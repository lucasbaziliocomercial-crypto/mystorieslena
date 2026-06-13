import { compressToUTF16, decompressFromUTF16 } from "lz-string";

import { WORKER_SOURCE } from "@/lib/lz-compress-worker-source";

import type {
  EscritaChapter,
  Roteiro,
  StepGenerationSnapshot,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { DEFAULT_CATEGORY } from "@/types/roteiro";
import { hasXmlCruft, stripXmlCruft } from "@/lib/parse-revisor-output";
import {
  hasEscritaContamination,
  stripEscritaContamination,
} from "@/lib/sanitize-escrita-content";
import { normalizeEscritaOutput } from "@/lib/normalize-escrita";
import {
  hasChapterTitleAnnotation,
  stripChapterHeaderAnnotations,
  stripChapterTitleAnnotation,
} from "@/lib/strip-chapter-annotations";

const KEY = "veludo:roteiros";

/** Chave onde um blob ilegível é posto em quarentena (ver `readFromStorage`). */
const CORRUPT_KEY = `${KEY}.corrupt`;

/**
 * Prefixo das chaves laterais que guardam o `dataUrl` (base64, ~0,3-0,5 MB) da
 * imagem de referência de cada roteiro, FORA do blob `veludo:roteiros`. Sem
 * isso, a imagem entrava em TODA compressão da biblioteca (a cada save), e o
 * custo de compressão cresce com o nº de roteiros — era o maior peso único por
 * roteiro além da Escrita. Movê-la pra uma chave própria deixa o blob quente
 * comprimir sem ela (saves mais rápidos), mantendo a imagem intacta.
 *
 * Invariante: o cache em memória SEMPRE tem o `Roteiro` com `dataUrl` reidratado
 * (`hydrateRefImage` no read); só o blob persistido grava `dataUrl: ""`
 * (`stripRefImage` no write). Nenhum consumidor de `referenceImage` muda —
 * todos leem do cache reidratado.
 */
const REFIMG_PREFIX = "veludo:refimg:";

/**
 * Rastreia, por id, a ÚLTIMA string de `dataUrl` já gravada na chave lateral —
 * por identidade de referência (`===`), não por valor. Quando a imagem não muda,
 * o cache mantém a MESMA string (nada a recria), então `stripRefImage` detecta
 * "já persistida" em O(1) e NÃO reescreve a chave lateral (reescrever ~0,4 MB a
 * cada save reintroduziria o custo por-save que estamos eliminando). Só quando a
 * roteirista troca a imagem (nova string) é que regrava. Limpo no reset/import.
 */
const lastWrittenRefImg = new Map<string, string>();

/**
 * Prefixo das chaves laterais que guardam o `history` (pilhas de snapshots de
 * cada step) de cada roteiro, FORA do blob `veludo:roteiros`. Mesmo motivo da
 * imagem (`REFIMG_PREFIX`): o `history` era ~55% da biblioteca (~4,8 MB de 9 MB)
 * e entrava em TODA serialização/compressão a cada save — com vários roteiros
 * gerando em paralelo (checkpoint a cada ~2,5 s por job), isso travava a main
 * thread e segurava a leitura do stream. Como o `history` muda RARAMENTE (só ao
 * regerar/aplicar correção), movê-lo pra chave própria deixa os saves do
 * streaming comprimirem só os `outputs` (~metade do tamanho), sem perder nada.
 *
 * O valor é comprimido (`COMPRESSED_PREFIX` + lz-string) porque cru (~0,6 MB ×
 * Nroteiros) estouraria a quota do localStorage; como a escrita é rara, comprimir
 * de vez em quando é barato. Invariante: o cache em memória SEMPRE tem o `history`
 * reidratado (`hydrateHistory` no read, que também REMOVE o marcador
 * `historyExternal`); só o blob persistido grava `history: undefined` +
 * `historyExternal: true`.
 */
const HISTORY_PREFIX = "veludo:history:";

/**
 * Rastreia, por id, o ÚLTIMO objeto `history` já gravado na chave lateral — por
 * identidade de referência (`===`), não por valor. Quando o roteiro é salvo SEM
 * mexer no `history` (caso do streaming: `setOutput` só troca `outputs`, então o
 * spread `{...r}` mantém a MESMA referência de `history`), `stripHistory` detecta
 * "já persistido" em O(1) e NÃO reescreve a chave (reescrever ~0,6 MB a cada save
 * reintroduziria o custo que estamos eliminando). Só quando o `history` vira um
 * objeto novo (push/restore/delete de snapshot) é que regrava. Limpo no reset/import.
 */
const lastWrittenHistory = new Map<string, Roteiro["history"]>();

/**
 * Sentinel que marca um valor comprimido com lz-string. Sem isso, não dá pra
 * distinguir um JSON cru (formato legado, escrito por versões ≤ 1.0.51) de
 * uma string UTF-16 comprimida — leitura quebraria pra qualquer um dos dois.
 * Backward-compat: roteiros antigos seguem sendo lidos como JSON cru, e o
 * próximo `saveRoteiro` regrava comprimido.
 */
const COMPRESSED_PREFIX = "LZ1:";

/**
 * Cap de snapshots por step no histórico. Antes era 20, mas com o texto
 * completo da Escrita (~200KB) salvo em cada snapshot sem dedup, isso
 * sozinho enchia o localStorage (4MB por roteiro só de histórico). Baixado
 * pra 2 (de 5) pra aliviar máquinas fracas: ainda dá pra desfazer a última
 * geração, mas corta ~600KB-1MB por roteiro do blob comprimido a cada save.
 * Exportado pra o store (`store/wizard.ts`) usar o MESMO cap e não divergir
 * — os dois truncam pilhas, então repetir o literal era fonte de bug.
 */
export const HISTORY_CAP = 2;

function isBrowser() {
  return typeof window !== "undefined";
}

/**
 * Move uma chave opcional dentro de um Partial<Record<StepId, T>> de origem
 * para destino, sem sobrescrever destino se já existir. Idempotente: rodar
 * duas vezes mantém o resultado da primeira. Retorna o objeto original se
 * não houve mudança (dedupe de re-renders).
 */
function moveStepKey<T>(
  obj: Partial<Record<StepId, T>> | undefined,
  from: StepId,
  to: StepId,
): Partial<Record<StepId, T>> | undefined {
  if (!obj) return obj;
  const fromVal = obj[from];
  if (fromVal === undefined) return obj;
  // Se destino já existe (idempotência ou conflito), só apaga origem.
  const next: Partial<Record<StepId, T>> = { ...obj };
  if (next[to] === undefined) {
    next[to] = fromVal;
  }
  delete next[from];
  return next;
}

/**
 * Backfill: roteiros antigos no localStorage não têm `category`. Como o app
 * sempre rodou só para Romance de Milionário (1ª pessoa), todo roteiro
 * legado vira dessa categoria. Sem esse fallback, qualquer lookup de
 * `category` em roteiros antigos quebraria silenciosamente.
 *
 * Também migra o step legado `revisor` (único, processava as duas Partes
 * juntas) para `revisor1` (Parte 1). `revisor2` fica vazio para a roteirista
 * gerar manualmente. Mantém o conteúdo da revisão antiga acessível como
 * histórico/output da Parte 1 — nada é descartado. A divisão real só vale
 * pra revisões futuras.
 */
function migrateLegacy(r: Roteiro): Roteiro {
  let next = r.category ? r : { ...r, category: DEFAULT_CATEGORY };

  // O StepId mudou — `"revisor"` não existe mais nos tipos. Como roteiros
  // antigos têm strings em runtime mesmo, fazemos a checagem via cast.
  const LEGACY_KEY = "revisor" as StepId;
  const hasLegacyOutput = next.outputs?.[LEGACY_KEY] !== undefined;
  const hasLegacyInput = next.userInputs?.[LEGACY_KEY] !== undefined;
  const hasLegacyHistory = next.history?.[LEGACY_KEY] !== undefined;
  const hasLegacyDraft =
    (next.drafts as Partial<Record<StepId, unknown>> | undefined)?.[
      LEGACY_KEY
    ] !== undefined;
  const hasLegacyCurrentStep = (next.currentStep as string) === "revisor";

  if (
    hasLegacyOutput ||
    hasLegacyInput ||
    hasLegacyHistory ||
    hasLegacyDraft ||
    hasLegacyCurrentStep
  ) {
    next = {
      ...next,
      outputs: moveStepKey(next.outputs, LEGACY_KEY, "revisor1") ?? next.outputs,
      userInputs:
        moveStepKey(next.userInputs, LEGACY_KEY, "revisor1") ?? next.userInputs,
      history:
        moveStepKey(next.history, LEGACY_KEY, "revisor1") ?? next.history,
      drafts: (moveStepKey(
        next.drafts as Partial<Record<StepId, unknown>> | undefined,
        LEGACY_KEY,
        "revisor1",
      ) ?? next.drafts) as Roteiro["drafts"],
      currentStep: hasLegacyCurrentStep ? "revisor1" : next.currentStep,
    };
  }
  return next;
}

/**
 * Limpa tags do schema <erros_detalhados> que tenham vazado pro conteúdo da
 * Escrita em aplicações de correção anteriores ao fix. O LLM ocasionalmente
 * emitia um <trecho_corrigido> contendo, como texto, literalmente as tags
 * `</trecho_original>` e `<trecho_corrigido>` — o find+replace do Revisor/
 * Overview então gravava esse XML cru no roteiro final do Step 4. Sanitiza:
 *
 *  • outputs.escrita.content (texto monolítico)
 *  • outputs.escrita.metadata.chapters[i].content (capítulos parseados)
 *  • history.escrita[i].content (snapshots — o histórico também pode ter
 *    pego cruft num save anterior)
 *  • history.escrita[i].metadata.chapters[j].content
 *
 * Idempotente — só executa o replace quando detecta cruft. Roteiros limpos
 * pulam tudo via `hasXmlCruft` early-return. Roda no listRoteiros, então o
 * próximo save persiste a versão limpa automaticamente.
 */
function cleanEscritaXmlCruft(output: StepOutput | undefined):
  | { output: StepOutput; changed: boolean }
  | { output: StepOutput | undefined; changed: false } {
  if (!output) return { output, changed: false };
  let changed = false;
  let nextContent = output.content;
  if (hasXmlCruft(nextContent)) {
    nextContent = stripXmlCruft(nextContent);
    changed = true;
  }
  let nextChapters: EscritaChapter[] | undefined = output.metadata?.chapters;
  if (nextChapters && nextChapters.some((c) => hasXmlCruft(c.content))) {
    nextChapters = nextChapters.map((c) =>
      hasXmlCruft(c.content) ? { ...c, content: stripXmlCruft(c.content) } : c,
    );
    changed = true;
  }
  if (!changed) return { output, changed: false };
  return {
    output: {
      ...output,
      content: nextContent,
      ...(nextChapters
        ? {
            metadata: {
              ...(output.metadata ?? {}),
              chapters: nextChapters,
            },
          }
        : {}),
    },
    changed: true,
  };
}

/**
 * Limpa a anotação de planejamento (`(~X.XXX palavras — ritmo Y)`) que o
 * modelo da Escrita às vezes copia do cabeçalho da Estrutura pro título do
 * capítulo no roteiro final. Sanitiza tanto o texto monolítico
 * (`outputs.escrita.content`) quanto os títulos em `metadata.chapters[i].title`.
 *
 * Idempotente — early-return quando não há anotação. Roda no listRoteiros,
 * então o próximo save persiste a versão limpa. Cura roteiros já gerados
 * (alpha-king, máfia, milionário) sem precisar regerar.
 */
function cleanEscritaChapterAnnotations(output: StepOutput | undefined):
  | { output: StepOutput; changed: boolean }
  | { output: StepOutput | undefined; changed: false } {
  if (!output) return { output, changed: false };
  let changed = false;

  let nextContent = output.content;
  if (hasChapterTitleAnnotation(nextContent)) {
    nextContent = stripChapterHeaderAnnotations(nextContent);
    changed = true;
  }

  let nextChapters: EscritaChapter[] | undefined = output.metadata?.chapters;
  const titleNeedsClean = (c: EscritaChapter) =>
    !!c.title && c.title !== stripChapterTitleAnnotation(c.title);
  if (nextChapters && nextChapters.some(titleNeedsClean)) {
    nextChapters = nextChapters.map((c) =>
      titleNeedsClean(c)
        ? { ...c, title: stripChapterTitleAnnotation(c.title!) }
        : c,
    );
    changed = true;
  }

  if (!changed) return { output, changed: false };
  return {
    output: {
      ...output,
      content: nextContent,
      ...(nextChapters
        ? {
            metadata: {
              ...(output.metadata ?? {}),
              chapters: nextChapters,
            },
          }
        : {}),
    },
    changed: true,
  };
}

/**
 * Remove contaminação de metadados/relatório que vazou pra PROSA da Escrita:
 * linhas de contagem de palavras (`[Contagem: ~1.750 palavras]`) e o relatório
 * do Revisor apendado (`# ❌ PRINCIPAIS ERROS`, `<erros_detalhados>`, etc.).
 * Cura roteiros JÁ gerados na origem — o próximo save persiste a versão limpa,
 * sem a roteirista precisar regerar. Limpa o content monolítico E cada
 * `metadata.chapters[i].content`. Idempotente — early-return via
 * `hasEscritaContamination`. Ver `lib/sanitize-escrita-content.ts`.
 */
function cleanEscritaContentContamination(output: StepOutput | undefined):
  | { output: StepOutput; changed: boolean }
  | { output: StepOutput | undefined; changed: false } {
  if (!output) return { output, changed: false };
  let changed = false;

  let nextContent = output.content;
  if (hasEscritaContamination(nextContent)) {
    nextContent = stripEscritaContamination(nextContent);
    changed = true;
  }

  let nextChapters: EscritaChapter[] | undefined = output.metadata?.chapters;
  if (nextChapters && nextChapters.some((c) => hasEscritaContamination(c.content))) {
    nextChapters = nextChapters.map((c) =>
      hasEscritaContamination(c.content)
        ? { ...c, content: stripEscritaContamination(c.content) }
        : c,
    );
    changed = true;
  }

  if (!changed) return { output, changed: false };
  return {
    output: {
      ...output,
      content: nextContent,
      ...(nextChapters
        ? {
            metadata: {
              ...(output.metadata ?? {}),
              chapters: nextChapters,
            },
          }
        : {}),
    },
    changed: true,
  };
}

function sanitizeRoteiroXmlCruft(r: Roteiro): Roteiro {
  let changed = false;
  let outputs = r.outputs;
  const cleaned = cleanEscritaXmlCruft(r.outputs?.escrita);
  if (cleaned.changed && cleaned.output) {
    outputs = { ...r.outputs, escrita: cleaned.output };
    changed = true;
  }

  // Remove a anotação `(~X palavras — ritmo Y)` que vazou do cabeçalho da
  // Estrutura pro título dos capítulos. Roda antes do normalize: pra roteiros
  // não-editados o normalize reconstrói o content a partir dos títulos já
  // limpos; pra editados o content limpo aqui é preservado.
  const cleanedAnno = cleanEscritaChapterAnnotations(outputs?.escrita);
  if (cleanedAnno.changed && cleanedAnno.output) {
    outputs = { ...(outputs ?? {}), escrita: cleanedAnno.output };
    changed = true;
  }

  // Remove contagem de palavras / relatório do Revisor que vazou pra prosa
  // (ver cleanEscritaContentContamination). Roda no load → próximo save grava limpo.
  const cleanedContamination = cleanEscritaContentContamination(outputs?.escrita);
  if (cleanedContamination.changed && cleanedContamination.output) {
    outputs = { ...(outputs ?? {}), escrita: cleanedContamination.output };
    changed = true;
  }

  // Auto-heal de duplicatas: roteiros corrompidos por versões anteriores
  // (antes da invariante de dedup no setOutput) viram limpos automaticamente
  // no load. Estratégia "longest" porque snapshots/output salvos são versões
  // estáveis — em load não há contexto de "regeneração recente".
  const escritaOutput = outputs?.escrita;
  if (escritaOutput) {
    const normalized = normalizeEscritaOutput(escritaOutput, {
      strategy: "longest",
      source: "storage:load",
    });
    if (normalized.changed) {
      outputs = { ...(outputs ?? {}), escrita: normalized.output };
      changed = true;
    }
  }

  let history = r.history;
  const escritaHistory = r.history?.escrita;
  if (escritaHistory && escritaHistory.length > 0) {
    let snapshotsChanged = false;
    const nextSnapshots: StepGenerationSnapshot[] = escritaHistory.map(
      (snap) => {
        let cleanContent = hasXmlCruft(snap.content)
          ? stripXmlCruft(snap.content)
          : snap.content;
        if (hasChapterTitleAnnotation(cleanContent)) {
          cleanContent = stripChapterHeaderAnnotations(cleanContent);
        }
        if (hasEscritaContamination(cleanContent)) {
          cleanContent = stripEscritaContamination(cleanContent);
        }
        const snapChapters = snap.metadata?.chapters;
        const titleNeedsClean = (c: EscritaChapter) =>
          !!c.title && c.title !== stripChapterTitleAnnotation(c.title);
        const chaptersNeedClean =
          !!snapChapters &&
          snapChapters.some(
            (c) =>
              hasXmlCruft(c.content) ||
              titleNeedsClean(c) ||
              hasEscritaContamination(c.content),
          );
        let next = snap;
        let snapChanged = false;
        if (cleanContent !== snap.content || chaptersNeedClean) {
          next = {
            ...snap,
            content: cleanContent,
            ...(chaptersNeedClean && snapChapters
              ? {
                  metadata: {
                    ...(snap.metadata ?? {}),
                    chapters: snapChapters.map((c) => {
                      let nc = c;
                      if (hasXmlCruft(nc.content)) {
                        nc = { ...nc, content: stripXmlCruft(nc.content) };
                      }
                      if (hasEscritaContamination(nc.content)) {
                        nc = {
                          ...nc,
                          content: stripEscritaContamination(nc.content),
                        };
                      }
                      if (titleNeedsClean(nc)) {
                        nc = {
                          ...nc,
                          title: stripChapterTitleAnnotation(nc.title!),
                        };
                      }
                      return nc;
                    }),
                  },
                }
              : {}),
          };
          snapChanged = true;
        }
        // Dedup também os snapshots do histórico. O bug do client não foi
        // escolha intencional da roteirista — restaurar um snapshot duplicado
        // só re-introduz o problema. Estratégia "longest" preserva a versão
        // mais completa que existia no momento do snapshot.
        if (next.metadata?.chapters) {
          const normalizedSnap = normalizeEscritaOutput(
            {
              content: next.content,
              metadata: next.metadata,
              generatedAt: next.generatedAt,
              editedAt: next.editedAt,
              edited: next.edited,
            },
            { strategy: "longest", source: "storage:history" },
          );
          if (normalizedSnap.changed) {
            next = {
              ...next,
              content: normalizedSnap.output.content,
              metadata: normalizedSnap.output.metadata,
            };
            snapChanged = true;
          }
        }
        if (!snapChanged) return snap;
        snapshotsChanged = true;
        return next;
      },
    );
    if (snapshotsChanged) {
      history = { ...(r.history ?? {}), escrita: nextSnapshots };
      changed = true;
    }
  }

  if (!changed) return r;
  return { ...r, outputs, ...(history ? { history } : {}) };
}

/**
 * Trunca qualquer pilha de history que esteja acima do HISTORY_CAP. Roteiros
 * salvos por versões antigas podem ter até 20 snapshots — esse prune roda na
 * leitura pra que a primeira gravação após a atualização já saia enxuta.
 */
function pruneHistory(r: Roteiro): Roteiro {
  if (!r.history) return r;
  let changed = false;
  const newHistory: Partial<Record<StepId, StepGenerationSnapshot[]>> = {};
  for (const [step, stack] of Object.entries(r.history) as [
    StepId,
    StepGenerationSnapshot[] | undefined,
  ][]) {
    if (!stack) continue;
    if (stack.length > HISTORY_CAP) {
      newHistory[step] = stack.slice(0, HISTORY_CAP);
      changed = true;
    } else {
      newHistory[step] = stack;
    }
  }
  return changed ? { ...r, history: newHistory } : r;
}

/**
 * Reidrata o `dataUrl` da imagem de referência a partir da chave lateral
 * (`REFIMG_PREFIX + id`). Roda no pipeline de leitura, DEPOIS do blob ser
 * descomprimido. Casos:
 *  • Sem `referenceImage` → no-op.
 *  • `dataUrl` já preenchido (roteiro LEGADO, imagem ainda inline no blob) →
 *    no-op; o 1º save migra pra chave lateral via `stripRefImage`. NÃO semeia
 *    `lastWrittenRefImg` (queremos que o 1º save grave a chave lateral).
 *  • `dataUrl` vazio → lê a chave lateral; se achar, reidrata E semeia
 *    `lastWrittenRefImg` (já está persistida → o 1º save não reescreve). Se a
 *    chave sumiu, mantém vazio (estado degradado, não quebra).
 */
function hydrateRefImage(r: Roteiro): Roteiro {
  const img = r.referenceImage;
  if (!img) return r;
  if (img.dataUrl) return r; // inline legado ou já reidratado
  try {
    const s = window.localStorage.getItem(REFIMG_PREFIX + r.id);
    if (s) {
      lastWrittenRefImg.set(r.id, s);
      return { ...r, referenceImage: { ...img, dataUrl: s } };
    }
  } catch {
    /* leitura da chave lateral falhou — mantém vazio */
  }
  return r;
}

/**
 * Reidrata o `history` a partir da chave lateral (`HISTORY_PREFIX + id`). Roda no
 * pipeline de leitura, DEPOIS do blob ser descomprimido, e por ÚLTIMO (depois de
 * `hydrateRefImage`) pra a semente de `lastWrittenHistory` casar com a identidade
 * final do objeto no cache. Casos:
 *  • `historyExternal !== true` → no-op (roteiro LEGADO com history inline, ou sem
 *    history); o 1º save migra pra chave lateral via `stripHistory`. NÃO semeia o
 *    rastreador (queremos que o 1º save grave a chave).
 *  • `historyExternal === true` → lê a chave lateral, descomprime+parseia, reidrata
 *    E semeia `lastWrittenHistory` (já persistido → o 1º save não reescreve). REMOVE
 *    o marcador `historyExternal` (ele é só do blob; nunca entra no cache/backup).
 *  • Falha (chave sumiu/corrompida/parse) → degrada pra `history` vazio SÓ neste
 *    roteiro (remove o marcador, NÃO semeia, NÃO lança, NÃO bloqueia a leitura). O
 *    próximo `stripHistory` vê `history` undefined → limpa a chave órfã. Perde-se só
 *    a pilha de "desfazer" (cap 2) deste roteiro — NUNCA o roteiro (`outputs`).
 */
function hydrateHistory(r: Roteiro): Roteiro {
  if (r.historyExternal !== true) return r;
  try {
    const raw = window.localStorage.getItem(HISTORY_PREFIX + r.id);
    if (raw) {
      const history = JSON.parse(
        raw.startsWith(COMPRESSED_PREFIX)
          ? (decompressFromUTF16(raw.slice(COMPRESSED_PREFIX.length)) ?? "")
          : raw,
      ) as Roteiro["history"];
      // O marcador é só do blob — sai do objeto em memória.
      const next: Roteiro = { ...r, history };
      delete next.historyExternal;
      lastWrittenHistory.set(r.id, history);
      return next;
    }
  } catch {
    /* chave lateral corrompida/ausente — degrada pra history vazio neste roteiro */
  }
  // Chave ausente/corrompida: remove o marcador e zera o history SÓ neste roteiro
  // (degrada vazio, sem bloquear a leitura da biblioteca; o `outputs` fica intacto).
  const next: Roteiro = { ...r };
  delete next.historyExternal;
  delete next.history;
  return next;
}

// O corpo do Web Worker de compressão (compressor lz-string vendorizado +
// handler de mensagem) vive em `lib/lz-compress-worker-source.ts` (módulo SEM
// dependências, pra ser embutível no worker E testável via node). Importado
// como WORKER_SOURCE no topo. Ver o porquê do worker em `getCompressWorker`.

/** Worker compartilhado (lazy). Nunca recriado salvo erro/reset. */
let compressWorker: Worker | null = null;
/** Após uma falha de criação/runtime do worker, todo save cai no caminho síncrono. */
let workerUnavailable = false;
let workerSeq = 0;
const workerPending = new Map<
  number,
  {
    resolve: (s: string) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/** Teto pra um compress travado nunca pendurar um save (cai no fallback síncrono). */
const WORKER_COMPRESS_TIMEOUT_MS = 15_000;

function rejectAllWorkerPending(reason: unknown) {
  for (const [, p] of workerPending) {
    clearTimeout(p.timer);
    p.reject(reason);
  }
  workerPending.clear();
}

function getCompressWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (compressWorker) return compressWorker;
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url); // o Worker já segurou o recurso; pode revogar.
    w.onmessage = (e: MessageEvent) => {
      const data = e.data as { id: number; ok: boolean; value?: string };
      const p = workerPending.get(data.id);
      if (!p) return;
      clearTimeout(p.timer);
      workerPending.delete(data.id);
      if (data.ok && typeof data.value === "string") p.resolve(data.value);
      else p.reject(new Error("worker compress falhou"));
    };
    w.onerror = () => {
      // Erro duro do worker: derruba tudo e desativa — saves seguem síncronos.
      rejectAllWorkerPending(new Error("worker error"));
      workerUnavailable = true;
      try {
        w.terminate();
      } catch {
        /* best-effort */
      }
      if (compressWorker === w) compressWorker = null;
    };
    compressWorker = w;
    return w;
  } catch {
    workerUnavailable = true;
    return null;
  }
}

