"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { flushPendingSave, isStorageReadBlocked } from "@/lib/storage";

/**
 * Guarda de saúde do armazenamento local. Cobre dois cenários:
 *
 *  1. `veludo:storage-quota-exceeded` — o localStorage estourou (~5MB). Mostra
 *     dialog pedindo pra apagar roteiros antigos.
 *  2. `veludo:storage-read-failed` / `veludo:storage-write-blocked` — a leitura
 *     inicial falhou (blob corrompido). O storage preservou o blob num backup
 *     e BLOQUEOU escrita pra não sobrescrever os dados reais. Avisa a usuária
 *     a NÃO recriar roteiros (podem ser recuperáveis) e a reiniciar o app.
 *
 * Sem esses guards, o erro de quota crashava o renderer (tela branca) e a
 * falha de leitura levava a um wipe silencioso da biblioteca no save seguinte.
 *
 * Plugado em app/layout.tsx pra ficar disponível em qualquer rota.
 */
export function StorageQuotaGuard() {
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [readFailedOpen, setReadFailedOpen] = useState(false);

  useEffect(() => {
    const onQuota = () => setQuotaOpen(true);
    const onReadFailed = () => setReadFailedOpen(true);
    window.addEventListener("veludo:storage-quota-exceeded", onQuota);
    window.addEventListener("veludo:storage-read-failed", onReadFailed);
    window.addEventListener("veludo:storage-write-blocked", onReadFailed);
    // A leitura é lazy: o evento pode ter disparado antes deste listener
    // montar. Checa o estado atual no mount pra cobrir essa corrida.
    if (isStorageReadBlocked()) setReadFailedOpen(true);
    return () => {
      window.removeEventListener("veludo:storage-quota-exceeded", onQuota);
      window.removeEventListener("veludo:storage-read-failed", onReadFailed);
      window.removeEventListener("veludo:storage-write-blocked", onReadFailed);
    };
  }, []);

  // beforeunload: o scheduleSave debouncer pode ter até 600ms enfileirado.
  // Se a usuária fechar a janela do Electron antes do timer, a última
  // edição se perderia. Aqui fazemos flush síncrono — beforeunload é o
  // último ponto onde dá pra gravar localStorage de forma garantida.
  useEffect(() => {
    const flush = () => flushPendingSave();
    window.addEventListener("beforeunload", flush);
    // pagehide cobre cenários onde beforeunload não dispara (mobile, BFCache).
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return (
    <>
      <Dialog open={quotaOpen} onOpenChange={setQuotaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Espaço de armazenamento cheio</DialogTitle>
            <DialogDescription>
              O navegador interno do app não conseguiu salvar o roteiro porque o
              espaço local (~5 MB) está cheio. Apague roteiros antigos da tela
              inicial pra liberar espaço — sem isso, o que você está editando
              agora não vai ser preservado quando fechar o app.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setQuotaOpen(false)}>Entendi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={readFailedOpen} onOpenChange={setReadFailedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Não consegui abrir sua biblioteca</DialogTitle>
            <DialogDescription>
              Houve um erro ao ler os roteiros salvos, então o app fez uma cópia
              de segurança dos seus dados e PAROU de gravar pra não apagar nada.
              A biblioteca pode aparecer vazia agora, mas seus dados não foram
              perdidos. NÃO recrie os roteiros do zero. Feche e abra o app de
              novo — se continuar assim, fale com o suporte antes de mexer em
              qualquer coisa.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setReadFailedOpen(false)}>Entendi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
