/**
 * Categoria: Romance de Milionário em 1ª pessoa (estilo Helô Stories™).
 *
 * Reúne os 6 agentes da categoria — premissa, estrutura1, estrutura2,
 * escrita, revisor1, revisor2 — junto com o prompt da Escrita exposto
 * separadamente (usado pelo endpoint /api/escrita-fix-wordcount sem montar
 * Agent) e o par de extração estruturada do Revisor (fallback
 * /api/revisor-extract-errors).
 *
 * O step "revisor" foi dividido em revisor1 e revisor2 — a factory
 * `buildRevisorAgent` gera os dois Agents a partir de um único template,
 * filtrando os capítulos por Parte e prefixando uma instrução de escopo.
 */

import type { StepId } from "@/types/roteiro";
import type { Agent } from "../types";
import { premissaAgent } from "./premissa";
import { estrutura1Agent } from "./estrutura1";
import { estrutura2Agent } from "./estrutura2";
import { escritaAgent } from "./escrita";
import { revisorAgentTemplate } from "./revisor";
import { buildRevisorAgent } from "../_shared/build-revisor-agent";
import { buildOverviewAgent } from "../_shared/build-overview-agent";
import { ESCRITA_SYSTEM_PROMPT } from "./escrita-prompt";
import {
  REVISOR_EXTRACT_SYSTEM_PROMPT,
  buildRevisorExtractUserMessage,
} from "./revisor-extract-prompt";

export const milionario1pAgents: Record<StepId, Agent> = {
  premissa: premissaAgent,
  estrutura1: estrutura1Agent,
  estrutura2: estrutura2Agent,
  escrita: escritaAgent,
  revisor1: buildRevisorAgent({ template: revisorAgentTemplate, part: 1 }),
  revisor2: buildRevisorAgent({ template: revisorAgentTemplate, part: 2 }),
  overview: buildOverviewAgent(),
};

export const milionario1pEscritaSystemPrompt = ESCRITA_SYSTEM_PROMPT;

export const milionario1pRevisorExtract = {
  systemPrompt: REVISOR_EXTRACT_SYSTEM_PROMPT,
  buildUserMessage: buildRevisorExtractUserMessage,
};
