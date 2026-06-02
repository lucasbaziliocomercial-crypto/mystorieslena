/**
 * Parser do output estruturado do agente Escrita (fluxo unificado all-at-once).
 *
 * O agente entrega no formato:
 *
 *   ═══════════════════════════════════════
 *   ROTEIRO
 *   ═══════════════════════════════════════
 *
 *   ═══════════════════════════════════════
 *   PARTE 1
 *   ═══════════════════════════════════════
 *
 *   # Capítulo 1 — [Título]
 *   [texto]
 *
 *   # Capítulo 2 — [Título]
 *   [texto]
 *
 *   ═══════════════════════════════════════
 *   PARTE 2
 *   ═══════════════════════════════════════
 *
 *   # Capítulo 1 — [Título]
 *   [texto, com marcadores de POV]
 *
 *   ═══════════════════════════════════════
 *   RELATÓRIO DE AUTO-REVISÃO
 *   ═══════════════════════════════════════
 *   [relatório]
 *
 *   ═══════════════════════════════════════
 *   MEMÓRIA VIVA ATUALIZADA
 *   ═══════════════════════════════════════
 *   ```json
 *   { ... }
 *   ```
 *
 *   ═══════════════════════════════════════
 *   VALIDAÇÃO
 *   ═══════════════════════════════════════
 *   Status: APROVADO | BLOQUEADO
 *   [...]
 *
 * Este parser separa o roteiro completo (capítulos + Parte 1 / Parte 2) dos
 * metadados (relatório, memória viva, validação). O roteiro é depois quebrado
 * em capítulos individuais para visualização em cards.
 */

import type { EscritaChapter } from "@/types/roteiro";
import { stripChapterTitleAnnotation } from "./strip-chapter-annotations";

export interface ParsedEscritaOutput {
  /** Texto do roteiro completo — pronto pra leitura/edição. */
  roteiro: string;
  /** Capítulos individuais extraídos do roteiro completo. */
  chapters: EscritaChapter[];
  /** Relatório de auto-revisão (5 passadas + checklist). */
  report?: string;
  /** Memória viva em formato JSON (string). */
  memory?: string;
  /** Status + detalhes da validação bloqueante. */
  validation?: string;
  /** APROVADO | BLOQUEADO | null (se não detectado). */
  validationStatus: "APROVADO" | "BLOQUEADO" | null;
  /** true se nenhum marcador foi encontrado (output mal-formado). */
  rawFallback: boolean;
}

const SECTION_HEADER_REGEX =
  /═{3,}\s*\n\s*(ROTEIRO|PARTE 1|PARTE 2|CAP[IÍ]TULO|RELAT[OÓ]RIO DE AUTO-REVIS[AÃ]O|MEM[OÓ]RIA VIVA ATUALIZADA|VALIDA[CÇ][AÃ]O)\s*\n\s*═{3,}/gi;

type SectionName =
  | "roteiro"
  | "parte1"
  | "parte2"
  | "chapter"
  | "report"
  | "memory"
  | "validation";

function normalizeSectionName(raw: string): SectionName | null {
  const upper = raw.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (upper === "ROTEIRO") return "roteiro";
  if (upper === "PARTE 1") return "parte1";
  if (upper === "PARTE 2") return "parte2";
  if (upper.startsWith("CAPITULO")) return "chapter";
  if (upper.startsWith("RELATORIO")) return "report";
  if (upper.startsWith("MEMORIA")) return "memory";
  if (upper.startsWith("VALIDACAO")) return "validation";
  return null;
}

export function parseEscritaOutput(raw: string): ParsedEscritaOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      roteiro: "",
      chapters: [],
      validationStatus: null,
      rawFallback: true,
    };
  }

  type Hit = { name: SectionName; start: number; end: number };
  const hits: Hit[] = [];
  const regex = new RegExp(SECTION_HEADER_REGEX.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(trimmed)) !== null) {
    const name = normalizeSectionName(m[1]!);
    if (!name) continue;
    hits.push({ name, start: m.index, end: m.index + m[0].length });
  }

  if (hits.length === 0) {
    return {
      roteiro: trimmed,
      chapters: parseChaptersFromRoteiro(trimmed),
      validationStatus: null,
      rawFallback: true,
    };
  }

  // Encontra onde começa o primeiro bloco de metadados (relatório/memória/validação)
  // — tudo antes disso é o roteiro (capítulos + cabeçalhos PARTE 1/PARTE 2).
  const firstMetadataIdx = hits.findIndex(
    (h) => h.name === "report" || h.name === "memory" || h.name === "validation",
  );

  let roteiroText = "";
  if (firstMetadataIdx === -1) {
    // Sem metadados — todo o conteúdo (depois do primeiro header) é roteiro.
    const firstHit = hits[0]!;
    roteiroText = trimmed.slice(firstHit.end).trim();
  } else {
    // Roteiro vai do primeiro hit de roteiro/parte1/parte2 até o primeiro metadado.
    const firstRoteiroIdx = hits.findIndex(
      (h) => h.name === "roteiro" || h.name === "parte1" || h.name === "parte2",
    );
    const startIdx = firstRoteiroIdx >= 0 ? firstRoteiroIdx : 0;
    const startHit = hits[startIdx]!;
    const endHit = hits[firstMetadataIdx]!;
    roteiroText = trimmed.slice(startHit.end, endHit.start).trim();
  }

  // Metadados.
  const metadataSections: Partial<Record<SectionName, string>> = {};
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    if (cur.name !== "report" && cur.name !== "memory" && cur.name !== "validation") {
      continue;
    }
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.start : trimmed.length;
    const body = trimmed.slice(cur.end, nextStart).trim();
    if (body) metadataSections[cur.name] = body;
  }

  const report = metadataSections.report?.trim();
  const memory = extractJsonFromMemoryBlock(metadataSections.memory);
  const validation = metadataSections.validation?.trim();

  let validationStatus: ParsedEscritaOutput["validationStatus"] = null;
  if (validation) {
    const statusMatch = validation.match(/Status:\s*(APROVADO|BLOQUEADO)/i);
    if (statusMatch) {
      validationStatus =
        statusMatch[1]!.toUpperCase() === "APROVADO"
          ? "APROVADO"
          : "BLOQUEADO";
    }
  }

  const chapters = parseChaptersFromRoteiro(roteiroText, memory);

  return {
    roteiro: roteiroText,
    chapters,
    report,
    memory,
    validation,
    validationStatus,
    rawFallback: false,
  };
}

