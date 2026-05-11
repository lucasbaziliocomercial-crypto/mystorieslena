/**
 * Helpers compartilhados pra aplicar sugestões de erros transversais do
 * Revisor (cards "Sugestão IA") via /api/escrita-apply-suggestion.
 *
 * Arquitetura:
 *   1. computeApplyScope(error, content, chapters) — calcula escopo SYNC.
 *      Retorna kind/label/conteúdo do trecho a mandar pro Opus, ou um
 *      escopo "blocked" pra UI tratar (dedup primeiro, ou edição manual).
 *   2. applySuggestionsToScope(scope, errors, ...) — faz a chamada (stream)
 *      e retorna o roteiro/chapters atualizados.
 *   3. applySuggestionToScope(error, ...) — wrapper pra aplicar UM erro
 *      (calcula escopo internamente). Chamado pelo botão da UI.
 *
 * Escopo "window" (default desde 2026-05): em vez de mandar o capítulo
 * inteiro pra trocar 1 nome, recortamos uma janela cirúrgica de ~5
 * parágrafos ao redor do match fuzzy. Opus reescreve só essa janela
 * em <15s. Erros sem âncora literal caem em "chapter" mas com
 * `requiresConfirmation` — UI mostra modal antes de chamar Opus.
 */

import type { EscritaChapter, RevisorError } from "@/types/roteiro";
import {
  concatenateChapters,
  parseEscritaChaptersDirect,
} from "./parse-escrita-output";
import { findTrechoWindow } from "./trecho-window";
import { validateRewrite } from "./validate-rewrite";

/**
 * Normaliza texto pra comparação de "mudou de verdade?": colapsa whitespace,
 * remove zero-width chars (​-‍, ﻿). Não normaliza casing/
 * aspas — diferenças aí são mudanças reais que queremos detectar.
 */
