import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildRefinePatchPrompt } from "../_shared/refine-patch-prompt";
import { PREMISSA_SYSTEM_PROMPT } from "./premissa-prompt";

/**
 * Etapa 1 — Premissa (Romance de Máfia, duologia).
 *
 * Fluxo em duas fases (controlado pelo app via ctx.premissaPhase):
 *   FASE 1 — RESUMO: TÍTULO PROVISÓRIO + PREMISSA CENTRAL + um resumo em prosa
 *     por parte (cada um ≤500 palavras).
 *   FASE 2 — SINOPSE-ESQUELETO: 5 capítulos × 3 acontecimentos × 2 partes,
 *     mais FINAL DA PARTE 1, ELEMENTOS PLANTADOS NA PARTE 1, INÍCIO DA PARTE 2
 *     — A BOMBA, e FINAL DEFINITIVO.
 *
 * Substitui o sistema antigo de 20 etapas por um modelo enxuto e cronológico
 * conforme PDF "LENA - MÁFIA - GUIA CONSTRUÇÃO DE ROTEIROS (alterado)".
 */
export const premissaAgent: Agent = {
  id: "premissa",
  label: "Premissa",
  description:
    "Premissa de Romance de Máfia (duologia). Fluxo em duas fases: resumo curto (≤500 palavras por parte) → sinopse-esqueleto com 5 capítulos × 3 acontecimentos × 2 partes + bomba + final definitivo",
  model: MODELS.opus,
  thinking: "disabled",
  effort: "low",
  systemPrompt: PREMISSA_SYSTEM_PROMPT,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const phase = ctx.premissaPhase ?? "resumo";

    // Modo correção pontual: roteirista quer mexer em um detalhe sem regerar
    // o resumo/sinopse-esqueleto inteiro. Devolve patches XML find+replace.
    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const currentLabel =
        phase === "estrutura"
          ? "PREMISSA ATUAL (resumo + sinopse-esqueleto)"
          : "RESUMO ATUAL (Fase 1 — TÍTULO + PREMISSA CENTRAL + dois resumos curtos)";
      const extraRules =
        phase === "estrutura"
          ? [
              "Preserve a estrutura da sinopse-esqueleto: cabeçalhos `PARTE 1 — ACONTECIMENTOS EM ORDEM CRONOLÓGICA`, `FINAL DA PARTE 1`, `ELEMENTOS PLANTADOS NA PARTE 1`, `INÍCIO DA PARTE 2 — A BOMBA`, `PARTE 2 — ACONTECIMENTOS EM ORDEM CRONOLÓGICA`, `FINAL DEFINITIVO`. Não mude títulos nem numeração de capítulos/acontecimentos.",
              "Plantio e pagamento: se mexer em um elemento plantado na P1, garanta que a bomba/pagamento na P2 continue coerente — emita um <alteracao> em cada lado se preciso.",
              "P1 termina sem casamento/filhos/bomba; P2 começa com bomba que nasce de elemento plantado. Não viole.",
            ]
          : [
              "Preserve os cabeçalhos `TÍTULO PROVISÓRIO:`, `PREMISSA CENTRAL:`, `RESUMO DA PARTE 1` e `RESUMO DA PARTE 2`.",
              "Limite rigoroso: cada resumo (P1 e P2) tem no máximo 500 palavras — não estoure.",
              "Romance em primeiro plano, mundo mafioso em segundo, conflito externo em terceiro. P1 termina sem bomba; P2 começa com bomba; final feliz com casamento/filhos.",
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
      : "IDEIA BASE DO USUÁRIO: nenhuma ideia específica foi enviada — escolha cidade da lista permitida (Nova York/Chicago/Las Vegas/Miami/Boston/Sicília/Nápoles/Moscou/São Petersburgo/Dubai/Londres), tipo de organização mafiosa (Cosa Nostra americana, máfia siciliana, Camorra, Bratva russa), cargo do MMC, profissão/gatilho inicial da FMC e segredo central seguindo as regras do prompt mestre.";

    if (phase === "estrutura") {
      const resumo = ctx.approvedResumo?.trim() || "";
      const resumoBlock = resumo
        ? `RESUMO APROVADO PELO USUÁRIO (FASE 1 — fonte de verdade, mantenha coerência total):\n\n${resumo}`
        : "RESUMO APROVADO PELO USUÁRIO: (não fornecido — gere a sinopse-esqueleto seguindo apenas a ideia base e as regras do prompt mestre).";

      return [
        briefingBlock,
        resumoBlock,
        `TAREFA NESTE TURNO:

Entregue APENAS a SINOPSE-ESQUELETO completa, na ordem exata do prompt mestre:
1. PARTE 1 — ACONTECIMENTOS EM ORDEM CRONOLÓGICA (CAPÍTULO 1 a 5, com 3 acontecimentos numerados em cada capítulo)
2. FINAL DA PARTE 1 (eles juntos, sem casamento/filhos/bomba; entrega EMOCIONAL via aproximação → elipse → manhã seguinte; SEM cena íntima descrita; apenas dúvida sutil)
3. ELEMENTOS PLANTADOS NA PARTE 1 (3 a 5 detalhes que parecem normais e voltam ressignificados na P2 — anote como cada um será ressignificado)
4. INÍCIO DA PARTE 2 — A BOMBA (deve nascer DIRETAMENTE de um dos elementos plantados)
5. PARTE 2 — ACONTECIMENTOS EM ORDEM CRONOLÓGICA (CAPÍTULO 1 a 5, 3 acontecimentos cada)
6. FINAL DEFINITIVO (casamento + filhos / lua de mel / sonho realizado)

NÃO repita o resumo aprovado. Comece direto pelo cabeçalho "PARTE 1 — ACONTECIMENTOS EM ORDEM CRONOLÓGICA".

Mantenha coerência total com o resumo aprovado: nomes, cidade, organização mafiosa, gatilho, segredo central, antagonista e final feliz precisam ser exatamente os mesmos. A sinopse-esqueleto detalha e expande o que o resumo já estabeleceu — não introduz mudanças de rumo.

Aplique TODAS as regras do prompt mestre:
- Romance em primeiro plano, perigo em segundo, conflito externo em terceiro.
- FMC ATIVA em todos os pontos de virada (questiona, negocia, provoca sem se destruir).
- 5 pilares (mundo mafioso convincente, MMC perigoso mas não vazio, heroína forte e ativa, química esmagadora, escalada constante).
- 21 diretrizes da Guia 10 (tensão adiada, "quase" mais viciante que entrega, vilão ataca ponto fraco, ciúme revela mas não resolve, FMC interpreta errado os sinais dele, etc.).
- Elementos plantados parecem normais na P1 e ressignificam na P2.
- P1 termina com casal junto e em paz, sem casamento/filhos/bomba.
- P2 começa com bomba que nasce de elemento plantado na P1.
- Cidade da lista permitida, nomes fora da lista proibida.
- Cada acontecimento tem causa, consequência e impacto no romance.
- "Antes" da protagonista mostrado nos primeiros acontecimentos do CAPÍTULO 1 da Parte 1.
- Romance gradual em etapas (tensão → atenção → cuidado → confiança parcial → desejo velado → vulnerabilidade → envolvimento real). Não pular fases.`,
      ].join("\n\n");
    }

    return [
      briefingBlock,
      `TAREFA NESTE TURNO:

Entregue APENAS o RESUMO da Fase 1 — exatamente neste formato e nada mais:

TÍTULO PROVISÓRIO: [criar título comercial, se o usuário não fornecer]

PREMISSA CENTRAL: [resumir a ideia principal em 1-3 linhas: trope base + contexto mafioso + gancho emocional]

RESUMO DA PARTE 1
[Em prosa corrida, NO MÁXIMO 500 palavras. Cobrir, na ordem: apresentação da FMC e do "antes" dela; apresentação do MMC + organização mafiosa explicada em palavras simples; encontro inicial; o que força a convivência; aproximação detalhada com cenas concretas; primeiro grande perigo do mundo mafioso; como enfrentam e se escolhem; fechamento da Parte 1 com eles juntos e bem, sem casamento/filhos/bomba.]

RESUMO DA PARTE 2
[Em prosa corrida, NO MÁXIMO 500 palavras. Cobrir, na ordem: a bomba inicial (algo plantado na P1 que ressignifica tudo); por que parece o fim do casal; afastamento ativo da FMC; investigação ativa da FMC; tentativas e sacrifícios do MMC; verdade completa; reconciliação não apressada; queda do antagonista com FMC participante; final feliz com casamento/gravidez/sonho realizado.]

NÃO entregue a sinopse-esqueleto neste turno. NÃO escreva frases de espera ou pedidos de aprovação — o usuário vai aprovar/editar o resumo na interface do app antes de pedir a sinopse-esqueleto em uma chamada separada.

Use linguagem clara e didática (apresente cada personagem pelo nome completo, idade, profissão/cargo e situação; explique termos mafiosos — don, capo, consigliere, omertà, Bratva, Cosa Nostra — em palavras simples; conte cronologicamente; DETALHE A APROXIMAÇÃO dos dois com cenas concretas, não generalize).

Aplique TODAS as regras do prompt mestre (cidade da lista permitida, nomes fora da lista proibida, FMC ATIVA em pontos de virada, romance em primeiro plano com mundo mafioso em segundo, fechamento da Parte 1 sem cliffhanger, abertura da Parte 2 com bomba, reconciliação não apressada, final feliz obrigatório).

LIMITE RIGOROSO: cada resumo (P1 e P2) deve ter NO MÁXIMO 500 palavras. Se passar de 500, condense.`,
    ].join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.9,
};
