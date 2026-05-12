import { MODELS } from "@/lib/anthropic";
import type { Agent } from "../types";
import { buildRefinePatchPrompt } from "../_shared/refine-patch-prompt";
import { PREMISSA_SYSTEM_PROMPT } from "./premissa-prompt";

/**
 * Etapa 1 — Premissa (Romance de Milionário 3ª pessoa, canal Rowan).
 *
 * Fluxo em duas fases (controlado pelo app via ctx.premissaPhase):
 *   FASE 1 — RESUMO: TÍTULO PROVISÓRIO + PREMISSA CENTRAL + dois resumos em
 *     prosa (Parte 1 e Parte 2), cada um ≤500 palavras, em terceira pessoa
 *     CENTRADA NA FMC (sem POV masculino, MMC observado de fora).
 *   FASE 2 — OBRIGAÇÕES DE ESTRUTURA: mapa de plantio/pagamento, plausibilidade
 *     de parentesco, arquitetura de conflito adequada ao gênero, antagonistas
 *     com arco fechado, timeline/calendário, divisão P1/P2, arcos emocionais
 *     por capítulo, voz narrativa imutável, validação de personagens
 *     secundários.
 *
 * Convertido fielmente do PDF "_ROWAN_-_MILIONARIOS_-_GUIA_COMPLETO_alterado".
 */
