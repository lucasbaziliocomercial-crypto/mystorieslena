import type { EscritaChapter } from "@/types/roteiro";
import { countWords } from "./word-count.ts";
import { stripChapterTitleAnnotation } from "./strip-chapter-annotations";

/**
 * Helpers de exportação HTML do roteiro.
 *
 * Produz HTML estilizado pra colar no Google Docs preservando a hierarquia —
 * PARTE como Heading 1 centralizado, Capítulo como Heading 2 grande e bold,
 * troca de POV (✦ Nome) como Heading 3, fonte Arial 11pt, parágrafos
 * justificados (match exato do default do Docs).
 *
 * O mesmo HTML é usado tanto no download direto (.html), na exportação PDF
 * (printToPDF do Electron) quanto no copy-clipboard pra colar no Google Docs.
 *
 * Tolera dois formatos de marcador (legado e novo):
 *   - "═══ PARTE 1 ═══" (legado)              → <h1> "PARTE 1" centralizado (Heading 1 no Docs)
 *   - "# PARTE 1"                             → <h1> "PARTE 1" centralizado (Heading 1 no Docs)
 *   - "# Capítulo 1 — X" (legado)             → <h2> Capítulo 1 — X (Heading 2 no Docs)
 *   - "## Capítulo 1 — X" (novo)              → <h2> Capítulo 1 — X (Heading 2 no Docs)
 *   - "━━━ NOME ━━━" / "### ✦ Nome"           → <h3> "✦ Nome" (Heading 3 no Docs, subtítulo de POV)
 *
 * A hierarquia h1 (PARTE) > h2 (Capítulo) > h3 (POV) faz o painel "Guias" /
 * "Estrutura do documento" do Google Docs aninhar tudo numa árvore correta:
 * cada Capítulo aparece embaixo da PARTE, e cada troca de POV embaixo do
 * Capítulo. Sem essa hierarquia, só os h3 viravam nó visíveis.
 */

const SANS = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

const STYLE_BODY =
  `font-family: ${SANS}; line-height: 1.5; color: #000; font-size: 11pt; font-weight: 400;`;
// font-weight: 400 explícito no <p> impede o Google Docs de herdar o weight 700
// do <h1> de Capítulo anterior durante o paste (bug visto no Revisor onde
// todo o body saia em negrito). font-family redundante aqui pra travar a fonte
// caso o Docs decida não herdar do body.
const STYLE_PARA =
  `margin: 0 0 11pt 0; text-align: justify; line-height: 1.5; font-size: 11pt; font-weight: 400; font-family: ${SANS};`;
const STYLE_H_CHAPTER =
  `font-family: ${SANS}; font-size: 20pt; font-weight: 700; color: #000; margin: 20pt 0 6pt 0; line-height: 1.15; text-align: left;`;
const STYLE_PART_DIVIDER =
  `text-align: center; margin: 36pt 0 24pt 0; font-family: ${SANS}; font-size: 14pt; font-weight: 700; color: #000;`;
const STYLE_POV_HEADING =
  `font-family: ${SANS}; font-size: 12pt; font-weight: 700; color: #000; margin: 14pt 0 8pt 0; line-height: 1.3; text-align: left;`;
const STYLE_HR =
  "border: none; border-top: 1px solid #999; opacity: 0.5; margin: 24pt auto; width: 40%;";
// Verde Google Docs "Light green 3" — destaque marca-texto pros parágrafos do
// POV do MMC. Aplicado em <span> inline (não no <p>) porque o Docs trata
// background-color em span como destaque de texto e em block como caixa.
const STYLE_HIGHLIGHT_MMC = "background-color: #d9ead3";

// Símbolo "marcador de POV" — o prompt da Escrita instrui ✦ (U+2726) mas o
// LLM às vezes emite ♦ (U+2666), visualmente parecido mas codepoint diferente.
// Aceitar ambos (e ◆ U+25C6 como rede de segurança) garante que TODA mudança
// de POV da Parte 2 seja reconhecida — caso contrário o trecho fica como
// parágrafo cru, sem virar Heading 3 no Docs e sem destaque verde do MMC.
const POV_SYMBOL_CLASS = "[\\u2726\\u2666\\u25C6]"; // ✦ ♦ ◆
const POV_PREFIX_STRIP_RE = new RegExp(`^${POV_SYMBOL_CLASS}\\s*`);

