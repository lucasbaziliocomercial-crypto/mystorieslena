"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readPerfMetrics, type EscritaPerfRecord } from "@/lib/perf-metrics";
import { getWriterName, setWriterName } from "@/lib/writer-identity";
import { Activity, Loader2 } from "lucide-react";

interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  hitPct: number;
}

interface LogTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  events: number;
}

interface UsageLog {
  count: number;
  totals: LogTotals;
  byDay: Record<string, LogTotals>;
  byStep: Record<string, LogTotals>;
}

const STEP_LABEL: Record<string, string> = {
  premissa: "Premissa",
  estrutura1: "Estrutura P1",
  estrutura2: "Estrutura P2",
  escrita: "Escrita",
  revisor1: "Revisor P1",
  revisor2: "Revisor P2",
  overview: "Overview",
  calibracao: "Calibração",
  "revisor-extract": "Revisor (extração)",
};

const CATEGORY_LABEL: Record<string, string> = {
  "milionario-1p": "Milionário 1ª",
  "milionario-3p": "Milionário 3ª",
  mafia: "Máfia",
  "alpha-king": "Alpha King",
};

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${String(rem).padStart(2, "0")}s` : `${rem}s`;
}

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMin = Math.round((Date.now() - t) / 60000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.round(h / 24)}d`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("pt-BR");
}

/**
 * Botão "Métricas" (+ dialog). Painel SOMENTE LEITURA de throughput/cota — o
 * lado VELOCIDADE do "medir pra otimizar" (os evals já cobrem a QUALIDADE).
 * Lê o perf.jsonl gravado por geração (`lib/perf-metrics.ts`, Electron) e o
 * acumulado de cota da sessão (`/api/claude-usage`). Advisory — nunca bloqueia.
 */
