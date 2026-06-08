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
import { getRoteirosBlobBytes, pruneCacheLikeData } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, Loader2, Sparkles } from "lucide-react";

/** Timestamp ISO da última limpeza (manual ou automática). Lido pelo AutoCleanup. */
const CLEAN_KEY = "veludo:lastCleanup";
const WEEK_DAYS = 7;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

function lastCleanupHint(iso: string | null): string {
  const d = daysSince(iso);
  if (d === null) return "O cache nunca foi limpo.";
  if (d <= 0) return "Cache limpo hoje.";
  if (d === 1) return "Última limpeza ontem.";
  return `Última limpeza há ${d} dias.`;
}

type State =
  | { kind: "measuring" }
  | { kind: "confirm"; sizeBytes: number }
  | { kind: "clearing" }
  | { kind: "done"; freedBytes: number }
  | { kind: "error"; message: string };

/**
 * Botão "Limpar cache" (+ dialog próprio). Libera espaço e mantém o app leve sem
 * tocar nos roteiros salvos:
 *  • Renderer: `pruneCacheLikeData()` poda history/evals e recompacta o blob.
 *  • Main (Electron): `clearCache()` limpa caches do Chromium + poda backups + log.
 *
 * Sem Electron (navegador / `npm run dev`), roda só a parte do localStorage —
 * degradação graciosa. Grava `veludo:lastCleanup` (alimenta o nudge semanal e o
 * AutoCleanup). Auto-fecha no sucesso. Advisory — nunca bloqueia nada.
 */
export function ClearCacheButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "measuring" });
  const [lastCleanup, setLastCleanup] = useState<string | null>(null);

  // Relê o lastCleanup ao montar e sempre que o dialog abre/fecha.
  useEffect(() => {
    try {
      setLastCleanup(localStorage.getItem(CLEAN_KEY));
    } catch {
      /* ignore */
    }
  }, [open]);

  const overdue = (daysSince(lastCleanup) ?? Infinity) >= WEEK_DAYS;

  const openDialog = useCallback(() => {
    setOpen(true);
    setState({ kind: "measuring" });
    const bridge = window.mystorieslena;
    const blobBytes = getRoteirosBlobBytes();
    if (bridge?.getCacheSize) {
      bridge
        .getCacheSize()
        .then((res) =>
          setState({
            kind: "confirm",
            sizeBytes: (res.ok ? res.totalBytes : 0) + blobBytes,
          }),
        )
        .catch(() => setState({ kind: "confirm", sizeBytes: blobBytes }));
    } else {
      setState({ kind: "confirm", sizeBytes: blobBytes });
    }
  }, []);

  const doClear = useCallback(async () => {
    setState({ kind: "clearing" });
    const bridge = window.mystorieslena;
    try {
      // Renderer: poda localStorage (history/evals) + recompacta o blob enxuto.
      const prune = pruneCacheLikeData();
      const localFreed = Math.max(0, prune.beforeBytes - prune.afterBytes);
      // Main: caches do Chromium + backups antigos + log do servidor.
      let mainFreed = 0;
      if (bridge?.clearCache) {
        const res = await bridge.clearCache();
        if (!res.ok) {
          throw new Error(res.reason ?? "Falha ao limpar o cache do app.");
        }
        mainFreed = res.freedBytes ?? 0;
      }
      const now = new Date().toISOString();
      try {
        localStorage.setItem(CLEAN_KEY, now);
      } catch {
        /* ignore */
      }
      setLastCleanup(now);
      setState({ kind: "done", freedBytes: mainFreed + localFreed });
      // Auto-fecha após mostrar o resultado (padrão UpdateButton).
      setTimeout(() => setOpen(false), 2500);
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Falha ao limpar.",
      });
    }
  }, []);

  const clearing = state.kind === "clearing";

  return (
    <>
      <Button
        onClick={openDialog}
        variant="outline"
        className={cn("relative gap-2", className)}
        title={`Libera espaço e deixa o app mais rápido. Seus roteiros NÃO são apagados. ${lastCleanupHint(lastCleanup)}`}
      >
        <Sparkles className="size-4" />
        Limpar cache
        {overdue && (
          // Nudge sutil: ponto âmbar quando faz ≥ 7 dias (ou nunca).
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-2.5 rounded-full bg-amber-500 ring-2 ring-background"
          />
        )}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          // Não fecha no meio da limpeza.
          if (clearing) return;
          setOpen(o);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Limpar cache do app</DialogTitle>
            <DialogDescription>
              Isto apaga só os arquivos temporários que o app cria sozinho (cache
              de navegação, backups antigos além dos 5 mais recentes, históricos
              de desfazer e logs). Deixa tudo mais leve e rápido.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 text-sm">
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-800">
              ✓ Seus roteiros continuam salvos. Nada do seu trabalho é apagado.
            </p>

            {state.kind === "measuring" && (
              <p className="text-muted-foreground">Calculando espaço…</p>
            )}

            {state.kind === "confirm" && (
              <>
                <p className="text-muted-foreground">
                  {state.sizeBytes > 0
                    ? `Dá pra liberar cerca de ${formatBytes(state.sizeBytes)}.`
                    : "Quase não há nada pra limpar — o app já está leve."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {lastCleanupHint(lastCleanup)} Você pode fazer isso toda
                  semana, sem medo.
                </p>
              </>
            )}

            {state.kind === "clearing" && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Limpando…
              </p>
            )}

            {state.kind === "done" && (
              <p className="flex items-center gap-2 font-medium text-emerald-700">
                <Check className="size-4" />
                {state.freedBytes > 0
                  ? `Pronto! Liberei ${formatBytes(state.freedBytes)} de espaço.`
                  : "Pronto! O app já estava limpo."}
              </p>
            )}

            {state.kind === "error" && (
              <p className="flex items-start gap-2 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                Não consegui limpar agora: {state.message}. Seus roteiros estão a
                salvo — pode tentar de novo.
              </p>
            )}
          </div>

          <DialogFooter>
            {state.kind === "done" ? (
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Fechar
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={clearing}
                >
                  Agora não
                </Button>
                <Button onClick={doClear} disabled={clearing}>
                  {clearing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Limpando…
                    </>
                  ) : (
                    "Limpar agora"
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
