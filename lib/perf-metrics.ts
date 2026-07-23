/**
 * Métricas de throughput da Escrita (Pilar C — "não dá pra otimizar o que não
 * se mede", aplicado à VELOCIDADE/cota, complementando os evals que medem
 * QUALIDADE). Cada geração emite um resumo (`onMetrics` em `run-escrita.ts`)
 * que o QueueRunner persiste num `.jsonl` em disco (via IPC do Electron). O
 * painel (`components/MetricsPanel.tsx`) lê de volta pra mostrar a curva de
 * tempo/palavras/429 ao longo das gerações — assim dá pra afinar
 * `MAX_CONCURRENT_STREAMS`/`CALIBRATION_CONCURRENCY` com dado, não no chute.
 *
 * Só observabilidade. Fora do Electron (browser / `npm run dev`) vira no-op —
 * não há onde gravar o arquivo.
 *
 * IMPORTANTE: este módulo é importado SÓ como tipo por `run-escrita.ts`
 * (`import type`), pra o motor headless não ganhar dependência de `window`.
 */

import type { RoteiroCategory } from "@/types/roteiro";

/** Resumo de uma geração de Escrita (uma linha do perf.jsonl). */
export interface EscritaPerfRecord {
  category: RoteiroCategory;
  /** ISO — início da fase de batches (geração+calibração). */
  startedAt: string;
  /** ISO — fim da geração. */
  finishedAt: string;
  /** Tempo de parede da geração+calibração, em ms. */
  totalMs: number;
  /** Total de palavras geradas (countWords da história inteira). */
  words: number;
  /** Nº de batches (P1 + P2). */
  batches: number;
  /** Retries transientes 408/429/5xx — sinal de saturação da cota da equipe. */
  transientRetries: number;
  /** Total de ms em backoff exponencial. */
  backoffMs: number;
  /**
   * Calibração (observabilidade pro checkup decidir CALIBRATION_MAX_PASSES /
   * mira da Escrita com dado). Opcionais — registros antigos do .jsonl não têm.
   */
  /** Caps fora do alvo ±8% que dispararam reescrita Sonnet (P1+P2). */
  calibCapsOutOfTarget?: number;
  /** Destes, quantos estavam CURTOS (muito "expandir" = Escrita escreve curto). */
  calibToExpand?: number;
  /** Quantos estavam LONGOS (precisaram encurtar). */
  calibToShorten?: number;
  /** Total de chamadas Sonnet de reescrita — mede a cauda do MAX_PASSES. */
  calibPasses?: number;
}

/**
 * Anexa um registro de perf ao .jsonl em disco (best-effort, Electron-only).
 * Nunca lança — instrumentação não pode derrubar a geração.
 */
export function appendPerfMetric(record: EscritaPerfRecord): void {
  try {
    const bridge =
      typeof window !== "undefined" ? window.mystorieslena : undefined;
    if (!bridge?.appendPerfMetric) return;
    void bridge.appendPerfMetric(JSON.stringify(record)).catch(() => {
      /* best-effort */
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Lê as últimas N gerações registradas (mais recente primeiro). Vazio fora do
 * Electron ou se o arquivo ainda não existe.
 */
export async function readPerfMetrics(
  limit = 50,
): Promise<EscritaPerfRecord[]> {
  try {
    const bridge =
      typeof window !== "undefined" ? window.mystorieslena : undefined;
    if (!bridge?.readPerfMetrics) return [];
    const res = await bridge.readPerfMetrics(limit);
    if (!res.ok || !Array.isArray(res.records)) return [];
    return res.records as EscritaPerfRecord[];
  } catch {
    return [];
  }
}