/** Comprime `json` no worker. Rejeita se indisponível/erro/timeout → fallback síncrono. */
function compressViaWorker(json: string): Promise<string> {
  const w = getCompressWorker();
  if (!w) return Promise.reject(new Error("worker indisponível"));
  return new Promise<string>((resolve, reject) => {
    const id = ++workerSeq;
    const timer = setTimeout(() => {
      workerPending.delete(id);
      reject(new Error("worker timeout"));
    }, WORKER_COMPRESS_TIMEOUT_MS);
    workerPending.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ id, json });
    } catch (e) {
      clearTimeout(timer);
      workerPending.delete(id);
      reject(e);
    }
  });
}

/**
 * Comprime um `json` JÁ stringificado (caminho síncrono / fallback). Mantém o
 * log `[perf] serialize` e o fallback de gravar cru se a compressão der pau.
 */
function serializeJsonSync(json: string): string {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  try {
    const compressed = compressToUTF16(json);
    if (compressed && compressed.length > 0) {
      if (t0) {
        console.info(
          `[perf] serialize: ${(performance.now() - t0).toFixed(0)}ms, ${json.length} chars`,
        );
      }
      return COMPRESSED_PREFIX + compressed;
    }
  } catch (e) {
    console.warn("[storage] falha na compressão, gravando cru:", e);
  }
  return json;
}

