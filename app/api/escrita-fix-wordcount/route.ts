/**
 * Endpoint que reescreve UM capítulo da Escrita pra atingir o alvo de palavras.
 *
 * Acionado pela calibração da Escrita após os batches: se algum cap saiu fora
 * da faixa (CALIBRATION_THRESHOLD = ±8% em lib/escrita-calibration.ts — não
 * dispara por pequenos desvios), o frontend chama esse endpoint pra encurtar
 * ou expandir o cap específico. O ajuste fino final a ±3% é no step Revisor.
 *
 * Histórico: o endpoint existia até maio de 2026 (commit 66d628d removeu
 * "por custo alto"), mas o estouro generalizado de word count voltou a ser
 * problema na prática. Recriado com threshold mais largo (±8% vs ±3% que
 * o prompt pede) — só ataca casos egrégios, não calibra todo cap fora do
 * range estrito.
 *
 * Modelo: Sonnet. O ajuste é MECÂNICO (encurtar/expandir um cap já escrito
 * mantendo cenas, cliffhanger e voz — travado nas "REGRAS RÍGIDAS" abaixo),
 * não geração criativa do zero. Sonnet é mais rápido e tira carga da fila
 * Opus, que numa assinatura compartilhada (equipe, mesma conta) disputa cota
 * com os batches criativos. A escrita em si segue 100% Opus. Output: o
 * capítulo INTEIRO reescrito no formato canônico `## Capítulo N — Título`.
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
  /**
   * Tolerância relativa da faixa aceita (ex.: 0.08 = ±8%). Default 0.03 (±3%).
   * A calibração da Escrita passa ±8% (faixa larga → o Sonnet converge em 1
   * passe sem precisar acertar o número exato, o que causava overshoot pro lado
   * oposto). O Revisor não passa nada → fica no ±3% rigoroso de sempre.
   */
  tolerancePct?: number;
  premissa?: string;
  neighborSynopses?: Array<{
    number: number;
    part: "Parte 1" | "Parte 2";
    synopsis: string;
  }>;
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

  const { chapter, currentWords, targetWords } = body;
  if (!chapter?.content || !targetWords) {
    return new Response("Faltam campos obrigatórios", { status: 400 });
  }

  const diff = targetWords - currentWords;
  const absDiff = Math.abs(diff);
  // Faixa aceita: ±tolerancePct (default ±3% — range estrito do prompt mestre,
  // usado pelo Revisor). A calibração da Escrita passa ±8% pra dar margem ao
  // Sonnet convergir sem atravessar pro lado oposto. Mínimo absoluto de 30
  // palavras pra alvos pequenos. Mesma base de `parse-estrutura-targets#targetRange`.
  const tolerance =
    typeof body.tolerancePct === "number" && body.tolerancePct > 0
      ? body.tolerancePct
      : 0.03;
  const margin = Math.max(30, Math.round(targetWords * tolerance));
  const min = targetWords - margin;
  const max = targetWords + margin;

  const sections: string[] = [];

  sections.push(
    `Você está REVISANDO um capítulo já escrito do romance pra ajustar a contagem de palavras. O capítulo está com ${currentWords.toLocaleString("pt-BR")} palavras. O alvo é ${targetWords.toLocaleString("pt-BR")} palavras (faixa aceita: ${min.toLocaleString("pt-BR")}-${max.toLocaleString("pt-BR")}). Diferença: ${diff > 0 ? "faltam" : "sobram"} ~${absDiff.toLocaleString("pt-BR")} palavras.`,
  );

  if (diff > 0) {
    sections.push(
      `━━━ AÇÃO: EXPANDIR (ajuste CONSERVADOR) ━━━\n\nO capítulo está CURTO. Adicione palavras pra chegar PERTO de ${targetWords.toLocaleString("pt-BR")} — faixa aceita ${min.toLocaleString("pt-BR")}–${max.toLocaleString("pt-BR")}.\n\n⚠️ REGRA ANTI-OSCILAÇÃO (a mais importante): NÃO EXAGERE no ajuste. É MUITO melhor adicionar de MENOS e parar perto do alvo do que adicionar demais e ESTOURAR pro outro lado. NUNCA ultrapasse ${max.toLocaleString("pt-BR")} palavras. Na dúvida, adicione menos — pode até parar um pouco ABAIXO de ${targetWords.toLocaleString("pt-BR")} (desde que ≥ ${min.toLocaleString("pt-BR")}), isso é seguro e aceito. Acrescente no MÁXIMO ~${absDiff.toLocaleString("pt-BR")} palavras.\n\nComo expandir:\n• Mais detalhe sensorial (cheiro, textura, temperatura, som)\n• Mais descrição de ambiente (móveis, luz, atmosfera)\n• Fluxo de pensamento da narradora entre falas\n• Ampliação dos diálogos JÁ presentes (mais beats, mais subtexto)\n• Pausas, silêncios e gestos que carregam tensão\n\nREGRAS RÍGIDAS — qualquer violação invalida o output:\n• NÃO acrescente eventos novos. Mesmas cenas, mais densas.\n• NÃO altere o cliffhanger final.\n• NÃO mude a ordem das cenas.\n• NÃO altere falas-chave (revelações, decisões, frases marcantes).\n• NÃO adicione personagens novos.\n• MANTENHA o tom do canal (conforme o system prompt acima).\n• NUNCA copie texto deste briefing pro corpo do capítulo. Estas instruções são ORDENS pra você executar — não fazem parte do roteiro. Se você começar o capítulo com "Expandir...", "(a)...(b)...", ou "conforme cravado", PARE: está copiando o briefing.`,
    );
    // Guard anti-duplicação no ramo EXPANDIR — a origem da duplicata que o
    // Revisor SEMPRE acusa: sob a ordem "encher sem eventos novos", o Sonnet
    // tende a PADAR re-emitindo prosa que o capítulo já tem. Espelha o guard
    // anti-briefing acima; o run-escrita ainda passa o resultado por
    // stripInternalDuplication como 2ª linha de defesa (defesa em profundidade).
    sections.push(
      `⚠️ ANTI-DUPLICAÇÃO (invalida o output): ganhe as palavras com CONTEÚDO NOVO, nunca com CÓPIA. Densificar é aprofundar o que já existe — mais detalhe sensorial, mais subtexto na MESMA cena. NUNCA recopie um parágrafo, uma cena ou um bloco de frases que já apareceu antes no capítulo (nem idêntico, nem parafraseado), e NUNCA "reinicie" o capítulo refazendo o que já foi contado. Se você se pegar reescrevendo algo que já está no texto do capítulo, PARE: é duplicação.`,
    );
  } else {
    sections.push(
      `━━━ AÇÃO: ENCURTAR (ajuste CONSERVADOR) ━━━\n\nO capítulo está LONGO. Corte palavras pra chegar PERTO de ${targetWords.toLocaleString("pt-BR")} — faixa aceita ${min.toLocaleString("pt-BR")}–${max.toLocaleString("pt-BR")}.\n\n⚠️ REGRA ANTI-OSCILAÇÃO (a mais importante): NÃO EXAGERE no corte. É MUITO melhor cortar de MENOS e parar perto do alvo do que cortar demais e ficar CURTO demais. NUNCA desça abaixo de ${min.toLocaleString("pt-BR")} palavras. Na dúvida, corte menos — pode até parar um pouco ACIMA de ${targetWords.toLocaleString("pt-BR")} (desde que ≤ ${max.toLocaleString("pt-BR")}), isso é seguro e aceito. Remova no MÁXIMO ~${absDiff.toLocaleString("pt-BR")} palavras.\n\nComo encurtar:\n• Cortar redundâncias (frases que repetem ideias)\n• Reduzir descrições excessivas que não carregam tensão\n• Eliminar advérbios desnecessários\n• Compactar parágrafos sem perder ritmo\n• Encurtar pensamentos internos longos da narradora — manter os essenciais, cortar os redundantes\n\nREGRAS RÍGIDAS — qualquer violação invalida o output:\n• NÃO remova cenas inteiras.\n• NÃO altere o cliffhanger final.\n• NÃO altere falas-chave (revelações, decisões, frases marcantes).\n• NÃO mude a ordem das cenas.\n• MANTENHA o tom do canal (conforme o system prompt acima).\n• NUNCA copie texto deste briefing pro corpo do capítulo. Estas instruções são ORDENS pra você executar — não fazem parte do roteiro.`,
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
    `━━━ FORMATO DE SAÍDA ━━━\n\nDevolva o capítulo INTEIRO reescrito, começando pelo header EXATAMENTE neste formato:\n\n${headerLine}\n\n[texto inteiro do capítulo, ajustado pra ficar DENTRO da faixa ${min.toLocaleString("pt-BR")}–${max.toLocaleString("pt-BR")} palavras (sem atravessar pro outro lado), respeitando todas as regras acima]\n\nNada além disso. Sem comentários, sem ═══, sem sinopses, sem contagem de palavras no corpo.`,
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
          // Sonnet: ajuste mecânico de tamanho (não criação) — mais rápido e
          // alivia a fila Opus compartilhada. Ver cabeçalho do arquivo.
          model: MODELS.sonnet,
          thinking: "disabled",
          effort: "low",
          signal: req.signal,
          meta: {
            step: "calibracao",
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
