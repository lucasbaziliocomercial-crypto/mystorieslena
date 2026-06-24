/**
 * Registry central das categorias suportadas pelo gerador.
 *
 * Cada categoria carrega:
 *  • Os 5 agentes da pipeline (premissa, estrutura1, estrutura2, escrita, revisor)
 *  • Configuração de contagem de palavras por Parte
 *  • Prompts auxiliares (escrita system prompt, revisor-extract) consumidos
 *    diretamente por endpoints sem montar Agent
 *  • Metadados de UI (label, description)
 *
 * Para adicionar uma nova categoria:
 *  1. Criar `lib/agents/<id>/` com os 5 agentes + prompts.
 *  2. Importar agentes e prompts aqui.
 *  3. Acrescentar entrada em `CATEGORIES`.
 *  4. Listar o ID em `RoteiroCategory` (lib/categories/types.ts).
 */

import {
  milionario1pAgents,
  milionario1pEscritaSystemPrompt,
  milionario1pRevisorExtract,
} from "@/lib/agents/milionario1p";
import {
  mafiaAgents,
  mafiaEscritaSystemPrompt,
  mafiaRevisorExtract,
} from "@/lib/agents/mafia";
import {
  milionario3pAgents,
  milionario3pEscritaSystemPrompt,
  milionario3pRevisorExtract,
} from "@/lib/agents/milionario3p";
import {
  alphaKingAgents,
  alphaKingEscritaSystemPrompt,
  alphaKingRevisorExtract,
} from "@/lib/agents/alphaking";
import type { StepId } from "@/types/roteiro";
import type { Agent } from "@/lib/agents/types";
import type { CategoryConfig, RoteiroCategory } from "./types";

export const CATEGORIES: Record<RoteiroCategory, CategoryConfig> = {
  "milionario-1p": {
    id: "milionario-1p",
    label: "Romance de Milionário (1ª pessoa)",
    channels: "Kay",
    description:
      "Duologia em 1ª pessoa pela FMC, estilo Helô Stories™. Parte 1 com 12.000 a 13.000 palavras (gratuita), Parte 2 com 13.250 palavras (paga). Hook com expansão do título, cena íntima sugerida na Parte 1 e completa na Parte 2.",
    agents: milionario1pAgents,
    escritaSystemPrompt: milionario1pEscritaSystemPrompt,
    wordCount: {
      parte1: { min: 12000, max: 13000, target: 12500 },
      parte2: { min: 13000, max: 13500, target: 13250 },
    },
  },
  "milionario-3p": {
    id: "milionario-3p",
    label: "Romance de Milionário (3ª pessoa)",
    channels: "Rowan",
    description:
      "Duologia em 3ª pessoa LIMITADA À FMC nas DUAS partes (sem POV masculino — MMC observado de fora pelos atos), estilo Helô Stories™. Mesmo universo de poder e riqueza do 1p. Parte 1 com 10.000 a 11.000 palavras (gratuita), Parte 2 com 13.500 palavras (paga, teto 14.000). Premissa bifásica (resumos ≤500 palavras + obrigações de estrutura), escrita 2-em-2, Revisor com símbolos 🟢🟡🔴💀.",
    agents: milionario3pAgents,
    escritaSystemPrompt: milionario3pEscritaSystemPrompt,
    wordCount: {
      parte1: { min: 10000, max: 11000, target: 10500 },
      parte2: { min: 13000, max: 14000, target: 13500 },
    },
  },
  mafia: {
    id: "mafia",
    label: "Romance de Máfia",
    channels: "Lena v1, v2 e v3",
    description:
      "Dark romance de máfia, duologia em 1ª pessoa pela FMC com até 4 narrações do MMC na Parte 2. Mundo mafioso convincente (Cosa Nostra, Bratva, Camorra, Sicília). Parte 1 com 12.000 a 13.000 palavras, Parte 2 com 13.500 palavras.",
    agents: mafiaAgents,
    escritaSystemPrompt: mafiaEscritaSystemPrompt,
    wordCount: {
      parte1: { min: 12000, max: 13000, target: 12500 },
      parte2: { min: 13300, max: 13700, target: 13500 },
    },
  },
  "alpha-king": {
    id: "alpha-king",
    label: "Romance Alpha King (Werewolf)",
    channels: "Alpha King",
    description:
      "Duologia werewolf Alpha King, 1ª pessoa pela FMC (futura Luna) com 2–4 narrações do Alpha King na Parte 2. Universo de alcateias, Moon Goddess, vínculo de mate, rejeição e marcação. Parte 1 com 11.500 palavras (6 caps), Parte 2 com 13.000–13.500 (5–6 caps). Premissa bifásica, escrita 2-em-2, Revisor com símbolos 🟢🟡🔴💀.",
    agents: alphaKingAgents,
    escritaSystemPrompt: alphaKingEscritaSystemPrompt,
    wordCount: {
      parte1: { min: 11300, max: 11700, target: 11500 },
      parte2: { min: 13000, max: 13500, target: 13500 },
    },
  },
};

export const CATEGORY_ORDER: RoteiroCategory[] = [
  "milionario-1p",
  "milionario-3p",
  "mafia",
  "alpha-king",
];

export function getCategory(id: RoteiroCategory): CategoryConfig {
  return CATEGORIES[id];
}

export function getCategoryAgent(
  category: RoteiroCategory,
  step: StepId,
): Agent {
  return CATEGORIES[category].agents[step];
}

/**
 * Quem precisa do prompt da Escrita sem montar Agent
 * (endpoint /api/escrita-fix-wordcount). Centralizado aqui para que a
 * troca por categoria seja uma única lookup.
 */
export function getCategoryEscritaSystemPrompt(
  category: RoteiroCategory,
): string {
  return CATEGORIES[category].escritaSystemPrompt;
}

/**
 * Mesma lógica para o fallback de extração estruturada do Revisor,
 * exposto pelo endpoint /api/revisor-extract-errors. Cada categoria
 * carrega seu próprio mapeamento de emojis (a Máfia usa 🔴/💀 onde a
 * milionário usa 🟠/🔴).
 */
export function getCategoryRevisorExtract(category: RoteiroCategory): {
  systemPrompt: string;
  buildUserMessage: (params: {
    revisaoMarkdown: string;
    escritaContent: string;
  }) => string;
} {
  if (category === "mafia") return mafiaRevisorExtract;
  if (category === "milionario-3p") return milionario3pRevisorExtract;
  if (category === "alpha-king") return alphaKingRevisorExtract;
  return milionario1pRevisorExtract;
}

export type { CategoryConfig, RoteiroCategory } from "./types";
