"use client";

import { cn } from "@/lib/utils";
import { STEPPER_NODES, type StepId } from "@/types/roteiro";
import { Check } from "lucide-react";

interface Props {
  current: StepId;
  completed: StepId[];
  onSelect?: (step: StepId) => void;
}

export function StepIndicator({ current, completed, onSelect }: Props) {
  // Trilha de EXIBIÇÃO: 6 nós (revisor1+revisor2 colapsados num "Revisor").
  const currentNodeIdx = STEPPER_NODES.findIndex((n) =>
    n.steps.includes(current),
  );

  return (
    <div className="w-full">
      <ol className="flex items-center justify-between gap-1 sm:gap-2">
        {STEPPER_NODES.map((node, idx) => {
          // Um nó "feito" = TODOS os steps que ele representa têm conteúdo
          // (pro "Revisor" só marca o check quando as duas Partes existem).
          const isCompleted = node.steps.every((s) => completed.includes(s));
          const isCurrent = node.steps.includes(current);

          return (
            <li key={node.key} className="flex items-center flex-1 last:flex-none">
              <button
                type="button"
                // Clicar no nó leva pro 1º step que ele representa (no Revisor =
                // revisor1; as abas dentro do step trocam pra Parte 2).
                onClick={() => onSelect?.(node.steps[0]!)}
                className="group flex flex-col items-center gap-1.5 min-w-0 transition cursor-pointer"
              >
                <div
                  className={cn(
                    "size-8 sm:size-9 rounded-full flex items-center justify-center text-xs font-semibold border transition",
                    isCurrent &&
                      "bg-primary text-primary-foreground border-primary shadow-sm ring-4 ring-primary/15",
                    isCompleted &&
                      !isCurrent &&
                      "bg-primary/90 text-primary-foreground border-primary/90",
                    !isCurrent &&
                      !isCompleted &&
                      "bg-background text-muted-foreground border-border",
                  )}
                >
                  {isCompleted && !isCurrent ? (
                    <Check className="size-4" strokeWidth={3} />
                  ) : (
                    <span>{idx + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "text-[10px] sm:text-xs font-medium text-center leading-tight max-w-[80px] truncate",
                    isCurrent ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {node.label}
                </span>
              </button>
              {idx < STEPPER_NODES.length - 1 && (
                <div
                  className={cn(
                    "flex-1 h-[2px] mx-1 sm:mx-2 -mt-5 rounded-full transition",
                    idx < currentNodeIdx ? "bg-primary/80" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
