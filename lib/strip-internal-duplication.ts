/**
 * Detecção e remoção determinística de DUPLICAÇÃO INTERNA num capítulo da
 * Escrita — quando o modelo Opus "reinicia" no meio da geração e re-emite um
 * bloco grande de cenas que JÁ tinha escrito, SEM um novo cabeçalho
 * `## Capítulo N`.
 *
 * Diferente de `dedup-chapters.ts` (que remove CAPÍTULOS INTEIROS repetidos,
 * keyando por part+número — dois headers `## Capítulo 3`), aqui o capítulo é UM
 * só: o lixo está DENTRO do corpo, a segunda metade refaz a primeira. O
 * `dedupChaptersLast` não enxerga (só um cap com number N), então isso escapava
 * da Escrita e ia pra prosa final — e só o Revisor pegava ("Cap. 3 — bloco
 * inteiro repetido (segunda metade refaz cenas da primeira)"). Este módulo
 * costura o caso NA ORIGEM (o motor da Escrita), do mesmo jeito que o dedup de
 * capítulo inteiro já faz.
 *
 * ⚠️ PRECISÃO ACIMA DE TUDO — isto trima PROSA, e um falso-positivo destrói um
 * capítulo bom (pior que o problema atual). Por isso o gatilho é estreito e só
 * dispara no padrão INEQUÍVOCO de "restart do modelo":
 *   1. um bloco de ≥2 parágrafos e ≥200 palavras reaparece IDÊNTICO
 *      (normalizado: minúsculas + espaços colapsados) mais à frente; E
 *   2. essa 2ª ocorrência vai até ~o FIM do capítulo (≤40 palavras de cauda) —
 *      o restart re-emite até o fim, ao contrário de um eco/carta relida no
 *      meio (que tem cena depois); E
 *   3. o bloco repetido cobre ≥30% do capítulo — um restart real refaz "a
 *      segunda metade" (~50%); uma carta/documento relido verbatim no fim é uma
 *      fração PEQUENA (~10-20%), então a cobertura separa um do outro mesmo
 *      quando ambos terminam o capítulo. (Aperto de precisão sugerido na revisão
 *      rigorosa pra zerar o falso-positivo da "carta relida".)
 * Quando dispara: mantém a 1ª ocorrência (a boa, que flui do contexto anterior)
 * e deleta da 2ª ocorrência até o fim — EXATAMENTE a receita que o Revisor dava
 * manualmente ("DELETAR todo o bloco entre o primeiro fechamento e o início do
 * Cap. N+1"). Tudo ANTES da 2ª ocorrência (intro + 1ª cópia + qualquer cena no
 * meio) é preservado — nunca apagamos texto único.
 *
 * Match EXATO (não fuzzy) de propósito: um restart do LLM re-emite os MESMOS
 * tokens. Se o modelo PARAFRASEasse a repetição (não casa exato), não tocamos —
 * o Revisor ainda pega o resíduo (defesa em profundidade). Preferimos perder uma
 * duplicata pequena a trimar prosa legítima.
 *
 * Funções puras, sem DOM/storage — testável por node (importam só `countWords`).
 */

import { countWords } from "./word-count.ts";

/** Bloco repetido tem que ter ≥ esta contagem de palavras (via `countWords`). */
const MIN_DUP_WORDS = 200;
/** …e abranger ≥ este nº de parágrafos (restart sempre cobre vários). */
const MIN_DUP_BLOCKS = 2;
/** A 2ª ocorrência tem que ir até ~o fim do cap (cauda ≤ isto, em palavras). */
const MAX_TAIL_WORDS = 40;
/**
 * O bloco repetido tem que cobrir ≥ esta fração do capítulo. Restart real refaz
 * ~metade do cap; carta/documento relido é fração pequena → cobertura separa os
 * dois mesmo quando ambos terminam o cap. 0.30 deixa margem folgada (pega o
 * caso real ~0.50, rejeita carta ~0.15).
 */
const MIN_DUP_COVERAGE = 0.3;
/** Restart duplo/triplo — repassa até estabilizar (raro precisar >1). */
const MAX_PASSES = 4;

