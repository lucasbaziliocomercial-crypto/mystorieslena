import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildEstruturaContinuationMessage } from "../continuation-prompt";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { ESTRUTURA_MASTER_PROMPT } from "./estrutura-master-prompt";
import { ESTRUTURA2_PROMPT } from "./estrutura2-prompt";

/**
 * Etapa 3 — Estrutura da Parte 2 (Romance de Milionário 3ª pessoa, canal Rowan).
 *
 * 13.500 palavras (faixa 13.000-14.000, alvo 13.500), 6 capítulos.
 * Abertura com BOMBA, narração em terceira pessoa ONISCIENTE (narrador acessa
 * a mente da FMC E do MMC — só na Parte 2; a Parte 1 segue limitada à FMC),
 * cena erótica em posição flexível, final feliz no último cap
 * (casamento + filhos / lua de mel / sonho realizado).
 *
 * System prompt = master M3P + estrutura2 M3P.
 */
export const estrutura2Agent: Agent = {
  id: "estrutura2",
  label: "Estrutura — Parte 2",
  description:
    "Monta a estrutura completa da Parte 2 de Milionário 3p (13.000-14.000 palavras, alvo 13.500, 6 capítulos) — bomba inicial, mapa cena por cena, cena erótica em posição flexível, final feliz com casamento/filhos/sonho. Narração 3ª pessoa ONISCIENTE (acessa FMC e MMC; só na Parte 2 — a Parte 1 segue limitada à FMC).",
  model: MODELS.opus,
  thinking: "adaptive",
  effort: "medium",
  systemPrompt: ESTRUTURA_MASTER_PROMPT + ESTRUTURA2_PROMPT + CANONE_RULE,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const estrutura1 = ctx.previousOutputs.estrutura1?.content?.trim() ?? "";
    const canoneBlock = buildCanoneBlock(ctx.canone);

    if (ctx.continuationMode && ctx.currentOutput?.trim()) {
      return buildEstruturaContinuationMessage({
        parteLabel: "PARTE 2",
        partial: ctx.currentOutput,
        userInput: ctx.userInput,
        canone: ctx.canone,
      });
    }

    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const refine: string[] = [];
      refine.push(
        "Você JÁ entregou uma versão dessa ESTRUTURA da PARTE 2. A roteirista pediu uma CORREÇÃO PONTUAL. NÃO regere a estrutura inteira. Devolva APENAS as alterações no formato XML descrito abaixo.",
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
          "[trecho EXATO do documento atual — copie literal.]",
          "</original>",
          "<corrigido>",
          "[trecho novo que substitui o original.]",
          "</corrigido>",
          "</alteracao>",
          "",
          "REGRAS RIGOROSAS:",
          "• Inclua um bloco <alteracao> POR cada trecho que muda.",
          "• <original> precisa ser cópia LITERAL do documento atual.",
          "• <original> precisa ser ÚNICO no documento.",
          "• NÃO devolva a estrutura inteira.",
          "• Se mudar a contagem de palavras de um capítulo, EMITA TAMBÉM blocos rebalanceando outros para manter o total entre 13.000 e 14.000 palavras (alvo 13.500, REGRA INEGOCIÁVEL — Parte 2 NUNCA pode cair fora dessa faixa).",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai montar a ESTRUTURA da PARTE 2 da história de romance de milionário em 3ª pessoa. Toda a regra está no seu system prompt — siga na risca. A Estrutura da Parte 1 (do Step 2) é fonte de verdade e a premissa do Step 1 é o conteúdo base. Use o campo de instruções adicionais como ajuste opcional.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nA imagem foi usada na Parte 1 — mantenha COERÊNCIA com mood, paleta e aparência dos personagens. Use a imagem pra sustentar continuidade visual da Parte 2 (especialmente na cena íntima e no epílogo). Em conflito, o TEXTO prevalece.",
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
      "━━━ AÇÃO ━━━\n\nMonte a ESTRUTURA COMPLETA da Parte 2 seguindo o LAYOUT DE SAÍDA OBRIGATÓRIO definido no system prompt (Bomba → Ponto de Retomada → Conflitos Herdados → Mapa cena por cena → Capítulos → Cena Erótica → Easter Eggs → Entrega Final → Resolução). Comece direto. NÃO escreva os capítulos em si — apenas a ESTRUTURA/PLANEJAMENTO.\n\n⚠️ ATENÇÃO CRÍTICA — CONTAGEM DE PALAVRAS: a SOMA das contagens declaradas DEVE ficar entre 13.000 e 14.000 palavras (alvo 13.500). ZERO tolerância — nunca abaixo de 13.000 nem acima de 14.000. Capítulos: EXATAMENTE 6 — nunca menos, nunca mais. Cada um dos 6 capítulos com MÍNIMO ~2.000 palavras — nenhum capítulo (nem o último) pode ficar muito mais curto que os outros; o último NÃO é um epílogo curto. Antes de finalizar, SOME mentalmente e CONFIRME que cabe na faixa. Se abaixo, AUMENTE algum cap; se acima, REDUZA.\n\n⚠️ NARRAÇÃO em TERCEIRA PESSOA ONISCIENTE — narrador externo invisível que acessa a mente da FMC E do MMC, alternando o foco de forma fluida (nenhum personagem narra; sem 1ª pessoa na narração; sem blocos ✦ NOME). Este regime onisciente vale SÓ para a Parte 2 — a Parte 1 permanece limitada à FMC. A cena erótica tem posição FLEXÍVEL (segue a curva de química, nunca nos primeiros capítulos, nunca no epílogo).",
    );

    return sections.join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.8,
};
