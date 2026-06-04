"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { importLibraryFromString } from "@/lib/storage";
import type { RoteiroBackupEntry } from "@/types/electron-bridge";

function formatBackupLabel(e: RoteiroBackupEntry): string {
  const when = new Date(e.mtimeMs).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
  return `${when} · ${(e.size / 1024).toFixed(0)} KB`;
}

/** Conta roteiros sem aplicar. -1 = formato comprimido/legado (não previsível). */
function previewCount(data: string): number {
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return -1;
  }
}

type Pending = { data: string; count: number; label: string };

/**
 * Diálogo de restauração de backup. Oferece os backups automáticos (Electron)
 * e a opção de escolher um arquivo exportado. Tem um passo de confirmação
 * antes de SUBSTITUIR a biblioteca atual (que é guardada em pre-restore).
 * Após restaurar, recarrega a página pra reler o storage do zero.
 */
export function RestoreBackupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [backups, setBackups] = useState<RoteiroBackupEntry[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setPending(null);
      setError(null);
      return;
    }
    const bridge = window.mystorieslena;
    if (bridge?.listRoteiroBackups) {
      bridge
        .listRoteiroBackups()
        .then((res) => {
          if (res.ok) setBackups(res.backups);
        })
        .catch(() => {});
    }
  }, [open]);

  const choseAutoBackup = async (e: RoteiroBackupEntry) => {
    setError(null);
    const bridge = window.mystorieslena;
    if (!bridge?.readRoteiroBackup) return;
    const res = await bridge.readRoteiroBackup(e.name);
    if (!res.ok || !res.data) {
      setError(res.reason || "Falha ao ler o backup.");
      return;
    }
    setPending({
      data: res.data,
      count: previewCount(res.data),
      label: formatBackupLabel(e),
    });
  };

  const choseFile = async (file: File) => {
    setError(null);
    try {
      const data = await file.text();
      setPending({ data, count: previewCount(data), label: file.name });
    } catch {
      setError("Não consegui ler o arquivo.");
    }
  };

  const applyRestore = () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      importLibraryFromString(pending.data);
      // Reload completo: relê o storage e remonta tudo com a biblioteca nova.
      window.location.reload();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Falha ao restaurar.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restaurar backup</DialogTitle>
          <DialogDescription>
            {pending
              ? "Confirme a restauração abaixo. A biblioteca atual será substituída — uma cópia dela é guardada antes."
              : "Escolha um backup automático ou um arquivo que você exportou. Isso substitui a biblioteca atual."}
          </DialogDescription>
        </DialogHeader>

        {!pending ? (
          <div className="flex flex-col gap-4">
            {backups.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Backups automáticos
                </p>
                <div className="flex flex-col gap-1 max-h-48 overflow-auto">
                  {backups.map((b) => (
                    <button
                      key={b.name}
                      onClick={() => choseAutoBackup(b)}
                      className="text-left rounded-md border px-3 py-2 text-sm hover:border-primary/40 hover:bg-primary/[0.03] transition"
                    >
                      {formatBackupLabel(b)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Ou de um arquivo exportado
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.txt,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void choseFile(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                Escolher arquivo do computador
              </Button>
            </div>
            {error && <p className="text-xs text-red-700">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Origem: <span className="font-medium">{pending.label}</span>
            </p>
            <p>
              Roteiros no backup:{" "}
              <span className="font-medium">
                {pending.count >= 0 ? pending.count : "—"}
              </span>
            </p>
            <p className="text-xs text-amber-700">
              ⚠️ Isso substitui TODA a biblioteca atual por este backup. A
              biblioteca atual é guardada numa cópia (pre-restore) antes.
            </p>
            {error && <p className="text-xs text-red-700">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {pending ? (
            <>
              <Button
                variant="ghost"
                onClick={() => setPending(null)}
                disabled={busy}
              >
                Voltar
              </Button>
              <Button onClick={applyRestore} disabled={busy}>
                {busy ? "Restaurando…" : "Substituir e restaurar"}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
