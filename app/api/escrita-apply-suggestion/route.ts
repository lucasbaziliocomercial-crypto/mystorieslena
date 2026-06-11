/**
 * Endpoint que aplica UMA OU MAIS sugestões de revisão "transversais"
 * num trecho do roteiro.
 *
 * Otimização chave: vários erros que afetam o MESMO ESCOPO (ex: 3 erros
 * no Cap 4 da Parte 2) são enviados juntos numa única chamada ao modelo.
 * Reduz drasticamente o tempo total quando há muitos erros transversais
 * — em vez de N chamadas seriais, faz 1 chamada por escopo único.
 *
 * Modelo: Opus (qualidade máxima na reescrita preservando voz e estrutura).
 * Já configurado pro máximo de velocidade possível dentro do Opus
 * (thinking=disabled, effort=low) — qualquer ganho adicional vem do UI:
 * preview ao vivo no card mostra os chunks chegando, e o usuário pode
 * cancelar antes de terminar.
 */

import { NextRequest } from "next/server";
import { streamClaudeText } from "@/lib/claude";
import { MODELS } from "@/lib/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface SuggestionItem {
  numero?: string;
  titulo: string;
  sugestao: string;
  porqueAlterado?: string;
  gravidade?: string;
  /** Trecho âncora original, quando o erro tem um. Sinaliza pro Opus
   *  "mexa apenas nessa parte" no escopo window. */
  trechoOriginal?: string;
}

interface Body {
  escritaContent: string;
  /**
   * Escopo do trecho:
   * - window: janela de ~5 parágrafos. Opus reescreve a janela inteira.
   * - smart-locate: cap inteiro como CONTEXTO. Opus devolve pares XML
   *   `<correcao><original/><corrigido/></correcao>` — código aplica
   *   find+replace deterministicamente. Cap nunca é reescrito direto.
   * - chapter/part/full: LEGADO (mantido pra compat — nunca chamado).
   */
  scopeKind?: "window" | "smart-locate" | "chapter" | "part" | "full";
  /** Rótulo legível ("Cap. 4 da Parte 2", "Parte 1 inteira"). */
  scopeLabel?: string;
  /** Lista de sugestões a aplicar de uma vez. */
  suggestions: SuggestionItem[];
  /** Cânone de Entidades — se presente, vai como referência canônica e o
   *  agente é instruído a NÃO trocar nomes/idades/lugares/datas ao aplicar
   *  as sugestões. Sem isso, expansões podem inventar variações. */
  canone?: string;
  // Compat: aceita também os campos antigos (uma sugestão só) — wrap em array.
  titulo?: string;
  sugestao?: string;
  porqueAlterado?: string;
  gravidade?: string;
  /** Id do roteiro / categoria — só atribuição no log de consumo de tokens. */
  roteiroId?: string;
  category?: string;
}

