import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildEstruturaContinuationMessage } from "../continuation-prompt";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { ESTRUTURA_MASTER_PROMPT } from "./estrutura-master-prompt";
import { ESTRUTURA2_PROMPT } from "./estrutura2-prompt";

/**
 * Etapa 3 — Estrutura da Parte 2.
 *
 * Agente especializado que segue NA RISCA o prompt mestre da Parte 2
 * (13.000–13.500 palavras, 6 capítulos, narração 1ª pessoa alternando
 * FMC + MMC com 2-4 trechos do MMC, hook de 90-140 palavras, cena íntima
 * em posição flexível (definida pela curva de química), final feliz/epílogo no último).
 *
 * System prompt = regras gerais do projeto (master) + regras específicas
 * da Parte 2 (estrutura2-prompt). User message = Premissa do Step 1 +
 * Estrutura da Parte 1 do Step 2 + ajustes/pedidos opcionais do usuário no
 * campo de Instruções.
 */
export const estrutura2Agent: Agent = {
  id: "estrutura2",
  label: "Estrutura — Parte 2",
  description:
    "Monta a estrutura completa da Parte 2 (13.000–13.500 palavras, 6 capítulos) seguindo o prompt mestre especializado — hook, mapa com narrador, alternância FMC/MMC, cena íntima em posição flexível, epílogo/final feliz",
  model: MODELS.opus,
  thinking: "adaptive",
  effort: "medium",
  systemPrompt: ESTRUTURA_MASTER_PROMPT + ESTRUTURA2_PROMPT + CANONE_RULE,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const estrutura1 = ctx.previousOutputs.estrutura1?.content?.trim() ?? "";
    const canoneBlock = buildCanoneBlock(ctx.canone);

    // Modo "Continuar de onde parou": geração anterior interrompida. Continua
    // a partir do partial em `currentOutput` sem repetir nem recomeçar.
    if (ctx.continuationMode && ctx.currentOutput?.trim()) {
      return buildEstruturaContinuationMessage({
        parteLabel: "PARTE 2",
        partial: ctx.currentOutput,
        userInput: ctx.userInput,
        canone: ctx.canone,
      });
    }

    // Modo correção: a roteirista pediu um ajuste pontual. NÃO é pra regerar
    // a estrutura inteira. O agente devolve APENAS pares <alteracao>/<original>
    // /<corrigido> com find+replace literal — o frontend aplica no output
    // corrente. Trechos não tocados permanecem byte-a-byte como estavam.
    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const refine: string[] = [];
      refine.push(
        "Você JÁ entregou uma versão dessa ESTRUTURA da PARTE 2. A roteirista pediu uma CORREÇÃO PONTUAL. NÃO regere a estrutura inteira. Devolva APENAS as alterações no formato XML descrito abaixo — o app aplica via find+replace literal no documento corrente.",
      );
      refine.push(
        `━━━ ESTRUTURA ATUAL — PARTE 2 (consulte mas NÃO devolva inteira) ━━━\n\n${ctx.currentOutput.trim()}`,
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
      if (estrutura1) {
        refine.push(
          `━━━ ESTRUTURA DA PARTE 1 APROVADA (Step 2 — referência de coerência) ━━━\n\n${estrutura1}`,
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
          "• Inclua um bloco <alteracao> POR cada trecho que muda — pode ser 1, 5, 20.",
          "• <original> precisa ser uma cópia LITERAL do documento atual — qualquer caractere errado faz o find+replace falhar.",
          "• <original> precisa ser ÚNICO no documento. Se aparece duplicado, expanda com contexto até ficar único.",
          "• NÃO devolva a estrutura inteira. NÃO devolva markdown explicativo fora dos blocos <alteracao>.",
          "• Se mudar a contagem de palavras de um capítulo, EMITA TAMBÉM blocos <alteracao> rebalanceando outros capítulos pra manter o total entre 13.000 e 13.500 palavras (REGRA INEGOCIÁVEL — Parte 2 NUNCA pode cair fora dessa faixa).",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai montar a ESTRUTURA da PARTE 2 da história. Toda a regra está no seu system prompt — siga na risca, sem alucinar e sem desvios. A Estrutura da Parte 1 (do Step 2) é fonte de verdade e a premissa do Step 1 é o conteúdo base. Use o que estiver no campo de instruções adicionais como ajuste opcional.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nA roteirista anexou uma imagem visual de referência (vai chegar como input multimodal antes desta mensagem). Mantenha COERÊNCIA com a Parte 1 que já usou essa imagem — mesmo mood, mesma paleta, mesma aparência dos personagens. Use a imagem pra sustentar a continuidade visual da Parte 2 (especialmente na cena íntima e no epílogo). Em conflito entre imagem e texto, o TEXTO prevalece.",
      );
    }

    if (canoneBlock) {
      sections.push(canoneBlock);
    }

    if (premissa) {
      sections.push(
        `━━━ PREMISSA APROVADA (Step 1) ━━━\n\n${premissa}`,
      );
    } else {
      sections.push(
        "━━━ PREMISSA ━━━\n\n⚠️ Não fornecida. Avise no topo da estrutura que a premissa não foi fornecida e siga gerando o melhor possível com base na Parte 1 e nas instruções da roteirista.",
      );
    }

    if (estrutura1) {
      sections.push(
        `━━━ ESTRUTURA DA PARTE 1 APROVADA (Step 2 — fonte de verdade para coerência) ━━━\n\n${estrutura1}`,
      );
    } else {
      sections.push(
        "━━━ ESTRUTURA DA PARTE 1 ━━━\n\n⚠️ Não fornecida. Marque no topo da estrutura: \"⚠️ ATENÇÃO: a Estrutura da Parte 1 não foi enviada. Esta estrutura foi feita sem ela e pode contradizer o material da Parte 1.\" — e siga gerando.",
      );
    }

    if (ctx.userInput?.trim()) {
      sections.push(
        `━━━ INSTRUÇÕES ADICIONAIS DA ROTEIRISTA (ajustes opcionais) ━━━\n\n${ctx.userInput.trim()}`,
      );
    }

    sections.push(
      "━━━ AÇÃO ━━━\n\nMonte a ESTRUTURA COMPLETA da Parte 2 seguindo o LAYOUT DE SAÍDA OBRIGATÓRIO definido no system prompt (Mapa com narrador → Hook/Isca → Ponto de Retomada → Distribuição POVs do MMC → Conflitos herdados → Capítulos → Cena Íntima → Easter Eggs → Entrega Final → Resolução → Checklist). Comece direto, sem pedir confirmação. NÃO escreva os capítulos em si — apenas a ESTRUTURA/PLANEJAMENTO.\n\n⚠️ ATENÇÃO CRÍTICA — CONTAGEM DE PALAVRAS: a SOMA das contagens planejadas para os capítulos DEVE ficar entre 13.000 e 13.500 palavras. ZERO tolerância pra fora dessa faixa. Capítulos: EXATAMENTE 6 — nunca menos, nunca mais. Antes de finalizar, SOME mentalmente a contagem de cada capítulo e CONFIRME que o total cabe na faixa 13.000–13.500. Se ficar abaixo, AUMENTE algum(s) capítulo(s); se ficar acima, REDUZA. Não pule essa verificação.",
    );

    return sections.join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.8,
};
