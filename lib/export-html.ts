import type { EscritaChapter } from "@/types/roteiro";
import { countWords } from "./word-count.ts";
import { stripChapterTitleAnnotation } from "./strip-chapter-annotations.ts";
import {
  isWordCountLine,
  stripEscritaContamination,
} from "./sanitize-escrita-content.ts";

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

/**
 * Casa o POV atual com o nome canônico de um protagonista (MMC ou FMC), por
 * nome completo OU por primeiro token — tolera "Saverio" vs "Saverio
 * Aldobrandini" (Estrutura usa nome completo, Escrita usa só o primeiro no
 * `### ✦`, ou vice-versa). `false` se qualquer lado for null.
 */
function matchesLead(
  povCanonical: string | null,
  povFirstToken: string | null,
  leadCanonical: string | null,
  leadFirstToken: string | null,
): boolean {
  if (povCanonical === null || leadCanonical === null) return false;
  if (povCanonical === leadCanonical) return true;
  return (
    povFirstToken !== null &&
    leadFirstToken !== null &&
    povFirstToken === leadFirstToken
  );
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
  // o `^[ \t]*` por causa do `#`). O `\*{0,2}` aparece DOS DOIS LADOS do nome
  // pra cobrir `✦ **SALVATORE**` (negrito só no nome) — sem o lado de dentro,
  // esse marcador NÃO era reconhecido, o trecho do MMC virava prosa sem POV
  // (sem verde) e o rótulo do POV feminino vazava pra cima da fala dele.
  preprocessed = preprocessed.replace(
    new RegExp(
      `^[ \\t]*\\*{0,2}${POV_SYMBOL_CLASS}[ \\t]+\\*{0,2}([^\\n*]+?)\\*{0,2}[ \\t]*$`,
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
 * Valida/normaliza um valor cru de "nome" extraído da Estrutura. Rejeita
 * avisos/disclaimers do LLM (⚠️, "ATENÇÃO", "(a definir)", "sem nome", etc.) e
 * retorna só o PRIMEIRO token nome-like (capitalizado). Módulo-level porque é
 * compartilhado pela extração do MMC e da FMC.
 */
function isPlausibleName(raw: string): string | null {
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
    .split(/[\s,;()"'—\-]+/)
    .find((t) => /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]+$/.test(t));
  if (firstToken) return firstToken;
  // Fallback: primeiro token simples (já passou validação básica).
  const fallback = cleaned.split(/\s+/)[0];
  return /^[A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç]/.test(fallback) ? fallback : null;
}

/**
 * Extrai o PRIMEIRO NOME do protagonista (MMC ou FMC) do output da Estrutura.
 *
 * Category-agnostic: ancora pela TAG `(MMC)`/`(FMC)` em qualquer linha de
 * cabeçalho — cobre `PROTAGONISTA MASCULINO (MMC)` (milionário/máfia),
 * `ALPHA KING (MMC)` / `HEROÍNA (FMC)` (alpha-king), com `#`/emoji opcionais.
 *
 * Dois formatos de nome:
 *   1. INLINE no cabeçalho — `👤 ALPHA KING (MMC) — Cael Ashford; 34…` →
 *      pega o nome logo após a tag (separador — / - / : / ;).
 *   2. LINHA `Nome:` própria abaixo do cabeçalho — `Nome: Saverio Aldobrandini`
 *      (com bullet/negrito opcional; prioriza "Nome corrigido"/"Nome real"
 *      sobre um primeiro `Nome:` que contenha aviso ⚠️).
 *
 * Fonte CONFIÁVEL — não depende de heurística de palavras (que inverte quando
 * o trecho do MMC é longo). Retorna só o PRIMEIRO nome (é assim que `✦ NOME`
 * aparece na Escrita). `null` se a estrutura não foi gerada/é inparseável.
 */
function extractLeadName(
  estruturaContent: string | undefined | null,
  tag: "MMC" | "FMC",
): string | null {
  if (!estruturaContent) return null;

  // Cabeçalho da seção: QUALQUER linha que contenha "(MMC)"/"(FMC)". Captura o
  // que vem ANTES (group 1) e DEPOIS (group 2) da tag na mesma linha.
  const headerRe = new RegExp(`^([^\\n]*?)\\(${tag}\\)([^\\n]*)$`, "im");
  const headerMatch = estruturaContent.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;

  // 1) Nome inline DEPOIS da tag (formato alpha-king: "HEROÍNA (FMC) — Sieva").
  //    O texto após a tag começa com um separador (— / - / : / ;) + o nome.
  const inlineRaw = headerMatch[2].replace(/^[\s—\-:;]+/, "").trim();
  const inlineName = isPlausibleName(inlineRaw);
  if (inlineName) return inlineName;

  // 2) Senão, varre linhas "Nome:" na SEÇÃO — do header até a próxima seção em
  //    caixa alta (ex.: "PROTAGONISTA FEMININA", "ANTAGONISTA") ou fim. Limita
  //    a 2000 chars pra não pegar a estrutura toda. Tolerante a markdown
  //    header (`##`/`#`) e bullets emoji antes do próximo título.
  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = estruturaContent.slice(sectionStart, sectionStart + 2000);
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

  // Prioridade: último candidato plausível (correções vêm DEPOIS do original
  // — "Nome corrigido", "Nome real" etc. ficam abaixo de "Nome").
  for (let i = candidates.length - 1; i >= 0; i--) {
    const name = isPlausibleName(candidates[i]);
    if (name) return name;
  }

  // 3) ÚLTIMO recurso: nome ANTES da tag na mesma linha (formato
  //    "**Helena (FMC)**" em tabelas/linhas de narração, onde o nome PRECEDE
  //    o tag e não há linha "Nome:"). Pega o ÚLTIMO token nome-próprio
  //    (Maiúscula + minúsculas) — assim NÃO captura rótulos em CAIXA ALTA
  //    ("PROTAGONISTA FEMININA", "HEROÍNA"), que cairiam no Nome: acima.
  const beforeTokens = headerMatch[1].match(
    /[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+/g,
  );
  if (beforeTokens && beforeTokens.length) {
    const beforeName = isPlausibleName(beforeTokens[beforeTokens.length - 1]);
    if (beforeName) return beforeName;
  }
  return null;
}

/**
 * Extrai o PRIMEIRO NOME do MMC (protagonista masculino) da Estrutura.
 * Ver `extractLeadName`. Fonte primária pro destaque verde do POV masculino.
 */
export function extractMaleLeadNameFromEstrutura(
  estruturaContent: string | undefined | null,
): string | null {
  return extractLeadName(estruturaContent, "MMC");
}

/**
 * Extrai o PRIMEIRO NOME da FMC (protagonista feminina/heroína) da Estrutura.
 * Usado como GUARDA: o POV da FMC nunca recebe o destaque verde na Parte 2.
 */
export function extractFemaleLeadNameFromEstrutura(
  estruturaContent: string | undefined | null,
): string | null {
  return extractLeadName(estruturaContent, "FMC");
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
     * Nome da FMC (heroína), tipicamente vindo de
     * `extractFemaleLeadNameFromEstrutura`. GUARDA DURA: o POV da FMC NUNCA
     * recebe o destaque verde na Parte 2. Além disso, quando conhecido, faz o
     * walker pintar todo POV nomeado da Parte 2 que NÃO seja a FMC (tudo que
     * não é a heroína na P2 é o MMC) — robusto mesmo se o nome do MMC falhar.
     * Sem fallback heurístico: se não vier da Estrutura, fica `null` e o
     * destaque recai só sobre o `maleLeadName` (comportamento legado).
     */
    femaleLeadName?: string | null;
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
  // Última linha de defesa: nenhum PDF/HTML/paste-no-Docs pode carregar
  // contagem de palavras nem o relatório do Revisor, mesmo que um roteiro
  // tenha escapado do heal de storage. Idempotente (no-op pra texto limpo).
  raw = stripEscritaContamination(raw);
  const out: string[] = [];
  let inCodeBlock = false;
  let paraBuffer: string[] = [];
  let currentPov: string | null = null;
  // Já emitimos o rótulo "✦ NOME" do POV feminino implícito no trecho atual?
  // (Ver flushPara — rótulo da heroína na Parte 2 quando ela narra sem ✦.)
  let fmcSectionLabeled = false;
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

  // FMC (heroína) — SEM auto-detecção heurística: só vale o nome explícito da
  // Estrutura. Usado como guarda (a FMC nunca fica verde) e pra pintar todo
  // POV não-FMC da Parte 2 como MMC.
  const femaleLeadName = options?.femaleLeadName ?? null;
  const femaleLeadCanonical = femaleLeadName ? nomeCanonico(femaleLeadName) : null;
  const femaleLeadFirstToken = femaleLeadCanonical?.split(/\s+/)[0] ?? null;

  const chapters = options?.chapters;
  // Cursor que avança a cada `## Capítulo N — Título` encontrado no texto.
  // Aponta pro próximo chapter esperado em `chapters[]`. Quando o cap atual
  // está em "Parte 2", o walker liga `inParte2 = true` independente do
  // header `# PARTE 2` estar presente ou não.
  let chapterCursor = 0;

  const preprocessed = preprocessRoteiro(raw);
  // Há alternância de POV no roteiro? (algum marcador ✦ NOME nomeado, já
  // normalizado pra `### ✦ NOME`). O rótulo do POV feminino implícito (heroína
  // sem ✦ na Parte 2) só liga quando há alternância — senão (milionário-3p,
  // todo FMC sem ✦) os rótulos seriam ruído.
  const hasNamedPov = new RegExp(`^###\\s+${POV_SYMBOL_CLASS}`, "m").test(
    preprocessed,
  );

  // Renderiza um cabeçalho de capítulo (<h2> = Heading 2 no Docs). Compartilhado
  // pelo formato novo `## Capítulo` e pelo legado `# Capítulo` (alpha-king e
  // roteiros antigos emitem capítulo com UM `#` só — ver detecção no branch h1).
  const emitChapter = (titleRaw: string) => {
    flushPara();
    currentPov = null;
    fmcSectionLabeled = false;
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
    const chapterTitle = stripChapterTitleAnnotation(titleRaw);
    out.push(`<h2 style="${STYLE_H_CHAPTER}">${escapeHtml(chapterTitle)}</h2>`);
  };

  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ").trim();
    if (text) {
      const inner = inlineFormat(text);
      const povFirstToken = currentPov?.split(/\s+/)[0] ?? null;
      const matchesFmc = matchesLead(
        currentPov,
        povFirstToken,
        femaleLeadCanonical,
        femaleLeadFirstToken,
      );
      const matchesMmc = matchesLead(
        currentPov,
        povFirstToken,
        maleLeadCanonical,
        maleLeadFirstToken,
      );
      // Destaque verde = POV MASCULINO (MMC) na Parte 2, travado:
      //  • TRAVA: o POV da FMC (heroína) NUNCA é pintado.
      //  • senão pinta se casa com o MMC, OU — quando sabemos quem é a FMC
      //    (nome veio da Estrutura) — se é um POV nomeado da P2 que não é a
      //    FMC (tudo que não é a heroína na P2 é o MMC, mesmo se o nome do MMC
      //    não foi detectado).
      //  • sem nenhum sinal de FMC/MMC: só casa com o MMC (legado).
      const isMmcPov =
        inParte2 &&
        currentPov !== null &&
        !matchesFmc &&
        (matchesMmc || femaleLeadCanonical !== null);
      const content = isMmcPov
        ? `<span style="${STYLE_HIGHLIGHT_MMC}">${inner}</span>`
        : inner;
      // Rótulo do POV FEMININO (heroína) na Parte 2: quando ela narra SEM
      // marcador ✦ (o modelo a trata como narradora-padrão), o trecho fica
      // sem identificação nenhuma no export. Emite um título "✦ NOME — POV
      // feminino" (mesmo formato do masculino, mas SEM verde) no começo de
      // cada trecho implícito dela (início do capítulo e quando o POV volta
      // dela depois de um trecho do MMC). Só liga com alternância de POV
      // (hasNamedPov) — não toca milionário-3p (todo FMC, sem ✦) nem a Parte
      // 1. O nome é OPCIONAL: sem ele (Estrutura quebrada / sem tag (FMC)), cai
      // pro rótulo genérico "✦ POV feminino" — o trecho dela NUNCA fica sem
      // identificação. ⚠️ NUNCA pinta nada de verde — a FMC jamais fica verde.
      if (
        inParte2 &&
        currentPov === null &&
        hasNamedPov &&
        !fmcSectionLabeled
      ) {
        const fmcLabel = femaleLeadName
          ? `✦ ${escapeHtml(femaleLeadName)} — POV feminino`
          : "✦ POV feminino";
        out.push(`<h3 style="${STYLE_POV_HEADING}">${fmcLabel}</h3>`);
        fmcSectionLabeled = true;
      }
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
      const povFirst = currentPov.split(/\s+/)[0];
      const headingMatchesFmc = matchesLead(
        currentPov,
        povFirst,
        femaleLeadCanonical,
        femaleLeadFirstToken,
      );
      const headingMatchesMmc = matchesLead(
        currentPov,
        povFirst,
        maleLeadCanonical,
        maleLeadFirstToken,
      );
      // Se este marcador É a FMC (heroína), ela já está rotulada por ele — não
      // re-rotular implicitamente depois. Se é outro POV (o MMC), ao voltar pra
      // prosa implícita da heroína, re-rotula com "✦ NOME — POV feminino".
      fmcSectionLabeled = headingMatchesFmc;
      // Etiqueta de papel na Parte 2 (sem verde aqui — o verde vai na PROSA do
      // MMC, não no cabeçalho): mesma lógica do destaque verde — POV feminino
      // se casa com a FMC; POV masculino se é o MMC OU (sabendo quem é a FMC)
      // qualquer POV nomeado da P2 que não seja ela. Fora da Parte 2, sem
      // etiqueta (a P1 não tem alternância a identificar).
      let roleTag = "";
      if (inParte2) {
        if (headingMatchesFmc) roleTag = " — POV feminino";
        else if (headingMatchesMmc || femaleLeadCanonical !== null)
          roleTag = " — POV masculino";
      }
      out.push(
        `<h3 style="${STYLE_POV_HEADING}">${escapeHtml(h3[1])}${roleTag}</h3>`,
      );
      continue;
    }
    if (h2) {
      // Capítulo — sai como <h2> pra virar Heading 2 no Google Docs e aninhar
      // embaixo da PARTE (h1) na árvore de Guias / Estrutura do documento.
      emitChapter(h2[1]);
      continue;
    }
    if (h1) {
      // Um `#` só pode ser PARTE (divisor) OU capítulo legado. Alguns prompts
      // (alpha-king) e roteiros antigos emitem `# Capítulo N — Título` com um
      // único `#`. Sem este desvio, o capítulo virava <h1> centralizado (cara
      // de PARTE) e ainda forçava page-break antes de cada cap. Só `PARTE 1/2`
      // é divisor de fato; "Capítulo …" segue o caminho do <h2>.
      const headingText = h1[1].trim();
      if (/^\*{0,2}\s*Cap[íi]tulo\b/i.test(headingText)) {
        emitChapter(headingText.replace(/^\*+|\*+$/g, "").trim());
        continue;
      }
      // Separador de PARTE — sai como <h1> pra virar Heading 1 no Google Docs
      // (raiz da árvore de Guias). Mantém centralizado via style inline e
      // adiciona page-break antes da PARTE 2+.
      flushPara();
      currentPov = null;
      fmcSectionLabeled = false;
      const partLabel = headingText.toUpperCase();
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

    // Separador de cena solto — tarja decorativa (═━─ ≥5), quebra temática
    // markdown (--- / *** / ___, ≥3) OU um marcador de POV SOZINHO (✦ / ♦ / ◆
    // numa linha só, sem nome, com negrito opcional). Vira <hr> E RESETA o POV.
    //
    // ⚠️ TRAVA DO DESTAQUE VERDE (POV MASCULINO) — não remover o reset:
    // na Parte 2 de alpha-king/máfia a HEROÍNA (FMC) narra SEM marcador ✦
    // (ela é a narradora-padrão; só os trechos do MMC levam ✦ NOME). Numa
    // troca de cena a prosa volta pra ela. Sem este reset, o POV do último
    // ✦ (o MMC) vazava pelo separador e pintava a cena da heroína de verde —
    // exatamente o bug recorrente ("tudo ficou verde / tirou o POV feminino").
    // O ✦ SOZINHO é o separador de cena que a máfia/alpha-king emitem entre um
    // trecho do MMC (✦ NOME) e o retorno à heroína — sem este caso, o ✦ ficava
    // como prosa e o POV do MMC vazava pra cena seguinte da FMC (bug do print
    // da Calla). O verde é do MMC e SÓ do MMC; a FMC nunca pode ficar verde.
    const sep = line.trim();
    if (
      /^[═━─]{5,}/.test(sep) ||
      /^(?:-{3,}|\*{3,}|_{3,})$/.test(sep) ||
      new RegExp(`^\\*{0,2}${POV_SYMBOL_CLASS}\\*{0,2}$`).test(sep)
    ) {
      flushPara();
      currentPov = null;
      out.push(`<hr style="${STYLE_HR}">`);
      continue;
    }

    paraBuffer.push(line);
  }
  flushPara();
  return out.join("\n");
}

/**
 * Versão TEXTO LIMPO do roteiro pro fallback do clipboard.
 *
 * O `CopyPartButton` escreve dois flavors no clipboard: `text/html` (rico, com
 * headings e o destaque verde do MMC) e `text/plain`. Quando o destino aceita
 * HTML (Google Docs, Word), o `text/html` ganha. Mas em ambientes onde o
 * `clipboard.write([ClipboardItem])` falha (cai no `writeText`) ou o usuário
 * cola como "somente texto", o que vai pro doc é o `text/plain`. Se esse plain
 * for o markdown CRU, a roteirista vê `# Capítulo 1`, `**`, contagens de
 * palavras e marcadores de PARTE no documento — a "formatação toda errada".
 *
 * Esta função entrega o mesmo conteúdo SEM ruído de markdown: cabeçalhos viram
 * linhas limpas (sem `#`, sem anotação de palavras), `**`/`*` somem, marcadores
 * de POV ficam como `✦ Nome`, linhas de contagem de palavras e divisores são
 * removidos. O destaque verde só existe no flavor HTML — texto puro não carrega
 * cor —, então isso é o melhor degradê possível pro caminho de fallback.
 */
export function escritaContentToPlainText(raw: string): string {
  // Mesma defesa do flavor HTML — o fallback text/plain também não pode
  // carregar contagem nem relatório do Revisor.
  raw = stripEscritaContamination(raw);
  const preprocessed = preprocessRoteiro(raw);
  const lines: string[] = [];

  for (const rawLine of preprocessed.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      // Colapsa múltiplas linhas em branco numa só.
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }

    if (isWordCountLine(line)) continue;

    // Divisor decorativo solto vira linha em branco.
    if (/^[═━─]{5,}/.test(line)) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      lines.push(h3[1].replace(/\*\*/g, "").trim());
      continue;
    }
    const headingText = line.match(/^#{1,2}\s+(.+)$/);
    if (headingText) {
      const text = headingText[1].replace(/\*\*/g, "").trim();
      // Pula o marcador de PARTE (vira nome de aba no Docs, não vai no corpo).
      if (/^PARTE\s+\d/i.test(text)) continue;
      lines.push(stripChapterTitleAnnotation(text));
      continue;
    }

    // Parágrafo de prosa — tira só os marcadores de ênfase markdown.
    lines.push(line.replace(/\*\*/g, "").replace(/\*(.+?)\*/g, "$1"));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
