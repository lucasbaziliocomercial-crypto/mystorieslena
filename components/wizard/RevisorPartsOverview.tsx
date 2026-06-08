"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  REVISOR_STEPS,
  STEP_LABELS,
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

const HATE_RISK_LABEL: Record<
  RevisorHateRisk,
  { emoji: string; label: string }
> = {
  baixo: { emoji: "🟢", label: "hate baixo" },
  medio: { emoji: "🟡", label: "hate médio" },
  alto: { emoji: "🔴", label: "hate alto" },
};

const GRAVISSIMO = gravityLabel("gravissimo");

type PartStatus = "idle" | "queued" | "running" | "ready";

/**
 * Painel das DUAS Partes da revisão, fixo no topo dos steps revisor1/revisor2.
 * É o que organiza o fluxo paralelo: não importa em qual Parte você esteja, vê o
 * estado das duas (na fila / gerando / pronta + nota / hate / gravíssimos /
 * correções pendentes), pula entre elas, e dispara as ações "as duas Partes".
 * As ações per-Parte ("esta Parte") ficam nos botões do próprio step, abaixo —
 * a separação visual é o que evita misturar/desorganizar os dois revisores.
 */
export function RevisorPartsOverview({
  currentStep,
  busy,
  onGenerateBoth,
  onContinueBoth,
}: {
  /** Step de revisor atualmente aberto (pra destacar e não oferecer "ir"). */
  currentStep: RevisorStepId;
  /** Algum job de revisor (P1 ou P2) rodando/na fila — desabilita as ações. */
  busy: boolean;
  /** Enfileira revisor1 + revisor2 do zero (1ª passada / regerar). */
  onGenerateBoth: () => void;
  /** Re-roda revisor1 + revisor2 em modo continuação (não relista erros). */
  onContinueBoth: () => void;
}) {
  const roteiro = useWizard((s) => s.roteiro);
  const setCurrentStep = useWizard((s) => s.setCurrentStep);
  const jobs = useQueue((s) => s.jobs);
  if (!roteiro) return null;

  const bothReady = REVISOR_STEPS.every((step) => {
    const c = roteiro.outputs[step]?.content?.trim() ?? "";
    return c.length > 0 && !c.startsWith("[");
  });

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

    // Último eval desta Parte (já traz nota/hate/contagens). Fallback: parsear o
    // conteúdo direto (caso o eval ainda não tenha sido gravado).
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
    const gravissimos =
      ev?.counts.gravissimo ??
      errors.filter((e) => e.gravidade === "gravissimo").length;
    const pendentes = errors.filter((e) => !e.applied).length;
    const canFinish = nota !== null && nota >= 8 && gravissimos === 0;

    return {
      step,
      label: STEP_LABELS[step],
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
    <div className="rounded-lg border bg-muted/30 p-3 sm:p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-semibold">Revisão — as duas Partes</span>
        <span className="text-[11px] text-muted-foreground">
          gere/continue cada Parte e elas rodam em paralelo
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {parts.map((p) => {
          const isCurrent = p.step === currentStep;
          return (
            <div
              key={p.step}
              className={cn(
                "rounded-md border bg-background px-3 py-2.5 flex flex-col gap-1.5",
                isCurrent && "border-primary/50 ring-1 ring-primary/20",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{p.label}</span>
                {isCurrent ? (
                  <span className="text-[10px] font-medium text-primary">
                    você está aqui
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCurrentStep(p.step)}
                    className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    ir <ArrowRight className="size-3" />
                  </button>
                )}
              </div>

              {p.status === "running" || p.status === "queued" ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-primary">
                  <Loader2 className="size-3 animate-spin" />
                  {p.status === "queued" ? "na fila…" : (p.phase ?? "gerando…")}
                </span>
              ) : p.status === "ready" ? (
                <>
                  <div className="flex items-center gap-2 flex-wrap text-xs tabular-nums">
                    <span className="font-semibold">
                      ⭐ {p.nota !== null ? `${p.nota}/10` : "—"}
                    </span>
                    {p.hateRisk && (
                      <span title={HATE_RISK_LABEL[p.hateRisk].label}>
                        {HATE_RISK_LABEL[p.hateRisk].emoji}
                      </span>
                    )}
                    {p.gravissimos > 0 && (
                      <span className="text-rose-700">
                        {GRAVISSIMO.emoji} {p.gravissimos}
                      </span>
                    )}
                    {p.canFinish && (
                      <CheckCircle2 className="size-3.5 text-emerald-600" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[11px]",
                      p.pendentes > 0
                        ? "font-medium text-amber-700"
                        : "text-muted-foreground",
                    )}
                  >
                    {p.pendentes > 0
                      ? `${p.pendentes} correç${p.pendentes === 1 ? "ão" : "ões"} pendente${p.pendentes === 1 ? "" : "s"}`
                      : "sem correções pendentes"}
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  ainda não gerada
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={onGenerateBoth}
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={busy}
          title="Enfileira a revisão da Parte 1 e da Parte 2 ao mesmo tempo (rodam em paralelo). A Parte 2 roda sem o relatório da Parte 1 — re-rode depois pra pegar cruzamentos."
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Gerar as duas Partes
        </Button>
        <Button
          onClick={onContinueBoth}
          size="sm"
          className="gap-1.5"
          disabled={busy || !bothReady}
          title={
            bothReady
              ? "Re-roda a revisão da Parte 1 e da Parte 2 ao mesmo tempo, em modo continuação (não relista os erros já apontados)."
              : "Gere as duas Partes primeiro."
          }
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          Continuar as duas Partes
        </Button>
      </div>
    </div>
  );
}
