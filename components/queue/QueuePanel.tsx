"use client";

/**
 * Painel da fila em 2º plano — mostra jobs em andamento / na fila / concluídos.
 * Lê `useQueue`; funciona em qualquer página (a fila é global). O motor que
 * roda os jobs é o `QueueRunner` (montado no layout raiz).
 */
import { useQueue, type QueueJob } from "@/store/queue";
import { abortJob } from "@/lib/generation/job-control";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
  Clock,
  RotateCcw,
} from "lucide-react";

function progressLabel(job: QueueJob): string {
  const p = job.progress;
  if (!p) return "Iniciando…";
  if (p.kind === "writing") {
    return `Escrevendo ${p.part} — cap. ${p.chapters.join(" e ")} (batch ${p.batchIndex}/${p.totalBatches})`;
  }
  return `Calibrando ${p.part} — cap. ${p.chapter} (${p.currentIndex}/${p.totalToCalibrate})`;
}

function StatusIcon({ status }: { status: QueueJob["status"] }) {
  if (status === "running")
    return <Loader2 className="size-4 text-primary animate-spin shrink-0" />;
  if (status === "done")
    return <CheckCircle2 className="size-4 text-emerald-600 shrink-0" />;
  if (status === "error")
    return <AlertTriangle className="size-4 text-destructive shrink-0" />;
  return <Clock className="size-4 text-muted-foreground shrink-0" />;
}

export function QueuePanel() {
  const jobs = useQueue((s) => s.jobs);
  const removeJob = useQueue((s) => s.removeJob);
  const enqueue = useQueue((s) => s.enqueue);
  const clearFinished = useQueue((s) => s.clearFinished);

  if (jobs.length === 0) return null;

  // Cancela/remove um job. Se estiver rodando, aborta a geração antes.
  const handleRemove = (job: QueueJob) => {
    removeJob(job.id);
    if (job.status === "running") abortJob(job.id);
  };

  // Retoma um job que falhou: remove o errado e re-enfileira com resume=true
  // (o motor pula os capítulos já feitos e gera só o que falta).
  const handleRetry = (job: QueueJob) => {
    removeJob(job.id);
    enqueue(job.roteiroId, job.roteiroTitle, job.step, job.userInput, true);
  };

  const hasFinished = jobs.some(
    (j) => j.status === "done" || j.status === "error",
  );

  return (
    <Card className="p-4 mb-6 border-primary/20 bg-primary/[0.02]">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="font-serif text-base flex items-center gap-2">
          <Clock className="size-4 text-primary" /> Fila em 2º plano
        </h3>
        {hasFinished && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFinished}
            className="text-xs h-7"
          >
            Limpar concluídos
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {jobs.map((job) => (
          <div key={job.id} className="flex items-center gap-3 text-sm">
            <StatusIcon status={job.status} />
            <div className="flex-1 min-w-0">
              <p className="truncate font-medium leading-tight">
                {job.roteiroTitle}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {job.status === "running"
                  ? progressLabel(job)
                  : job.status === "queued"
                    ? "Na fila — começa quando a produção em foco estiver livre"
                    : job.status === "done"
                      ? "Escrita concluída ✓"
                      : `Erro: ${job.error ?? "desconhecido"}`}
              </p>
            </div>
            <Badge variant="outline" className="font-normal text-[10px] shrink-0">
              Escrita
            </Badge>
            {job.status === "error" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs shrink-0"
                onClick={() => handleRetry(job)}
                title="Continuar de onde parou (gera só os capítulos que faltam)"
              >
                <RotateCcw className="size-3.5" />
                Continuar
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={() => handleRemove(job)}
              aria-label={
                job.status === "running" ? "Cancelar geração" : "Remover da fila"
              }
              title={
                job.status === "running" ? "Cancelar geração" : "Remover da fila"
              }
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
