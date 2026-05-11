/**
 * Detecção e remoção determinística de capítulos duplicados na Escrita.
 *
 * Quando o agente Escrita (Opus) re-emite "# Capítulo N — Título" mais de
 * uma vez dentro da mesma Parte (acontece quando regenerações sobrepõem),
 * o `parseEscritaChaptersDirect` mantém todas as cópias. Hoje o Revisor
 * detecta isso e escala "Aplicar via IA" pra reescrever a Parte inteira —
 * isso queima minutos do Opus e regenera 13k palavras pra deletar 4 cópias.
 *
 * Em vez disso, aqui agrupamos por (part, number, title) e mantemos a
 * versão com mais palavras (mais completa/coerente, geralmente é a última
 * regeneração bem-sucedida). É determinístico, instantâneo, sem IA.
 */

import type { EscritaChapter } from "@/types/roteiro";
import { countWords } from "./word-count";

export interface DuplicateGroup {
  part: string | undefined;
  number: number;
  title: string | undefined;
  /** Índices no array original onde as duplicatas aparecem. */
  indices: number[];
  /** Índice escolhido pra manter (versão mais longa). */
  keepIndex: number;
}

function groupKey(c: EscritaChapter): string {
  return `${c.part ?? ""}|${c.number}|${c.title ?? ""}`;
}

/**
 * Detecta grupos de capítulos com mesmo (part, number, title) aparecendo
 * 2+ vezes. Devolve [] se não há duplicatas.
 */
export function detectDuplicateChapters(
  chapters: EscritaChapter[],
): DuplicateGroup[] {
  const groups = new Map<string, number[]>();
  chapters.forEach((c, i) => {
    const k = groupKey(c);
    const existing = groups.get(k);
    if (existing) existing.push(i);
    else groups.set(k, [i]);
  });

  const result: DuplicateGroup[] = [];
  for (const [, indices] of groups) {
    if (indices.length < 2) continue;
    const first = chapters[indices[0]!]!;
    // Mantém o de maior wordCount (mais completo). Empate → primeiro.
    let keepIndex = indices[0]!;
    let keepWords = countWords(chapters[keepIndex]!.content);
    for (const i of indices.slice(1)) {
      const w = countWords(chapters[i]!.content);
      if (w > keepWords) {
        keepWords = w;
        keepIndex = i;
      }
    }
    result.push({
      part: first.part,
      number: first.number,
      title: first.title,
      indices,
      keepIndex,
    });
  }

  // Ordena por part > number pra UI mostrar em ordem natural.
  result.sort((a, b) => {
    const pa = a.part ?? "";
    const pb = b.part ?? "";
    if (pa !== pb) return pa.localeCompare(pb);
    return a.number - b.number;
  });

  return result;
}

/**
 * Remove duplicatas mantendo a versão escolhida em `detectDuplicateChapters`.
 * Preserva a ordem original do array (só filtra os índices a remover).
 */
export function dedupChapters(chapters: EscritaChapter[]): {
  chapters: EscritaChapter[];
  removed: DuplicateGroup[];
} {
  const groups = detectDuplicateChapters(chapters);
  if (groups.length === 0) return { chapters, removed: [] };

  const removeSet = new Set<number>();
  for (const g of groups) {
    for (const i of g.indices) {
      if (i !== g.keepIndex) removeSet.add(i);
    }
  }

  const filtered = chapters.filter((_, i) => !removeSet.has(i));
  return { chapters: filtered, removed: groups };
}
