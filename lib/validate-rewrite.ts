/**
 * Valida que uma reescrita de capítulo retornada pelo Claude é narrativa
 * legítima — não eco da instrução do usuário, não output truncado, não
 * mini-output em vez de capítulo expandido.
 *
 * Existe porque o Opus, ocasionalmente, ecoa o `sugestao` ou o briefing
 * do prompt como se fosse o conteúdo do capítulo. O parser de capítulos
 * (`parseRevisedChapters` / `parseEscritaChaptersDirect`) é tolerante por
 * design — ele só procura header `## Capítulo N` e pega tudo entre headers
 * como corpo, sem checar se o corpo "parece" texto narrativo. Resultado:
 * a instrução vira o capítulo no localStorage e o usuário vê o briefing
 * dele como se fosse o roteiro.
 *
 * Defesa em três camadas — qualquer uma falhar invalida a reescrita:
 *   1. echo: Claude copiou o triggerText quase literalmente nos primeiros
 *      30% do output. Compara janela contígua de palavras normalizadas.
 *   2. too-short / too-long: contagem de palavras sai de 50%-200% do alvo.
 *   3. instruction-prefix: começo do conteúdo casa padrão "Verbo imperativo
 *      ... (a) ... (b) ..." ou marcadores típicos de briefing.
 *
 * Sempre que falha → o caller mantém o capítulo original. Não há "fix
 * automático" aqui — a única saída segura é não substituir.
 */

import { countWords } from "./word-count";

export type RewriteValidationReason =
  | "echo"
  | "too-short"
  | "too-long"
  | "instruction-prefix"
  | "marker-stripped";

export interface RewriteValidationInput {
  newContent: string;
  originalContent: string;
  /** Texto da instrução/sugestão que disparou a reescrita (pra detectar eco). */
  triggerText?: string;
  /** Alvo declarado em palavras (fix-wordcount). Se omitido, usa countWords(originalContent). */
  targetWords?: number;
}

export interface RewriteValidationResult {
  ok: boolean;
  reason?: RewriteValidationReason;
  /** Mensagem curta legível pra log + UI. */
  message?: string;
}

const MIN_RATIO = 0.5;
const MAX_RATIO = 2.0;
/** Limite de cobertura do triggerText no início do newContent que conta como eco. */
const ECHO_COVERAGE_THRESHOLD = 0.8;
/** Janela do começo do conteúdo onde o eco é checado (30%). */
const ECHO_PREFIX_RATIO = 0.3;
/** Trigger texts curtos demais não dão sinal estatístico — pula a detecção. */
const ECHO_MIN_TRIGGER_WORDS = 8;
/** Conteúdos curtos não devem ser checados (capítulos legítimos têm dezenas). */
const ECHO_MIN_CONTENT_WORDS = 30;

/**
 * Detecta padrões claros de briefing/instrução nos primeiros caracteres.
 * Conservador por design: exige verbo imperativo + marcadores típicos
 * de briefing (`(a)`, "aproximadamente N palavras", "conforme") pra evitar
 * falsos-positivos em narrativas que começam com "Expandir o peito" etc.
 */
const INSTRUCTION_PREFIX_RE =
  /^\s*(?:Expandir|Encurtar|Adicionar|Remover|Reescrever|Incluir|Aplicar|Corrigir|Mudar|Substituir|Alterar|Trocar|Ajustar|Refazer)\b[^\n]{0,400}?(?:\([a-z]\)|aproximadamente\s+\d|conforme\s+(?:cravado|a\s+estrutura|o\s+aprovado))/i;

// Marcadores que o export-html.ts depende pra calcular coloração verde da
// voz masculina na Parte 2. Apagá-los no reescrita quebra o destaque no PDF
// final — `### ✦ Nome` deixa o parágrafo sem POV detectado, `# PARTE N`
// faz o walker perder o boundary de Parte. Aceita ✦/♦/◆ porque o LLM
// alterna entre eles (mesmo conjunto que POV_SYMBOL_CLASS em export-html.ts).
const POV_MARKER_RE = /^###\s+[✦♦◆]/gm;
const PART_MARKER_RE = /^#\s+PARTE\s+[12]\b/gim;

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mede que fração das palavras do trigger aparece (em ordem, com gaps
 * pequenos) na janela inicial do newContent. Retorna 0..1.
 */