function serialize(roteiros: Roteiro[]): string {
  // [perf] mede o custo síncrono de compressão. O caminho QUENTE (streaming) usa
  // o worker (compressViaWorker) e NÃO passa aqui; isto cobre o síncrono:
  // saveRoteiro/delete/import/backup/export e o fallback do unload.
  return serializeJsonSync(JSON.stringify(roteiros));
}

/**
 * Tira o `dataUrl` da imagem do roteiro ANTES de ele entrar no blob comprimido,
 * gravando-o na chave lateral. Retorna um CLONE raso com `dataUrl: ""` (o cache
 * em memória, intocado, segue com a imagem reidratada). Pontos:
 *  • `storageReadBlocked` (blob em quarentena) → não mexe em nada.
 *  • Sem imagem → passa direto; se sobrou chave lateral de uma imagem apagada,
 *    limpa.
 *  • Imagem inalterada (mesma string já gravada) → só tira do blob, sem reescrever.
 *  • Imagem nova/legada inline → grava a chave lateral e tira do blob.
 *  • Falha de quota ao gravar a chave → MANTÉM inline (nunca perde a imagem).
 */
function stripRefImage(r: Roteiro): Roteiro {
  if (storageReadBlocked) return r;
  const img = r.referenceImage;
  const dataUrl = img?.dataUrl;
  if (!dataUrl) {
    if (lastWrittenRefImg.has(r.id)) {
      try {
        window.localStorage.removeItem(REFIMG_PREFIX + r.id);
      } catch {
        /* best-effort */
      }
      lastWrittenRefImg.delete(r.id);
    }
    return r;
  }
  if (lastWrittenRefImg.get(r.id) === dataUrl) {
    return { ...r, referenceImage: { ...img!, dataUrl: "" } };
  }
  try {
    window.localStorage.setItem(REFIMG_PREFIX + r.id, dataUrl);
    lastWrittenRefImg.set(r.id, dataUrl);
    return { ...r, referenceImage: { ...img!, dataUrl: "" } };
  } catch {
    // Quota etc — não dá pra mover; mantém inline pra NUNCA perder a imagem.
    return r;
  }
}