export function MetricsPanelButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<EscritaPerfRecord[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [log, setLog] = useState<UsageLog | null>(null);
  const [writer, setWriter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setWriter(getWriterName());
    try {
      const [recs, usageRes, logRes] = await Promise.all([
        readPerfMetrics(50),
        fetch("/api/claude-usage")
          .then((r) => r.json())
          .catch(() => null),
        fetch("/api/claude-usage-log")
          .then((r) => r.json())
          .catch(() => null),
      ]);
      setRecords(recs);
      setUsage(
        usageRes && usageRes.ok
          ? {
              input: usageRes.input ?? 0,
              cacheRead: usageRes.cacheRead ?? 0,
              cacheWrite: usageRes.cacheWrite ?? 0,
              output: usageRes.output ?? 0,
              hitPct: usageRes.hitPct ?? 0,
            }
          : null,
      );
      setLog(
        logRes && logRes.ok
          ? {
              count: logRes.count ?? 0,
              totals: logRes.totals,
              byDay: logRes.byDay ?? {},
              byStep: logRes.byStep ?? {},
            }
          : null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          void load();
        }}
        variant="outline"
        className={className}
        title="Velocidade das gerações e uso da cota Claude (cache hit%, tokens)"
      >
        <Activity className="size-4" />
        Métricas
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Métricas de geração</DialogTitle>
            <DialogDescription>
              Velocidade das últimas gerações da Escrita e uso da cota Claude.
              Serve para afinar a paralelização e ver quando a cota da equipe
              satura (muitos 429/backoff). Não altera nada — só informa.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Carregando…
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Identidade da roteirista — atribui o gasto no log central */}
              <div className="rounded-md border p-3">
                <label
                  htmlFor="writer-name"
                  className="mb-1 block text-sm font-medium"
                >
                  Seu nome
                </label>
                <p className="mb-2 text-xs text-muted-foreground">
                  Identifica quem gerou no monitoramento de tokens da equipe.
                  Salvo só neste computador; vai junto dos números (nunca o
                  texto das histórias).
                </p>
                <input
                  id="writer-name"
                  type="text"
                  value={writer}
                  onChange={(e) => setWriter(e.target.value)}
                  onBlur={() => setWriterName(writer)}
                  placeholder="Ex.: Maria"
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                  maxLength={120}
                />
              </div>

              {/* Consumo de tokens (histórico persistente, sobrevive ao restart) */}
              <div className="rounded-md border p-3">
                <h4 className="mb-2 text-sm font-medium">
                  Consumo de tokens (histórico)
                </h4>
                {log && log.totals ? (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                      <span className="text-muted-foreground">
                        Input:{" "}
                        <span className="font-medium text-foreground">
                          {fmtNum(log.totals.input)}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Output:{" "}
                        <span className="font-medium text-foreground">
                          {fmtNum(log.totals.output)}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Cache lido: {fmtNum(log.totals.cacheRead)}
                      </span>
                      <span className="text-muted-foreground">
                        Chamadas: {fmtNum(log.totals.events)}
                      </span>
                    </div>

                    {/* Por passo */}
                    {Object.keys(log.byStep).length > 0 && (
                      <div className="max-h-40 overflow-y-auto rounded-md border">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                            <tr>
                              <th className="px-2 py-1.5 text-left">Passo</th>
                              <th className="px-2 py-1.5 text-right">Input</th>
                              <th className="px-2 py-1.5 text-right">Output</th>
                              <th className="px-2 py-1.5 text-right">Chamadas</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(log.byStep)
                              .sort((a, b) => b[1].output - a[1].output)
                              .map(([step, t]) => (
                                <tr key={step} className="border-t">
                                  <td className="px-2 py-1.5">
                                    {STEP_LABEL[step] ?? step}
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    {fmtNum(t.input)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    {fmtNum(t.output)}
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    {fmtNum(t.events)}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Sem registros de consumo ainda. (O log em disco só existe no
                    app instalado, não no navegador.)
                  </p>
                )}
              </div>

              {/* Cota acumulada da sessão */}
              <div className="rounded-md border p-3">
                <h4 className="mb-2 text-sm font-medium">
                  Cota Claude (acumulado desta sessão)
                </h4>
                {usage ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                    <span className="text-muted-foreground">
                      Cache hit:{" "}
                      <span className="font-medium text-foreground">
                        {usage.hitPct}%
                      </span>
                    </span>
                    <span className="text-muted-foreground">
                      Input: {fmtNum(usage.input)}
                    </span>
                    <span className="text-muted-foreground">
                      Output: {fmtNum(usage.output)}
                    </span>
                    <span className="text-muted-foreground">
                      Cache lido: {fmtNum(usage.cacheRead)}
                    </span>
                    <span className="text-muted-foreground">
                      Cache escrito: {fmtNum(usage.cacheWrite)}
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Sem dados de cota ainda (zera ao reabrir o app).
                  </p>
                )}
              </div>

              {/* Histórico de gerações */}
              <div>
                <h4 className="mb-2 text-sm font-medium">
                  Últimas gerações ({records.length})
                </h4>
                {records.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhuma geração registrada ainda. Gere um roteiro completo
                    para começar a medir. (O registro em disco só existe no app
                    instalado, não no navegador.)
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                        <tr>
                          <th className="px-2 py-1.5 text-left">Quando</th>
                          <th className="px-2 py-1.5 text-left">Categoria</th>
                          <th className="px-2 py-1.5 text-right">Tempo</th>
                          <th className="px-2 py-1.5 text-right">Palavras</th>
                          <th className="px-2 py-1.5 text-right">Pal/min</th>
                          <th className="px-2 py-1.5 text-right">429</th>
                          <th className="px-2 py-1.5 text-right">Backoff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r, i) => {
                          const min = r.totalMs / 60000;
                          const wpm = min > 0 ? Math.round(r.words / min) : 0;
                          return (
                            <tr
                              key={`${r.finishedAt}-${i}`}
                              className="border-t"
                            >
                              <td className="px-2 py-1.5">
                                {fmtWhen(r.finishedAt)}
                              </td>
                              <td className="px-2 py-1.5">
                                {CATEGORY_LABEL[r.category] ?? r.category}
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                {fmtDuration(r.totalMs)}
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                {fmtNum(r.words)}
                              </td>
                              <td className="px-2 py-1.5 text-right">{wpm}</td>
                              <td
                                className={
                                  "px-2 py-1.5 text-right " +
                                  (r.transientRetries > 0
                                    ? "font-medium text-amber-600"
                                    : "")
                                }
                              >
                                {r.transientRetries}
                              </td>
                              <td className="px-2 py-1.5 text-right">
                                {fmtDuration(r.backoffMs)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