export interface InternalDuplication {
  /** Índice (em parágrafos) onde a 2ª ocorrência — o "restart" — começa. */
  startBlock: number;
  /** Quantos parágrafos o bloco repetido cobre (tamanho do run casado). */
  blocks: number;
  /** Palavras que serão removidas (da 2ª ocorrência até o fim). */
  words: number;
}

/**
 * Quebra o conteúdo em parágrafos (separados por linha em branco), aparados e
 * sem vazios. Reconstrução posterior junta de volta com `\n\n` — preserva as
 * quebras de linha SIMPLES de dentro de cada parágrafo (split só em `\n{2,}`),
 * então não remexe a formatação da parte mantida.
 */
function splitBlocks(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Normaliza um parágrafo pra comparação: minúsculas + espaços colapsados. */
function normalizeBlock(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Acha a MAIOR sequência contígua de parágrafos que reaparece idêntica mais à
 * frente, COM a 2ª ocorrência terminando ~no fim do texto (padrão "restart").
 * Retorna null se nada cruzar os limiares de precisão (o caso comum — não
 * dispara em prosa saudável).
 */
export function detectInternalDuplication(
  content: string,
): InternalDuplication | null {
  if (!content) return null;
  const blocks = splitBlocks(content);
  const n = blocks.length;
  // Precisa de espaço pra 1ª + 2ª ocorrência (cada uma ≥ MIN_DUP_BLOCKS).
  if (n < MIN_DUP_BLOCKS * 2) return null;

  const norm = blocks.map(normalizeBlock);
  const wordsOf = blocks.map((b) => countWords(b));
  const totalWords = wordsOf.reduce((a, b) => a + b, 0);
  if (totalWords === 0) return null;

  let best: InternalDuplication | null = null;

  for (let i = 0; i < n; i++) {
    if (!norm[i]) continue;
    for (let k = i + 1; k < n; k++) {
      if (norm[k] !== norm[i]) continue;
      // Estende o run enquanto casa e a 1ª ocorrência não invade a 2ª.
      let L = 0;
      while (i + L < k && k + L < n && norm[i + L] === norm[k + L]) {
        L++;
      }
      if (L < MIN_DUP_BLOCKS) continue;
      // A 2ª ocorrência tem que ir ~até o fim (restart). Cauda = blocos após ela.
      let tail = 0;
      for (let t = k + L; t < n; t++) tail += wordsOf[t]!;
      if (tail > MAX_TAIL_WORDS) continue;
      // Palavras removidas = da 2ª ocorrência (k) até o fim (inclui a cauda).
      let words = 0;
      for (let t = k; t < n; t++) words += wordsOf[t]!;
      if (words < MIN_DUP_WORDS) continue;
      // Cobertura: o bloco repetido tem que ser uma fração grande do cap
      // (restart real ~50%; carta relida ~15% → rejeitada).
      if (words / totalWords < MIN_DUP_COVERAGE) continue;
      if (!best || words > best.words) {
        best = { startBlock: k, blocks: L, words };
      }
    }
  }

  return best;
}

export interface StripResult {
  /** Conteúdo limpo (ou o original intocado, se não havia duplicação). */
  content: string;
  /** true se algo foi removido. */
  trimmed: boolean;
  /** Total de palavras removidas (somando passes). */
  trimmedWords: number;
}

/**
 * Remove a duplicação interna mantendo a 1ª ocorrência e cortando da 2ª até o
 * fim. Idempotente: rodar de novo num texto já limpo não muda nada. NÃO altera
 * o conteúdo quando NÃO há duplicação (early-return do original — não remexe a
 * formatação à toa). Repassa até MAX_PASSES pra cobrir restart duplo.
 */
export function stripInternalDuplication(content: string): StripResult {
  if (!content) return { content, trimmed: false, trimmedWords: 0 };

  let cur = content;
  let trimmedWords = 0;
  let trimmed = false;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const dup = detectInternalDuplication(cur);
    if (!dup) break;
    const blocks = splitBlocks(cur);
    const kept = blocks.slice(0, dup.startBlock).join("\n\n").trimEnd();
    // Segurança paranoica: nunca devolve vazio (se algo bizarro zerar tudo,
    // mantém o que tinha e para — melhor um resíduo que um cap apagado).
    if (!kept.trim()) break;
    cur = kept;
    trimmedWords += dup.words;
    trimmed = true;
  }

  return { content: cur, trimmed, trimmedWords };
}
