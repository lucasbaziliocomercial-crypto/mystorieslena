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

const KEY = "veludo:roteiros";

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

function sanitizeRoteiroXmlCruft(r: Roteiro): Roteiro {
  let changed = false;
  let outputs = r.outputs;
  const cleaned = cleanEscritaXmlCruft(r.outputs?.escrita);
  if (cleaned.changed && cleaned.output) {
    outputs = { ...r.outputs, escrita: cleaned.output };
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
        const cleanContent = hasXmlCruft(snap.content)
          ? stripXmlCruft(snap.content)
          : snap.content;
        const snapChapters = snap.metadata?.chapters;
        const chaptersHasCruft =
          !!snapChapters && snapChapters.some((c) => hasXmlCruft(c.content));
        let next = snap;
        let snapChanged = false;
        if (cleanContent !== snap.content || chaptersHasCruft) {
          next = {
            ...snap,
            content: cleanContent,
            ...(chaptersHasCruft && snapChapters
              ? {
                  metadata: {
                    ...(snap.metadata ?? {}),
                    chapters: snapChapters.map((c) =>
                      hasXmlCruft(c.content)
                        ? { ...c, content: stripXmlCruft(c.content) }
                        : c,
                    ),
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
      console.error("[storage] falha ao descomprimir localStorage");
      return [];
    }
    return JSON.parse(json) as Roteiro[];
  }
  // Formato legado (JSON cru, versões ≤ 1.0.51). Próximo save vira comprimido.
  return JSON.parse(raw) as Roteiro[];
}

export function listRoteiros(): Roteiro[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = deserialize(raw);
    return parsed
      .map(migrateLegacy)
      .map(pruneHistory)
      .map(sanitizeRoteiroXmlCruft)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function getRoteiro(id: string): Roteiro | null {
  return listRoteiros().find((r) => r.id === id) ?? null;
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
  const all = listRoteiros();
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
  const all = listRoteiros();
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
  const all = listRoteiros().filter((r) => r.id !== id);
  safeSetItem(serialize(all));
}

export function newRoteiroId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
