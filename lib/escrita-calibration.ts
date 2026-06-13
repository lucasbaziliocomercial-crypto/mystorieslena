/**
 * Constantes da calibração de word-count da Escrita — compartilhadas pelo
 * foreground (`components/wizard/StepShell.tsx`) e pelo motor headless da fila
 * (`lib/generation/run-escrita.ts`) pra NÃO divergirem. Mexeu aqui, vale pros dois.
 */

/**
 * Tolerância do alvo de palavras POR CAPÍTULO. Capítulos cujo desvio relativo
 * for MAIOR que isso são reescritos via `/api/escrita-fix-wordcount` (1 chamada
 * Opus cada).
 *
 * Afrouxado de ±5% → **±8%** de propósito: menos capítulos disparam reescrita =
 * menos chamadas Opus = Escrita mais rápida. O step Revisor faz o ajuste fino
 * final a ±3%, então a saída FINAL fica parecida — a Escrita só não precisa mais
 * ser tão precisa sozinha.
 */
export const CALIBRATION_THRESHOLD = 0.08;

/**
 * Máximo de calibrações rodando ao mesmo tempo — teto TOTAL compartilhado pelas
 * duas Partes (via `createLimiter` em `run-escrita.ts`, não mais um pool por
 * Parte). A calibração é **Sonnet** (mais leve) e roda per-Parte assim que CADA
 * Parte termina de gerar: a da P1 **SOBREPÕE a cauda de geração (Opus) da P2**,
 * aproveitando a cota que ficava ociosa quando a P1 acabava antes.
 * **5** ataca o gargalo dos ÚLTIMOS capítulos da Parte 2: quando vários caps
 * saem curtos e precisam EXPANDIR de uma vez, mais concorrência = menos rodadas
 * = "fim" mais rápido. É um knob: numa assinatura compartilhada (equipe), se os
 * logs `[perf]` mostrarem 429 na calibração (agora ela compete com a geração
 * Opus da P2 na janela de sobreposição), reduza; pra 1 força calibração
 * estritamente sequencial.
 */
export const CALIBRATION_CONCURRENCY = 5;

/**
 * Máximo de passes de reescrita POR CAPÍTULO na calibração. Um passe só do Sonnet
 * raramente cobre desvios grandes (ex.: +38% acima do alvo — o Opus tende a
 * escrever longo em prosa criativa por mais que o prompt grite "TETO RÍGIDO"), e
 * um passe que falha por cota/rede na janela de sobreposição P1‖P2 era engolido
 * como best-effort, deixando o capítulo no tamanho cru. Com até **3** passes,
 * cada um reconta o tamanho ATUAL e encurta/expande de novo até entrar na faixa
 * ±CALIBRATION_THRESHOLD — encurtamentos parciais compõem (2.847→2.500→2.250→…)
 * e falhas viram retry. O loop só aceita resultado que APROXIMA do alvo (nunca
 * piora) e para assim que entra na faixa, então o custo extra só acontece nos
 * capítulos realmente fora — não desacelera o caso comum.
 */
export const CALIBRATION_MAX_PASSES = 3;

/**
 * Máximo de passes do BALANÇO DE TOTAL da Parte (`balancePartTotal` em
 * `run-escrita.ts`). A calibração por-capítulo acima só toca caps com desvio
 * >±CALIBRATION_THRESHOLD do alvo INDIVIDUAL — mas a Escrita mira ×0,99 (milionário-3p
 * ×0,97) e os caps podem cair curtos DENTRO do ±8%, então a SOMA da Parte pode fechar abaixo do piso do
 * `partTotalRange` e nada a puxava de volta. O balanço expande os caps mais
 * curtos (ou encurta os mais longos) até o total entrar na faixa, mirando o MEIO
 * da faixa pra absorver a imprecisão do Sonnet. Cada cap é limitado ao seu
 * PRÓPRIO alvo, então a soma nunca cruza pro outro lado — 2 passes bastam: o 1º
 * fecha o grosso, o 2º cobre o resíduo de quem o Sonnet expandiu de menos. Se
 * mesmo assim não fechar, para gracioso (total levemente fora » muito fora).
 */
export const BALANCE_MAX_PASSES = 2;

/**
 * Teto GLOBAL de streams de GERAÇÃO (Opus) concorrentes entre TODOS os jobs da
 * fila. Cada job de Escrita roda Parte 1 ‖ Parte 2 = 2 streams; com o teto
 * `MAX_CONCURRENT_STREAMS = 4` do QueueRunner (Escrita custa 2 via `jobStreamCost`),
 * DUAS Escritas ao mesmo tempo disparavam até 4 streams Opus disputando a
 * assinatura ÚNICA da equipe — a rota então injetava `[ERRO]` de cota no corpo do
 * stream e a run inteira abortava em branco. Este teto (aplicado por um
 * `createLimiter` MÓDULO-LEVEL em
 * `run-escrita.ts`, compartilhado entre invocações) mantém o total de streams de
 * geração em ~2: um job sozinho (2 streams) fica INALTERADO; dois jobs se
 * intercalam dentro do teto e AMBOS terminam. É um knob — se os logs `[perf]`
 * mostrarem pouca contenção (poucos `transientRetries`), pode subir; se aparecer
 * `[ERRO]` de cota, baixe.
 */
export const GEN_STREAM_CONCURRENCY = 2;

/**
 * Teto (ms) do backoff exponencial do retry de COTA na geração — vs os 8s dos
 * transientes comuns (rede/429-HTTP/stall/formato). A cota da assinatura renova
 * mais devagar que um burst de 429, então um `[ERRO]` de cota (res.ok=true,
 * tratado como transiente desde o fix do "dois ao mesmo tempo dá branco") espera
 * mais entre tentativas: 1s→2s→4s→8s→16s (teto 30s) ao longo das tentativas,
 * dando à assinatura compartilhada tempo real de recuperar.
 */
export const QUOTA_BACKOFF_CAP_MS = 30_000;
