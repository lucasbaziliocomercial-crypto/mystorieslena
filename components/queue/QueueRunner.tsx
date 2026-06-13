"use client";

/**
 * Gerenciador de geração da Escrita — montado 1× no layout raiz, sempre ativo.
 *
 * Roda a Escrita de roteiros FORA do componente da aba, então a geração
 * **sobrevive a trocar/fechar a guia** e **roda concorrente** com outras abas
 * (até MAX_CONCURRENT ao mesmo tempo). Isso atende ao pedido de "deixar várias
 * histórias gerando ao mesmo tempo pra otimizar tempo".
 *
 * - Escreve o resultado no storage por id pelo caminho coalescido/idle
 *   (`scheduleSave` + `flushPendingSave` no fim) pra não travar a janela
 *   quando 2+ jobs geram em paralelo.
 * - Se o roteiro do job for o que está ABERTO no momento, também reflete no
 *   store ativo (`useWizard.setOutput`) pra a aba mostrar os capítulos surgindo.
 * - Cada job tem seu AbortController (registro em `job-control.ts`) pra cancelar.
 *
 * NOTA: compartilha a cota da assinatura — N gerações ao mesmo tempo dividem o
 * mesmo limite, então cada uma pode ficar mais lenta. MAX_CONCURRENT limita o
 * paralelismo pra não estourar cota/CPU.
 */
import { useEffect, useRef } from "react";
import { useQueue } from "@/store/queue";
import { useWizard } from "@/store/wizard";
import { getRoteiro, scheduleSave, requestPendingSaveFlush } from "@/lib/storage";
import { appendEvalSnapshot } from "@/lib/eval-log";
import { accrueProductionTime } from "@/lib/production-time";
import { appendPerfMetric } from "@/lib/perf-metrics";
import { syncWriterIdentity } from "@/lib/writer-identity";
import { computeRevisorEval } from "@/lib/parse-revisor-output";
import {
  runEscrita,
  type RunEscritaState,
} from "@/lib/generation/run-escrita";
import {
  runStreamingStep,
  runPremissa,
  runCanone,
} from "@/lib/generation/run-step";
import {
  registerJob,
  unregisterJob,
  abortAllJobs,
  hasJobController,
} from "@/lib/generation/job-control";
import {
  isRevisorStep,
  type ProductionStepKey,
  type StepId,
  type StepOutput,
} from "@/types/roteiro";

// Máx. de jobs de geração rodando ao mesmo tempo. Cada job de Escrita agora usa
// 2 streams Opus em paralelo (Parte 1 ‖ Parte 2 em run-escrita.ts), então 2 jobs
// = ~4 streams Opus de batch concorrentes — perto dos 3 de antes, sem estourar a
// cota da assinatura COMPARTILHADA (equipe na mesma conta). É um knob: afine pelos
// logs `[perf]` do run-escrita — poucos 429 → pode subir; muitos 429 → baixe.
const MAX_CONCURRENT = 2;

function notifyDone(title: string) {
  if (typeof window === "undefined") return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Roteiro pronto ✓", {
        body: `A Escrita de "${title}" terminou.`,
      });
    }
  } catch {
    /* Notification indisponível — ignora */
  }
}

