/**
 * Helpers de concorrência sem dependência externa.
 *
 * - `mapWithConcurrency(items, limit, fn)` — processa uma lista FECHADA rodando
 *   no máx. `limit` tarefas ao mesmo tempo (pool de workers puxando de um cursor
 *   compartilhado). Use quando todos os itens já existem de antemão.
 * - `createLimiter(limit)` — limitador COMPARTILHÁVEL: vários produtores submetem
 *   tarefas ao MESMO pool em momentos diferentes, sob um teto único. Use quando
 *   os itens chegam aos poucos — ex.: a calibração de word-count da Escrita, em
 *   que a Parte 1 e a Parte 2 entram no pool conforme CADA Parte termina de gerar
 *   (a calibração da P1 sobrepõe a cauda de geração da P2), sem estourar o limite
 *   do plano Claude (OAuth Pro/Max).
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

/**
 * Limitador de concorrência COMPARTILHÁVEL (estilo p-limit). Diferente de
 * `mapWithConcurrency` — que recebe TODOS os itens de uma vez —, o `createLimiter`
 * deixa vários produtores alimentarem o MESMO pool conforme suas tarefas ficam
 * prontas em momentos diferentes, sob um teto único de concorrência.
 *
 * Usado pela calibração da Escrita: a Parte 1 e a Parte 2 entram no pool assim
 * que CADA Parte termina de gerar (a P1 acaba antes da P2), então a calibração
 * da P1 roda sobreposta à cauda de geração da P2 — sem estourar o teto total.
 *
 * Retorna `run(fn)`: executa no máx. `limit` `fn`s ao mesmo tempo; o excedente
 * espera numa fila FIFO. Se `signal` abortar, as tarefas ainda não despachadas
 * resolvem `undefined` (não disparam). Erros de `fn` propagam pro chamador do
 * `run` (o despacho do pool segue normalmente).
 */
export function createLimiter(
  limit: number,
  opts?: { signal?: AbortSignal },
): <R>(fn: () => Promise<R>) => Promise<R | undefined> {
  const max = Math.max(1, limit);
  let active = 0;
  const queue: (() => void)[] = [];

  // Despacha o que couber: roda enquanto houver slot livre e tarefa na fila.
  // Tarefa abortada NÃO consome slot (só resolve undefined), então o `while`
  // segue puxando a próxima — sem recursão.
  const pump = (): void => {
    while (active < max && queue.length > 0) {
      const start = queue.shift()!;
      start();
    }
  };

  return function run<R>(fn: () => Promise<R>): Promise<R | undefined> {
    return new Promise<R | undefined>((resolve, reject) => {
      queue.push(() => {
        if (opts?.signal?.aborted) {
          resolve(undefined);
          return;
        }
        active += 1;
        fn().then(
          (r) => {
            active -= 1;
            resolve(r);
            pump();
          },
          (e) => {
            active -= 1;
            reject(e);
            pump();
          },
        );
      });
      pump();
    });
  };
}
