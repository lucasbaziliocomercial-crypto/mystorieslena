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
import { buildPersonagensBlock } from "./personagens-block";
import { OVERVIEW_SYSTEM_PROMPT } from "./overview-prompt";
import { buildRefinePatchPrompt } from "./refine-patch-prompt";

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
      const personagensBlock = buildPersonagensBlock(ctx.personagens);

      // Modo correção pontual: roteirista quer mexer no relatório atual sem
      // refazer a varredura inteira (ex.: remover um erro, ajustar a redação
      // de uma sugestão, atualizar um trecho_corrigido). Devolve patches XML.
      if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
        const extraRules: string[] = [
          "Preserve as seções obrigatórias: `📋 ERROS ESTRUTURAIS ENCONTRADOS` (bullets) e `🔧 CORREÇÕES APLICÁVEIS (XML)` (bloco <erros_detalhados>). Não as remova.",
          "Se mexer em um <erro> do bloco <erros_detalhados>, lembre que o <original> precisa incluir o <erro>...</erro> INTEIRO pra remover, ou apenas o campo (ex.: <trecho_corrigido>) pra editar.",
          "Se um erro foi listado nos bullets E no XML, atualize OS DOIS — emita um <alteracao> por lado.",
        ];
        if (canoneBlock) {
          extraRules.push(
            "Cânone de entidades disponível — use pra checar nomes/idades/lugares/datas se a correção pedir.",
          );
        }
        const refine: string[] = [];
        refine.push(
          buildRefinePatchPrompt({
            currentLabel: "OVERVIEW ATUAL (relatório que você já entregou)",
            currentOutput: ctx.currentOutput,
            userInstruction: ctx.userInput,
            extraRules,
          }),
        );
        if (canoneBlock) {
          refine.push(canoneBlock);
        }
        if (personagensBlock) {
          refine.push(personagensBlock);
        }
        if (escrita) {
          refine.push(
            `━━━ ROTEIRO COMPLETO (Parte 1 + Parte 2 — referência, consulte se a correção pedir releitura) ━━━\n\n${escrita}`,
          );
        }
        return refine.join("\n\n");
      }

      const sections: string[] = [];

      sections.push(
        "Você vai fazer a revisão ESTRUTURAL do roteiro completo abaixo (Parte 1 + Parte 2 juntas — o roteiro já passou pelos dois Revisores literários e algumas correções podem já ter sido aplicadas). Aplique EXATAMENTE os critérios do system prompt. NÃO comente sobre estilo, ritmo, voz ou qualidade narrativa. Entregue no FORMATO OBRIGATÓRIO do system prompt: primeiro a lista em tópicos, depois o bloco XML <erros_detalhados> com cada erro estruturado pra a UI aplicar 1-clique.",
      );

      if (canoneBlock) {
        sections.push(canoneBlock);
      }

      if (personagensBlock) {
        sections.push(personagensBlock);
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
        "━━━ AÇÃO ━━━\n\nFaça a varredura estrutural agora. Entregue:\n1) Seção \"📋 ERROS ESTRUTURAIS ENCONTRADOS\" em markdown com bullets — um por erro, citando localização e trecho-evidência curto.\n2) Seção \"🔧 CORREÇÕES APLICÁVEIS (XML)\" com o bloco <erros_detalhados> — um <erro> por item da lista, com trecho_original literal e trecho_corrigido plug-and-play.\n\nSe NENHUM erro estrutural for encontrado, responda apenas \"Nenhum erro estrutural encontrado.\" e pule o XML. Comece direto pela seção de erros — sem preâmbulo, sem análise literária, sem sugestões criativas.",
      );

      return sections.join("\n\n");
    },
    maxTokens: 12000,
    temperature: 0.2,
  };
}
