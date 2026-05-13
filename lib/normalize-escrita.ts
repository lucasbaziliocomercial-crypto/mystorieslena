/**
 * Normalização canônica do output da Escrita.
 *
 * Invariante central do app:
 *
 *   "outputs.escrita.metadata.chapters[] nunca contém duplicatas por
 *    (canonPart, number); outputs.escrita.content é função pura do array
 *    chapters[] (exceto quando edição manual setou edited=true — neste
 *    caso content preserva a edição da roteirista, mas chapters[] segue
 *    dedupado)."
 *
 * Esta função é a barreira que garante a invariante. Chamadores:
 *   - store/wizard.ts#setOutput → executa em TODA gravação (estratégia
 *     "longest", segura por default).
 *   - components/wizard/StepShell.tsx batch loop → executa antes do persist
 *     com estratégia "last" (regeneração no meio do loop substitui anterior).
 *   - lib/storage.ts#sanitizeRoteiroEscrita → executa no load do localStorage
 *     com estratégia "longest" (auto-heal de roteiros já corrompidos).
 *
 * É idempotente: rodar duas vezes produz o mesmo output.
 */

import type { StepOutput } from "@/types/roteiro";
import {
  dedupChapters,
  dedupChaptersLast,
} from "./dedup-chapters";
import { concatenateChapters } from "./parse-escrita-output";

export type DedupStrategy = "longest" | "last";

export interface NormalizeOptions {
  /** Como resolver empate entre duplicatas. Default: "longest". */
  strategy?: DedupStrategy;
  /** Identifica o caller pra console.warn — útil pra rastrear regressões. */
  source?: string;
}

export interface NormalizeResult {
  output: StepOutput;
  /** Quantos capítulos foram removidos por duplicação. */
  removed: number;
  /** Se houve qualquer mudança no output (chapters ou content). */
  changed: boolean;
}

/**
 * Idempotente. Se nada precisar mudar, devolve o `output` original (mesma
 * referência) e `changed=false` — chamadores podem usar isso pra evitar
 * re-render desnecessário.
 *
 * Output ausente ou sem `metadata.chapters` é passthrough (não há nada pra
 * normalizar).
 *
 * Edição manual (`output.edited === true`) preserva `content` editado pela
 * roteirista — só dedupa o array de `chapters[]`. Isso mantém o fluxo de
 * edição livre funcionando: a invariante "content = f(chapters)" é
 * assimétrica e respeita o caso onde o usuário editou texto monolítico.
 */
export function normalizeEscritaOutput(
  output: StepOutput | undefined,
  opts: NormalizeOptions = {},
): NormalizeResult {
  const strategy = opts.strategy ?? "longest";

  if (!output) {
    return { output: { content: "" }, removed: 0, changed: false };
  }
  const chapters = output.metadata?.chapters;
  if (!chapters || chapters.length === 0) {
    return { output, removed: 0, changed: false };
  }

  let dedupedChapters = chapters;
  let removed = 0;
  if (strategy === "last") {
    const r = dedupChaptersLast(chapters);
    dedupedChapters = r.chapters;
    removed = r.removed;
  } else {
    const r = dedupChapters(chapters);
    dedupedChapters = r.chapters;
    removed = r.chapters.length < chapters.length
      ? chapters.length - r.chapters.length
      : 0;
  }

  const userEdited = output.edited === true;
  const nextContent = userEdited
    ? output.content
    : concatenateChapters(dedupedChapters);

  const contentChanged = nextContent !== output.content;
  const chaptersChanged = removed > 0;
  const changed = contentChanged || chaptersChanged;

  if (removed > 0) {
    console.warn(
      `[normalize-escrita] removeu ${removed} cap(s) duplicado(s)`,
      { source: opts.source ?? "unknown", strategy, removed },
    );
  }

  if (!changed) return { output, removed: 0, changed: false };

  return {
    output: {
      ...output,
      content: nextContent,
      metadata: {
        ...(output.metadata ?? {}),
        chapters: dedupedChapters,
      },
    },
    removed,
    changed: true,
  };
}