function nomeCanonico(s: string): string {
  return s.replace(POV_PREFIX_STRIP_RE, "").trim().toLowerCase();
}

function preprocessRoteiro(raw: string): string {
  let preprocessed = raw.replace(
    /═{3,}\s*\n\s*(PARTE 1|PARTE 2)\s*\n\s*═{3,}/g,
    (_m, label) => `# ${label}`,
  );
  preprocessed = preprocessed.replace(
    /═{3,}\s*\n\s*ROTEIRO\s*\n\s*═{3,}/g,
    "",
  );
  preprocessed = preprocessed.replace(
    /━{3,}\s*\n\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s]*?)\s*\n\s*━{3,}/g,
    (_m, name) => {
      const trimmed = name.trim();
      const formatted = trimmed
        .toLowerCase()
        .replace(/(?:^|\s)\S/g, (s: string) => s.toUpperCase());
      return `### ✦ ${formatted}`;
    },
  );
  // Formato máfia (lib/agents/mafia/escrita-prompt.ts:46) — POV vem como
  // linha isolada `✦ NOME` (com possível **negrito**), sem heading markdown.
  // Promove para `### ✦ NOME` pra ser tratado pelo walker e pelo detector
  // de MMC. Não casa quando já tem `### ` na frente (esse prefixo bloqueia
  // o `^[ \t]*` por causa do `#`).
  preprocessed = preprocessed.replace(
    new RegExp(
      `^[ \\t]*\\*{0,2}${POV_SYMBOL_CLASS}[ \\t]+([^\\n*]+?)\\*{0,2}[ \\t]*$`,
      "gm",
    ),
    (_m, name) => `### ✦ ${name.trim()}`,
  );
  return preprocessed;
}

/**
 * Detecta MMC dado um trecho qualquer (sem garantia de Parte 1 + Parte 2).
 *
 * Heurística "primeiro vs. segundo POV diferente": o primeiro `### ✦ Nome`
 * é tratado como FMC e o próximo nome distinto é o MMC. Funciona em
 * `milionario-1p` porque o prompt da Escrita força a Parte 2 a sempre
 * começar pelo POV da FMC. Para `milionario-3p` (onde Parte 2 pode começar
 * pelo MMC) essa regra inverte e/ou retorna nada — use
 * `detectMaleLeadFromFullRoteiro` quando o roteiro inteiro está disponível.
 */
export function detectMaleLeadName(raw: string): string | null {
  const normalized = preprocessRoteiro(raw);

  let firstPov: string | null = null;
  let mmcDisplay: string | null = null;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    const h3 = line.match(/^###\s+(.+)$/);
    if (!h3) continue;

    const display = h3[1].replace(POV_PREFIX_STRIP_RE, "").trim();
    if (!display) continue;

    const canonical = display.toLowerCase();
    if (firstPov === null) {
      firstPov = canonical;
      continue;
    }
    if (canonical !== firstPov) {
      mmcDisplay = display;
      break;
    }
  }

  return mmcDisplay;
}

const IMPLICIT_POV_KEY = "__implicit__";

/**
 * Linha standalone que o LLM da Escrita injeta no fim de capítulos com a
 * contagem de palavras (ex.: `(2.097 palavras)`, `*(2.103 palavras)*`,
 * `(Contagem: 1.764 palavras)`, `Total de palavras: 1764`). Não devem ir
 * pra exportação (PDF, HTML, clipboard) em nenhuma categoria nem Parte.
 *
 * Estratégia: a linha é considerada metadata se, depois de remover marcadores
 * markdown, parênteses, sinais, números e palavras-chave conhecidas (contagem,
 * total, palavra(s), de, aproximadamente, etc.), sobrar STRING VAZIA. Frases
 * de prosa que mencionam "palavras" no meio (ex.: "Ela escreveu 200 palavras
 * antes de parar.") deixam tokens normais sobrando, então não casam.
 *
 * Exige presença simultânea de dígito e da palavra "palavra(s)" — sem isso,
 * é prosa normal.
 */
