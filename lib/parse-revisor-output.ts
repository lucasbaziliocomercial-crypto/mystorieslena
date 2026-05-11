import type { RevisorError, RevisorErrorGravity } from "@/types/roteiro";

/**
 * Parser do bloco <erros_detalhados> emitido pelo Revisor (Step 5).
 *
 * O system prompt do Revisor instrui a emitir, ao final da resposta, um
 * bloco XML-like contendo um <erro> por cada erro 🟡/🟠/🔴 listado em
 * "PRINCIPAIS ERROS". Esse parser extrai esses blocos e devolve um array
 * estruturado que a UI usa pra renderizar os cards de correção e fazer
 * find+replace no roteiro da Escrita.
 *
 * Pra ser tolerante a output meio bagunçado (modelo às vezes esquece tag
 * de fechamento, mistura espaços, etc), o parser usa regex permissiva e
 * só valida que os 3 blocos obrigatórios (trecho_original, trecho_corrigido,
 * por_que_alterado) estão presentes — ignora silenciosamente erros mal
 * formados em vez de quebrar a tela inteira.
 */

const GRAVITY_MAP: Record<string, RevisorErrorGravity> = {
  naointerfere: "naoInterfere",
  "nao interfere": "naoInterfere",
  "não interfere": "naoInterfere",
  naoInterfere: "naoInterfere",
  atencao: "atencao",
  atenção: "atencao",
  interfere: "interfere",
  gravissimo: "gravissimo",
  gravíssimo: "gravissimo",
};

function decode(s: string): string {
  return s.trim();
}

function getAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m?.[1];
}

