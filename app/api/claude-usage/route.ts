/**
 * Uso acumulado da cota Claude nesta sessão do server Next (zera no restart do
 * server). O painel de métricas (`components/MetricsPanel.tsx`) lê daqui o hit%
 * de cache e o total de tokens consumidos da cota COMPARTILHADA da equipe — o
 * gargalo dominante. Só observabilidade: lê o acumulador module-level de
 * `lib/claude.ts`, não dispara nenhuma chamada ao modelo.
 */
import { getUsageTotals } from "@/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, ...getUsageTotals() });
}
