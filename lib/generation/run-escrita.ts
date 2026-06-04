/**
 * Motor headless da Escrita (loop 2-em-2) — extraído pra rodar FORA do
 * `StepShell` (ex.: fila de geração em 2º plano). Espelha fielmente o branch
 * Escrita do `components/wizard/StepShell.tsx` (geração + retries + dedup +
 * calibração deferida/paralela), reusando os MESMOS helpers puros (parseEscritaBatch,
 * planBatches, dedupChaptersLast, concatenateChapters, parseEscritaChaptersDirect,
 * countWords) — a lógica que define a QUALIDADE do output é compartilhada, então
 * o resultado é equivalente ao foreground. Só o "encanamento" (React/store) é
 * que difere: aqui ele vira callbacks.
 *
 * IMPORTANTE: o foreground (StepShell) NÃO foi refatorado pra usar este motor —
 * pra não arriscar a produção principal. Se um dia unificar, este é o ponto de
 * partida. Mantenha os dois em sincronia ao mexer no loop da Escrita.
 *
 * Roda no renderer (browser): usa `fetch` pros endpoints /api/agent/escrita e
 * /api/escrita-fix-wordcount, e `Date`/`TextDecoder` normalmente.
 */

import type {
  BatchMissingChapters,
  EscritaChapter,
  EscritaSynopsis,
  RoteiroCategory,
  RoteiroReferenceImage,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { CATEGORIES } from "@/lib/categories";
import {
  countChaptersInEstrutura,
  planBatches,
} from "@/lib/parse-estrutura-chapters";
import { extractChapterTargets } from "@/lib/parse-estrutura-targets";
import { parseEscritaBatch } from "@/lib/parse-escrita-batch";
import {
  concatenateChapters,
  parseEscritaChaptersDirect,
} from "@/lib/parse-escrita-output";
import { canonPart, dedupChaptersLast } from "@/lib/dedup-chapters";
import { countWords } from "@/lib/word-count";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  CALIBRATION_THRESHOLD,
  CALIBRATION_CONCURRENCY,
} from "@/lib/escrita-calibration";

export type EscritaProgress =
  | {
      kind: "writing";
      batchIndex: number;
      totalBatches: number;
      part: "Parte 1" | "Parte 2";
      chapters: number[];
    }
  | {
      kind: "calibrating";
      currentIndex: number;
      totalToCalibrate: number;
      part: "Parte 1" | "Parte 2";
      chapter: number;
    };

export interface RunEscritaState {
  chapters: EscritaChapter[];
  synopses: EscritaSynopsis[];
  warnings: BatchMissingChapters[];
  content: string;
}

export interface RunEscritaInput {
  category: RoteiroCategory;
  /** outputs do roteiro (vira `previousOutputs` no body da /api/agent/escrita). */
  previousOutputs: Partial<Record<StepId, StepOutput>>;
  userInput?: string;
  referenceImage?: RoteiroReferenceImage;
  canone?: string;
  /**
   * Retomada: quando true, semeia os acumuladores com os capítulos/sinopses já
   * presentes em `previousOutputs.escrita.metadata` e PULA os batches cujos
   * capítulos já estão todos prontos — em vez de regerar do batch 0. A
   * calibração ±5% continua rodando ao fim (idempotente: pula caps já na faixa).
   */
  resume?: boolean;
}

export interface RunEscritaHooks {
  signal: AbortSignal;
  /** Progresso de batch/calibração — pra UI da fila. */
  onProgress?: (p: EscritaProgress) => void;
  /** Estado acumulado após cada batch e cada calibração — pra persistir incremental. */
  onPartial?: (state: RunEscritaState) => void;
  /**
   * Texto cru do batch atual chegando do stream (throttled ~80ms). Só dos
   * batches de GERAÇÃO — a calibração roda silenciosa (vários streams paralelos
   * embaralhariam o preview). Usado pelo QueueRunner pra mostrar a geração ao
   * vivo quando o roteiro do job está aberto.
   */
  onLiveText?: (text: string) => void;
  /**
   * Aguardado ANTES de cada batch/calibração. O runner da fila usa pra PAUSAR
   * enquanto a produção em foco está gerando — assim a fila cede prioridade e
   * cota à produção principal (não dispara chamada concorrente). Resolve quando
   * pode prosseguir.
   */
  beforeUnit?: () => Promise<void>;
}

