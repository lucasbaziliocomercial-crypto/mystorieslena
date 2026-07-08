/**
 * Remoção DETERMINÍSTICA de MARCADORES DE POV `✦ NOME` DUPLICADOS EM SEQUÊNCIA
 * na PARTE 2 — resíduo de copiar-colar do modelo.
 *
 * Bug reportado (08/07/2026, história de máfia da Mina/Dante): a Escrita emitiu
 * `✦ DANTE — POV masculino` DUAS vezes seguidas, sem prosa entre os dois
 * marcadores — "resíduo de copiar-colar", listado como GRAVÍSSIMO na revisão. O
 * `dedupChaptersLast` (capítulo inteiro) e o `stripInternalDuplication` (bloco de
 * prosa repetido) NÃO pegam isto: são só duas LINHAS de marcador adjacentes, sem
 * corpo entre elas. O `stripPovMarkersPart1` também não — ele remove TODO
 * marcador, mas só da Parte 1 (onde nenhum ✦ é legítimo); na Parte 2 o ✦ é o
 * rótulo de POV que o exporter usa, então lá o conserto é COLAPSAR a duplicata,
 * não apagar.
 *
 * REGRA (alta precisão — só o caso INEQUÍVOCO de duplicata): quando dois (ou
 * mais) marcadores de POV NOMEADOS aparecem em sequência, separados apenas por
 * linhas em branco (NENHUMA prosa entre eles), e todos referem o MESMO narrador
 * (mesmo nome normalizado), mantém-se APENAS o ÚLTIMO — o que fica colado na
 * prosa que ele de fato rotula — e descartam-se os anteriores (redundantes, não
 * rotulam nada). Se os nomes adjacentes DIFEREM (ex.: `✦ DANTE` seguido de
 * `✦ MINA` sem prosa entre eles), é AMBÍGUO qual era a intenção — NÃO tocamos e
 * deixamos pro Revisor (que tem o checklist de marcador no bloco errado).
 *
 * ⚠️ SÓ marcador NOMEADO. Uma linha só de estrelas (`✦`, `✦ ✦ ✦`) é DIVISÓRIA
 * de cena, não marcador de POV — o grupo do nome exige ao menos uma letra/dígito,
 * então divisórias NÃO casam e são preservadas (mesma distinção do exporter e do
 * `strip-pov-markers-part1`). Duas divisórias `✦ ✦ ✦` seguidas continuam sendo
 * duas divisórias (não são marcadores nomeados) — não é escopo desta trava.
 *
 * ⚠️ Chamar SÓ em capítulos da Parte 2. Na Parte 1 o conserto é remover TODOS os
 * marcadores (`stripPovMarkersPart1`), não colapsar duplicatas.
 *
 * Função pura, sem DOM/storage — testável por node.
 */

// ✦ (U+2726) + look-alikes que o modelo às vezes emite (♦ U+2666, ◆ U+25C6) —
// mesma classe de símbolos do exporter e do strip-pov-markers-part1.
const POV_SYMBOL_CLASS = "[\\u2726\\u2666\\u25C6]";

/**
 * Linha ISOLADA que é um marcador de POV NOMEADO — captura o "miolo" (nome +
 * eventual sufixo `— POV masculino/feminino`) pra normalização posterior. Casa
 * as formas `✦ NOME`, `✦ **NOME**`, `**✦ NOME**`, `### ✦ NOME`, com ou sem o
 * sufixo de POV. O grupo capturado é validado por `normalizeMarkerName` (que
 * exige ao menos uma letra/dígito no NOME) — divisórias sem nome retornam null.
 */
const MARKER_LINE_RE = new RegExp(
  `^[ \\t]*(?:#{1,3}[ \\t]*)?\\*{0,2}${POV_SYMBOL_CLASS}[ \\t]+(.*?)[ \\t]*$`,
);

/**
 * Extrai o NOME canônico de um marcador (pra comparar dois marcadores). Remove
 * o sufixo de POV (`— POV masculino`, `– POV feminino`, `- pov ...`), a
 * formatação markdown (`**`), e normaliza (minúsculas, espaços colapsados).
 * Retorna null se a linha não é um marcador NOMEADO (sem letra/dígito no nome —
 * ex.: divisória `✦ ✦ ✦`).
 */
export function normalizeMarkerName(line: string): string | null {
  const m = line.match(MARKER_LINE_RE);
  if (!m) return null;
  let name = m[1] ?? "";
  // Corta o sufixo de POV, se houver (travessão/hífen + "POV ...").
  name = name.replace(/\s*[—–-]\s*POV\b.*$/i, "");
  // Remove marcadores markdown e outros símbolos de estrela remanescentes.
  name = name.replace(/\*+/g, "").replace(new RegExp(POV_SYMBOL_CLASS, "g"), "");
  name = name.replace(/\s+/g, " ").trim().toLowerCase();
  // Exige ao menos uma letra/dígito — divisórias (`✦ ✦ ✦`) caem fora.
  if (!/[\p{L}\p{N}]/u.test(name)) return null;
  return name;
}

export interface StripDuplicatePovResult {
  /** Conteúdo limpo (ou o original intocado, se não havia duplicata adjacente). */
  content: string;
  /** Quantas linhas de marcador redundante foram removidas. */
  removed: number;
}

/**
 * Colapsa marcadores de POV NOMEADOS duplicados em sequência (mesmo nome,
 * separados só por linhas em branco), mantendo o ÚLTIMO. No-op (retorna o
 * content original, `removed: 0`) quando não há duplicata adjacente — barato e
 * idempotente. NÃO altera nada quando os nomes adjacentes diferem (ambíguo →
 * fica pro Revisor).
 */
export function stripDuplicateConsecutivePovMarkers(
  content: string,
): StripDuplicatePovResult {
  if (!content) return { content, removed: 0 };
  const lines = content.split("\n");

  // Pré-computa, pra cada linha, se é marcador nomeado e qual o nome; e se é
  // linha em branco (só whitespace).
  const markerName: (string | null)[] = lines.map((l) => normalizeMarkerName(l));
  const isBlank: boolean[] = lines.map((l) => l.trim().length === 0);

  const removeIdx = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (markerName[i] == null) continue;
    // Acha a PRÓXIMA linha não-branca. Se for outro marcador do MESMO nome,
    // esta linha (i) é redundante — o próximo marcador rotula a mesma voz e fica
    // mais perto da prosa. Marca i pra remoção. (Cadeias de 3+ colapsam em
    // cascata: cada um vê o seguinte.)
    let j = i + 1;
    while (j < lines.length && isBlank[j]) j++;
    if (j < lines.length && markerName[j] != null && markerName[j] === markerName[i]) {
      removeIdx.add(i);
    }
  }

  if (removeIdx.size === 0) return { content, removed: 0 };

  const kept = lines.filter((_, i) => !removeIdx.has(i));
  // Colapsa a quebra tripla que a remoção da linha isolada tenha deixado, e apara
  // uma quebra inicial órfã (quando o marcador removido era a 1ª linha do bloco).
  const cleaned = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  return { content: cleaned, removed: removeIdx.size };
}
