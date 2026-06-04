"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useWizard } from "@/store/wizard";
import { useQueue } from "@/store/queue";
import { abortJob } from "@/lib/generation/job-control";

/**
 * Card de Cânone de Entidades — aparece dentro do step Premissa, abaixo do
 * conteúdo da premissa, e trava o avanço pra Estrutura P1 enquanto não
 * estiver aprovado (em roteiros novos).
 *
 * A geração roda no GERENCIADOR persistente (`QueueRunner` → `runCanone`):
 * sobrevive a trocar/fechar a guia e roda concorrente com outros projetos,
 * igual aos steps. O resultado vai pra `roteiro.canone` (regerar invalida a
 * aprovação). O preview ao vivo usa `queueLiveStream` (só do roteiro aberto).
 */
export function CanoneCard() {
  const roteiro = useWizard((s) => s.roteiro);
  const approveCanone = useWizard((s) => s.approveCanone);
  const clearCanone = useWizard((s) => s.clearCanone);
  const setCanone = useWizard((s) => s.setCanone);
  const queueLiveStream = useWizard((s) => s.queueLiveStream);
  const enqueue = useQueue((s) => s.enqueue);
  const removeQueueJob = useQueue((s) => s.removeJob);

  const canoneJob = useQueue((s) =>
    roteiro
      ? s.jobs.find(
          (j) =>
            j.roteiroId === roteiro.id &&
            j.step === "canone" &&
            (j.status === "running" || j.status === "queued"),
        )
      : undefined,
  );
  // Erro do último job de cânone (pra mostrar feedback de falha).
  const canoneError = useQueue((s) =>
    roteiro
      ? s.jobs.find(
          (j) =>
            j.roteiroId === roteiro.id &&
            j.step === "canone" &&
            j.status === "error",
        )?.error
      : undefined,
  );

  if (!roteiro) return null;

  const premissaContent = roteiro.outputs.premissa?.content?.trim() ?? "";
  const canone = roteiro.canone ?? "";
  const canoneApproved = !!roteiro.canoneApproved;
  const hasCanone = canone.trim().length > 0;
  const generating = !!canoneJob;
  const displayedValue = generating ? queueLiveStream : canone;
  const canGenerate = premissaContent.length > 0 && !generating;

  const generate = () => {
    if (!canGenerate || !roteiro) return;
    // Limpa jobs de cânone finalizados/errados antigos deste roteiro.
    for (const j of useQueue.getState().jobs) {
      if (
        j.roteiroId === roteiro.id &&
        j.step === "canone" &&
        (j.status === "done" || j.status === "error")
      ) {
        removeQueueJob(j.id);
      }
    }
    enqueue(roteiro.id, roteiro.title, "canone");
  };

  const cancel = () => {
    if (!canoneJob) return;
    removeQueueJob(canoneJob.id);
    abortJob(canoneJob.id);
  };

  // Roteiro sem premissa preenchida: card fica oculto (cânone só faz sentido
  // depois que tem texto na premissa). O StepShell já renderiza primeiro.
  if (premissaContent.length === 0) return null;

  return (
    <Card className="border-amber-200 bg-amber-50/30 dark:border-amber-900/40 dark:bg-amber-950/20">
      <CardHeader>
        <CardTitle>Cânone de Entidades</CardTitle>
        <CardDescription>
          Lista travada de nomes, idades, profissões, lugares, datas e relações
          extraídos da premissa. Vai como referência canônica em todos os
          próximos steps (Estrutura P1, Estrutura P2, Escrita e Revisor) — sem
          isso o modelo às vezes troca nomes ou inventa idades ao longo do
          roteiro.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {!hasCanone && !generating && (
          <div className="rounded-md border border-amber-300/50 bg-amber-100/40 p-3 text-sm dark:border-amber-800/40 dark:bg-amber-900/20">
            Ainda não há cânone para esse roteiro. Clique em{" "}
            <strong>Gerar cânone</strong> para extrair as entidades da premissa.
            Você pode ajustar o texto antes de aprovar.
          </div>
        )}

        {generating && (
          <div className="rounded-md border border-blue-300/50 bg-blue-50 p-3 text-sm dark:border-blue-800/40 dark:bg-blue-950/30">
            {canoneJob?.status === "queued"
              ? "Na fila — começa em instantes…"
              : "Extraindo entidades da premissa…"}{" "}
            <span className="text-blue-900/70 dark:text-blue-100/60">
              Rodando em 2º plano — você pode trocar de guia que a geração
              continua.
            </span>
          </div>
        )}

        {canoneError && !generating && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800/40 dark:bg-red-950/30 dark:text-red-200">
            {canoneError}
          </div>
        )}

        {(hasCanone || generating) && (
          <Textarea
            value={displayedValue}
            onChange={(e) => {
              if (generating) return; // evita corrida com stream
              setCanone(e.target.value);
            }}
            placeholder="O cânone aparecerá aqui após a geração — você pode editar livremente."
            className="min-h-[280px] font-mono text-xs"
            readOnly={generating}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!generating ? (
            <Button
              type="button"
              size="sm"
              variant={hasCanone ? "outline" : "default"}
              onClick={generate}
              disabled={!canGenerate}
            >
              {hasCanone ? "Regerar cânone" : "Gerar cânone"}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={cancel}>
              Cancelar geração
            </Button>
          )}

          {hasCanone && !generating && (
            <>
              {canoneApproved ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
                  ✓ Cânone aprovado
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={approveCanone}
                  disabled={!hasCanone}
                >
                  Aprovar cânone
                </Button>
              )}

              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (
                    confirm(
                      "Limpar o cânone? Você poderá gerar de novo a partir da premissa.",
                    )
                  ) {
                    clearCanone();
                  }
                }}
              >
                Limpar
              </Button>
            </>
          )}
        </div>

        {hasCanone && !canoneApproved && !generating && (
          <p className="text-xs text-amber-900/80 dark:text-amber-100/70">
            ⚠️ Aprove o cânone para destravar o avanço pra Estrutura — Parte 1.
            Em roteiros legados (sem cânone), o avanço continua liberado mas
            sem o reforço de consistência.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
