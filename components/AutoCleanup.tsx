"use client";

import { useEffect } from "react";

import { isStorageReadBlocked, pruneCacheLikeData } from "@/lib/storage";

const CLEAN_KEY = "veludo:lastCleanup";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KICKOFF_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // checa de hora em hora

/**
 * Agente de limpeza automática do localStorage "cache-like" — espelha o
 * `LibraryBackup` (kickoff + interval, silencioso e não-bloqueante). Roda no
 * máximo 1×/semana via o timestamp `veludo:lastCleanup` (o MESMO que o botão
 * "Limpar cache" grava), podando `history`/`evals` e recompactando o blob no
 * formato enxuto (imagens nas chaves laterais).
 *
 * NÃO toca nos roteiros nem nos caches do Chromium (disco) — a limpeza de disco
 * roda no main process (~20s após o boot) e no clique manual. Pula se a leitura
 * do storage está bloqueada (corrupção). Plugado em app/layout.tsx.
 */
export function AutoCleanup() {
  useEffect(() => {
    const maybeClean = () => {
      if (isStorageReadBlocked()) return;
      let last: string | null = null;
      try {
        last = localStorage.getItem(CLEAN_KEY);
      } catch {
        return;
      }
      const lastMs = last ? Date.parse(last) : NaN;
      // Ainda dentro da semana → não faz nada.
      if (!Number.isNaN(lastMs) && Date.now() - lastMs < WEEK_MS) return;
      try {
        const res = pruneCacheLikeData();
        localStorage.setItem(CLEAN_KEY, new Date().toISOString());
        if (res.changed) {
          console.info(
            `[cleanup] auto (semanal): ${res.prunedRoteiros} roteiros podados, -${res.removedEvals} evals`,
          );
        }
      } catch {
        /* best-effort — não trava a UI */
      }
    };

    const kickoff = window.setTimeout(maybeClean, KICKOFF_DELAY_MS);
    const interval = window.setInterval(maybeClean, CHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(interval);
    };
  }, []);

  return null;
}
