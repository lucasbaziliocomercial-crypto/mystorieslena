import type {
  EscritaSynopsis,
  RoteiroReferenceImage,
  StepId,
  StepOutput,
} from "@/types/roteiro";

/**
 * Quando o Escrita roda em modo 2-em-2, cada request descreve qual par de
 * capítulos a IA deve gerar e em qual Parte está. Outros agentes ignoram.
 */
export interface AgentBatchContext {
  part: "Parte 1" | "Parte 2";
  /** Números absolutos dos capítulos a gerar — 1 ou 2 entradas. Ex.: [3, 4]. */
  chapters: number[];
  /** Quantidade total de capítulos da Parte (pra orientar o agente). */
  totalInPart: number;
  /** Índice 1-based deste batch dentro da rodada inteira. */
  batchIndex: number;
  /** Total de batches que serão disparados nessa rodada (Parte 1 + Parte 2). */
  totalBatches: number;
  /**
   * Alvo de palavras de cada capítulo deste batch, lido da Estrutura aprovada.
   * Sem esse número explícito no prompt o Opus tende a extrapolar (cada cap
   * com +20-70% sobre o alvo). Quando presente, o user message instrui o
   * agente a obedecer o número EXATO com margem ±3%. Pareado 1:1 com
   * `chapters` (mesma ordem).
   */
  chapterTargets?: number[];
}

export interface AgentContext {
  previousOutputs: Partial<Record<StepId, StepOutput>>;
  userInput?: string;
  /** Imagem de referência opcional anexada na Premissa. */
  referenceImage?: RoteiroReferenceImage;
  /**
   * Modo correção: a roteirista NÃO quer regenerar do zero, só aplicar uma
   * correção pontual em cima da versão atual. Quando true, o agente recebe
   * `currentOutput` (a versão atual desse step) e o `userInput` vira a
   * instrução de correção.
   */
  refineMode?: boolean;
  /** Versão atual do output desse step — usada como base no modo correção. */
  currentOutput?: string;
  /** Modo 2-em-2 do Escrita — só presente quando o frontend está iterando. */
  batch?: AgentBatchContext;
  /** Sinopses dos capítulos já gerados em batches anteriores (continuidade). */
  previousSynopses?: EscritaSynopsis[];
  /**
   * Fase do agente Premissa. "resumo" pede só o Bloco 0 (dois resumos longos);
   * "estrutura" pede Blocos 1-8 com o resumo já aprovado em `approvedResumo`.
   * Outros agentes ignoram.
   */
  premissaPhase?: "resumo" | "estrutura";
  /** Resumo (Bloco 0) já aprovado pelo usuário — usado na fase "estrutura". */
  approvedResumo?: string;
  /**
   * Modo "Continuar revisão" do step Revisor — só populado quando a roteirista
   * clica nesse botão (vs "Gerar novamente" que recomeça do zero). Lista os
   * títulos dos erros já destacados em revisões anteriores (output corrente +
   * todas as entradas do histórico do Revisor). O agente recebe a instrução
   * de NÃO repetir esses erros e focar em refinamentos novos — assim cada
   * rodada cobre aspectos diferentes e a Nota Final reflete progresso real.
   */
  previousRevisorErrors?: string[];
  /**
   * Modo "Continuar de onde parou" — disparado quando uma geração anterior
   * dos steps Estrutura P1/P2 foi interrompida no meio do stream e o output
   * parcial está preservado. O agente recebe o partial em `currentOutput` e
   * deve continuar EXATAMENTE de onde parou, sem repetir, recomeçar nem
   * resumir. Diferente de `refineMode` (que ajusta uma versão completa).
   */
  continuationMode?: boolean;
  /**
   * Cânone de Entidades — bloco markdown estruturado (Personagens / Lugares /
   * Datas / Relações) extraído da Premissa e aprovado pela roteirista.
   * Quando presente, cada agente injeta esse bloco como primeira referência
   * no user message com o cabeçalho "━━━ CÂNONE DE ENTIDADES ━━━" e os
   * system prompts (via REGRA CANÔNICA) instruem o modelo a usar nomes/
   * idades/lugares/datas EXATAMENTE como aparecem aqui. Roteiros legados
   * sem cânone passam undefined — agentes funcionam como antes.
   */
  canone?: string;
}

export interface Agent {
  id: StepId;
  label: string;
  description: string;
  model: string;
  systemPrompt: string;
  buildUserMessage: (ctx: AgentContext) => string;
  maxTokens: number;
  temperature?: number;
  /**
   * Thinking mode. Default: 'disabled' (mais rápido).
   * Use 'adaptive' só se o agente precisar de raciocínio pesado.
   */
  thinking?: "disabled" | "adaptive";
  /** Effort level. Default: 'low' (mais rápido). */
  effort?: "low" | "medium" | "high";
  /** if true, shows a warning that the prompt is still a placeholder */
  placeholder?: boolean;
  /**
   * Quando true, o agente recebe a imagem de referência (Premissa) como
   * input multimodal junto com o userMessage. Modelo precisa ser
   * vision-capable (Opus, Sonnet recentes).
   */
  acceptsReferenceImage?: boolean;
}
