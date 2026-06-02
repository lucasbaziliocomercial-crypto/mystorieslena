export type StepId =
  | "premissa"
  | "estrutura1"
  | "estrutura2"
  | "escrita"
  | "revisor1"
  | "revisor2"
  | "overview";

export const STEP_ORDER: StepId[] = [
  "premissa",
  "estrutura1",
  "estrutura2",
  "escrita",
  "revisor1",
  "revisor2",
  "overview",
];

export const STEP_LABELS: Record<StepId, string> = {
  premissa: "Premissa",
  estrutura1: "Estrutura — Parte 1",
  estrutura2: "Estrutura — Parte 2",
  escrita: "Escrita",
  revisor1: "Revisor — Parte 1",
  revisor2: "Revisor — Parte 2",
  overview: "Overview Final",
};

/** Steps de revisão (úteis pra checks tipo `REVISOR_STEPS.includes(step)`). */
export const REVISOR_STEPS = ["revisor1", "revisor2"] as const;
export type RevisorStepId = (typeof REVISOR_STEPS)[number];
export function isRevisorStep(step: StepId): step is RevisorStepId {
  return step === "revisor1" || step === "revisor2";
}
export function partOfRevisorStep(step: RevisorStepId): 1 | 2 {
  return step === "revisor1" ? 1 : 2;
}

export interface EscritaChapter {
  /** Número do capítulo (1, 2, 3...). */
  number: number;
  /** "Parte 1" | "Parte 2" ou livre. */
  part?: string;
  /** Título do capítulo. */
  title?: string;
  /** Texto narrativo limpo do capítulo. */
  content: string;
  /** Cliffhanger extraído da memória viva final, se disponível. */
  cliffhanger?: string;
  /** Contagem de palavras do capítulo, se extraída da memória viva final. */
  wordCount?: number;
  /** Timestamp de geração. */
  generatedAt: string;
  /** Se foi editado manualmente depois. */
  edited?: boolean;
  /** Timestamp da última edição. */
  editedAt?: string;
}

/** Grau de severidade de um erro apontado pelo Revisor. */
export type RevisorErrorGravity =
  | "naoInterfere"
  | "atencao"
  | "interfere"
  | "gravissimo";

/**
 * Um erro estruturado emitido pelo Revisor (bloco <erros_detalhados>).
 * Cada erro tem trecho_original / trecho_corrigido literais — a UI usa
 * essa info pra fazer find+replace direto no roteiro da Escrita quando
 * a roteirista marca o checkbox e clica em "Aplicar correções".
 */
export interface RevisorError {
  /** ID estável (numero + sufixo, ex: "1", "3a"). */
  id: string;
  /** Numeração que casa com "PRINCIPAIS ERROS" (ex: "1", "3a"). */
  numero: string;
  gravidade: RevisorErrorGravity;
  /** Capítulo onde o erro foi encontrado, se aplicável. */
  capitulo?: number;
  /** Parte do roteiro onde o erro está (1 ou 2). Importante porque a
   *  numeração de capítulos reinicia em cada Parte — sem essa info,
   *  "Cap. 3" é ambíguo. */
  parte?: 1 | 2;
  /** Linha curta resumindo o erro. */
  titulo: string;
  /** Trecho exato do roteiro a substituir — literal, fiel ao original. */
  trechoOriginal: string;
  /** Versão corrigida — substitui o trecho original 1:1. */
  trechoCorrigido: string;
  /** Justificativa da mudança (1-3 frases). */
  porqueAlterado: string;
  /** Marcado como aplicado no roteiro (find+replace já rodou com sucesso). */
  applied?: boolean;
  /** Timestamp de quando foi aplicado. */
  appliedAt?: string;
}

/**
 * Sinopse curta de um capítulo gerado em batch — vira contexto pro próximo
 * batch (continuidade) e ponte Parte 1 → Parte 2.
 */
export interface EscritaSynopsis {
  number: number;
  part: "Parte 1" | "Parte 2";
  synopsis: string;
}

/**
 * Aviso de batch da Escrita em que o agente Opus não emitiu todos os
 * cabeçalhos `## Capítulo N` esperados pelo plano 2-em-2. Detecta o caso
 * em que o agente "engole" um cap silenciosamente — sem isso, o usuário
 * só descobriria no Revisor depois de gastar 30+ minutos do pipeline.
 */
export interface BatchMissingChapters {
  batchIndex: number;
  part: "Parte 1" | "Parte 2";
  expected: number[];
  missing: number[];
  /**
   * Quantos capítulos duplicados (por canonPart+number) foram silenciosamente
   * removidos neste batch pelo `dedupChaptersLast`. Ocorre quando o agente
   * Escrita re-emite um cap que já existia em batches anteriores. Renderizado
   * no banner amarelo com o mesmo peso de `missing` — visibilidade > silêncio.
   */
  duplicatesRemoved?: number;
  /**
   * Erro fatal do batch (HTTP/rede/parser sem cabeçalhos depois de todos os
   * retries). Quando presente, o loop NÃO aborta — registra esse aviso e
   * segue pro próximo batch (P2 não pode ser pulada por falha em P1, nem
   * vice-versa). Banner renderiza em vermelho com o motivo pra a roteirista
   * regerar só os batches faltantes via "Gerar capítulo X novamente".
   */
  fatalError?: string;
}

