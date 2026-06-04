"use client";

import { useEffect, useRef } from "react";

import { isStorageReadBlocked, serializeLibraryForBackup } from "@/lib/storage";

const BACKUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const KICKOFF_DELAY_MS = 15_000;

/**
 * Auto-backup da biblioteca em disco (só no Electron). A cada ~5 min e ao
 * esconder a janela, manda a biblioteca serializada pro main process gravar
 * em userData/backups (rotativo, mantém os últimos N). É a rede de segurança
 * FORA do localStorage: se o storage corromper ou encher, ainda existem
 * cópias em disco.
 *
 * No-op fora do Electron (`window.mystorieslena` ausente) e quando a leitura
 * está bloqueada (não sobrescreve backups bons com o estado de erro). Dedupe
 * por igualdade de string — não regrava se nada mudou desde o último backup.
 *
 * Plugado em app/layout.tsx.
 */
export function LibraryBackup() {
  const lastRef = useRef<string | null>(null);

  useEffect(() => {
    const bridge = window.mystorieslena;
    if (!bridge?.autoBackupRoteiros) return;

    const backup = () => {
      if (isStorageReadBlocked()) return;
      let data: string;
      try {
        data = serializeLibraryForBackup();
      } catch {
        return;
      }
      if (!data || data === "[]") return; // nada pra salvar
      if (data === lastRef.current) return; // sem mudança
      lastRef.current = data;
      void bridge.autoBackupRoteiros(data).catch(() => {
        // best-effort; não trava a UI
      });
    };

    const interval = window.setInterval(backup, BACKUP_INTERVAL_MS);
    const kickoff = window.setTimeout(backup, KICKOFF_DELAY_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") backup();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(kickoff);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
