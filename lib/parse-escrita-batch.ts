/**
 * Parser do output de UM batch do agente Escrita no fluxo 2-em-2.
 *
 * Formato esperado por batch (sem banners ROTEIRO/PARTE/RELATÓRIO):
 *
 *   ## Capítulo N — Título
 *   [conteúdo do capítulo]
 *
 *   ## Capítulo N+1 — Título
 *   [conteúdo do capítulo]
 *
 *   ═══ SINOPSES ═══
 *   - Cap N: [3-5 frases. Eventos, tom, cliffhanger.]
 *   - Cap N+1: [idem]
 *
 * O frontend chama esse parser depois que o stream do batch fecha, anexa os
 * capítulos no acumulador global e usa as sinopses como contexto pro próximo
 * batch.
 */

import type { EscritaChapter, EscritaSynopsis } from "@/types/roteiro";
import { stripChapterTitleAnnotation } from "./strip-chapter-annotations";

export interface ParsedBatch {
  chapters: EscritaChapter[];
  synopses: EscritaSynopsis[];
}

const SYNOPSES_BANNER_REGEX =
  /═{3,}\s*\n?\s*SINOPSES?\s*\n?\s*═{3,}/i;
// Markdown opcional + bold opcional — tolera `## Capítulo N — Título`,
// `Capítulo N — Título` puro e `**Capítulo N — Título**`.
const CHAPTER_HEADER_REGEX =
  /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\s*(?:—|–|-)\s*(.+?)\s*\*{0,2}\s*$/gim;
const CHAPTER_HEADER_NO_TITLE_REGEX =
  /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\s*\*{0,2}\s*$/gim;

export function parseEscritaBatch(
  raw: string,
  part: "Parte 1" | "Parte 2",
): ParsedBatch {
  const trimmed = raw.trim();
  if (!trimmed) return { chapters: [], synopses: [] };

  // 1) Separa o corpo dos capítulos do bloco de sinopses (se houver).
  const synopsesMatch = SYNOPSES_BANNER_REGEX.exec(trimmed);
  const chaptersBody = synopsesMatch
    ? trimmed.slice(0, synopsesMatch.index).trim()
    : trimmed;
  const synopsesBody = synopsesMatch
    ? trimmed.slice(synopsesMatch.index + synopsesMatch[0].length).trim()
    : "";

  // 2) Localiza cabeçalhos de capítulo no corpo.
  type Hit = {
    number: number;
    title?: string;
    index: number;
    headerEnd: number;
  };
  const hits: Hit[] = [];

  const titledRe = new RegExp(CHAPTER_HEADER_REGEX.source, "gim");
  let m: RegExpExecArray | null;
  while ((m = titledRe.exec(chaptersBody)) !== null) {
    hits.push({
      number: parseInt(m[1]!, 10),
      title: stripChapterTitleAnnotation(m[2]!.trim()),
      index: m.index,
      headerEnd: m.index + m[0].length,
    });
  }
  const noTitleRe = new RegExp(CHAPTER_HEADER_NO_TITLE_REGEX.source, "gim");
  while ((m = noTitleRe.exec(chaptersBody)) !== null) {
    if (hits.some((h) => h.index === m!.index)) continue;
    hits.push({
      number: parseInt(m[1]!, 10),
      index: m.index,
      headerEnd: m.index + m[0].length,
    });
  }
  hits.sort((a, b) => a.index - b.index);

  // 3) Extrai conteúdo de cada capítulo (do fim do header até o próximo header).
  const generatedAt = new Date().toISOString();
  const chapters: EscritaChapter[] = [];

  if (hits.length === 0) {
    // Fallback: nenhum header detectado — devolve o corpo inteiro como cap único
    // (raríssimo, mas evita perder texto se o agente ignorar o formato).
    if (chaptersBody) {
      chapters.push({
        number: 0,
        part,
        content: chaptersBody,
        generatedAt,
      });
    }
  } else {
    for (let i = 0; i < hits.length; i++) {
      const cur = hits[i]!;
      const nextStart =
        i + 1 < hits.length ? hits[i + 1]!.index : chaptersBody.length;
      const body = chaptersBody.slice(cur.headerEnd, nextStart).trim();
      chapters.push({
        number: cur.number,
        title: cur.title,
        part,
        content: body,
        generatedAt,
      });
    }
  }

  // 4) Parseia sinopses linha-a-linha. Aceita "Cap N" ou "Capítulo N",
  //    com bullet opcional (- * •) e separador : — – -. Cada bullet é uma
  //    sinopse de um capítulo. Linhas que não casam (cabeçalhos sobrando,
  //    linhas em branco) são ignoradas.
  const synopses: EscritaSynopsis[] = [];
  if (synopsesBody) {
    const lineRe =
      /^\s*[-*•]?\s*Cap(?:[ií]tulo)?\s+(\d+)\s*[:—–-]\s*(.+?)\s*$/i;
    for (const line of synopsesBody.split(/\r?\n/)) {
      const sm = lineRe.exec(line);
      if (!sm) continue;
      const number = parseInt(sm[1]!, 10);
      const synopsis = sm[2]!.trim();
      if (Number.isFinite(number) && synopsis) {
        synopses.push({ number, part, synopsis });
      }
    }
  }

  return { chapters, synopses };
}
