"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Download, Loader2 } from "lucide-react";
import type { Roteiro } from "@/types/roteiro";
import {
  buildEscritaHtmlDocument,
  detectMaleLeadFromFullRoteiro,
  escritaContentToHtml,
  extractFemaleLeadNameFromEstrutura,
  extractMaleLeadNameFromEstrutura,
} from "@/lib/export-html";
import { cn } from "@/lib/utils";

interface Props {
  roteiro: Roteiro;
  variant?: "default" | "outline" | "secondary";
  size?: "default" | "sm" | "lg";
  className?: string;
}

/**
 * Baixa o conteúdo da Escrita como PDF (quando rodando no Electron) ou
 * como .html (fallback no navegador). O PDF é gerado pelo Electron via
 * printToPDF nativo do Chromium — qualidade idêntica a "Imprimir → PDF"
 * do Chrome — e é salvo onde o usuário escolher.
 */
export function DownloadEscritaButton({
  roteiro,
  variant = "outline",
  size = "default",
  className,
}: Props) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "canceled">(
    "idle",
  );

  const handleClick = useCallback(async () => {
    const escritaContent = roteiro.outputs.escrita?.content?.trim();
    if (!escritaContent) {
      alert("Gere o roteiro primeiro pra baixar.");
      return;
    }

    setState("loading");
    try {
      const title = roteiro.title || "Roteiro";
      // Fonte primária: campo `Nome:` da seção "PROTAGONISTA MASCULINO
      // (MMC)" da Estrutura1/2. Fallback: heurística baseada nos POVs
      // marcados no roteiro inteiro.
      const maleLeadName =
        extractMaleLeadNameFromEstrutura(roteiro.outputs.estrutura1?.content) ??
        extractMaleLeadNameFromEstrutura(roteiro.outputs.estrutura2?.content) ??
        detectMaleLeadFromFullRoteiro(escritaContent);
      // Nome da FMC (heroína) da Estrutura — guarda dura: o POV dela NUNCA
      // fica verde na Parte 2. Sem heurística (só Estrutura).
      const femaleLeadName =
        extractFemaleLeadNameFromEstrutura(roteiro.outputs.estrutura1?.content) ??
        extractFemaleLeadNameFromEstrutura(roteiro.outputs.estrutura2?.content);
      // `chapters` vai pro export como source-of-truth da Parte (cada cap
      // sabe se é "Parte 1" ou "Parte 2"). Garante que a coloração verde
      // do MMC na Parte 2 sobreviva mesmo se o header `# PARTE 2` for
      // apagado por uma reescrita ou edição manual.
      const chapters = roteiro.outputs.escrita?.metadata?.chapters;
      const bodyHtml = escritaContentToHtml(escritaContent, {
        maleLeadName,
        femaleLeadName,
        chapters,
      });
      const html = buildEscritaHtmlDocument(title, bodyHtml);
      const safeName =
        (title || "roteiro").replace(/[^\w\s-]/g, "").trim() || "roteiro";

      const bridge = window.mystorieslena;

      if (bridge?.exportRoteiroPdf) {
        // Electron: usa o printToPDF nativo, que sai como o Chrome imprime.
        const result = await bridge.exportRoteiroPdf({
          html,
          filename: `${safeName}.pdf`,
          title,
        });
        if (result.canceled) {
          setState("canceled");
          setTimeout(() => setState("idle"), 1500);
          return;
        }
        if (!result.ok) {
          alert(`Erro ao gerar PDF: ${result.reason ?? "desconhecido"}`);
          setState("idle");
          return;
        }
        setState("done");
        setTimeout(() => setState("idle"), 2500);
        return;
      }

      // Fallback (browser): baixa o HTML — abrir e imprimir como PDF manualmente.
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setState("done");
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      console.error("Erro ao baixar roteiro:", err);
      setState("idle");
      alert("Não consegui gerar o arquivo. Tente novamente.");
    }
  }, [roteiro]);

  const isElectron = typeof window !== "undefined" && !!window.mystorieslena?.exportRoteiroPdf;
  const idleLabel = isElectron ? "Baixar roteiro (PDF)" : "Baixar roteiro (.html)";

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={state === "loading"}
      className={cn("gap-2", className)}
    >
      {state === "loading" && <Loader2 className="size-4 animate-spin" />}
      {state === "done" && <Check className="size-4 text-emerald-600" />}
      {(state === "idle" || state === "canceled") && (
        <Download className="size-4" />
      )}
      {state === "loading"
        ? "Gerando PDF..."
        : state === "done"
          ? "Baixado!"
          : state === "canceled"
            ? "Cancelado"
            : idleLabel}
    </Button>
  );
}
