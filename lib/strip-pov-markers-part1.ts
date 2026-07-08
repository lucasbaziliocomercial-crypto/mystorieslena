/**
 * Remoção DETERMINÍSTICA de marcadores de POV `✦ NOME` que vazam pra PARTE 1.
 *
 * A Parte 1 das 4 categorias é narrada 100% pela FMC (heroína), do começo ao
 * fim — NENHUM bloco `✦ NOME` (POV do MMC ou de qualquer outro) pode existir
 * nela. O marcador visual `✦ NOME` é EXCLUSIVO da Parte 2 (categorias de POV
 * alternado: milionário-1p, máfia, alpha-king; a milionário-3p não usa `✦` em
 * Parte nenhuma). Os prompts da Estrutura E da Escrita já proíbem isso de forma
 * explícita, mas a defesa é PROBABILÍSTICA — o modelo Opus às vezes emite um
 * bloco `✦ THIERRY` no meio da Parte 1 mesmo assim (bug reportado pela
 * roteirista na história da LENA/máfia: "só falas do MMC aparecendo na Parte
 * 1"; o `✦ THIERRY` aparecia como nó na árvore de Guias do Google Docs, POV do
 * MMC onde só devia haver a heroína).
 *
 * Diferente do "vazamento do narrador" na milionário-3p (que exige reescrita
 * GRAMATICAL — "o narrador registrou X" no meio da oração — e por isso NÃO tem
 * sanitizer de código, só o Revisor limpa), um marcador `✦ NOME` é uma LINHA
 * ISOLADA: removê-la é um corte puramente MECÂNICO que NÃO toca a prosa. Por
 * isso cabe uma trava determinística aqui, na origem (o motor da Escrita),
 * análoga ao `stripInternalDuplication`. Isto remove SÓ o marcador; se a prosa
 * do bloco em si escorregou pro POV do MMC, o resíduo fica pro Revisor (que tem
 * o checklist de POV/narrador). Defesa em profundidade: prompt (previne) +
 * este strip (remove o marcador visível) + Revisor (pega o resíduo de prosa).
 *
 * ⚠️ SÓ marcador NOMEADO. Uma linha só de estrelas (`✦`, `✦ ✦ ✦`, `**✦**`) é
 * DIVISÓRIA DE CENA decorativa, NÃO um marcador de POV — o exporter já a trata
 * como `<hr>`. Removê-la seria destrutivo (perderia a quebra de cena), então o
 * regex exige que o "nome" tenha ao menos uma letra/dígito. Mesma distinção que
 * o exporter faz (`lib/export-html.ts`, POV_SYMBOL_DIVIDER_RE vs `### ✦ NOME`).
 *
 * Função pura, sem DOM/storage — testável por node.
 */

// ✦ (U+2726) + look-alikes que o modelo às vezes emite no lugar (♦ U+2666,
// ◆ U+25C6) — mesma classe de símbolos do exporter (lib/export-html.ts).
const POV_SYMBOL_CLASS = "[\\u2726\\u2666\\u25C6]";

/**
 * Linha ISOLADA que é um marcador de POV NOMEADO:
 *   `✦ NOME`, `✦ **NOME**`, `**✦ NOME**`, `### ✦ NOME` (forma já promovida a
 *   heading, caso o strip rode sobre conteúdo já curado/reescrito).
 * O grupo do nome EXIGE ao menos uma letra/dígito — assim `✦ ✦ ✦` (divisória
 * decorativa, sem nome) NÃO casa e é preservado como quebra de cena.
 */
const NAMED_POV_MARKER_RE = new RegExp(
  `^[ \\t]*(?:#{1,3}[ \\t]*)?\\*{0,2}${POV_SYMBOL_CLASS}[ \\t]+\\*{0,2}` +
    `([^\\n*]*[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç0-9][^\\n*]*?)` +
    `\\*{0,2}[ \\t]*$`,
);

/**
 * Remove todas as linhas de marcador de POV NOMEADO (`✦ NOME`) do conteúdo de um
 * capítulo da PARTE 1. Retorna o conteúdo já limpo e a lista dos nomes removidos
 * (pra o aviso visível no banner da Escrita). No-op (retorna o content original,
 * `removed: []`) quando não há nenhum marcador — barato e idempotente.
 *
 * ⚠️ Chamar SÓ em capítulos da Parte 1. Na Parte 2 o `✦ NOME` é legítimo e
 * necessário (é o rótulo de POV que o exporter usa pro destaque verde do MMC).
 */
export function stripPovMarkersPart1(content: string): {
  content: string;
  removed: string[];
} {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(NAMED_POV_MARKER_RE);
    if (m) {
      removed.push(m[1].trim());
      continue; // descarta a linha do marcador — a prosa ao redor fica intacta
    }
    kept.push(line);
  }
  if (removed.length === 0) return { content, removed };
  // Colapsa a quebra tripla que a remoção da linha isolada possa ter deixado
  // (marcador rodeado de linhas em branco → \n\n\n). Preserva o resto.
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  return { content: cleaned, removed };
}
