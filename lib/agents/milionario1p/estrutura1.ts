import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildEstruturaContinuationMessage } from "../continuation-prompt";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { extractTituloFromPremissa } from "../_shared/extract-titulo";
import { ESTRUTURA_MASTER_PROMPT } from "./estrutura-master-prompt";
import { ESTRUTURA1_PROMPT } from "./estrutura1-prompt";

/**
 * Etapa 2 — Estrutura da Parte 1.
 *
 * Agente especializado que segue NA RISCA o prompt mestre da Parte 1
 * (11.500 palavras, 6 capítulos fixos, ritmo rápido→equilibrado→desenvolvido,
 * narração 1ª pessoa FMC, hook obrigatório de 90-120 palavras, questionamento
 * sutil no final).
 *
 * System prompt = regras gerais do projeto (master) + regras específicas
 * da Parte 1 (estrutura1-prompt). User message = Premissa do Step 1 +
 * ajustes/pedidos opcionais do usuário no campo de Instruções.
 */
export const estrutura1Agent: Agent = {
  id: "estrutura1",
  label: "Estrutura — Parte 1",
  description:
    "Monta a estrutura completa da Parte 1 (11.500 palavras, 6 capítulos) seguindo o prompt mestre especializado — hook, mapa, capítulos, cena íntima, questionamento final",
  model: MODELS.opus,
  thinking: "adaptive",
  effort: "medium",
  systemPrompt: ESTRUTURA_MASTER_PROMPT + ESTRUTURA1_PROMPT + CANONE_RULE,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const canoneBlock = buildCanoneBlock(ctx.canone);
    const titulo = extractTituloFromPremissa(premissa);

    // Modo "Continuar de onde parou": a geração anterior foi interrompida e
    // o output parcial está em `currentOutput`. O agente continua exatamente
    // daquele ponto. Verificado ANTES do refineMode porque os dois usam
    // currentOutput, mas com semânticas opostas.
    if (ctx.continuationMode && ctx.currentOutput?.trim()) {
      return buildEstruturaContinuationMessage({
        parteLabel: "PARTE 1",
        partial: ctx.currentOutput,
        userInput: ctx.userInput,
        canone: ctx.canone,
      });
    }

    // Modo correção: a roteirista pediu um ajuste pontual. NÃO é pra regerar
    // a estrutura inteira (~12k palavras de planejamento). O agente devolve
    // APENAS pares <alteracao>/<original>/<corrigido> com find+replace
    // literal — o frontend aplica no output corrente. Os trechos não tocados
    // permanecem byte-a-byte como estavam.
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
          "[trecho EXATO do documento atual — copie literal, com mesma quebra de linha, mesmas aspas, mesmos travessões. Inclua contexto suficiente pra ser único no documento — ex.: o cabeçalho do capítulo + 1 frase do corpo, ou um parágrafo inteiro.]",
          "</original>",
          "<corrigido>",
          "[trecho novo que substitui o original.]",
          "</corrigido>",
          "</alteracao>",
          "",
          "REGRAS RIGOROSAS:",
          "• Inclua um bloco <alteracao> POR cada trecho que muda. Não há limite — pode ser 1, 5, 20.",
          "• <original> precisa ser uma cópia LITERAL do documento atual — qualquer caractere errado faz o find+replace falhar.",
          "• <original> precisa ser ÚNICO no documento. Se o trecho aparece duplicado, expanda <original> com contexto até ficar único.",
          "• NÃO devolva a estrutura inteira. NÃO devolva markdown explicativo fora dos blocos <alteracao>.",
          "• Não invente mudanças que a roteirista não pediu — só toque no que ela pediu.",
          "• Se mudar a contagem de palavras de um capítulo, EMITA TAMBÉM blocos <alteracao> rebalanceando outros capítulos pra manter o total entre 11.300 e 11.700 palavras (REGRA INEGOCIÁVEL).",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai montar a ESTRUTURA da PARTE 1 da história. Toda a regra está no seu system prompt — siga na risca, sem alucinar e sem desvios. A premissa abaixo é a fonte primária do conteúdo. Use o que estiver no campo de instruções adicionais como ajuste opcional.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nA roteirista anexou uma imagem visual de referência (vai chegar como input multimodal antes desta mensagem). USE essa imagem pra calibrar:\n• Mood/atmosfera da história (luz, paleta, peso emocional)\n• Aparência física dos personagens, se a imagem mostrar pessoas\n• Cenário/ambientação se a imagem mostrar locais\n• Estilo de narrativa visual (cinematográfico, intimista, etc)\n\nIntegre os elementos visuais à estrutura sem inventar contradições com a premissa textual. Se imagem e premissa entrarem em conflito, a PREMISSA TEXTUAL prevalece.",
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
          `• O hook principal E a versão alternativa DEVEM expandir este título literal.`,
          `• A primeira frase de cada hook precisa ecoar/traduzir o título — não citar de forma decorativa, não trocar por sinônimos, não suavizar.`,
          `• É proibido inventar outro título, sugerir alternativas ou ignorar este.`,
          `• Antes de fechar o hook, releia: a expansão do título está clara nas 2 versões? Se não, refaça.`,
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
          `• O hook principal E a versão alternativa DEVEM expandir esse título literal.`,
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
      "━━━ AÇÃO ━━━\n\nMonte a ESTRUTURA COMPLETA da Parte 1 seguindo o LAYOUT DE SAÍDA OBRIGATÓRIO definido no system prompt (Mapa → Mundo → Pessoas-Chave → FMC → MMC → Casal → Secundários → Hook → Capítulos → Questionamento → Temas → Arcos → Momentos-chave → Checklist). Comece direto, sem pedir confirmação. Não escreva os capítulos em si — apenas a ESTRUTURA/PLANEJAMENTO.\n\n⚠️ ATENÇÃO CRÍTICA — CONTAGEM DE PALAVRAS: A SOMA das contagens de palavras planejadas para os 6 capítulos DEVE ficar entre 11.300 e 11.700 palavras (ALVO 11.500). Esta é uma REGRA INEGOCIÁVEL. Distribua conforme a tabela do system prompt (~12% / 14% / 18% / 20% / 18% / 18%). Antes de finalizar, SOME mentalmente a quantidade indicada em cada capítulo e CONFIRME que o total está dentro da faixa. Se ficar fora, REDISTRIBUA até bater. Não pule essa verificação.",
    );

    return sections.join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.8,
};
