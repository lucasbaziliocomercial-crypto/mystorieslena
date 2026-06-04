import { compressToUTF16, decompressFromUTF16 } from "lz-string";

import type {
  EscritaChapter,
  Roteiro,
  StepGenerationSnapshot,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { DEFAULT_CATEGORY } from "@/types/roteiro";
import { hasXmlCruft, stripXmlCruft } from "@/lib/parse-revisor-output";
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
 * sozinho enchia o localStorage (4MB por roteiro só de histórico). 5 é o
 * suficiente pra dar undo confortável sem estourar o quota.
 */
const HISTORY_CAP = 5;

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
        const snapChapters = snap.metadata?.chapters;
        const titleNeedsClean = (c: EscritaChapter) =>
          !!c.title && c.title !== stripChapterTitleAnnotation(c.title);
        const chaptersNeedClean =
          !!snapChapters &&
          snapChapters.some((c) => hasXmlCruft(c.content) || titleNeedsClean(c));
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

function serialize(roteiros: Roteiro[]): string {
  const json = JSON.stringify(roteiros);
  // Tenta comprimir; se algo bizarro acontecer (lz-string nunca lança em uso
  // normal, mas mantemos o fallback), grava cru — perder dados é pior do
  // que gravar maior.
  try {
    const compressed = compressToUTF16(json);
    if (compressed && compressed.length > 0) {
      return COMPRESSED_PREFIX + compressed;
    }
  } catch (e) {
    console.warn("[storage] falha na compressão, gravando cru:", e);
  }
  return json;
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
      .map(sanitizeRoteiroXmlCruft);
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

  try {
    window.localStorage.setItem(KEY, serialize(sanitized));
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
  safeSetItem(serialize(all));
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

function performPendingSave() {
  if (pendingRoteiros.size === 0) return;
  const all = getCache();
  const now = new Date().toISOString();
  for (const [id, roteiro] of pendingRoteiros) {
    const idx = all.findIndex((r) => r.id === id);
    const updated: Roteiro = { ...roteiro, updatedAt: now };
    if (idx >= 0) all[idx] = updated;
    else all.push(updated);
  }
  pendingRoteiros.clear();
  safeSetItem(serialize(all));
}

export function scheduleSave(roteiro: Roteiro) {
  if (!isBrowser()) return;
  pendingRoteiros.set(roteiro.id, roteiro);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runWhenIdle(performPendingSave);
  }, SAVE_DEBOUNCE_MS);
}

export function flushPendingSave() {
  if (!isBrowser()) return;
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
  performPendingSave();
}

export function deleteRoteiro(id: string) {
  if (!isBrowser()) return;
  // Se havia gravação pendente desse roteiro, descarta — o delete vence.
  pendingRoteiros.delete(id);
  const all = getCache();
  const idx = all.findIndex((r) => r.id === id);
  if (idx >= 0) all.splice(idx, 1);
  safeSetItem(serialize(all));
}

export function newRoteiroId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
