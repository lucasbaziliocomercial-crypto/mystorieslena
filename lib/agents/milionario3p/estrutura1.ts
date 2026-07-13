import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildEstruturaContinuationMessage } from "../continuation-prompt";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { extractTituloFromPremissa } from "../_shared/extract-titulo";
import { ESTRUTURA_MASTER_PROMPT } from "./estrutura-master-prompt";
import { ESTRUTURA1_PROMPT } from "./estrutura1-prompt";

/**
 * Etapa 2 — Estrutura da Parte 1 (Romance de Milionário 3ª pessoa, canal Rowan).
 *
 * 10.000 a 11.000 palavras (alvo 10.500), 5-6 capítulos.
 * Narração em terceira pessoa LIMITADA À FMC (sem POV masculino, MMC observado
 * de fora), SEM cena íntima descrita na Parte 1 (apenas elipse: aproximação →
 * porta fechando → manhã seguinte), final feliz sem casamento e sem filhos.
 *
 * System prompt = master M3P + estrutura1 M3P.
 */
export const estrutura1Agent: Agent = {
  id: "estrutura1",
  label: "Estrutura — Parte 1",
  description:
    "Monta a estrutura completa da Parte 1 de Milionário 3p (10.000-11.000 palavras, 5-6 capítulos) — mapa cena por cena, capítulos com química crescente, narração 3ª pessoa limitada à FMC (sem POV masculino), entrega do casal SEM cena íntima descrita (apenas elipse), final em paz sem casamento e sem filhos",
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
          "• Se mudar a contagem de palavras de um capítulo, EMITA TAMBÉM blocos <alteracao> rebalanceando outros para manter o total entre 10.000 e 11.000 palavras (REGRA INEGOCIÁVEL).",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai montar a ESTRUTURA da PARTE 1 da história de romance de milionário em 3ª pessoa. Toda a regra está no seu system prompt — siga na risca, sem alucinar e sem desvios. A premissa abaixo é a fonte primária do conteúdo. Use o que estiver no campo de instruções adicionais como ajuste opcional.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nA roteirista anexou uma imagem visual de referência. USE essa imagem pra calibrar mood/atmosfera (luz, paleta, peso emocional do mundo de luxo), aparência física dos personagens (especialmente o MMC), cenário/ambientação, estilo visual da narrativa. Integre os elementos visuais à estrutura sem inventar contradições com a premissa textual. Em conflito, a PREMISSA TEXTUAL prevalece.",
      );
    }

    if (canoneBlock) {
      sections.push(canoneBlock);
    }

    if (titulo) {
      sections.push(
        [
          `━━━ TÍTULO OFICIAL DA HISTÓRIA (FONTE PRIMÁRIA — usar EXATAMENTE este título) ━━━`,
          ``,
          `"${titulo}"`,
          ``,
          `⚠️ REGRA INEGOCIÁVEL:`,
          `• Use este título EXATO no bloco "📖 TÍTULO DA HISTÓRIA" da saída.`,
          `• É proibido inventar outro título, sugerir alternativas ou ignorar este.`,
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
      "━━━ AÇÃO ━━━\n\nMonte a ESTRUTURA COMPLETA da Parte 1 seguindo o LAYOUT DE SAÍDA OBRIGATÓRIO definido no system prompt (Mundo → Pessoas-chave → FMC → MMC → Casal → Secundários → Mapa cena por cena → Capítulos → Temas → Arcos → Momentos-chave). Comece direto, sem pedir confirmação. Não escreva os capítulos em si — apenas a ESTRUTURA/PLANEJAMENTO.\n\n⚠️ ATENÇÃO CRÍTICA — CONTAGEM DE PALAVRAS: a SOMA das contagens declaradas para os 5-6 capítulos DEVE ficar entre 10.000 e 11.000 palavras (alvo 10.500). REGRA INEGOCIÁVEL. Antes de finalizar, SOME mentalmente as contagens de cada capítulo e CONFIRME que o total está dentro da faixa. Se ficar fora, REDISTRIBUA até bater.\n\n⚠️ NARRAÇÃO em TERCEIRA PESSOA LIMITADA À FMC — narrador externo que acompanha PRIORITARIAMENTE a heroína. SEM POV masculino. SEM entrar nos pensamentos do MMC (ele aparece apenas pelos atos, falas, gestos observáveis). NÃO é narração da FMC em primeira pessoa.\n\n⚠️ ENTREGA DO CASAL na Parte 1 NÃO TEM cena íntima descrita — apenas elipse (aproximação → porta fechando → manhã seguinte). Final em paz, sem casamento, sem filhos.",
    );

    return sections.join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.8,
};