function getInner(block: string, tagName: string): string | undefined {
  const re = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`,
    "i",
  );
  const m = re.exec(block);
  return m ? decode(m[1]!) : undefined;
}

/**
 * Remove o bloco <erros_detalhados>...</erros_detalhados> do conteúdo bruto,
 * devolvendo o texto principal "limpo" (markdown da revisão sem o XML).
 */
export function stripErrosDetalhados(content: string): string {
  return content
    .replace(/<erros_detalhados>[\s\S]*?(?:<\/erros_detalhados>|$)/i, "")
    .trim();
}

/**
 * Extrai array de RevisorError do output bruto do Revisor. Devolve
 * lista vazia se o bloco não foi emitido ou se nada parseou.
 *
 * `forcedPart` (opcional): quando o caller sabe que esses erros são de uma
 * Parte específica (porque vieram do step `revisor1` ou `revisor2`), passa
 * `1` ou `2` aqui — assim cada erro recebe `parte` certo mesmo se o XML
 * esquecer de emitir o atributo, e o `id` ganha prefixo `p1-`/`p2-` para
 * não colidir com erros do outro step (ambos numeram a partir de 1).
 * Sem `forcedPart`, comportamento legado: usa `parte=` do XML se houver.
 */
export function parseRevisorErrors(
  content: string,
  forcedPart?: 1 | 2,
): RevisorError[] {
  if (!content) return [];
  const idPrefix = forcedPart ? `p${forcedPart}-` : "";

  // 1) Localiza o bloco <erros_detalhados>...</erros_detalhados>. Se não
  //    encontrar fechamento, pega até o fim — modelo às vezes corta.
  const blockRe = /<erros_detalhados>([\s\S]*?)(?:<\/erros_detalhados>|$)/i;
  const blockMatch = blockRe.exec(content);
  if (!blockMatch) return [];
  const block = blockMatch[1] ?? "";

  // 2) Itera sobre cada <erro ...>...</erro>.
  const erroRe = /<erro\b([^>]*)>([\s\S]*?)<\/erro>/gi;
  const out: RevisorError[] = [];
  let m: RegExpExecArray | null;
  while ((m = erroRe.exec(block)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";

    const numero = getAttr(attrs, "numero");
    const gravidadeRaw = getAttr(attrs, "gravidade")?.toLowerCase();
    const titulo = getAttr(attrs, "titulo");
    const capituloRaw = getAttr(attrs, "capitulo");
    const parteRaw = getAttr(attrs, "parte");
    const gravidade = gravidadeRaw
      ? (GRAVITY_MAP[gravidadeRaw.replace(/_/g, "")] ??
        GRAVITY_MAP[gravidadeRaw] ??
        "interfere")
      : "interfere";

    const trechoOriginal = getInner(inner, "trecho_original");
    const trechoCorrigido = getInner(inner, "trecho_corrigido");
    const porqueAlterado = getInner(inner, "por_que_alterado");

    // Aceita erro mesmo sem trecho_original/trecho_corrigido — vira card
    // INFORMATIVO (sem botão "Aplicar"). Útil pra erros transversais como
    // discrepância entre premissa e roteiro, conteúdo AUSENTE (epílogo
    // faltando), ou problemas estruturais que requerem ação manual em vez
    // de substituição. Só skipa se NEM titulo NEM porque_alterado existem
    // (aí é mesmo erro malformado, sem informação útil).
    if (!trechoOriginal && !trechoCorrigido && !titulo && !porqueAlterado) {
      continue;
    }

    // forcedPart vence atributo do XML — o step ativo é a verdade.
    const parteNum = forcedPart ?? (parteRaw ? Number(parteRaw) : undefined);
    const parte =
      parteNum === 1 || parteNum === 2 ? (parteNum as 1 | 2) : undefined;

    const baseNumero = numero ?? String(out.length + 1);
    out.push({
      id: `${idPrefix}${baseNumero}`,
      numero: baseNumero,
      gravidade,
      capitulo: capituloRaw ? Number(capituloRaw) : undefined,
      ...(parte ? { parte } : {}),
      titulo: titulo ?? "Erro sem título",
      trechoOriginal: trechoOriginal ?? "",
      trechoCorrigido: trechoCorrigido ?? "",
      porqueAlterado: porqueAlterado ?? "",
    });
  }

  return out;
}

/**
 * Parser de defesa final: extrai a lista de erros DIRETO da seção
 * PRINCIPAIS ERROS do markdown da revisão, gerando cards informativos
 * pra erros que NÃO viraram <erro> no XML (nem no fallback).
 *
 * Cada item esperado: "🟢/🟡/🟠/🔴 Erro #N [grau] — descrição..."
 *
 * Os erros gerados aqui são SEMPRE informativos (trecho_original vazio) —
 * a UI mostra como cards "ação manual" sem botão de aplicar. Garante que
 * a roteirista vê TODOS os erros mesmo se o LLM falhou em emitir XML pra
 * todos.
 */
export function parseMarkdownErrorList(
  content: string,
  forcedPart?: 1 | 2,
): RevisorError[] {
  if (!content) return [];
  const idPrefix = forcedPart ? `p${forcedPart}-` : "";
  const principaisRe =
    /(?:^|\n)#+\s*[^\n]*PRINCIPAIS\s+ERROS[^\n]*\n([\s\S]*?)(?=\n#+\s|\n\s*<erros_detalhados|$)/i;
  const principaisMatch = principaisRe.exec(content);
  if (!principaisMatch) return [];
  const scope = principaisMatch[1] ?? "";

  // Cabeçalhos de erro variam de formato entre rodadas do modelo:
  //   "🔴 Erro #1 [Gravíssimo] — desc"           (spec do prompt)
  //   "Erro 1 🔴 [Interfere] — desc"             (model drift, sem #)
  //   "**Erro #3** 🟠 [Interfere] — desc"        (com markdown bold)
  //   "Erro 3a 🔴 [Gravíssimo] — desc"           (sufixo letra)
  // O regex aceita o emoji ANTES ou DEPOIS de "Erro N", # opcional, bold
  // opcional. `💀` cai no mesmo grupo gravissimo (categoria mafia).
  const headerRe =
    /(?:^|\n)\s*\*{0,2}\s*(🟢|🟡|🟠|🔴|💀)?\s*\*{0,2}\s*Erro\s*#?\s*(\d+[a-z]?)\s*\*{0,2}\s*(🟢|🟡|🟠|🔴|💀)?\s*\*{0,2}\s*(?:\[([^\]]+)\])?\s*[—–-]\s*/gi;

  const matches = Array.from(scope.matchAll(headerRe));
  if (matches.length === 0) return [];

  const out: RevisorError[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const emoji = m[1] ?? m[3] ?? "";
    const numero = (m[2] ?? "").toLowerCase();
    if (!numero) continue;

    const start = (m.index ?? 0) + m[0].length;
    const next = matches[i + 1];
    const end = next ? (next.index ?? scope.length) : scope.length;
    const description = scope.slice(start, end).trim().replace(/\s+/g, " ");
    if (!description) continue;

    const gravidade: RevisorErrorGravity =
      emoji === "🟢"
        ? "naoInterfere"
        : emoji === "🟡"
        ? "atencao"
        : emoji === "🟠"
        ? "interfere"
        : emoji === "🔴" || emoji === "💀"
        ? "gravissimo"
        : "atencao";

    // Título = primeira frase ou primeiros ~100 chars; resto = porqueAlterado.
    const sentenceMatch = /^([^.!?]+[.!?])\s*([\s\S]*)$/.exec(description);
    const titulo = sentenceMatch
      ? sentenceMatch[1]!.trim()
      : description.slice(0, 120).trim();
    const porqueAlterado = sentenceMatch
      ? sentenceMatch[2]!.trim()
      : description.length > 120
      ? description.slice(120).trim()
      : "";

    out.push({
      id: `${idPrefix}${numero}`,
      numero,
      gravidade,
      ...(forcedPart ? { parte: forcedPart } : {}),
      titulo,
      trechoOriginal: "",
      trechoCorrigido: "",
      porqueAlterado,
    });
  }

  return out;
}

/**
 * Conta quantos números de erro únicos (Erro #1, #2, #3a, etc.) o markdown
 * da revisão lista. Útil pra detectar mismatch entre o XML estruturado e a
 * lista do markdown — quando o modelo emite só alguns <erro> no XML mas
 * lista mais em PRINCIPAIS ERROS, dispara fallback pra completar.
 *
 * Limita o escopo à seção PRINCIPAIS ERROS quando detectável (entre o
 * heading "PRINCIPAIS ERROS" e o próximo heading ou tag <erros_detalhados>),
 * pra não contar referências cruzadas em SUGESTÕES, ANÁLISE LEITOR, etc.
 * Se a seção não for detectável, cai pro texto todo.
 */
export function countMarkdownErrorNumbers(content: string): number {
  if (!content) return 0;
  const principaisRe =
    /(?:^|\n)#+\s*[^\n]*PRINCIPAIS\s+ERROS[^\n]*\n([\s\S]*?)(?=\n#+\s|\n\s*<erros_detalhados|$)/i;
  const principaisMatch = principaisRe.exec(content);
  const scope = principaisMatch?.[1] ?? content;

  const matches = scope.matchAll(/Erro\s*#?\s*(\d+[a-z]?)\b/gi);
  const uniqueNumbers = new Set<string>();
  for (const m of matches) {
    uniqueNumbers.add(m[1]!.toLowerCase());
  }
  return uniqueNumbers.size;
}

/**
 * Tenta inferir se um erro está na Parte 1 ou Parte 2 do roteiro buscando
 * o trechoOriginal no conteúdo da Escrita e comparando a posição com o
 * banner "═══ PARTE 2 ═══" que separa as duas partes. Devolve undefined
 * se não conseguir localizar o trecho. Útil pra erros gerados antes do
 * agente passar a emitir o atributo parte explicitamente.
 */
export function inferPartFromContent(
  escritaContent: string,
  trechoOriginal: string,
): 1 | 2 | undefined {
  if (!escritaContent || !trechoOriginal) return undefined;
  const range = findTrechoInText(escritaContent, trechoOriginal);
  if (!range) return undefined;
  // Match tolerante a variações: "═══ PARTE 2 ═══", "PARTE 2", "## Parte 2".
  const parte2Re = /PARTE\s+2/i;
  const parte2Match = parte2Re.exec(escritaContent);
  if (!parte2Match) return 1; // Sem banner Parte 2 — tudo é Parte 1.
  return range.start < parte2Match.index ? 1 : 2;
}

/**
 * Hash leve do conteúdo da Escrita pra detectar edição posterior à revisão.
 * Não é cripto — só precisa mudar quando o texto muda. Inclui length +
 * primeiros e últimos 100 chars (cobre edições no meio também porque
 * length muda).
 */
export function hashEscritaContent(content: string): string {
  const len = content.length;
  const head = content.slice(0, 100);
  const tail = content.slice(-100);
  return `${len}:${head.length}:${tail.length}:${head}|${tail}`;
}

/** Retorna o emoji + label correspondente à gravidade. */
export function gravityLabel(g: RevisorErrorGravity): {
  emoji: string;
  label: string;
} {
  switch (g) {
    case "naoInterfere":
      return { emoji: "🟢", label: "Não interfere" };
    case "atencao":
      return { emoji: "🟡", label: "Atenção" };
    case "interfere":
      return { emoji: "🟠", label: "Interfere" };
    case "gravissimo":
      return { emoji: "🔴", label: "Gravíssimo" };
  }
}

/**
 * Normalização tolerante a variações tipográficas: aspas curvas → retas,
 * travessões equivalentes, runs de whitespace → 1 espaço. Devolve a string
 * normalizada + mapa de índice (cada posição na normalizada aponta pro
 * índice correspondente na original) pra permitir reconstituição.
 */
function normalizeForMatch(s: string): {
  norm: string;
  mapToOrig: number[];
} {
  const out: string[] = [];
  const map: number[] = [];
  let prevWasSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    let normalized: string;
    if (c === "“" || c === "”" || c === "«" || c === "»") {
      normalized = '"';
    } else if (
      c === "‘" ||
      c === "’" ||
      c === "′" ||
      c === "`"
    ) {
      normalized = "'";
    } else if (c === "–" || c === "—" || c === "−") {
      // En-dash, em-dash, minus → em-dash unificado.
      normalized = "—";
    } else if (/\s/.test(c)) {
      // Runs de whitespace viram um único espaço.
      if (prevWasSpace) continue;
      normalized = " ";
      prevWasSpace = true;
      out.push(normalized);
      map.push(i);
      continue;
    } else {
      normalized = c;
    }
    prevWasSpace = false;
    out.push(normalized);
    map.push(i);
  }
  return { norm: out.join(""), mapToOrig: map };
}

