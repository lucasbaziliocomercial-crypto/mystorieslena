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

export function abortJob(jobId: string) {
  controllers.get(jobId)?.abort();
}

/** Aborta todos os jobs em andamento (ex.: unmount do runner / reload). */
export function abortAllJobs() {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
}