function isWordCountLine(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  if (!trimmed) return false;
  if (!/\d/.test(trimmed)) return false;
  // Não usa \b pq `_` é word char (regex JS), e o LLM emite italico com
  // underscore tipo `_2.103 palavras_`. Boundary explícito por não-letra.
  if (
    !/(?:^|[^a-záéíóúâêôãõçñ])palavras?(?:$|[^a-záéíóúâêôãõçñ])/i.test(trimmed)
  )
    return false;
  const stripped = trimmed
    .replace(/[*_()~≈]/g, " ")
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
 * Extrai o PRIMEIRO NOME do MMC do output da Estrutura1 (ou Estrutura2).
 *
 * Em todas as 3 categorias (`milionario-1p`, `milionario-3p`, `mafia`) os
 * prompts da Estrutura têm uma seção rotulada `PROTAGONISTA MASCULINO (MMC)`
 * seguida de um campo `Nome: <nome>` (ou `- Nome: <nome>`, com bullet
 * markdown opcional, e cabeçalho podendo vir com `#` ou emoji 👤/🤵 antes).
 *
 * Esta é a fonte CONFIÁVEL — não depende de heurística de palavras (que
 * quebra em máfia, onde MMC pode ter mais palavras que FMC).
 *
 * Retorna só o PRIMEIRO nome ("Saverio" de "Saverio Aldobrandini") porque
 * é assim que o `✦ NOME` aparece no roteiro da Escrita.
 *
 * Retorna `null` se a estrutura não foi gerada, foi editada quebrando o
 * padrão, ou não é parseável.
 */
export function extractMaleLeadNameFromEstrutura(
  estruturaContent: string | undefined | null,
): string | null {
  if (!estruturaContent) return null;

  // Captura a SEÇÃO "PROTAGONISTA MASCULINO (MMC)" — do header dela até a
  // próxima seção em caixa alta (ex.: "PROTAGONISTA FEMININA", "ANTAGONISTA",
  // "TRAMA") ou fim de string. Sem delimitar a seção, varremos Nome:s de
  // outros personagens. Limitado a 2000 chars pra não pegar a estrutura toda.
  const headerMatch = estruturaContent.match(
    /PROTAGONISTA\s+MASCULINO\s*\(MMC\)[^\n]*\n/i,
  );
  if (!headerMatch || headerMatch.index === undefined) return null;
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = estruturaContent.slice(sectionStart, sectionStart + 2000);
  // Procura a próxima linha "ALL CAPS de pelo menos 5 letras" (próxima seção).
  // Se não achar, usa o fim do slice. Tolerante a markdown header (`##`/`#`)
  // e bullets emoji antes do título.
  const nextSectionRe = /\n(?:#{1,3}\s+)?[^\n]{0,4}\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,}/;
  const nextMatch = rest.match(nextSectionRe);
  const section = nextMatch && nextMatch.index !== undefined
    ? rest.slice(0, nextMatch.index)
    : rest;

  // Pega TODAS as linhas "Nome..." (incluindo "Nome corrigido", "Nome real",
  // "Nome do personagem" etc.). O LLM às vezes anota um aviso/correção no
  // primeiro `Nome:` (ex.: "⚠️ ATENÇÃO: nome substituído por estar na lista
  // de proibidos") e coloca o nome real numa linha "Nome corrigido:" depois.
  // Sem essa lógica, o detector retornaria "⚠️" e nenhum POV ficaria verde.
  const nameLineRe =
    /^[ \t]*(?:[-•*]\s*)?\*{0,2}Nome[^\n:—\-]*\*{0,2}\s*[:\-—]\s*(.+?)\s*$/gim;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameLineRe.exec(section)) !== null) {
    candidates.push(m[1].trim());
  }
  if (candidates.length === 0) return null;

  const isPlausibleName = (raw: string): string | null => {
    let cleaned = raw.replace(/^\*+|\*+$/g, "").trim();
    cleaned = cleaned.replace(/^\*+|\*+$/g, "").trim(); // remove ** wrapping again se sobrar
    if (!cleaned) return null;
    // Rejeita avisos/disclaimers do LLM. Não basta cortar `^\*+|\*+$` — o
    // valor pode começar com ⚠️, "ATENÇÃO", "ATTENTION", "ATTENTION!",
    // "Sem nome", "(a definir)", etc.
    const lc = cleaned.toLowerCase();
    if (
      /^[⚠️❗❌🚫]/.test(cleaned) ||
      /\b(aten[cç][aã]o|proibido|substitu[ií]d|disclaimer|n[aã]o\s+definido|sem\s+nome|a\s+definir|placeholder)\b/i.test(
        cleaned,
      ) ||
      lc.startsWith("(") ||
      lc.length < 2
    ) {
      return null;
    }
    // Exige pelo menos uma letra (caso o LLM tenha colocado só símbolos).
    if (!/[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]/.test(cleaned)) return null;
    // Pega o primeiro token "nome-like" (letras/acentos/hífen, sem aspas/vírgula).
    const firstToken = cleaned
      .split(/[\s,()"'—\-]+/)
      .find((t) => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]+$/.test(t));
    if (firstToken) return firstToken;
    // Fallback: primeiro token simples (já passou validação básica).
    const fallback = cleaned.split(/\s+/)[0];
    return /^[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]/.test(fallback) ? fallback : null;
  };

  // Prioridade: último candidato plausível (correções vêm DEPOIS do original
  // — "Nome corrigido", "Nome real" etc. ficam abaixo de "Nome").
  for (let i = candidates.length - 1; i >= 0; i--) {
    const name = isPlausibleName(candidates[i]);
    if (name) return name;
  }
  return null;
}

/**
 * Detecta o MMC a partir do roteiro COMPLETO (Parte 1 + Parte 2).
 *
 * Sinais combinados (em ordem):
 *   1. **Parte 1 marcou FMC e Parte 2 introduz nome novo** (`milionario-3p`):
 *      Se Parte 1 tem `### ✦` cobrindo a maior parte da prosa de P1 (ou seja,
 *      o bucket implícito de P1 é pequeno), o set de nomes de P1 é o conjunto
 *      FMC. MMC = primeiro nome em P2 que NÃO está nesse set.
 *   2. **FMC tem mais palavras que MMC** (sinal universal — vale para `1p`,
 *      `mafia` e como tiebreaker de `3p`): Conta palavras por bucket de POV
 *      no roteiro inteiro (incluindo um bucket "implícito" para a prosa
 *      antes de qualquer `### ✦`, típico da Parte 1 de `1p` e `mafia`). Se
 *      o bucket implícito é grande (>= 1000 palavras), ele representa a FMC
 *      narrando sem header. Entre os nomes marcados, MMC = quem tem MENOS
 *      palavras totais. Cobre o caso da máfia onde Parte 1 é toda implícita
 *      e o MMC só aparece num cliffhanger curto + na Parte 2.
 *   3. **Apenas 1 nome marcado**: Se há narração implícita substantiva mais
 *      um único nome com `### ✦`, esse nome é o MMC.
 *
 * Retorna `null` quando não há `### ✦` algum (não dá pra destacar nada).
 */
export function detectMaleLeadFromFullRoteiro(raw: string): string | null {
  const normalized = preprocessRoteiro(raw);

  type Bucket = { display: string; words: number };
  const buckets = new Map<string, Bucket>();
  const parte1Names: string[] = [];
  const parte2Names: string[] = [];

  let currentPovCanonical: string = IMPLICIT_POV_KEY;
  let inParte2 = false;

  const ensureBucket = (canonical: string, display: string) => {
    if (!buckets.has(canonical)) {
      buckets.set(canonical, { display, words: 0 });
    }
  };
  ensureBucket(IMPLICIT_POV_KEY, "");

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#\s+PARTE 2\s*$/.test(line)) {
      inParte2 = true;
      // Reseta o POV: prosa logo após `# PARTE 2` sem `### ✦` é implícita
      // de novo (raro, mas evita herdar POV de cliffhanger da P1).
      currentPovCanonical = IMPLICIT_POV_KEY;
      continue;
    }
    if (/^#\s+PARTE 1\s*$/.test(line)) {
      inParte2 = false;
      currentPovCanonical = IMPLICIT_POV_KEY;
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      const display = h3[1].replace(POV_PREFIX_STRIP_RE, "").trim();
      if (display) {
        currentPovCanonical = display.toLowerCase();
        ensureBucket(currentPovCanonical, display);
        if (inParte2) parte2Names.push(currentPovCanonical);
        else parte1Names.push(currentPovCanonical);
      }
      continue;
    }

    // Pula `## Capítulo` e `# OutraCoisa` (não conta como prosa).
    if (/^##?\s+/.test(line)) continue;

    buckets.get(currentPovCanonical)!.words += countWords(line);
  }

  const namedBuckets = [...buckets.entries()].filter(
    ([canonical]) => canonical !== IMPLICIT_POV_KEY,
  );

  if (namedBuckets.length === 0) return null;
  if (namedBuckets.length === 1) return namedBuckets[0][1].display;

  const implicitWords = buckets.get(IMPLICIT_POV_KEY)!.words;
  const parte1Set = new Set(parte1Names);

  // Sinal 1: Parte 1 marcou a FMC com cobertura significativa (implícito
  // pequeno). Vale pra milionario-3p (P1 narrada limitada à FMC com header).
  if (parte1Set.size > 0 && implicitWords < 1000) {
    for (const canonical of parte2Names) {
      if (!parte1Set.has(canonical)) {
        return buckets.get(canonical)!.display;
      }
    }
    return null;
  }

  // Sinal 2: FMC tem mais palavras (universal). Quando a P1 é implícita
  // (bucket "__implicit__" grande) ou nenhum dos sinais determinísticos
  // resolveu, o nome marcado com MENOS palavras é o MMC.
  namedBuckets.sort((a, b) => a[1].words - b[1].words);
  return namedBuckets[0][1].display;
}

