/**
 * Avaliação de COMPLETUDE de uma Escrita já gerada — a entrega NÃO pode sair
 * curta em silêncio.
 *
 * Uma Parte é INCOMPLETA se: (a) 0 capítulos; (b) MENOS capítulos que a
 * Estrutura declara (um lote foi largado após esgotar os retries por cota/rede/
 * stall — vira aviso não-fatal e os capítulos ficam faltando); ou (c) todos os
 * capítulos presentes mas a SOMA de palavras ficou ABAIXO do piso da faixa (a
 * calibração/balanço — que puxaria a contagem pra dentro da faixa — também falhou
 * por cota; `balancePartTotal` vira no-op sob saturação da assinatura da equipe).
 *
 * Antes SÓ (a) bloqueava a geração; (b) e (c) saíam como "pronto" com um aviso
 * amarelo que passava batido, e a roteirista exportava um doc curto ("o doc não
 * respeita a contagem"). Agora as três marcam a entrega como incompleta → o motor
 * lança EscritaIncompleteError e a UI mostra "Continuar geração" (que regenera os
 * capítulos que faltam E re-roda calibração+balanço, idempotentes, pra fechar a
 * contagem). Escolha da roteirista (16/07/2026): melhor bloquear e completar que
 * entregar curto sem avisar.
 *
 * Função PURA (sem imports de valor) — node-testável (`--experimental-strip-types`
 * não resolve `@/` em import de valor; ver `lib/expected-min-chapters.ts`). O
 * chamador (`run-escrita.ts`) monta os números por Parte a partir dos capítulos
 * gerados + `partTotalRange` (category-aware, cobre as 4 categorias).
 */

export interface PartCompleteness {
  /** Rótulo da Parte, ex.: "Parte 1". */
  part: string;
  /** Capítulos DISTINTOS de fato gerados (numerados) nesta Parte. */
  gotChapters: number;
  /** Capítulos que a Estrutura declara pra esta Parte. */
  expectedChapters: number;
  /** Soma de palavras dos capítulos desta Parte (via countWords). */
  words: number;
  /** Piso de palavras da faixa desta Parte (partTotalRange(part).min). */
  minWords: number;
}

/**
 * Devolve a lista de problemas (frases legíveis) das Partes incompletas — vazia
 * se tudo completo. Ordem: vazia → faltando capítulos → soma abaixo do piso.
 * Cada Parte reporta NO MÁXIMO um problema (o mais grave). Pura/testável.
 */
export function findIncompleteProblems(parts: PartCompleteness[]): string[] {
  const problems: string[] = [];
  for (const p of parts) {
    if (p.expectedChapters <= 0) continue; // Parte não declarada na Estrutura
    if (p.gotChapters <= 0) {
      problems.push(`${p.part} ficou vazia (0 de ${p.expectedChapters} capítulos)`);
      continue;
    }
    if (p.gotChapters < p.expectedChapters) {
      problems.push(
        `${p.part} saiu incompleta (${p.gotChapters} de ${p.expectedChapters} capítulos)`,
      );
      continue;
    }
    // Todos os capítulos presentes — a SOMA precisa alcançar o piso da faixa.
    if (p.minWords > 0 && p.words < p.minWords) {
      problems.push(
        `${p.part} ficou abaixo da contagem mínima (${p.words} de ${p.minWords}+ palavras)`,
      );
    }
  }
  return problems;
}
