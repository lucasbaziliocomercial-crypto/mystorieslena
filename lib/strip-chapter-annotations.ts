/**
 * Remove a anotação de PLANEJAMENTO que o prompt da Estrutura coloca no
 * cabeçalho de cada capítulo:
 *
 *   `## Capítulo 1 — A Chegada (~1.380 palavras — ritmo rápido)`
 *                              └──────── anotação ────────────┘
 *
 * Outras formas geradas: `(± X palavras — ritmo Y)`, `(2.097 palavras)`,
 * `(~2.070 palavras — ritmo desenvolvido)`. É orçamento de escrita — existe só
 * pra guiar a Escrita — e JAMAIS deve aparecer no título do capítulo no
 * roteiro final.
 *
 * O modelo da Escrita ocasionalmente copia o cabeçalho INTEIRO da Estrutura
 * (anotação incluída) em vez de só o título. Estas funções limpam essa sujeira
 * em todos os pontos onde um título de capítulo é capturado, exibido ou
 * exportado — e curam roteiros já salvos no localStorage.
 *
 * Invariante de segurança: só removemos um parêntese FINAL cujo miolo menciona
 * "palavra(s)" — o denominador comum de TODAS as formas geradas (a cadência
 * "ritmo X" sempre vem junto de "palavras" no mesmo parêntese). Títulos com
 * parêntese legítimo ("A Volta (Finalmente)") ficam intactos.
 */

// Parêntese final cujo conteúdo menciona "palavra(s)". Casa (), [] e os
// parênteses fullwidth （） que o LLM às vezes emite.
const TRAILING_PLAN_ANNOTATION_SRC =
  "\\s*[(\\[（]\\s*[^)\\]）]*palavras?[^)\\]）]*[)\\]）]\\s*$";

/** Remove a anotação de planejamento do FIM de um título de capítulo. */
export function stripChapterTitleAnnotation(title: string): string {
  if (!title) return title;
  const re = new RegExp(TRAILING_PLAN_ANNOTATION_SRC, "i");
  let next = title;
  let prev: string;
  // Loop pra cobrir o caso raro de duas anotações encadeadas
  // ("Título (~1.380 palavras) (ritmo rápido)").
  do {
    prev = next;
    next = next.replace(re, "");
  } while (next !== prev);
  return next.trim();
}

// Cabeçalho de capítulo numa linha do roteiro — mesma tolerância dos parsers
// de escrita (`## Capítulo 1 — Título`, `# Capítulo 1 — Título`,
// `Capítulo 1 — Título`, com bold opcional). Grupo 1 = prefixo até o travessão,
// grupo 2 = título, grupo 3 = bold de fechamento opcional.
const CHAPTER_HEADER_LINE_SRC =
  "^(#{0,4}\\s*\\*{0,2}\\s*Cap[ií]tulo\\s+\\d+\\s*(?:—|–|-)\\s*)(.+?)(\\s*\\*{0,2})\\s*$";

/** True se algum cabeçalho de capítulo no blob carrega a anotação. */
export function hasChapterTitleAnnotation(text: string | undefined): boolean {
  if (!text) return false;
  const re = new RegExp(CHAPTER_HEADER_LINE_SRC, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== stripChapterTitleAnnotation(m[2]!)) return true;
  }
  return false;
}

/**
 * Limpa a anotação dos cabeçalhos de capítulo num blob de roteiro monolítico
 * (`outputs.escrita.content`), preservando todo o resto linha-a-linha. Seguro
 * para conteúdo editado pela roteirista — só mexe nas linhas de cabeçalho.
 */
export function stripChapterHeaderAnnotations(text: string): string {
  if (!text) return text;
  const re = new RegExp(CHAPTER_HEADER_LINE_SRC, "gim");
  return text.replace(re, (full, prefix: string, title: string, suffix: string) => {
    const cleaned = stripChapterTitleAnnotation(title);
    // O grupo `title` já vem sem espaço/bold nas pontas (consumidos por
    // `prefix`/`suffix`), então comparar direto é seguro.
    return cleaned === title ? full : `${prefix}${cleaned}${suffix}`;
  });
}