function echoCoverage(triggerWords: string[], windowText: string): number {
  if (triggerWords.length === 0) return 0;
  const windowWords = windowText.split(" ").filter(Boolean);
  if (windowWords.length === 0) return 0;

  // Procura a maior subsequência contígua do trigger que aparece como
  // bloco contíguo na janela. Implementação O(n*m) suficiente pra
  // triggers de até ~200 palavras.
  let bestRun = 0;
  for (let i = 0; i < windowWords.length; i++) {
    let run = 0;
    while (
      i + run < windowWords.length &&
      run < triggerWords.length &&
      windowWords[i + run] === triggerWords[run]
    ) {
      run++;
    }
    if (run > bestRun) bestRun = run;
  }
  return bestRun / triggerWords.length;
}

export function validateRewrite(
  input: RewriteValidationInput,
): RewriteValidationResult {
  const newContent = input.newContent ?? "";
  const trimmed = newContent.trim();

  if (INSTRUCTION_PREFIX_RE.test(trimmed)) {
    return {
      ok: false,
      reason: "instruction-prefix",
      message:
        "A IA respondeu com o briefing da instrução em vez do capítulo reescrito.",
    };
  }

  const newWords = countWords(newContent);
  const baseline =
    input.targetWords ?? countWords(input.originalContent ?? "");

  if (baseline > 0) {
    if (newWords < Math.max(30, Math.floor(baseline * MIN_RATIO))) {
      return {
        ok: false,
        reason: "too-short",
        message: `A IA devolveu ${newWords} palavras (esperado ~${baseline}). Provavelmente truncou.`,
      };
    }
    if (newWords > Math.ceil(baseline * MAX_RATIO)) {
      return {
        ok: false,
        reason: "too-long",
        message: `A IA devolveu ${newWords} palavras (esperado ~${baseline}). Provavelmente repetiu o capítulo.`,
      };
    }
  }

  if (input.triggerText && input.triggerText.trim()) {
    const normalizedTrigger = normalizeForCompare(input.triggerText);
    const triggerWords = normalizedTrigger.split(" ").filter(Boolean);
    if (
      triggerWords.length >= ECHO_MIN_TRIGGER_WORDS &&
      newWords >= ECHO_MIN_CONTENT_WORDS
    ) {
      const normalizedNew = normalizeForCompare(newContent);
      const allWords = normalizedNew.split(" ").filter(Boolean);
      const prefixLen = Math.max(
        triggerWords.length,
        Math.floor(allWords.length * ECHO_PREFIX_RATIO),
      );
      const prefix = allWords.slice(0, prefixLen).join(" ");
      const coverage = echoCoverage(triggerWords, prefix);
      if (coverage >= ECHO_COVERAGE_THRESHOLD) {
        return {
          ok: false,
          reason: "echo",
          message:
            "A IA repetiu a instrução literal no início do capítulo em vez de reescrevê-lo.",
        };
      }
    }
  }

  const originalContent = input.originalContent ?? "";
  const originalPovMarkers = originalContent.match(POV_MARKER_RE)?.length ?? 0;
  const newPovMarkers = newContent.match(POV_MARKER_RE)?.length ?? 0;
  const originalPartMarkers = originalContent.match(PART_MARKER_RE)?.length ?? 0;
  const newPartMarkers = newContent.match(PART_MARKER_RE)?.length ?? 0;
  if (
    newPovMarkers < originalPovMarkers ||
    newPartMarkers < originalPartMarkers
  ) {
    return {
      ok: false,
      reason: "marker-stripped",
      message:
        "A reescrita apagou marcadores de POV/Parte (### ✦ Nome ou # PARTE N). Esses markers são necessários pra coloração do PDF — texto original mantido.",
    };
  }

  return { ok: true };
}
