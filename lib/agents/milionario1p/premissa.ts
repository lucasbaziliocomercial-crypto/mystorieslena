import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildRefinePatchPrompt } from "../_shared/refine-patch-prompt";
import { PREMISSA_SYSTEM_PROMPT } from "./premissa-prompt";

/**
 * Etapa 1 — Premissa (Romance de Bilionário, duologia).
 *
 * Funciona em duas fases orquestradas pelo frontend:
 *
 *   FASE 1 — RESUMO (Bloco 0):
 *     ctx.premissaPhase === "resumo"
 *     A partir do briefing do usuário (ctx.userInput), gera APENAS os dois
 *     resumos longos (Parte 1 + Parte 2, ~600-900 palavras cada).
 *
 *   FASE 2 — ESTRUTURA COMPLETA (Blocos 1-7):
 *     ctx.premissaPhase === "estrutura"
 *     Recebe o resumo já aprovado pelo usuário (ctx.approvedResumo) e
 *     gera os Blocos 1-7 completos (cabeçalho, elenco fixo, cenários,
 *     contexto histórico, 6+14 etapas, regras globais).
 *
 * Modo legado (sem premissaPhase): comportamento de fallback que pede o
 * Bloco 0 — funciona se o frontend chamar sem flag.
 */
export const premissaAgent: Agent = {
  id: "premissa",
  label: "Premissa",
  description:
    "Premissa de Romance de Bilionário (duologia). Fluxo em duas fases: gera resumo, espera aprovação, gera estrutura completa Blocos 1-7",
  model: MODELS.opus,
  thinking: "disabled",
  effort: "low",
  systemPrompt: PREMISSA_SYSTEM_PROMPT,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const phase = ctx.premissaPhase ?? "resumo";

    // Modo correção pontual: roteirista quer mexer em um detalhe sem regerar
    // o resumo/estrutura inteiro. Devolve patches XML find+replace.
    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const currentLabel =
        phase === "estrutura"
          ? "PREMISSA ATUAL (resumo + Blocos 1-7)"
          : "RESUMO ATUAL (Bloco 0)";
      const extraRules =
        phase === "estrutura"
          ? [
              "Preserve a estrutura dos Blocos 1-7: cabeçalhos `BLOCO 1`, `BLOCO 2`, … precisam permanecer intactos no <corrigido> se aparecerem dentro do <original>.",
              "Preserve numeração e títulos de etapas — só mude o conteúdo do trecho citado.",
              "Coerência: se mexer em um nome/cidade/segredo central, emita um <alteracao> por ocorrência (no resumo E nos Blocos onde aparecer).",
            ]
          : [
              "Preserve a estrutura de parágrafos do resumo (8 parágrafos na Parte 1, 9 na Parte 2 — definida na PARTE G do prompt mestre).",
              "Preserve os cabeçalhos `TÍTULO PROVISÓRIO:`, `PREMISSA CENTRAL:`, `# RESUMO DA PARTE 1` e `# RESUMO DA PARTE 2`.",
              "Romance em 1ª pessoa, voz da FMC — não mude pra 3ª pessoa nem introduza POV masculino.",
            ];
      return buildRefinePatchPrompt({
        currentLabel,
        currentOutput: ctx.currentOutput,
        userInstruction: ctx.userInput,
        extraRules,
      });
    }

    const briefing = ctx.userInput?.trim() || "";
    const briefingBlock = briefing
      ? `IDEIA BASE DO USUÁRIO:\n\n${briefing}`
      : "IDEIA BASE DO USUÁRIO: nenhuma ideia específica foi enviada — escolha cidade, tipo de fortuna do MMC, profissão da FMC, gatilho inicial e segredo central seguindo as regras do prompt mestre.";

    if (phase === "estrutura") {
      const resumo = ctx.approvedResumo?.trim() || "";
      const resumoBlock = resumo
        ? `RESUMO APROVADO PELO USUÁRIO (BLOCO 0 — fonte de verdade, mantenha coerência total):\n\n${resumo}`
        : "RESUMO APROVADO PELO USUÁRIO: (não fornecido — gere os blocos seguindo apenas a ideia base e as regras do prompt mestre).";

      return [
        briefingBlock,
        resumoBlock,
        `TAREFA NESTE TURNO:

Entregue APENAS os Blocos 1 ao 7, na ordem exata definida na PARTE G do prompt mestre:
- BLOCO 1: CABEÇALHO
- BLOCO 2: ELENCO FIXO
- BLOCO 3: CENÁRIOS FIXOS
- BLOCO 4: CONTEXTO HISTÓRICO TRAVADO
- BLOCO 5: PARTE 1 — ETAPAS 1 ATÉ 6
- BLOCO 6: PARTE 2 — ETAPAS 7 ATÉ 20
- BLOCO 7: REGRAS GLOBAIS DE ESCRITA

NÃO repita o Bloco 0 (resumo). Comece direto pelo Bloco 1.

Mantenha coerência total com o resumo aprovado: nomes, cidade, tipo de fortuna do MMC, gatilho, segredo central, antagonista e final feliz precisam ser exatamente os mesmos. Os Blocos 1-7 detalham e expandem o que o resumo já estabeleceu — não introduzem mudanças de rumo.

Aplique TODAS as regras das Partes A-N (foco no romance, FMC ativa em todos os pontos de virada, cidade da lista permitida, nomes fora da lista proibida, elemento de ritmo em cada etapa, construção gradual do romance, até 4 POVs masculinos na Parte 2, mapa de plantio e pagamento, timeline coerente).`,
      ].join("\n\n");
    }

    // Fase resumo (default)
    return [
      briefingBlock,
      `TAREFA NESTE TURNO:

Entregue APENAS o BLOCO 0 — os dois resumos longos (RESUMO DA PARTE 1 e RESUMO DA PARTE 2), cada um com aproximadamente 600 a 900 palavras, em prosa corrida, com a estrutura de parágrafos definida na PARTE G do prompt mestre.

NÃO entregue Blocos 1-7 neste turno. NÃO escreva frases de espera ou pedidos de aprovação — o usuário vai aprovar/editar o resumo na interface do app antes de pedir os Blocos 1-7 em uma chamada separada.

Use linguagem clara e didática conforme a PARTE G (apresente cada personagem pelo nome completo, idade, profissão e situação; explique termos técnicos como CEO, herdeiro, conglomerado em palavras simples; conte cronologicamente; detalhe a aproximação dos dois). Aplique TODAS as regras das Partes A-N (cidade da lista permitida, nomes fora da lista proibida, FMC ativa, romance em primeiro plano, fechamento da Parte 1 sem cliffhanger, abertura da Parte 2 com bomba, reconciliação não apressada, final feliz obrigatório).

FORMATO DE SAÍDA esperado neste turno (comece EXATAMENTE por estas duas linhas, nesta ordem):

TÍTULO PROVISÓRIO: [criar título comercial e sedutor, se o usuário não fornecer]

PREMISSA CENTRAL: [resumir a ideia principal em 1-3 linhas: trope base + universo de poder/riqueza + gancho emocional]

# RESUMO DA PARTE 1

[8 parágrafos cobrindo: apresentação da FMC, apresentação do MMC, encontro, o que força a convivência, aproximação detalhada, primeiro grande obstáculo, como enfrentam e se escolhem, fechamento sem entrega total]

# RESUMO DA PARTE 2

[9 parágrafos cobrindo: bomba inicial, por que parece o fim, afastamento ativo da FMC, investigação da FMC, tentativas do MMC, verdade completa, reconciliação, queda do antagonista, final feliz]`,
    ].join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.9,
};
