/**
 * Log de consumo de tokens da equipe (server-side, roda no processo do Next).
 *
 * Captura no chokepoint `lib/claude.ts` (TODA chamada Claude passa por lá):
 * a cada `result` da SDK, `recordUsageEvent` grava um evento com os tokens
 * (input/output/cache) + metadados (roteirista, roteiroId, categoria, passo,
 * modelo, data) em DOIS lugares:
 *
 *   (a) `usage.jsonl` local (durabilidade + painel local via /api/claude-usage-log);
 *   (b) uma fila em memória que um forwarder envia em LOTE pro Google Sheets
 *       (Apps Script Web App) — a visão CENTRALIZADA da equipe.
 *
 * Regras de ouro (CLAUDE.md): só OBSERVABILIDADE. Best-effort e NON-BLOCKING —
 * nada aqui pode lançar pra cima nem atrasar a geração. **Nenhum texto da
 * história sai da máquina** — só números de tokens + metadados.
 *
 * Identidade: o app é single-user por máquina (1 processo Next = 1 roteirista),
 * então o nome é setado UMA vez via `setUsageWriter` (POST /api/usage-identity)
 * e reusado em todos os eventos — não precisa viajar em cada request. O
 * `roteiroId` varia por request e chega via `meta` (pode ficar vazio).
 *
 * IMPORTANTE: este módulo é carregado transitivamente por `lib/claude.ts`, que
 * o teste `node --experimental-strip-types scripts/test-build-prompt-input.mjs`
 * importa direto. Por isso: SÓ builtins do node (sem import de `@/...` de
 * valor), nada de top-level que segure o processo (o timer é lazy + unref).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Destino central (Apps Script Web App). Vem do env (dev/local) ou das
// constantes bakeadas no build (release da equipe). VAZIO = forwarding
// desligado: grava só o usage.jsonl local, sem enviar nada pela rede.
const SHEET_URL =
  process.env.MYSTORIESLENA_USAGE_SHEET_URL || /* BAKE_URL */ "";
// Token compartilhado — só desencoraja POST aleatório no endpoint público.
// Num app cliente não é segredo forte; o Apps Script valida pra evitar lixo.
const SHEET_TOKEN =
  process.env.MYSTORIESLENA_USAGE_SHEET_TOKEN || /* BAKE_TOKEN */ "";

const FLUSH_INTERVAL_MS = 10_000; // envia a fila a cada ~10s
const FLUSH_BATCH_TRIGGER = 25; // ou assim que juntar 25 eventos
const FLUSH_MAX_PER_POST = 100; // no máximo 100 eventos por POST
const MAX_QUEUE = 5000; // teto de segurança da fila em memória
const FILE_PRUNE_EVERY = 200; // a cada N appends, poda o arquivo
const FILE_KEEP_LINES = 5000; // mantém as últimas N linhas do usage.jsonl
const BACKOFF_MS = 30_000; // recuo após falha de envio

