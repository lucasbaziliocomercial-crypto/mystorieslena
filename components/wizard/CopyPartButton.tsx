"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy, Loader2 } from "lucide-react";
import type { Roteiro } from "@/types/roteiro";
import {
  buildEscritaHtmlDocument,
  detectMaleLeadFromFullRoteiro,
  escritaContentToHtml,
  escritaContentToPlainText,
  extractFemaleLeadFullNameFromEstrutura,
  extractMaleLeadFullNameFromEstrutura,
  splitRoteiroByParts,
} from "@/lib/export-html";
import { cn } from "@/lib/utils";

interface Props {
  roteiro: Roteiro;
  part: 1 | 2;
  variant?: "default" | "outline" | "secondary";
  size?: "default" | "sm" | "lg";
  className?: string;
}

/**
 * Copia só uma parte do roteiro (P1 ou P2) formatada em HTML pro clipboard.
 * Pensado pro fluxo de duas guias (tabs) no Google Docs: cria 2 abas no Docs,
 * cola Parte 1 numa, Parte 2 na outra. O HTML não inclui o marcador `PARTE X`
 * (ele já vira o nome da aba), só o conteúdo dos capítulos.
 */
export function CopyPartButton({
  roteiro,
  part,
  variant = "outline",
  size = "default",
  className,
}: Props) {
  const [state, setState] = useState<
    "idle" | "loading" | "copied" | "empty"
  >("idle");

  const handleClick = useCallback(async () => {
    const escritaContent = roteiro.outputs.escrita?.content?.trim();
    if (!escritaContent) {
      alert("Gere o roteiro primeiro pra copiar.");
      return;
    }

    const { parte1, parte2 } = splitRoteiroByParts(escritaContent);
    const partContent = part === 1 ? parte1 : parte2;

    if (!partContent) {
      setState("empty");
      setTimeout(() => setState("idle"), 2500);
      return;
    }

    setState("loading");
    try {
      // Destaque verde do MMC sai só na Parte 2. Quando o usuário copia a
      // Parte 1, desativa via `maleLeadName: null`. Quando copia a Parte 2,
      // o conteúdo já vem sem o header `# PARTE 2` (`splitRoteiroByParts`
      // remove ele) — `forceParte2: true` garante que o walker já comece
      // tratando o conteúdo como Parte 2.
      // Fonte primária do nome do MMC: o campo `Nome:` da seção
      // "PROTAGONISTA MASCULINO (MMC)" da Estrutura1 (rótulo explícito,
      // garantido nas 3 categorias). Fallback: heurística que conta POVs
      // marcados no roteiro inteiro. Parte 1 não destaca nada.
      // NOME COMPLETO (não só o 1º nome): o match de POV casa por token, então a
      // heroína/MMC são reconhecidos por primeiro nome OU sobrenome — evita que a
      // heroína "Anaïs Lenoir" marcada ora ✦ Anaïs ora ✦ Lenoir caia metade como
      // POV masculino (verde).
      const maleLeadName =
        part === 2
          ? extractMaleLeadFullNameFromEstrutura(
              roteiro.outputs.estrutura1?.content,
            ) ??
            extractMaleLeadFullNameFromEstrutura(
              roteiro.outputs.estrutura2?.content,
            ) ??
            detectMaleLeadFromFullRoteiro(escritaContent)
          : null;
      // Nome da FMC (heroína) da Estrutura — guarda dura: o POV dela NUNCA
      // fica verde na Parte 2. Sem heurística (só Estrutura). Parte 1 não usa.
      const femaleLeadName =
        part === 2
          ? extractFemaleLeadFullNameFromEstrutura(
              roteiro.outputs.estrutura1?.content,
            ) ??
            extractFemaleLeadFullNameFromEstrutura(
              roteiro.outputs.estrutura2?.content,
            )
          : null;
      // Chapters filtrados pela parte — passa pro export como source-of-truth
      // do `chapter.part`, garantindo que o walker mantenha `inParte2` certo
      // mesmo se o texto bruto tiver perdido o header `# PARTE 2` (ele já é
      // removido pelo `splitRoteiroByParts`, mas chapters fortalecem o fallback).
      const partLabel = part === 1 ? "Parte 1" : "Parte 2";
      const partChapters = roteiro.outputs.escrita?.metadata?.chapters?.filter(
        (c) => c.part === partLabel,
      );
      const bodyHtml = escritaContentToHtml(partContent, {
        maleLeadName,
        femaleLeadName,
        forceParte2: part === 2,
        chapters: partChapters,
      });
      const html = buildEscritaHtmlDocument("", bodyHtml);
      // Fallback de texto puro: markdown LIMPO (sem `#`, `**`, contagem de
      // palavras nem marcador de PARTE). Usado quando o destino cola só texto
      // ou quando o write de `text/html` falha — evita despejar o markdown cru
      // (`# Capítulo 1`…) no documento da roteirista.
      const text = escritaContentToPlainText(partContent);

      const clipboard = navigator.clipboard;
      if (
        clipboard &&
        typeof (clipboard as Clipboard).write === "function" &&
        typeof ClipboardItem !== "undefined"
      ) {
        try {
          const blobHtml = new Blob([html], { type: "text/html" });
          const blobText = new Blob([text], { type: "text/plain" });
          const item = new ClipboardItem({
            "text/html": blobHtml,
            "text/plain": blobText,
          });
          await clipboard.write([item]);
        } catch {
          await clipboard.writeText(text);
        }
      } else if (clipboard?.writeText) {
        await clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API indisponível.");
      }

      setState("copied");
      setTimeout(() => setState("idle"), 3000);
    } catch (err) {
      console.error("Erro ao copiar parte do roteiro:", err);
      alert("Não consegui copiar. Tente novamente.");
      setState("idle");
    }
  }, [roteiro, part]);

  const idleLabel = `Copiar Parte ${part}`;
  const copiedLabel = `Parte ${part} copiada — cole na guia`;
  const emptyLabel = `Parte ${part} vazia`;

  return (
    <Button
      variant={variant}
      size={size}
      onClick={handleClick}
      disabled={state === "loading"}
      className={cn("gap-2", className)}
    >
      {state === "loading" && <Loader2 className="size-4 animate-spin" />}
      {state === "copied" && <Check className="size-4 text-emerald-600" />}
      {(state === "idle" || state === "empty") && (
        <Copy className="size-4" />
      )}
      {state === "loading"
        ? "Copiando..."
        : state === "copied"
          ? copiedLabel
          : state === "empty"
            ? emptyLabel
            : idleLabel}
    </Button>
  );
}