/**
 * Procura `needle` dentro de `haystack` tentando primeiro match literal e,
 * se falhar, match fuzzy (normalizando aspas curvas, travessões e
 * whitespace). Devolve {start, end} no texto ORIGINAL pra fazer slice
 * direto, ou null se nem assim achou.
 *
 * Exportado para reuso em `lib/parse-correction-patches.ts` — outros steps
 * (Estrutura 1, Estrutura 2, Revisor) usam o mesmo find+replace literal/
 * fuzzy pra aplicar correções pontuais ditadas pelo agente em refineMode.
 */
export function findTrechoInText(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  // Tentativa 1: literal.
  const literal = haystack.indexOf(needle);
  if (literal !== -1) {
    return { start: literal, end: literal + needle.length };
  }

  // Tentativa 2: fuzzy.
  const normHay = normalizeForMatch(haystack);
  const normNeedle = normalizeForMatch(needle);
  const fuzzy = normHay.norm.indexOf(normNeedle.norm);
  if (fuzzy === -1) return null;

  const normEnd = fuzzy + normNeedle.norm.length;
  // Mapeia: posição no normalizado → posição no original.
  const start = normHay.mapToOrig[fuzzy];
  if (start === undefined) return null;
  // O fim é a posição original do último char + 1. Se o último char no
  // normalizado é um " " (whitespace run colapsado), pegamos até o fim do
  // run no original.
  const lastNormIdx = normEnd - 1;
  const lastOrigIdx = normHay.mapToOrig[lastNormIdx];
  if (lastOrigIdx === undefined) return null;
  // Se a posição seguinte no original também é whitespace (parte do mesmo
  // run colapsado), avança até sair do run.
  let end = lastOrigIdx + 1;
  if (/\s/.test(haystack[lastOrigIdx]!)) {
    while (end < haystack.length && /\s/.test(haystack[end]!)) end++;
  }
  return { start, end };
}

