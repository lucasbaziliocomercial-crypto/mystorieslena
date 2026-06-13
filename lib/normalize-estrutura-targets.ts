/**
 * Trava DETERMINÍSTICA (sem LLM) que garante que os alvos de palavras POR
 * CAPÍTULO de uma Estrutura sempre somem dentro da faixa total da Parte.
 *
 * Motivação: só a milionário-1p Parte 1 tem números fixos no prompt que somam
 * o total exato. A Parte 2 e as outras categorias (máfia, 3p, alphaking) deixam
 * o modelo distribuir as palavras com placeholders (`~X.XXX palavras` /
 * `Contagem aproximada: [N palavras]`) — e nada no código conferia se a soma
 * cabia no teto da Parte. Quando estoura, a Escrita escreve longo e a
 * calibração/balanço têm que encolher tudo depois (mais chamadas Opus = mais
 * lento em todo lugar).
 *
 * Esta função roda logo após a Estrutura ser finalizada (antes de gravar):
 * lê os alvos por capítulo (mesmos parsers que a Escrita usa —
 * `extractTargetFromBlock` de `parse-estrutura-targets`), e se a SOMA cair fora
 * de `partTotalRange`, reescala cada alvo proporcionalmente pra fechar no
 * `target` exato, reescrevendo SÓ o token de alvo de cada bloco de capítulo.
 * Total/hook/prosa fora dos blocos ficam intactos. Silenciosa por design.
 */

import {
  splitChapterBlocks,
  extractTargetFromBlock,
  partTotalRange,
} from "@/lib/parse-estrutura-targets";
import type { RoteiroCategory } from "@/lib/categories/types";
import { DEFAULT_CATEGORY } from "@/types/roteiro";

export interface NormalizeEstruturaResult {
  text: string;
  /** true se algum alvo foi reescrito (soma estava fora da faixa da Parte). */
  rescaled: boolean;
  sumBefore: number;
  sumAfter: number;
}

/** "2070" → "2.070" | "950" → "950" | "11500" → "11.500" (separador de milhar). */
function fmtMilhar(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "2.070" → 2070 | "950" → 950 (tira o separador de milhar). */
function parseNum(s: string): number {
  return parseInt(s.replace(/\./g, ""), 10);
}

// Token numérico tolerante: "1.380", "11.500" (com separador) OU "2070" (3-5
// dígitos sem separador) — espelha os formatos que o modelo emite nos headers.
const NUM_TOK = String.raw`(?:\d{1,2}\.\d{3}|\d{3,5})`;
const RANGE_RE = new RegExp(
  `(${NUM_TOK})(\\s*(?:[-–—]|a)\\s*)(${NUM_TOK})(\\s*palavras)`,
  "i",
);
const SINGLE_RE = new RegExp(
  `((?:~|aproximadamente\\s+)?)(${NUM_TOK})(\\s*palavras)`,
  "i",
);

/**
 * Reescreve o PRIMEIRO token de alvo de um TRECHO pra `newTarget`. Tenta faixa
 * (`A-B palavras`) antes de número único — MESMA ordem do `extractTargetFromText`,
 * pra o token reescrito ser exatamente o que a Escrita lê depois. Numa faixa,
 * escala os dois extremos pro mesmo fator (preserva o formato de faixa).
 * Retorna `null` se nada casar neste trecho.
 */
function rewriteTargetInText(text: string, newTarget: number): string | null {
  const rm = RANGE_RE.exec(text);
  if (rm) {
    const a = parseNum(rm[1]!);
    const b = parseNum(rm[3]!);
    const avg = Math.max(1, Math.round((a + b) / 2));
    const f = newTarget / avg;
    const na = Math.max(1, Math.round(a * f));
    const nb = Math.max(1, Math.round(b * f));
    return (
      text.slice(0, rm.index) +
      fmtMilhar(na) +
      rm[2]! +
      fmtMilhar(nb) +
      rm[4]! +
      text.slice(rm.index + rm[0].length)
    );
  }
  const sm = SINGLE_RE.exec(text);
  if (sm) {
    return (
      text.slice(0, sm.index) +
      sm[1]! +
      fmtMilhar(newTarget) +
      sm[3]! +
      text.slice(sm.index + sm[0].length)
    );
  }
  return null; // nada pra reescrever neste trecho
}

/**
 * Reescreve o alvo de palavras de um bloco de capítulo PELO HEADER (1ª linha),
 * caindo pro corpo só se o header não declarar alvo — ESPELHO EXATO do leitor
 * `extractTargetFromBlock` (`parse-estrutura-targets`).
 *
 * ⚠️ Por que header-first: uma anotação de SUB-CENA no corpo (ex.: o trecho ✦ do
 * POV masculino na máfia/alpha-king, "1 trecho MMC de 237-297 palavras") descreve
 * um PEDAÇO do capítulo, não o alvo dele. Se o escritor reescrevesse essa faixa em
 * vez do header (como fazia antes), o header continuaria com o número velho que o
 * leitor (header-first) lê — leitor e escritor discordavam e o normalize INFLAVA a
 * estrutura (lia a faixa de sub-cena como alvo → soma artificialmente baixa →
 * reescalava tudo pra cima). Bug "normalize infla a Estrutura", 12/06/2026.
 */
function rewriteTargetInBlock(body: string, newTarget: number): string {
  const nl = body.indexOf("\n");
  const header = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? "" : body.slice(nl);
  const rewrittenHeader = rewriteTargetInText(header, newTarget);
  if (rewrittenHeader !== null) return rewrittenHeader + rest;
  // Fallback: header sem alvo (ex.: milionário-3p, alvo no corpo).
  return rewriteTargetInText(body, newTarget) ?? body;
}

/**
 * Sincroniza a linha-RESUMO da Estrutura ("**Soma das contagens declaradas:**
 * A + B + … = TOTAL palavras") com os alvos REESCALADOS, pra ela bater com os
 * cabeçalhos dos capítulos. O modelo escreve esse resumo à mão e às vezes erra a
 * conta (declara capítulos somando 15.500 e escreve "= 13.500"); de qualquer forma
 * ele ficaria defasado depois do reescalonamento. Reescreve SÓ essa linha (metadado
 * da Estrutura — NUNCA a prosa/história) e só quando a quantidade de números bate
 * com o nº de capítulos (senão devolve o texto intacto). Não é a fonte que a Escrita
 * lê (isso é o header) — é só pra não confundir a roteirista.
 */
function rewriteFooterSum(
  text: string,
  targets: number[],
  total: number,
): string {
  const labelRe =
    /Soma das contagens declaradas|Confirma[çc][ãa]o final de palavras|Soma total declarada/i;
  const listRe = /([\d.]+(?:\s*\+\s*[\d.]+)+)(\s*=\s*\*{0,2}\s*)([\d.]+)/;
  const newList = targets.map(fmtMilhar).join(" + ");
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!labelRe.test(line)) return line;
    const m = listRe.exec(line);
    if (!m || m[1]!.split("+").length !== targets.length) return line;
    changed = true;
    return (
      line.slice(0, m.index) +
      newList +
      m[2]! +
      fmtMilhar(total) +
      line.slice(m.index + m[0]!.length)
    );
  });
  return changed ? lines.join("\n") : text;
}