/**
 * Tira o `history` do roteiro ANTES de ele entrar no blob comprimido, gravando-o
 * (comprimido) na chave lateral. Retorna um CLONE raso com `history: undefined` +
 * `historyExternal: true` (o cache em memória, intocado, segue com o history
 * reidratado). Espelha `stripRefImage`. Pontos:
 *  • `storageReadBlocked` (blob em quarentena) → não mexe em nada.
 *  • Sem history (ausente ou `{}`) → passa direto; se sobrou chave lateral de um
 *    history apagado, limpa.
 *  • History INALTERADO (mesma referência já gravada) → só tira do blob, SEM
 *    reescrever a chave nem comprimir. Este é o caminho QUENTE do streaming
 *    (`setOutput` não toca `history`), então a maioria dos saves cai aqui.
 *  • History NOVO (push/restore/delete de snapshot) → comprime e grava a chave,
 *    semeia o rastreador, e tira do blob.
 *  • Falha de quota ao gravar → MANTÉM inline (nunca perde o history).
 */
function stripHistory(r: Roteiro): Roteiro {
  if (storageReadBlocked) return r;
  const h = r.history;
  if (!h || Object.keys(h).length === 0) {
    if (lastWrittenHistory.has(r.id)) {
      try {
        window.localStorage.removeItem(HISTORY_PREFIX + r.id);
      } catch {
        /* best-effort */
      }
      lastWrittenHistory.delete(r.id);
    }
    // Sem history: garante que o blob não carregue um marcador órfão.
    if (r.historyExternal) {
      const next: Roteiro = { ...r };
      delete next.historyExternal;
      return next;
    }
    return r;
  }
  if (lastWrittenHistory.get(r.id) === h) {
    return { ...r, history: undefined, historyExternal: true };
  }
  try {
    window.localStorage.setItem(
      HISTORY_PREFIX + r.id,
      COMPRESSED_PREFIX + compressToUTF16(JSON.stringify(h)),
    );
    lastWrittenHistory.set(r.id, h);
    return { ...r, history: undefined, historyExternal: true };
  } catch {
    // Quota etc — não dá pra mover; mantém inline pra NUNCA perder o history.
    return r;
  }
}

