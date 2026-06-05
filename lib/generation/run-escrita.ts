/**
 * Motor headless da Escrita — gera o roteiro completo (Parte 1 + Parte 2) em
 * batches 2-em-2. É a FONTE ÚNICA do full-gen da Escrita: o branch do
 * `StepShell.tsx` enfileira no QueueRunner e dá `return` antes do seu loop
 * (caminho morto pra full-gen), então toda geração "do zero" passa por aqui.
 * Reusa os MESMOS helpers puros (parseEscritaBatch, planBatches,
 * dedupChaptersLast, concatenateChapters, parseEscritaChaptersDirect,
 * countWords) — a lógica que define a QUALIDADE do output é compartilhada.
 *
 * PARALELIZAÇÃO P1 ‖ P2: as duas Partes rodam em paralelo (`Promise.all` de dois
 * loops independentes), cada uma acumulando nos seus próprios arrays. A
 * continuidade intra-Parte vem das sinopses da própria Parte. ALÉM disso, a P2
 * recebe a cada batch um snapshot BEST-EFFORT das sinopses que a P1 JÁ escreveu
 * naquele instante (`crossSynopsesRef` → `crossPartSynopses` no body) — leitura
 * sem bloqueio: como as duas Partes avançam no mesmo ritmo, a P2 costuma já ter
 * os fatos da P1 até o cap que está escrevendo. Isso costura a continuidade
 * cruzada NA ORIGEM (evita os GRAVES "personagem em dois lugares" / "contradição
 * de concepção P1↔P2" que a ponte só-pela-Estrutura deixava passar), mantendo o
 * paralelismo que ~corta pela metade a fase de batches quando há cota ociosa. A
 * P1 é a fundação e não recebe contexto cruzado; o Revisor (que também roda
 * P1‖P2) ainda pega resíduos. ⚠️ O branch morto do `StepShell` NÃO tem essa
 * paralelização — não o reanime pra full-gen.
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
  type BatchPlan,
} from "@/lib/parse-estrutura-chapters";
import { extractChapterTargets } from "@/lib/parse-estrutura-targets";
import { parseEscritaBatch } from "@/lib/parse-escrita-batch";
import {
  concatenateChapters,
  parseEscritaChaptersDirect,
} from "@/lib/parse-escrita-output";
import { canonPart, dedupChaptersLast } from "@/lib/dedup-chapters";
import { countWords } from "@/lib/word-count";
import { createLimiter } from "@/lib/concurrency";
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

/**
 * Erro fatal que ABORTA a run inteira (em vez de truncar silenciosamente).
 * Usado quando a rota injeta um marcador de login/binário/cota no stream — não
 * adianta seguir pros próximos batches porque todos vão falhar igual, e o
 * usuário precisa ver a causa real (ex.: precisa relogar / bateu no limite).
 */
export class EscritaFatalError extends Error {}

/**
 * Marcadores que a rota (`app/api/agent/[step]/route.ts`) injeta no corpo do
 * stream quando a SDK falha — com `res.ok=true`, então não dá pra detectar pelo
 * status HTTP. Se aparecerem, o "lote" não tem capítulos de verdade: é uma
 * mensagem de erro disfarçada. Abortamos com a causa real.
 */
const FATAL_STREAM_MARKERS: { marker: string; reason: string }[] = [
  {
    marker: "[LOGIN NECESSÁRIO NO CLAUDE]",
    reason:
      "Login necessário no Claude — sua sessão expirou ou você bateu no limite de uso da assinatura. Faça login novamente (ou aguarde a renovação da cota) e clique em \"Continuar geração\".",
  },
  {
    marker: "[BINÁRIO CLAUDE NÃO ENCONTRADO]",
    reason:
      "O binário do Claude Code não foi encontrado neste pacote. Reinstale o app pela última versão e tente \"Continuar geração\".",
  },
];

