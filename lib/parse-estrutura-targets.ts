/**
 * Extrai o alvo de palavras de cada capítulo de uma Estrutura aprovada.
 *
 * As estruturas sinalizam o alvo de várias formas — o parser tolera
 * todas as comuns:
 *   - "Alvo: ~2.500 palavras"
 *   - "(2500 palavras)"
 *   - "~2.500 palavras"
 *   - "Contagem: 2300-2700"
 *   - "Contagem: 2300 a 2700 palavras"
 *
 * Quando uma faixa é dada (`A-B`), o alvo é a média (a, b) → (a+b)/2.
 * Quando nenhum alvo é detectável pra um capítulo, retorna undefined
 * pra ele — a chamada que pediu pode fazer fallback.
 */

// Markdown opcional + bold opcional — tolerante aos formatos que o modelo
// pode emitir (`## Capítulo 1`, `Capítulo 1`, `**Capítulo 1**`).
const CHAPTER_HEADER_REGEX = /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)/im;

/**
 * Quebra a estrutura em blocos de capítulo. Cada bloco vai do header
 * "# Capítulo N" até o próximo header (ou fim do texto). O `body`
 * INCLUI a linha do header — porque no formato real do prompt mestre o
 * alvo de palavras vem entre parênteses no próprio header:
 *   `## Capítulo 1 — A Chegada (~1.380 palavras — ritmo rápido)`
 * Sem incluir a linha do header, o parser nunca acha o alvo.
 */
export function splitChapterBlocks(
  estrutura: string,
): Array<{ number: number; body: string; start: number }> {
  type Hit = { number: number; index: number };
  const hits: Hit[] = [];
  const re = /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\b[^\n]*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(estrutura)) !== null) {
    hits.push({
      number: parseInt(m[1]!, 10),
      index: m.index,
    });
  }
  hits.sort((a, b) => a.index - b.index);

  const blocks: Array<{ number: number; body: string; start: number }> = [];
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const nextStart =
      i + 1 < hits.length ? hits[i + 1]!.index : estrutura.length;
    blocks.push({
      number: cur.number,
      body: estrutura.slice(cur.index, nextStart), // INCLUI header
      start: cur.index,
    });
  }
  return blocks;
}

/** Tenta extrair um número de palavras de um trecho de texto (header OU corpo). */
function extractTargetFromText(text: string): number | undefined {
  // Normaliza separador de milhar: "2.500" → "2500" (mas "2.5" continua "2.5")
  const normalized = text.replace(/(\d)\.(\d{3}\b)/g, "$1$2");

  // Padrão 1: faixa "X-Y palavras" ou "X a Y palavras"
  const range =
    /(\d{3,5})\s*(?:[-–—]|a)\s*(\d{3,5})\s*palavras/i.exec(normalized);
  if (range) {
    const a = parseInt(range[1]!, 10);
    const b = parseInt(range[2]!, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      return Math.round((a + b) / 2);
    }
  }

  // Padrão 2: "~X palavras" / "X palavras" / "(X palavras)"
  const single = /(?:~|aproximadamente\s+)?(\d{3,5})\s*palavras/i.exec(
    normalized,
  );
  if (single) {
    const n = parseInt(single[1]!, 10);
    if (Number.isFinite(n) && n >= 100 && n <= 50000) return n;
  }

  return undefined;
}

/**
 * Extrai o alvo de palavras de um bloco de capítulo.
 *
 * O alvo AUTORITATIVO vive no HEADER (1ª linha do bloco):
 *   `## Capítulo N — Título (~2.400 palavras — ritmo Y)`
 * Anotações de SUB-CENA no CORPO — ex.: "1 trecho MMC de 237-297 palavras"
 * (comprimento do trecho `✦` do POV masculino na máfia/alpha-king) — descrevem
 * um PEDAÇO do capítulo, não o alvo dele. Por isso lê-se o HEADER PRIMEIRO; só
 * se o header não declarar alvo é que varre o corpo inteiro (ex.: milionário-3p,
 * cujos headers não têm "(~X palavras)").
 *
 * ⚠️ Bug 12/06/2026: o parser varria o bloco inteiro e a faixa de sub-cena
 * "237-297 palavras" sequestrava o alvo do Cap 4 — virava 267 (= média de
 * 237 e 297) em vez de 2.400. A Escrita gerava ~270 palavras pra bater nesse
 * alvo falso e a calibração ±8% (270 vs 267) achava que estava no alvo, então
 * um capítulo de 270 palavras era entregue. Ler o header primeiro elimina isso.
 */
export function extractTargetFromBlock(body: string): number | undefined {
  const nl = body.indexOf("\n");
  const header = nl === -1 ? body : body.slice(0, nl);
  const fromHeader = extractTargetFromText(header);
  if (fromHeader !== undefined) return fromHeader;
  return extractTargetFromText(body);
}

export interface ChapterTarget {
  number: number;
  target?: number; // undefined → caller faz fallback
}

export function extractChapterTargets(
  estrutura: string | undefined,
): ChapterTarget[] {
  if (!estrutura?.trim()) return [];
  const blocks = splitChapterBlocks(estrutura);
  return blocks.map((b) => ({
    number: b.number,
    target: extractTargetFromBlock(b.body),
  }));
}

/**
 * Helper: dado a lista de targets parseados e o total esperado da Parte
 * (12.500 pra Parte 1, 13.250 pra Parte 2 — defaults do prompt),
 * preenche os capítulos sem alvo com a média da Parte (uniform fallback).
 */
export function fillTargetsWithFallback(
  targets: ChapterTarget[],
  partTotal: number,
): Array<{ number: number; target: number }> {
  const numChapters = targets.length || 1;
  const fallback = Math.round(partTotal / numChapters);
  return targets.map((t) => ({
    number: t.number,
    target: t.target ?? fallback,
  }));
}

/**
 * Margens de aceitação: ±3% do alvo (apertado pra atender a regra rígida do
 * PDF — totais por Parte são quase exatos, então cada cap precisa cair perto
 * do seu alvo individual). Mínimo absoluto de 30 palavras pra alvos pequenos.
 */
export function targetRange(target: number): { min: number; max: number } {
  const margin = Math.max(30, Math.round(target * 0.03));
  return { min: target - margin, max: target + margin };
}

export function isWithinTarget(actual: number, target: number): boolean {
  const { min, max } = targetRange(target);
  return actual >= min && actual <= max;
}

/**
 * Range obrigatório de palavras TOTAIS de uma Parte, agora category-aware.
 *
 * Cada sub-nicho tem alvos próprios (milionário 1p: 12.500/13.250 |
 * milionário 3p: 10.500/13.500 | máfia: 12.500/13.500). A configuração
 * vive em `lib/categories/index.ts` e é lida por categoria — esta função
 * passa a delegar a lookup.
 *
 * O parâmetro `category` é opcional pra preservar chamadas legadas; quando
 * omitido, usa o DEFAULT_CATEGORY (milionário 1p).
 */
import { CATEGORIES } from "@/lib/categories";
import type { RoteiroCategory } from "@/lib/categories/types";
import { DEFAULT_CATEGORY } from "@/types/roteiro";

export function partTotalRange(
  part: "Parte 1" | "Parte 2",
  category: RoteiroCategory = DEFAULT_CATEGORY,
): {
  min: number;
  max: number;
  target: number;
} {
  const cfg = CATEGORIES[category].wordCount;
  return part === "Parte 1" ? cfg.parte1 : cfg.parte2;
}
