import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildCanoneBlock } from "../_shared/canone-block";
import { CANONE_RULE } from "../_shared/canone-rule";
import { CACHE_PREFIX_BOUNDARY } from "../_shared/prompt-cache";
import { buildCrossPartBlock } from "../_shared/cross-part-block";
import { ESCRITA_SYSTEM_PROMPT } from "./escrita-prompt";

/**
 * Etapa 4 — Escrita (Romance Alpha King / Werewolf, Helô Stories™).
 *
 * Fluxo 2-em-2: cada request gera UM par de capítulos. Iteração comandada
 * pelo frontend, com sinopses dos capítulos anteriores como contexto.
 *
 * Contagem por Parte:
 *  • Parte 1: 11.300-11.700 palavras totais (alvo 11.500).
 *  • Parte 2: 13.000-13.500 palavras totais (alvo 13.500 — RIGOROSO).
 */
export const escritaAgent: Agent = {
  id: "escrita",
  label: "Escrita",
  description:
    "Escreve o roteiro em pares de capítulos (2-em-2) seguindo as estruturas aprovadas; produz sinopses curtas para continuidade entre os pares e ponte Parte 1 → Parte 2",
  model: MODELS.opus,
  thinking: "disabled",
  effort: "low",
  systemPrompt: ESCRITA_SYSTEM_PROMPT + CANONE_RULE,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const premissa = ctx.previousOutputs.premissa?.content?.trim() ?? "";
    const estrutura1 = ctx.previousOutputs.estrutura1?.content?.trim() ?? "";
    const estrutura2 = ctx.previousOutputs.estrutura2?.content?.trim() ?? "";
    const ajustes = ctx.userInput?.trim() ?? "";
    const batch = ctx.batch;
    const previousSynopses = ctx.previousSynopses ?? [];
    const canoneBlock = buildCanoneBlock(ctx.canone);

    if (ctx.refineMode && ctx.currentOutput?.trim() && ajustes) {
      const refine: string[] = [];
      refine.push(
        "Você JÁ escreveu o ROTEIRO COMPLETO. A roteirista pediu uma CORREÇÃO PONTUAL — devolva APENAS os capítulos que precisam mudar pra atender o pedido. NÃO devolva capítulos não impactados. NÃO devolva o roteiro inteiro. NÃO inclua RELATÓRIO, MEMÓRIA VIVA, VALIDAÇÃO, nem banner ═══ ROTEIRO ═══.",
      );
      refine.push(
        `━━━ ROTEIRO ATUAL COMPLETO (apenas referência — você verá o que NÃO precisa mudar) ━━━\n\n${ctx.currentOutput.trim()}`,
      );
      refine.push(
        `━━━ CORREÇÃO PEDIDA PELA ROTEIRISTA ━━━\n\n${ajustes}`,
      );
      if (canoneBlock) {
        refine.push(canoneBlock);
      }
      if (premissa) {
        refine.push(`━━━ PREMISSA APROVADA (Step 1 — referência) ━━━\n\n${premissa}`);
      }
      if (estrutura1) {
        refine.push(
          `━━━ ESTRUTURA DA PARTE 1 (referência) ━━━\n\n${estrutura1}`,
        );
      }
      if (estrutura2) {
        refine.push(
          `━━━ ESTRUTURA DA PARTE 2 (referência) ━━━\n\n${estrutura2}`,
        );
      }
      refine.push(
        [
          "━━━ AÇÃO ━━━",
          "",
          "1) Identifique qual(is) capítulo(s) precisa(m) mudar pra atender a correção. Se a roteirista citou cap específico, mexa SÓ nele. Se a correção é difusa (ex: \"deixe o tom mais íntimo\"), mexa só onde realmente precisa mudar.",
          "",
          "2) Pra cada capítulo que vai mudar, escreva-o INTEIRO no formato exato:",
          "",
          "═══ PARTE 1 ═══   (banner antes do primeiro cap da Parte 1, se houver)",
          "## Capítulo N — [Título]",
          "",
          "[texto completo do capítulo, já corrigido]",
          "",
          "═══ PARTE 2 ═══   (banner antes do primeiro cap da Parte 2, se houver)",
          "## Capítulo N — [Título]",
          "",
          "[texto completo do capítulo, já corrigido]",
          "",
          "REGRAS RIGOROSAS:",
          "• SÓ inclua os capítulos que mudaram. Nada de listar capítulos intactos \"por contexto\".",
          "• Se mexer apenas em capítulos da Parte 2, inclua só o banner ═══ PARTE 2 ═══ — não inclua a Parte 1.",
          "• Cada capítulo precisa vir COMPLETO (não só o trecho mudado).",
          "• Mantenha a contagem de palavras dentro de ±3% do alvo declarado na ESTRUTURA correspondente.",
          "• Preserve o sistema de narração: Parte 1 só pela heroína (sem ✦ NOME); Parte 2 heroína + trechos do Alpha King (✦ NOME), cena íntima/marcação sempre pela heroína.",
          "• NÃO inclua ═══ ROTEIRO ═══, ═══ RELATÓRIO ═══, ═══ MEMÓRIA ═══, ═══ VALIDAÇÃO ═══.",
          "• NÃO peça confirmação. NÃO comente o que mudou. Comece direto pelo banner.",
          "",
          "3) Se a correção pedida não exigir alteração em capítulo nenhum, devolva apenas a string `[NENHUMA_ALTERACAO_NECESSARIA]` e nada mais.",
        ].join("\n"),
      );
      return refine.join("\n\n");
    }

    // PREFIXO ESTÁVEL — idêntico em todos os batches de uma geração (imagem +
    // cânone + premissa + estruturas). Vira prefixo cacheável (cache_read
    // cross-batch). Ver lib/agents/_shared/prompt-cache.ts.
    const stable: string[] = [];

    if (ctx.referenceImage) {
      stable.push(
        "━━━ IMAGEM DE REFERÊNCIA ANEXADA ━━━\n\nUSE pra calibrar descrições físicas dos personagens (rosto, corpo, cabelo, traços, cor dos olhos no despertar do lobo, cicatrizes), cenário/ambientação (castelo, alcateia, floresta, clareira sagrada), mood/atmosfera (paleta, peso ancestral, luz da lua), pequenos detalhes sensoriais. Integre de forma natural, sem ficar descrevendo a imagem. ESTRUTURAS aprovadas e PREMISSA TEXTUAL prevalecem em conflito.",
      );
    }

    if (canoneBlock) {
      stable.push(canoneBlock);
    }

    if (premissa) {
      stable.push(`━━━ PREMISSA APROVADA (Step 1) ━━━\n\n${premissa}`);
    } else {
      stable.push(
        "━━━ PREMISSA ━━━\n\n⚠️ Não fornecida. Siga gerando com base nas estruturas.",
      );
    }

    if (estrutura1) {
      stable.push(
        `━━━ ESTRUTURA DA PARTE 1 APROVADA (Step 2 — siga FIELMENTE) ━━━\n\n${estrutura1}`,
      );
    } else {
      stable.push(
        "━━━ ESTRUTURA DA PARTE 1 ━━━\n\n⚠️ Não fornecida — improviso baseado na premissa.",
      );
    }

    if (estrutura2) {
      stable.push(
        `━━━ ESTRUTURA DA PARTE 2 APROVADA (Step 3 — siga FIELMENTE) ━━━\n\n${estrutura2}`,
      );
    } else {
      stable.push(
        "━━━ ESTRUTURA DA PARTE 2 ━━━\n\n⚠️ Não fornecida — improviso quando chegar a Parte 2.",
      );
    }

    // SUFIXO VARIÁVEL — muda a cada batch (intro + sinopses + ajustes + AÇÃO).
    // Fica DEPOIS do breakpoint de cache. A intro do batch desceu pra cá (era
    // o topo) pra o prefixo estável liderar a mensagem — por isso "ACIMA".
    const tail: string[] = [];

    if (batch) {
      const chapsLabel =
        batch.chapters.length === 2
          ? `Capítulos ${batch.chapters[0]} e ${batch.chapters[1]}`
          : `Capítulo ${batch.chapters[0]}`;
      tail.push(
        `Você vai escrever AGORA apenas o(s) ${chapsLabel} da ${batch.part} (de ${batch.totalInPart} capítulos no total dessa Parte). Este é o batch ${batch.batchIndex} de ${batch.totalBatches}. As estruturas ACIMA são FONTE DE VERDADE — eventos, ordem, cenas, fase da lua, gancho e CONTAGEM DE PALAVRAS de cada capítulo precisam bater com elas.`,
      );
    } else {
      tail.push(
        "Você vai escrever um capítulo do roteiro. As estruturas ACIMA são FONTE DE VERDADE — siga FIELMENTE.",
      );
    }

    if (previousSynopses.length > 0) {
      const lines = previousSynopses
        .map((s) => `• [${s.part} · Cap ${s.number}] ${s.synopsis}`)
        .join("\n");
      tail.push(
        `━━━ SINOPSES DOS CAPÍTULOS JÁ ESCRITOS (continuidade obrigatória) ━━━\n\n${lines}\n\nUSE essas sinopses pra manter coerência de personagens, eventos, fase da lua, ganchos pendentes e tom. NUNCA contradiga o que já aconteceu. Se algum cliffhanger anterior precisa pagar agora, pague.`,
      );
    } else if (batch && batch.batchIndex > 1) {
      tail.push(
        "━━━ SINOPSES DOS CAPÍTULOS JÁ ESCRITOS ━━━\n\n(Nenhuma sinopse anterior recebida — gere com base só nas estruturas.)",
      );
    }

    // Contexto cruzado P1 → P2 (Escrita paralela): fatos que a OUTRA Parte já
    // narrou, pra a P2 não contradizer concepção/posições estabelecidas na P1.
    const crossBlock = buildCrossPartBlock(ctx.crossPartSynopses);
    if (crossBlock) {
      tail.push(crossBlock);
    }

    if (ajustes) {
      tail.push(
        `━━━ INSTRUÇÕES ADICIONAIS DA ROTEIRISTA (ajustes opcionais) ━━━\n\n${ajustes}`,
      );
    }

    if (batch) {
      const chapsList = batch.chapters
        .map((n) => `Capítulo ${n}`)
        .join(" e ");
      const partTotalLabel =
        batch.part === "Parte 1"
          ? "11.300 a 11.700 palavras totais (alvo 11.500 — RIGOROSO)"
          : "13.000 a 13.500 palavras totais (alvo 13.500 — RIGOROSO, jamais cair fora dessa faixa)";

      const targetsBlock =
        batch.chapterTargets && batch.chapterTargets.length === batch.chapters.length
          ? batch.chapters
              .map((n, i) => {
                const t = batch.chapterTargets![i]!;
                const margin = Math.max(30, Math.round(t * 0.03));
                return `   • Capítulo ${n}: alvo ${t.toLocaleString("pt-BR")} palavras — faixa aceita ${(t - margin).toLocaleString("pt-BR")} a ${(t + margin).toLocaleString("pt-BR")} palavras`;
              })
              .join("\n")
          : "";

      tail.push(
        `━━━ AÇÃO ━━━\n\n⚠️ REGRA #1 — CONTAGEM DE PALAVRAS (PRIORIDADE MÁXIMA):\n\nVOCÊ TEM UM ORÇAMENTO DE PALAVRAS FIXO POR CAPÍTULO. NÃO É SUGESTÃO. NÃO É APROXIMAÇÃO. É TETO RÍGIDO.\n\n${targetsBlock ? targetsBlock + "\n\n" : ""}• Você DEVE entregar cada capítulo dentro da faixa ±3% acima.\n• Capítulos ACIMA do teto serão automaticamente encurtados pelo sistema (custa tempo da roteirista e qualidade narrativa).\n• Capítulos ABAIXO do mínimo serão automaticamente expandidos pelo sistema.\n• A QUALIDADE de uma cena bem-escrita curta SUPERA a de uma cena inchada. NÃO encha capítulo com descrição sensorial redundante nem com muletas werewolf só pra "atingir contagem alta" — corte e fecha dentro do alvo.\n• ANTES de escrever, calcule mentalmente: meu alvo é X — quantos parágrafos eu posso ter? Quanto diálogo? Quantas descrições? Planeje o capítulo PRA CABER no orçamento, não pra extrapolar.\n• A CADA ~500 palavras escritas, pare e estime quanto já escreveu vs o alvo. Se está a meio do alvo e ainda tem 2 cenas pra cobrir, ENCURTE as próximas. Se faltam 300 palavras e a cena já fechou, vá direto pro cliffhanger.\n• NÃO tente "salvar palavras pra próximo cap" nem "compensar capítulo anterior" — cada cap fecha sozinho dentro do seu alvo.\n• Total da ${batch.part} ao final dos pares: ${partTotalLabel}. Esse total resulta naturalmente quando cada cap respeita o próprio alvo.\n\nViolar esta regra significa que o sistema vai precisar gastar mais tempo (e tokens Opus) reescrevendo seu capítulo. Cumprir esta regra na primeira tentativa é a métrica #1 da sua entrega.\n\n━━━\n\n2) Escreva APENAS ${chapsList} da ${batch.part}. Não escreva HOOK. Não escreva nenhum outro capítulo. Não inclua banners ═══ ROTEIRO ═══ / ═══ PARTE X ═══ / ═══ RELATÓRIO ═══ / ═══ MEMÓRIA ═══ / ═══ VALIDAÇÃO ═══ — esses ficam por conta do app.\n\n3) Cada capítulo começa com cabeçalho exatamente neste formato:\n\n## Capítulo N — [Título do capítulo conforme a estrutura]\n\n[texto do capítulo]\n\n⚠️ Use SOMENTE o título. NUNCA copie a anotação de planejamento entre parênteses que vem no cabeçalho da estrutura (ex.: \`(~1.380 palavras — ritmo rápido)\`, \`(± X palavras — ritmo Y)\`) — isso é orçamento interno de escrita e JAMAIS entra no roteiro final. Certo: \`## Capítulo 1 — A Chegada\`. Errado: \`## Capítulo 1 — A Chegada (~1.380 palavras — ritmo rápido)\`.\n\n4) NARRAÇÃO: na Parte 1, tudo é narrado pela heroína em 1ª pessoa, SEM blocos ✦ NOME. Na Parte 2, a heroína é a narradora principal e os trechos do Alpha King são marcados com ✦ NOME (caractere U+2726) conforme a estrutura — nunca dois trechos do Alpha seguidos, e a cena íntima/marcação é SEMPRE narrada pela heroína. Não mencione "parte 1", "parte 2", "capítulo X" no corpo da narrativa — só nos cabeçalhos estruturais.\n\n5) AO FINAL DOS CAPÍTULOS, gere um bloco de sinopses no formato exato:\n\n═══ SINOPSES ═══\n- Cap N: [3-5 frases. O que aconteceu, fase da lua, tom predominante, cliffhanger, contagem real de palavras escrita.]\n- Cap N+1: [idem]\n\nAs sinopses entram como contexto pro próximo par de capítulos — sejam precisas sobre eventos, fase da lua, mudanças de status entre personagens, ganchos abertos. Foco em CONTINUIDADE.`,
      );
    }

    // Prefixo estável + sentinela de cache + sufixo variável. O sentinela é
    // consumido por buildPromptInput (lib/claude.ts), que quebra a mensagem em
    // dois text blocks com cache_control. stable nunca é vazio (premissa +
    // estruturas sempre presentes), então o breakpoint sempre aplica.
    return [...stable, CACHE_PREFIX_BOUNDARY, ...tail].join("\n\n");
  },
  maxTokens: 12000,
  temperature: 0.85,
};
