/**
 * Helpers de concorrência sem dependência externa.
 *
 * `mapWithConcurrency` processa `items` rodando no máximo `limit` tarefas ao
 * mesmo tempo (pool de workers que puxam de um cursor compartilhado). Usado pela
 * calibração de word-count da Escrita: cada capítulo é uma reescrita Opus
 * INDEPENDENTE (escreve num índice distinto de `accChapters`, só lê sinopses já
 * existentes), então rodar em paralelo dá o mesmo resultado que em série, só mais
 * rápido. O cap pequeno (3) evita disparar chamadas demais e estourar o limite do
 * plano Claude (OAuth Pro/Max).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  opts?: {
    /**
     * Aguardado ANTES de despachar cada tarefa. A fila usa pra ceder ao
     * foreground (mesma semântica do `beforeUnit` por-unidade do motor headless).
     */
    beforeEach?: (index: number) => Promise<void> | void;
    /** Para de despachar novas tarefas quando abortado. */
    signal?: AbortSignal;
  },
): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts?.signal?.aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      if (opts?.beforeEach) await opts.beforeEach(i);
      if (opts?.signal?.aborted) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