function buildEscritaOutput(state: RunEscritaState): StepOutput {
  return {
    content: state.content,
    metadata: {
      chapters: state.chapters,
      synopses: state.synopses,
      ...(state.warnings.length > 0 ? { batchWarnings: state.warnings } : {}),
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Grava o cânone por id (storage) + reflete no store se for o ativo. Regerar
 *  invalida a aprovação (canoneApproved=false), igual ao `setCanone` do store. */
function applyCanone(roteiroId: string, canone: string) {
  const r = getRoteiro(roteiroId);
  if (r) {
    const next = { ...r, canone, canoneApproved: false };
    delete next.canoneApprovedAt;
    scheduleSave(next);
  }
  const w = useWizard.getState();
  if (w.roteiro?.id === roteiroId) w.setCanone(canone);
}

/** Grava o output de um step por id (storage) + reflete no store se for o ativo. */
function applyStepOutput(roteiroId: string, step: StepId, output: StepOutput) {
  const w = useWizard.getState();
  const active = w.roteiro?.id === roteiroId;
  // Fonte de verdade: storage por id (sobrevive a navegação).
  const r = getRoteiro(roteiroId);
  if (r) {
    let next = { ...r, outputs: { ...r.outputs, [step]: output } };
    // Eval de qualidade (Karpathy): anexa ao log versionado. Só aqui quando o
    // roteiro NÃO está ativo; se estiver, o store grava via recordEval (abaixo)
    // e seu persist sobrescreveria este — evita corrida/duplicata.
    if (!active && isRevisorStep(step)) {
      const data = computeRevisorEval(
        step,
        output.content ?? "",
        output.metadata?.errors ?? [],
        output.metadata?.escritaSnapshotHash,
      );
      if (data) {
        next = { ...next, evals: appendEvalSnapshot(r.evals, data, new Date().toISOString()) };
      }
    }
    // Caminho COALESCIDO/idle (não o saveRoteiro direto): o `onPartial` dispara
    // por batch e, com 2 jobs em paralelo, o save direto comprimia a biblioteca
    // toda de forma síncrona a cada batch × 2 → travava a janela. `scheduleSave`
    // junta tudo num Map por id (último vence) e comprime 1× por janela de 600ms
    // dentro de requestIdleCallback, fora do caminho crítico. O estado final do
    // job é forçado a disco via flushPendingSave() ao concluir (abaixo).
    scheduleSave(next);
  }
  // Se a aba aberta é esse roteiro, reflete ao vivo no store.
  if (active) {
    w.setOutput(step, output);
    if (isRevisorStep(step)) w.recordEval(step, output);
  }
}

/**
 * Acumula `elapsedMs` de geração ativa no cronômetro de produção do roteiro
 * (ver [ProductionTime]). Roteiro ATIVO → via store (`recordProductionTime`,
 * que persiste); em 2º plano → grava direto no storage pelo caminho coalescido.
 * Mesma lógica de acúmulo dos dois lados (`accrueProductionTime`). Best-effort:
 * instrumentação nunca derruba a conclusão do job.
 */
function accrueProduction(
  roteiroId: string,
  step: ProductionStepKey,
  elapsedMs: number,
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  const w = useWizard.getState();
  if (w.roteiro?.id === roteiroId) {
    w.recordProductionTime(step, elapsedMs);
    return;
  }
  const r = getRoteiro(roteiroId);
  if (!r) return;
  const production = accrueProductionTime(
    r.production,
    step,
    elapsedMs,
    new Date().toISOString(),
  );
  scheduleSave({ ...r, production });
}

export function QueueRunner() {
  const updateJob = useQueue((s) => s.updateJob);

  // Assinatura de status dos jobs — muda só em TRANSIÇÃO (enfileirou / começou /
  // terminou), NÃO a cada tick de progresso (onProgress→updateJob dispara a cada
  // chunk). O drain só precisa acordar em transição; ler o array inteiro fazia o
  // efeito re-rodar a cada chunk de cada job rodando. O drainRef lê o estado
  // fresco via getState(), então não precisa do array nas deps.
  const jobsSig = useQueue((s) => s.jobs.map((j) => `${j.id}:${j.status}`).join("|"));
  const mountedRef = useRef(true);
  // Chaves `${roteiroId}:${step}` atualmente gerando (controle de concorrência).
  // Lock por STEP (não por roteiro) pra que revisor1 e revisor2 do MESMO roteiro
  // rodem em paralelo — cada um grava uma chave de step distinta em outputs, e
  // `applyStepOutput` re-lê o roteiro fresco e síncrono antes de gravar (sem
  // janela de interleave). `MAX_CONCURRENT` ainda limita o paralelismo total.
  const runningRef = useRef<Set<string>>(new Set());
  const jobKey = (j: { roteiroId: string; step: string }) =>
    `${j.roteiroId}:${j.step}`;

  const drainRef = useRef<() => void>(() => {});
  drainRef.current = () => {
    const running = runningRef.current;

    // Recupera jobs FANTASMA antes de drenar: marcados `running` na fila mas SEM
    // AbortController vivo (e que ESTE runner não iniciou) — sobra de um abort no
    // unmount (`abortAllJobs`), crash ou hot-reload. Sem isso o job fica `running`
    // pra sempre, o StepShell desabilita o botão "Gerar" (`disabled={!!stepJob}`) e
    // a roteirista vê "nada acontece". Reset pra `queued`+`resume` (o motor da
    // Escrita pula os batches já feitos) — mesma cura que o `loadJobs` faz no
    // reload, mas cobrindo o MEIO da sessão. Idempotente e sem loop: após o reset
    // o job vira `queued` (não casa de novo aqui); ao re-drenar vira `running` COM
    // controller registrado (também não casa).
    for (const j of useQueue.getState().jobs) {
      if (
        j.status === "running" &&
        !running.has(jobKey(j)) &&
        !hasJobController(j.id)
      ) {
        updateJob(j.id, {
          status: "queued",
          progress: undefined,
          startedAt: undefined,
          resume: true,
        });
      }
    }

    if (running.size >= MAX_CONCURRENT) return;

    const queued = useQueue
      .getState()
      .jobs.filter(
        (j) => j.status === "queued" && !running.has(jobKey(j)),
      );

    for (const job of queued) {
      if (running.size >= MAX_CONCURRENT) break;

      running.add(jobKey(job));
      const abort = new AbortController();
      registerJob(job.id, abort);
      updateJob(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        error: undefined,
      });

      void (async () => {
        // [perf] cronômetro do step na fila (cobre escrita/estrutura/revisor/
        // overview/premissa/canone "Gerar"). Logado no console ao concluir/falhar.
        const startedMs = Date.now();
        try {
          const r = getRoteiro(job.roteiroId);
          if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");

          if (job.step === "escrita") {
            const finalState = await runEscrita(
              {
                category: r.category,
                roteiroId: r.id,
                previousOutputs: r.outputs,
                userInput: job.userInput ?? r.userInputs?.escrita,
                referenceImage: r.referenceImage,
                canone: r.canone,
                resume: job.resume,
              },
              {
                signal: abort.signal,
                onProgress: (progress) => updateJob(job.id, { progress }),
                onPartial: (state: RunEscritaState) =>
                  applyStepOutput(
                    job.roteiroId,
                    "escrita",
                    buildEscritaOutput(state),
                  ),
                // Preview ao vivo: só reflete na tela se o roteiro do job é o
                // que está aberto agora. Em outra aba, não custa nada.
                onLiveText: (text) => {
                  const w = useWizard.getState();
                  if (w.roteiro?.id === job.roteiroId)
                    w.setQueueLiveStream(job.step, text);
                },
                // Throughput/cota → perf.jsonl (só observabilidade; best-effort).
                onMetrics: (rec) => appendPerfMetric(rec),
              },
            );
            if (abort.signal.aborted) return; // cancelado — job já removido
            applyStepOutput(
              job.roteiroId,
              "escrita",
              buildEscritaOutput(finalState),
            );
          } else if (job.step === "canone") {
            // Cânone — grava em roteiro.canone (não em outputs[step]).
            const canone = await runCanone(job.roteiroId, {
              signal: abort.signal,
              onPhase: (phase) => updateJob(job.id, { phase }),
              onLiveText: (text) => {
                const w = useWizard.getState();
                if (w.roteiro?.id === job.roteiroId)
                  w.setQueueLiveStream(job.step, text);
              },
            });
            if (abort.signal.aborted) return; // cancelado — job já removido
            applyCanone(job.roteiroId, canone);
          } else if (job.step === "premissa") {
            // Premissa — 2 fases (resumo / estrutura), params no job.
            const output = await runPremissa(
              job.roteiroId,
              job.premissa ?? { phase: "resumo" },
              job.userInput,
              {
                signal: abort.signal,
                onPhase: (phase) => updateJob(job.id, { phase }),
                onLiveText: (text) => {
                  const w = useWizard.getState();
                  if (w.roteiro?.id === job.roteiroId)
                    w.setQueueLiveStream(job.step, text);
                },
              },
            );
            if (abort.signal.aborted) return; // cancelado — job já removido
            applyStepOutput(job.roteiroId, "premissa", output);
          } else {
            // Estrutura 1/2, Revisor 1/2 — motor de chamada única.
            const output = await runStreamingStep(
              job.roteiroId,
              job.step,
              job.userInput,
              {
                signal: abort.signal,
                onPhase: (phase) => updateJob(job.id, { phase }),
                onLiveText: (text) => {
                  const w = useWizard.getState();
                  if (w.roteiro?.id === job.roteiroId)
                    w.setQueueLiveStream(job.step, text);
                },
              },
              // Contexto "não relista esses erros" do "Continuar revisão" —
              // snapshot capturado no enqueue (só revisor1/revisor2 usam).
              job.previousRevisorErrors,
            );
            if (abort.signal.aborted) return; // cancelado — job já removido
            applyStepOutput(job.roteiroId, job.step, output);
          }

          // Cronômetro de produção: soma o tempo ativo deste step ao total do
          // roteiro (antes do flush, pra persistir junto com o output). É tempo
          // de geração — só conta jobs que chegaram aqui (concluídos), não os
          // que falharam/foram cancelados.
          accrueProduction(job.roteiroId, job.step, Date.now() - startedMs);

          // Durabilidade "terminou = salvou": força o último snapshot coalescido
          // pro disco. Caminho ASSÍNCRONO (worker) — a compressão NÃO bloqueia a
          // UI. Com revisor1‖revisor2 terminando quase juntos, os dois flushes
          // colapsam num único compress (saveInFlight/resaveQueued). Os onPartial
          // já gravaram via scheduleSave e o unload faz flush síncrono.
          requestPendingSaveFlush();
          updateJob(job.id, {
            status: "done",
            finishedAt: new Date().toISOString(),
            progress: undefined,
            phase: undefined,
          });
          console.info(
            `[perf] ${job.step} ("${job.roteiroTitle}") levou ${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
          );
          notifyDone(job.roteiroTitle);
        } catch (e) {
          const err = e as Error;
          if (err.name === "AbortError" || abort.signal.aborted) return; // cancelado
          console.info(
            `[perf] ${job.step} ("${job.roteiroTitle}") FALHOU após ${((Date.now() - startedMs) / 1000).toFixed(1)}s`,
          );
          // Durabilidade em FALHA: força o último parcial coalescido pro disco
          // (caminho async/worker — não bloqueia a UI). Os onPartial já gravaram
          // via scheduleSave; aqui garante que o gerado até o erro sobreviva. O
          // unload (beforeunload/pagehide) ainda faz flush síncrono se o app fechar.
          requestPendingSaveFlush();
          updateJob(job.id, {
            status: "error",
            error: err.message || "Falha desconhecida",
            finishedAt: new Date().toISOString(),
          });
        } finally {
          running.delete(jobKey(job));
          unregisterJob(job.id);
          // Limpa o preview ao vivo deste step (terminou/abortou/falhou) — só
          // se o roteiro ainda é o aberto. Os capítulos finais já foram pro output.
          const w = useWizard.getState();
          if (w.roteiro?.id === job.roteiroId) w.setQueueLiveStream(job.step, "");
          if (mountedRef.current) setTimeout(() => drainRef.current(), 50);
        }
      })();
    }
  };

  // Acorda o loop quando a fila muda de STATUS (novo job enfileirado / job
  // concluído) — não a cada tick de progresso.
  useEffect(() => {
    drainRef.current();
  }, [jobsSig]);

  useEffect(() => {
    mountedRef.current = true;
    // Espelha o nome da roteirista no server (log de consumo de tokens). 1× no
    // boot — o app é single-user por máquina, então isso basta pra atribuir o
    // gasto. Best-effort.
    void syncWriterIdentity();
    return () => {
      mountedRef.current = false;
      abortAllJobs();
    };
  }, []);

  return null;
}
