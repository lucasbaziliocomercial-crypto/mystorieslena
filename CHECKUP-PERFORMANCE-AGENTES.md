# Checkup de Performance — Automação de Roteiros (MyStoriesLena)

**Foco:** velocidade dos agentes de IA, mantendo a qualidade.
**Data:** 11/06/2026 · **Escopo:** `lib/claude.ts`, `lib/generation/run-escrita.ts`, `lib/agents/**`, rotas de API.

---

## Resumo executivo

A automação já está **bem acima da média** em engenharia de performance: prompt caching no system prompt, `thinking` desligado por padrão, Parte 1 ‖ Parte 2 em paralelo, calibração de contagem com pool de concorrência, retries com backoff e até instrumentação de tempo (`perf-metrics.ts`). Não há nada "quebrado" para consertar.

O ganho de velocidade agora vem de **três alavancas concretas**, em ordem de impacto:

1. **Reativar o cache do prefixo estável da Escrita** (ganho garantido, risco baixo) — hoje está desligado e a documentação está desatualizada sobre isso.
2. **Reduzir a frequência de calibração** afinando o prompt de contagem — cada capítulo fora do alvo dispara uma reescrita Sonnet extra.
3. **Avaliar modelo por etapa** com dados, em vez de Opus para tudo.

Abaixo, cada uma detalhada com a evidência no código.

---

## 1. Cache do prefixo da Escrita está desligado (maior ganho, menor risco)

**O que encontrei.** Em cada batch da Escrita, a mensagem do usuário carrega um **prefixo estável de ~20k tokens** (cânone + premissa + estrutura P1 + estrutura P2) que é **idêntico em todos os ~10–12 batches** de uma geração. O `prompt-cache.ts` foi feito justamente para esse prefixo virar `cache_read` entre os batches.

**Mas** o `lib/claude.ts` (`buildPromptInput`, linhas ~162–208) **desativou esse cache**: por causa de um conflito de TTL (o CLI injeta `cache_control ttl='1h'` no último bloco, e qualquer breakpoint `ephemeral`=5m antes dele causava erro 400), hoje o `cache_control` fica **só no último bloco** (o sufixo, que **muda a cada batch**). Resultado: o prefixo grande é **reprocessado a cada batch** em vez de lido do cache.

O próprio comentário no código reconhece o trade-off:
> *"Trade-off: perdemos o cache de prefixo cross-batch — reativá-lo exigiria marcar o prefixo com ttl='1h' EXPLÍCITO."*

**Problema secundário:** a docstring de `prompt-cache.ts` ainda afirma que o prefixo "passa a ser lido do cache (`cache_read`) nos 6+ batches" — está **desatualizada** e pode enganar quem mexer nisso depois.

**Recomendação.**
- Reativar o breakpoint no prefixo usando **`cache_control` com `ttl` explícito de 1h** (para empatar com o que o CLI injeta no fim e não tomar o 400 de ordenação). Validar com os logs `cache_read` / `cumulative hit%` que já existem em `claude.ts`.
- Em ~10–12 batches lendo ~20k tokens do cache em vez de reprocessar, o **tempo de "time-to-first-token" de cada batch cai** e o consumo de cota despenca.
- Atualizar a docstring de `prompt-cache.ts` para refletir o estado real.

**Como medir antes/depois:** o `hitPct` acumulado já é logado (`[claude.ts] cumulative: … hit=NN%`). Hoje deve estar baixo durante a Escrita; o objetivo é vê-lo subir batch a batch.

---

## 2. Reduzir a frequência de calibração de contagem de palavras

**O que encontrei.** Depois de escrever, `calibratePart` (em `run-escrita.ts`) recalcula a contagem de cada capítulo e, para todo capítulo fora de **±8%** (`CALIBRATION_THRESHOLD = 0.08`), dispara uma **reescrita Sonnet** (até **3 passes**, `CALIBRATION_MAX_PASSES`, concorrência 5). Ou seja: **toda imprecisão de contagem na 1ª passada vira uma chamada de modelo extra** — esse é hoje um dos maiores custos de tempo variável da Escrita.

O código já mede isso (`[perf] escrita: … N cap(s) fora do alvo → recalibração (X expandir, Y encurtar)`).

**Recomendação.**
- **Olhar o log `[perf]` de algumas gerações reais** para ver quantos capítulos caem em calibração e se o viés é "expandir" (escreveu curto) ou "encurtar" (escreveu longo). Isso diz exatamente para que lado ajustar.
- O prompt da Escrita já é **muito** carregado em instruções de contagem (todo o bloco "REGRA #1"). Se o viés for consistente (ex.: sempre estoura o teto), a correção certa é **ajustar o alvo-mira** (`aim = target * 0.94` na `escrita.ts`) ou enxugar o bloco — e não adicionar mais texto, que só aumenta o custo de cada chamada sem necessariamente melhorar a obediência.
- Se na prática quase nenhum capítulo precisa de 3 passes, **baixar `CALIBRATION_MAX_PASSES` para 2** corta a cauda de pior caso sem perda perceptível.

