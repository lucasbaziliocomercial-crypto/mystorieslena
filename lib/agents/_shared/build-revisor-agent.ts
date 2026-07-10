/**
 * Factory que transforma um template de Revisor (mesmo system prompt e regras
 * de gravidade da categoria) em um agente focado APENAS em uma das Partes do
 * roteiro. Antes existia um único `revisorAgent` por categoria que recebia P1
 * e P2 concatenadas — entregava revisões superficiais e introduzia
 * inconsistências (sugestões para a P2 que contradiziam escolhas da P1).
 *
 * Esta factory gera dois Agents (revisor1, revisor2) reaproveitando o
 * `buildUserMessage` original da categoria: filtra os capítulos por Parte
 * antes de chamar o template, prepende uma instrução de escopo, e — no
 * revisor2 — anexa o relatório limpo do revisor1 como contexto narrativo
 * (a Parte 1 é tratada como definitiva).
 */

import type { StepOutput, EscritaChapter } from "@/types/roteiro";
import { stripErrosDetalhados } from "@/lib/parse-revisor-output";
import type { Agent, AgentContext } from "../types";

type RevisorPart = 1 | 2;

function partLabel(part: RevisorPart): "Parte 1" | "Parte 2" {
  return part === 1 ? "Parte 1" : "Parte 2";
}

/**
 * Reconstrói um StepOutput de Escrita contendo APENAS os capítulos da Parte
 * escolhida. Reescreve `content` (texto monolítico) e `metadata.chapters` em
 * sincronia. Capítulos sem `part` são tratados como pertencentes à Parte 1
 * (fallback paranóico — formato bruto da Escrita sempre carimba `part`, mas
 * roteiros antigos podem ter chapters sem essa info).
 */
function filterEscritaByPart(
  escrita: StepOutput | undefined,
  part: RevisorPart,
): StepOutput | undefined {
  if (!escrita) return escrita;
  const target = partLabel(part);
  const allChapters: EscritaChapter[] = escrita.metadata?.chapters ?? [];
  const filtered = allChapters.filter((ch) => {
    const chPart = ch.part ?? "Parte 1";
    return chPart === target;
  });

  // Se não tem chapters parseados (parser falhou ou roteiro legado all-at-once)
  // não temos como filtrar com segurança — devolve a escrita inteira. O agente
  // recebe o disclaimer de escopo no header e foca por marcador textual.
  if (allChapters.length === 0) {
    return escrita;
  }

  if (filtered.length === 0) {
    // Nenhum capítulo da parte alvo — o frontend deve ter bloqueado isso, mas
    // se chegar aqui devolvemos vazio pra o template gerar o aviso de "nada
    // pra revisar".
    return {
      ...escrita,
      content: "",
      metadata: { ...(escrita.metadata ?? {}), chapters: [] },
    };
  }

  // Concatena com banner de Parte no topo + headers de capítulo. Mantém o
  // mesmo formato textual que o output bruto da Escrita usa (═══ PARTE X ═══
  // + `# Capítulo N — Título`), pra que padrões de regex no system prompt do
  // Revisor casem como sempre casaram.
  const banner = `═══════════════════════════════════════\n${target.toUpperCase()}\n═══════════════════════════════════════`;
  const body = filtered
    .map((ch) => {
      const titleSuffix = ch.title ? ` — ${ch.title}` : "";
      return `# Capítulo ${ch.number}${titleSuffix}\n\n${ch.content.trim()}`;
    })
    .join("\n\n");
  const newContent = `${banner}\n\n${body}`.trim();

  return {
    ...escrita,
    content: newContent,
    metadata: {
      ...(escrita.metadata ?? {}),
      chapters: filtered,
    },
  };
}

function buildScopeHeader(part: RevisorPart): string {
  const target = partLabel(part);
  const other = part === 1 ? "Parte 2" : "Parte 1";
  const lines = [
    `━━━ ESCOPO DESTA REVISÃO: ${target.toUpperCase()} (e SOMENTE ${target.toUpperCase()}) ━━━`,
    "",
    `• Os capítulos abaixo são SOMENTE da ${target}. NÃO há nada da ${other} no material a revisar.`,
    `• TODOS os erros que você emitir devem se referir a essa Parte. No XML <erros_detalhados>, cada <erro> deve ter o atributo parte="${part}".`,
    `• Foque em coerência, ritmo, voz, plot e cliffhangers DENTRO da ${target}. Não comente sobre o que vai acontecer (ou já aconteceu) na ${other}, exceto quando a continuidade entre as Partes for explicitamente afetada por algo que ESTÁ na ${target}.`,
    `• Numeração e XML <erro numero="..."> reinicia em 1 nesta revisão — o app prefixa internamente cada id com p${part}- pra não colidir com a outra Parte.`,
  ];
  // Parte 1: a narração é de UMA voz só (a heroína), sem POV alternado nem
  // marcador ✦. O "Checklist de MARCADOR DE POV" do system prompt é EXCLUSIVO
  // da Parte 2 — reforça aqui pra o Revisor não inventar erros de "POV
  // masculino/feminino" na Parte 1 (a roteirista relatava POVs apontados na
  // Parte 1 que não existem no roteiro; os marcadores ✦ já são removidos na
  // origem pelo stripPovMarkersPart1).
  if (part === 1) {
    lines.push(
      `• POV: a ${target} é narrada por UMA perspectiva só (a da heroína), sem POV alternado e sem marcador ✦. Se o seu system prompt tiver um "Checklist de MARCADOR DE POV ✦", ele NÃO se aplica aqui — é exclusivo da Parte 2. NÃO emita erros de "POV masculino/feminino", "marcador no bloco errado" ou "troca de POV" na ${target}; o único risco de voz é a narração escapar da perspectiva da heroína (tratado pelo checklist de narrador/pessoa).`,
    );
  }
  return lines.join("\n");
}