export interface UsageEvent {
  /** Id único — o Apps Script deduplica por ele (retries não duplicam). */
  id: string;
  ts: string; // ISO
  writer: string;
  roteiroId: string;
  category: string;
  step: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Campos que o chamador fornece (id/ts/writer são preenchidos aqui). */
export interface UsageEventInput {
  writer?: string;
  roteiroId?: string;
  category?: string;
  step?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface UsageLogState {
  writer: string;
  queue: UsageEvent[];
  counter: number;
  appendCount: number;
  timer: ReturnType<typeof setInterval> | null;
  flushing: boolean;
  backoffUntil: number;
}

// Estado module-level, ancorado no globalThis pra sobreviver ao re-eval do
// módulo no HMR do dev (senão o dev abriria N timers e N filas).
const g = globalThis as unknown as { __mysteriesUsageLog?: UsageLogState };
const state: UsageLogState =
  g.__mysteriesUsageLog ??
  (g.__mysteriesUsageLog = {
    writer: "",
    queue: [],
    counter: 0,
    appendCount: 0,
    timer: null,
    flushing: false,
    backoffUntil: 0,
  });

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function metricsDir(): string {
  return (
    process.env.MYSTORIESLENA_METRICS_DIR ||
    path.join(os.tmpdir(), "mystorieslena-metrics")
  );
}

function usageFilePath(): string {
  const dir = metricsDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "usage.jsonl");
}

/** Define o nome da roteirista desta máquina (1×, via /api/usage-identity). */
export function setUsageWriter(name: string): void {
  state.writer = String(name || "").trim().slice(0, 120);
}

export function getUsageWriter(): string {
  return state.writer;
}

/**
 * Registra um evento de consumo. NUNCA lança — qualquer falha é engolida pra
 * não derrubar a geração.
 */
export function recordUsageEvent(evt: UsageEventInput): void {
  try {
    state.counter += 1;
    const rand = Math.floor(Math.random() * 0xffffff).toString(16);
    const ev: UsageEvent = {
      id: `${Date.now().toString(36)}-${state.counter.toString(36)}-${rand}`,
      ts: new Date().toISOString(),
      writer: (evt.writer || state.writer || "desconhecido").slice(0, 120),
      roteiroId: String(evt.roteiroId || "").slice(0, 80),
      category: String(evt.category || ""),
      step: String(evt.step || ""),
      model: String(evt.model || ""),
      input: num(evt.input),
      output: num(evt.output),
      cacheRead: num(evt.cacheRead),
      cacheWrite: num(evt.cacheWrite),
    };
    appendLine(ev);
    if (SHEET_URL) {
      if (state.queue.length < MAX_QUEUE) state.queue.push(ev);
      ensureTimer();
      if (state.queue.length >= FLUSH_BATCH_TRIGGER) void flush();
    }
  } catch {
    /* best-effort */
  }
}

function appendLine(ev: UsageEvent): void {
  try {
    const file = usageFilePath();
    fs.appendFileSync(file, JSON.stringify(ev) + "\n", "utf8");
    state.appendCount += 1;
    if (state.appendCount % FILE_PRUNE_EVERY === 0) pruneFile(file);
  } catch {
    /* ignore */
  }
}

function pruneFile(file: string): void {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length > FILE_KEEP_LINES) {
      fs.writeFileSync(
        file,
        lines.slice(-FILE_KEEP_LINES).join("\n") + "\n",
        "utf8",
      );
    }
  } catch {
    /* ignore */
  }
}

function ensureTimer(): void {
  if (state.timer || !SHEET_URL) return;
  state.timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  // não segura o processo vivo (importante pro teste e pro shutdown limpo).
  state.timer.unref?.();
}

/**
 * Envia um lote da fila pro Apps Script. Sucesso → remove os enviados (por id).
 * Falha → mantém na fila e recua (retry no próximo tick). Nunca lança.
 */
async function flush(): Promise<void> {
  if (state.flushing || !SHEET_URL) return;
  if (Date.now() < state.backoffUntil) return;
  if (state.queue.length === 0) return;
  state.flushing = true;
  const batch = state.queue.slice(0, FLUSH_MAX_PER_POST);
  try {
    const res = await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: SHEET_TOKEN, events: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sent = new Set(batch.map((e) => e.id));
    state.queue = state.queue.filter((e) => !sent.has(e.id));
    state.backoffUntil = 0;
  } catch {
    state.backoffUntil = Date.now() + BACKOFF_MS;
  } finally {
    state.flushing = false;
  }
}

/** Lê as últimas N linhas do usage.jsonl local (pro painel). Vazio se não há. */
export function readUsageLog(limit = 2000): UsageEvent[] {
  try {
    const file = path.join(metricsDir(), "usage.jsonl");
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(1, limit));
    const out: UsageEvent[] = [];
    for (const ln of tail) {
      try {
        out.push(JSON.parse(ln) as UsageEvent);
      } catch {
        /* linha corrompida — pula */
      }
    }
    return out;
  } catch {
    return [];
  }
}
