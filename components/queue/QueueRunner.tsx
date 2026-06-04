"use client";

/**
 * Gerenciador de geração da Escrita — montado 1× no layout raiz, sempre ativo.
 *
 * Roda a Escrita de roteiros FORA do componente da aba, então a geração
 * **sobrevive a trocar/fechar a guia** e **roda concorrente** com outras abas
 * (até MAX_CONCURRENT ao mesmo tempo). Isso atende ao pedido de "deixar várias
 * histórias gerando ao mesmo tempo pra otimizar tempo".
 *
 * - Escreve o resultado direto no storage por id (`saveRoteiro`).
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
import { getRoteiro, saveRoteiro } from "@/lib/storage";
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
} from "@/lib/generation/job-control";
import type { StepId, StepOutput } from "@/types/roteiro";

const MAX_CONCURRENT = 3;

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
    saveRoteiro(next);
  }
  const w = useWizard.getState();
  if (w.roteiro?.id === roteiroId) w.setCanone(canone);
}

/** Grava o output de um step por id (storage) + reflete no store se for o ativo. */
function applyStepOutput(roteiroId: string, step: StepId, output: StepOutput) {
  // Fonte de verdade: storage por id (sobrevive a navegação).
  const r = getRoteiro(roteiroId);
  if (r) saveRoteiro({ ...r, outputs: { ...r.outputs, [step]: output } });
  // Se a aba aberta é esse roteiro, reflete ao vivo no store.
  const w = useWizard.getState();
  if (w.roteiro?.id === roteiroId) w.setOutput(step, output);
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
  // roteiroIds atualmente gerando (controle de concorrência).
  const runningRef = useRef<Set<string>>(new Set());

  const drainRef = useRef<() => void>(() => {});
  drainRef.current = () => {
    const running = runningRef.current;
    if (running.size >= MAX_CONCURRENT) return;

    const queued = useQueue
      .getState()
      .jobs.filter(
        (j) => j.status === "queued" && !running.has(j.roteiroId),
      );

    for (const job of queued) {
      if (running.size >= MAX_CONCURRENT) break;

      running.add(job.roteiroId);
      const abort = new AbortController();
      registerJob(job.id, abort);
      updateJob(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        error: undefined,
      });

      void (async () => {
        try {
          const r = getRoteiro(job.roteiroId);
          if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");

          if (job.step === "escrita") {
            const finalState = await runEscrita(
              {
                category: r.category,
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
                  if (w.roteiro?.id === job.roteiroId) w.setQueueLiveStream(text);
                },
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
                if (w.roteiro?.id === job.roteiroId) w.setQueueLiveStream(text);
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
                    w.setQueueLiveStream(text);
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
                    w.setQueueLiveStream(text);
                },
              },
            );
            if (abort.signal.aborted) return; // cancelado — job já removido
            applyStepOutput(job.roteiroId, job.step, output);
          }

          updateJob(job.id, {
            status: "done",
            finishedAt: new Date().toISOString(),
            progress: undefined,
            phase: undefined,
          });
          notifyDone(job.roteiroTitle);
        } catch (e) {
          const err = e as Error;
          if (err.name === "AbortError" || abort.signal.aborted) return; // cancelado
          updateJob(job.id, {
            status: "error",
            error: err.message || "Falha desconhecida",
            finishedAt: new Date().toISOString(),
          });
        } finally {
          running.delete(job.roteiroId);
          unregisterJob(job.id);
          // Limpa o preview ao vivo deste roteiro (terminou/abortou/falhou) — só
          // se ele ainda é o aberto. Os capítulos finais já foram pro output.
          const w = useWizard.getState();
          if (w.roteiro?.id === job.roteiroId) w.setQueueLiveStream("");
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
    return () => {
      mountedRef.current = false;
      abortAllJobs();
    };
  }, []);

  return null;
}
