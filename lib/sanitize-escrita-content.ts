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

import {
  hasXmlCruft,
  stripXmlCruft,
  hasCanonBanner,
  stripCanonBanner,
  hasEditorialNote,
  stripEditorialNote,
} from "./parse-revisor-output.ts";

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
 * Marca de EDIÇÃO / STAGE DIRECTION entre colchetes ocupando a LINHA inteira —
 * o modelo da Escrita às vezes "dirige" a cena em vez de narrá-la:
 *   `[Volta para Calla.]`  ·  `[POV: Damiano]`  ·  `[Transição de cena]`
 *   `[Corte para o flashback]`  ·  `[Retoma a perspectiva da Luna]`
 * É METADADO cravado na prosa que quebra a imersão e JAMAIS pode ir pro roteiro
 * final (mesma família da contagem de palavras / relatório do Revisor). A
 * roteirista reportou um `[Volta para Calla.]` cravado num roteiro de teste.
 *
 * PRECISO de propósito — a roteirista odeia metadado E remoção de prosa legítima
 * (REGRA Nº 1). Só casa quando AS DUAS coisas valem: (a) a linha É um colchete
 * INTEIRO (depois de tirar ênfase markdown/aspas em volta); (b) o miolo tem um
 * SINAL inequívoco de direção/edição (POV, cena, transição, corte, flashback,
 * "volta/retoma/retorna…", narração) ou de cânone/revisor. Assim NÃO toca:
 *   • num colchete no MEIO da frase ("Ele leu a placa: [SAÍDA].");
 *   • numa placa/bilhete em caixa-alta que o personagem lê ("[FECHADO PARA
 *     REFORMA]") — sem sinal de direção, fica;
 *   • em "[1]" / "[...]";
 *   • no `✦ NOME` (POV) nem nos separadores `---`/`***`/`═━─` — esses não usam
 *     colchete, então a marcação de POV/cena legítima (e o verde do export) fica
 *     intacta.
 * O Revisor ainda sinaliza (card informativo "metadado na prosa") qualquer marca
 * que não bata aqui — defesa em profundidade, sem auto-remover prosa duvidosa.
 */
const STAGE_DIRECTION_SIGNAL =
  /(?:^|[^a-zà-ÿ])(?:pov|perspectiva|narra(?:r|ndo|dor|[çc][ãa]o)|cena|transi[çc][ãa]o|corte|flashback|flash-back|volt[ao][a-zà-ÿ]*|retom[a-zà-ÿ]+|retorn[a-zà-ÿ]+|c[âa]none|substitu[a-zà-ÿ]*|roteirist[a-zà-ÿ]*|revisor[a-zà-ÿ]*)(?:$|[^a-zà-ÿ])/i;

export function isStageDirectionLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  // Tira ênfase markdown / aspas / blockquote em volta da linha inteira.
  const core = trimmed.replace(/^[>*_"'\s]+/, "").replace(/[*_"'\s]+$/, "");
  // (a) linha = um colchete inteiro (1-200 chars de miolo, sem `]` interno).
  if (!/^\[[^\]\n]{1,200}\]$/.test(core)) return false;
  // (b) miolo tem sinal de direção/edição (senão é placa/bilhete legítimo → fica).
  return STAGE_DIRECTION_SIGNAL.test(core);
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
  if (hasCanonBanner(text)) return true;
  if (hasEditorialNote(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    if (isWordCountLine(line)) return true;
    if (isStageDirectionLine(line)) return true;
  }
  return false;
}

/**
 * Remove a contaminação preservando a prosa e a estrutura de parágrafos:
 *   1) corta o relatório do Revisor (da 1ª âncora forte até o fim do texto);
 *   2) remove linhas-soltas de contagem de palavras + marcas de direção/edição
 *      entre colchetes ("[Volta para Calla.]", "[POV: X]");
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

  // 2) Linhas standalone de contagem de palavras + marcas de direção/edição
  //    entre colchetes ("[Volta para Calla.]", "[POV: X]", "[Transição]").
  out = out
    .split(/\r?\n/)
    .filter((line) => !isWordCountLine(line) && !isStageDirectionLine(line))
    .join("\n");

  // 3) Tags XML soltas (`<erro>`, `</trecho_corrigido>`, etc.) + a tarja de
  //    cânone "CÂNONE DE ENTIDADES" + NOTAS EDITORIAIS do Revisor entre colchetes
  //    ("[substitua X pelo nome do cânone…]", "[NOME NÃO MENCIONE…]") que tenham
  //    vazado pra prosa (cura roteiros já contaminados na 1.0.88). Só a TARJA de
  //    cânone (inequívoca) — a citação inline NÃO varre a prosa aqui (falso-
  //    positivo com "o cânone" substantivo); a nota editorial é segura (colchete
  //    + marcador editorial, que romance jamais usa). ORDEM: stripEditorialNote
  //    ANTES do stripCanonBanner — a nota costuma conter "ao cânone de entidades"
  //    e o banner comeria o `]` de fechamento, deixando meio colchete na prosa.
  out = stripCanonBanner(stripEditorialNote(stripXmlCruft(out)));

  // 4) Normaliza só o excesso de linhas em branco que sobrou das remoções.
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}
