import type { EvalSnapshot } from "@/types/roteiro";

/**
 * Log de evals de qualidade (conceito do Karpathy: nota objetiva, automatizada
 * e versionada). Append-only por roteiro — cresce ao longo de TODAS as rodadas
 * de revisão (além do cap de 5 do histórico de step), pra a roteirista ver a
 * curva de qualidade e decidir com confiança se uma re-rodada melhorou.
 *
 * Soft-cap só pra proteger o localStorage — efetivamente ilimitado pro uso real
 * (um roteiro acumula ~5–15 evals). Cada snapshot é minúsculo (números + 2
 * timestamps), então o cap é generoso.
 *
 * NOTA: este módulo importa SÓ tipos de @/types/roteiro (stripados em runtime),
 * pra `appendEvalSnapshot` seguir testável via `node --experimental-strip-types`
 * (que não resolve o alias `@/` em imports de valor). A montagem do snapshot a
 * partir de um relatório (que precisa de `computeRevisorEval`, um import de
 * valor) fica nos call sites (store/wizard.ts e QueueRunner.tsx).
 */
export const EVAL_LOG_CAP = 200;

/**
 * Anexa um snapshot ao log, com dedup: se o último eval do MESMO step tem nota,
 * risco de hate, total de erros E hash da Escrita idênticos, não anexa nada
 * (re-render / commit idempotente não polui o log). Uma re-rodada que muda
 * qualquer um desses vira uma entrada nova — é exatamente o sinal de "melhorou
 * ou piorou". Devolve o array ORIGINAL (mesma referência) quando não há mudança,
 * pra o caller poder pular o persist.
 */
export function appendEvalSnapshot(
  prev: EvalSnapshot[] | undefined,
  data: Omit<EvalSnapshot, "id" | "at">,
  now: string,
): EvalSnapshot[] {
  const list = prev ?? [];

  // Último eval do mesmo step (a numeração/contexto é por Parte).
  let lastForStep: EvalSnapshot | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.step === data.step) {
      lastForStep = list[i];
      break;
    }
  }
  if (
    lastForStep &&
    lastForStep.nota === data.nota &&
    lastForStep.hateRisk === data.hateRisk &&
    lastForStep.errorTotal === data.errorTotal &&
    lastForStep.escritaHash === data.escritaHash
  ) {
    return list; // nada de novo — não anexa (dedup)
  }

  const snap: EvalSnapshot = { ...data, id: `${data.step}-${now}`, at: now };
  const next = [...list, snap];
  // Soft-cap: descarta os mais antigos se passar do teto.
  return next.length > EVAL_LOG_CAP
    ? next.slice(next.length - EVAL_LOG_CAP)
    : next;
}
