/**
 * Constantes da calibração de word-count da Escrita — compartilhadas pelo
 * foreground (`components/wizard/StepShell.tsx`) e pelo motor headless da fila
 * (`lib/generation/run-escrita.ts`) pra NÃO divergirem. Mexeu aqui, vale pros dois.
 */

/**
 * Limiar de RAM "máquina fraca" (MB) — o MESMO do heap adaptativo em
 * `electron/main.js` (≤6GB). Numa máquina abaixo disso, reduzimos os tetos de
 * concorrência de geração (menos streams Opus simultâneos), porque o que derruba
 * o socket do `claude.exe` na máquina da roteirista (Celeron, 4GB) é a pressão de
 * memória sob geração paralela. 8GB+ fica IDÊNTICO — zero regressão pro time.
 */
export const LOW_MEM_THRESHOLD_MB = 6144;

/**
 * Decide se a máquina é de POUCA RAM a partir do total em MB. Puro/testável.
 * `null`/inválido (fora do Electron: web, SSR, build) → `false` (assume máquina
 * normal, concorrência CHEIA). Assim a otimização só LIGA quando há sinal real de
 * máquina fraca; na dúvida, comporta-se como antes.
 */
export function isLowMemMachine(totalMemMB: number | null | undefined): boolean {
  return (
    typeof totalMemMB === "number" &&
    totalMemMB > 0 &&
    totalMemMB <= LOW_MEM_THRESHOLD_MB
  );
}

/** RAM física exposta pelo preload (`window.mystorieslena.totalMemMB`), síncrona. */
function machineTotalMemMB(): number | null {
  if (typeof window === "undefined") return null;
  const v = window.mystorieslena?.totalMemMB;
  return typeof v === "number" ? v : null;
}

/**
 * `true` numa máquina ≤6GB (ex.: o notebook Celeron 4GB da roteirista). Avaliado
 * UMA vez no load do módulo — o preload já expôs a RAM antes do 1º render, então
 * o valor está pronto quando a fila/Escrita inicializam. Nas máquinas fracas os
 * tetos abaixo caem; nas normais (e fora do Electron) ficam nos valores originais.
 */
export const IS_LOW_MEM_MACHINE = isLowMemMachine(machineTotalMemMB());

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
 *
 * ADAPTATIVO À RAM: numa máquina ≤6GB cai pra **2** (menos streams Sonnet ao
 * mesmo tempo = menos pressão de memória). 8GB+ segue **5**.
 */
export const CALIBRATION_CONCURRENCY = IS_LOW_MEM_MACHINE ? 2 : 5;

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
 * >±CALIBRATION_THRESHOLD do alvo INDIVIDUAL — mas a Escrita mira ×1,02 (milionário-3p
 * ×1,00) e os caps podem cair fora do ±8% em qualquer direção, então a SOMA da Parte pode fechar fora do
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
 *
 * ADAPTATIVO À RAM: numa máquina ≤6GB cai pra **1** — isso SERIALIZA os streams
 * de geração, inclusive o P1‖P2 de UMA Escrita (que sozinho já usa 2). O peak de
 * memória durante a fase mais pesada cai ~pela metade (1 stream Opus por vez em
 * vez de 2), ao custo de a Escrita levar ~o dobro do tempo NAQUELA máquina — troca
 * certa numa máquina que hoje TRAVA no meio da geração (melhor lento+completo que
 * rápido+quebrado). A arquitetura P1‖P2 + costura cruzada NÃO muda: os dois loops
 * seguem rodando (`Promise.all`); só o limitador os intercala 1 a 1. 8GB+ = **2**.
 */
export const GEN_STREAM_CONCURRENCY = IS_LOW_MEM_MACHINE ? 1 : 2;

/**
 * Teto (ms) do backoff exponencial do retry de COTA na geração — vs os 8s dos
 * transientes comuns (rede/429-HTTP/stall/formato). A cota da assinatura renova
 * mais devagar que um burst de 429, então um `[ERRO]` de cota (res.ok=true,
 * tratado como transiente desde o fix do "dois ao mesmo tempo dá branco") espera
 * mais entre tentativas: 1s→2s→4s→8s→16s (teto 30s) ao longo das tentativas,
 * dando à assinatura compartilhada tempo real de recuperar.
 */
export const QUOTA_BACKOFF_CAP_MS = 30_000;