export const premissaAgent: Agent = {
  id: "premissa",
  label: "Premissa",
  description:
    "Premissa de Romance de Milionário 3ª pessoa (canal Rowan). Fluxo em duas fases: resumo curto (≤500 palavras por parte, 3ª pessoa centrada na FMC, sem POV masculino) → obrigações de estrutura (mapa de plantio/pagamento, timeline, voz narrativa imutável, antagonistas com arco fechado)",
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
              "Preserve os cabeçalhos numerados (1. MAPA DE PLANTIO E PAGAMENTO, 2. PLAUSIBILIDADE DE PARENTESCO, … 10. VALIDAÇÃO DE PERSONAGENS SECUNDÁRIOS) — só mude o conteúdo do trecho citado.",
              "Voz narrativa imutável: terceira pessoa centrada na FMC — não introduza POV masculino nem primeira pessoa.",
              "Coerência: se mexer em um nome/cidade/segredo, emita um <alteracao> por ocorrência (no resumo E nas obrigações onde aparecer).",
            ]
          : [
              "Preserve os cabeçalhos `TÍTULO PROVISÓRIO:`, `PREMISSA CENTRAL:`, `RESUMO DA PARTE 1` e `RESUMO DA PARTE 2`.",
              "Voz narrativa imutável: TERCEIRA PESSOA centrada na FMC, sem POV masculino — MMC descrito por gestos/falas/ações observáveis.",
              "Limite rigoroso: cada resumo (P1 e P2) tem no máximo 500 palavras — não estoure.",
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
      : "IDEIA BASE DO USUÁRIO: nenhuma ideia específica foi enviada — escolha cidade da lista permitida (Chicago, Nova York, Dubai, Londres, Paris, Mônaco, Milão, Zurique — NUNCA Brasil), tipo de fortuna do MMC (CEO, herdeiro, magnata), profissão da FMC, gatilho inicial e segredo central seguindo as regras do prompt mestre.";

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

1. MAPA DE PLANTIO E PAGAMENTO — tabela de elementos plantados (personagens secundários, conflitos externos, segredos, traumas, objetos simbólicos, frases em aberto, previsões emocionais) com colunas: Elemento | Onde introduzido (cap.) | Onde desenvolvido | Onde pago/resolvido | Consequência narrativa do pagamento.

2. PLAUSIBILIDADE DE PARENTESCO E REDE SOCIAL — se houver twist de parentesco, listar pistas plantadas, justificativa do isolamento da protagonista, sobrenomes distintos, checagem de rede social realista. Se não houver, escrever "Não aplicável".

3. ARQUITETURA DE CONFLITO ADEQUADA AO GÊNERO — descrever o conflito principal (emocional/relacional), motivações dos antagonistas (rival romântica, ex amarga, sócio cético — nada de vilões genéricos), conflitos externos somente como catalisadores.

4. ANTAGONISTAS COM ARCO FECHADO — para CADA antagonista: motivação explícita, trajetória pré-definida nos capítulos onde aparece, momento de fechamento (derrota, rendição, desistência, reconciliação ou saída digna).

5. TIMELINE E CALENDÁRIO — linha do tempo integral: dia/mês de cada cena chave, dias da semana, intervalos temporais, idades dos personagens em momentos-chave, estações do ano. Tudo coerente, contagens regressivas fechando.

6. DIVISÃO P1/P2 — listar (a) o que é prometido na P1 e entregue dentro dela, (b) o que é plantado na P1 para pagar na P2 (lista explícita), (c) nível de intensidade da cena íntima em cada parte, (d) gancho final da P1, (e) resolução final da P2.

7. ARCOS EMOCIONAIS POR CAPÍTULO — para cada capítulo (5-6 na P1, 5-6 na P2): qual arco emocional da protagonista avança, qual relação entre personagens muda, qual pergunta o leitor termina o capítulo fazendo, qual resposta o capítulo paga.

8. PROPORÇÃO DE TEMPO ENTRE ARCOS — confirmar que eventos importantes (revelação, traição, agressão, pedido de casamento) NÃO acontecem em capítulos consecutivos sem respiro. Eventos traumáticos grandes precisam de intervalo mínimo de duas semanas narrativas antes de cenas íntimas, reconciliações ou decisões irreversíveis.

9. VOZ NARRATIVA — DEFINIDA E IMUTÁVEL — registrar literalmente:
   - QUEM NARRA: narrador externo em terceira pessoa, foco LIMITADO à FMC. Sem POV masculino. Sem alternância. Sem primeira pessoa.
   - MUDANÇAS DE POV: NÃO HÁ.
   - REGISTRO DE VOZ: envolvente, sensorial, elegante, próximo da heroína.
   - RESTRIÇÕES: o narrador só sabe o que a FMC sabe ou pode observar; em cenas onde a FMC não está presente, descrever apenas o observável (gestos, falas, ações).
   - MOSTRAR O MMC: tudo o que ele sente é traduzido em comportamento.

10. VALIDAÇÃO DE PERSONAGENS SECUNDÁRIOS — para CADA secundário relevante: nome completo, papel narrativo (aliado, antagonista, mentor, oposição social), momento de entrada e saída, característica distintiva de voz (sotaque, vocabulário, gesto recorrente), relação mapeada com cada personagem central.

NÃO repita o resumo aprovado. Comece direto pelo cabeçalho "1. MAPA DE PLANTIO E PAGAMENTO".

Mantenha coerência total com o resumo aprovado: nomes, cidade, fortuna do MMC, profissão da FMC, gatilho, segredo central, antagonista e final feliz precisam ser exatamente os mesmos. As obrigações de estrutura detalham e expandem o que o resumo já estabeleceu — não introduzem mudanças de rumo.

Aplique TODAS as regras do prompt mestre — especialmente as 6 regras de prevenção de erros (não repetir arco P1/P2, FMC ativa, toda informação plantada deve ser colhida, geografia verificada, não repetir descrições, dar espaço ao que importa) e as regras de nomes (lista proibida + sugestões).`,
      ].join("\n\n");
    }

    return [
      briefingBlock,
      `TAREFA NESTE TURNO:

Entregue APENAS o RESUMO da Fase 1 — exatamente neste formato e nada mais:

TÍTULO PROVISÓRIO: [criar título comercial e sedutor, se o usuário não fornecer]

PREMISSA CENTRAL: [resumir a ideia principal em 1-3 linhas: trope base + universo de poder/riqueza + gancho emocional]

RESUMO DA PARTE 1
[Em prosa corrida, NO MÁXIMO 500 palavras. Em TERCEIRA PESSOA centrada na FMC (sem POV masculino, MMC observado de fora — descrito por gestos, falas, ações observáveis, nunca por pensamentos internos). Cobrir, na ordem: apresentação da FMC e do mundo dela; apresentação do MMC pelo olhar externo + universo de poder explicado em palavras simples; encontro inicial; o que força a convivência; aproximação detalhada com cenas concretas; primeiro grande obstáculo (humilhação social, ex ciumenta, família que não aceita, etc.); como enfrentam e se escolhem; fechamento da Parte 1 com eles juntos e em paz, SEM casamento, SEM filhos, com a sensação "será que essa história está mesmo resolvida?"]

RESUMO DA PARTE 2
[Em prosa corrida, NO MÁXIMO 500 palavras. MESMO REGIME NARRATIVO: terceira pessoa centrada na FMC, sem POV masculino. Cobrir, na ordem: bomba inicial (algo plantado na P1 que ressignifica tudo); por que parece o fim do casal; afastamento ativo da FMC; ações concretas e observáveis do MMC para reconquistá-la (gestos, sacrifícios, falas decisivas, mudanças visíveis de comportamento — nunca pensamentos dele); reconciliação não apressada (começa do meio pro final); FMC com papel ativo na resolução; queda do antagonista com FMC participante; final feliz com casamento + filhos / lua de mel / sonho realizado.]

NÃO entregue as obrigações de estrutura neste turno. NÃO escreva frases de espera ou pedidos de aprovação — o usuário vai aprovar/editar o resumo na interface do app antes de pedir as obrigações de estrutura em uma chamada separada.

Use linguagem clara e didática (apresente cada personagem pelo nome completo, idade, profissão e situação; explique termos técnicos como CEO, herdeiro, conglomerado em palavras simples; conte cronologicamente; DETALHE A APROXIMAÇÃO dos dois com cenas concretas, não generalize).

Aplique TODAS as regras do prompt mestre:
- Voz narrativa: TERCEIRA PESSOA EXCLUSIVA centrada na FMC. SEM POV masculino. MMC mostrado pelos atos.
- Cidade da lista permitida (NUNCA Brasil).
- Nomes criativos fora da lista proibida (sem Valentina, Camila, Isabella, Sofia, Enzo, Rafael, Mateo, Gabriel, Lorenzo, Damian, Sebastian, Alexander, Dominic, etc.).
- 5 pilares (universo de poder convincente, MMC com dor específica observável, FMC forte e ativa com objetivo próprio, química esmagadora, escalada constante).
- 6 regras de prevenção de erros (arco P2 NÃO repete formato da P1, FMC sempre ativa, toda informação plantada deve ser colhida, geografia verificada, não repetir descrições, dar espaço ao que importa).
- Regra da reconciliação: conflitos da P2 menores em escala mas mais profundos emocionalmente, MMC age e prova (cenas observáveis), reconciliação começa do meio pro final.
- P1 termina sem casamento/filhos. P2 entrega casamento/filhos/lua de mel/sonho realizado.
- Romance em primeiro plano, conflito sempre emocional/relacional (não corporativo, policial ou violento).

LIMITE RIGOROSO: cada resumo (P1 e P2) deve ter NO MÁXIMO 500 palavras. Se passar de 500, condense.`,
    ].join("\n\n");
  },
  maxTokens: 16000,
  temperature: 0.9,
};