/**
 * Garante que a soma dos alvos por capítulo caiba na faixa da Parte.
 * Se já cabe (ou não dá pra ler todos os alvos com segurança), devolve o texto
 * intacto com `rescaled: false`.
 */
export function normalizeEstruturaTargets(
  estrutura: string | undefined,
  part: "Parte 1" | "Parte 2",
  category: RoteiroCategory = DEFAULT_CATEGORY,
): NormalizeEstruturaResult {
  const text = estrutura ?? "";
  const blocks = splitChapterBlocks(text);
  if (blocks.length === 0) {
    return { text, rescaled: false, sumBefore: 0, sumAfter: 0 };
  }

  const targets = blocks.map((b) => extractTargetFromBlock(b.body));
  // Se algum capítulo não tem alvo legível, NÃO mexe (reescalar parcialmente
  // distorceria o resto) — segurança acima de tudo.
  if (targets.some((t) => t === undefined)) {
    const sum = targets.reduce<number>((acc, t) => acc + (t ?? 0), 0);
    return { text, rescaled: false, sumBefore: sum, sumAfter: sum };
  }

  const nums = targets as number[];
  const sumBefore = nums.reduce((a, b) => a + b, 0);
  const { min, max, target } = partTotalRange(part, category);

  if (sumBefore >= min && sumBefore <= max) {
    return { text, rescaled: false, sumBefore, sumAfter: sumBefore };
  }
  if (sumBefore <= 0) {
    return { text, rescaled: false, sumBefore, sumAfter: sumBefore };
  }

  // Reescala proporcional pro total alvo, com o resíduo de arredondamento no
  // capítulo de maior alvo (pra a soma bater EXATA no target).
  const factor = target / sumBefore;
  const newTargets = nums.map((t) => Math.max(1, Math.round(t * factor)));
  const residual = target - newTargets.reduce((a, b) => a + b, 0);
  if (residual !== 0) {
    let idxMax = 0;
    for (let i = 1; i < newTargets.length; i++) {
      if (newTargets[i]! > newTargets[idxMax]!) idxMax = i;
    }
    newTargets[idxMax] = Math.max(1, newTargets[idxMax]! + residual);
  }

  // Reescreve cada bloco no texto original. `splitChapterBlocks` cobre de forma
  // contígua do 1º header de capítulo até o fim, então o prefixo (hook, mundo,
  // personagens etc.) é preservado e só os blocos são reescritos.
  const prefix = text.slice(0, blocks[0]!.start);
  const rewrittenBodies = blocks.map((b, i) =>
    rewriteTargetInBlock(b.body, newTargets[i]!),
  );
  const newText = prefix + rewrittenBodies.join("");
  const sumAfter = newTargets.reduce((a, b) => a + b, 0);

  // Sincroniza o rodapé-resumo com os alvos reescalados (só a linha "Soma das
  // contagens declaradas: …"); se não houver, devolve `newText` intacto.
  const finalText = rewriteFooterSum(newText, newTargets, target);

  return { text: finalText, rescaled: true, sumBefore, sumAfter };
}