function normalizeForChangeCheck(s: string): string {
  return s.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Detecta quando a reescrita do Opus é, na prática, idêntica ao input
 * (whitespace/zero-width ignorados). Quando true, a "aplicação" não vai
 * mudar o roteiro visivelmente — bloqueamos pra não criar status "APLICADO"
 * enganador. Casing/aspas/travessões DIFEREM intencionalmente: se Opus
 * normalizou esses, é uma mudança real (mesmo que pequena).
 */
function isNoOpRewrite(original: string, rewritten: string): boolean {
  return (
    normalizeForChangeCheck(original) === normalizeForChangeCheck(rewritten)
  );
}

export type ScopeKind = "window" | "chapter" | "part" | "full" | "blocked";

export type BlockedReason = "duplicate-chapter" | "no-chapter-anchor";

export interface ApplyScope {
  kind: ScopeKind;
  /** Conteúdo do trecho recortado pra mandar pro Opus (vazio quando blocked). */
  content: string;
  /** Caps incluídos no escopo (vazio quando kind=full/blocked). */
  chapters: EscritaChapter[];
  /** Rótulo legível pra UI ("Cap. 4 da Parte 2", "janela em Cap. 4"). */
  label: string;
  /**
   * Window-only: offsets dentro de `parentChapter.content` onde a janela
   * começa/termina. Splice do retorno do Opus volta nesses offsets.
   */
  windowStart?: number;
  windowEnd?: number;
  /** Window-only: capítulo pai do qual a janela foi recortada. */
  parentChapter?: EscritaChapter;
  /**
   * Chapter-only: UI deve pedir confirmação antes de mandar pro Opus —
   * setado quando não tem âncora literal pra escopo cirúrgico (informativo
   * sem trechoOriginal, ou janela não pôde ser computada).
   */
  requiresConfirmation?: boolean;
  /** Blocked-only: motivo do bloqueio pra UI exibir mensagem certa. */
  blockedReason?: BlockedReason;
}

export interface SuggestionApplyResult {
  applied: boolean;
  /** Conteúdo completo do roteiro atualizado (só populado se applied=true). */
  newContent?: string;
  /** Array de chapters atualizado (só populado se applied=true). */
  newChapters?: EscritaChapter[];
  /**
   * Sinaliza que a IA devolveu uma resposta que falhou validação (eco da
   * instrução, truncamento, briefing copiado em vez do capítulo) e o caller
   * deve avisar a usuária. Quando true, applied é false e o conteúdo
   * original foi preservado.
   */
  validationFailed?: boolean;
  /** Mensagem legível pra UI quando validationFailed=true. */
  validationMessage?: string;
}

/**
 * Calcula o escopo cirúrgico pra aplicar a sugestão. Cascata:
 *   1. trechoOriginal + parte + capítulo identificados + 1 cap match
 *      → tenta findTrechoWindow no cap → kind="window".
 *      → não acha janela → kind="chapter" (requiresConfirmation).
 *   2. erro informativo (sem trechoOriginal) + 1 cap match
 *      → kind="chapter" (requiresConfirmation).
 *   3. capítulo duplicado detectado → kind="blocked"
 *      (UI pede pra rodar dedup primeiro).
 *   4. sem parte+capitulo → kind="blocked" (sem âncora).
 *
 * NUNCA mais escalonamos pra Parte inteira ou roteiro inteiro
 * automaticamente — a usuária reclamou que parecia "reescrita da história
 * inteira". Casos transversais reais (adicionar epílogo etc) caem em
 * "chapter" com requiresConfirmation.
 */
export function computeApplyScope(
  err: RevisorError,
  escritaContent: string,
  allChapters: EscritaChapter[],
): ApplyScope {
  void escritaContent; // Reservado pra futura extensão (best-cap-guess sem metadata).
  const hasChaptersMetadata = allChapters.length > 0;
  const partLabel =
    err.parte === 1 ? "Parte 1" : err.parte === 2 ? "Parte 2" : undefined;

  if (
    hasChaptersMetadata &&
    partLabel &&
    typeof err.capitulo === "number"
  ) {
    const matchingCaps = allChapters.filter(
      (c) => c.part === partLabel && c.number === err.capitulo,
    );
    if (matchingCaps.length > 1) {
      return {
        kind: "blocked",
        chapters: matchingCaps,
        content: "",
        label: `${partLabel} (Cap. ${err.capitulo} duplicado ${matchingCaps.length}×)`,
        blockedReason: "duplicate-chapter",
      };
    }
    if (matchingCaps.length === 1) {
      const cap = matchingCaps[0]!;
      const trecho = err.trechoOriginal?.trim();

      // Tenta janela cirúrgica primeiro (caminho rápido pra erros com âncora).
      if (trecho) {
        const window = findTrechoWindow(cap.content, trecho);
        if (window.found) {
          return {
            kind: "window",
            chapters: [cap],
            content: window.content,
            label: `janela em Cap. ${err.capitulo} da ${partLabel}`,
            windowStart: window.start,
            windowEnd: window.end,
            parentChapter: cap,
          };
        }
      }

      // Sem âncora ou janela não computável → cap inteiro com confirmação.
      return {
        kind: "chapter",
        chapters: [cap],
        content: cap.content,
        label: `Cap. ${err.capitulo} da ${partLabel}`,
        requiresConfirmation: true,
      };
    }
  }

  // Sem âncora suficiente pra escopo cirúrgico — bloqueia em vez de escalar.
  return {
    kind: "blocked",
    chapters: [],
    content: "",
    label: "sem âncora de capítulo",
    blockedReason: "no-chapter-anchor",
  };
}

/**
 * Aplica uma ou mais sugestões NO MESMO ESCOPO via Opus (uma chamada
 * só), via /api/escrita-apply-suggestion. O endpoint instrui o modelo
 * a aplicar todas as sugestões da lista no trecho recebido.
 *
 * onChunk: callback chamado a cada pedaço do stream (pra mostrar liveStream).
 */
export async function applySuggestionsToScope(params: {
  scope: ApplyScope;
  errors: RevisorError[];
  /** Roteiro inteiro (precisa pra reconstruir após aplicar o escopo). */
  fullEscritaContent: string;
  fullChapters: EscritaChapter[];
  /** Cânone de Entidades — se presente, vai como referência canônica e o
   *  endpoint instrui o modelo a NÃO trocar nomes/idades/lugares/datas ao
   *  aplicar as sugestões. Sem isso, a expansão pode inventar variantes. */
  canone?: string;
  signal?: AbortSignal;
  onChunk?: (acc: string) => void;
}): Promise<SuggestionApplyResult> {
  const { scope, errors, fullEscritaContent, fullChapters, canone, signal, onChunk } =
    params;

  if (errors.length === 0) return { applied: false };
  if (scope.kind === "blocked") return { applied: false };

  const suggestions = errors
    .map((err) => {
      const sug = err.trechoCorrigido?.trim() || err.porqueAlterado?.trim();
      return sug
        ? {
            numero: err.numero,
            titulo: err.titulo || `Erro #${err.numero}`,
            sugestao: sug,
            porqueAlterado: err.porqueAlterado,
            gravidade: err.gravidade,
            trechoOriginal: err.trechoOriginal?.trim() || undefined,
          }
        : null;
    })
    .filter((s): s is NonNullable<typeof s> => !!s);

  if (suggestions.length === 0) return { applied: false };

  let res: Response;
  try {
    res = await fetch("/api/escrita-apply-suggestion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        escritaContent: scope.content,
        scopeKind: scope.kind,
        scopeLabel: scope.label,
        suggestions,
        ...(canone?.trim() ? { canone } : {}),
      }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { applied: false };
    }
    console.warn(`[apply-suggestion] fetch falhou:`, e);
    return { applied: false };
  }

  if (!res.ok || !res.body) {
    console.warn(`[apply-suggestion] HTTP ${res.status}`);
    return { applied: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    onChunk?.(acc);
  }

  const newScopeContent = acc.trim();
  if (!newScopeContent || newScopeContent.includes("[ERRO]")) {
    console.warn(`[apply-suggestion] Stream vazio/erro`);
    return { applied: false };
  }

  const now = new Date().toISOString();

  // Texto da instrução que pode ser ecoado pelo modelo. Usado pra detectar
  // quando o Opus copia o briefing literal em vez de aplicar a sugestão.
  // Concatena título + sugestão + porqueAlterado de todos os erros.
  const triggerText = suggestions
    .map((s) =>
      [s.titulo, s.sugestao, s.porqueAlterado].filter(Boolean).join(" "),
    )
    .join("\n");

  /**
   * Valida um cap reparseado contra o original correspondente em fullChapters.
   * Retorna o validation result do helper canônico.
   */
  const validateAgainstOriginal = (
    reparsed: EscritaChapter,
    original: EscritaChapter | undefined,
  ) => {
    if (!original) {
      return {
        ok: false as const,
        reason: "too-short" as const,
        message: `Cap ${reparsed.number} sem correspondente original.`,
      };
    }
    return validateRewrite({
      newContent: reparsed.content,
      originalContent: original.content,
      triggerText,
    });
  };

  let newFullContent: string;
  let newChapters: EscritaChapter[];

  if (scope.kind === "window") {
    if (
      !scope.parentChapter ||
      typeof scope.windowStart !== "number" ||
      typeof scope.windowEnd !== "number"
    ) {
      console.warn(`[apply-suggestion] window scope sem parentChapter/offsets`);
      return { applied: false };
    }
    // Valida APENAS a janela contra o trecho original (50-200%).
    const windowValidation = validateRewrite({
      newContent: newScopeContent,
      originalContent: scope.content,
      triggerText,
    });
    if (!windowValidation.ok) {
      console.warn(
        `[apply-suggestion] window validação falhou: ${windowValidation.reason}`,
      );
      return {
        applied: false,
        validationFailed: true,
        validationMessage:
          windowValidation.message ??
          "A IA devolveu uma resposta inesperada — texto original mantido.",
      };
    }
    // Detecta no-op: Opus devolveu a janela quase idêntica ao input. Sem isso,
    // o card mostraria "APLICADO" mas o texto continuaria igual. Acontece quando
    // Opus interpreta a sugestão como "preservar tudo" e só re-emite o input.
    if (isNoOpRewrite(scope.content, newScopeContent)) {
      console.warn(`[apply-suggestion] window: Opus devolveu input intacto (no-op)`);
      return {
        applied: false,
        validationFailed: true,
        validationMessage:
          "O Opus devolveu o trecho sem aplicar a correção. Tente regenerar a revisão ou edite manualmente no Step 4.",
      };
    }
    // Splice na janela: troca apenas content.slice(windowStart, windowEnd).
    const parent = scope.parentChapter;
    const newCapContent =
      parent.content.slice(0, scope.windowStart) +
      newScopeContent +
      parent.content.slice(scope.windowEnd);
    const idx = fullChapters.findIndex(
      (c) => c.part === parent.part && c.number === parent.number,
    );
    if (idx === -1) {
      console.warn(`[apply-suggestion] window: cap pai não achado em fullChapters`);
      return { applied: false };
    }
    const updated = [...fullChapters];
    updated[idx] = {
      ...parent,
      content: newCapContent,
      edited: true,
      editedAt: now,
    };
    newChapters = updated;
    newFullContent = concatenateChapters(updated);
  } else if (scope.kind === "full") {
    const reparsed = parseEscritaChaptersDirect(newScopeContent);
    if (reparsed.length === 0) {
      // Sem capítulos parseáveis — não dá pra validar individualmente. Trata
      // como roteiro monolítico e roda só os checks de tamanho/eco no todo.
      const validation = validateRewrite({
        newContent: newScopeContent,
        originalContent: scope.content,
        triggerText,
      });
      if (!validation.ok) {
        console.warn(
          `[apply-suggestion] full sem caps + validação falhou: ${validation.reason}`,
        );
        return {
          applied: false,
          validationFailed: true,
          validationMessage:
            validation.message ??
            "A IA devolveu uma resposta inesperada — texto original mantido.",
        };
      }
      newFullContent = newScopeContent;
      newChapters = fullChapters;
    } else {
      // Valida cada cap reparseado contra seu original. Qualquer falha
      // invalida a aplicação inteira (evita salvar metade lixo).
      for (const r of reparsed) {
        const original = fullChapters.find(
          (c) => c.part === r.part && c.number === r.number,
        );
        const v = validateAgainstOriginal(r, original);
        if (!v.ok) {
          console.warn(
            `[apply-suggestion] full Cap ${r.number} ${r.part}: ${v.reason} — abortando aplicação. ${v.message ?? ""}`,
          );
          return {
            applied: false,
            validationFailed: true,
            validationMessage:
              v.message ??
              "A IA devolveu uma resposta inesperada — texto original mantido.",
          };
        }
      }
      newFullContent = newScopeContent;
      newChapters = reparsed;
    }
  } else if (scope.kind === "part") {
    const reparsedPart = parseEscritaChaptersDirect(newScopeContent);
    if (reparsedPart.length === 0) {
      console.warn(`[apply-suggestion] Não consegui reparsear a Parte`);
      return { applied: false };
    }
    const fallbackPart = scope.chapters[0]?.part;
    // Valida cada cap reparseado da Parte contra o original em scope.chapters.
    for (const r of reparsedPart) {
      const partOfR = r.part ?? fallbackPart;
      const original = scope.chapters.find(
        (c) => c.part === partOfR && c.number === r.number,
      );
      const v = validateAgainstOriginal(r, original);
      if (!v.ok) {
        console.warn(
          `[apply-suggestion] part Cap ${r.number} ${partOfR}: ${v.reason} — abortando aplicação. ${v.message ?? ""}`,
        );
        return {
          applied: false,
          validationFailed: true,
          validationMessage:
            v.message ??
            "A IA devolveu uma resposta inesperada — texto original mantido.",
        };
      }
    }
    const reparsedWithPart: EscritaChapter[] = reparsedPart.map((r) => ({
      ...r,
      part: r.part ?? fallbackPart,
      edited: true,
      editedAt: now,
    }));
    const firstIdx = fullChapters.findIndex((c) => c.part === fallbackPart);
    let lastIdx = -1;
    fullChapters.forEach((c, i) => {
      if (c.part === fallbackPart) lastIdx = i;
    });
    if (firstIdx === -1 || lastIdx === -1) {
      console.warn(`[apply-suggestion] Não localizei a Parte ${fallbackPart}`);
      return { applied: false };
    }
    const updated = [
      ...fullChapters.slice(0, firstIdx),
      ...reparsedWithPart,
      ...fullChapters.slice(lastIdx + 1),
    ];
    newChapters = updated;
    newFullContent = concatenateChapters(updated);
  } else {
    // chapter
    const reparsedScope = parseEscritaChaptersDirect(newScopeContent);
    if (reparsedScope.length === 0) {
      // Modelo às vezes devolve o conteúdo sem o header "# Capítulo N — Título"
      // (cap inteiro reescrito como prosa pura). Aceita como conteúdo do cap pai.
      if (scope.chapters.length !== 1) {
        console.warn(`[apply-suggestion] Não consegui reparsear o capítulo`);
        return { applied: false };
      }
      const parent = scope.chapters[0]!;
      const validation = validateRewrite({
        newContent: newScopeContent,
        originalContent: parent.content,
        triggerText,
      });
      if (!validation.ok) {
        return {
          applied: false,
          validationFailed: true,
          validationMessage:
            validation.message ??
            "A IA devolveu uma resposta inesperada — texto original mantido.",
        };
      }
      if (isNoOpRewrite(parent.content, newScopeContent)) {
        return {
          applied: false,
          validationFailed: true,
          validationMessage:
            "O Opus devolveu o capítulo sem aplicar a correção. Tente regenerar a revisão ou edite manualmente no Step 4.",
        };
      }
      const idx = fullChapters.findIndex(
        (c) => c.part === parent.part && c.number === parent.number,
      );
      if (idx === -1) return { applied: false };
      const updated = [...fullChapters];
      updated[idx] = {
        ...parent,
        content: newScopeContent,
        edited: true,
        editedAt: now,
      };
      newChapters = updated;
      newFullContent = concatenateChapters(updated);
    } else {
      const fallbackPart = scope.chapters[0]?.part;
      const updated = [...fullChapters];
      for (const r of reparsedScope) {
        const partOfR = r.part ?? fallbackPart;
        const idx = updated.findIndex(
          (c) => c.part === partOfR && c.number === r.number,
        );
        if (idx >= 0) {
          const v = validateAgainstOriginal(r, updated[idx]);
          if (!v.ok) {
            console.warn(
              `[apply-suggestion] chapter Cap ${r.number} ${partOfR}: ${v.reason} — abortando aplicação. ${v.message ?? ""}`,
            );
            return {
              applied: false,
              validationFailed: true,
              validationMessage:
                v.message ??
                "A IA devolveu uma resposta inesperada — texto original mantido.",
            };
          }
          updated[idx] = {
            ...updated[idx]!,
            content: r.content,
            title: r.title ?? updated[idx]!.title,
            edited: true,
            editedAt: now,
          };
        }
      }
      newChapters = updated;
      newFullContent = concatenateChapters(updated);
    }
  }

  // Suprime warnings sobre fullEscritaContent (só usado pra futura extensão).
  void fullEscritaContent;

  // Última defesa: se NADA mudou no roteiro inteiro (todos os caps idênticos
  // após normalização), bloqueia. Salva o usuário do bug "APLICADO sem efeito"
  // independente de qual branch acima rodou.
  if (isNoOpRewrite(fullEscritaContent, newFullContent)) {
    return {
      applied: false,
      validationFailed: true,
      validationMessage:
        "A reescrita não produziu mudança detectável no roteiro. Tente regenerar a revisão ou edite manualmente no Step 4.",
    };
  }

  return {
    applied: true,
    newContent: newFullContent,
    newChapters,
  };
}

/**
 * Wrapper compatível com o call-site antigo do botão manual:
 * aplica UMA sugestão, calcula escopo internamente.
 */
export async function applySuggestionToScope(params: {
  error: RevisorError;
  escritaContent: string;
  chapters: EscritaChapter[];
  /** Cânone de Entidades — repassado pro endpoint pra preservar nomes/datas/
   *  lugares na reescrita. Opcional (roteiros legados sem cânone). */
  canone?: string;
  signal?: AbortSignal;
  onChunk?: (acc: string) => void;
}): Promise<
  SuggestionApplyResult & {
    scopeLabel: string;
    scopeKind: ScopeKind;
    blockedReason?: BlockedReason;
    requiresConfirmation?: boolean;
  }
> {
  const scope = computeApplyScope(
    params.error,
    params.escritaContent,
    params.chapters,
  );
  if (scope.kind === "blocked") {
    return {
      applied: false,
      scopeLabel: scope.label,
      scopeKind: scope.kind,
      blockedReason: scope.blockedReason,
    };
  }
  const result = await applySuggestionsToScope({
    scope,
    errors: [params.error],
    fullEscritaContent: params.escritaContent,
    fullChapters: params.chapters,
    canone: params.canone,
    signal: params.signal,
    onChunk: params.onChunk,
  });
  return {
    ...result,
    scopeLabel: scope.label,
    scopeKind: scope.kind,
    requiresConfirmation: scope.requiresConfirmation,
  };
}

/**
 * Variante "preview-only" do `computeApplyScope` pra UI: a UI pode chamar
 * antes de clicar pra saber se vai mostrar modal de confirmação, banner de
 * bloqueio, ou aplicar direto. Sem side effects.
 */
export function previewApplyScope(
  err: RevisorError,
  escritaContent: string,
  chapters: EscritaChapter[],
): {
  kind: ScopeKind;
  label: string;
  requiresConfirmation: boolean;
  blockedReason?: BlockedReason;
} {
  const s = computeApplyScope(err, escritaContent, chapters);
  return {
    kind: s.kind,
    label: s.label,
    requiresConfirmation: !!s.requiresConfirmation,
    blockedReason: s.blockedReason,
  };
}

/**
 * Filtro: erros que precisam ser aplicados via Opus em vez de find+replace
 * (transversais, sem trecho_original literal).
 */
export function isInformativoError(e: RevisorError): boolean {
  return !e.trechoOriginal?.trim() || !e.trechoCorrigido?.trim();
}