/**
 * Serializa pro blob `veludo:roteiros` com as imagens E o `history` movidos pras
 * chaves laterais. É o que os writers usam (saveRoteiro / performPendingSave /
 * deleteRoteiro / import). `serialize` puro continua existindo pra backup/export,
 * que DEVE manter imagem e history inline (cópia completa de segurança).
 */
function serializeForBlob(roteiros: Roteiro[]): string {
  return serialize(roteiros.map((r) => stripHistory(stripRefImage(r))));
}

/**
 * Parte síncrona (main thread) do save para o caminho do worker: aplica
 * `stripRefImage` + `stripHistory` (que escrevem as chaves laterais de imagem e
 * de history — precisam de localStorage, indisponível no worker) e devolve só o
 * JSON. A compressão pesada do blob vai pro worker depois. NÃO usar no caminho
 * síncrono — lá `serializeForBlob` já faz strip + compress de uma vez.
 *
 * Nota: num save que MUDA o history, paga-se aqui um compress síncrono de ~0,6 MB
 * só daquele history (dezenas de ms, RARO — ver `stripHistory`), em vez do freeze
 * de vários segundos do blob inteiro. Os saves do streaming não mexem no history,
 * então caem no atalho por-identidade e não pagam nada.
 */
function stripAndStringify(roteiros: Roteiro[]): string {
  return JSON.stringify(roteiros.map((r) => stripHistory(stripRefImage(r))));
}

function deserialize(raw: string): Roteiro[] {
  if (raw.startsWith(COMPRESSED_PREFIX)) {
    const compressed = raw.slice(COMPRESSED_PREFIX.length);
    const json = decompressFromUTF16(compressed);
    if (!json) {
      // NÃO retornar [] aqui: o cache viraria vazio e o próximo save
      // sobrescreveria a biblioteca inteira. Lança pra `readFromStorage`
      // tratar (quarentena do blob + bloqueio de escrita).
      throw new Error("falha ao descomprimir localStorage (blob corrompido)");
    }
    return JSON.parse(json) as Roteiro[];
  }
  // Formato legado (JSON cru, versões ≤ 1.0.51). Próximo save vira comprimido.
  return JSON.parse(raw) as Roteiro[];
}

/**
 * Cache em memória do array de roteiros já descomprimido + migrado + podado +
 * sanitizado. O app é single-window Electron (sem aba/processo concorrente
 * escrevendo no localStorage), então o cache é a fonte de verdade da sessão.
 *
 * Sem ele, CADA save batia em `listRoteiros()` que descomprime o blob inteiro
 * e roda o pipeline `migrate→prune→sanitize` (incluindo `normalizeEscritaOutput`
 * em todo `outputs.escrita`) sobre TODOS os roteiros — O(biblioteca) por save.
 * Como o store persiste a cada mutação (debounce 600ms) e o streaming faz
 * checkpoint a cada ~2.5s, isso recomputava a biblioteca dezenas de vezes por
 * geração e piorava com mais projetos. Agora o pipeline pesado roda só na 1ª
 * leitura (lazy); os writers mutam o cache e só pagam o `serialize` (compress).
 */
let roteirosCache: Roteiro[] | null = null;

/**
 * True quando a ÚLTIMA leitura do localStorage falhou (descompressão/parse)
 * com um blob NÃO-vazio presente. Enquanto for true, `safeSetItem` se recusa
 * a gravar — senão o cache vazio (resultado de ERRO de leitura, não de
 * biblioteca vazia) sobrescreveria os dados reais e os perderia pra sempre.
 * Reavaliado a cada `readFromStorage`.
 */
let storageReadBlocked = false;

/**
 * Permite a UI detectar o estado de leitura-falha mesmo se o evento foi
 * disparado antes do listener montar (a leitura é lazy — roda no 1º acesso).
 */
export function isStorageReadBlocked(): boolean {
  return storageReadBlocked;
}

/**
 * Preserva o blob bruto que não conseguimos ler num backup e avisa a UI.
 * Best-effort: se o próprio backup falhar (ex.: quota), só loga — o que
 * importa é NÃO destruir o original, garantido pelo bloqueio de escrita.
 */
