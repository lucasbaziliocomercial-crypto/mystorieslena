/**
 * Endpoint que reescreve UM capítulo da Escrita pra atingir o alvo de palavras.
 *
 * Acionado pelo loop da Escrita após cada batch: se algum cap saiu fora de
 * uma margem larga (default ±15% pra economizar Opus tokens — não dispara
 * por pequenos desvios), o frontend chama esse endpoint pra encurtar ou
 * expandir o cap específico.
 *
 * Histórico: o endpoint existia até maio de 2026 (commit 66d628d removeu
 * "por custo alto"), mas o estouro generalizado de word count voltou a ser
 * problema na prática. Recriado com threshold mais largo (±15% vs ±3% que
 * o prompt pede) — só ataca casos egrégios, não calibra todo cap fora do
 * range estrito.
 *
 * Modelo: Opus (mantém voz Helô — Sonnet perde tom). Output: o capítulo
 * INTEIRO reescrito no formato canônico `## Capítulo N — Título`.
 */

import { NextRequest } from "next/server";
import { streamClaudeText } from "@/lib/claude";
import { MODELS } from "@/lib/anthropic";
import { getCategoryEscritaSystemPrompt } from "@/lib/categories";
import type { RoteiroCategory } from "@/types/roteiro";
import { DEFAULT_CATEGORY } from "@/types/roteiro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  category?: RoteiroCategory;
  chapter: {
    number: number;
    title?: string;
    part: "Parte 1" | "Parte 2";
    content: string;
  };
  currentWords: number;
  targetWords: number;
  premissa?: string;
  neighborSynopses?: Array<{
    number: number;
    part: "Parte 1" | "Parte 2";
    synopsis: string;
  }>;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Body inválido", { status: 400 });
  }

  const { chapter, currentWords, targetWords } = body;
  if (!chapter?.content || !targetWords) {
    return new Response("Faltam campos obrigatórios", { status: 400 });
  }

  const diff = targetWords - currentWords;
  const absDiff = Math.abs(diff);
  // Range estrito do prompt mestre: ±3%. Mínimo absoluto de 30 palavras pra
  // alvos pequenos. Mesma fórmula de `lib/parse-estrutura-targets.ts#targetRange`.
  const margin = Math.max(30, Math.round(targetWords * 0.03));
  const min = targetWords - margin;
  const max = targetWords + margin;

  const sections: string[] = [];

  sections.push(
    `Você está REVISANDO um capítulo já escrito do romance pra ajustar a contagem de palavras. O capítulo está com ${currentWords.toLocaleString("pt-BR")} palavras. O alvo é ${targetWords.toLocaleString("pt-BR")} palavras (faixa aceita: ${min.toLocaleString("pt-BR")}-${max.toLocaleString("pt-BR")}). Diferença: ${diff > 0 ? "faltam" : "sobram"} ~${absDiff.toLocaleString("pt-BR")} palavras.`,
  );

  if (diff > 0) {
    sections.push(
      `━━━ AÇÃO: EXPANDIR ━━━\n\nEXPANDA cenas existentes para adicionar cerca de ${absDiff.toLocaleString("pt-BR")} palavras. Use:\n• Mais detalhe sensorial (cheiro, textura, temperatura, som)\n• Mais descrição de ambiente (móveis, luz, atmosfera)\n• Fluxo de pensamento da narradora entre falas\n• Ampliação dos diálogos JÁ presentes (mais beats, mais subtexto)\n• Pausas, silêncios e gestos que carregam tensão\n\nREGRAS RÍGIDAS — qualquer violação invalida o output:\n• NÃO acrescente eventos novos. Mesmas cenas, mais densas.\n• NÃO altere o cliffhanger final.\n• NÃO mude a ordem das cenas.\n• NÃO altere falas-chave (revelações, decisões, frases marcantes).\n• NÃO adicione personagens novos.\n• MANTENHA o tom Helô Stories (sedutor, intenso).\n• NUNCA copie texto deste briefing pro corpo do capítulo. Estas instruções são ORDENS pra você executar — não fazem parte do roteiro. Se você começar o capítulo com "Expandir...", "(a)...(b)...", ou "conforme cravado", PARE: está copiando o briefing.`,
    );
  } else {
    sections.push(
      `━━━ AÇÃO: ENCURTAR ━━━\n\nENCURTE removendo cerca de ${absDiff.toLocaleString("pt-BR")} palavras. Use:\n• Cortar redundâncias (frases que repetem ideias)\n• Reduzir descrições excessivas que não carregam tensão\n• Eliminar advérbios desnecessários\n• Compactar parágrafos sem perder ritmo\n• Encurtar pensamentos internos longos da narradora — manter os essenciais, cortar os redundantes\n\nREGRAS RÍGIDAS — qualquer violação invalida o output:\n• NÃO remova cenas inteiras.\n• NÃO altere o cliffhanger final.\n• NÃO altere falas-chave (revelações, decisões, frases marcantes).\n• NÃO mude a ordem das cenas.\n• MANTENHA o tom Helô Stories.\n• NUNCA copie texto deste briefing pro corpo do capítulo. Estas instruções são ORDENS pra você executar — não fazem parte do roteiro.`,
    );
  }

  if (body.premissa) {
    sections.push(`━━━ PREMISSA (contexto) ━━━\n\n${body.premissa}`);
  }

  if (body.neighborSynopses?.length) {
    const lines = body.neighborSynopses
      .map((s) => `• [${s.part} · Cap ${s.number}] ${s.synopsis}`)
      .join("\n");
    sections.push(
      `━━━ SINOPSES VIZINHAS (não contradiga) ━━━\n\n${lines}`,
    );
  }

  const headerLine = chapter.title
    ? `## Capítulo ${chapter.number} — ${chapter.title}`
    : `## Capítulo ${chapter.number}`;

  sections.push(
    `━━━ CAPÍTULO ATUAL (${chapter.part}) ━━━\n\n${headerLine}\n\n${chapter.content}`,
  );

  sections.push(
    `━━━ FORMATO DE SAÍDA ━━━\n\nDevolva o capítulo INTEIRO reescrito, começando pelo header EXATAMENTE neste formato:\n\n${headerLine}\n\n[texto inteiro do capítulo, ${diff > 0 ? "com cerca de " + absDiff.toLocaleString("pt-BR") + " palavras a mais" : "com cerca de " + absDiff.toLocaleString("pt-BR") + " palavras a menos"}, respeitando todas as regras acima]\n\nNada além disso. Sem comentários, sem ═══, sem sinopses, sem contagem de palavras no corpo.`,
  );

  const userMessage = sections.join("\n\n");
  const escritaSystemPrompt = getCategoryEscritaSystemPrompt(
    body.category ?? DEFAULT_CATEGORY,
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamClaudeText({
          systemPrompt: escritaSystemPrompt,
          userMessage,
          model: MODELS.opus,
          thinking: "disabled",
          effort: "low",
          signal: req.signal,
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