/**
 * Converte o output cru da Escrita em HTML formatado, com hierarquia
 * de headings adequada pra Google Docs e PDF.
 */
export function escritaContentToHtml(
  raw: string,
  options?: {
    maleLeadName?: string | null;
    /**
     * Quando o `raw` é só Parte 2 (sem o header `# PARTE 2` no início, caso do
     * `CopyPartButton` exportando "Parte 2"), passar `forceParte2: true` pra
     * aplicar o destaque do MMC desde o começo. Default `false`: o walker
     * espera ver `# PARTE 2` antes de habilitar o destaque, garantindo que
     * trechos da Parte 1 (ex.: cliffhanger MMC da máfia) não sejam pintados.
     */
    forceParte2?: boolean;
    /**
     * Capítulos estruturados do roteiro (de `outputs.escrita.metadata.chapters`),
     * em ORDEM. Quando fornecido, o walker usa `chapter.part === "Parte 2"`
     * como fonte da verdade pra alternar `inParte2` ao entrar em cada `## Capítulo`,
     * em vez de depender só do header `# PARTE 2` no texto cru. Garante que
     * a coloração verde do MMC na Parte 2 sobreviva mesmo se o header de
     * Parte for apagado por uma reescrita ou edição.
     */
    chapters?: EscritaChapter[];
  },
): string {
  const out: string[] = [];
  let inCodeBlock = false;
  let paraBuffer: string[] = [];
  let currentPov: string | null = null;
  let inParte2 = options?.forceParte2 === true;

  const maleLeadName =
    options?.maleLeadName === undefined
      ? detectMaleLeadFromFullRoteiro(raw)
      : options.maleLeadName;
  const maleLeadCanonical = maleLeadName ? nomeCanonico(maleLeadName) : null;
  // Primeiro token do nome do MMC pra match tolerante a "Saverio" vs
  // "Saverio Aldobrandini" — cobre o caso onde a Estrutura usa nome
  // completo e a Escrita usa só primeiro nome (ou vice-versa) no `### ✦`.
  const maleLeadFirstToken = maleLeadCanonical?.split(/\s+/)[0] ?? null;

  const chapters = options?.chapters;
  // Cursor que avança a cada `## Capítulo N — Título` encontrado no texto.
  // Aponta pro próximo chapter esperado em `chapters[]`. Quando o cap atual
  // está em "Parte 2", o walker liga `inParte2 = true` independente do
  // header `# PARTE 2` estar presente ou não.
  let chapterCursor = 0;

  const preprocessed = preprocessRoteiro(raw);

  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ").trim();
    if (text) {
      const inner = inlineFormat(text);
      const povFirstToken = currentPov?.split(/\s+/)[0] ?? null;
      const isMmcPov =
        inParte2 &&
        maleLeadCanonical !== null &&
        currentPov !== null &&
        (currentPov === maleLeadCanonical ||
          (povFirstToken !== null &&
            maleLeadFirstToken !== null &&
            povFirstToken === maleLeadFirstToken));
      const content = isMmcPov
        ? `<span style="${STYLE_HIGHLIGHT_MMC}">${inner}</span>`
        : inner;
      out.push(`<p style="${STYLE_PARA}">${content}</p>`);
    }
    paraBuffer = [];
  };

  for (const rawLine of preprocessed.split("\n")) {
    const line = rawLine.trimEnd();

    if (line.startsWith("```")) {
      flushPara();
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        out.push(
          '<pre style="background: #f4f4f4; padding: 8px; border-radius: 4px; font-family: Consolas, monospace; font-size: 10pt; white-space: pre-wrap;">',
        );
      } else {
        out.push("</pre>");
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escapeHtml(line));
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    if (isWordCountLine(line)) {
      flushPara();
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h3 = line.match(/^###\s+(.+)$/);

    if (h3) {
      // POV markers (### ✦ Nome) viram <h3> estilizado — preserva o ✦ no
      // roteiro final e, ao colar no Google Docs, vira Heading 3 (aparece
      // na barra de navegação).
      flushPara();
      currentPov = nomeCanonico(h3[1]);
      out.push(`<h3 style="${STYLE_POV_HEADING}">${escapeHtml(h3[1])}</h3>`);
      continue;
    }
    if (h2) {
      // Capítulo — sai como <h2> pra virar Heading 2 no Google Docs e aninhar
      // embaixo da PARTE (h1) na árvore de Guias / Estrutura do documento.
      flushPara();
      currentPov = null;
      // Quando `chapters[]` é fornecido, usa o `chapter.part` desse cap como
      // fonte da verdade pra `inParte2`. Sobrevive a roteiros que perderam
      // o header `# PARTE 2` por uma reescrita/edição.
      if (chapters && chapterCursor < chapters.length) {
        const cap = chapters[chapterCursor]!;
        if (cap.part === "Parte 2") inParte2 = true;
        else if (cap.part === "Parte 1") inParte2 = false;
        chapterCursor++;
      }
      // Safety net: remove a anotação `(~X palavras — ritmo Y)` que possa ter
      // sobrado no cabeçalho (ex.: roteiro editado à mão cujo content não
      // passou pelo heal de storage).
      const chapterTitle = stripChapterTitleAnnotation(h2[1]);
      out.push(`<h2 style="${STYLE_H_CHAPTER}">${escapeHtml(chapterTitle)}</h2>`);
      continue;
    }
    if (h1) {
      // Separador de PARTE — sai como <h1> pra virar Heading 1 no Google Docs
      // (raiz da árvore de Guias). Mantém centralizado via style inline e
      // adiciona page-break antes da PARTE 2+.
      flushPara();
      currentPov = null;
      const partLabel = h1[1].trim().toUpperCase();
      if (/^PARTE\s+2\b/.test(partLabel)) {
        inParte2 = true;
      } else if (/^PARTE\s+1\b/.test(partLabel)) {
        inParte2 = false;
      }
      const isFirstPart = !out.some((s) => /class="part-divider"/.test(s));
      const breakStyle = isFirstPart ? "" : "; page-break-before: always";
      out.push(
        `<h1 class="part-divider" style="${STYLE_PART_DIVIDER}${breakStyle}">${escapeHtml(h1[1])}</h1>`,
      );
      continue;
    }

    // Lista de bullet (raro no roteiro, mas suporta).
    const bullet = line.match(/^[-•*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      out.push(
        `<p style="margin: 4px 0 4px 16px;">• ${inlineFormat(bullet[1])}</p>`,
      );
      continue;
    }

    // Tarja decorativa solta (separador discreto).
    if (/^[═━─]{5,}/.test(line.trim())) {
      flushPara();
      out.push(`<hr style="${STYLE_HR}">`);
      continue;
    }

    paraBuffer.push(line);
  }
  flushPara();
  return out.join("\n");
}

/**
 * Documento HTML completo pronto pra clipboard, download .html ou geração de PDF.
 */
export function buildEscritaHtmlDocument(
  title: string,
  bodyHtml: string,
): string {
  // Sem <title>: quando o HTML é colado no Google Docs, o Docs usa o <title>
  // como cabeçalho de página, deixando o nome do roteiro vazado pro topo do doc
  // ("Novo roteiro — 28/04/2026, 10:34:45"). Omitir resolve.
  void title;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 22mm 18mm 22mm; }
  body { ${STYLE_BODY} margin: 0; padding: 0; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Divide o conteúdo cru da Escrita em Parte 1 e Parte 2, já tirando os marcadores
 * `# PARTE 1` / `# PARTE 2` (eles viram nome de aba no Docs, não vão no body).
 *
 * Retorna { parte1, parte2 } como strings cruas (markdown), prontas pra passar
 * pelo `escritaContentToHtml`. Se a Parte 2 não existir (roteiro só com P1),
 * `parte2` vem como string vazia.
 */
export function splitRoteiroByParts(
  raw: string,
): { parte1: string; parte2: string } {
  // Normaliza banners legados primeiro (mesmo que escritaContentToHtml faz).
  const normalized = raw
    .replace(
      /═{3,}\s*\n\s*(PARTE 1|PARTE 2)\s*\n\s*═{3,}/g,
      (_m, label) => `# ${label}`,
    )
    .replace(/═{3,}\s*\n\s*ROTEIRO\s*\n\s*═{3,}/g, "");

  const parte2Match = normalized.match(/^#\s+PARTE 2\s*$/m);

  if (!parte2Match || parte2Match.index === undefined) {
    // Roteiro só com Parte 1 (ou sem marcador): tudo vai pra parte1.
    const parte1Only = normalized.replace(/^#\s+PARTE 1\s*\n?/m, "").trim();
    return { parte1: parte1Only, parte2: "" };
  }

  const parte1Raw = normalized.slice(0, parte2Match.index);
  const parte2Raw = normalized.slice(parte2Match.index + parte2Match[0].length);

  return {
    parte1: parte1Raw.replace(/^#\s+PARTE 1\s*\n?/m, "").trim(),
    parte2: parte2Raw.trim(),
  };
}

function inlineFormat(text: string): string {
  let escaped = escapeHtml(text);
  // Tira pares de ** sem renderizar negrito. Prosa de romance não usa negrito
  // no corpo; quando aparece ** é ruído (o Revisor, ao chamar /api/escrita-fix-
  // wordcount, às vezes recebe do Opus trechos envolvidos em **). Stripar aqui
  // garante export limpo independente do que a IA tenha gerado.
  escaped = escaped.replace(/\*\*/g, "");
  escaped = escaped.replace(/\*(.+?)\*/g, "<em>$1</em>");
  escaped = escaped.replace(/`(.+?)`/g, "<code>$1</code>");
  return escaped;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