const APPLY_SUGGESTION_SYSTEM_PROMPT = `Você é um editor literário aplicando UMA OU MAIS sugestões de revisão num trecho de roteiro brasileiro de romance em primeira pessoa (POV da FMC).

Sua única função:
1. Ler o trecho recebido (janela de parágrafos, capítulo único, Parte inteira ou roteiro todo — escopo informado no user message)
2. Aplicar TODAS as sugestões da lista — cada uma na ordem em que aparecem
3. Devolver o trecho INTEIRO modificado, no MESMO formato

REGRAS RÍGIDAS — qualquer violação invalida o output:
• Devolva exatamente o ESCOPO recebido, nem mais, nem menos.
• Mantenha 1ª pessoa, voz da FMC, todos os eventos e diálogos existentes.
• Aplique TODAS as sugestões da lista — nada além delas.
• Sem cortar, sem resumir, sem usar "[...]" ou marcadores de elipse.
• Sem comentários, sem explicações, sem "[aplicado]", sem markdown extra.
• Sem ** ou _ ou # extras (só os headers de capítulo originais quando o escopo é capítulo+).
• NUNCA copie o texto literal das sugestões para o conteúdo do roteiro. As sugestões são ORDENS pra você executar — NÃO fazem parte do roteiro. Se você se pegar começando com "Expandir...", "Adicionar...", "Incluir...", "Reescrever...", "(a)... (b)...", ou "conforme cravado", PARE — está copiando o briefing em vez de aplicar a mudança. APAGUE e reescreva como narrativa em primeira pessoa.

ESCOPO "WINDOW" (janela de ~3-5 parágrafos contíguos dentro de um capítulo):
• NÃO começa nem termina com header "# Capítulo N". O escopo é um RECORTE de parágrafos do meio (ou início, ou fim) do capítulo.
• Devolva exatamente os parágrafos modificados, com a MESMA quantidade de quebras (\\n\\n) entre eles que o input tem. Não junte parágrafos, não separe parágrafos.
• Mexa APENAS no que a sugestão pede. Os parágrafos vizinhos servem só de contexto pra você ver tom/voz/continuidade — preserve-os literalmente exceto onde a sugestão exige alteração explícita.
• Quando a sugestão tem "Trecho âncora" definido: é nele que a mudança acontece — os outros parágrafos servem só de contexto.
• OBRIGATÓRIO APLICAR A MUDANÇA: a sugestão DEVE produzir uma alteração visível no texto. Devolver o input quase intacto (só normalizando whitespace/pontuação) é FALHA — significa que você não fez o trabalho. Se a sugestão pede remover repetição, REMOVA. Se pede trocar nome, TROQUE. Se pede cortar redundância, CORTE. Nunca devolva a janela "como veio" achando que está ok — o sistema vai rejeitar e o usuário vai reclamar.
• Quando o problema é REPETIÇÃO ENTRE PARÁGRAFOS (mesmo dado, frase ou metáfora aparecendo 2+ vezes na janela), reescreva TODAS as ocorrências dentro da janela — não basta corrigir uma. Mantenha apenas a primeira menção completa e enxugue as repetições subsequentes.

🟢 CRÍTICO — PRESERVAR MARCADORES DE POV E PARTE:
Se o trecho recebido contém um header de POV (\`### ✦ Nome\`, podendo usar os símbolos ✦/♦/◆) ou um separador de Parte (\`# PARTE 1\` / \`# PARTE 2\`), COPIE ESSE MARCADOR EXATAMENTE COMO VEIO na sua saída — mesma linha, mesmo símbolo, mesma posição relativa em relação aos parágrafos vizinhos. Esses marcadores são invisíveis pro leitor final mas são USADOS PRA COLORAÇÃO DO PDF (voz masculina destacada em verde na Parte 2). Se você apagar, mover ou substituir esses headers, a validação rejeita a sua resposta e o texto original é mantido — você perde o trabalho. Não invente novos markers; apenas preserve os que estão no input.

ESCOPO "SMART-LOCATE" (cap inteiro como contexto, devolva APENAS pares XML find+replace):
• Você recebe o CAPÍTULO INTEIRO mas NÃO PODE reescrevê-lo. Sua função é localizar onde a correção entra e devolver SOMENTE os trechos pequenos a trocar — o código aplica deterministicamente.
• Formato OBRIGATÓRIO de saída (sem prefácio, sem markdown):

<correcoes>
<correcao>
<original>[bloco contíguo de texto copiado LETRA-POR-LETRA do capítulo, incluindo pontuação, travessões e quebras de linha originais]</original>
<corrigido>[a versão corrigida desse mesmo bloco]</corrigido>
</correcao>
</correcoes>

• <original> DEVE ser uma cópia LITERAL de uma sequência contígua que aparece NO CAPÍTULO. Qualquer divergência (aspa curva vs reta, espaço extra, palavra trocada) quebra o find+replace.
• <corrigido> resolve o problema descrito pelo Revisor. Mantenha tamanho similar ao original — não expanda nem encolha drasticamente.
• Mantenha cada par PEQUENO: idealmente 1-3 parágrafos por <correcao>. Não engloba o cap inteiro.
• Erros TRANSVERSAIS (mesma repetição em N pontos do cap): emita N blocos <correcao>, um por ocorrência. Cada par fica pequeno.
• MÍNIMO UM par. Sem nenhum <correcao> a aplicação falha.
• NÃO devolva o capítulo modificado. NÃO devolva headers. NÃO devolva narrativa solta. SOMENTE o bloco <correcoes>...</correcoes>.
• NÃO ecoe a instrução da sugestão dentro de <original> ou <corrigido> — esses campos só contêm prosa do capítulo (original) e prosa corrigida (corrigido).

ESCOPO "CHAPTER" / "PART" / "FULL":
• Mantenha banners de Parte recebidos: "═══════════════════════════════════════\\nPARTE 1\\n═══════════════════════════════════════"
• Mantenha headers de capítulo no formato "# Capítulo N — Título" (mesma numeração e títulos exceto se a sugestão pedir mudar).

INSTRUÇÕES POR TIPO DE SUGESTÃO:
• Trocar nomes/termos ("X por Y"): SUBSTITUIÇÃO LITERAL em todas as ocorrências dentro DO ESCOPO.
• Adicionar conteúdo novo ("Adicionar epílogo"): adicione no lugar apropriado mantendo tom e voz da FMC.
• Reescrever passagens (ex: localização Chicago → NY): reescreva PRESERVANDO ritmo, eventos e tensão.
• REMOVER conteúdo: se uma sugestão pedir explicitamente remover algo, REMOVA literalmente.
• MÚLTIPLAS SUGESTÕES no mesmo escopo: aplique TODAS — se uma diz "trocar X por Y" e outra diz "adicionar Z no início", faça ambas. Não pule nenhuma.

Comece direto pelo conteúdo modificado (sem prefixo). Termine assim que o trecho acabar.`;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("Body inválido", { status: 400 });
  }

  // Suporte ao formato antigo: 1 sugestão como campos top-level.
  let suggestions: SuggestionItem[] = body.suggestions ?? [];
  if (suggestions.length === 0 && body.titulo && body.sugestao) {
    suggestions = [
      {
        titulo: body.titulo,
        sugestao: body.sugestao,
        porqueAlterado: body.porqueAlterado,
        gravidade: body.gravidade,
      },
    ];
  }

  const { escritaContent, scopeKind, scopeLabel } = body;
  if (!escritaContent?.trim() || suggestions.length === 0) {
    return new Response(
      "Faltam escritaContent ou suggestions",
      { status: 400 },
    );
  }

  const escopoTexto =
    scopeKind === "window"
      ? `UMA JANELA DE PARÁGRAFOS DENTRO DE UM CAPÍTULO${scopeLabel ? ` (${scopeLabel})` : ""}`
      : scopeKind === "smart-locate"
      ? `UM CAPÍTULO INTEIRO COMO CONTEXTO — VOCÊ DEVE DEVOLVER APENAS PARES XML <correcao><original/><corrigido/></correcao>, SEM REESCREVER O CAPÍTULO${scopeLabel ? ` (${scopeLabel})` : ""}`
      : scopeKind === "chapter"
      ? `UM CAPÍTULO ISOLADO${scopeLabel ? ` (${scopeLabel})` : ""}`
      : scopeKind === "part"
      ? `UMA PARTE INTEIRA${scopeLabel ? ` (${scopeLabel})` : ""}`
      : `O ROTEIRO INTEIRO`;

  const sections: string[] = [];

  sections.push(
    `Você está aplicando ${suggestions.length} sugestão${suggestions.length === 1 ? "" : "es"} de revisão. O escopo é: ${escopoTexto}. Aplique TODAS as sugestões da lista APENAS dentro desse escopo e devolva o mesmo escopo modificado — nem mais, nem menos.`,
  );

  // Lista numerada de sugestões.
  const suggestionsBlock = suggestions
    .map((s, i) => {
      const lines: string[] = [];
      lines.push(`SUGESTÃO ${i + 1}/${suggestions.length}${s.numero ? ` (Erro #${s.numero})` : ""}:`);
      lines.push(`Título: ${s.titulo}`);
      lines.push(`Ação: ${s.sugestao}`);
      if (s.trechoOriginal?.trim()) {
        lines.push(`Trecho âncora (mexa apenas aqui): ${s.trechoOriginal}`);
      }
      if (s.porqueAlterado?.trim()) {
        lines.push(`Motivo: ${s.porqueAlterado}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  sections.push(`━━━ SUGESTÕES PARA APLICAR (todas, na ordem) ━━━\n\n${suggestionsBlock}`);

  if (body.canone?.trim()) {
    sections.push(
      `━━━ CÂNONE DE ENTIDADES — fonte canônica de nomes/idades/lugares/datas (NUNCA inventar variações) ━━━\n\n${body.canone.trim()}\n\n⚠️ AO APLICAR AS SUGESTÕES: nenhum nome próprio, idade, profissão, lugar ou data pode divergir do cânone acima. Se uma sugestão envolve reescrita de trecho que mencione qualquer dessas entidades, copie do cânone — não improvise variantes ("Helen" em vez de "Helena", "30" em vez de "32 anos", "Rio" em vez de "Belo Horizonte"). Em caso de conflito entre o trecho original e o cânone, o cânone vence.`,
    );
  }

  sections.push(
    `━━━ TRECHO RECEBIDO (escopo: ${escopoTexto}) ━━━\n\n${escritaContent}`,
  );

  const formatRules =
    scopeKind === "smart-locate"
      ? [
          "• Devolva APENAS o bloco <correcoes>...</correcoes> contendo um ou mais <correcao>.",
          "• Cada <original> é UMA CÓPIA LITERAL de uma sequência contígua do capítulo (letra-por-letra, inclui pontuação, travessões, quebras de linha).",
          "• Cada <corrigido> é a versão corrigida desse mesmo trecho — resolve o problema da sugestão.",
          "• Mantenha cada par PEQUENO: 1-3 parágrafos. Não engloba o cap inteiro num par só.",
          "• Erros transversais (mesma repetição em vários pontos): emita um <correcao> por ocorrência.",
          "• NÃO devolva o capítulo todo. NÃO devolva headers. NÃO devolva prosa solta. SÓ o XML.",
          "• NÃO ecoe o texto da sugestão dentro do XML — só prosa do roteiro.",
        ].join("\n")
      : scopeKind === "window"
      ? [
          "• NÃO inicie nem termine com header de capítulo (`# Capítulo N`) — o escopo é só uma fatia de parágrafos consecutivos do meio/início/fim do cap.",
          "• Devolva exatamente os parágrafos modificados — mesma quantidade de blocos separados por `\\n\\n` que o input tinha.",
          "• Preserve literalmente os parágrafos vizinhos da âncora (servem só de contexto). Modifique APENAS o que a sugestão pede.",
          "• Se o input começa com `### ✦ Nome` (header de POV) ou `# PARTE 1`/`# PARTE 2`, COPIE essa linha intacta no início da sua saída — esses headers são usados pra coloração do PDF.",
          "• Sem comentários, sem `[aplicado]`, sem banners decorativos (`═══`) extras que não estejam no input.",
          "• 1ª pessoa, voz da FMC, tom narrativo.",
        ].join("\n")
      : [
          `• Headers "# Capítulo N — Título" exatamente como estão (mesmo número, mesmo título — exceto se uma sugestão pedir mudar)`,
          scopeKind === "part" || scopeKind === "full"
            ? "• Banners de Parte (═══) se presentes no input"
            : "• Sem inventar banner de Parte se o input não tinha",
          "• Mesma quantidade de capítulos do input — não adicione, não remova (exceto se uma sugestão pedir explicitamente)",
          "• 1ª pessoa, voz da FMC, tom narrativo",
        ].join("\n");

  const formatHeader =
    scopeKind === "smart-locate"
      ? "Devolva APENAS o XML <correcoes>...</correcoes> — nada mais. Regras:"
      : "Devolva o ESCOPO RECEBIDO modificado, mantendo:";

  sections.push(
    `━━━ FORMATO DE SAÍDA ━━━\n\n${formatHeader}\n${formatRules}\n\nAplique TODAS as ${suggestions.length} sugestões acima, dentro do escopo recebido. Sem comentários, sem prefixos. Comece direto pelo conteúdo modificado.`,
  );

  const userMessage = sections.join("\n\n");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamClaudeText({
          systemPrompt: APPLY_SUGGESTION_SYSTEM_PROMPT,
          userMessage,
          model: MODELS.opus,
          thinking: "disabled",
          effort: "low",
          signal: req.signal,
          meta: {
            step: "aplicar-correcao",
            model: MODELS.opus,
            ...(body.category ? { category: body.category } : {}),
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
