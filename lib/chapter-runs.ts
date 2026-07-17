/**
 * Dedup de RASCUNHOS repetidos de capítulos numa Estrutura.
 *
 * O modelo às vezes concatena 2-3 rascunhos da lista de capítulos (ou o fluxo de
 * regenerar/refinar anexa em vez de substituir), gerando a MESMA sequência
 * `Capítulo 1..6` várias vezes num só documento. `keepLastChapterRun` mantém só o
 * ÚLTIMO conjunto — que é o rascunho final e o que a Escrita usa.
 *
 * Por que importa (bug ROTEIRO 59, 17/07/2026): com 6 caps repetidos 3× (18 blocos)
 * a SOMA dos alvos por capítulo parece "na faixa" da Parte e o piso por-cap cai
 * (total/18 em vez de total/6) → o rescale de `normalizeEstruturaTargets` E o
 * `enforceMinChapterShare` viram no-op → a Parte nasce com ~1/3 do tamanho (a P2
 * saiu 4.758 palavras em vez de ~13.250). Enxergar só o último run reativa o rescale.
 *
 * Um novo "run" começa quando o número do capítulo é <= ao anterior (a sequência
 * recomeça, ex.: …6, 1). Sem repetição (numeração única crescente) devolve intacto.
 * O último run é contíguo até o fim do texto — por isso a reconstrução por prefixo +
 * bodies em `normalizeEstruturaTargets` preserva os rascunhos anteriores intactos.
 *
 * Genérico em `{ number }` pra servir tanto aos blocos de `splitChapterBlocks`
 * quanto a testes. Puro, sem dependências (testável via node). Idempotente.
 */
export function keepLastChapterRun<T extends { number: number }>(
  blocks: T[],
): T[] {
  if (blocks.length <= 1) return blocks;
  let runStart = 0;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i]!.number <= blocks[i - 1]!.number) runStart = i;
  }
  return blocks.slice(runStart);
}