/** Marcadores FORTES (login/binário) — nunca aparecem em prosa, abortam na hora. */
function detectHardMarker(text: string): string | null {
  for (const { marker, reason } of FATAL_STREAM_MARKERS) {
    if (text.includes(marker)) return reason;
  }
  return null;
}

/**
 * Marcador genérico `[ERRO] <msg>` — qualquer exceção da SDK que NÃO é
 * login/binário (ex.: limite de uso/cota, erro de servidor). Só é consultado
 * quando o lote NÃO rendeu capítulo nenhum, pra não confundir com prosa que por
 * acaso contenha o texto. Retorna a causa amigável (ou null se não houver erro).
 */
function detectErroMarker(text: string): string | null {
  const generic = /\[ERRO\]\s*([\s\S]*)$/.exec(text);
  if (!generic) return null;
  const detail = generic[1]?.trim().slice(0, 300);
  const isQuota = /rate.?limit|quota|usage|limit|429|overloaded|capacity/i.test(
    detail ?? "",
  );
  return isQuota
    ? `Limite de uso da assinatura Claude atingido (ou servidor sobrecarregado). Aguarde alguns minutos e clique em "Continuar geração". Detalhe: ${detail}`
    : `Erro ao gerar o lote: ${detail || "falha desconhecida na SDK do Claude"}.`;
}