function quarantineCorruptBlob(raw: string, error: unknown) {
  console.error(
    "[storage] leitura falhou — preservando blob e bloqueando escrita:",
    error,
  );
  try {
    const backupKey = CORRUPT_KEY;
    // Só grava o primeiro backup (não acumula cópias a cada reload).
    if (window.localStorage.getItem(backupKey) === null) {
      window.localStorage.setItem(backupKey, raw);
      console.error(`[storage] blob corrompido salvo em "${backupKey}".`);
    }
  } catch (e) {
    console.error("[storage] não foi possível salvar backup do blob:", e);
  }
  window.dispatchEvent(new CustomEvent("veludo:storage-read-failed"));
}

function readFromStorage(): Roteiro[] {
  storageReadBlocked = false; // reavalia a cada leitura
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
    if (!raw) return []; // genuinamente vazio (usuário novo) — não bloqueia
    const parsed = deserialize(raw);
    return parsed
      .map(migrateLegacy)
      .map(pruneHistory)
      .map(sanitizeRoteiroXmlCruft)
      .map(hydrateRefImage)
      .map(hydrateHistory);
  } catch (e) {
    // raw existia e era não-vazio, mas não parseou. Retornar [] em silêncio
    // (comportamento antigo) faria o próximo save apagar a biblioteca toda.
    // Em vez disso: preserva o blob e bloqueia escrita até a próxima leitura
    // bem-sucedida (ex.: depois de um reload com o blob recuperado).
    if (raw) {
      quarantineCorruptBlob(raw, e);
      storageReadBlocked = true;
    }
    return [];
  }
}

/** Cache populado preguiçosamente; pipeline de sanitização roda 1x por sessão. */
function getCache(): Roteiro[] {
  if (roteirosCache === null) {
    roteirosCache = readFromStorage();
  }
  return roteirosCache;
}

/**
 * Invalida o cache em memória. Chamar quando o localStorage for escrito por fora
 * dos helpers deste módulo (ex.: import manual, seed de dev). No fluxo normal do
 * app não é necessário — os writers daqui mantêm o cache coerente.
 */
export function resetRoteirosCache() {
  roteirosCache = null;
  lastWrittenRefImg.clear();
  lastWrittenHistory.clear();
  // Derruba o worker de compressão: import/restore reconstroem a biblioteca, e
  // compressões em voo viram stale. Um worker novo é criado no próximo save.
  rejectAllWorkerPending(new Error("reset"));
  if (compressWorker) {
    try {
      compressWorker.terminate();
    } catch {
      /* best-effort */
    }
    compressWorker = null;
  }
  workerUnavailable = false;
}

