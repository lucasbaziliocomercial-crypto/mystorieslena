/**
 * Define o nome da roteirista desta máquina pro log de consumo de tokens.
 *
 * O app é single-user por máquina (1 processo Next = 1 roteirista), então o
 * nome é setado UMA vez (no boot do app e quando muda no painel de Métricas) e
 * reusado em todos os eventos — não precisa viajar em cada request de geração.
 * Só observabilidade: guarda o nome em memória no processo do server.
 */
import { setUsageWriter, getUsageWriter } from "@/lib/usage-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let writer = "";
  try {
    const body = (await req.json()) as { writer?: string };
    writer = String(body?.writer ?? "");
  } catch {
    /* body vazio/ inválido — seta vazio mesmo */
  }
  setUsageWriter(writer);
  return Response.json({ ok: true, writer: getUsageWriter() });
}
