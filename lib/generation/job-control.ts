/**
 * Registro de AbortControllers dos jobs de geração em andamento. Fica FORA do
 * Zustand store porque AbortController não é serializável (e o store da fila é
 * persistido em localStorage). Permite cancelar um job específico a partir de
 * qualquer componente (StepShell, QueuePanel) sem prop drilling.
 */
const controllers = new Map<string, AbortController>();

export function registerJob(jobId: string, ctrl: AbortController) {
  controllers.set(jobId, ctrl);
}

export function unregisterJob(jobId: string) {
  controllers.delete(jobId);
}

/**
 * True se o job ainda tem um AbortController VIVO no registro — i.e., a tarefa
 * async está de fato em andamento. Um job marcado `running` na fila SEM
 * controller aqui é um FANTASMA: a tarefa morreu (abort no unmount via
 * `abortAllJobs`, crash, hot-reload do dev) mas o status ficou preso em
 * `running`. O `QueueRunner` usa isto pra recuperar fantasmas (running→queued),
 * senão o `StepShell` desabilita o botão "Gerar" pra sempre (`disabled={!!stepJob}`)
 * e a roteirista vê "nada acontece".
 */
export function hasJobController(jobId: string): boolean {
  return controllers.has(jobId);
}

export function abortJob(jobId: string) {
  controllers.get(jobId)?.abort();
}

/** Aborta todos os jobs em andamento (ex.: unmount do runner / reload). */
export function abortAllJobs() {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
}
