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
 * Máximo de calibrações rodando ao mesmo tempo. Numa assinatura única (OAuth
 * Pro/Max), concorrência alta demais só enfileira no servidor — 3 é o teto
 * seguro. Reduza pra 1 pra forçar calibração estritamente sequencial.
 */
export const CALIBRATION_CONCURRENCY = 3;
