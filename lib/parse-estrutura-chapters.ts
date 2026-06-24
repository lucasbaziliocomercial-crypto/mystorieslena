/**
 * Conta quantos capítulos uma Estrutura aprovada (Step 2 ou Step 3) declara.
 *
 * As estruturas saem com cabeçalhos no formato `# Capítulo N — Título` (ou
 * `## Capítulo N`, ou variações com en/em-dash). O agente Escrita usa esse
 * número pra saber quantos pares vai gerar — sem isso, não há como o
 * frontend planejar o loop de batches 2-em-2.
 */

// Lista de regexes em ordem de preferência — o detector tenta o mais
// específico primeiro e cai pros mais permissivos se nenhum cap for
// achado. O `^[^A-Za-zÀ-ÿ\n]*` aceita qualquer prefixo não-letra (markdown
// `##`, bold `**`, bullet `-` `•`, símbolos como `📖`, espaços) antes da
// palavra "Capítulo" ou "Cap." — bloqueia narrativa tipo "do Capítulo 1"
// porque a linha não começa com letra.
const CHAPTER_HEADER_PATTERNS: RegExp[] = [
  // Estrito: "## Capítulo 1 — Título" (formato canônico)
  /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\b/gim,
  // Permissivo: aceita qualquer prefixo não-letra (bullet, símbolos, emojis)
  /^[^A-Za-zÀ-ÿ\d\n]*Cap[ií]tulo\s+(\d+)\b/gim,
  // Abreviação: "Cap. 1", "Cap 1"
  /^[^A-Za-zÀ-ÿ\d\n]*Cap\.?\s+(\d+)\b/gim,
];

export const CHAPTER_HEADER_REGEX = CHAPTER_HEADER_PATTERNS[0]!;

/**
 * Conta os números de capítulo únicos detectados no texto. Tenta padrões
 * em escala crescente de permissividade — se o estrito não acha nada, cai
 * pro permissivo, depois pro abreviado. Retorna o maior count entre eles.
 */
export function countChaptersInEstrutura(estrutura: string | undefined): number {
  if (!estrutura?.trim()) return 0;
  let best = 0;
  for (const pattern of CHAPTER_HEADER_PATTERNS) {
    const seen = new Set<number>();
    const re = new RegExp(pattern.source, "gim");
    let m: RegExpExecArray | null;
    while ((m = re.exec(estrutura)) !== null) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0 && n <= 50) seen.add(n);
    }
    if (seen.size > best) best = seen.size;
    // Se o estrito já achou pelo menos 3 caps, confiamos nele e paramos —
    // os patterns mais permissivos podem capturar falso positivo se a
    // estrutura tiver linhas estilo "Cap. de família 3 — os Volkov".
    if (best >= 3) break;
  }
  return best;
}

export interface BatchPlan {
  part: "Parte 1" | "Parte 2";
  chapters: number[]; // 1 ou 2 entradas, números absolutos dentro da Parte
  totalInPart: number;
  batchIndex: number; // 1-based
  /** Alvo de palavras por capítulo desse batch — alinhado com `chapters`. */
  targets: number[];
}

import { partTotalRange } from "./parse-estrutura-targets";
import type { RoteiroCategory } from "@/lib/categories/types";
import { DEFAULT_CATEGORY } from "@/types/roteiro";

/**
 * Monta a lista de batches respeitando a fronteira entre Parte 1 e Parte 2.
 * Nenhum batch atravessa parte — se Parte 1 tem 5 caps, sai como [1,2], [3,4], [5].
 *
 * `targetsP1`/`targetsP2` são arrays alinhados aos números absolutos dos caps
 * (índice 0 = cap 1, índice 1 = cap 2, etc). Se a estrutura não declarou alvo
 * pra algum cap, esta função preenche com a média da Parte (target / nCaps),
 * agora category-aware — milionário usa 12.500/13.250, máfia usa 12.500/13.500.
 */
export function planBatches(
  totalParte1: number,
  totalParte2: number,
  targetsP1?: number[],
  targetsP2?: number[],
  category: RoteiroCategory = DEFAULT_CATEGORY,
): BatchPlan[] {
  const plan: BatchPlan[] = [];
  let idx = 0;
  const targetP1 = partTotalRange("Parte 1", category).target;
  const targetP2 = partTotalRange("Parte 2", category).target;
  for (let i = 1; i <= totalParte1; i += 2) {
    const chapters = i + 1 <= totalParte1 ? [i, i + 1] : [i];
    const targets = chapters.map(
      (n) => targetsP1?.[n - 1] ?? Math.round(targetP1 / Math.max(totalParte1, 1)),
    );
    idx += 1;
    plan.push({
      part: "Parte 1",
      chapters,
      totalInPart: totalParte1,
      batchIndex: idx,
      targets,
    });
  }
  for (let i = 1; i <= totalParte2; i += 2) {
    const chapters = i + 1 <= totalParte2 ? [i, i + 1] : [i];
    const targets = chapters.map(
      (n) => targetsP2?.[n - 1] ?? Math.round(targetP2 / Math.max(totalParte2, 1)),
    );
    idx += 1;
    plan.push({
      part: "Parte 2",
      chapters,
      totalInPart: totalParte2,
      batchIndex: idx,
      targets,
    });
  }
  return plan;
}