/** Extrai o JSON de dentro de um bloco ```json ... ``` (ou retorna o texto cru). */
function extractJsonFromMemoryBlock(
  memoryBlock: string | undefined,
): string | undefined {
  if (!memoryBlock) return undefined;
  const match = memoryBlock.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match?.[1]) {
    const inner = match[1].trim();
    try {
      return JSON.stringify(JSON.parse(inner), null, 2);
    } catch {
      return inner;
    }
  }
  const trimmed = memoryBlock.trim();
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/**
 * Quebra o texto do roteiro completo em capítulos individuais. Procura por
 * cabeçalhos no formato "# Capítulo N — Título" (ou "# Capítulo N").
 * Detecta também os marcadores de PARTE 1 / PARTE 2 para preencher o
 * campo `part` de cada capítulo.
 *
 * Exportado para uso pela correção pontual da Escrita, que recebe apenas
 * os capítulos alterados (sem banner ═══ ROTEIRO ═══) e precisa quebrar
 * direto sem o pré-corte que `parseEscritaOutput` faz.
 */
export function parseEscritaChaptersDirect(
  text: string,
  memoryJson?: string,
): EscritaChapter[] {
  return parseChaptersFromRoteiro(text, memoryJson);
}

/**
 * Reconstrói o conteúdo do roteiro a partir de um array de capítulos,
 * inserindo banners de Parte (═══ PARTE N ═══) na transição. Inverso do
 * parseEscritaChaptersDirect — usado depois de mexer em chapters[]
 * individualmente (ex: aplicar correção em um cap só).
 */
export function concatenateChapters(chapters: EscritaChapter[]): string {
  const blocks: string[] = [];
  let currentPart: string | undefined;
  for (const c of chapters) {
    if (c.part && c.part !== currentPart) {
      blocks.push(
        `═══════════════════════════════════════\n${c.part.toUpperCase()}\n═══════════════════════════════════════`,
      );
      currentPart = c.part;
    }
    const header = c.title
      ? `# Capítulo ${c.number} — ${c.title}`
      : `# Capítulo ${c.number}`;
    blocks.push(`${header}\n\n${c.content.trim()}`);
  }
  return blocks.join("\n\n");
}

