/**
 * Endpoint FALLBACK do Revisor — extrai bloco <erros_detalhados> de uma
 * revisão que veio sem o XML (truncado ou esquecido pelo modelo).
 *
 * Disparado pela UI (StepShell.tsx) quando parseRevisorErrors devolve []
 * mas o markdown contém erros listados em PRINCIPAIS ERROS. Modelo: Sonnet —
 * é EXTRAÇÃO MECÂNICA de XML (re-localiza trechos que o Revisor já listou em
 * PRINCIPAIS ERROS), não avaliação literária; Sonnet empata com Opus aqui a
 * uma fração do tempo e tira carga da fila Opus da equipe. Só roda no fallback
 * (raro). Output: stream do XML `<erros_detalhados>...</erros_detalhados>`.
 */

import { NextRequest } from "next/server";
import { streamClaudeText } from "@/lib/claude";
import { MODELS } from "@/lib/anthropic";
import { getCategoryRevisorExtract } from "@/lib/categories";
import type { RoteiroCategory } from "@/types/roteiro";
import { DEFAULT_CATEGORY } from "@/types/roteiro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  /** Sub-nicho do roteiro — escolhe o mapeamento de gravidade correto
   *  (milionário usa 🟠/🔴, máfia usa 🔴/💀). */
  category?: RoteiroCategory;
  revisaoMarkdown: string;
  escritaContent: string;
  /** Id do roteiro — só atribuição no log de consumo de tokens. */
  roteiroId?: string;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Body inválido", { status: 400 });
  }

  if (!body.revisaoMarkdown?.trim() || !body.escritaContent?.trim()) {
    return new Response("Faltam revisaoMarkdown ou escritaContent", {
      status: 400,
    });
  }

  const extract = getCategoryRevisorExtract(body.category ?? DEFAULT_CATEGORY);
  const userMessage = extract.buildUserMessage({
    revisaoMarkdown: body.revisaoMarkdown,
    escritaContent: body.escritaContent,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamClaudeText({
          systemPrompt: extract.systemPrompt,
          userMessage,
          model: MODELS.sonnet,
          thinking: "disabled",
          effort: "low",
          signal: req.signal,
          meta: {
            step: "revisor-extract",
            category: body.category ?? DEFAULT_CATEGORY,
            model: MODELS.sonnet,
            ...(body.roteiroId ? { roteiroId: body.roteiroId } : {}),
          },
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Erro desconhecido";
        controller.enqueue(encoder.encode(`\n\n[ERRO] ${msg}`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
