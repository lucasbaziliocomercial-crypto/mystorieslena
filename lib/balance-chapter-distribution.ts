/**
 * Trava DETERMINÍSTICA de DISTRIBUIÇÃO por capítulo (sem LLM) — garante que
 * NENHUM capítulo (em especial o ÚLTIMO) fique muito mais curto que os outros.
 *
 * Motivação (bug 15/06/2026, "último capítulo de 800 palavras"): a Estrutura da
 * Parte 2 declara só o TOTAL (ex.: 13.500 em 6 capítulos). Nada garantia um alvo
 * razoável POR capítulo — o modelo às vezes tratava o ÚLTIMO como um epílogo
 * curto e declarava ~800 palavras (média ~2.250), enquanto os outros ficavam
 * ~2.300-2.900. Como a SOMA continuava na faixa, `normalizeEstruturaTargets`
 * (que só olha a soma) NÃO corrigia, e a Escrita gerava um capítulo minúsculo
 * fiel ao alvo errado. O Prompt Master nunca pediu um capítulo curto.
 *
 * Esta função recebe os alvos por capítulo + o alvo TOTAL da Parte e, se algum
 * capítulo cair abaixo de um PISO (fração da média), eleva-o ao piso e retira o
 * déficit dos capítulos ACIMA da média (proporcional ao excedente),
 * CONSERVANDO a soma. Assim nenhum capítulo fica curto e o total da Parte não
 * muda. Pura, sem dependências de valor (testável via node), idempotente.
 *
 * ⚠️ Aplicar SÓ na PARTE 2 — a Parte 1 de algumas categorias tem capítulos
 * curtos legítimos por desenho (ex.: alpha-king P1 Cap 6 ≤ 1.000). O call site
 * (`normalizeEstruturaTargets`) já guarda `part === "Parte 2"`.
 */

/**
 * Piso por capítulo = fração da média da Parte (`alvoTotal / nº de capítulos`).
 * Com 0,90 e uma Parte 2 de ~13.250-13.500 em 6 capítulos (média ~2.208-2.250),
 * o piso fica ≈ 1.990-2.025 palavras — o "~2.000 por capítulo" pedido pela
 * roteirista. É um knob: subir aproxima todos da média; descer afrouxa.
 */
export const MIN_SHARE_FRAC = 0.9;

/**
 * Eleva qualquer capítulo abaixo do piso até o piso e tira o déficit dos
 * capítulos acima da média (proporcional ao excedente), conservando a soma.
 *
 * @param targets    alvos por capítulo (já lidos da Estrutura, header-first)
 * @param partTarget alvo TOTAL da Parte (de `partTotalRange(...).target`)
 * @returns          novos alvos (mesma soma) OU `null` se nada precisa mudar
 *                   (todos já no piso) — idempotente.
 */
export function enforceMinChapterShare(
  targets: number[],
  partTarget: number,
): number[] | null {
  const n = targets.length;
  if (n === 0 || partTarget <= 0) return null;

  const sum = targets.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;

  const evenShare = partTarget / n;
  const floor = Math.round(evenShare * MIN_SHARE_FRAC);

  // Todos já no piso? Nada a fazer (idempotente — 2ª passada vira no-op).
  if (targets.every((t) => t >= floor)) return null;

  // 1) Eleva cada capítulo abaixo do piso até o piso.
  const result = targets.map((t) => (t < floor ? floor : t));
  const deficit = result.reduce((a, b) => a + b, 0) - sum; // > 0

  // 2) Doadores = capítulos ACIMA do piso; cada um pode ceder até (valor - piso).
  const surplus = result.map((t) => Math.max(0, t - floor));
  const totalSurplus = surplus.reduce((a, b) => a + b, 0);

  // Caso degenerado: não há excedente suficiente pra cobrir o déficit sem furar
  // o piso de alguém (irreal com 6 caps e piso ~0,9 da média — exigiria vários
  // capítulos minúsculos ao mesmo tempo). Fallback: reescala proporcional pro
  // alvo total, o mais equilibrado possível dentro do impossível.
  if (totalSurplus < deficit) {
    const factor = partTarget / sum;
    const scaled = targets.map((t) => Math.max(1, Math.round(t * factor)));
    fixResidual(scaled, partTarget);
    return scaled;
  }

  // 3) Retira o déficit dos doadores, proporcional ao excedente, sem furar o piso.
  for (let i = 0; i < n; i++) {
    if (surplus[i]! <= 0) continue;
    const take = Math.min(
      surplus[i]!,
      Math.round((deficit * surplus[i]!) / totalSurplus),
    );
    result[i] = result[i]! - take;
  }

  // 4) Conserva a soma EXATA (corrige resíduo de arredondamento da etapa 3),
  // ajustando os doadores com mais folga acima do piso primeiro — nunca fura o
  // piso (diff > 0 = ainda há a remover; diff < 0 = removemos demais, devolve).
  let diff = result.reduce((a, b) => a + b, 0) - sum;
  if (diff !== 0) {
    const order = [...Array(n).keys()].sort(
      (a, b) => result[b]! - floor - (result[a]! - floor),
    );
    for (const i of order) {
      if (diff === 0) break;
      if (diff > 0) {
        const take = Math.min(result[i]! - floor, diff);
        result[i] = result[i]! - take;
        diff -= take;
      } else {
        result[i] = result[i]! - diff; // diff < 0 → soma |diff| no maior doador
        diff = 0;
      }
    }
  }

  return result;
}

/** Joga o resíduo de arredondamento no maior alvo, pra a soma bater EXATA. */
function fixResidual(arr: number[], total: number): void {
  const residual = total - arr.reduce((a, b) => a + b, 0);
  if (residual === 0) return;
  let idxMax = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i]! > arr[idxMax]!) idxMax = i;
  arr[idxMax] = Math.max(1, arr[idxMax]! + residual);
}
