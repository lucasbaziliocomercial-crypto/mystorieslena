import type {
  EvalSnapshot,
  RevisorError,
  RevisorErrorGravity,
  RevisorHateRisk,
  StepId,
} from "@/types/roteiro";

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
 * Remove tags do schema <erros_detalhados> que tenham sido capturadas DENTRO
 * de um campo de RevisorError (trecho_original / trecho_corrigido /
 * por_que_alterado) ou que tenham sido injetadas no roteiro final via
 * applyCorrections quando o LLM emitiu um trecho_corrigido mal-formado.
 *
 * Cenário do bug que motivou isso: o LLM ocasionalmente emite um <erro> em
 * que o `<trecho_corrigido>` contém, como texto, literalmente as tags do
 * próximo erro (ou tags de fechamento aninhadas). O parser captura essa
 * string como o conteúdo do campo e o find+replace literal injeta as tags
 * no roteiro — fica cravado "...</trecho_original> <trecho_corrigido>..."
 * no meio da narrativa do Step 4.
 *
 * O roteiro de Romance NUNCA contém XML legítimo, então qualquer ocorrência
 * dessas tags é cruft e some sem perda.
 *
 * `sanitizeXmlCruft`  — strip + normaliza whitespace (campos curtos).
 * `stripXmlCruft`     — só strip, preserva whitespace (textos longos como
 *                       o roteiro inteiro, onde colapsar `\n{3,}` quebraria
 *                       formatação intencional de cenas/parágrafos).
 */
const XML_CRUFT_RE =
  /<\/?(?:erros_detalhados|erro|trecho_original|trecho_corrigido|por_que_alterado)\b[^>]*>/gi;

export function hasXmlCruft(text: string): boolean {
  if (!text) return false;
  XML_CRUFT_RE.lastIndex = 0;
  return XML_CRUFT_RE.test(text);
}

export function stripXmlCruft(text: string): string {
  if (!text) return text;
  if (!hasXmlCruft(text)) return text;
  return text.replace(XML_CRUFT_RE, "");
}

export function sanitizeXmlCruft(text: string): string {
  if (!text) return text;
  if (!hasXmlCruft(text)) return text;
  return text
    .replace(XML_CRUFT_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Contaminação de CÂNONE que o Revisor às vezes vaza pra DENTRO de um
 * `trecho_corrigido` (e daí pra prosa via `applyCorrections`) ou ecoa no
 * relatório. A roteirista relatou "o cânone entrando no meio das correções"; o
 * prompt do Revisor já proíbe (`canone-rule.ts`), e isto é a defesa em
 * profundidade no código (mesmo padrão do XML cruft acima).
 *
 * DOIS níveis de agressividade — por causa do risco de FALSO-POSITIVO que apaga
 * prosa legítima da autora:
 *  • A TARJA "CÂNONE DE ENTIDADES" é inequívoca (romance jamais a contém) →
 *    segura até pra rodar sobre a PROSA inteira (heal de storage / export). Use
 *    `stripCanonBanner` / `hasCanonBanner` nesse caminho.
 *  • A CITAÇÃO inline ("conforme o cânone") é DELICADA: "o cânone" é substantivo
 *    legítimo ("o cânone bíblico", "segundo o cânone da Igreja"). Por isso a
 *    citação SÓ casa quando "cânone" é seguido IMEDIATAMENTE de pontuação/
 *    parêntese/fim (como uma citação meta termina) — NUNCA de uma palavra (que
 *    indicaria substantivo real) — e SÓ deve ser aplicada nos CARDS do Revisor
 *    (`trecho_corrigido`), via `stripCanonMeta`, JAMAIS varrendo a prosa inteira.
 */
const CANON_BANNER_RE =
  /[ \t]*[━—–-]*[ \t]*C[ÂA]NONE\s+DE\s+ENTIDADES\b[^\n]*/gi;
// Citação inline. O lookahead `(?=… )` exige que "cânone" termine em pontuação/
// fecha-parêntese/abre-parêntese/fim-de-linha — assim "conforme o cânone." e
// "alinhado com o CÂNONE (Helena, 32)" casam, mas "segundo o cânone budista" e
// "o cânone bíblico" (cânone = substantivo real, seguido de palavra) NÃO casam.
const CANON_CITATION_RE =
  /[ \t]*[,—–-]?[ \t]*(?:conforme|alinhad[oa][ \t]+(?:com|ao)|de[ \t]+acordo[ \t]+com|segundo)[ \t]+o[ \t]+c[âa]none\b(?=[ \t]*[.,;:!?)\]]|[ \t]*\(|[ \t]*$)(?:[ \t]*\([^)\n]*\))?/gi;