/** Sleep que resolve cedo se o signal abortar (não trava o cancelamento). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Backoff exponencial com teto (1s, 2s, 4s, … até 8s) por tentativa. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

async function readResponseText(
  res: Response,
  signal: AbortSignal,
  onLive?: (text: string) => void,
  onFirstChunk?: () => void,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  // Throttle por tempo (não RAF): o motor roda em 2º plano e o RAF pausa quando
  // a aba fica oculta — aqui queremos emitir mesmo assim. ~80ms ≈ 12 updates/s,
  // suficiente pra UI e leve no store. Sempre faz um flush final.
  let lastEmit = 0;
  let sawFirst = false;
  for (;;) {
    if (signal.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (!sawFirst) {
      sawFirst = true;
      onFirstChunk?.(); // [perf] marca o TTFT (1º byte do stream)
    }
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

  // Planos POR PARTE — cada um roda num loop independente (paralelizados via
  // `Promise.all`). planBatches com a outra Parte zerada gera só os batches
  // daquela Parte, com batchIndex local 1-based e `part` correto.
  const planP1 = planBatches(totalP1, 0, targetsP1, undefined, category);
  const planP2 = planBatches(0, totalP2, undefined, targetsP2, category);
  const totalBatches = planP1.length + planP2.length;

  // Acumuladores POR PARTE — sem estado compartilhado entre os dois loops (e o
  // JS é single-thread), então não há race. O snapshot mescla os dois pra
  // persistir o roteiro inteiro a cada batch de qualquer Parte.
  const p1Chapters: EscritaChapter[] = [];
  const p1Synopses: EscritaSynopsis[] = [];
  const p2Chapters: EscritaChapter[] = [];
  const p2Synopses: EscritaSynopsis[] = [];
  const accWarnings: BatchMissingChapters[] = [];

  // ═══ Retomada: semeia CADA Parte com o que já foi gerado ════════════════
  // Os capítulos/sinopses prontos já foram persistidos via `onPartial` no
  // `outputs.escrita.metadata`. Separar por Parte permite pular os batches já
  // concluídos em cada loop. Dedup `last` resolve qualquer overlap.
  if (input.resume) {
    const prev = previousOutputs.escrita?.metadata;
    // canonPart normaliza pra lowercase ("parte 2") — comparar nesse case.
    if (prev?.chapters?.length) {
      for (const c of prev.chapters) {
        (canonPart(c.part) === "parte 2" ? p2Chapters : p1Chapters).push(c);
      }
    }
    if (prev?.synopses?.length) {
      for (const s of prev.synopses) {
        (canonPart(s.part) === "parte 2" ? p2Synopses : p1Synopses).push(s);
      }
    }
  }

  // Snapshot MESCLADO das duas Partes. A calibração muta os capítulos IN-PLACE
  // dentro de p1Chapters/p2Chapters, então mergedChapters() já reflete o texto
  // calibrado — não há array materializado separado. dedup last-wins resolve
  // overlap de retomada/retry. (JS single-thread → P1-calib e P2-geração
  // emitindo partials ao mesmo tempo não dão race.)
  const mergedChapters = (): EscritaChapter[] =>
    dedupChaptersLast([...p1Chapters, ...p2Chapters]).chapters;
  const snapshot = (): RunEscritaState => {
    const chapters = mergedChapters();
    return {
      chapters: [...chapters],
      synopses: [...p1Synopses, ...p2Synopses],
      warnings: [...accWarnings],
      content: concatenateChapters(chapters),
    };
  };
  const emitPartial = () => hooks.onPartial?.(snapshot());

  // [perf] contadores compartilhados entre os dois loops.
  let batchesDone = 0; // progresso agregado (display)
  let transientRetries = 0; // 408/429/5xx — sinal de saturação de cota
  let backoffMs = 0;

  // ═══ Loop de UMA Parte (retry/dedup por batch) — roda 1× por Parte ════════
  // Tentativas por batch: cobre falha de FORMATO (modelo não emitiu os
  // cabeçalhos) e TRANSIENTE (rede caiu, 429 de rate-limit, 5xx). Sem isso, o
  // batch 3 falhar uma vez derrubava os capítulos 5–12 inteiros. Cada loop
  // escreve SÓ nos seus arrays (localChapters/localSynopses) — nunca cruza Partes.
  const MAX_RETRIES_PER_BATCH = 4;
  // Sinaliza o outro loop a parar quando uma Parte bate em erro fatal
  // (login/cota/binário) — sem isso a outra Parte seguiria gerando órfã enquanto
  // o `Promise.all` já rejeitou.
  let fatalRaised = false;
  const runPartLoop = async (
    plan: BatchPlan[],
    localChapters: EscritaChapter[],
    localSynopses: EscritaSynopsis[],
    onLive?: (text: string) => void,
    // Contexto cruzado da OUTRA Parte (continuidade P1 → P2). Lido a cada batch
    // de forma BEST-EFFORT (snapshot do que a outra Parte já produziu naquele
    // instante) — NÃO bloqueia: como P1 e P2 avançam no mesmo ritmo, a P2 já
    // costuma ter os fatos da P1 até o cap que está escrevendo. Sem isso a P2
    // fica cega ao texto real da P1 e gera os GRAVES "personagem em dois lugares"
    // / "contradição de concepção P1↔P2". Só a P2 recebe (a P1 é a fundação).
    crossSynopsesRef?: () => EscritaSynopsis[],
  ): Promise<void> => {
    for (const b of plan) {
      if (signal.aborted || fatalRaised) break;

      // Retomada: se TODOS os capítulos deste batch já existem (rodada
      // anterior), pula. Se ficou pela metade, `allPresent` é falso → regera o
      // batch e o `dedupChaptersLast` (last-wins) resolve a duplicata.
      if (input.resume) {
        const have = new Set(
          localChapters.map((c) => `${canonPart(c.part)}|${c.number}`),
        );
        const allPresent = b.chapters.every((n) =>
          have.has(`${canonPart(b.part)}|${n}`),
        );
        if (allPresent) {
          batchesDone += 1;
          continue;
        }
      }

      if (hooks.beforeUnit) await hooks.beforeUnit();
      if (signal.aborted || fatalRaised) break;

      let chaptersToRequest = [...b.chapters];
      let targetsToRequest = [...b.targets];
      let attempt = 0;
      let finalMissing: number[] = chaptersToRequest;
      let batchFatalError: string | null = null;
      const batchStart = Date.now();
      let ttftMs = 0;

      while (chaptersToRequest.length > 0 && attempt <= MAX_RETRIES_PER_BATCH) {
        if (signal.aborted) break;
        attempt += 1;
        hooks.onProgress?.({
          kind: "writing",
          batchIndex: Math.min(batchesDone + 1, totalBatches),
          totalBatches,
          part: b.part,
          chapters: chaptersToRequest,
        });

        // Snapshot best-effort das sinopses da OUTRA Parte (P1) NESTE instante —
        // re-lido a cada tentativa pra pegar o que a P1 escreveu enquanto isso.
        const crossSnap = crossSynopsesRef ? crossSynopsesRef() : [];

        let res: Response;
        try {
          res = await fetch(`/api/agent/escrita`, {
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
                totalBatches,
                chapterTargets: targetsToRequest,
              },
              // Sinopses DESTA Parte (continuidade intra-Parte).
              previousSynopses: localSynopses,
              // Sinopses já prontas da OUTRA Parte (continuidade cruzada P1→P2).
              // Best-effort: o que a P1 produziu até agora, sem bloquear o
              // paralelismo. Costura os GRAVES de continuidade cruzada na origem
              // (a Escrita), em vez de deixar tudo pro Revisor.
              ...(crossSnap.length > 0
                ? { crossPartSynopses: crossSnap }
                : {}),
            }),
            signal,
          });
        } catch (e) {
          // Erro de rede (conexão caiu, DNS, fetch abortado por timeout do SO).
          if (signal.aborted) break;
          if (attempt <= MAX_RETRIES_PER_BATCH) {
            const delay = backoffDelay(attempt);
            backoffMs += delay;
            await sleep(delay, signal);
            if (signal.aborted) break;
            continue;
          }
          batchFatalError = `Falha de rede ao gerar o lote: ${(e as Error).message}`;
          break;
        }

        if (!res.ok || !res.body) {
          const errText =
            (await res.text().catch(() => "")) || res.statusText;
          // 408/429/5xx são transientes (rate-limit, servidor ocupado) —
          // retenta com backoff. Conta como sinal de saturação de cota.
          const transient =
            res.status === 408 || res.status === 429 || res.status >= 500;
          if (transient && attempt <= MAX_RETRIES_PER_BATCH) {
            transientRetries += 1;
            const delay = backoffDelay(attempt);
            backoffMs += delay;
            await sleep(delay, signal);
            if (signal.aborted) break;
            continue;
          }
          batchFatalError = errText;
          break;
        }

        const acc = await readResponseText(res, signal, onLive, () => {
          if (ttftMs === 0) ttftMs = Date.now() - batchStart;
        });
        if (signal.aborted) break;

        // A rota injeta marcadores login/binário quando a SDK falha COM
        // res.ok=true — o "lote" é só uma mensagem de erro. Detecta e ABORTA a
        // run inteira com a causa real, em vez de truncar o roteiro em silêncio.
        const hardReason = detectHardMarker(acc);
        if (hardReason) {
          fatalRaised = true;
          throw new EscritaFatalError(hardReason);
        }

        const parsed = parseEscritaBatch(acc, b.part);

        const fallbackOnly =
          parsed.chapters.length > 0 &&
          parsed.chapters.every((c) => c.number === 0);
        const noRealChapters = parsed.chapters.length === 0 || fallbackOnly;

        // Lote sem capítulo de verdade. Três caminhos:
        if (noRealChapters) {
          // 1) Erro real da SDK (cota/servidor) injetado como `[ERRO]` → aborta
          //    a run inteira com a causa (não adianta seguir, vai falhar igual).
          const erroReason = detectErroMarker(acc);
          if (erroReason) {
            fatalRaised = true;
            throw new EscritaFatalError(erroReason);
          }
          // 2) Só formato inválido / resposta vazia → retenta com backoff.
          if (attempt <= MAX_RETRIES_PER_BATCH) {
            const delay = backoffDelay(attempt);
            backoffMs += delay;
            await sleep(delay, signal);
            if (signal.aborted) break;
            continue;
          }
          // 3) Esgotou as tentativas → registra o motivo e pula este lote.
          batchFatalError = fallbackOnly
            ? `O modelo não seguiu o formato esperado (sem cabeçalhos "## Capítulo N — Título") após ${MAX_RETRIES_PER_BATCH + 1} tentativas.`
            : `O modelo retornou resposta vazia para o lote após ${MAX_RETRIES_PER_BATCH + 1} tentativas.`;
          break;
        }

        if (signal.aborted) break;

        localChapters.push(...parsed.chapters);
        localSynopses.push(...parsed.synopses);

        const gotNumbers = new Set(
          parsed.chapters.map((c) => c.number).filter((n) => n > 0),
        );
        const stillMissing = chaptersToRequest.filter(
          (n) => !gotNumbers.has(n),
        );
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

      batchesDone += 1;

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

      // Dedup LOCAL desta Parte (last-wins) — resolve cap parcial reentregue num
      // retry. Cada loop só mexe no seu array, então não cruza Partes.
      const dedupResult = dedupChaptersLast(localChapters);
      if (dedupResult.removed > 0) {
        localChapters.length = 0;
        localChapters.push(...dedupResult.chapters);
        accWarnings.push({
          batchIndex: b.batchIndex,
          part: b.part,
          expected: [],
          missing: [],
          duplicatesRemoved: dedupResult.removed,
        });
      }

      // [perf] tempo + palavras deste batch. TTFT alto vs total alto separa
      // espera de cota (fila do servidor) de geração de output.
      const batchWords = b.chapters.reduce((sum, n) => {
        const ch = localChapters.find(
          (c) => canonPart(c.part) === canonPart(b.part) && c.number === n,
        );
        return sum + (ch ? countWords(ch.content) : 0);
      }, 0);
      console.info(
        `[perf] escrita batch ${b.part} #${b.batchIndex}: TTFT ${(ttftMs / 1000).toFixed(1)}s, total ${((Date.now() - batchStart) / 1000).toFixed(1)}s, ${batchWords}p, ${attempt} tentativa(s)`,
      );

      emitPartial();
    }
  };

  // ═══ Calibração de word-count (Sonnet) — SOBREPOSTA à geração ═════════════
  // Cada Parte calibra assim que SUA geração termina (via `.then` no loop), e
  // NÃO no fim das duas. Como a P1 acaba antes da P2, a calibração da P1 roda em
  // paralelo com a cauda de geração da P2 — aproveita a cota que ficava ociosa e
  // tira a calibração do caminho crítico do "fim". Lossless: a vizinhança de
  // sinopses já é por-Parte (`partSynopses` é só desta Parte), então calibrar a
  // P1 antes da P2 ficar pronta não perde contexto nenhum. O limitador
  // COMPARTILHADO (`createLimiter`) garante o teto único `CALIBRATION_CONCURRENCY`
  // mesmo com as duas Partes alimentando o mesmo pool. Reescrita em Sonnet
  // (ajuste mecânico de tamanho — ver /api/escrita-fix-wordcount). Threshold/
  // concorrência em @/lib/escrita-calibration.
  const calibLimiter = createLimiter(CALIBRATION_CONCURRENCY, { signal });
  const calibratePart = async (
    partLabel: "Parte 1" | "Parte 2",
    partChapters: EscritaChapter[],
    partSynopses: EscritaSynopsis[],
    targets: number[],
  ): Promise<void> => {
    if (signal.aborted || fatalRaised) return;

    const candidates = partChapters
      .map((ch) => ({
        ch,
        target: ch.number >= 1 ? (targets[ch.number - 1] ?? null) : null,
      }))
      .filter((c) => {
        if (!c.target) return false;
        const cur = countWords(c.ch.content);
        return Math.abs(cur - c.target) / c.target > CALIBRATION_THRESHOLD;
      });
    if (candidates.length === 0) return;

    // [perf] quantos caps DESTA Parte saíram fora do alvo (±8%) → reescrita
    // Sonnet de cap inteiro. Distingue EXPANDIR (cap curto) de ENCURTAR (longo):
    // muitos "expandir" = o prompt da Escrita está enviesado pra escrever curto.
    const toExpand = candidates.filter(
      (c) => countWords(c.ch.content) < c.target!,
    ).length;
    console.info(
      `[perf] escrita: ${partLabel} — ${candidates.length} cap(s) fora do alvo → recalibração (${toExpand} expandir, ${candidates.length - toExpand} encurtar)`,
    );

    const calibStart = Date.now();
    let done = 0;
    await Promise.all(
      candidates.map((cand) =>
        calibLimiter(async () => {
          if (signal.aborted || fatalRaised) return;
          if (hooks.beforeUnit) await hooks.beforeUnit();
          if (signal.aborted || fatalRaised) return;

          const current = countWords(cand.ch.content);
          done += 1;
          hooks.onProgress?.({
            kind: "calibrating",
            currentIndex: done,
            totalToCalibrate: candidates.length,
            part: partLabel,
            chapter: cand.ch.number,
          });

          // Vizinhança ±1 cap DESTA Parte (`partSynopses` já é só dela).
          const neighborSynopses = partSynopses
            .filter((s) => Math.abs(s.number - cand.ch.number) <= 1)
            .map((s) => ({
              number: s.number,
              part: s.part,
              synopsis: s.synopsis,
            }));

          try {
            const fixRes = await fetch(`/api/escrita-fix-wordcount`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category,
                chapter: {
                  number: cand.ch.number,
                  title: cand.ch.title,
                  part: partLabel,
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
              // Muta o capítulo NO LUGAR no array desta Parte — mergedChapters()
              // / snapshot() já reflete (não há array materializado separado).
              const idx = partChapters.findIndex(
                (c) => c.number === cand.ch.number,
              );
              if (idx >= 0) {
                partChapters[idx] = {
                  ...partChapters[idx]!,
                  content: newCh.content,
                  title: newCh.title ?? partChapters[idx]!.title,
                  generatedAt: new Date().toISOString(),
                };
                emitPartial();
              }
            }
          } catch (e) {
            if ((e as Error).name === "AbortError") return;
            // mantém o capítulo original — calibração é best-effort
          }
        }),
      ),
    );

    console.info(
      `[perf] escrita: ${partLabel} — calibração de ${candidates.length} cap(s) levou ${((Date.now() - calibStart) / 1000).toFixed(1)}s`,
    );
  };

  // ═══ Roda as duas Partes EM PARALELO; cada uma CALIBRA ao terminar ════════
  // onLiveText só na Parte 1 (um stream coerente; dois embaralhariam o preview).
  // O `.then(calibratePart)` faz a calibração da P1 sobrepor a cauda da P2.
  const batchesPhaseStart = Date.now();
  await Promise.all([
    // P1 é a fundação — não recebe contexto cruzado (5º arg ausente).
    runPartLoop(planP1, p1Chapters, p1Synopses, hooks.onLiveText).then(() =>
      calibratePart("Parte 1", p1Chapters, p1Synopses, targetsP1),
    ),
    // P2 recebe, a cada batch, as sinopses da P1 já prontas naquele instante
    // (best-effort, sem bloquear) — costura a continuidade cruzada na origem.
    runPartLoop(planP2, p2Chapters, p2Synopses, undefined, () => [
      ...p1Synopses,
    ]).then(() => calibratePart("Parte 2", p2Chapters, p2Synopses, targetsP2)),
  ]);
  console.info(
    `[perf] escrita: geração+calibração levou ${((Date.now() - batchesPhaseStart) / 1000).toFixed(1)}s — ${transientRetries} retry transiente (429/5xx), ~${(backoffMs / 1000).toFixed(0)}s em backoff`,
  );

  const result = snapshot();
  emitPartial();
  return result;
}
