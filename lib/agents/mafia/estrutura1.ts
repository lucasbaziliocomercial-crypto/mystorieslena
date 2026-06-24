import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildEstruturaContinuationMessage } from "../continuation-prompt";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { extractTituloFromPremissa } from "../_shared/extract-titulo";
import { ESTRUTURA_MASTER_PROMPT } from "./estrutura-master-prompt";
import { ESTRUTURA1_PROMPT } from "./estrutura1-prompt";

/**
 * Etapa 2 — Estrutura da Parte 1 (Romance de Máfia).
 *
 * 12.500 palavras (faixa 12.000-13.000, alvo 12.500), 5-6 capítulos,
 * ritmo acelerado nos iniciais (1-3) e respirado nos finais (4-6),
 * narração 1ª pessoa FMC, hook expansão do título de 90-120 palavras,
 * cena de entrega no penúltimo cap (até 600 palavras, três fases),
 * dúvida sutil no final — sem casamento/filhos.
 *
 * System prompt = master de Máfia + estrutura1 de Máfia.
 */
export const estrutura1Agent: Agent = {
  id: "estrutura1",
  label: "Estrutura — Parte 1",
  description:
    "Monta a estrutura completa da Parte 1 de Máfia (12.500 palavras, 5-6 capítulos) — hook, mapa, capítulos com ritmo graduado, cena de entrega, dúvida sutil no final",
  model: MODELS.opus,
  thinking: "adaptive",
  effort: "medium",
  systemPrompt: ESTRUTURA_MASTER_PROMPT + ESTRUTURA1_PROMPT + CANONE_RULE,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const canoneBlock = buildCanoneBlock(ctx.canone);
    const titulo = extractTituloFromPremissa(premissa);

    if (ctx.continuationMode && ctx.currentOutput?.trim()) {
      return buildEstruturaContinuationMessage({
        parteLabel: "PARTE 1",
        partial: ctx.currentOutput,
        userInput: ctx.userInput,
        canone: ctx.canone,
      });
    }

    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const refine: string[] = [];
      refine.push(
        "Você JÁ entregou uma versão dessa ESTRUTURA da PARTE 1. A roteirista pediu uma CORREÇÃO PONTUAL. NÃO regere a estrutura inteira. Devolva APENAS as alterações no formato XML descrito abaixo — o app aplica via find+replace literal no documento corrente.",
      );
      refine.push(
        `━━━ ESTRUTURA ATUAL — PARTE 1 (consulte mas NÃO devolva inteira) ━━━\n\n${ctx.currentOutput.trim()}`,
      );
      refine.push(
        `━━━ CORREÇÃO PEDIDA PELA ROTEIRISTA ━━━\n\n${ctx.userInput.trim()}`,
      );
      if (canoneBlock) {
        refine.push(canoneBlock);
      }
      if (premissa) {
        refine.push(
          `━━━ PREMISSA APROVADA (Step 1 — referência de coerência) ━━━\n\n${premissa}`,
        );
      }
      refine.push(
        [
          "━━━ FORMATO DE SAÍDA OBRIGATÓRIO ━━━",
          "",
          "Para cada trecho da estrutura que precisa mudar, emita um bloco:",
          "",
          "<alteracao>",
          "<descricao>linha curta explicando o que muda</descricao>",
          "<original>",
          "[trecho EXATO do documento atual — copie literal, com mesma quebra de linha, mesmas aspas, mesmos travessões. Inclua contexto suficiente pra ser único no documento.]",
          "</original>",
          "<corrigido>",
          "[trecho novo que substitui o original.]",
          "</corrigido>",
          "</alteracao>",
          "",
          "REGRAS RIGOROSAS:",
          "• Inclua um bloco <alteracao> POR cada trecho que muda. Não há limite — pode ser 1, 5, 20.",
          "• <original> precisa ser uma cópia LITERAL do documento atual.",
          "• <original> precisa ser ÚNICO no documento. Se duplicado, expanda com contexto.",
          "• NÃO devolva a estrutura inteira. NÃO devolva markdown explicativo fora dos blocos <alteracao>.",
          "• Não invente mudanças que a roteirista não pediu.",
          "• Se mudar a contagem de palavras de um capítulo, EMITA TAMBÉM blocos <alteracao> rebalanceando outros para manter o total entre 12.000 e 13.000 palavras (REGRA INEGOCIÁVEL).",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai montar a ESTRUTURA da PARTE 1 da história de máfia. Toda a regra está no seu system prompt — siga na risca, sem alucinar e sem desvios. A premissa abaixo é a fonte primária do conteúdo. Use o que estiver no campo de instruções adicionais como ajuste opcional.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nA roteirista anexou uma imagem visual de referência. USE essa imagem pra calibrar mood/atmosfera (luz, paleta, peso emocional do mundo mafioso), aparência física dos personagens (especialmente o MMC), cenário/ambientação, estilo visual da narrativa. Integre os elementos visuais à estrutura sem inventar contradições com a premissa textual. Em conflito, a PREMISSA TEXTUAL prevalece.",
      );
    }

    if (canoneBlock) {
      sections.push(canoneBlock);
    }

    if (titulo) {
      sections.push(
        [
          `━━━ TÍTULO OFICIAL DA HISTÓRIA (FONTE PRIMÁRIA — usar EXATAMENTE este título no hook) ━━━`,
          ``,
          `"${titulo}"`,
          ``,
          `⚠️ REGRA INEGOCIÁVEL:`,
          `• O hook principal E as 3 versões alternativas DEVEM expandir este título literal.`,
          `• A primeira frase de cada hook precisa ecoar/traduzir o título — não citar de forma decorativa, não trocar por sinônimos, não suavizar.`,
          `• É proibido inventar outro título, sugerir alternativas ou ignorar este.`,
          `• Antes de fechar o hook, releia: a expansão do título está clara nas 4 versões? Se não, refaça.`,
        ].join("\n"),
      );
    } else if (premissa) {
      sections.push(
        [
          `━━━ TÍTULO AUSENTE NA PREMISSA — CRIE UM (NÃO BLOQUEIE) ━━━`,
          ``,
          `A premissa não trouxe uma linha "TÍTULO PROVISÓRIO:". CRIE você mesmo um título provisório comercial, curto e sedutor a partir da premissa, e trate-o como o TÍTULO OFICIAL desta história.`,
          ``,
          `⚠️ REGRA INEGOCIÁVEL:`,
          `• Defina o título logo no início da saída, no bloco "📖 TÍTULO DA HISTÓRIA".`,
          `• O hook principal E as 3 versões alternativas DEVEM expandir esse título literal.`,
          `• A primeira frase de cada hook precisa ecoar o título.`,
          `• NÃO bloqueie, NÃO peça o título à roteirista, NÃO devolva mensagem de erro — gere a ESTRUTURA COMPLETA normalmente.`,
        ].join("\n"),
      );
    }

    if (premissa) {
      sections.push(
        `━━━ PREMISSA APROVADA (Step 1 — fonte primária) ━━━\n\n${premissa}`,
      );
    } else {
      sections.push(
        "━━━ PREMISSA ━━━\n\n⚠️ Não fornecida. Avise que o Step 1 (Premissa) precisa estar preenchido para gerar a Parte 1 com qualidade. Se mesmo assim houver instruções no campo abaixo que tragam contexto suficiente, use-as como base.",
      );
    }

    if (ctx.userInput?.trim()) {
      sections.push(
        `━━━ INSTRUÇÕES ADICIONAIS DA ROTEIRISTA (ajustes opcionais) ━━━\n\n${ctx.userInput.trim()}`,
      );
    }

    sections.push(
      "━━━ AÇÃO ━━━\n\nMonte a ESTRUTURA COMPLETA da Parte 1 seguindo o LAYOUT DE SAÍDA OBRIGATÓRIO definido no system prompt (Mundo → Hierarquia → FMC → MMC → Casal → Secundários → Mapa da História → Hook → Capítulos → Temas → Arcos → Momentos-chave → Dúvida Sutil). Comece direto, sem pedir confirmação. Não escreva os capítulos em si — apenas a ESTRUTURA/PLANEJAMENTO.\n\n⚠️ ATENÇÃO CRÍTICA — CONTAGEM DE PALAVRAS: a SOMA das contagens declaradas para os 5-6 capítulos DEVE ficar entre 12.000 e 13.000 palavras (alvo 12.500). REGRA INEGOCIÁVEL. Antes de finalizar, SOME mentalmente as contagens de cada capítulo e CONFIRME que o total está dentro da faixa. Se ficar fora, REDISTRIBUA até bater.",
    );

    return sections.join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.8,
};