export interface StepOutputMetadata {
  /** [Legacy all-at-once] Relatório de auto-revisão. */
  report?: string;
  /** [Legacy all-at-once] Memória Viva em JSON (string). */
  memory?: string;
  /** [Legacy all-at-once] Detalhes da validação bloqueante (texto livre). */
  validation?: string;
  /** [Legacy all-at-once] Status resumido da validação. */
  validationStatus?: "APROVADO" | "BLOQUEADO";
  /** Capítulos do roteiro Escrita (formato 2-em-2 vai acumulando aqui). */
  chapters?: EscritaChapter[];
  /** Erros estruturados parseados do bloco <erros_detalhados> do Revisor. */
  errors?: RevisorError[];
  /**
   * Hash leve do conteúdo da Escrita NO MOMENTO em que a revisão foi gerada.
   * Usado pelo Revisor para detectar se o roteiro do Step 4 foi editado
   * depois da revisão — se sim, alguns trechos_originais podem não bater
   * mais e a UI avisa o usuário.
   */
  escritaSnapshotHash?: string;
  /** Sinopses por capítulo do fluxo 2-em-2 (continuidade entre batches). */
  synopses?: EscritaSynopsis[];
  /**
   * Batches em que o agente Escrita pulou capítulos esperados. Renderizado
   * como banner amarelo na UI da Escrita pra o usuário regerar. Limpo na
   * próxima geração bem-sucedida.
   */
  batchWarnings?: BatchMissingChapters[];
  /**
   * Aviso pra UI quando a Escrita pós-correção pontual não conseguiu ser
   * quebrada em capítulos (parser legado falhou). O content fica salvo cru
   * e a UI renderiza como `<pre>` puro mostrando esse aviso. Edição cap-a-cap
   * fica indisponível até regenerar do zero.
   */
  parseWarning?: string;
  /**
   * [Premissa, fluxo automático] Briefing de ideia que o usuário escreveu
   * antes de gerar o resumo. Mantido pra reusar quando ele clicar em
   * "Regenerar resumo" ou "Voltar ao briefing".
   */
  premissaBriefing?: string;
  /**
   * [Premissa, fluxo automático] Resumo (Bloco 0) gerado na Fase 1 e editável
   * pelo usuário antes de aprovar. Quando `resumoApproved` é true, esse texto
   * é enviado pra Fase 2 como `approvedResumo`.
   */
  premissaResumo?: string;
  /** [Premissa] true depois que o usuário aprovou o resumo e a Fase 2 rodou. */
  premissaResumoApproved?: boolean;
  /** [Premissa] timestamp da aprovação do resumo. */
  premissaResumoApprovedAt?: string;
  /**
   * [Premissa] true quando o usuário escolheu o modo manual ("já tenho a
   * premissa pronta"). Nesse caso `content` recebe o texto colado direto
   * e os campos do fluxo automático ficam vazios.
   */
  premissaManualPaste?: boolean;
  /**
   * [Estrutura P1/P2] true enquanto a geração está em andamento — o `content`
   * é checkpointed periodicamente durante o stream. Vira `false` quando o
   * stream termina limpo. Se o app é fechado/freeze no meio, o flag continua
   * `true` ao reabrir — a UI usa isso pra mostrar o banner "geração
   * interrompida" e oferecer o botão "Continuar de onde parou".
   */
  partial?: boolean;
  /**
   * [Estrutura P1/P2] ISO timestamp do início da geração corrente. Usado pra
   * calcular "interrompida há X min" no banner. Setado junto com `partial`.
   */
  streamingStartedAt?: string;
}

export interface StepOutput {
  /** Conteúdo principal — limpo, editável, alimenta os próximos steps. */
  content: string;
  /** Metadados auxiliares (relatório/memória/validação). Não vão adiante. */
  metadata?: StepOutputMetadata;
  generatedAt?: string;
  editedAt?: string;
  edited?: boolean;
}

/** Snapshot de uma geração anterior, salva no histórico de cada step. */
export interface StepGenerationSnapshot {
  /** ID único do snapshot. */
  id: string;
  /** Quando foi gerado/salvo. */
  savedAt: string;
  /** Conteúdo principal capturado. */
  content: string;
  /** Metadata associado (relatório, memória, validação, capítulos da Escrita). */
  metadata?: StepOutputMetadata;
  /** Se foi editado manualmente antes de virar histórico. */
  edited?: boolean;
  /** Quando foi editado pela última vez. */
  editedAt?: string;
  /** Quando foi gerado originalmente. */
  generatedAt?: string;
  /** Rótulo opcional ("v1", "antes da revisão", etc) — gerado automaticamente. */
  label?: string;
}

/**
 * Imagem de referência visual anexada à premissa. O agente Estrutura 1
 * recebe essa imagem como input multimodal pra ajudar a montar a
 * estrutura conforme o estilo/mood/personagens da imagem.
 */
