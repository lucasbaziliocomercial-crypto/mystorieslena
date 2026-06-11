"use client";

/**
 * Selo ⏱ do cronômetro de produção do roteiro — total + lista expansível do
 * tempo gasto em cada etapa. Componente compartilhado pela lista de roteiros
 * (`RoteiroList`) e pelo cabeçalho do roteiro aberto (`Wizard`), pra os dois
 * lugares não divergirem. Só renderiza quando há tempo registrado; a lista por
 * etapa só quando o breakdown (`byStep`) existe (retro-compat com roteiros
 * contabilizados antes do breakdown).
 *
 * `<details>` nativo (sem JS) — clicar no total revela/esconde a lista.
 */

import type { ProductionStepKey, ProductionTime } from "@/types/roteiro";
import { STEP_LABELS } from "@/types/roteiro";
import { formatProductionTime } from "@/lib/production-time";
import { ChevronDown, Clock } from "lucide-react";

/** Ordem de exibição do breakdown (inclui o cânone, entre premissa e estrutura1 —
 *  não é um StepId do wizard, mas roda pela fila e consome tempo). */
const PRODUCTION_STEP_ORDER: ProductionStepKey[] = [
  "premissa",
  "canone",
  "estrutura1",
  "estrutura2",
  "escrita",
  "revisor1",
  "revisor2",
  "overview",
];

/** Rótulos do breakdown — reusa STEP_LABELS e nomeia o cânone (fora do wizard). */
const PRODUCTION_STEP_LABELS: Record<ProductionStepKey, string> = {
  ...STEP_LABELS,
  canone: "Cânone",
};

export function ProductionTimeBadge({
  production,
}: {
  production: ProductionTime | undefined;
}) {
  if (!production || production.totalMs <= 0) return null;
  return (
    <details className="group w-fit text-xs">
      <summary
        className="inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-secondary-foreground"
        title="Tempo total de geração deste roteiro (só o tempo gerando, sem pausas nem edição). Clique pra ver o tempo por etapa."
      >
        <Clock className="size-3" />
        <span className="font-medium">
          {formatProductionTime(production.totalMs)}
        </span>
        <span className="text-muted-foreground">no total</span>
        <ChevronDown className="size-3 transition group-open:rotate-180" />
      </summary>
      {production.byStep && (
        <ul className="mt-1.5 ml-1 flex flex-col gap-1 text-muted-foreground">
          {PRODUCTION_STEP_ORDER.filter((s) => production.byStep?.[s]).map(
            (s) => {
              const st = production.byStep![s]!;
              return (
                <li
                  key={s}
                  className="flex items-center justify-between gap-4"
                  style={{ minWidth: 200 }}
                >
                  <span>
                    {PRODUCTION_STEP_LABELS[s]}
                    {st.generations > 1 && (
                      <span className="ml-1 opacity-60">×{st.generations}</span>
                    )}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {formatProductionTime(st.totalMs)}
                  </span>
                </li>
              );
            },
          )}
        </ul>
      )}
    </details>
  );
}