export function listRoteiros(): Roteiro[] {
  if (!isBrowser()) return [];
  // Cópia ordenada — não muta a ordem interna do cache (writers usam findIndex).
  return [...getCache()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getRoteiro(id: string): Roteiro | null {
  if (!isBrowser()) return null;
  return getCache().find((r) => r.id === id) ?? null;
}

/**
 * Serializa a biblioteca atual (descomprimida) pra backup/export em disco.
 * Lê do cache em memória — barato, sem re-rodar o pipeline de sanitização.
 * Retorna "[]" quando não há nada.
 */
export function serializeLibraryForBackup(): string {
  if (!isBrowser()) return "[]";
  return JSON.stringify(getCache());
}

/**
 * Retorna o blob posto em quarentena por uma leitura que falhou (CORRUPT_KEY),
 * pra a UI oferecer "salvar cópia de segurança". null se não houver.
 */
export function getQuarantinedBlob(): string | null {
  if (!isBrowser()) return null;
  try {
    return window.localStorage.getItem(CORRUPT_KEY);
  } catch {
    return null;
  }
}

/**
 * Restaura a biblioteca a partir do conteúdo de um backup. Aceita tanto o
 * formato de export/auto-backup (JSON array descomprimido) quanto o blob bruto
 * (`LZ1:`/JSON legado). SUBSTITUI a biblioteca atual — mas antes guarda uma
 * cópia em `veludo:roteiros.pre-restore` (restore reversível). Passa pelo
 * pipeline de migração/sanitização e regrava comprimido. Limpa o
 * `storageReadBlocked` (restaurar é justamente a saída pra corrupção).
 *
 * Retorna o nº de roteiros restaurados. Lança Error (com mensagem amigável em
 * PT-BR) se o arquivo for inválido ou não couber no quota.
 */
export function importLibraryFromString(raw: string): number {
  if (!isBrowser()) throw new Error("Sem ambiente de navegador.");
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Arquivo vazio.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Não é JSON cru — tenta o formato comprimido/legado do localStorage.
    try {
      parsed = deserialize(trimmed);
    } catch {
      throw new Error("Arquivo não reconhecido como backup de roteiros.");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Formato inválido: esperava uma lista de roteiros.");
  }
  const roteiros = parsed.filter(
    (r): r is Roteiro =>
      !!r && typeof r === "object" && typeof (r as Roteiro).id === "string",
  );
  if (roteiros.length === 0 && parsed.length > 0) {
    throw new Error("Nenhum roteiro válido no arquivo.");
  }

  // Segurança: preserva a biblioteca atual antes de sobrescrever.
  try {
    const current = window.localStorage.getItem(KEY);
    if (current) window.localStorage.setItem(`${KEY}.pre-restore`, current);
  } catch {
    // best-effort — não impede o restore
  }

  const sanitized = roteiros
    .map(migrateLegacy)
    .map(pruneHistory)
    .map(sanitizeRoteiroXmlCruft);

  // Restaurar substitui a biblioteca inteira — zera os rastreadores de imagem e
  // history já gravados pras chaves laterais serem (re)escritas a partir do
  // backup. O cache fica com imagem e history inline (do backup), então segue
  // reidratado; o `serializeForBlob(sanitized)` abaixo estrai pras chaves laterais.
  lastWrittenRefImg.clear();
  lastWrittenHistory.clear();

  try {
    window.localStorage.setItem(KEY, serializeForBlob(sanitized));
  } catch (e) {
    if (isQuotaExceededError(e)) {
      throw new Error(
        "Backup grande demais pro espaço local (~5 MB). Apague roteiros antigos antes de restaurar.",
      );
    }
    throw e;
  }

  storageReadBlocked = false;
  roteirosCache = sanitized;
  return sanitized.length;
}

/**
 * Detecta se um erro vindo do localStorage é o limite de quota (~5MB).
 * Suporta tanto navegadores que setam `name === "QuotaExceededError"` quanto
 * versões antigas que usam o legacy `code === 22`.
 */
function isQuotaExceededError(e: unknown): boolean {
  if (e instanceof DOMException) {
    return e.name === "QuotaExceededError" || e.code === 22;
  }
  return false;
}

function safeSetItem(value: string) {
  // Trava de segurança: se a leitura inicial falhou (blob corrompido), o cache
  // está vazio por ERRO, não porque a biblioteca está vazia. Gravar agora
  // sobrescreveria o blob preservado e perderia tudo. Recusa e avisa a UI.
  if (storageReadBlocked) {
    console.error(
      "[storage] escrita bloqueada: leitura inicial falhou e o blob foi preservado; não sobrescrevendo.",
    );
    window.dispatchEvent(new CustomEvent("veludo:storage-write-blocked"));
    return;
  }
  // Sem o try/catch, se o usuário enche o localStorage (roteiros com imagem
  // inline em data URL passam fácil dos 5MB), o setItem lança e crasha o
  // renderer — Electron mostra tela branca sem nenhum aviso. Aqui capturamos
  // QuotaExceededError e disparamos um custom event pra UI mostrar dialog.
  try {
    window.localStorage.setItem(KEY, value);
    // Blob persistido — o cache está em dia com o disco.
    cacheDirty = false;
  } catch (e) {
    if (isQuotaExceededError(e)) {
      console.error("[storage] localStorage cheio:", e);
      window.dispatchEvent(new CustomEvent("veludo:storage-quota-exceeded"));
      return;
    }
    throw e;
  }
}

export function saveRoteiro(roteiro: Roteiro) {
  if (!isBrowser()) return;
  const all = getCache();
  const idx = all.findIndex((r) => r.id === roteiro.id);
  const updated: Roteiro = { ...roteiro, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = updated;
  else all.push(updated);
  safeSetItem(serializeForBlob(all));
}

/**
 * Coalesce de gravações: o Zustand chama persist() em todas as mutações
 * (setOutput, setUserInput, setDraft, etc). Sem debounce, cada keystroke
 * acionava `compressToUTF16()` síncrono em ~500KB-1MB de JSON, bloqueando
 * o main thread por 100-300ms — UI travava ao digitar.
 *
 * Aqui o roteiro mais recente fica num map (último vence), e um único
 * timer de SAVE_DEBOUNCE_MS dispara o flush. 50 keystrokes em rajada
 * viram 1 gravação. O flush em si roda em requestIdleCallback pra que,
 * se o teclado ainda estiver ativo no momento, a compressão saia do
 * critical path.
 *
 * `flushPendingSave()` força sync imediato — usar em beforeunload, ao
 * trocar de step, ao resetar o wizard. Sem isso, fechar o app antes do
 * timer expirar perderia a última edição.
 */
const SAVE_DEBOUNCE_MS = 600;
const pendingRoteiros = new Map<string, Roteiro>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idleHandle: number | null = null;

type IdleCallbackHandle = number;
type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number };
interface IdleWindow {
  requestIdleCallback?: (
    cb: (deadline: IdleDeadline) => void,
    opts?: { timeout: number },
  ) => IdleCallbackHandle;
  cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
}

function runWhenIdle(cb: () => void) {
  const w = window as IdleWindow & Window;
  if (typeof w.requestIdleCallback === "function") {
    idleHandle = w.requestIdleCallback(
      () => {
        idleHandle = null;
        cb();
      },
      { timeout: 1000 },
    );
  } else {
    idleHandle = window.setTimeout(() => {
      idleHandle = null;
      cb();
    }, 0) as unknown as number;
  }
}

/** Dreno do Map de pendentes pro cache em memória (parte síncrona, comum aos dois
 *  caminhos). Retorna o array do cache já mutado, ou null se nada havia pendente. */
function drainPendingIntoCache(): Roteiro[] | null {
  if (pendingRoteiros.size === 0) return null;
  const all = getCache();
  const now = new Date().toISOString();
  for (const [id, roteiro] of pendingRoteiros) {
    const idx = all.findIndex((r) => r.id === id);
    const updated: Roteiro = { ...roteiro, updatedAt: now };
    if (idx >= 0) all[idx] = updated;
    else all.push(updated);
  }
  pendingRoteiros.clear();
  // O cache mudou e ainda não foi pro disco — marca pra a rede de segurança do
  // unload (ver `cacheDirty`/`flushPendingSave`). Zerado no `safeSetItem` de sucesso.
  cacheDirty = true;
  return all;
}

/** Trava de não-reentrância do caminho async (uma compressão no worker por vez). */
let saveInFlight = false;
let resaveQueued = false;

/**
 * "O cache em memória tem mutação que ainda NÃO bateu no disco." Setado quando
 * `drainPendingIntoCache` move pendentes pro cache; zerado quando `safeSetItem`
 * grava o blob com sucesso. Existe pra a Fase 2 (navegação assíncrona) ser segura:
 * `setRoteiro`/`setCurrentStep`/`reset` passaram a usar o caminho async (worker,
 * não-bloqueante), então o drain pro cache é síncrono mas a compressão fica no ar.
 * Se a janela fechar nesse intervalo, `flushPendingSave` (beforeunload/pagehide)
 * vê `cacheDirty` e grava o cache inteiro SÍNCRONO antes de morrer — durabilidade
 * preservada. Fecha também a janela drain↔setItem que já existia no caminho do
 * `QueueRunner` (requestPendingSaveFlush).
 */
let cacheDirty = false;

/**
 * Caminho QUENTE/idle (streaming): comprime FORA da main thread (worker). A main
 * thread só paga o `JSON.stringify` (rápido) + `localStorage.setItem`. Coalesce:
 * se uma compressão já está em voo, marca pra rodar de novo (last-write-wins) em
 * vez de interleave. Fallback síncrono se o worker estiver indisponível/erro/timeout
 * (um save NUNCA se perde).
 */
async function performPendingSave(): Promise<void> {
  if (storageReadBlocked) {
    pendingRoteiros.clear();
    return;
  }
  if (saveInFlight) {
    resaveQueued = true;
    return;
  }
  const all = drainPendingIntoCache();
  if (!all) return;
  saveInFlight = true;
  try {
    // Parte rápida na main thread (inclui escrever as chaves laterais de imagem).
    const json = stripAndStringify(all);
    let blob: string;
    try {
      blob = await compressViaWorker(json); // pesado, fora da main thread
    } catch {
      // Worker indisponível/erro/timeout → comprime síncrono no MESMO json.
      blob = serializeJsonSync(json);
    }
    // Re-checa guard DEPOIS do await (corrupção pode ter sido sinalizada no meio).
    if (storageReadBlocked) return;
    safeSetItem(blob); // re-checa storageReadBlocked + quota no momento do setItem
  } finally {
    saveInFlight = false;
    // Edits que chegaram durante a compressão → roda de novo pra o ÚLTIMO estado
    // vencer (nunca grava blob velho).
    if (resaveQueued || pendingRoteiros.size > 0) {
      resaveQueued = false;
      void performPendingSave();
    }
  }
}

/** Caminho SÍNCRONO (unload/troca de step/reset): comprime inline. Garante que a
 *  última edição vá pro disco antes da janela morrer (beforeunload não pode await). */
function performPendingSaveSync(): void {
  const all = drainPendingIntoCache();
  if (!all) return;
  safeSetItem(serializeForBlob(all));
}

export function scheduleSave(roteiro: Roteiro) {
  if (!isBrowser()) return;
  pendingRoteiros.set(roteiro.id, roteiro);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runWhenIdle(() => void performPendingSave());
  }, SAVE_DEBOUNCE_MS);
}

