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
