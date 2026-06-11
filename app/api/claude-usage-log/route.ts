/**
 * Histórico de consumo de tokens (lê o usage.jsonl local gravado por
 * `lib/usage-log.ts`) — o lado HISTÓRICO/persistente do consumo, complementando
 * o `/api/claude-usage` (que é só o acumulado volátil da sessão do server).
 *
 * Devolve agregados leves pro painel de Métricas: totais gerais + quebras por
 * dia, por passo, por categoria e por modelo. Só observabilidade — não dispara
 * nenhuma chamada ao modelo.
 */
import { readUsageLog, type UsageEvent } from "@/lib/usage-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  events: number;
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 };
}

function add(t: Totals, e: UsageEvent): void {
  t.input += e.input;
  t.output += e.output;
  t.cacheRead += e.cacheRead;
  t.cacheWrite += e.cacheWrite;
  t.events += 1;
}

function bucket(map: Record<string, Totals>, key: string, e: UsageEvent): void {
  const k = key || "—";
  (map[k] ??= emptyTotals());
  add(map[k], e);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(10000, Number(url.searchParams.get("limit")) || 5000),
  );

  const events = readUsageLog(limit);

  const totals = emptyTotals();
  const byDay: Record<string, Totals> = {};
  const byStep: Record<string, Totals> = {};
  const byCategory: Record<string, Totals> = {};
  const byModel: Record<string, Totals> = {};

  for (const e of events) {
    add(totals, e);
    bucket(byDay, (e.ts || "").slice(0, 10), e); // YYYY-MM-DD
    bucket(byStep, e.step, e);
    bucket(byCategory, e.category, e);
    bucket(byModel, e.model, e);
  }

  return Response.json({
    ok: true,
    count: events.length,
    totals,
    byDay,
    byStep,
    byCategory,
    byModel,
  });
}