function parseChaptersFromRoteiro(
  roteiroText: string,
  memoryJson?: string,
): EscritaChapter[] {
  if (!roteiroText.trim()) return [];

  // Memória viva final (se disponível) tem a contagem de palavras + cliffhanger
  // de cada capítulo — usamos para enriquecer os chapters extraídos.
  const memoryChapters = parseMemoryChapters(memoryJson);

  // Mapeia inícios de PARTE 1 e PARTE 2. Suporta dois formatos:
  //   1. ═══ PARTE 1 ═══ (legado)
  //   2. # PARTE 1     (novo, vira heading 1 no Google Docs)
  const parteRegex =
    /(?:═{3,}\s*\n\s*(PARTE 1|PARTE 2)\s*\n\s*═{3,})|(?:^#\s+(PARTE 1|PARTE 2)\s*$)/gim;
  const parteHits: { name: "Parte 1" | "Parte 2"; index: number }[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = parteRegex.exec(roteiroText)) !== null) {
    const matched = (pm[1] || pm[2] || "").toUpperCase();
    if (matched !== "PARTE 1" && matched !== "PARTE 2") continue;
    parteHits.push({
      name: matched === "PARTE 1" ? "Parte 1" : "Parte 2",
      index: pm.index,
    });
  }

  function partAtIndex(idx: number): string | undefined {
    let current: string | undefined;
    for (const ph of parteHits) {
      if (ph.index <= idx) current = ph.name;
      else break;
    }
    return current;
  }

  // Localiza cabeçalhos de capítulo. `#{0,4}` torna o markdown opcional
  // (modelo às vezes emite `Capítulo 1 — Título` sem `##`); `\*{0,2}` aceita
  // bold (`**Capítulo 1**`). O `^` âncora previne falso positivo em narrativa.
  const chapterRegex = /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\s*(?:—|-|–)\s*(.+?)\s*\*{0,2}\s*$/gim;
  const chapterRegexNoTitle = /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\s*\*{0,2}\s*$/gim;

  type Hit = { number: number; title?: string; index: number; headerEnd: number };
  const hits: Hit[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = chapterRegex.exec(roteiroText)) !== null) {
    hits.push({
      number: parseInt(cm[1]!, 10),
      title: stripChapterTitleAnnotation(cm[2]!.trim()),
      index: cm.index,
      headerEnd: cm.index + cm[0].length,
    });
  }
  // Captura também capítulos sem título (raro, mas suportar).
  while ((cm = chapterRegexNoTitle.exec(roteiroText)) !== null) {
    if (hits.some((h) => h.index === cm!.index)) continue;
    hits.push({
      number: parseInt(cm[1]!, 10),
      index: cm.index,
      headerEnd: cm.index + cm[0].length,
    });
  }

  hits.sort((a, b) => a.index - b.index);

  if (hits.length === 0) {
    // Fallback — sem cabeçalhos, devolve o roteiro inteiro como um único "capítulo".
    return [
      {
        number: 1,
        content: roteiroText.trim(),
        generatedAt: new Date().toISOString(),
      },
    ];
  }

  const result: EscritaChapter[] = [];
  for (let i = 0; i < hits.length; i++) {
    const cur = hits[i]!;
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.index : roteiroText.length;
    const body = roteiroText.slice(cur.headerEnd, nextStart).trim();
    // Remove cabeçalhos de PARTE 1/PARTE 2 que tenham caído dentro deste body
    // (entre dois capítulos). Cobre ambos formatos: ═══ PARTE 1 ═══ e # PARTE 1.
    const cleanedBody = body
      .replace(/═{3,}\s*\n\s*PARTE [12]\s*\n\s*═{3,}/gi, "")
      .replace(/^#\s+PARTE [12]\s*$/gim, "")
      .trim();

    const part = partAtIndex(cur.index);
    const memInfo = memoryChapters.get(cur.number);

    result.push({
      number: cur.number,
      title: cur.title,
      part: part ?? memInfo?.part,
      content: cleanedBody,
      cliffhanger: memInfo?.cliffhanger,
      wordCount: memInfo?.wordCount,
      generatedAt: new Date().toISOString(),
    });
  }

  return result;
}

interface MemoryChapterInfo {
  number: number;
  part?: string;
  title?: string;
  cliffhanger?: string;
  wordCount?: number;
}

function parseMemoryChapters(
  memoryJson: string | undefined,
): Map<number, MemoryChapterInfo> {
  const map = new Map<number, MemoryChapterInfo>();
  if (!memoryJson) return map;
  try {
    const parsed = JSON.parse(memoryJson) as {
      capitulos_escritos?: Array<{
        numero?: number;
        titulo?: string;
        parte?: string;
        cliffhanger?: string;
        contagem_palavras?: number;
      }>;
    };
    const caps = parsed.capitulos_escritos;
    if (Array.isArray(caps)) {
      for (const c of caps) {
        if (typeof c.numero !== "number") continue;
        map.set(c.numero, {
          number: c.numero,
          part: c.parte,
          title: c.titulo,
          cliffhanger: c.cliffhanger,
          wordCount:
            typeof c.contagem_palavras === "number"
              ? c.contagem_palavras
              : undefined,
        });
      }
    }
  } catch {
    // ignore
  }
  return map;
}

/**
 * Filtra o bloco de JSON da Memória Viva do output em streaming,
 * substituindo-o por um placeholder elegante. O resto do output
 * (cabeçalhos, capítulos, relatório, validação) permanece cru.
 */
export function filterMemoryBlockForDisplay(acc: string): string {
  const memHeaderRe =
    /═{3,}\s*\n\s*MEM[OÓ]RIA VIVA ATUALIZADA\s*\n\s*═{3,}/i;
  const memHeaderMatch = memHeaderRe.exec(acc);
  if (!memHeaderMatch) return acc;

  const memHeaderEnd = memHeaderMatch.index + memHeaderMatch[0].length;
  const afterMem = acc.slice(memHeaderEnd);

  const validationHeaderRe = /═{3,}\s*\n\s*VALIDA[CÇ][AÃ]O\s*\n\s*═{3,}/i;
  const validationMatch = validationHeaderRe.exec(afterMem);

  const before = acc.slice(0, memHeaderEnd);
  const placeholder =
    "\n\n  ✨ Construindo memória viva final…\n  (timeline, personagens, ganchos, capítulos catalogados)\n";

  if (validationMatch) {
    const validationAndAfter = afterMem.slice(validationMatch.index);
    return `${before}${placeholder}\n${validationAndAfter}`;
  }

  return `${before}${placeholder}`;
}
