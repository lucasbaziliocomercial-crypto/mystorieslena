"use client";

/**
 * Barra de guias (abas) dos projetos abertos. Renderizada no topo da página de
 * roteiro (`Wizard`). Clicar numa guia navega pro projeto; o "×" fecha a guia
 * (e, se for a ativa, vai pra outra guia ou pra home). Cada guia mostra um
 * indicador quando o roteiro está gerando/na fila em 2º plano.
 */
import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTabs } from "@/store/tabs";
import { useQueue } from "@/store/queue";
import { cn } from "@/lib/utils";
import { Loader2, Plus, X } from "lucide-react";

export function ProjectTabs({ activeId }: { activeId: string }) {
  const tabs = useTabs((s) => s.tabs);
  const closeTab = useTabs((s) => s.closeTab);
  // Assinatura de status dos jobs ativos — muda só em transição, não a cada tick
  // de progresso. Evita re-render da barra de guias a cada chunk do stream em 2º
  // plano (as guias só mostram um spinner/ponto por status).
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
  const router = useRouter();

  if (tabs.length <= 1) return null; // 1 só aberto não precisa de barra

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const remaining = tabs.filter((t) => t.id !== id);
    closeTab(id);
    if (id === activeId) {
      const next = remaining[remaining.length - 1];
      router.push(next ? `/roteiro/${next.id}` : "/");
    }
  };

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b pb-1 -mx-1 px-1">
      {tabs.map((t) => {
        const jobStatus = activeJobByRoteiro.get(t.id);
        const active = t.id === activeId;
        return (
          <Link
            key={t.id}
            href={`/roteiro/${t.id}`}
            className={cn(
              "group flex items-center gap-1.5 shrink-0 rounded-t-md border border-b-0 px-3 py-1.5 text-sm transition max-w-[200px]",
              active
                ? "bg-card border-border font-medium"
                : "bg-muted/40 border-transparent text-muted-foreground hover:bg-muted",
            )}
            title={t.title}
          >
            {jobStatus === "running" ? (
              <Loader2 className="size-3 animate-spin text-primary shrink-0" />
            ) : jobStatus === "queued" ? (
              <span
                className="size-2 rounded-full bg-amber-500 shrink-0"
                title="Na fila em 2º plano"
              />
            ) : null}
            <span className="truncate">{t.title}</span>
            <button
              type="button"
              onClick={(e) => handleClose(e, t.id)}
              aria-label={`Fechar guia ${t.title}`}
              className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-foreground/10"
            >
              <X className="size-3" />
            </button>
          </Link>
        );
      })}
      <Link
        href="/"
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition"
        title="Abrir/criar outro projeto"
        aria-label="Abrir outro projeto"
      >
        <Plus className="size-4" />
      </Link>
    </div>
  );
}
