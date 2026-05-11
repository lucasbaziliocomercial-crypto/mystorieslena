/**
 * Acha uma JANELA CIRÚRGICA de parágrafos ao redor do trecho_original
 * do Revisor, pra mandar pro Opus reescrever apenas essa fatia em vez do
 * capítulo inteiro.
 *
 * Estratégia:
 *   1. Tenta `findTrechoInText` (literal → fuzzy) — match exato/tolerante.
 *   2. Se falhar, faz best-partial-match: tenta a primeira sentença,
 *      a primeira linha de diálogo (`— ...`), e a última sentença como
 *      âncoras de fallback. Qualquer uma que casa serve.
 *   3. Achou âncora → expande pra trás e pra frente até bordas de parágrafo
 *      (linhas em branco), incluindo ~3 antes e ~3 depois, capando em
 *      MAX_WINDOW_WORDS (~500 palavras via `countWords`).
 *
 * Devolve {start, end, content} apontando pra dentro do chapterContent
 * original. O caller faz splice pra trocar só essa fatia.
 */

import { findTrechoInText } from "./parse-revisor-output";
import { countWords } from "./word-count";

/** Cap de palavras na janela final — Opus reescreve ~500w em <15s. */
const MAX_WINDOW_WORDS = 500;
/** Quantos parágrafos pegar antes/depois da âncora. */
const PARAGRAPHS_BEFORE = 3;
const PARAGRAPHS_AFTER = 3;
/** Tamanho mínimo do partial-anchor pra evitar match em substrings comuns. */
const MIN_PARTIAL_ANCHOR_CHARS = 20;

export type FindTrechoWindowResult =
  | { found: true; start: number; end: number; content: string; matchKind: "exact" | "partial" }
  | { found: false };

/**
 * Extrai sentenças candidatas a âncora parcial do trecho. Ordena por:
 *   1. Linhas de diálogo (`— ...`) — sinal forte de presença literal.
 *   2. Sentenças longas (>20 chars) — mais únicas, menos falsos positivos.
 *   3. Primeira/última sentença do trecho.
 */
function extractPartialAnchors(trecho: string): string[] {
  const anchors: string[] = [];

  // 1. Linhas de diálogo (mais distintivas)
  const dialogueLines = trecho
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[—–-]\s/.test(l) && l.length >= MIN_PARTIAL_ANCHOR_CHARS);
  anchors.push(...dialogueLines);

  // 2. Sentenças longas (split em . ! ? + nova linha dupla)
  const sentences = trecho
    .split(/(?<=[.!?])\s+|\n\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_PARTIAL_ANCHOR_CHARS);
  // Adiciona da maior pra menor (mais único primeiro), evitando duplicatas.
  sentences
    .slice()
    .sort((a, b) => b.length - a.length)
    .forEach((s) => {
      if (!anchors.includes(s)) anchors.push(s);
    });

  return anchors;
}

/**
 * Acha o início do parágrafo que contém `pos` (volta até encontrar `\n\n` ou
 * início do texto), expandindo `paragraphsBefore` parágrafos a mais.
 */
function expandStartByParagraphs(
  text: string,
  pos: number,
  paragraphsBefore: number,
): number {
  let cursor = pos;
  for (let i = 0; i <= paragraphsBefore; i++) {
    // Recua até início do parágrafo atual.
    const prevBreak = text.lastIndexOf("\n\n", cursor - 1);
    if (prevBreak === -1) return 0;
    cursor = prevBreak;
    if (i < paragraphsBefore) cursor -= 1; // pra entrar no parágrafo anterior na próx iteração
  }
  // Avança 2 chars pra pular o `\n\n` final do parágrafo anterior.
  return Math.min(text.length, cursor + 2);
}

/**
 * Acha o fim do parágrafo que contém `pos` (avança até encontrar `\n\n` ou
 * fim do texto), expandindo `paragraphsAfter` parágrafos a mais.
 */
function expandEndByParagraphs(
  text: string,
  pos: number,
  paragraphsAfter: number,
): number {
  let cursor = pos;
  for (let i = 0; i <= paragraphsAfter; i++) {
    const nextBreak = text.indexOf("\n\n", cursor);
    if (nextBreak === -1) return text.length;
    cursor = nextBreak;
    if (i < paragraphsAfter) cursor += 2;
  }
  return cursor;
}

/**
 * Encolhe a janela simetricamente até ficar dentro do limite de palavras.
 * Tira 1 parágrafo de cada lado por vez (alternado) até passar.
 */
function shrinkToWordCap(
  text: string,
  windowStart: number,
  windowEnd: number,
  anchorStart: number,
  anchorEnd: number,
): { start: number; end: number } {
  let start = windowStart;
  let end = windowEnd;
  let trimSide: "start" | "end" = "start";

  while (countWords(text.slice(start, end)) > MAX_WINDOW_WORDS) {
    if (trimSide === "start") {
      const nextBreak = text.indexOf("\n\n", start);
      // Para se já passou da âncora (não vamos cortar a âncora original).
      if (nextBreak === -1 || nextBreak + 2 >= anchorStart) {
        trimSide = "end";
        continue;
      }
      start = nextBreak + 2;
      trimSide = "end";
    } else {
      const prevBreak = text.lastIndexOf("\n\n", end - 1);
      if (prevBreak === -1 || prevBreak <= anchorEnd) {
        trimSide = "start";
        continue;
      }
      end = prevBreak;
      trimSide = "start";
    }
    // Safeguard contra loop infinito quando ambos os lados estão na âncora.
    if (start >= anchorStart - 2 && end <= anchorEnd + 2) break;
  }

  return { start, end };
}

/**
 * Tenta achar uma janela cirúrgica em `chapterContent` ao redor de uma
 * âncora derivada de `trechoOriginal`. Veja docstring do módulo pra
 * estratégia.
 */
export function findTrechoWindow(
  chapterContent: string,
  trechoOriginal: string,
): FindTrechoWindowResult {
  if (!chapterContent || !trechoOriginal?.trim()) return { found: false };

  // Tentativa 1: âncora exata via findTrechoInText.
  let anchor = findTrechoInText(chapterContent, trechoOriginal);
  let matchKind: "exact" | "partial" = "exact";

  // Tentativa 2: âncoras parciais (diálogos / sentenças longas).
  if (!anchor) {
    const partials = extractPartialAnchors(trechoOriginal);
    for (const p of partials) {
      const hit = findTrechoInText(chapterContent, p);
      if (hit) {
        anchor = hit;
        matchKind = "partial";
        break;
      }
    }
  }

  if (!anchor) return { found: false };

  const windowStart = expandStartByParagraphs(
    chapterContent,
    anchor.start,
    PARAGRAPHS_BEFORE,
  );
  const windowEnd = expandEndByParagraphs(
    chapterContent,
    anchor.end,
    PARAGRAPHS_AFTER,
  );

  const { start, end } = shrinkToWordCap(
    chapterContent,
    windowStart,
    windowEnd,
    anchor.start,
    anchor.end,
  );

  return {
    found: true,
    start,
    end,
    content: chapterContent.slice(start, end),
    matchKind,
  };
}
