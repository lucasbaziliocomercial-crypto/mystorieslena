"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  deleteRoteiro,
  listRoteiros,
  newRoteiroId,
  saveRoteiro,
  serializeLibraryForBackup,
} from "@/lib/storage";
import { downloadFile } from "@/lib/backup";
import type { Roteiro } from "@/types/roteiro";
import { STEP_ORDER } from "@/types/roteiro";
import { CATEGORIES } from "@/lib/categories";
import type { RoteiroCategory } from "@/lib/categories/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialogRoot,
  AlertDialog,
} from "./AlertDialog";
import { CategoryPicker } from "./CategoryPicker";
import { QueuePanel } from "@/components/queue/QueuePanel";
import { RestoreBackupDialog } from "@/components/RestoreBackupDialog";
import { ClearCacheButton } from "@/components/ClearCacheButton";
import { useQueue } from "@/store/queue";
import { useTabs } from "@/store/tabs";
import {
  ArrowRight,
  Download,
  FileText,
  History,
  Layers,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

export function RoteiroList() {
  const router = useRouter();
  const [roteiros, setRoteiros] = useState<Roteiro[]>([]);
  const [ready, setReady] = useState(false);
  const [toDelete, setToDelete] = useState<Roteiro | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Assinatura estável dos jobs ativos (queued/running) — muda só em TRANSIÇÃO
  // de status, NÃO a cada tick de progresso (updateJob dispara a cada chunk do
  // stream em 2º plano). Sem isso, a lista re-renderizava e o refresh()
  // (listRoteiros) rodava a cada tick. Como string primitiva, o seletor só
  // notifica quando o conteúdo muda de verdade.
  const jobsSig = useQueue((s) =>
    s.jobs
      .filter((j) => j.status === "queued" || j.status === "running")
      .map((j) => `${j.roteiroId}:${j.status}`)
      .join("|"),
  );
  const activeJobByRoteiro = useMemo(() => {
    const m = new Map<string, "queued" | "running">();
    if (jobsSig) {
      for (const part of jobsSig.split("|")) {
        const sep = part.lastIndexOf(":");
        if (sep > 0) {
          m.set(part.slice(0, sep), part.slice(sep + 1) as "queued" | "running");
        }
      }
    }
    return m;
  }, [jobsSig]);
  const enqueue = useQueue((s) => s.enqueue);
  const closeTab = useTabs((s) => s.closeTab);

  const refresh = useCallback(() => {
    setRoteiros(listRoteiros());
  }, []);

  // Enfileira a Escrita de um roteiro pra rodar em 2º plano. Pede permissão de
  // notificação aqui (gesto do usuário) — o QueueRunner usa se concedida.
  const handleEnqueueEscrita = useCallback(
    (r: Roteiro) => {
      try {
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "default"
        ) {
          void Notification.requestPermission();
        }
      } catch {
        // ambiente sem Notification — segue sem notificação nativa.
      }
      enqueue(r.id, r.title, "escrita");
    },
    [enqueue],
  );

  useEffect(() => {
    refresh();
    setReady(true);
  }, [refresh]);

  // Quando a fila em 2º plano muda de STATUS (ex.: um job concluiu e gravou a
  // Escrita no storage), recarrega a lista pra o contador "X de Y etapas"
  // refletir. Depende de jobsSig (não do array jobs) pra NÃO re-ler o storage a
  // cada tick de progresso.
  useEffect(() => {
    refresh();
  }, [jobsSig, refresh]);

  const handlePickCategory = useCallback(
    (category: RoteiroCategory) => {
      const id = newRoteiroId();
      const now = new Date().toISOString();
      const r: Roteiro = {
        id,
        title: `Novo roteiro — ${new Date().toLocaleString("pt-BR")}`,
        category,
        createdAt: now,
        updatedAt: now,
        currentStep: "premissa",
        outputs: {},
      };
      saveRoteiro(r);
      router.push(`/roteiro/${id}`);
    },
    [router],
  );

  const openPicker = useCallback(() => setPickerOpen(true), []);

  // Backup manual: salva toda a biblioteca num .json. No Electron abre o dialog
  // nativo "Salvar como"; no navegador puro dispara um download.
  const handleExportLibrary = useCallback(async () => {
    const data = serializeLibraryForBackup();
    const date = new Date().toISOString().slice(0, 10);
    await downloadFile(data, `biblioteca-mystorieslena-${date}.json`);
  }, []);

  const confirmDelete = useCallback(() => {
    if (!toDelete) return;
    deleteRoteiro(toDelete.id);
    closeTab(toDelete.id);
    setToDelete(null);
    refresh();
  }, [toDelete, refresh, closeTab]);

  if (!ready) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Carregando...
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <h2 className="text-xl font-serif">Seus roteiros</h2>
        <div className="flex items-center gap-2">
          {roteiros.length > 0 && (
            <Button
              onClick={handleExportLibrary}
              variant="outline"
              className="gap-2"
              title="Salva uma cópia de todos os seus roteiros num arquivo .json (backup de segurança)"
            >
              <Download className="size-4" />
              Exportar biblioteca
            </Button>
          )}
          <Button
            onClick={() => setRestoreOpen(true)}
            variant="outline"
            className="gap-2"
            title="Restaura a biblioteca a partir de um backup automático ou de um arquivo exportado"
          >
            <History className="size-4" />
            Restaurar backup
          </Button>
          <ClearCacheButton />
          <Button onClick={openPicker} className="gap-2" size="lg">
            <Plus className="size-4" />
            Novo roteiro
          </Button>
        </div>
      </div>

      <QueuePanel />

      {roteiros.length === 0 ? (
        <Card className="py-16 px-6 flex flex-col items-center gap-3 text-center border-dashed">
          <FileText className="size-10 text-muted-foreground" />
          <h3 className="font-serif text-lg">Nenhum roteiro ainda</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Clique em <span className="font-semibold">Novo roteiro</span> para
            começar. As 5 etapas guiam você da premissa até o roteiro final.
          </p>
          <Button onClick={openPicker} className="mt-2 gap-2">
            <Plus className="size-4" />
            Criar primeiro roteiro
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3">
          {roteiros.map((r) => {
            const completed = STEP_ORDER.filter(
              (s) => !!r.outputs[s]?.content,
            ).length;
            const activeJob = activeJobByRoteiro.get(r.id);
            // Escrita em 2º plano só faz sentido com as duas estruturas prontas.
            const canQueueEscrita =
              !!r.outputs.estrutura1?.content?.trim() &&
              !!r.outputs.estrutura2?.content?.trim();
            return (
              <Card
                key={r.id}
                className="p-4 sm:p-5 flex items-center gap-4 flex-wrap hover:border-primary/40 transition"
              >
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/roteiro/${r.id}`}
                    className="block hover:underline underline-offset-4"
                  >
                    <h3 className="font-serif text-base sm:text-lg truncate">
                      {r.title}
                    </h3>
                  </Link>
                  <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-muted-foreground">
                    <Badge variant="outline" className="font-normal">
                      {CATEGORIES[r.category].label}
                    </Badge>
                    <Badge variant="secondary" className="font-normal">
                      {completed} de {STEP_ORDER.length} etapas
                    </Badge>
                    <span>·</span>
                    <span>
                      Atualizado{" "}
                      {new Date(r.updatedAt).toLocaleString("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {activeJob ? (
                    <Badge
                      variant="secondary"
                      className="gap-1 font-normal whitespace-nowrap"
                    >
                      {activeJob === "running" ? (
                        <>
                          <Loader2 className="size-3 animate-spin" /> Gerando…
                        </>
                      ) : (
                        "Na fila"
                      )}
                    </Badge>
                  ) : canQueueEscrita ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 whitespace-nowrap"
                      onClick={() => handleEnqueueEscrita(r)}
                      title="Gera a Escrita deste roteiro em 2º plano enquanto você trabalha em outro — sem travar a produção principal"
                    >
                      <Layers className="size-4" /> 2º plano
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setToDelete(r)}
                    aria-label="Excluir roteiro"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  <Link href={`/roteiro/${r.id}`}>
                    <Button variant="ghost" size="sm" className="gap-1">
                      Abrir <ArrowRight className="size-4" />
                    </Button>
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onConfirm={handlePickCategory}
      />

      <RestoreBackupDialog open={restoreOpen} onOpenChange={setRestoreOpen} />

      <AlertDialogRoot open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialog
          title="Excluir roteiro?"
          description={`"${toDelete?.title}" será removido permanentemente do seu navegador.`}
          confirmLabel="Excluir"
          onCancel={() => setToDelete(null)}
          onConfirm={confirmDelete}
          destructive
        />
      </AlertDialogRoot>
    </>
  );
}
