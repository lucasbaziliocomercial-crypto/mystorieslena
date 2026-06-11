/**
 * Endpoint que extrai o CÂNONE DE ENTIDADES da Premissa aprovada.
 *
 * Roda uma vez quando a roteirista aprova a Premissa. Devolve um bloco
 * markdown estruturado (Personagens / Lugares / Datas / Relações /
 * Detalhes não-negociáveis) que vira fonte canônica injetada em todos
 * os steps seguintes (estrutura1, estrutura2, escrita, revisor) via
 * REGRA CANÔNICA nos system prompts.
 *
 * Modelo: Opus 4.7 (alinhado com todos os outros steps — sem queda de
 * qualidade na extração).
 */

import { NextRequest } from "next/server";
import { streamClaudeText } from "@/lib/claude";
import { MODELS } from "@/lib/anthropic";
import { CANONE_SYSTEM_PROMPT } from "@/lib/agents/_shared/canone-prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  /** Texto da Premissa aprovada (output.content do step "premissa"). */
  premissa: string;
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

  if (!body.premissa?.trim()) {
    return new Response("Falta `premissa` no body.", { status: 400 });
  }

  const userMessage = `━━━ PREMISSA APROVADA ━━━

${body.premissa.trim()}

━━━ FIM DA PREMISSA ━━━

Extraia o CÂNONE DE ENTIDADES desta premissa no formato markdown estruturado descrito no system prompt. Devolva APENAS o bloco — nada antes ou depois.`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamClaudeText({
          systemPrompt: CANONE_SYSTEM_PROMPT,
          userMessage,
          model: MODELS.opus,
          thinking: "disabled",
          effort: "low",
          signal: req.signal,
          meta: {
            step: "canone",
            model: MODELS.opus,
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
