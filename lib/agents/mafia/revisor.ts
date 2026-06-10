import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE, CANONE_REVISOR_CHECKLIST } from "../_shared/canone-rule";
import { REVISOR_SYSTEM_PROMPT } from "./revisor-prompt";

/**
 * Template do agente Revisor (Romance de Máfia).
 *
 * Editor literário rigoroso de dark romance de máfia. Aplica 4 graus de
 * classificação (🟢 não interfere, 🟡 atenção, 🔴 interfere, 💀 gravíssimo
 * — note que difere do milionário no terceiro/quarto graus). Numera
 * sequencialmente, dá nota final, mede risco de hate.
 *
 * A factory `buildRevisorAgent` gera dois Agents (revisor1, revisor2) a
 * partir deste template — cada um focado em uma Parte só.
 */
export const revisorAgentTemplate: Omit<Agent, "id"> = {
  label: "Revisor",
  description:
    "Editor literário rigoroso de máfia — revisa o roteiro completo classificando erros em 4 graus (🟢 / 🟡 / 🔴 / 💀), numerando sequencialmente, com análise de leitor real, hater e nota final 0-10",
  model: MODELS.opus,
  thinking: "disabled",
  effort: "low",
  systemPrompt: REVISOR_SYSTEM_PROMPT + CANONE_RULE + CANONE_REVISOR_CHECKLIST,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const estrutura1 = ctx.previousOutputs.estrutura1?.content?.trim() ?? "";
    const estrutura2 = ctx.previousOutputs.estrutura2?.content?.trim() ?? "";
    const escrita = ctx.previousOutputs.escrita?.content?.trim() ?? "";
    const canoneBlock = buildCanoneBlock(ctx.canone);

    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const refine: string[] = [];
      refine.push(
        "Você JÁ entregou uma revisão completa do roteiro. A roteirista pediu uma CORREÇÃO PONTUAL na sua revisão. NÃO regere a revisão inteira. Devolva APENAS as alterações no formato XML descrito abaixo.",
      );
      refine.push(
        `━━━ SUA REVISÃO ATUAL (consulte mas NÃO devolva inteira) ━━━\n\n${ctx.currentOutput.trim()}`,
      );
      refine.push(
        `━━━ INSTRUÇÃO DE CORREÇÃO DA ROTEIRISTA ━━━\n\n${ctx.userInput.trim()}`,
      );
      if (escrita) {
        refine.push(
          `━━━ ROTEIRO REVISADO (Step 4 — referência, consulte se a correção pedir releitura) ━━━\n\n${escrita}`,
        );
      }
      if (canoneBlock) {
        refine.push(canoneBlock);
      }
      if (premissa) {
        refine.push(
          `━━━ PREMISSA APROVADA (Step 1 — referência) ━━━\n\n${premissa}`,
        );
      }
      if (estrutura1) {
        refine.push(
          `━━━ ESTRUTURA DA PARTE 1 APROVADA (Step 2 — referência) ━━━\n\n${estrutura1}`,
        );
      }
      if (estrutura2) {
        refine.push(
          `━━━ ESTRUTURA DA PARTE 2 APROVADA (Step 3 — referência) ━━━\n\n${estrutura2}`,
        );
      }
      refine.push(
        [
          "━━━ FORMATO DE SAÍDA OBRIGATÓRIO ━━━",
          "",
          "Para cada trecho da revisão que precisa mudar, emita um bloco:",
          "",
          "<alteracao>",
          "<descricao>linha curta explicando o que muda</descricao>",
          "<original>",
          "[trecho EXATO da revisão atual — copie literal, com mesma quebra de linha, mesmas aspas, mesmos emojis (🟢🟡🔴💀), mesmos travessões. Se for remover um <erro> do bloco <erros_detalhados>, copie o <erro>...</erro> INTEIRO no <original>.]",
          "</original>",
          "<corrigido>",
          "[trecho novo que substitui o original. Pode ser vazio (string vazia) se a intenção é REMOVER o trecho.]",
          "</corrigido>",
          "</alteracao>",
          "",
          "EXEMPLOS DE USO:",
          "",
          "1) Remover um erro do bloco <erros_detalhados>: <original> = `<erro><numero>3</numero>...</erro>` inteiro / <corrigido> = vazio.",
          "2) Reclassificar um erro de 🔴 pra 🟡: <original> = `## 🔴 INTERFERE — Erro #5: ...` / <corrigido> = `## 🟡 ATENÇÃO — Erro #5: ...`.",
          "3) Atualizar a Nota Final: <original> = `Nota Final: 7.5/10` / <corrigido> = `Nota Final: 8.0/10`.",
          "4) Adicionar um novo erro ao XML: <original> = `</erros_detalhados>` / <corrigido> = `<erro>...</erro>\\n</erros_detalhados>`.",
          "",
          "REGRAS RIGOROSAS:",
          "• Inclua um bloco <alteracao> POR cada trecho que muda.",
          "• <original> precisa ser cópia LITERAL.",
          "• <original> precisa ser ÚNICO na revisão.",
          "• NÃO devolva a revisão inteira. NÃO devolva markdown explicativo fora dos blocos.",
          "• Se mexer em uma classificação ou erro, considere se a Nota Final ou o Risco de Hate precisa ser recalculado.",
          "• Se a correção pedida não exigir alteração nenhuma, devolva apenas a string [NENHUMA_ALTERACAO_NECESSARIA] e nada mais.",
          "",
          "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    const sections: string[] = [];

    sections.push(
      "Você vai revisar o roteiro abaixo com rigor TOTAL, aplicando todos os critérios do seu system prompt na risca. Use os materiais de referência (Premissa + Estruturas) para verificação de coerência. Entregue no FORMATO OBRIGATÓRIO definido no system prompt.",
    );

    if (ctx.referenceImage) {
      sections.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nVerifique se descrições físicas dos personagens batem com a aparência da imagem, mood/atmosfera/paleta refletida na narrativa, sem contradições visuais. Inconsistências entre imagem e roteiro: classifique conforme os 4 graus (🟢 / 🟡 / 🔴 / 💀).",
      );
    }

    if (escrita) {
      sections.push(
        `━━━ MATERIAL A REVISAR (vindo do Step 4 — Escrita) ━━━\n\n${escrita}`,
      );
    } else {
      sections.push(
        "━━━ MATERIAL A REVISAR ━━━\n\n⚠️ Nenhum roteiro foi encontrado no Step 4 (Escrita). Avise o usuário que precisa gerar o roteiro antes da revisão. NÃO invente conteúdo.",
      );
    }

    if (canoneBlock) {
      sections.push(canoneBlock);
    }

    if (premissa) {
      sections.push(
        `━━━ REFERÊNCIA — PREMISSA APROVADA (Step 1) ━━━\n\n${premissa}`,
      );
    }
    if (estrutura1) {
      sections.push(
        `━━━ REFERÊNCIA — ESTRUTURA DA PARTE 1 APROVADA (Step 2) ━━━\n\n${estrutura1}`,
      );
    }
    if (estrutura2) {
      sections.push(
        `━━━ REFERÊNCIA — ESTRUTURA DA PARTE 2 APROVADA (Step 3) ━━━\n\n${estrutura2}`,
      );
    }

    if (ctx.userInput?.trim()) {
      sections.push(
        `━━━ INSTRUÇÕES ADICIONAIS DA ROTEIRISTA (foco específico, opcional) ━━━\n\n${ctx.userInput.trim()}`,
      );
    }

    // Modo "Continuar revisão": força foco em erros NOVOS (não-equivalentes
    // aos já destacados em rodadas anteriores). Mesma lógica das outras categorias.
    if (ctx.previousRevisorErrors && ctx.previousRevisorErrors.length > 0) {
      const list = ctx.previousRevisorErrors
        .map((title, i) => `  ${i + 1}. ${title}`)
        .join("\n");
      sections.push(
        [
          "━━━ ERROS JÁ DESTACADOS EM REVISÕES ANTERIORES — NÃO REPITA ━━━",
          "",
          "A roteirista já leu, considerou e (em parte) corrigiu os erros abaixo em rodadas anteriores desta revisão. NÃO os liste de novo na sua resposta — ela está clicando 'Continuar revisão' justamente pra ver erros DIFERENTES, refinar aspectos que você ainda não cobriu, e fazer a Nota Final progredir.",
          "",
          list,
          "",
          "REGRAS PARA ESTA RODADA:",
          "• NÃO inclua na sua resposta erros equivalentes aos da lista acima — mesmo que o trecho exato seja outro, se o tipo do erro/diagnóstico já foi feito, pule.",
          "• Foque em aspectos NOVOS que você não destacou antes: detalhes mais sutis, refinamentos de ritmo/voz/imersão, inconsistências secundárias, oportunidades de elevação que ficaram invisíveis nas primeiras passadas.",
          "• Se o roteiro já está em forma muito boa e você genuinamente não encontra erros novos significativos, declare isso explicitamente na seção PRINCIPAIS ERROS (\"Não há erros relevantes além dos já apontados em rodadas anteriores\") e atribua uma Nota Final alta condizente.",
          "• A Nota Final deve refletir o estado ATUAL do roteiro — se ele melhorou desde a primeira revisão, a nota sobe. Se piorou em algum aspecto novo, abaixa.",
          "• Mantenha o formato obrigatório e o bloco XML <erros_detalhados> normalmente — só com erros NOVOS.",
        ].join("\n"),
      );
    }

    sections.push(
      "━━━ AÇÃO ━━━\n\nFaça a revisão completa do roteiro acima cruzando com a premissa e as estruturas. Classifique TODOS os erros pelo grau correto (🟢 / 🟡 / 🔴 / 💀), numere sequencialmente (apenas 🟡, 🔴 e 💀), entregue no formato obrigatório (Principais Erros → Sugestões → Análise como Leitor Real → Análise de Hater → Risco de Hate → Nota Final → bloco <erros_detalhados>). Seja brutalmente honesto. Não peça confirmação. Comece direto.",
    );

    return sections.join("\n\n");
  },
  maxTokens: 32000,
  temperature: 0.4,
};
