/**
 * Piso de capítulos que uma Estrutura VÁLIDA precisa declarar, por Parte e
 * categoria — backstop determinístico contra Estrutura TRUNCADA.
 *
 * Quando o socket do `claude.exe` cai "limpo" no meio do stream da Estrutura
 * (sem injetar `[ERRO]`, o stream só encerra cedo — pressão de memória na máquina
 * fraca da roteirista), a Estrutura sai com menos capítulos que o esperado (ex.:
 * 4 de 6). Nada downstream conferia isso: a Escrita gera fiel aos 4 caps (~8k
 * palavras em vez de ~12k), o guard de completude da Escrita só dispara com a
 * Parte VAZIA, e a roteirista só percebia no Google Docs ("poucos capítulos,
 * contagem não bate"). `runEstruturaStep` (run-step.ts) usa este piso pra
 * RETENTAR a chamada (TransientStreamError → withStallRetry) quando a Estrutura
 * vem curta; esgotadas as tentativas, o job erra ("Gerar novamente") em vez de
 * salvar a Estrutura truncada.
 *
 * Valores = os invariantes de contagem travados nos prompts de Estrutura (ver
 * CLAUDE.md / "Parte 2 = exatamente 6"): Parte 2 = SEMPRE 6 nas 4 categorias;
 * Parte 1 = 6 (milionario-1p, alpha-king) ou 5 (milionario-3p, mafia, que os
 * prompts deixam "5 a 6"). É um PISO (`>=` passa), então uma P1 legítima de 5 ou 6
 * nas categorias 5-6 nunca dá falso-positivo; só uma Estrutura de fato curta dispara.
 *
 * Módulo standalone COM SÓ import de TIPO (RoteiroCategory) de propósito: sem
 * import de VALOR via `@/`, `--experimental-strip-types` do node resolve e o
 * teste (`scripts/test-expected-min-chapters.mjs`) roda no `npm test`/CI. Ver a
 * mesma restrição em `lib/eval-log.ts`.
 */
import type { RoteiroCategory } from "@/lib/categories/types";

/** Default histórico (roteiros legados sem categoria) — igual ao DEFAULT_CATEGORY. */
const DEFAULT_CATEGORY: RoteiroCategory = "milionario-1p";

const MIN_CHAPTERS: Record<
  RoteiroCategory,
  { "Parte 1": number; "Parte 2": number }
> = {
  "milionario-1p": { "Parte 1": 6, "Parte 2": 6 },
  "milionario-3p": { "Parte 1": 5, "Parte 2": 6 },
  mafia: { "Parte 1": 5, "Parte 2": 6 },
  "alpha-king": { "Parte 1": 6, "Parte 2": 6 },
};

export function expectedMinChapters(
  part: "Parte 1" | "Parte 2",
  category: RoteiroCategory = DEFAULT_CATEGORY,
): number {
  return MIN_CHAPTERS[category][part];
}
