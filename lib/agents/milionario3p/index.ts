/**
 * Categoria: Romance de Milionário 3ª pessoa (canal Rowan, estilo Helô Stories™).
 *
 * Reúne os 5 agentes — premissa, estrutura1, estrutura2, escrita, revisor —
 * junto com o prompt da Escrita exposto separadamente (consumido por
 * /api/escrita-fix-wordcount) e o par de extração estruturada do Revisor
 * (fallback /api/revisor-extract-errors).
 *
 * NARRAÇÃO: Terceira pessoa LIMITADA À FMC nas DUAS partes (sem exceção).
 * Sem POV masculino, sem alternância, sem mudança de regime entre Parte 1
 * e Parte 2. O MMC é mostrado apenas pelos atos, falas e gestos observáveis
 * — o leitor nunca entra na cabeça dele, nem na cena erótica do penúltimo
 * capítulo da Parte 2. Conforme a Premissa Narrativa Obrigatória do guia.
 *
 * Word counts: P1 9.500–10.500 palavras (alvo 10.500), P2 13.000–14.000
 * (alvo 13.500). Símbolos do Revisor: 🟢🟡🔴💀.
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

export const milionario3pAgents: Record<StepId, Agent> = {
  premissa: premissaAgent,
  estrutura1: estrutura1Agent,
  estrutura2: estrutura2Agent,
  escrita: escritaAgent,
  revisor1: buildRevisorAgent({ template: revisorAgentTemplate, part: 1 }),
  revisor2: buildRevisorAgent({ template: revisorAgentTemplate, part: 2 }),
  overview: buildOverviewAgent(),
};

export const milionario3pEscritaSystemPrompt = ESCRITA_SYSTEM_PROMPT;

export const milionario3pRevisorExtract = {
  systemPrompt: REVISOR_EXTRACT_SYSTEM_PROMPT,
  buildUserMessage: buildRevisorExtractUserMessage,
};
