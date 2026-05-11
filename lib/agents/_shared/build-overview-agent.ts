/**
 * Factory do agente Overview Final — 7º e último step do wizard, roda depois
 * dos dois Revisores. Faz uma revisão estrutural rápida do roteiro INTEIRO
 * (Parte 1 + Parte 2 juntas em uma única chamada) procurando erros de cópia,
 * edição, duplicação e nomes errados que escapam dos Revisores literários.
 *
 * Único e compartilhado entre as 3 categorias — o prompt não depende de
 * símbolos de gravidade nem regras de palavras-por-Parte. Padrão precedente
 * de factory compartilhada: build-revisor-agent.ts.
 */

import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildCanoneBlock } from "./canone-block";
import { OVERVIEW_SYSTEM_PROMPT } from "./overview-prompt";

export function buildOverviewAgent(): Agent {
  return {
    id: "overview",
    label: "Overview Final",
    description:
      "Revisão estrutural rápida do roteiro completo (P1+P2) — busca apenas erros de cópia, edição, repetição e nomes errados. Não analisa estilo nem ritmo.",
    model: MODELS.sonnet,
    thinking: "disabled",
    effort: "low",
    systemPrompt: OVERVIEW_SYSTEM_PROMPT,
    acceptsReferenceImage: false,
    buildUserMessage: (ctx) => {
      const escrita = ctx.previousOutputs.escrita?.content?.trim() ?? "";
      const canoneBlock = buildCanoneBlock(ctx.canone);

      const sections: string[] = [];

      sections.push(
        "Você vai fazer a revisão ESTRUTURAL do roteiro completo abaixo (Parte 1 + Parte 2 juntas — o roteiro já passou pelos dois Revisores literários e algumas correções podem já ter sido aplicadas). Aplique EXATAMENTE os critérios do system prompt. NÃO comente sobre estilo, ritmo, voz ou qualidade narrativa. Liste em tópicos APENAS os erros estruturais encontrados.",
      );

      if (canoneBlock) {
        sections.push(canoneBlock);
      }

      if (escrita) {
        sections.push(
          `━━━ ROTEIRO COMPLETO (Parte 1 + Parte 2) ━━━\n\n${escrita}`,
        );
      } else {
        sections.push(
          "━━━ ROTEIRO COMPLETO ━━━\n\n⚠️ Nenhum roteiro foi encontrado no Step 4 (Escrita). Avise a roteirista que precisa gerar o roteiro antes de rodar a Overview Final. NÃO invente conteúdo.",
        );
      }

      if (ctx.userInput?.trim()) {
        sections.push(
          `━━━ FOCO EXTRA DA ROTEIRISTA (opcional) ━━━\n\n${ctx.userInput.trim()}`,
        );
      }

      sections.push(
        "━━━ AÇÃO ━━━\n\nFaça a varredura estrutural agora. Liste em tópicos APENAS os erros encontrados nas categorias do system prompt. Comece direto pela lista — sem preâmbulo, sem análise literária, sem sugestões criativas. Se nenhum erro estrutural for detectado, responda exatamente: \"Nenhum erro estrutural encontrado.\"",
      );

      return sections.join("\n\n");
    },
    maxTokens: 12000,
    temperature: 0.2,
  };
}
