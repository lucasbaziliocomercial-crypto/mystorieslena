import type { Agent } from "@/lib/agents/types";
import type { StepId } from "@/types/roteiro";

/**
 * Sub-nichos suportados pelo gerador. Cada um carrega seu próprio conjunto
 * de prompts, configuração de contagem de palavras e descrições de UI.
 *
 * Adicionar um novo sub-nicho:
 *   1. Acrescentar o ID aqui em `RoteiroCategory`.
 *   2. Criar `lib/agents/<id>/` com os 5 agentes + prompts.
 *   3. Registrar a categoria em `lib/categories/index.ts`.
 *
 * Nunca remover um ID já em uso — roteiros legados no localStorage
 * carregam essa string. Manter a compatibilidade ou prever migração.
 */
export type RoteiroCategory =
  | "milionario-1p"
  | "milionario-3p"
  | "mafia"
  | "alpha-king";

/** Configuração de contagem de palavras por Parte (Parte 1 / Parte 2). */
export interface PartWordCount {
  /** Limite inferior aceito pelo balanceamento — é o "RIGOROSO mínimo". */
  min: number;
  /** Limite superior aceito pelo balanceamento — é o "RIGOROSO máximo". */
  max: number;
  /** Alvo central usado pelos cálculos de fallback de capítulo. */
  target: number;
}

export interface CategoryWordCount {
  parte1: PartWordCount;
  parte2: PartWordCount;
}

export interface CategoryConfig {
  id: RoteiroCategory;
  /** Rótulo curto exibido na UI (cards, badges). */
  label: string;
  /** Frase curta que descreve o sub-nicho no card de seleção. */
  description: string;
  /**
   * Canais que produzem essa categoria — usado pra ajudar a roteirista
   * a identificar visualmente o sub-nicho na tela de seleção. Exemplos:
   * "Kay" / "Rowan v1 e v2" / "Lena v1, v2 e v3".
   */
  channels: string;
  /** Conjunto completo de agentes (premissa, estrutura1, estrutura2, escrita, revisor). */
  agents: Record<StepId, Agent>;
  /** Configuração de palavras totais por Parte — usada por partTotalRange e fallbacks. */
  wordCount: CategoryWordCount;
  /**
   * Prompt da Escrita exposto separadamente — o endpoint
   * `/api/escrita-fix-wordcount` precisa dele direto, sem montar Agent.
   */
  escritaSystemPrompt: string;
}
