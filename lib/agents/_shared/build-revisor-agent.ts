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
  return [
    `━━━ ESCOPO DESTA REVISÃO: ${target.toUpperCase()} (e SOMENTE ${target.toUpperCase()}) ━━━`,
    "",
    `• Os capítulos abaixo são SOMENTE da ${target}. NÃO há nada da ${other} no material a revisar.`,
    `• TODOS os erros que você emitir devem se referir a essa Parte. No XML <erros_detalhados>, cada <erro> deve ter o atributo parte="${part}".`,
    `• Foque em coerência, ritmo, voz, plot e cliffhangers DENTRO da ${target}. Não comente sobre o que vai acontecer (ou já aconteceu) na ${other}, exceto quando a continuidade entre as Partes for explicitamente afetada por algo que ESTÁ na ${target}.`,
    `• Numeração e XML <erro numero="..."> reinicia em 1 nesta revisão — o app prefixa internamente cada id com p${part}- pra não colidir com a outra Parte.`,
  ].join("\n");
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
      //    de saída do system prompt SÓ pra esta passada: entrega só o bloco de
      //    erros (PRINCIPAIS ERROS + <erros_detalhados>), pulando o ensaio.
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
 * Instrução de "relatório enxuto" — anexada na 2ª revisão em diante. A roteirista
 * já leu o relatório completo numa passada anterior; agora só quer os erros pra
 * corrigir. Como o OUTPUT domina o wall-clock, cortar o ensaio (Análise de
 * Leitor / Hater / Nota / Melhorias) ~corta o tempo da ação que elas mais
 * repetem (3×/parte). Mantém o bloco <erros_detalhados> intacto — é ele que
 * move os cards de correção de 1 clique — e a lista PRINCIPAIS ERROS (o
 * contador de erros do app usa ela pro fallback de extração).
 */
function buildLeanReportInstruction(): string {
  return [
    "━━━ MODO RELATÓRIO ENXUTO (re-revisão — PRIORIDADE sobre o formato do system prompt) ━━━",
    "",
    "Esta NÃO é a primeira revisão deste roteiro. A roteirista já leu o relatório completo numa passada anterior e agora só quer a lista de erros pra corrigir. Pra economizar tempo, entregue SOMENTE estas duas seções, NESTA ordem, e NADA MAIS:",
    "",
    "1. # ❌ PRINCIPAIS ERROS — lista numerada e classificada (🟢/🟡/🟠/🔴), UMA linha curta por erro (trecho citado + qual é o problema). Sem parágrafos de análise.",
    "",
    "2. O bloco <erros_detalhados>…</erros_detalhados> COMPLETO, no formato EXATO do system prompt — um <erro> por cada item de PRINCIPAIS ERROS, com trecho_original literal e trecho_corrigido plug-and-play.",
    "",
    "NÃO gere nesta passada: SUGESTÕES PRÁTICAS, ANÁLISE COMO LEITOR REAL, ANÁLISE DE HATER, NÍVEL DE RISCO DE HATE, NOTA FINAL, MELHORIAS PRÁTICAS. Pule essas seções inteiras — elas não entram aqui.",
    "",
    "Comece direto pelo cabeçalho # ❌ PRINCIPAIS ERROS. Sem preâmbulo.",
  ].join("\n");
}
