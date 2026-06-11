/**
 * Cronômetro de produção do roteiro (Pilar C — medir, aplicado ao tempo que a
 * roteirista leva pra PRODUZIR um roteiro inteiro, pra ela reportar pra equipe).
 *
 * Soma o tempo ATIVO de geração de cada step (premissa → estrutura → escrita →
 * revisor → overview) conforme eles concluem na fila (`QueueRunner`). NÃO é tempo
 * de relógio do início ao fim — não conta pausas, edição manual nem tempo parado;
 * é só o tempo gerando. Assim o número não infla se ela sair pra almoçar no meio.
 *
 * Fonte ÚNICA da lógica de acúmulo e formatação: o store (`recordProductionTime`,
 * caminho do roteiro ATIVO) e o `QueueRunner` (caminho do roteiro em 2º plano)
 * chamam `accrueProductionTime` — sem isso os dois seams divergiriam.
 */

import type { ProductionStepKey, ProductionTime } from "@/types/roteiro";

/**
 * Acumula `elapsedMs` ao cronômetro de produção, atribuindo ao `step` que acabou
 * de gerar. Puro — recebe o estado anterior (ou undefined no 1º step) e o
 * `nowIso` da conclusão, devolve o próximo estado. Atualiza o total E o breakdown
 * por step (`byStep[step]`). `firstStartedAt` é semeado retroagindo `elapsedMs` a
 * partir de `nowIso` na 1ª contabilização (início aproximado da produção).
 */
export function accrueProductionTime(
  prev: ProductionTime | undefined,
  step: ProductionStepKey,
  elapsedMs: number,
  nowIso: string,
): ProductionTime {
  const firstStartedAt =
    prev?.firstStartedAt ??
    new Date(new Date(nowIso).getTime() - elapsedMs).toISOString();
  const prevStep = prev?.byStep?.[step];
  return {
    totalMs: (prev?.totalMs ?? 0) + elapsedMs,
    generations: (prev?.generations ?? 0) + 1,
    firstStartedAt,
    lastFinishedAt: nowIso,
    byStep: {
      ...(prev?.byStep ?? {}),
      [step]: {
        totalMs: (prevStep?.totalMs ?? 0) + elapsedMs,
        generations: (prevStep?.generations ?? 0) + 1,
      },
    },
  };
}

/**
 * Formata o tempo total (ms) em PT-BR pro selo do card: "45s", "12min",
 * "12min 30s", "1h 5min". Arredonda pro segundo; abaixo de 1 min mostra só
 * segundos.
 */
export function formatProductionTime(totalMs: number): string {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec > 0 ? `${totalMin}min ${sec}s` : `${totalMin}min`;
  }
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${h}h ${min}min` : `${h}h`;
}