/**
 * Serializa de volta um array de RevisorError pro formato XML
 * `<erros_detalhados><erro>...</erro>...</erros_detalhados>` que o agente
 * Revisor emite. Usado em refineMode pra reconstituir o output completo
 * antes de aplicar patches do agente — assim os patches podem mexer no
 * XML também (remover <erro>, atualizar <trechoCorrigido>, etc) e o
 * resultado fica reparseável por `parseRevisorErrors`.
 */
export function serializeRevisorErrors(errors: RevisorError[]): string {
  if (errors.length === 0) return "<erros_detalhados></erros_detalhados>";
  const blocks = errors.map((e) => {
    const fields: string[] = [];
    fields.push(`<numero>${e.numero}</numero>`);
    fields.push(`<gravidade>${e.gravidade}</gravidade>`);
    if (typeof e.parte === "number") fields.push(`<parte>${e.parte}</parte>`);
    if (typeof e.capitulo === "number")
      fields.push(`<capitulo>${e.capitulo}</capitulo>`);
    fields.push(`<titulo>${e.titulo}</titulo>`);
    fields.push(`<trechoOriginal>${e.trechoOriginal}</trechoOriginal>`);
    fields.push(`<trechoCorrigido>${e.trechoCorrigido}</trechoCorrigido>`);
    fields.push(`<porqueAlterado>${e.porqueAlterado}</porqueAlterado>`);
    return `<erro>\n${fields.join("\n")}\n</erro>`;
  });
  return `<erros_detalhados>\n${blocks.join("\n\n")}\n</erros_detalhados>`;
}

