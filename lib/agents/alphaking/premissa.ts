import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildRefinePatchPrompt } from "../_shared/refine-patch-prompt";
import { PREMISSA_SYSTEM_PROMPT } from "./premissa-prompt";

/**
 * Etapa 1 — Premissa (Romance Alpha King / Werewolf, duologia).
 *
 * Fluxo em duas fases (controlado pelo app via ctx.premissaPhase):
 *   FASE 1 — RESUMO: TÍTULO PROVISÓRIO + PREMISSA CENTRAL + um resumo em prosa
 *     por parte (cada um ≤500 palavras).
 *   FASE 2 — OBRIGAÇÕES DE ESTRUTURA: as 10 obrigações do "RELATÓRIO 1" do guia
 *     (mapa de plantio/pagamento, parentesco/rede da alcateia, arquitetura de
 *     conflito, antagonistas com arco fechado, timeline/calendário lunar,
 *     divisão P1/P2, arcos emocionais por capítulo, proporção de tempo, voz
 *     narrativa, validação de secundários).
 *
 * Convertido do documento "ALPHA KING - PROMPTS" (PREMISSAS + RELATÓRIO 1).
 */
export const premissaAgent: Agent = {
  id: "premissa",
  label: "Premissa",
  description:
    "Premissa de Romance Alpha King / Werewolf (duologia). Fluxo em duas fases: resumo curto (≤500 palavras por parte) → obrigações de estrutura (mapa de plantio/pagamento, calendário lunar, voz narrativa, antagonistas com arco fechado)",
  model: MODELS.opus,
  thinking: "disabled",
  effort: "low",
  systemPrompt: PREMISSA_SYSTEM_PROMPT,
  acceptsReferenceImage: true,
  buildUserMessage: (ctx) => {
    const phase = ctx.premissaPhase ?? "resumo";

    // Modo correção pontual: roteirista quer mexer em um detalhe sem regerar
    // o resumo/obrigações inteiras. Devolve patches XML find+replace.
    if (ctx.refineMode && ctx.currentOutput?.trim() && ctx.userInput?.trim()) {
      const currentLabel =
        phase === "estrutura"
          ? "PREMISSA ATUAL (resumo + obrigações de estrutura)"
          : "RESUMO ATUAL (Fase 1 — TÍTULO + PREMISSA CENTRAL + dois resumos curtos)";
      const extraRules =
        phase === "estrutura"
          ? [
              "Preserve os cabeçalhos numerados (1. MAPA DE PLANTIO E PAGAMENTO, 2. PLAUSIBILIDADE DE PARENTESCO E REDE DA ALCATEIA, … 10. VALIDAÇÃO DE PERSONAGENS SECUNDÁRIOS) — só mude o conteúdo do trecho citado.",
              "Voz narrativa: Parte 1 em primeira pessoa exclusiva da heroína; Parte 2 em primeira pessoa alternando heroína (principal) + 2 a 4 trechos do Alpha King. Não viole.",
              "Coerência: se mexer em um nome/reino/profecia, emita um <alteracao> por ocorrência (no resumo E nas obrigações onde aparecer).",
              `"Luna" é título, jamais nome próprio da heroína. Calendário lunar coerente — marcação só em lua cheia se a regra foi estabelecida.`,
            ]
          : [
              "Preserve os cabeçalhos `TÍTULO PROVISÓRIO:`, `PREMISSA CENTRAL:`, `RESUMO DA PARTE 1` e `RESUMO DA PARTE 2`.",
              "Limite rigoroso: cada resumo (P1 e P2) tem no máximo 500 palavras — não estoure.",
              "Romance/vínculo de mate em primeiro plano, universo werewolf em segundo, guerra/política em terceiro. P1 termina com casal reivindicado mas SEM coroação/herdeiro/casamento sob a lua; P2 começa com bomba e entrega coroação como Luna + marca completa + herdeiro.",
              `"Luna" é título, nunca nome próprio da heroína.`,
            ];
      return buildRefinePatchPrompt({
        currentLabel,
        currentOutput: ctx.currentOutput,
        userInstruction: ctx.userInput,
        extraRules,
      });
    }

    const briefing = ctx.userInput?.trim() || "";
    const briefingBlock = briefing
      ? `IDEIA BASE DO USUÁRIO:\n\n${briefing}`
      : "IDEIA BASE DO USUÁRIO: nenhuma ideia específica foi enviada — defina o reino lobo / alcateia principal, a origem da heroína (ômega, serva, pária, sem lobo, herdeira oculta), o trope base do casal (rejeição da mate, substituição, ômega e Alpha King, vínculo negado, mate proibida, casamento arranjado werewolf), o passado marcante do Alpha King e o segredo central, seguindo as regras do prompt mestre.";

    if (phase === "estrutura") {
      const resumo = ctx.approvedResumo?.trim() || "";
      const resumoBlock = resumo
        ? `RESUMO APROVADO PELO USUÁRIO (FASE 1 — fonte de verdade, mantenha coerência total):\n\n${resumo}`
        : "RESUMO APROVADO PELO USUÁRIO: (não fornecido — gere as obrigações de estrutura seguindo apenas a ideia base e as regras do prompt mestre).";

      return [
        briefingBlock,
        resumoBlock,
        `TAREFA NESTE TURNO:

Entregue APENAS as OBRIGAÇÕES DE ESTRUTURA da Fase 2, na ordem exata abaixo:

1. MAPA DE PLANTIO E PAGAMENTO — tabela de elementos plantados (personagens secundários relevantes: Beta, rival Luna, mãe-rainha, conselheiros, alpha rival, ex prometida; conflitos externos: guerras territoriais, packs rivais, traições; segredos: linhagem oculta, lobo raro, identidade verdadeira da heroína; traumas; objetos simbólicos: medalhão lunar, espada ancestral, marca espiritual, flor da clareira; frases em aberto da Moon Goddess; profecias) com colunas: Elemento | Onde introduzido (cap.) | Onde desenvolvido | Onde pago/resolvido | Consequência narrativa do pagamento. Proibido plantar elemento sem coluna "pagamento".

2. PLAUSIBILIDADE DE PARENTESCO E REDE DA ALCATEIA — se houver twist de parentesco (heroína filha perdida do alpha rival, herdeira verdadeira do trono, etc.): pistas plantadas (lobo raro, cheiro estranho, marca de nascença), justificativa de por que ela nunca descobriu antes (entregue bebê a outra alcateia, supressor de cheiro, lobo adormecido), linhagens distintas, e checagem realista (se viveu anos na alcateia, por que ninguém sentiu o cheiro?). Se não houver, escrever "Não aplicável".

3. ARQUITETURA DE CONFLITO ADEQUADA AO GÊNERO — o conflito é primariamente emocional, relacional e espiritual, com guerra/política como pano de fundo. A pergunta real é "ele vai escolher ela ou não? o vínculo vai vencer?". Antagonistas com motivações claras e proporcionais (rival Luna, ex prometida, alpha rival, mãe-rainha tradicionalista, conselheiro contra o vínculo) — sem vilões genéricos.

4. ANTAGONISTAS COM ARCO FECHADO — para CADA antagonista: motivação explícita (ciúmes da Luna verdadeira, fome de poder, vingança ancestral, lealdade cega à tradição), trajetória ao longo dos capítulos (não some), e momento de fechamento EM CENA (derrota em desafio alpha, rendição, exílio, morte digna, redenção, banimento). A rival Luna especialmente precisa de queda em cena.

5. TIMELINE E CALENDÁRIO LUNAR — linha do tempo integral: dia/momento aproximado de cada cena chave, FASE DA LUA em cada cena (cheia/nova/crescente/minguante, especialmente em rituais, marcações, transformações), intervalos ("três luas depois"), idades em momentos-chave (despertar do lobo aos 18), estações. Marcação só acontece em lua cheia se essa for a regra; profecia "três luas" precisa fechar a matemática.

6. DIVISÃO ENTRE PARTE GRATUITA E PARTE PAGA — (a) o que é prometido e entregue na P1 (rejeição, ciúmes, primeira reivindicação, primeira marca parcial, escolha pública); (b) o que é plantado na P1 para pagar na P2 (lista explícita: profecia, rival grávida, marca incompleta, lobo raro despertando, herdeiro, ameaça externa); (c) nível de intensidade da cena íntima em cada parte (sugerida/cio na P1 vs. consumação total + concepção do herdeiro na P2); (d) gancho final sutil da P1; (e) resolução final da P2 (coroação como Luna, herdeiro, marca completa, paz com a Moon Goddess).

7. ARCOS EMOCIONAIS POR CAPÍTULO — para cada capítulo (6 na P1, 5-6 na P2): qual arco emocional da heroína avança (de ômega para reconhecida, de rejeitada para reivindicada, de invisível para Luna), qual relação muda (vínculo se fortalece, lobo do alpha cede, rival ataca, conselho se posiciona), qual pergunta a leitora termina o capítulo fazendo, qual resposta o capítulo paga. Proibido capítulo de enchimento.

8. PROPORÇÃO DE TEMPO ENTRE ARCOS — confirmar que eventos importantes (rejeição pública, marcação, traição, morte na alcateia) NÃO acontecem em capítulos consecutivos sem respiro. Eventos traumáticos grandes exigem intervalo mínimo de duas luas narrativas antes de cenas íntimas, reconciliações apressadas ou decisões irreversíveis.

9. VOZ NARRATIVA — DEFINIDA ANTES DA ESCRITA — registrar literalmente:
   - QUEM NARRA: Parte 1 em PRIMEIRA PESSOA exclusiva da heroína (futura Luna). Parte 2 em PRIMEIRA PESSOA alternando heroína (narradora principal) + 2 a 4 trechos do Alpha King identificados pelo nome.
   - O POV do Alpha (Parte 2) revela o que a heroína não vê (decisões nos bastidores, conselho, batalhas na fronteira, medos escondidos, o lobo dele uivando) e NUNCA reconta cena já narrada pela heroína.
   - A cena íntima / marcação completa é SEMPRE narrada pela heroína.
   - REGISTRO DE VOZ: heroína mais lírica/emocional; Alpha mais visceral/territorial.
   - RESTRIÇÕES: o narrador só sabe o que vê, ouve, cheira (se o lobo despertou) e sente pelo vínculo (se estabelecido).

10. VALIDAÇÃO DE PERSONAGENS SECUNDÁRIOS — para CADA secundário relevante (Beta principal, rival Luna, alpha rival, mãe-rainha, conselheiro, melhor amiga, irmão do alpha, serva confiável): nome completo (regras de nomes), papel narrativo, posição na hierarquia (Beta/Gamma/ômega/guerreiro/conselheiro), momento de entrada e saída, característica distintiva (cheiro do lobo, cor dos olhos no despertar, cicatriz, gesto, vocabulário), relação mapeada com cada personagem central.

NÃO repita o resumo aprovado. Comece direto pelo cabeçalho "1. MAPA DE PLANTIO E PAGAMENTO".

Mantenha coerência total com o resumo aprovado: nomes, reino/alcateia, trope base, segredo central, antagonista e final precisam ser exatamente os mesmos. As obrigações detalham e expandem o que o resumo já estabeleceu — não introduzem mudanças de rumo. Aplique as regras de nomes (lista proibida + "Luna" jamais como nome próprio).`,
      ].join("\n\n");
    }

    return [
      briefingBlock,
      `TAREFA NESTE TURNO:

Entregue APENAS o RESUMO da Fase 1 — exatamente neste formato e nada mais:

TÍTULO PROVISÓRIO: [criar título comercial e sedutor com peso werewolf, se o usuário não fornecer]

PREMISSA CENTRAL: [resumir a ideia principal em 1-3 linhas: trope base + universo werewolf + gancho emocional do vínculo]

RESUMO DA PARTE 1
[Em prosa corrida, NO MÁXIMO 500 palavras. Cobrir, na ordem: apresentação da heroína e do mundo dela (ômega/serva/pária/sem lobo); apresentação do Alpha King + universo de alcateias/hierarquia explicado em palavras simples; encontro inicial e despertar do vínculo (cheiro, puxão, o lobo dele a reconhece); o conflito proibido (rejeição pública, escolha de outra, vínculo negado); humilhação na corte e queda emocional; entrada do ciúmes (rival alpha, beta gentil, prometido); a primeira grande escolha (ele a reivindica, marca, interrompe casamento); fechamento da Parte 1 com casal junto e em paz, SEM coroação como Luna, SEM herdeiro, SEM casamento sob a lua — só um questionamento sutil ("a Moon Goddess ainda não terminou de cobrar").]

RESUMO DA PARTE 2
[Em prosa corrida, NO MÁXIMO 500 palavras. Cobrir, na ordem: a bomba inicial (profecia revelada, rival voltando grávida, marca corrompendo, guerra com alcateia rival, identidade verdadeira da heroína emergindo); por que parece o fim do casal; pressão sobre o vínculo (conselho, packs rivais, traição); ações concretas e sacrifícios do Alpha (renunciar trono, expor a garganta, enfrentar o conselho, derrotar o rival); amadurecimento da heroína como Luna, dona do próprio lobo, com papel ativo na resolução; conflito definitivo e queda do antagonista em cena; final feliz com coroação como Luna + marca completa sob a lua cheia + casamento + herdeiro alpha + paz com a Moon Goddess.]

NÃO entregue as obrigações de estrutura neste turno. NÃO escreva frases de espera ou pedidos de aprovação — o usuário vai aprovar/editar o resumo na interface do app antes de pedir as obrigações em uma chamada separada.

Use linguagem clara e didática (apresente cada personagem pelo nome completo, idade, posição na alcateia e situação; explique termos werewolf — alcateia, mate, Luna, Beta, ômega, vínculo, Moon Goddess, marcação — em palavras simples; conte cronologicamente; DETALHE A APROXIMAÇÃO dos dois com cenas concretas).

Aplique TODAS as regras do prompt mestre:
- Voz: P1 primeira pessoa da heroína; P2 heroína + 2 a 4 trechos do Alpha King; cena íntima sempre pela heroína.
- Universo werewolf medieval/viking/fantasia (NUNCA urbano/Brasil/moderno).
- Nomes criativos fora da lista proibida ("Luna" jamais como nome próprio da heroína).
- 5 pilares (universo convincente, Alpha com dor específica, heroína forte e ativa, química esmagadora, escalada constante).
- 6 regras de prevenção (arco P2 NÃO repete o formato da P1, heroína sempre ativa, toda informação plantada é colhida, geografia/calendário lunar verificados, não repetir descrições werewolf, dar espaço ao que importa).
- Regra da reconciliação: conflitos da P2 menores em escala mas mais profundos; o alpha age e prova; reconciliação começa do meio pro final.
- P1 sem coroação/herdeiro/casamento sob a lua. P2 entrega coroação como Luna + marca completa + herdeiro.
- Romance/vínculo em primeiro plano; guerra/política só como pano de fundo.

LIMITE RIGOROSO: cada resumo (P1 e P2) deve ter NO MÁXIMO 500 palavras. Se passar de 500, condense.`,
    ].join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.9,
};