function reTest(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

/** Só a TARJA do bloco de cânone — SEGURA pra varrer a prosa (zero falso-positivo). */
export function hasCanonBanner(text: string): boolean {
  return !!text && reTest(CANON_BANNER_RE, text);
}

/** Remove só a tarja "CÂNONE DE ENTIDADES" (preserva prosa e quebras de linha). */
export function stripCanonBanner(text: string): string {
  if (!text || !hasCanonBanner(text)) return text;
  CANON_BANNER_RE.lastIndex = 0;
  return text.replace(CANON_BANNER_RE, "");
}

/** Tarja + citação inline (endurecida) — SÓ pros CARDS do Revisor, NÃO pra prosa. */
export function hasCanonMeta(text: string): boolean {
  return (
    !!text && (reTest(CANON_BANNER_RE, text) || reTest(CANON_CITATION_RE, text))
  );
}

/**
 * Remove contaminação de cânone (tarja + citação inline endurecida) preservando
 * as quebras de parágrafo. SÓ pros cards do Revisor (`trecho_corrigido`) — a
 * citação inline NÃO deve varrer a prosa inteira (risco de falso-positivo com
 * "o cânone" substantivo). Pro caminho da prosa use `stripCanonBanner`.
 */
export function stripCanonMeta(text: string): string {
  if (!text || !hasCanonMeta(text)) return text;
  CANON_BANNER_RE.lastIndex = 0;
  CANON_CITATION_RE.lastIndex = 0;
  return text
    .replace(CANON_BANNER_RE, "")
    .replace(CANON_CITATION_RE, "")
    .replace(/\([ \t]*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;!?])/g, "$1")
    .replace(/,[ \t]*,/g, ",");
}

/**
 * NOTA EDITORIAL do Revisor vazada pra DENTRO de um `trecho_corrigido` (e daí
 * pra prosa via `applyCorrections`). Quando o Revisor NÃO sabe o nome canônico
 * de um personagem (nome ausente do cânone), ele às vezes escreve uma INSTRUÇÃO
 * entre COLCHETES no lugar da prosa, ex.:
 *   "[NOME NÃO MENCIONE — substitua "Soren Malvorne" e todas as ocorrências de
 *    "Soren" pelo nome que a roteirista definir no cânone, ou adicione-o ao
 *    cânone de entidades antes de aplicar a correção automática.]"
 * Se isso entra na correção, o find+replace CRAVA o metadado na narrativa final
 * — exatamente a queixa "muito grave" da roteirista (bug recorrente da 1.0.88).
 * O prompt do Revisor (`canone-rule.ts`) JÁ proíbe e manda emitir erro
 * INFORMATIVO nesses casos; isto é a defesa em profundidade no código (mesmo
 * padrão do XML cruft / tarja de cânone acima).
 *
 * Detecção SEGURA (zero falso-positivo sobre prosa): um span entre colchetes
 * `[...]` QUE CONTÉM um marcador editorial inequívoco (roteirista / cânone /
 * "correção automática" / substitua / "ocorrências de" / "NOME NÃO MENCIONE").
 * Romance jamais usa `[...]` com essas palavras — diferente de "o cânone"
 * substantivo solto na prosa (que NÃO casa, por não estar entre colchetes nem
 * acompanhado desses verbos de instrução).
 *
 * Tratamento: nos CARDS do Revisor, um `trecho_corrigido` com nota editorial é
 * INAPLICÁVEL → o parser ZERA o campo (o card vira INFORMATIVO e a roteirista
 * decide; mesma receita do invariante "uma identidade = um nome"). Na PROSA
 * (heal de storage/export + última defesa do `applyCorrections`) a nota é
 * removida com `stripEditorialNote`.
 */
const EDITORIAL_NOTE_RE =
  /\[[^\]]*?(?:roteirista|c[âa]none|corre[çc][ãa]o\s+autom[áa]tica|substitu\w*|ocorr[êe]ncias?\s+de|nome\s+n[ãa]o\s+menc\w*)[^\]]*?\]/gi;