/**
 * Aplica uma lista de correções num texto-base (find+replace).
 * Tenta primeiro match literal; se o trecho não bate exatamente (aspas
 * curvas vs retas, travessão diferente, whitespace), tenta match fuzzy
 * normalizado. Devolve o texto novo + lista de IDs aplicados/falhados.
 *
 * Comportamento de N ocorrências: o `trecho_original` do Revisor é, em
 * tese, uma âncora única. Quando ele aparece >1 vez no texto, isso quase
 * sempre significa erro transversal (mesma frase/parágrafo repetida) e o
 * usuário espera que a correção pegue todas as instâncias. Por isso fazemos
 * substituição IDEMPOTENTE: trocamos TODAS as ocorrências do trecho pela
 * versão corrigida. Se o trecho realmente aparece em contextos não
 * relacionados, o Revisor errou ao escolher uma âncora curta demais — o
 * fix é trocar a âncora, não pular as outras instâncias.
 *
 * Falha um erro como `failed` se: trecho_original ausente, não encontrado
 * no texto, OU se trecho_original === trecho_corrigido (no-op silencioso).
 */
export function applyCorrections(
  baseText: string,
  errors: RevisorError[],
): { text: string; appliedIds: string[]; failedIds: string[] } {
  let text = baseText;
  const appliedIds: string[] = [];
  const failedIds: string[] = [];

  for (const err of errors) {
    const original = err.trechoOriginal;
    if (!original) {
      failedIds.push(err.id);
      continue;
    }
    // Guard contra Revisor emitir trecho_original === trecho_corrigido —
    // ia marcar applied=true sem mudar nada (caminho mais comum pro bug
    // "APLICADO mas texto idêntico").
    if (original === err.trechoCorrigido) {
      failedIds.push(err.id);
      continue;
    }

    // Loop até esgotar as ocorrências. Cada iteração re-procura a partir do
    // texto JÁ atualizado — evita match recursivo se a substituição contém
    // o trecho original (raro, mas seguro).
    let replacedAny = false;
    while (true) {
      const range = findTrechoInText(text, original);
      if (!range) break;
      text =
        text.slice(0, range.start) +
        err.trechoCorrigido +
        text.slice(range.end);
      replacedAny = true;
      // Se trecho_corrigido contém o trecho_original (caso de inserção
      // aditiva, ex: "X" → "X Y"), o while geraria loop infinito.
      // Detecta isso comparando o conteúdo resultante: se o ponto de
      // inserção avançou pelo menos um caractere, ok; senão, sai.
      if (err.trechoCorrigido.includes(original)) break;
    }
    if (replacedAny) {
      appliedIds.push(err.id);
    } else {
      failedIds.push(err.id);
    }
  }

  return { text, appliedIds, failedIds };
}