export interface RoteiroReferenceImage {
  /** Data URL completa: "data:image/jpeg;base64,..." */
  dataUrl: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  filename: string;
  /** Tamanho em bytes do arquivo original (pre-base64). */
  size: number;
  uploadedAt: string;
}

/**
 * Sub-nicho de romance — define qual conjunto de prompts cada step usa.
 * Imutável depois que o roteiro é criado: trocar de categoria invalidaria os
 * outputs já gerados (a Premissa de Máfia não bate com a Estrutura de
 * Milionário). Roteiros sem esse campo no localStorage (legados) recebem
 * `"milionario-1p"` por backfill em `lib/storage.ts`.
 */
export type RoteiroCategory =
  | "milionario-1p"
  | "milionario-3p"
  | "mafia"
  | "alpha-king";

/** Default usado pra roteiros legados (sem `category` no localStorage). */
export const DEFAULT_CATEGORY: RoteiroCategory = "milionario-1p";

/**
 * Rascunhos não-confirmados de cada textarea do wizard, escopados por step.
 * Sobrevivem à navegação entre steps; são limpos quando o usuário comete o
 * valor via botão (Gerar resumo, Aplicar correção, Salvar edição). Sem isso,
 * trocar de step apaga o que estava digitado e ainda não foi salvo.
 */
export interface RoteiroDrafts {
  premissa?: {
    /** Textarea "Sua ideia" no fluxo automático. */
    briefing?: string;
    /** Textarea do resumo editável (modo "approving"). */
    resumo?: string;
    /** Textarea do modo manual (premissa colada direto). */
    content?: string;
    /** Caixa "Instruções adicionais" da Premissa. */
    instruction?: string;
  };
  estrutura1?: { input?: string };
  estrutura2?: { input?: string };
  escrita?: { input?: string };
  revisor1?: { input?: string };
  revisor2?: { input?: string };
  overview?: { input?: string };
}

export interface Roteiro {
  id: string;
  title: string;
  /**
   * Sub-nicho do roteiro (escolhido na criação). Travado depois disso —
   * cada categoria tem seu próprio jogo de prompts pros 5 steps.
   */
  category: RoteiroCategory;
  createdAt: string;
  updatedAt: string;
  currentStep: StepId;
  outputs: Partial<Record<StepId, StepOutput>>;
  /**
   * Ajustes/correções escritos pela roteirista, **escopados por step**.
   * Cada step tem sua própria caixa "Instruções adicionais" — o que ela
   * digita em Estrutura 1 não vaza pra Escrita ou Revisor.
   */
  userInputs?: Partial<Record<StepId, string>>;
  /**
   * @deprecated Campo legado (era um único input global pro roteiro).
   * Mantido só pra ler roteiros antigos do localStorage; nunca mais
   * gravamos aqui. Ao carregar um roteiro antigo, o conteúdo daqui é
   * migrado pra `userInputs[currentStep]` na primeira interação.
   */
  userInput?: string;
  /** Imagem opcional de referência visual pra Estrutura 1. */
  referenceImage?: RoteiroReferenceImage;
  /** Histórico de gerações por step. Cada step tem sua própria pilha de snapshots. */
  history?: Partial<Record<StepId, StepGenerationSnapshot[]>>;
  /**
   * Cânone de Entidades — bloco markdown estruturado com nomes próprios,
   * idades, profissões, lugares, datas e relações fixados a partir da
   * Premissa. Vira fonte canônica injetada em TODOS os steps seguintes
   * (estrutura1, estrutura2, escrita, revisor) pra evitar que o modelo
   * troque/invente nomes ao longo do roteiro. Editável pela roteirista
   * antes de avançar pra Estrutura P1.
   *
   * Roteiros legados (criados antes do recurso) ficam undefined — o app
   * mostra um banner "Gerar cânone agora" mas não bloqueia o fluxo.
   */
  canone?: string;
  /** True quando a roteirista clicou "Aprovar cânone" — destrava avanço pra
   *  Estrutura P1 em roteiros novos. Roteiros legados sem cânone seguem
   *  funcionando mesmo com este flag false/undefined. */
  canoneApproved?: boolean;
  /** Timestamp da aprovação do cânone. */
  canoneApprovedAt?: string;
  /**
   * Rascunhos do que está digitado nos textareas mas ainda não foi commitado
   * via botão. Persistido para o usuário não perder trabalho ao trocar de
   * step. Limpo automaticamente quando o valor vira oficial (via Gerar /
   * Aplicar / Salvar). Detalhes em [RoteiroDrafts].
   */
  drafts?: RoteiroDrafts;
}

export function nextStep(step: StepId): StepId | null {
  const idx = STEP_ORDER.indexOf(step);
  if (idx === -1 || idx === STEP_ORDER.length - 1) return null;
  return STEP_ORDER[idx + 1];
}

export function prevStep(step: StepId): StepId | null {
  const idx = STEP_ORDER.indexOf(step);
  if (idx <= 0) return null;
  return STEP_ORDER[idx - 1];
}
