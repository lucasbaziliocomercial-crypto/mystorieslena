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
 *
 * ⚠️ O RÓTULO DE PAPEL no fim (`— POV masculino` / `— POV feminino`) é OPCIONAL
 * e fica FORA do grupo do nome. Desde 1.1.19 o prompt da Escrita manda escrever
 * o rótulo colado no marcador, e as 3 categorias com ✦ também pedem o nome em
 * **negrito** — a combinação `✦ **NOME** — POV masculino` punha o sufixo DEPOIS
 * do `**` de fecho e a linha deixava de casar, derrubando esta trava de origem
 * justo quando o modelo vaza um POV do MMC pra Parte 1 (bug recorrente da LENA).
 * Manter em sincronia com o formato do `POV_MARKER_RULE`.
 */
const POV_ROLE_SUFFIX = `(?:[—–-][ \\t]*POV[ \\t]+(?:masculino|feminino)[ \\t]*)?`;

/** O mesmo rótulo, pra limpar o NOME capturado (ver uso abaixo). */
const POV_ROLE_SUFFIX_TRAIL_RE =
  /(?:[—–-]\s*POV\s+(?:masculino|feminino)\s*)+$/i;

const NAMED_POV_MARKER_RE = new RegExp(
  `^[ \\t]*(?:#{1,3}[ \\t]*)?\\*{0,2}${POV_SYMBOL_CLASS}[ \\t]+\\*{0,2}` +
    `([^\\n*]*[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç0-9][^\\n*]*?)` +
    `\\*{0,2}[ \\t]*${POV_ROLE_SUFFIX}\\*{0,2}[ \\t]*$`,
  // `i` por causa do RÓTULO: os prompts pedem o nome em CAIXA ALTA, e o modelo
  // uniformiza a linha toda ("✦ **DANTE** — POV MASCULINO"). Sem o flag, esse
  // par negrito+caixa escapava da trava. As classes do NOME já cobriam as duas
  // caixas, e a exigência de letra/dígito segue barrando a divisória `✦ ✦ ✦`.
  // Mesmo tratamento do irmão `normalizeMarkerName` (strip-duplicate-pov-markers).
  "i",
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
      // Só o NOME no aviso da roteirista: o `[^\n*]*` inicial do grupo é guloso,
      // então num marcador sem negrito (`✦ THIERRY — POV masculino`) o rótulo
      // entra na captura. A linha é removida de qualquer jeito — isto é só pra o
      // banner dizer "THIERRY", não "THIERRY — POV masculino".
      removed.push(m[1].replace(POV_ROLE_SUFFIX_TRAIL_RE, "").trim());
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
