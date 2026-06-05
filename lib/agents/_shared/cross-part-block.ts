import type { EscritaSynopsis } from "@/types/roteiro";

/**
 * Bloco de CONTEXTO CRUZADO entre Partes da Escrita (continuidade P1 → P2).
 *
 * O motor headless (`lib/generation/run-escrita.ts`) escreve a Parte 1 e a
 * Parte 2 EM PARALELO. Sem este bloco a P2 enxerga só as próprias sinopses e
 * fica CEGA ao que a P1 de fato narrou — a "ponte" depende só da Estrutura
 * planejada + cânone, que não basta: produz os dois erros GRAVES clássicos de
 * continuidade cruzada — "personagem em dois lugares" e "contradição de
 * concepção P1↔P2".
 *
 * Aqui a P2 recebe as sinopses dos capítulos que a P1 JÁ escreveu naquele
 * instante (leitura *best-effort* do acumulador compartilhado, SEM bloquear o
 * paralelismo — como as duas Partes avançam no mesmo ritmo, quando a P2 escreve
 * o cap N ela costuma já ter os fatos da P1 até ~N). Vai no SUFIXO variável da
 * mensagem (depois do breakpoint de cache), porque muda a cada batch.
 *
 * Fonte única pras 4 categorias (milionario1p/3p, mafia, alphaking) — mexeu
 * aqui, vale pra todas. Retorna "" quando não há sinopses cruzadas (P1, retomada
 * sem P1 pronta, ou primeiro batch da P2 antes da P1 emitir qualquer sinopse).
 */
export function buildCrossPartBlock(synopses?: EscritaSynopsis[]): string {
  if (!synopses || synopses.length === 0) return "";
  const ordered = [...synopses].sort((a, b) => a.number - b.number);
  const otherPart = ordered[0]?.part ?? "a outra Parte";
  const lines = ordered
    .map((s) => `• [${s.part} · Cap ${s.number}] ${s.synopsis}`)
    .join("\n");
  return `━━━ FATOS JÁ ESTABELECIDOS NA ${otherPart.toUpperCase()} (cânone vivo — NÃO contradiga) ━━━\n\n${lines}\n\nEstes são fatos REAIS já ESCRITOS na ${otherPart} (não o plano da Estrutura — o que de fato aconteceu no texto). Esta Parte é a CONTINUAÇÃO direta dela: respeite onde cada personagem ficou fisicamente, o que já foi revelado, o estado das relações e os objetos/lugares/datas já fixados. Se a Estrutura desta Parte conflitar com um fato já escrito aqui, o FATO ESCRITO prevalece. NUNCA coloque um personagem em dois lugares ao mesmo tempo, nem reescreva a concepção/origem/passado já estabelecido na ${otherPart}.`;
}