/** Cancela o timer/idle pendente (sem disparar save). */
function cancelPendingSaveTimers() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (idleHandle !== null) {
    const w = window as IdleWindow & Window;
    if (typeof w.cancelIdleCallback === "function") {
      w.cancelIdleCallback(idleHandle);
    } else {
      clearTimeout(idleHandle);
    }
    idleHandle = null;
  }
}

/**
 * Flush SÍNCRONO — usar em beforeunload/pagehide, troca de step e reset. Comprime
 * inline na main thread (curto: só o delta pendente). NÃO usar no caminho quente
 * de streaming (use `requestPendingSaveFlush`).
 */
export function flushPendingSave() {
  if (!isBrowser()) return;
  cancelPendingSaveTimers();
  performPendingSaveSync();
  // Rede de segurança do caminho ASSÍNCRONO (navegação/fila): se um
  // `performPendingSave` já drenou os pendentes pro cache mas a compressão no
  // worker ainda não bateu no disco, `pendingRoteiros` está vazio (o sync acima
  // foi no-op) PORÉM o cache tem mutação não-persistida. Grava o cache inteiro
  // síncrono AGORA pra a última edição ir pro disco antes da janela morrer. Só
  // dispara quando há sujeira real (`cacheDirty`), então em fluxo normal é no-op.
  if (cacheDirty) {
    safeSetItem(serializeForBlob(getCache()));
  }
}

/**
 * Flush ASSÍNCRONO coalescido — usar ao concluir/falhar um job da fila. Manda a
 * compressão pro worker (não bloqueia a UI) e, com revisor1‖revisor2 terminando
 * quase juntos, o `saveInFlight`/`resaveQueued` colapsa os dois persists num só.
 * Durabilidade: os `onPartial` já gravaram via scheduleSave e o unload faz flush
 * síncrono — então não precisa ser síncrono aqui.
 */
export function requestPendingSaveFlush() {
  if (!isBrowser()) return;
  cancelPendingSaveTimers();
  void performPendingSave();
}

export function deleteRoteiro(id: string) {
  if (!isBrowser()) return;
  // Se havia gravação pendente desse roteiro, descarta — o delete vence.
  pendingRoteiros.delete(id);
  const all = getCache();
  const idx = all.findIndex((r) => r.id === id);
  if (idx >= 0) all.splice(idx, 1);
  // Limpa as chaves laterais (imagem + history) — não deixa órfãs ocupando quota.
  try {
    window.localStorage.removeItem(REFIMG_PREFIX + id);
  } catch {
    /* best-effort */
  }
  try {
    window.localStorage.removeItem(HISTORY_PREFIX + id);
  } catch {
    /* best-effort */
  }
  lastWrittenRefImg.delete(id);
  lastWrittenHistory.delete(id);
  safeSetItem(serializeForBlob(all));
}

export function newRoteiroId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Cap de evals mantidos ao "Limpar cache" (mais enxuto que o EVAL_LOG_CAP=200 do
 *  log normal — mantém só a curva recente). Cada eval é minúsculo, mas o botão é
 *  pra deixar tudo o mais leve possível. */
export const EVAL_CLEAN_CAP = 30;

/** Tamanho aproximado (bytes) do blob `veludo:roteiros` no localStorage. UTF-16
 *  ≈ 2 bytes/char. Pro dialog de "Limpar cache" mostrar o peso atual. */
export function getRoteirosBlobBytes(): number {
  if (!isBrowser()) return 0;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? raw.length * 2 : 0;
  } catch {
    return 0;
  }
}

export interface PruneCacheResult {
  changed: boolean;
  prunedRoteiros: number;
  removedHistory: number;
  removedEvals: number;
  beforeBytes: number;
  afterBytes: number;
}

/**
 * Poda "cache-like" do localStorage, disparada pelo botão "Limpar cache" e pela
 * limpeza automática semanal. NUNCA toca em `outputs` (os roteiros), nem em
 * `userInputs`, `canone`, `drafts`, `title` ou na imagem de referência. O que faz:
 *
 *  1. Trunca o `evals[]` (log de qualidade) pra EVAL_CLEAN_CAP, mantendo os mais
 *     recentes.
 *  2. Trunca pilhas de `history` acima de HISTORY_CAP (defensivo — o `pruneHistory`
 *     do load normalmente já capou; fica aqui caso algo escape).
 *  3. **Recompacta o blob em disco no formato enxuto AGORA**: mesmo sem mudança no
 *     cache (já podado no load), o blob `veludo:roteiros` em disco pode ainda estar
 *     no formato antigo (history 5, imagem/history inline) até o próximo save.
 *     Reescrever via `serializeForBlob` aplica o formato enxuto (imagem E history
 *     nas chaves laterais, history capado em 2) na hora — o `afterBytes` cai bastante
 *     porque o history (~55% da biblioteca) sai do blob. Idempotente: só grava se o
 *     blob mudaria (compara strings), então rodar de novo logo em seguida quase não
 *     acha o que fazer.
 *
 * Respeita `storageReadBlocked` (não escreve em estado de corrupção). Atualiza o
 * cache em memória in-place pra a UI refletir sem reload.
 */
export function pruneCacheLikeData(): PruneCacheResult {
  const result: PruneCacheResult = {
    changed: false,
    prunedRoteiros: 0,
    removedHistory: 0,
    removedEvals: 0,
    beforeBytes: 0,
    afterBytes: 0,
  };
  if (!isBrowser() || storageReadBlocked) return result;

  const all = getCache();
  for (let i = 0; i < all.length; i++) {
    const r = all[i]!;
    let history = r.history;
    let evals = r.evals;
    let histChanged = false;
    let evalsChanged = false;

    if (history) {
      const newHistory: Partial<Record<StepId, StepGenerationSnapshot[]>> = {};
      for (const [step, stack] of Object.entries(history) as [
        StepId,
        StepGenerationSnapshot[] | undefined,
      ][]) {
        if (!stack) continue;
        if (stack.length > HISTORY_CAP) {
          result.removedHistory += stack.length - HISTORY_CAP;
          newHistory[step] = stack.slice(0, HISTORY_CAP);
          histChanged = true;
        } else {
          newHistory[step] = stack;
        }
      }
      if (histChanged) history = newHistory;
    }

    if (evals && evals.length > EVAL_CLEAN_CAP) {
      result.removedEvals += evals.length - EVAL_CLEAN_CAP;
      evals = evals.slice(-EVAL_CLEAN_CAP);
      evalsChanged = true;
    }

    if (histChanged || evalsChanged) {
      const clone: Roteiro = { ...r };
      if (histChanged) clone.history = history;
      if (evalsChanged) clone.evals = evals;
      all[i] = clone;
      result.prunedRoteiros += 1;
    }
  }

  // Recompacta o blob em disco (estoura imagens pras chaves laterais + formato
  // enxuto). Só grava se realmente muda — idempotente.
  let currentRaw = "";
  try {
    currentRaw = window.localStorage.getItem(KEY) ?? "";
  } catch {
    /* ignore */
  }
  result.beforeBytes = currentRaw.length * 2;
  const nextRaw = serializeForBlob(all);
  result.afterBytes = nextRaw.length * 2;
  if (nextRaw !== currentRaw) {
    safeSetItem(nextRaw);
    result.changed = true;
  }
  return result;
}