function buildRevisor1ContextSection(revisor1Content: string): string {
  const cleaned = stripErrosDetalhados(revisor1Content).trim();
  if (!cleaned) return "";
  return [
    "━━━ REVISÃO DA PARTE 1 (já aplicada — referência narrativa) ━━━",
    "",
    "A Parte 1 já foi revisada e as correções foram aplicadas no roteiro. O relatório abaixo documenta as escolhas que ficaram CONSOLIDADAS na Parte 1 — trate-as como definitivas.",
    "",
    "REGRAS:",
    "• NÃO levante \"inconsistências\" contra escolhas que a Parte 1 já consolidou (apenas contra contradições internas DA Parte 2).",
    "• Use o relatório da Parte 1 como ponto de partida narrativo: arcos, tom, motivações, dinâmica do casal estabelecidos lá são canônicos.",
    "• Se algo na Parte 2 contradiz o que a Parte 1 estabelece, isso É um erro da Parte 2 — aponte e classifique normalmente.",
    "",
    "═══ RELATÓRIO DA REVISÃO DA PARTE 1 ═══",
    "",
    cleaned,
  ].join("\n");
}

export interface BuildRevisorAgentOptions {
  /** Template do agente Revisor da categoria (sem `id` definitivo). */
  template: Omit<Agent, "id">;
  part: RevisorPart;
}

/**
 * Gera um Agent revisor1 ou revisor2 a partir do template da categoria.
 * Reaproveita systemPrompt, model, maxTokens, temperature, thinking, effort,
 * acceptsReferenceImage e — crucialmente — o `buildUserMessage` original da
 * categoria (com toda a lógica de modo refine, modo continuar revisão, regras
 * de XML específicas dos emojis daquela categoria). Só envolve o filtro de
 * capítulos por Parte e o prefixo de escopo.
 */
export function buildRevisorAgent({
  template,
  part,
}: BuildRevisorAgentOptions): Agent {
  const stepId = part === 1 ? "revisor1" : "revisor2";
  const target = partLabel(part);

  return {
    ...template,
    id: stepId,
    label: `Revisor — ${target}`,
    description: `${template.description} (escopo: ${target} — análise focada para detectar erros graves sem inconsistências cruzadas)`,
    buildUserMessage: (ctx: AgentContext): string => {
      // 1) Filtra a Escrita pra conter só os capítulos da parte alvo.
      const filteredEscrita = filterEscritaByPart(
        ctx.previousOutputs.escrita,
        part,
      );

      // 2) Constrói novo previousOutputs.
      //    Para revisor1, omitimos estrutura2 (não interfere na revisão da P1
      //    e mantém o prompt menor). Para revisor2 mantemos as duas estruturas.
      const newPreviousOutputs = { ...ctx.previousOutputs };
      newPreviousOutputs.escrita = filteredEscrita;
      if (part === 1) {
        newPreviousOutputs.estrutura2 = undefined;
      }

      const modifiedCtx: AgentContext = {
        ...ctx,
        previousOutputs: newPreviousOutputs,
      };

      // 3) Chama o buildUserMessage original da categoria — que sabe os emojis,
      //    regras de gravidade, formato XML e tudo mais específico daquela
      //    categoria.
      const baseMessage = template.buildUserMessage(modifiedCtx);

      // 4) Em modo refine (correção pontual da revisão atual) NÃO injetamos
      //    headers extras — o template já produziu uma resposta XML-only de
      //    <alteracao> e qualquer prefixo bagunçaria o parser de patches.
      if (ctx.refineMode) {
        return baseMessage;
      }

      // 5) Header de escopo no topo + (revisor2) seção da revisão da P1.
      const sections: string[] = [buildScopeHeader(part)];

      if (part === 2) {
        const revisor1Output = ctx.previousOutputs.revisor1?.content?.trim();
        if (revisor1Output) {
          const ctxSection = buildRevisor1ContextSection(revisor1Output);
          if (ctxSection) sections.push(ctxSection);
        }
      }

      sections.push(baseMessage);

      // 6) Modo relatório enxuto (2ª passada em diante) — sobrescreve o formato
      //    de saída do system prompt SÓ pra esta passada: entrega os erros
      //    (PRINCIPAIS ERROS + <erros_detalhados>) + a NOTA FINAL e a avaliação
      //    de hate (sempre — essenciais), pulando só o resto do ensaio.
      //    Vai por ÚLTIMO pra ter precedência sobre o "Mantenha o formato
      //    obrigatório" da seção de "Continuar revisão" (quando ambos coexistem).
      if (ctx.leanRevisorReport) {
        sections.push(buildLeanReportInstruction());
      }

      return sections.join("\n\n");
    },
  };
}

