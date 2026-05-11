"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  open: boolean;
  /** Rótulo legível do escopo que vai ser reescrito ("Cap. 4 da Parte 2"). */
  scopeLabel: string;
  /** Estimativa de palavras do escopo, pra usuária dimensionar o impacto. */
  approxWords?: number;
  /** Título curto do erro pra contexto. */
  errorTitle?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal de confirmação antes de mandar o Opus reescrever um capítulo inteiro.
 * Só aparece quando o erro NÃO tem âncora cirúrgica (window) — caso de erro
 * "informativo" do tipo "Adicionar epílogo" ou âncora desordenada que nem
 * o fallback de partial-match conseguiu localizar.
 *
 * Existe pra evitar a percepção de "a IA tá reescrevendo a história inteira":
 * a usuária aprova explicitamente cada reescrita de cap inteiro.
 */
export function ConfirmAiRewriteDialog({
  open,
  scopeLabel,
  approxWords,
  errorTitle,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-900">
            <AlertTriangle className="size-4 text-amber-700" />
            Reescrita ampla — confirmar?
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed pt-2">
            Esta correção <strong>não tem trecho âncora cirúrgico</strong>.
            Aplicar via IA vai regenerar o <strong>{scopeLabel}</strong>
            {typeof approxWords === "number" && approxWords > 0 ? (
              <> (~{approxWords.toLocaleString("pt-BR")} palavras)</>
            ) : null}{" "}
            inteiro com a sugestão aplicada. Outros eventos, diálogos e
            descrições devem ser preservados pelo Opus, mas o capítulo vai sair
            reescrito por inteiro.
          </DialogDescription>
        </DialogHeader>
        {errorTitle && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-muted-foreground">
              Erro:
            </span>{" "}
            <span className="text-foreground">{errorTitle}</span>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            className="bg-amber-600 hover:bg-amber-700 text-white"
            onClick={onConfirm}
          >
            Reescrever mesmo assim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
