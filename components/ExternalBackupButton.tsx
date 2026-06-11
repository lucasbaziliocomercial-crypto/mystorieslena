"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, Cloud, FolderOpen, Loader2 } from "lucide-react";

/**
 * Botão "Backup externo" (+ dialog). O backup automático já grava a cada ~5 min
 * em userData/backups (rede de segurança contra corrupção do localStorage). Este
 * controle adiciona uma cópia FORA da máquina: aponta pra uma pasta sincronizada
 * (OneDrive/Google Drive) e o auto-backup passa a gravar lá também um arquivo
 * rolante `veludo-roteiros-latest.json` — proteção contra perda da máquina.
 *
 * Só aparece dentro do Electron (precisa do dialog nativo de pasta). Advisory —
 * nunca bloqueia nada.
 */
export function ExternalBackupButton({ className }: { className?: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const bridge = window.mystorieslena;
    if (!bridge?.getExternalBackupDir) return;
    bridge
      .getExternalBackupDir()
      .then((res) => setDir(res.ok ? res.dir : null))
      .catch(() => {
        /* best-effort */
      });
  }, []);

  // Só habilita dentro do Electron (evita mismatch de hidratação: window só no client).
  useEffect(() => {
    if (window.mystorieslena?.pickExternalBackupDir) {
      setAvailable(true);
      refresh();
    }
  }, [refresh]);

  const choose = useCallback(async () => {
    const bridge = window.mystorieslena;
    if (!bridge?.pickExternalBackupDir) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bridge.pickExternalBackupDir();
      if (res.ok && res.dir) {
        setDir(res.dir);
      } else if (!res.canceled) {
        setError(res.reason ?? "Não consegui salvar a pasta.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao escolher a pasta.");
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    const bridge = window.mystorieslena;
    if (!bridge?.clearExternalBackupDir) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.clearExternalBackupDir();
      setDir(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao remover.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (!available) return null;

  return (
    <>
      <Button
        onClick={() => {
          setError(null);
          refresh();
          setOpen(true);
        }}
        variant="outline"
        className={cn("relative gap-2", className)}
        title={
          dir
            ? `Backup externo ativo: ${dir}`
            : "Configure uma cópia de backup fora da máquina (OneDrive/Google Drive)"
        }
      >
        <Cloud className="size-4" />
        Backup externo
        {dir && (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background"
          />
        )}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backup fora da máquina</DialogTitle>
            <DialogDescription>
              Além do backup automático no computador (a cada 5 minutos), o app
              pode copiar sua biblioteca para uma pasta sincronizada — como o
              OneDrive ou o Google Drive. Assim, se o computador estragar ou for
              perdido, seus roteiros continuam salvos na nuvem.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 text-sm">
            {dir ? (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">
                ✓ Backup externo ativo. A cada backup, o app grava o arquivo{" "}
                <span className="font-mono">veludo-roteiros-latest.json</span>{" "}
                nesta pasta:
                <br />
                <span className="break-all font-mono text-xs">{dir}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                Nenhuma pasta externa configurada. Escolha uma pasta dentro do
                seu OneDrive ou Google Drive para ativar o backup na nuvem.
              </p>
            )}

            {error && (
              <p className="flex items-start gap-2 text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            {dir && (
              <Button variant="ghost" onClick={clear} disabled={busy}>
                Remover
              </Button>
            )}
            <Button onClick={choose} disabled={busy} className="gap-2">
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Aguarde…
                </>
              ) : dir ? (
                <>
                  <FolderOpen className="size-4" /> Trocar pasta
                </>
              ) : (
                <>
                  <Check className="size-4" /> Escolher pasta
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
