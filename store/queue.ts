/**
 * Fila de geração em 2º plano. Permite enfileirar a Escrita de OUTROS roteiros
 * pra rodar sozinha enquanto a roteirista trabalha na produção principal.
 *
 * Regras de ouro (ver `components/queue/QueueRunner.tsx`):
 *  • roda 1 job por vez (sem concorrência);
 *  • só dispara enquanto NÃO há geração em foco (cede cota/prioridade à
 *    produção principal);
 *  • nunca processa o roteiro que está aberto/ativo no momento (evita conflito
 *    entre o store em memória e a escrita no storage).
 *
 * Persistida em `veludo:queue` (chave própria, separada de `veludo:roteiros`).
 * O payload é leve — só metadados do job, nunca o texto do roteiro.
 */
import { create } from "zustand";
import type { EscritaProgress } from "@/lib/generation/run-escrita";

export type QueueJobStatus = "queued" | "running" | "done" | "error";

/** Steps que rodam no gerenciador persistente/concorrente (sobrevivem a trocar
 *  de guia). Escrita = motor 2-em-2; os demais = motor de chamada única. */
export type QueueStep =
  | "escrita"
  | "estrutura1"
  | "estrutura2"
  | "revisor1"
  | "revisor2"
  | "overview"
  | "premissa"
  | "canone";

/** Params extras do job de Premissa (fluxo de 2 fases: resumo → estrutura). */
export interface PremissaJobParams {
  phase: "resumo" | "estrutura";
  /** Resumo aprovado — só na fase "estrutura". */
  approvedResumo?: string;
  /** Briefing (ideia) — snapshot capturado no clique. */
  briefing?: string;
}

export interface QueueJob {
  id: string;
  roteiroId: string;
  /** Snapshot do título no momento de enfileirar (pra exibir sem recarregar). */
  roteiroTitle: string;
  step: QueueStep;
  status: QueueJobStatus;
  /** Progresso de batch/calibração (só Escrita). */
  progress?: EscritaProgress;
  /** Rótulo de fase pros steps de chamada única (ex.: "Revisando…"). */
  phase?: string;
  /** Mensagem de erro quando status === "error". */
  error?: string;
  /** Snapshot do input "Ajustes opcionais" no momento de enfileirar (o motor
   *  usa isso em vez de reler do storage, evitando race com o debounce de save). */
  userInput?: string;
  /**
   * Retomada: quando true, o motor da Escrita SEMEIA os capítulos/sinopses já
   * salvos em `outputs.escrita.metadata` e PULA os batches já concluídos, em vez
   * de regerar do zero. Setado por "Continuar geração" (botão) e automaticamente
   * em jobs interrompidos pelo fechamento do app (running→queued no reload).
   */
  resume?: boolean;
  /** Params da Premissa (só quando step === "premissa"). */
  premissa?: PremissaJobParams;
  /**
   * Contexto do "Continuar revisão" (só revisor1/revisor2): títulos dos erros já
   * destacados em rodadas anteriores, agregados no clique e mandados pro agente
   * como "não relista esses". Snapshot no job (igual a `userInput`) — quando
   * presente, o job é uma continuação de revisão, não uma 1ª passada.
   */
  previousRevisorErrors?: string[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface QueueState {
  jobs: QueueJob[];
  /**
   * Enfileira um job. Idempotente por (roteiroId, step): se já existe um job
   * ativo (queued/running) pro mesmo roteiro+step, devolve null e não duplica.
   */
  enqueue: (
    roteiroId: string,
    roteiroTitle: string,
    step: QueueStep,
    userInput?: string,
    resume?: boolean,
    premissa?: PremissaJobParams,
    previousRevisorErrors?: string[],
  ) => string | null;
  updateJob: (id: string, patch: Partial<QueueJob>) => void;
  removeJob: (id: string) => void;
  /** Remove os jobs concluídos/errados (limpa o painel). */
  clearFinished: () => void;
}

const QUEUE_KEY = "veludo:queue";

function isBrowser() {
  return typeof window !== "undefined";
}

function loadJobs(): QueueJob[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const jobs = JSON.parse(raw) as QueueJob[];
    if (!Array.isArray(jobs)) return [];
    // Jobs que estavam "running" quando o app fechou/recarregou foram
    // interrompidos — voltam pra fila marcados `resume: true`, pra retomarem de
    // onde pararam (o motor da Escrita pula os batches já concluídos) em vez de
    // regerar tudo. Os capítulos prontos já foram persistidos via `onPartial`.
    return jobs.map((j) =>
      j.status === "running"
        ? {
            ...j,
            status: "queued" as const,
            progress: undefined,
            startedAt: undefined,
            resume: true,
          }
        : j,
    );
  } catch {
    return [];
  }
}

function saveJobs(jobs: QueueJob[]) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(jobs));
  } catch {
    // quota/serialização — a fila é best-effort; ignora.
  }
}

function makeJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useQueue = create<QueueState>((set, get) => ({
  jobs: loadJobs(),

  enqueue: (
    roteiroId,
    roteiroTitle,
    step,
    userInput,
    resume,
    premissa,
    previousRevisorErrors,
  ) => {
    const exists = get().jobs.some(
      (j) =>
        j.roteiroId === roteiroId &&
        j.step === step &&
        (j.status === "queued" || j.status === "running"),
    );
    if (exists) return null;
    const id = makeJobId();
    const job: QueueJob = {
      id,
      roteiroId,
      roteiroTitle,
      step,
      status: "queued",
      ...(userInput && userInput.trim() ? { userInput } : {}),
      ...(resume ? { resume: true } : {}),
      ...(premissa ? { premissa } : {}),
      ...(previousRevisorErrors && previousRevisorErrors.length > 0
        ? { previousRevisorErrors }
        : {}),
      queuedAt: new Date().toISOString(),
    };
    set((s) => {
      const jobs = [...s.jobs, job];
      saveJobs(jobs);
      return { jobs };
    });
    return id;
  },

  updateJob: (id, patch) =>
    set((s) => {
      const jobs = s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
      saveJobs(jobs);
      return { jobs };
    }),

  removeJob: (id) =>
    set((s) => {
      const jobs = s.jobs.filter((j) => j.id !== id);
      saveJobs(jobs);
      return { jobs };
    }),

  clearFinished: () =>
    set((s) => {
      const jobs = s.jobs.filter(
        (j) => j.status === "queued" || j.status === "running",
      );
      saveJobs(jobs);
      return { jobs };
    }),
}));