/**
 * Instrução de "relatório enxuto" — agora anexada em TODAS as passadas, inclusive
 * a 1ª (a roteirista optou por enxugar já na 1ª pra acelerar — ver MEMORY.md). A
 * revisão foca nos erros pra corrigir + nota + hate. Como o OUTPUT domina o
 * wall-clock, cortar o ensaio (Sugestões Práticas / Análise de Leitor / Melhorias)
 * acelera a ação que elas mais repetem (3×/parte).
 *
 * TRAVA (pedido explícito da roteirista): a NOTA FINAL e a avaliação de hate
 * (ANÁLISE DE HATER + NÍVEL DE RISCO DE HATE) são essenciais pra análise da
 * revisão e entram SEMPRE — em qualquer passada, enxuta ou não. NÃO remover
 * dessa lista sem combinar com ela.
 *
 * Mantém o bloco <erros_detalhados> intacto — é ele que move os cards de correção
 * de 1 clique — e a lista PRINCIPAIS ERROS (o contador de erros do app usa ela
 * pro fallback de extração).
 *
 * ⚠️ ORDEM (NÃO reordenar sem motivo): HATER → RISCO → NOTA vêm ANTES do bloco
 * <erros_detalhados>, e o XML é a ÚLTIMA seção. Isso casa com o system prompt
 * ("APÓS A REVISÃO MARKDOWN" / "Depois de tudo, emita um bloco XML") e com o
 * viés do modelo de tratar um bloco XML grande como o FIM da resposta. Quando o
 * XML vinha no meio (com nota+hate depois dele), em revisões com muitos erros o
 * modelo fechava </erros_detalhados> e PARAVA — derrubava exatamente a cauda
 * (hater + risco + nota), e o app caía no fallback "nota não detectada" + hate
 * falso-positivo (emoji 🔴 dos erros). Com a nota/hate ANTES do XML longo, elas
 * já aterrissaram mesmo que o XML seja truncado. Bug 11/06/2026 (LENA P1, 13
 * erros: só lista de erros, sem nota nem hate).
 */
function buildLeanReportInstruction(): string {
  return [
    "━━━ MODO RELATÓRIO ENXUTO (PRIORIDADE sobre o formato do system prompt) ━━━",
    "",
    "Esta revisão foca nos erros pra corrigir — MAS a nota e a avaliação de hate são essenciais e entram SEMPRE. Entregue SOMENTE estas seções, NESTA ordem EXATA, e NADA MAIS:",
    "",
    "1. # ❌ PRINCIPAIS ERROS — lista numerada e classificada (🟢/🟡/🟠/🔴), UMA linha curta por erro (trecho citado + qual é o problema). Sem parágrafos de análise.",
    "",
    "2. ANÁLISE DE HATER — no formato do system prompt: liste TODOS os pontos que geram ódio/rejeição encontrados, onde estão e como resolver.",
    "",
    "3. NÍVEL DE RISCO DE HATE — 🟢 BAIXO / 🟡 MÉDIO / 🔴 ALTO, com justificativa curta.",
    "",
    "4. NOTA FINAL (0 a 10) — com justificativa honesta.",
    "",
    "5. O bloco <erros_detalhados>…</erros_detalhados> COMPLETO, no formato EXATO do system prompt — um <erro> por cada item de PRINCIPAIS ERROS, com trecho_original literal e trecho_corrigido plug-and-play. Este bloco é SEMPRE a ÚLTIMA coisa da resposta (vem DEPOIS da nota), nunca no meio.",
    "",
    "NÃO gere nesta passada: SUGESTÕES PRÁTICAS, ANÁLISE COMO LEITOR REAL, MELHORIAS PRÁTICAS. Pule essas três seções inteiras — elas não entram aqui. (A ANÁLISE DE HATER, o NÍVEL DE RISCO DE HATE e a NOTA FINAL são obrigatórios mesmo nesta passada enxuta — emita as quatro primeiras seções ANTES de começar o <erros_detalhados> e NÃO encerre a resposta sem elas.)",
    "",
    "Comece direto pelo cabeçalho # ❌ PRINCIPAIS ERROS. Sem preâmbulo.",
  ].join("\n");
}
