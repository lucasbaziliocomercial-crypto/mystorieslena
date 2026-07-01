"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  REVISOR_STEPS,
  type RevisorHateRisk,
  type RevisorStepId,
} from "@/types/roteiro";
import {
  gravityLabel,
  parseRevisorHateRisk,
  parseRevisorNota,
} from "@/lib/parse-revisor-output";
import { useWizard } from "@/store/wizard";
import { useQueue } from "@/store/queue";

const HATE_RISK_EMOJI: Record<RevisorHateRisk, string> = {
  baixo: "🟢",
  medio: "🟡",
  alto: "🔴",
};

const GRAVISSIMO = gravityLabel("gravissimo");

type PartStatus = "idle" | "queued" | "running" | "ready";

/**
 * Abas Parte 1 / Parte 2 do step ÚNICO de Revisor. Substituem o antigo painel
 * "Revisão — as duas Partes": cada aba já carrega a nota + risco de hate +
 * correções pendentes daquela Parte, e clicar troca o step ativo
 * (revisor1 ↔ revisor2) — o corpo do step (relatório + cards) re-renderiza pra
 * a Parte selecionada. As ações ("Gerar as duas Partes" / "Continuar somente
 * Parte N") ficam no rodapé do step.
 */
export function RevisorPartTabs({
  currentStep,
}: {
  currentStep: RevisorStepId;
}) {
  const roteiro = useWizard((s) => s.roteiro);
  const setCurrentStep = useWizard((s) => s.setCurrentStep);
  const jobs = useQueue((s) => s.jobs);
  if (!roteiro) return null;

  const parts = REVISOR_STEPS.map((step) => {
    const part = step === "revisor1" ? 1 : 2;
    const out = roteiro.outputs[step];
    const content = out?.content?.trim() ?? "";
    const isSentinel = content.startsWith("[");
    const job = jobs.find(
      (j) =>
        j.roteiroId === roteiro.id &&
        j.step === step &&
        (j.status === "running" || j.status === "queued"),
    );
    let status: PartStatus = "idle";
    if (job) status = job.status === "running" ? "running" : "queued";
    else if (content && !isSentinel) status = "ready";

    // Último eval desta Parte (nota/hate/contagens). Fallback: parseia o
    // conteúdo direto (cobre roteiros antigos cujo eval ficou sem nota).
    const ev = [...(roteiro.evals ?? [])]
      .reverse()
      .find((e) => e.parte === part);
    const errors = out?.metadata?.errors ?? [];
    const nota =
      status === "ready" ? (ev?.nota ?? parseRevisorNota(content)) : null;
    const hateRisk =
      status === "ready"
        ? (ev?.hateRisk ?? parseRevisorHateRisk(content))
        : null;
    // Gravíssimos PENDENTES (não os já aplicados). Consistente com o banner do
    // veredito e com `pendentes` abaixo: um grave aplicado NÃO pode manter o
    // rótulo "🔴 N" nem travar o ✓/canFinish pra sempre. A fonte de verdade é o
    // array de erros ao vivo (reflete o `applied`); o eval snapshot (contagem
    // CONGELADA no momento da geração) só entra como fallback pra roteiros
    // antigos sem erros estruturados — que não têm como aplicar de qualquer jeito.
    const gravissimos =
      errors.length > 0
        ? errors.filter((e) => e.gravidade === "gravissimo" && !e.applied)
            .length
        : (ev?.counts.gravissimo ?? 0);
    const pendentes = errors.filter((e) => !e.applied).length;
    const canFinish = nota !== null && nota >= 8 && gravissimos === 0;

    return {
      step,
      part,
      status,
      phase: job?.phase,
      nota,
      hateRisk,
      gravissimos,
      pendentes,
      canFinish,
    };
  });

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto border-b -mx-1 px-1">
      {parts.map((p) => {
        const active = p.step === currentStep;
        return (
          <button
            key={p.step}
            type="button"
            onClick={() => setCurrentStep(p.step)}
            className={cn(
              "group flex flex-col gap-1 shrink-0 rounded-t-md border border-b-0 px-4 py-2.5 text-left transition min-w-[180px]",
              active
                ? "bg-card border-border"
                : "bg-muted/40 border-transparent hover:bg-muted",
            )}
          >
            <span
              className={cn(
                "text-sm",
                active ? "font-semibold" : "font-medium text-muted-foreground",
              )}
            >
              Revisor — Parte {p.part}
            </span>

            {p.status === "running" || p.status === "queued" ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                <Loader2 className="size-3 animate-spin" />
                {p.status === "queued" ? "na fila…" : (p.phase ?? "gerando…")}
              </span>
            ) : p.status === "ready" ? (
              <span className="flex items-center gap-2 flex-wrap text-xs tabular-nums">
                <span className="font-semibold">
                  ⭐ {p.nota !== null ? `${p.nota}/10` : "—"}
                </span>
                {p.hateRisk && <span>{HATE_RISK_EMOJI[p.hateRisk]}</span>}
                {p.gravissimos > 0 && (
                  <span className="text-rose-700">
                    {GRAVISSIMO.emoji} {p.gravissimos}
                  </span>
                )}
                {p.canFinish && (
                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                )}
                <span
                  className={cn(
                    p.pendentes > 0
                      ? "font-medium text-amber-700"
                      : "text-muted-foreground",
                  )}
                >
                  {p.pendentes > 0
                    ? `${p.pendentes} pendente${p.pendentes === 1 ? "" : "s"}`
                    : "sem pendências"}
                </span>
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                ainda não gerada
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