/** True se o texto contém uma nota editorial do Revisor entre colchetes. */
export function hasEditorialNote(text: string): boolean {
  return !!text && reTest(EDITORIAL_NOTE_RE, text);
}

/**
 * Remove notas editoriais entre colchetes preservando as quebras de linha da
 * prosa (só colapsa whitespace horizontal e conserta espaço antes de
 * pontuação — NÃO mexe em `\n`, pra não fundir parágrafos). Pro caminho da
 * PROSA (heal/export/última defesa). Nos CARDS, o parser ZERA o trecho_corrigido
 * em vez de chamar isto (correção inaplicável → informativa).
 */
export function stripEditorialNote(text: string): string {
  if (!text || !hasEditorialNote(text)) return text;
  EDITORIAL_NOTE_RE.lastIndex = 0;
  return text
    .replace(EDITORIAL_NOTE_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * NO-OP: trecho_corrigido é, na prática, IDÊNTICO ao trecho_original — a
 * "correção" não muda nada. Padrão do bug (12/06/2026): o Revisor cita um
 * parágrafo como âncora, repete-o INALTERADO no trecho_corrigido e descreve a
 * correção REAL só na prosa do por_que_alterado (ex.: começando com
 * "AVISO: substituir 'X' por 'Y'"). A engine de find+replace rejeita o par
 * (original === corrigido), MAS a UI classificava o card como "literal" e
 * mostrava um botão "Aplicar" fadado a falhar com "trecho não encontrado" —
 * mesmo o trecho EXISTINDO no roteiro (queixa da roteirista). Tratamento (mesma
 * receita do hasEditorialNote): zera o trecho_corrigido → card vira INFORMATIVO
 * (a roteirista lê o por_que_alterado/AVISO e decide, ou regenera a revisão).
 *
 * Normaliza só whitespace HORIZONTAL + zero-width e PRESERVA as quebras de
 * linha (uma correção que só RE-QUEBRA parágrafos — "a b" → "a\n\nb" — É mudança
 * real e NÃO é no-op). NÃO normaliza aspas/travessões: trocar « por " ou – por —
 * é correção legítima. INSERÇÕES (trecho_corrigido = âncora + texto novo) têm
 * conteúdo a mais, então nunca casam aqui.
 */
export function isNoOpCorrection(original: string, corrigido: string): boolean {
  if (!original || !corrigido) return false;
  const norm = (s: string) =>
    s
      .replace(/[​-‍﻿]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim();
  return norm(original) === norm(corrigido);
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

    const trechoOriginalRaw = getInner(inner, "trecho_original");
    const trechoCorrigidoRaw = getInner(inner, "trecho_corrigido");
    const porqueAlteradoRaw = getInner(inner, "por_que_alterado");

    // Defesa crítica: o LLM às vezes emite um trecho com tags do schema
    // capturadas como conteúdo (ex.: trecho_corrigido contendo a string
    // literal "</trecho_original> <trecho_corrigido>..."). Sem essa
    // sanitização, applyCorrections grava o XML cru dentro do roteiro
    // final da Escrita e a roteirista vê tags cravadas na narrativa.
    const trechoOriginal = trechoOriginalRaw
      ? stripEditorialNote(sanitizeXmlCruft(trechoOriginalRaw))
      : undefined;
    // trecho_corrigido com NOTA EDITORIAL do Revisor entre colchetes
    // ("[substitua X pelo nome do cânone…]", "[NOME NÃO MENCIONE…]") é
    // INAPLICÁVEL — aplicá-lo cravaria o metadado na prosa (queixa "muito grave"
    // da roteirista). Zera o campo → card INFORMATIVO (sem botão Aplicar; a
    // roteirista decide), com o motivo seguindo no por_que_alterado. Senão,
    // limpa cânone-meta + XML cruft como antes.
    const trechoCorrigidoClean = !trechoCorrigidoRaw
      ? undefined
      : hasEditorialNote(trechoCorrigidoRaw)
        ? ""
        : stripCanonMeta(sanitizeXmlCruft(trechoCorrigidoRaw));
    // NO-OP: trecho_corrigido idêntico ao trecho_original (depois de limpo) não
    // é correção aplicável — o Revisor citou a âncora, repetiu-a INALTERADA e
    // pôs a correção real só no por_que_alterado/AVISO. Zera → card INFORMATIVO
    // (mesma receita do hasEditorialNote): sem botão fadado a "trecho não
    // encontrado" num trecho que EXISTE no roteiro (bug 12/06/2026).
    const trechoCorrigido =
      trechoCorrigidoClean &&
      trechoOriginal &&
      isNoOpCorrection(trechoOriginal, trechoCorrigidoClean)
        ? ""
        : trechoCorrigidoClean;
    const porqueAlterado = porqueAlteradoRaw
      ? sanitizeXmlCruft(porqueAlteradoRaw)
      : undefined;

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
 * Extrai a Nota (0 a 10) do markdown do relatório do Revisor. O relatório enxuto
 * pede "NOTA FINAL (0 a 10) — …", e o modelo escreve de DUAS formas, ambas
 * suportadas:
 *   • com barra:  `**NOTA FINAL (0 a 10): 8/10**`, `Nota Final: 8,5/10`
 *   • SEM barra:  `🧨 NOTA FINAL: 7,8`  ← o modelo às vezes omite o "/10"
 *
 * O desafio é não confundir o engodo do RANGE "(0 a 10)" (texto da instrução)
 * com a nota. Duas passadas:
 *   Passo 1 (alta confiança): número seguido de "/10" — o "/10" já desambigua
 *     do "(0 a 10)" (que não tem barra). Pega a ÚLTIMA ocorrência (a NOTA FINAL
 *     fica perto do fim, longe de "x/10" solto na prosa).
 *   Passo 2 (fallback p/ "NOTA FINAL: 7,8" SEM barra): primeiro remove o range
 *     "(0 a 10)"/"(0-10)" do texto, depois ancora no cabeçalho específico
 *     "NOTA FINAL" (seguro contra "nota" solto na prosa) e pega o número logo
 *     em seguida, na mesma linha/curtíssima distância — sem vazar pra
 *     justificativa (que vem depois e cita "Cap 4"/nº de erros).
 *
 * Retorna null se não achar. Usado pelo banner de veredito + abas + eval,
 * computado no display — sem persistir nada no metadata.
 */
export function parseRevisorNota(content: string): number | null {
  if (!content) return null;

  const clamp = (raw: string): number | null => {
    const n = parseFloat(raw.replace(",", "."));
    return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
  };

  // Passo 1: número com "/10" (o "/10" pula o engodo "(0 a 10)"). Última ocorrência.
  let best: number | null = null;
  for (const m of content.matchAll(/nota\b[\s\S]{0,40}?(\d+(?:[.,]\d+)?)\s*\/\s*10/gi)) {
    const v = clamp(m[1]!);
    if (v !== null) best = v;
  }
  if (best !== null) return best;

  // Passo 2: "NOTA FINAL: 7,8" sem barra. Remove o RANGE "(0 a 10)" antes (senão
  // o "0" do range seria lido como nota), depois ancora no cabeçalho "NOTA FINAL"
  // e pega o número logo em seguida. O gap [^\n\d letras] só admite pontuação/
  // espaço/emoji (":", "—", "( )", "🧨") — NÃO letras nem newline: assim o número
  // tem que estar colado ao cabeçalho (ex.: "NOTA FINAL: 7,8") e nunca cai num
  // "Cap 4" da justificativa caso o modelo esqueça o valor da nota.
  const cleaned = content.replace(/0\s*(?:at[ée]|a|to|[-–—])\s*10/gi, " ");
  const m2 = /nota\s+final[^\n\dA-Za-zÀ-ÿ]{0,20}?(\d+(?:[.,]\d+)?)/i.exec(cleaned);
  return m2 ? clamp(m2[1]!) : null;
}

/**
 * Extrai o NÍVEL DE RISCO DE HATE (🟢 baixo / 🟡 médio / 🔴 alto) do relatório
 * do Revisor. Formato canônico (vem em TODA passada — completa e enxuta):
 *   `# 🎯 NÍVEL DE RISCO DE HATE`
 *   `🔴 ALTO — [justificativa]`
 *
 * Heurística: isola a seção do nível e pega o nível seguido de travessão/`:`
 * (o marcador da justificativa) — isso desambigua de um eventual eco do
 * template "🟢 BAIXO / 🟡 MÉDIO / 🔴 ALTO". Fallback por emoji se nenhum nível
 * justificado for achado. Retorna null se não detectar. Advisory (alimenta o
 * eval e o banner) — a roteirista sempre vê o relatório completo.
 */
export function parseRevisorHateRisk(content: string): RevisorHateRisk | null {
  if (!content) return null;
  const secRe = /N[IÍ]VEL\s+DE\s+RISCO\s+DE\s+HATE([\s\S]{0,400})/i;
  const sec = secRe.exec(content);
  const scope = sec?.[1] ?? content;

  // Nível seguido de — / – / - / : (o nível escolhido leva justificativa).
  const chosen = /(BAIXO|M[EÉ]DIO|ALTO)\s*[—–:-]/i.exec(scope);
  const word = (chosen?.[1] ?? "").toUpperCase();
  if (word.startsWith("ALT")) return "alto";
  if (word.startsWith("M")) return "medio";
  if (word.startsWith("BAI")) return "baixo";

  // Fallback por emoji (pessimista: 🔴 antes de 🟡 antes de 🟢).
  if (scope.includes("🔴")) return "alto";
  if (scope.includes("🟡")) return "medio";
  if (scope.includes("🟢")) return "baixo";
  return null;
}

/** Texto sentinela (erro/login) — não é um relatório real, não vira eval. */
function isSentinelReport(content: string): boolean {
  return !content.trim() || content.trim().startsWith("[");
}

/**
 * Constrói o eval de qualidade (sem `id`/`at` — adicionados pelo log append-only
 * em lib/eval-log.ts) a partir de um relatório de revisão + erros parseados.
 * Deriva 100% do que o Revisor já produziu — custo zero de cota. Retorna null
 * pra steps não-revisor ou relatórios sentinela (geração falhou).
 */
export function computeRevisorEval(
  step: StepId,
  content: string,
  errors: RevisorError[],
  escritaHash?: string,
): Omit<EvalSnapshot, "id" | "at"> | null {
  // Inline (sem importar isRevisorStep/partOfRevisorStep como VALOR) pra este
  // módulo manter só imports de TIPO de @/types/roteiro — assim os testes node
  // (--experimental-strip-types, que não resolve o alias `@/`) seguem rodando.
  if (step !== "revisor1" && step !== "revisor2") return null;
  if (isSentinelReport(content)) return null;

  const counts = { gravissimo: 0, interfere: 0, atencao: 0, naoInterfere: 0 };
  for (const e of errors) counts[e.gravidade] += 1;
  const nota = parseRevisorNota(content);

  return {
    step,
    parte: step === "revisor1" ? 1 : 2,
    nota,
    hateRisk: parseRevisorHateRisk(content),
    counts,
    errorTotal: errors.length,
    // Mesma regra do banner de veredito (decisão do usuário).
    canFinish: nota !== null && nota >= 8 && counts.gravissimo === 0,
    ...(escritaHash ? { escritaHash } : {}),
  };
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

/** Nº de parágrafos de um trecho (linha em branco = separador). */
function countParagraphs(s: string): number {
  return s.split(/\n[ \t]*\n/).filter((p) => p.trim().length > 0).length;
}

/**
 * A correção INSERE parágrafos novos (bloco de prosa) em vez de trocar texto
 * no lugar? Usado por `applyCorrections` pra decidir entre trocar TODAS as
 * ocorrências (substituição local — o erro transversal) e trocar só a
 * PRIMEIRA (inserção de bloco — replicá-la duplicaria prosa em pontos não
 * relacionados; bug "parágrafos duplicados depois da revisão", 21/07/2026).
 *
 * Alta precisão de propósito: só conta como inserção de bloco quando o
 * corrigido tem MAIS parágrafos que o original. Trocar uma frase por outra
 * frase (mesmo que bem maior), corrigir um nome repetido ou reescrever um
 * parágrafo inteiro continuam valendo pra todas as ocorrências, como antes.
 */
export function insertsParagraphs(original: string, corrigido: string): boolean {
  return countParagraphs(corrigido) > countParagraphs(original);
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
    // Defesa em profundidade contra XML cruft: mesmo que um erro antigo
    // tenha sido salvo no localStorage com tags do schema capturadas como
    // conteúdo (pré-fix do parseRevisorErrors), re-sanitiza antes do splice
    // pra GARANTIR que tags XML nunca entrem na narrativa final da Escrita.
    const original = sanitizeXmlCruft(err.trechoOriginal ?? "");
    const corrigido = stripCanonMeta(sanitizeXmlCruft(err.trechoCorrigido ?? ""));

    if (!original) {
      failedIds.push(err.id);
      continue;
    }
    // Defesa crítica contra metadado na prosa: um trecho_corrigido com NOTA
    // EDITORIAL do Revisor entre colchetes ("[substitua X pelo nome do cânone…]")
    // — card antigo salvo em 1.0.88, antes do parser zerar — CRAVARIA o metadado
    // na narrativa final. JAMAIS aplica. Checa o RAW (não o `corrigido` já
    // processado): a nota costuma conter "ao cânone de entidades", que o
    // stripCanonMeta acima removeria junto com o `]` de fechamento, escondendo a
    // nota do detector. Idem corrigido VAZIO: trocar o trecho por nada apagaria
    // a prosa (é card informativo, não correção).
    if (!corrigido || hasEditorialNote(err.trechoCorrigido ?? "")) {
      failedIds.push(err.id);
      continue;
    }
    // Guard contra Revisor emitir trecho_original === trecho_corrigido —
    // ia marcar applied=true sem mudar nada (caminho mais comum pro bug
    // "APLICADO mas texto idêntico").
    if (original === corrigido) {
      failedIds.push(err.id);
      continue;
    }

    // Loop até esgotar as ocorrências. Cada iteração re-procura a partir do
    // texto JÁ atualizado — evita match recursivo se a substituição contém
    // o trecho original (raro, mas seguro).
    //
    // ⚠️ EXCEÇÃO ANTI-DUPLICAÇÃO (bug "parágrafos duplicados depois da revisão",
    // 21/07/2026): a troca de TODAS as ocorrências só vale pra substituição
    // LOCAL (troca de palavra/frase — o erro transversal pra que ela foi feita).
    // Quando o `trecho_corrigido` ACRESCENTA parágrafos (inserção de bloco: o
    // Revisor pode emitir de 3 a 15 parágrafos num card), replicar isso em toda
    // ocorrência de uma âncora curta CRAVA o mesmo bloco de prosa em pontos não
    // relacionados do roteiro — foi o que a roteirista viu ao colar no Docs.
    // Nesse caso trocamos só a PRIMEIRA ocorrência: inserir um bloco novo em N
    // lugares nunca é a intenção do card. Ver `insertsParagraphs`.
    const blockInsertion = insertsParagraphs(original, corrigido);
    let replacedAny = false;
    while (true) {
      const range = findTrechoInText(text, original);
      if (!range) break;
      text = text.slice(0, range.start) + corrigido + text.slice(range.end);
      replacedAny = true;
      if (blockInsertion) break;
      // Se trecho_corrigido contém o trecho_original (caso de inserção
      // aditiva, ex: "X" → "X Y"), o while geraria loop infinito.
      // Detecta isso comparando o conteúdo resultante: se o ponto de
      // inserção avançou pelo menos um caractere, ok; senão, sai.
      if (corrigido.includes(original)) break;
    }
    if (replacedAny) {
      appliedIds.push(err.id);
    } else {
      failedIds.push(err.id);
    }
  }

  // Última linha de defesa: mesmo que TODAS as camadas anteriores tenham
  // falhado e algum trecho_corrigido tenha conseguido injetar tags do schema
  // (`<trecho_original>`, `</trecho_corrigido>`, etc.), a tarja "CÂNONE DE
  // ENTIDADES" ou uma NOTA EDITORIAL entre colchetes no texto, removemos antes
  // de devolver. Aqui `text` é a PROSA INTEIRA, então usamos só `stripCanonBanner`
  // (tarja inequívoca) — NÃO a citação inline, que sobre prosa daria falso-
  // positivo com "o cânone" substantivo. `stripEditorialNote` é seguro na prosa
  // (colchete + marcador editorial). ORDEM IMPORTA: stripEditorialNote ANTES do
  // stripCanonBanner — a nota costuma conter "ao cânone de entidades", e se o
  // banner rodasse primeiro comeria o `]` de fechamento e deixaria meio colchete
  // cravado. Tira o colchete INTEIRO primeiro, depois a tarja solta. Usa `strip*`
  // (não `sanitize`) pra NÃO mexer em whitespace/parágrafos do roteiro.
  text = stripCanonBanner(stripEditorialNote(stripXmlCruft(text)));

  return { text, appliedIds, failedIds };
}
