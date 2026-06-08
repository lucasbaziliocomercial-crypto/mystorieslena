/**
 * Sanitizador do CONTEÚDO da Escrita — remove lixo que JAMAIS pode aparecer
 * na prosa do roteiro final, mas que o modelo às vezes emite por drift e os
 * parsers de capítulo engolem como corpo:
 *
 *   1. Linhas de CONTAGEM DE PALAVRAS  → `[Contagem: ~1.750 palavras]`,
 *      `(2.097 palavras)`, `*2.103 palavras*`, `Total de palavras: 1764`, etc.
 *   2. RELATÓRIO DO REVISOR apendado    → `# ❌ PRINCIPAIS ERROS`, a lista de
 *      erros 🔴/🟡, `NÍVEL DE RISCO DE HATE`, `ANÁLISE DE HATER`,
 *      `NOTA FINAL (0 a 10)` e o bloco XML `<erros_detalhados>`.
 *
 * Instrução permanente da roteirista: "jamais interfira na história, colocando
 * a quantidade de palavras ou o problema na revisão dentro da história." Os
 * prompts JÁ proíbem isso (Escrita regra 12 = GRAVÍSSIMO; o Revisor sinaliza
 * "Contaminação de metadados"), mas o modelo dá drift mesmo assim — então este
 * módulo é a defesa em profundidade no código, plugada na origem (parsers),
 * no heal de storage e no export. É category-agnostic (cobre as 4 categorias).
 *
 * Conservador por design: só remove o que é INEQUIVOCAMENTE metadado/relatório
 * (romance jamais contém "PRINCIPAIS ERROS" como cabeçalho nem "NOTA FINAL
 * (0 a 10)"). Sem âncora, não toca em nada — prosa legítima fica intacta.
 *
 * Funções puras, sem dependência de DOM/storage — testável por node.
 */

import { hasXmlCruft, stripXmlCruft } from "./parse-revisor-output.ts";

/**
 * Linha standalone que é PURA contagem de palavras (ex.: `(2.097 palavras)`,
 * `*(2.103 palavras)*`, `[Contagem: ~1.750 palavras]`, `Total de palavras:
 * 1764`, `【1.764 palavras】`). NÃO deve ir pra exportação nem ficar gravada na
 * prosa em nenhuma categoria nem Parte.
 *
 * Estratégia: depois de remover marcadores (markdown, parênteses, COLCHETES,
 * chaves, sinais, números) e palavras-chave conhecidas (contagem, total,
 * palavra(s), de, aproximadamente, etc.), se sobrar STRING VAZIA é metadado.
 * Frases de prosa que mencionam "palavras" no meio (ex.: "Ela escreveu 200
 * palavras antes de parar.") deixam tokens normais sobrando → não casam.
 *
 * Exige presença simultânea de dígito e da palavra "palavra(s)".
 *
 * NB: a classe de remoção inclui `[ ] { } 【 】` — sem isso a forma com
 * colchetes (`[Contagem: …]`) sobrava como `"[]"` e escapava do filtro (era
 * o bug que deixava `[Contagem: ~1.750 palavras]` vazar pro PDF).
 */
export function isWordCountLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  if (!/\d/.test(trimmed)) return false;
  // Não usa \b pq `_` é word char (regex JS), e o LLM emite itálico com
  // underscore tipo `_2.103 palavras_`. Boundary explícito por não-letra.
  if (
    !/(?:^|[^a-záéíóúâêôãõçñ])palavras?(?:$|[^a-záéíóúâêôãõçñ])/i.test(trimmed)
  )
    return false;
  const stripped = trimmed
    .replace(/[*_()~≈\[\]{}【】]/g, " ")
    .replace(/[:\-—,.]/g, " ")
    .replace(/\d+/g, " ")
    .toLowerCase()
    .replace(
      /\b(?:contagem|total|de|palavras|palavra|aproximadamente|cerca|aprox|aproximado)\b/g,
      " ",
    )
    .replace(/\s+/g, "");
  return stripped === "";
}

/**
 * Âncoras INEQUÍVOCAS de início de relatório do Revisor. Romance jamais contém
 * nenhuma delas. O relatório é SEMPRE apêndice (vem depois da prosa), então
 * achar qualquer âncora significa cortar dali até o fim. `i` (e `m` onde faz
 * sentido) sem `g` → `.exec`/`.test` são stateless.
 */
const REPORT_ANCHORS: RegExp[] = [
  // "# ❌ PRINCIPAIS ERROS" — tolera markdown `#` + emoji antes (até ~12 chars),
  // ancorado em início de linha pra não casar "principais erros" no meio da prosa.
  /^[^\n]{0,12}PRINCIPAIS\s+ERROS/im,
  /<erros_detalhados/i,
  /N[IÍ]VEL\s+DE\s+RISCO\s+DE\s+HATE/i,
  /AN[AÁ]LISE\s+DE\s+HATER/i,
  /NOTA\s+FINAL\s*\(\s*0\s*a\s*10\s*\)/i,
];

/** True se o texto tem QUALQUER contaminação (contagem, relatório ou XML cruft). */
export function hasEscritaContamination(text: string): boolean {
  if (!text) return false;
  if (REPORT_ANCHORS.some((re) => re.test(text))) return true;
  if (hasXmlCruft(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    if (isWordCountLine(line)) return true;
  }
  return false;
}

/**
 * Remove a contaminação preservando a prosa e a estrutura de parágrafos:
 *   1) corta o relatório do Revisor (da 1ª âncora forte até o fim do texto);
 *   2) remove linhas-soltas de contagem de palavras;
 *   3) tira tags XML soltas do schema do Revisor (defesa);
 *   4) colapsa só o excesso de linhas em branco que as remoções geraram.
 *
 * Idempotente. Early-return barato pra texto limpo (não realoca à toa).
 */
export function stripEscritaContamination(text: string): string {
  if (!text) return text;
  if (!hasEscritaContamination(text)) return text;

  let out = text;

  // 1) Relatório do Revisor (apêndice) — corta da 1ª âncora (início da linha
  //    dela) até o fim. min() entre todas as âncoras que casaram.
  let cutAt = -1;
  for (const re of REPORT_ANCHORS) {
    const m = re.exec(out);
    if (!m) continue;
    const lineStart = out.lastIndexOf("\n", m.index - 1) + 1;
    if (cutAt === -1 || lineStart < cutAt) cutAt = lineStart;
  }
  if (cutAt !== -1) out = out.slice(0, cutAt);

  // 2) Linhas standalone de contagem de palavras.
  out = out
    .split(/\r?\n/)
    .filter((line) => !isWordCountLine(line))
    .join("\n");

  // 3) Tags XML soltas (`<erro>`, `</trecho_corrigido>`, etc.).
  out = stripXmlCruft(out);

  // 4) Normaliza só o excesso de linhas em branco que sobrou das remoções.
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}