/** Pré-condição não satisfeita (estruturas faltando) — não é erro de rede. */
export class EscritaPreconditionError extends Error {}

async function readResponseText(
  res: Response,
  signal: AbortSignal,
  onLive?: (text: string) => void,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  // Throttle por tempo (não RAF): o motor roda em 2º plano e o RAF pausa quando
  // a aba fica oculta — aqui queremos emitir mesmo assim. ~80ms ≈ 12 updates/s,
  // suficiente pra UI e leve no store. Sempre faz um flush final.
  let lastEmit = 0;
  for (;;) {
    if (signal.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (onLive) {
      const now = Date.now();
      if (now - lastEmit > 80) {
        lastEmit = now;
        onLive(acc);
      }
    }
  }
  if (onLive) onLive(acc);
  return acc;
}

/**
 * Gera o roteiro completo da Escrita (Parte 1 + Parte 2) em batches 2-em-2.
 * Devolve o estado final; também emite estados parciais via `hooks.onPartial`.
 */
export async function runEscrita(
  input: RunEscritaInput,
  hooks: RunEscritaHooks,
): Promise<RunEscritaState> {
  const { category, previousOutputs } = input;
  const { signal } = hooks;

  const estrutura1 = previousOutputs.estrutura1?.content;
  const estrutura2 = previousOutputs.estrutura2?.content;
  const totalP1 = countChaptersInEstrutura(estrutura1);
  const totalP2 = countChaptersInEstrutura(estrutura2);
  if (totalP1 === 0 || totalP2 === 0) {
    throw new EscritaPreconditionError(
      `Estrutura incompleta: Parte 1 = ${totalP1} caps, Parte 2 = ${totalP2} caps. Gere as duas estruturas antes de enfileirar a Escrita.`,
    );
  }

  const targetsP1Raw = extractChapterTargets(estrutura1);
  const targetsP2Raw = extractChapterTargets(estrutura2);
  const targetP1Total = CATEGORIES[category].wordCount.parte1.target;
  const targetP2Total = CATEGORIES[category].wordCount.parte2.target;
  const targetsP1 = Array.from(
    { length: totalP1 },
    (_, i) =>
      targetsP1Raw.find((t) => t.number === i + 1)?.target ??
      Math.round(targetP1Total / totalP1),
  );
  const targetsP2 = Array.from(
    { length: totalP2 },
    (_, i) =>
      targetsP2Raw.find((t) => t.number === i + 1)?.target ??
      Math.round(targetP2Total / totalP2),
  );

  const plan = planBatches(totalP1, totalP2, targetsP1, targetsP2, category);
  const accChapters: EscritaChapter[] = [];
  const accSynopses: EscritaSynopsis[] = [];
  const accWarnings: BatchMissingChapters[] = [];

  // ═══ Retomada: semeia o que já foi gerado numa rodada anterior ══════════
  // Os capítulos/sinopses prontos já foram persistidos via `onPartial` no
  // `outputs.escrita.metadata`. Semear aqui permite: (a) pular os batches já
  // concluídos no loop abaixo; (b) manter as sinopses como contexto pros
  // próximos batches (a "ponte" P1→P2). Dedup `last` resolve qualquer overlap.
  if (input.resume) {
    const prev = previousOutputs.escrita?.metadata;
    if (prev?.chapters?.length) accChapters.push(...prev.chapters);
    if (prev?.synopses?.length) accSynopses.push(...prev.synopses);
  }

  const snapshot = (): RunEscritaState => ({
    chapters: [...accChapters],
    synopses: [...accSynopses],
    warnings: [...accWarnings],
    content: concatenateChapters(accChapters),
  });
  const emitPartial = () => hooks.onPartial?.(snapshot());

  // ═══ Loop 2-em-2 com retry automático (espelha StepShell) ════════════
  const MAX_RETRIES_PER_BATCH = 2;
  for (const b of plan) {
    if (signal.aborted) break;

    // Retomada: se TODOS os capítulos deste batch já existem (rodada anterior),
    // pula — não regera o que já está pronto. Se o batch ficou pela metade
    // (parcial), `allPresent` é falso → regera o batch inteiro e o
    // `dedupChaptersLast` (last-wins) resolve a duplicata do cap já feito.
    if (input.resume) {
      const have = new Set(
        accChapters.map((c) => `${canonPart(c.part)}|${c.number}`),
      );
      const allPresent = b.chapters.every((n) =>
        have.has(`${canonPart(b.part)}|${n}`),
      );
      if (allPresent) continue;
    }

    if (hooks.beforeUnit) await hooks.beforeUnit();
    if (signal.aborted) break;

    let chaptersToRequest = [...b.chapters];
    let targetsToRequest = [...b.targets];
    let attempt = 0;
    let finalMissing: number[] = chaptersToRequest;
    let batchFatalError: string | null = null;

    while (chaptersToRequest.length > 0 && attempt <= MAX_RETRIES_PER_BATCH) {
      if (signal.aborted) break;
      attempt += 1;
      hooks.onProgress?.({
        kind: "writing",
        batchIndex: b.batchIndex,
        totalBatches: plan.length,
        part: b.part,
        chapters: chaptersToRequest,
      });

      const res = await fetch(`/api/agent/escrita`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          previousOutputs,
          userInput: input.userInput,
          referenceImage: input.referenceImage,
          ...(input.canone?.trim() ? { canone: input.canone } : {}),
          batch: {
            part: b.part,
            chapters: chaptersToRequest,
            totalInPart: b.totalInPart,
            batchIndex: b.batchIndex,
            totalBatches: plan.length,
            chapterTargets: targetsToRequest,
          },
          previousSynopses: accSynopses,
        }),
        signal,
      });

      if (!res.ok || !res.body) {
        batchFatalError = (await res.text().catch(() => "")) || res.statusText;
        break;
      }

      const acc = await readResponseText(res, signal, hooks.onLiveText);
      if (signal.aborted) break;

      const parsed = parseEscritaBatch(acc, b.part);

      const fallbackOnly = parsed.chapters.every((c) => c.number === 0);
      if (fallbackOnly && parsed.chapters.length > 0) {
        if (attempt <= MAX_RETRIES_PER_BATCH) continue;
        batchFatalError = `O modelo não seguiu o formato esperado (sem cabeçalhos "## Capítulo N — Título").`;
        break;
      }

      if (signal.aborted) break;

      accChapters.push(...parsed.chapters);
      accSynopses.push(...parsed.synopses);

      const gotNumbers = new Set(
        parsed.chapters.map((c) => c.number).filter((n) => n > 0),
      );
      const stillMissing = chaptersToRequest.filter((n) => !gotNumbers.has(n));
      if (stillMissing.length === 0) {
        finalMissing = [];
        break;
      }

      const stillMissingTargets = stillMissing.map((n) => {
        const idx = b.chapters.indexOf(n);
        return idx >= 0 ? b.targets[idx]! : 0;
      });
      chaptersToRequest = stillMissing;
      targetsToRequest = stillMissingTargets;
      finalMissing = stillMissing;
    }

    if (batchFatalError) {
      accWarnings.push({
        batchIndex: b.batchIndex,
        part: b.part,
        expected: b.chapters,
        missing: b.chapters,
        fatalError: batchFatalError,
      });
      emitPartial();
      continue;
    }

    if (finalMissing.length > 0) {
      accWarnings.push({
        batchIndex: b.batchIndex,
        part: b.part,
        expected: b.chapters,
        missing: finalMissing,
      });
    }

    const dedupResult = dedupChaptersLast(accChapters);
    if (dedupResult.removed > 0) {
      accChapters.length = 0;
      accChapters.push(...dedupResult.chapters);
      accWarnings.push({
        batchIndex: b.batchIndex,
        part: b.part,
        expected: [],
        missing: [],
        duplicatesRemoved: dedupResult.removed,
      });
    }

    emitPartial();
  }

  if (signal.aborted) return snapshot();

  // ═══ Calibração (deferida + PARALELA, cedendo ao foreground) ══════════
  // Calibração só muda o TAMANHO de cada cap (independente entre caps) e NÃO
  // alimenta batches seguintes (eles só recebem accSynopses), então adiar pro
  // fim é equivalente ao loop por-batch do StepShell, com menos churn. Cada
  // candidato escreve num índice distinto de accChapters e só LÊ accSynopses
  // (já completas neste ponto) → rodar em paralelo dá o MESMO resultado, só mais
  // rápido. Threshold/concorrência em @/lib/escrita-calibration (compartilhado
  // com o StepShell pra não divergir).
  const targetFor = (ch: EscritaChapter): number | null => {
    if (!ch.number || ch.number < 1) return null;
    const arr =
      ch.part === "Parte 2"
        ? targetsP2
        : ch.part === "Parte 1"
          ? targetsP1
          : null;
    return arr ? (arr[ch.number - 1] ?? null) : null;
  };
  const candidates = accChapters
    .map((ch, arrIndex) => ({ ch, arrIndex, target: targetFor(ch) }))
    .filter((c) => {
      if (!c.target) return false;
      const cur = countWords(c.ch.content);
      return Math.abs(cur - c.target) / c.target > CALIBRATION_THRESHOLD;
    });

  let calibrationDone = 0;
  await mapWithConcurrency(
    candidates,
    CALIBRATION_CONCURRENCY,
    async (cand) => {
      const current = countWords(cand.ch.content);
      calibrationDone += 1;
      hooks.onProgress?.({
        kind: "calibrating",
        currentIndex: calibrationDone,
        totalToCalibrate: candidates.length,
        part: cand.ch.part as "Parte 1" | "Parte 2",
        chapter: cand.ch.number,
      });

      const neighborSynopses = accSynopses
        .filter(
          (s) =>
            s.part === cand.ch.part && Math.abs(s.number - cand.ch.number) <= 1,
        )
        .map((s) => ({ number: s.number, part: s.part, synopsis: s.synopsis }));

      try {
        const fixRes = await fetch(`/api/escrita-fix-wordcount`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            chapter: {
              number: cand.ch.number,
              title: cand.ch.title,
              part: cand.ch.part as "Parte 1" | "Parte 2",
              content: cand.ch.content,
            },
            currentWords: current,
            targetWords: cand.target,
            premissa: previousOutputs.premissa?.content,
            neighborSynopses,
          }),
          signal,
        });
        if (!fixRes.ok || !fixRes.body) return;
        const fixAcc = await readResponseText(fixRes, signal);
        if (signal.aborted) return;
        const parsedFix = parseEscritaChaptersDirect(fixAcc);
        const newCh = parsedFix.find((p) => p.number === cand.ch.number);
        if (newCh?.content) {
          accChapters[cand.arrIndex] = {
            ...cand.ch,
            content: newCh.content,
            title: newCh.title ?? cand.ch.title,
            generatedAt: new Date().toISOString(),
          };
          emitPartial();
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // mantém o capítulo original — calibração é best-effort
      }
    },
    {
      signal,
      beforeEach: hooks.beforeUnit ? () => hooks.beforeUnit!() : undefined,
    },
  );

  const result = snapshot();
  emitPartial();
  return result;
}