**Princípio:** cada ponto percentual de capítulos que entram na 1ª passada já dentro da faixa é **uma chamada Sonnet a menos** no caminho crítico.

---

## 3. Modelo por etapa: medir antes de assumir Opus para tudo

**O que encontrei.** **Todas** as etapas usam Opus (`premissa`, `estrutura1/2`, `escrita`, `revisor`, `revisor-extract`). Opus é o mais lento. Faz sentido na **Escrita** (qualidade validada pela roteirista) e provavelmente na Estrutura. Mas vale **testar empiricamente** se algumas sub-etapas toleram Sonnet:

| Etapa | Modelo hoje | Vale testar Sonnet? |
|---|---|---|
| Escrita | Opus | Não — é o coração da qualidade |
| Estrutura P1/P2 | Opus + thinking adaptive | Provavelmente não |
| Premissa — fase "resumo" (Bloco 0) | Opus | **Sim, candidato** — é resumo, não prosa final |
| `revisor-extract-errors` | Opus | **Sim, candidato** — é extração estruturada de XML, tarefa mecânica |
| `escrita-fix-wordcount` | Sonnet ✅ | Já está em Sonnet (correto) |

**Recomendação.** Não trocar nada às cegas. Rodar 3–5 roteiros com Sonnet **só** no `revisor-extract` e na fase "resumo" da Premissa, comparar com os evals de qualidade que vocês já têm, e manter a troca apenas se a qualidade não cair. O `revisor-extract` é o candidato mais seguro: ele só re-extrai um XML que o modelo esqueceu — tarefa onde Sonnet costuma empatar com Opus a uma fração do tempo.

---

## 4. Gargalo serial dentro de cada Parte (estrutural — avaliar com cuidado)

**O que encontrei.** P1 ‖ P2 rodam em paralelo (`Promise.all`), mas **dentro de cada Parte os batches são sequenciais** (2 capítulos por vez), porque o batch N+1 depende das **sinopses** geradas pelo batch N. Com ~5–6 batches por Parte, esse é o caminho crítico real da Escrita.

**Por que não mexer por impulso:** a dependência de sinopse existe para garantir **continuidade** (personagens, ganchos, tom). Paralelizar tudo arriscaria exatamente a qualidade que vocês protegem.

**Ideia para experimentar (não aplicar direto):** as estruturas aprovadas já descrevem cada capítulo. Daria para gerar uma **"sinopse-semente" de cada capítulo a partir da estrutura** (uma chamada barata) e alimentar os batches com essas sementes — permitindo disparar mais batches em paralelo e reconciliar a continuidade fina depois. É a alavanca de maior ganho teórico de tempo, mas a de **maior risco de qualidade** — só vale com um teste A/B controlado contra os evals.

---

## 5. Itens menores

- **Tamanho dos system prompts.** A premissa tem ~79KB (~20k tokens) de system prompt. Como o system prompt **já é cacheado cross-call** (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` em `claude.ts`), o custo recorrente é baixo — mas o **cold start** (1ª geração após reiniciar o servidor) paga isso inteiro. Enxugar redundância nos prompts mais longos melhora o cold start e a manutenção.
- **`maxTokens` do Revisor = 32000.** Não custa tempo por si só (o tempo é proporcional ao que é gerado, não ao teto), mas convém confirmar que o Revisor não está de fato gerando perto desse teto — se estiver, o modo "relatório enxuto" (`leanRevisorReport`) deveria ser o padrão a partir da 2ª passada.
- **Documentação desatualizada** (`prompt-cache.ts`) — corrigir junto com o item 1 para não induzir erro no futuro.

---

## Ordem sugerida de execução

1. **Item 1 (cache do prefixo)** — ganho garantido, mexe em um arquivo, mensurável pelos logs que já existem. Comece aqui.
2. **Item 2 (calibração)** — olhe os logs `[perf]` de gerações reais antes de ajustar; é onde mora a maior variação de tempo.
3. **Item 3 (modelo por etapa)** — experimento controlado em `revisor-extract` e "resumo".
4. **Item 4 (paralelismo intra-Parte)** — só com A/B contra os evals; maior ganho, maior risco.

Nenhuma dessas recomendações exige reescrever a arquitetura — ela está sólida. São ajustes cirúrgicos em pontos que o próprio código já identifica e instrumenta.
