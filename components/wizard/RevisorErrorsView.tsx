"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  AlertTriangle,
  Wand2,
  Loader2,
  Sparkles,
  Layers,
} from "lucide-react";
import type { RevisorError } from "@/types/roteiro";
import {
  findTrechoInText,
  gravityLabel,
  hashEscritaContent,
  inferPartFromContent,
} from "@/lib/parse-revisor-output";
import {
  applySuggestionToScope,
  isInformativoError,
  previewApplyScope,
  type BlockedReason,
  type ScopeKind,
} from "@/lib/apply-suggestion";
import { detectDuplicateChapters } from "@/lib/dedup-chapters";
import { useWizard } from "@/store/wizard";
import { cn } from "@/lib/utils";
import { ConfirmAiRewriteDialog } from "./ConfirmAiRewriteDialog";
import { countWords } from "@/lib/word-count";

interface Props {
  errors: RevisorError[];
  /** Hash do conteúdo da Escrita NO MOMENTO em que a revisão foi gerada. */
  escritaSnapshotHash?: string;
}

/**
 * Classifica um erro pela viabilidade de aplicação:
 *  - "literal": tem âncora literal no roteiro → find+replace síncrono.
 *  - "unmatched": tem trecho_original mas não casa (Revisor montou âncora
 *    fora de ordem ou misturou parágrafos descontíguos) → fallback IA.
 *  - "informativo": sem âncora ou sem correção; cai pro fallback IA se
 *    tiver trecho_corrigido descrevendo a ação, senão é manual.
 */
type ErrorKind = "literal" | "unmatched" | "informativo";

function classifyError(
  err: RevisorError,
  escritaContent: string,
): ErrorKind {
  const original = err.trechoOriginal?.trim();
  const fix = err.trechoCorrigido?.trim();
  if (!original || !fix) return "informativo";
  return findTrechoInText(escritaContent, original) ? "literal" : "unmatched";
}

const GRAVITY_CIRCLE: Record<RevisorError["gravidade"], string> = {
  naoInterfere: "bg-emerald-200 text-emerald-900",
  atencao: "bg-amber-200 text-amber-900",
  interfere: "bg-orange-200 text-orange-900",
  gravissimo: "bg-red-200 text-red-900",
};

const GRAVITY_PILL: Record<RevisorError["gravidade"], string> = {
  naoInterfere: "bg-emerald-100 text-emerald-900 border-emerald-300",
  atencao: "bg-amber-100 text-amber-900 border-amber-300",
  interfere: "bg-orange-100 text-orange-900 border-orange-300",
  gravissimo: "bg-red-100 text-red-900 border-red-300",
};

export function RevisorErrorsView({ errors, escritaSnapshotHash }: Props) {
  const applyOne = useWizard((s) => s.applyRevisorCorrection);
  const applyMany = useWizard((s) => s.applyRevisorCorrections);
  const applyViaAi = useWizard((s) => s.applyRevisorCorrectionViaAi);
  const dedupAction = useWizard((s) => s.dedupRevisorChapters);
  const escritaOutput = useWizard((s) => s.roteiro?.outputs.escrita);
  const canone = useWizard((s) => s.roteiro?.canone);
  const escritaContent = escritaOutput?.content ?? "";
  const escritaChapters = escritaOutput?.metadata?.chapters ?? [];

  // Grupos de capítulos duplicados na Escrita atual. Quando existe, a UI
  // mostra um banner no topo direcionando pra dedup determinístico — sem isso,
  // erros que tocam caps duplicados ficam bloqueados (ver scopeInfoMap abaixo).
  const duplicateGroups = useMemo(
    () => (escritaChapters.length > 0 ? detectDuplicateChapters(escritaChapters) : []),
    [escritaChapters],
  );

  // Modal de confirmação pra reescrita ampla (escopo "chapter" — erros sem
  // âncora cirúrgica). Lifted aqui em vez de em cada card pra simplificar e
  // permitir reuso futuro pelo "Aplicar todas pendentes".
  const [confirmingErrorId, setConfirmingErrorId] = useState<string | null>(null);
  // Após confirmação no modal, esse signal dispara o card a aplicar de fato.
  const [confirmedErrorIds, setConfirmedErrorIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Resposta da última dedup pra mostrar feedback "3 cópias removidas".
  const [dedupFeedback, setDedupFeedback] = useState<string | null>(null);

  const pendingErrors = useMemo(
    () => errors.filter((e) => !e.applied),
    [errors],
  );
  const appliedErrors = useMemo(
    () => errors.filter((e) => e.applied),
    [errors],
  );

  // Hash da Escrita: gate dos memos pesados (classifyError chama
  // findTrechoInText que faz indexOf em ~50-200K chars). Recalcula só quando
  // o roteiro muda de verdade — não a cada keystroke noutro lugar.
  const escritaHash = useMemo(
    () => (escritaContent ? hashEscritaContent(escritaContent) : ""),
    [escritaContent],
  );

  // Classifica cada erro pendente em literal/unmatched/informativo. Quando
  // não há roteiro, todos viram "informativo" (sem como casar âncora).
  const classifiedPending = useMemo(() => {
    if (!escritaContent) {
      return pendingErrors.map((err) => ({
        err,
        kind: "informativo" as ErrorKind,
      }));
    }
    return pendingErrors.map((err) => ({
      err,
      kind: classifyError(err, escritaContent),
    }));
    // escritaHash é proxy estável pra escritaContent (length+head+tail) — usar
    // ele em vez de escritaContent direto evita recalcular quando outro lugar
    // reescreve com mesmo conteúdo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingErrors, escritaHash, escritaContent === ""]);

  // Pendentes literais: aplicação síncrona via store.applyRevisorCorrections.
  const pendingLiteralIds = useMemo(
    () =>
      classifiedPending
        .filter((c) => c.kind === "literal")
        .map((c) => c.err.id),
    [classifiedPending],
  );
  // Pendentes que precisam de IA: unmatched + informativos com trechoCorrigido.
  // Informativos sem trechoCorrigido viram card sem botão (manual no Step 4).
  // Note: o filtro por scopeKind="window" acontece logo abaixo — só esses
  // entram no "Aplicar todas pendentes" (chapter scope exige confirmação
  // individual e não roda em batch).
  const pendingAiIdsAll = useMemo(
    () =>
      classifiedPending
        .filter(
          (c) =>
            c.kind === "unmatched" ||
            (c.kind === "informativo" && !!c.err.trechoCorrigido?.trim()),
        )
        .map((c) => c.err.id),
    [classifiedPending],
  );

  // Para cada erro pendente, pré-calcula o tipo de escopo que vai ser usado
  // ao clicar em "Aplicar via IA". Permite que o card mostre:
  //   - "window" → botão normal (aplica direto, rápido)
  //   - "chapter" + requiresConfirmation → botão abre modal antes
  //   - "blocked" duplicate-chapter → desabilitado + aponta pro banner
  //   - "blocked" no-chapter-anchor → desabilitado + edição manual
  // Usamos escritaHash como gate pra não recomputar a cada keystroke.
  const scopeInfoById = useMemo(() => {
    const map = new Map<
      string,
      {
        kind: ScopeKind;
        requiresConfirmation: boolean;
        blockedReason?: BlockedReason;
        label: string;
      }
    >();
    if (!escritaContent || escritaChapters.length === 0) return map;
    for (const { err } of classifiedPending) {
      // Só pré-calculamos pra erros que de fato vão pro caminho IA.
      const willGoToAi = !findTrechoInText(escritaContent, err.trechoOriginal ?? "");
      if (!willGoToAi) continue;
      const info = previewApplyScope(err, escritaContent, escritaChapters);
      map.set(err.id, info);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifiedPending, escritaHash, escritaChapters]);

  // Para o "Aplicar todas pendentes" — só os de escopo "window" rodam em
  // batch. Os que exigem confirmação (chapter) ou estão bloqueados (dedup
  // pendente) precisam de ação individual.
  const pendingAiIds = useMemo(
    () =>
      pendingAiIdsAll.filter((id) => {
        const info = scopeInfoById.get(id);
        // Sem info = sem escrita; será desabilitado no card.
        if (!info) return false;
        return info.kind === "window";
      }),
    [pendingAiIdsAll, scopeInfoById],
  );

  const escritaChangedSinceRevisor = useMemo(() => {
    if (!escritaSnapshotHash || !escritaContent) return false;
    return escritaHash !== escritaSnapshotHash;
  }, [escritaSnapshotHash, escritaContent, escritaHash]);

  // Callback estável: sem useCallback, cada render do RevisorErrorsView criava
  // 20-50 funções novas (uma por error), invalidando a memoização do ErrorCard
  // e re-renderizando todos a cada keystroke/tick.
  const handleApplyOne = useCallback(
    (errorId: string) => applyOne(errorId),
    [applyOne],
  );

  /**
   * Aplica UM erro via IA (Opus em escopo cirúrgico). Usado tanto pelo botão
   * individual do card quanto pelo loop sequencial do "Aplicar todas pendentes".
   * O caller passa um onChunk pra streaming preview no card. Retorna
   * { applied, validationFailed?, validationMessage? } pra UI atualizar
   * estado local.
   */
  const handleApplyOneViaAi = useCallback(
    async (
      errorId: string,
      onChunk?: (acc: string) => void,
      signal?: AbortSignal,
      opts?: { confirmed?: boolean },
    ) => {
      const err = errors.find((e) => e.id === errorId);
      if (!err || !escritaContent) return { applied: false };

      // Bloqueio explícito: escopo sem âncora ou com duplicatas → não chama
      // Opus. Card mostra mensagem clara pedindo dedup ou edição manual.
      const preview = previewApplyScope(err, escritaContent, escritaChapters);
      if (preview.kind === "blocked") {
        return {
          applied: false,
          validationFailed: true,
          validationMessage:
            preview.blockedReason === "duplicate-chapter"
              ? "Capítulos duplicados detectados — remova as duplicatas no banner do topo antes de aplicar."
              : "Não foi possível identificar o capítulo do erro. Edite manualmente no Step 4.",
        };
      }
      // Reescrita ampla (cap inteiro) exige confirmação prévia. Sem isso,
      // o caller (card) deve abrir o modal e re-chamar com {confirmed:true}.
      if (preview.requiresConfirmation && !opts?.confirmed) {
        setConfirmingErrorId(errorId);
        return { applied: false, validationFailed: false, requiresConfirmation: true };
      }

      const result = await applySuggestionToScope({
        error: err,
        escritaContent,
        chapters: escritaChapters,
        canone,
        signal,
        onChunk,
      });
      if (result.applied && result.newContent && result.newChapters) {
        applyViaAi(errorId, result.newContent, result.newChapters);
      }
      return result;
    },
    [errors, escritaContent, escritaChapters, canone, applyViaAi],
  );

  const handleDedup = useCallback(() => {
    const r = dedupAction();
    if (r.removedCount === 0) {
      setDedupFeedback("Nenhuma duplicata para remover.");
      return;
    }
    const parts = r.groups
      .map((g) => `Cap. ${g.number}${g.part ? ` (${g.part})` : ""} ×${g.copiesRemoved}`)
      .join(", ");
    setDedupFeedback(
      `${r.removedCount} cópia${r.removedCount === 1 ? "" : "s"} removida${r.removedCount === 1 ? "" : "s"}: ${parts}.`,
    );
  }, [dedupAction]);

  const confirmingError = useMemo(
    () => (confirmingErrorId ? errors.find((e) => e.id === confirmingErrorId) : null),
    [confirmingErrorId, errors],
  );
  const confirmingScope = confirmingError
    ? scopeInfoById.get(confirmingError.id)
    : undefined;
  const confirmingChapter = useMemo(() => {
    if (!confirmingError) return null;
    return (
      escritaChapters.find(
        (c) =>
          (confirmingError.parte === 1 ? "Parte 1" : confirmingError.parte === 2 ? "Parte 2" : c.part) === c.part &&
          c.number === confirmingError.capitulo,
      ) ?? null
    );
  }, [confirmingError, escritaChapters]);
  const confirmingApproxWords = confirmingChapter
    ? countWords(confirmingChapter.content)
    : undefined;

  // Mapa errorId → kind, pra cada ErrorCard saber qual variante renderizar
  // sem reclassificar.
  const kindById = useMemo(() => {
    const map = new Map<string, ErrorKind>();
    for (const c of classifiedPending) map.set(c.err.id, c.kind);
    return map;
  }, [classifiedPending]);

  if (errors.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
        <CheckCircle2 className="size-6 mx-auto text-emerald-600 mb-2" />
        <p className="text-sm text-muted-foreground">
          Nenhum erro estruturado foi extraído da revisão. O agente pode não ter
          gerado o bloco <code>&lt;erros_detalhados&gt;</code> — gere a revisão
          de novo se quiser usar a correção automática.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">
            {errors.length} erro{errors.length === 1 ? "" : "s"} estruturado
            {errors.length === 1 ? "" : "s"}
          </span>
          {appliedErrors.length > 0 && (
            <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 font-normal gap-1">
              <CheckCircle2 className="size-3" />
              {appliedErrors.length} aplicado
              {appliedErrors.length === 1 ? "" : "s"}
            </Badge>
          )}
          {pendingErrors.length > 0 && (
            <Badge variant="outline" className="font-normal">
              {pendingErrors.length} pendente
              {pendingErrors.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        {pendingLiteralIds.length + pendingAiIds.length > 1 && escritaContent && (
          <ApplyAllButton
            literalIds={pendingLiteralIds}
            aiIds={pendingAiIds}
            onApplyMany={(ids) =>
              applyMany(ids, "Antes de aplicar todas as correções pendentes")
            }
            onApplyOneViaAi={handleApplyOneViaAi}
          />
        )}
      </div>

      {!escritaContent && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-700 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-900 leading-relaxed">
            O Step 4 (Escrita) está vazio — sem roteiro, não dá pra aplicar
            correção automática. Volte ao Step 4 e gere o roteiro antes.
          </p>
        </div>
      )}

      {duplicateGroups.length > 0 && (
        <div className="rounded-md border-2 border-amber-400 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <Layers className="size-5 text-amber-700 mt-0.5 shrink-0" />
          <div className="flex flex-col gap-2 flex-1 min-w-0">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-amber-900 uppercase tracking-wide">
                Capítulos duplicados detectados
              </span>
              <span className="text-xs text-amber-900 leading-relaxed">
                {duplicateGroups
                  .map(
                    (g) =>
                      `Cap. ${g.number}${g.part ? ` da ${g.part}` : ""} aparece ${g.indices.length}×`,
                  )
                  .join(" · ")}
                . Resolva as duplicatas antes de aplicar correções via IA —
                manter várias cópias confunde o escopo da reescrita.
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
                onClick={handleDedup}
                title="Mantém a versão mais longa de cada capítulo duplicado. Sem IA — instantâneo."
              >
                <Layers className="size-4" />
                Remover duplicatas (manter a mais longa)
              </Button>
              {dedupFeedback && (
                <span className="text-[11px] text-amber-900 leading-snug">
                  {dedupFeedback}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {escritaChangedSinceRevisor && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="size-4 text-amber-700 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-900 leading-relaxed">
            O roteiro do Step 4 foi editado depois desta revisão. Quando a
            substituição literal não encontra o trecho âncora, a UI cai pro
            fallback &quot;Aplicar via IA&quot; — o Opus reescreve só uma
            janela de ~5 parágrafos ao redor do trecho, mantendo o resto do
            capítulo intacto.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {errors.map((err) => {
          // Fallback: se o agente não emitiu `parte` no XML (revisões
          // antigas), tenta inferir buscando o trecho no roteiro.
          const parte =
            err.parte ?? inferPartFromContent(escritaContent, err.trechoOriginal);
          const enrichedErr = parte ? { ...err, parte } : err;
          // Aplicados não têm kind no map; lê o kind ou cai pro default
          // "literal" (irrelevante quando applied=true).
          const kind: ErrorKind = err.applied
            ? "literal"
            : kindById.get(err.id) ?? "informativo";
          const scopeInfo = scopeInfoById.get(err.id);
          return (
            <ErrorCard
              key={err.id}
              error={enrichedErr}
              kind={kind}
              disabled={!escritaContent}
              onApply={handleApplyOne}
              onApplyViaAi={handleApplyOneViaAi}
              scopeKind={scopeInfo?.kind}
              scopeBlockedReason={scopeInfo?.blockedReason}
              scopeRequiresConfirmation={scopeInfo?.requiresConfirmation}
              autoConfirm={confirmedErrorIds.has(err.id)}
              onAutoConfirmConsumed={() =>
                setConfirmedErrorIds((prev) => {
                  const next = new Set(prev);
                  next.delete(err.id);
                  return next;
                })
              }
            />
          );
        })}
      </div>

      <ConfirmAiRewriteDialog
        open={!!confirmingErrorId}
        scopeLabel={confirmingScope?.label ?? "capítulo afetado"}
        approxWords={confirmingApproxWords}
        errorTitle={confirmingError?.titulo}
        onConfirm={() => {
          if (!confirmingErrorId) return;
          const id = confirmingErrorId;
          setConfirmedErrorIds((prev) => new Set(prev).add(id));
          setConfirmingErrorId(null);
        }}
        onCancel={() => setConfirmingErrorId(null)}
      />
    </div>
  );
}

/**
 * Aplica todas pendentes em duas etapas:
 *  1. Literais: 1 chamada síncrona ao store (instantâneo, igual antes).
 *  2. IA (unmatched + informativos): loop SEQUENCIAL chamando Opus pra
 *     cada erro, um por vez. Sequencial pra não estourar rate-limit em
 *     roteiros com muitos fallbacks. Erros que falham validação ficam
 *     contabilizados em `failed` e podem ser reaplicados manualmente.
 */
function ApplyAllButton({
  literalIds,
  aiIds,
  onApplyMany,
  onApplyOneViaAi,
}: {
  literalIds: string[];
  aiIds: string[];
  onApplyMany: (ids: string[]) => { applied: string[]; failed: string[] };
  onApplyOneViaAi: (
    errorId: string,
    onChunk?: (acc: string) => void,
    signal?: AbortSignal,
  ) => Promise<{ applied: boolean; validationFailed?: boolean }>;
}) {
  const total = literalIds.length + aiIds.length;
  const [pending, setPending] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [feedback, setFeedback] = useState<{
    applied: number;
    failed: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handle = async () => {
    setPending(true);
    setFeedback(null);
    setAiProgress(0);
    abortRef.current = new AbortController();

    let applied = 0;
    let failed = 0;

    // Etapa 1: literais síncronos.
    if (literalIds.length > 0) {
      const result = onApplyMany(literalIds);
      applied += result.applied.length;
      failed += result.failed.length;
    }

    // Etapa 2: IA sequencial.
    for (let i = 0; i < aiIds.length; i++) {
      if (abortRef.current.signal.aborted) {
        failed += aiIds.length - i;
        break;
      }
      setAiProgress(i + 1);
      try {
        const r = await onApplyOneViaAi(
          aiIds[i]!,
          undefined,
          abortRef.current.signal,
        );
        if (r.applied) applied++;
        else failed++;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") {
          failed += aiIds.length - i;
          break;
        }
        failed++;
      }
    }

    setFeedback({ applied, failed });
    setPending(false);
    setAiProgress(0);
    abortRef.current = null;
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="flex items-center gap-2">
      {feedback && (
        <span className="text-[11px] text-muted-foreground">
          {feedback.applied > 0 && `${feedback.applied} aplicada(s)`}
          {feedback.applied > 0 && feedback.failed > 0 && " · "}
          {feedback.failed > 0 && `${feedback.failed} falhada(s)`}
        </span>
      )}
      {pending && aiIds.length > 0 && (
        <span className="text-[11px] text-muted-foreground">
          Via IA: {aiProgress}/{aiIds.length}
        </span>
      )}
      {pending ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleCancel}
          className="gap-2"
        >
          <Loader2 className="size-3 animate-spin" />
          Cancelar
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handle}
          className="gap-2"
          title={
            aiIds.length > 0
              ? `Aplica ${literalIds.length} literais imediato + ${aiIds.length} via IA (Opus, sequencial)`
              : `Aplica de uma vez todas as ${total} correções pendentes`
          }
        >
          <Wand2 className="size-3" />
          Aplicar todas pendentes ({total})
        </Button>
      )}
    </div>
  );
}

interface CardProps {
  error: RevisorError;
  /** Classificação do erro pendente: define qual fluxo de aplicação roda. */
  kind: ErrorKind;
  disabled: boolean;
  // Recebe o id do erro pra que o parent possa passar um único callback
  // memoizado para todos os cards (sem `() => applyOne(err.id)` por render).
  onApply: (errorId: string) => { applied: boolean; found: boolean };
  /** Fallback IA (Opus em escopo cirúrgico) — usado quando kind=unmatched
   *  ou kind=informativo (com trecho_corrigido). Stream de chunks via onChunk
   *  pra preview ao vivo no card. */
  onApplyViaAi: (
    errorId: string,
    onChunk?: (acc: string) => void,
    signal?: AbortSignal,
    opts?: { confirmed?: boolean },
  ) => Promise<{
    applied: boolean;
    validationFailed?: boolean;
    validationMessage?: string;
    requiresConfirmation?: boolean;
  }>;
  /** Tipo de escopo pré-calculado pelo parent (window/chapter/blocked). */
  scopeKind?: ScopeKind;
  /** Motivo do bloqueio (duplicate-chapter / no-chapter-anchor). */
  scopeBlockedReason?: BlockedReason;
  /** Se true, clicar em "Aplicar via IA" abre o modal de confirmação primeiro. */
  scopeRequiresConfirmation?: boolean;
  /** Setado pelo parent quando a usuária aprovou no modal — dispara aplicação. */
  autoConfirm?: boolean;
  /** Callback pra parent limpar o flag autoConfirm depois de consumido. */
  onAutoConfirmConsumed?: () => void;
}

/**
 * Detecta se uma correção é de INSERÇÃO (técnica do âncora): o trecho_corrigido
 * começa idêntico ao trecho_original e adiciona conteúdo novo logo depois.
 * Diferenciar isso de uma SUBSTITUIÇÃO normal muda o tom da UI — inserção é
 * aditiva (não destrói nada), substituição troca um trecho por outro.
 */
function detectInsertion(
  err: RevisorError,
): { kind: "insertion"; addedText: string } | { kind: "replacement" } | null {
  const orig = err.trechoOriginal?.trim();
  const fix = err.trechoCorrigido?.trim();
  if (!orig || !fix) return null;
  if (fix.startsWith(orig) && fix.length > orig.length + 20) {
    return { kind: "insertion", addedText: fix.slice(orig.length).trimStart() };
  }
  return { kind: "replacement" };
}

// memo: lista de 20-50 cards. Sem isso, qualquer re-render do parent
// (typing num textarea próximo, tick de timer) reconciliava todos os cards.
const ErrorCard = memo(function ErrorCard({
  error,
  kind,
  disabled,
  onApply,
  onApplyViaAi,
  scopeKind,
  scopeBlockedReason,
  scopeRequiresConfirmation,
  autoConfirm,
  onAutoConfirmConsumed,
}: CardProps) {
  const { emoji, label } = gravityLabel(error.gravidade);
  const [pending, startTransition] = useTransition();
  const [localFailed, setLocalFailed] = useState(false);

  // Estados pro fluxo "Aplicar via IA": streaming preview + erro de validação.
  const [aiPending, setAiPending] = useState(false);
  const [aiPreview, setAiPreview] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  // Caminho raro: modelo não obedeceu o prompt e emitiu trecho vazio. Sem
  // âncora literal não dá pra fazer find+replace seguro — vira card informativo
  // sem botão de aplicar (a roteirista edita manualmente no Step 4).
  const isInformativo = isInformativoError(error);
  // Pode aplicar via IA quando: (a) tem âncora mas não casou (unmatched), ou
  // (b) é informativo MAS tem trecho_corrigido descrevendo a ação. Sem
  // trecho_corrigido o Opus não tem instrução pra aplicar. Adicionalmente,
  // o escopo NÃO pode estar bloqueado (duplicatas / sem âncora de capítulo).
  const isBlocked = scopeKind === "blocked";
  const canApplyViaAi =
    !error.applied &&
    !!error.trechoCorrigido?.trim() &&
    (kind === "unmatched" || kind === "informativo") &&
    !isBlocked;
  const variant = useMemo(() => detectInsertion(error), [error]);
  const isInsertion = variant?.kind === "insertion";

  // Convenção: o Revisor começa <por_que_alterado> com "AVISO: " quando a
  // correção é parcial / o problema se repete em outros pontos / a roteirista
  // precisa revisar manualmente. A UI destaca isso pra ela não perder.
  const avisoText = useMemo(() => {
    const txt = error.porqueAlterado?.trim();
    if (!txt) return null;
    const m = txt.match(/^aviso\s*:\s*([\s\S]+)/i);
    return m ? m[1].trim() : null;
  }, [error.porqueAlterado]);
  const hasAviso = !!avisoText;

  const handleApply = () => {
    setLocalFailed(false);
    startTransition(() => {
      const result = onApply(error.id);
      if (!result.applied) setLocalFailed(true);
    });
  };

  const handleApplyViaAi = useCallback(
    async (opts?: { confirmed?: boolean }) => {
      setAiError(null);
      setAiPreview("");
      // Quando o parent ainda vai abrir o modal, NÃO mostramos spinner —
      // a aplicação só começa depois da confirmação.
      const willOpenModal =
        scopeRequiresConfirmation && !opts?.confirmed;
      if (!willOpenModal) setAiPending(true);
      aiAbortRef.current = new AbortController();
      try {
        const result = await onApplyViaAi(
          error.id,
          (acc) => setAiPreview(acc),
          aiAbortRef.current.signal,
          opts,
        );
        if (result.requiresConfirmation) {
          // Parent abriu o modal — esperamos autoConfirm voltar.
          setAiPending(false);
          return;
        }
        if (result.validationFailed) {
          setAiError(
            result.validationMessage ??
              "A IA devolveu uma resposta inesperada — texto original mantido.",
          );
        } else if (!result.applied) {
          setAiError(
            "Não foi possível aplicar a correção via IA. Tente novamente ou edite manualmente no Step 4.",
          );
        }
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") {
          setAiError(
            (e as Error)?.message ?? "Erro inesperado ao aplicar via IA.",
          );
        }
      } finally {
        if (!willOpenModal) setAiPending(false);
        aiAbortRef.current = null;
      }
    },
    [error.id, onApplyViaAi, scopeRequiresConfirmation],
  );

  const handleCancelAi = () => {
    aiAbortRef.current?.abort();
  };

  // Quando o parent sinaliza que a usuária confirmou no modal, dispara
  // a aplicação efetiva e limpa o flag pra evitar dispatch duplicado.
  useEffect(() => {
    if (autoConfirm && !aiPending) {
      onAutoConfirmConsumed?.();
      void handleApplyViaAi({ confirmed: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirm]);

  // Append "(Parte N)" no título se a parte é conhecida E o agente ainda
  // não colocou isso no titulo (alguns títulos já vêm com a info — não
  // queremos duplicar pra "...(Parte 2) (Parte 2)").
  const titleHasParte = /\(Parte\s+[12]\)/i.test(error.titulo ?? "");
  const tituloComParte =
    error.titulo && error.parte && !titleHasParte
      ? `${error.titulo} (Parte ${error.parte})`
      : error.titulo;
  const titleLabel = tituloComParte
    ? `Erro #${error.numero} — ${tituloComParte}`
    : `Erro #${error.numero}`;

  return (
    <details
      open={false}
      className={cn(
        "group rounded-lg border bg-card overflow-hidden transition",
        error.applied && "opacity-70",
      )}
    >
      <summary className="list-none cursor-pointer px-4 sm:px-5 py-3 flex items-center gap-3 bg-muted/30 hover:bg-muted/50 transition">
        <span
          className={cn(
            "size-8 rounded-full text-xs font-bold flex items-center justify-center shrink-0",
            GRAVITY_CIRCLE[error.gravidade],
          )}
        >
          {error.numero}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-serif text-base tracking-tight truncate">
            {titleLabel}
          </span>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded border uppercase tracking-wide",
                GRAVITY_PILL[error.gravidade],
              )}
            >
              {emoji} {label}
            </span>
            {typeof error.capitulo === "number" && (
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Cap. {error.capitulo}
              </span>
            )}
            {isInsertion && !error.applied && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide bg-sky-100 text-sky-900 border-sky-300">
                ✏️ Inserção
              </span>
            )}
            {hasAviso && !error.applied && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide bg-amber-100 text-amber-900 border-amber-400">
                ⚠ Aviso
              </span>
            )}
            {error.applied && (
              <Badge className="bg-emerald-100 text-emerald-900 border-emerald-400 font-semibold gap-1.5 text-[11px] px-2 py-0.5">
                <CheckCircle2 className="size-3.5" />
                APLICADO
                {error.appliedAt && (
                  <span className="font-normal normal-case opacity-80">
                    em {new Date(error.appliedAt).toLocaleString("pt-BR")}
                  </span>
                )}
              </Badge>
            )}
            {kind === "unmatched" && !error.applied && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wide bg-sky-100 text-sky-900 border-sky-300">
                ✨ Aplicar via IA
              </span>
            )}
            {localFailed && !error.applied && (
              <span className="text-[10px] text-amber-700 uppercase tracking-wide">
                trecho não encontrado
              </span>
            )}
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0 group-open:hidden">
          abrir
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0 hidden group-open:inline">
          recolher
        </span>
      </summary>

      <div className="px-4 sm:px-5 py-4 flex flex-col gap-4 border-t">
        {hasAviso && !error.applied && (
          <div className="rounded-md border-2 border-amber-400 bg-amber-50 px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle className="size-4 text-amber-700 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-amber-900 uppercase tracking-wide">
                Aviso da revisora
              </span>
              <span className="text-xs text-amber-900 leading-relaxed">
                {avisoText}
              </span>
            </div>
          </div>
        )}

        {isInsertion && !error.applied && (
          <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2.5 flex items-start gap-2">
            <Wand2 className="size-4 text-sky-700 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-sky-900 uppercase tracking-wide">
                Inserção de novo trecho
              </span>
              <span className="text-xs text-sky-900 leading-relaxed">
                Esta correção ADICIONA um trecho novo após a âncora abaixo, sem
                alterar nada do que já está escrito antes ou depois. Aplicar
                apenas insere o conteúdo novo no ponto certo.
                {typeof error.parte === "number" && typeof error.capitulo === "number" && (
                  <> Posição: Cap. {error.capitulo} da Parte {error.parte}.</>
                )}
              </span>
            </div>
          </div>
        )}

        {kind === "unmatched" && !error.applied && !isBlocked && (
          <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2.5 flex items-start gap-2">
            <Sparkles className="size-4 text-sky-700 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-sky-900 uppercase tracking-wide">
                Trecho âncora fora de sincronia
              </span>
              <span className="text-xs text-sky-900 leading-relaxed">
                {scopeKind === "window"
                  ? 'O Revisor montou o trecho âncora em ordem trocada, mas eu localizei a região afetada. Use "Aplicar via IA" abaixo — o Opus reescreve só uma janela de ~5 parágrafos ao redor do trecho, mantendo o resto do capítulo intacto.'
                  : 'O Revisor montou o trecho âncora em ordem trocada ou misturou parágrafos descontíguos, então a substituição literal não casa. Use "Aplicar via IA" abaixo — vai abrir uma confirmação porque o Opus precisa reescrever o capítulo inteiro.'}
              </span>
            </div>
          </div>
        )}

        {isBlocked && !error.applied && (
          <div className="rounded-md border-2 border-red-300 bg-red-50 px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle className="size-4 text-red-700 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-red-900 uppercase tracking-wide">
                {scopeBlockedReason === "duplicate-chapter"
                  ? "Aplicação bloqueada — capítulo duplicado"
                  : "Aplicação bloqueada — sem âncora de capítulo"}
              </span>
              <span className="text-xs text-red-900 leading-relaxed">
                {scopeBlockedReason === "duplicate-chapter"
                  ? "Este erro toca um capítulo que aparece mais de uma vez na Escrita. Use o botão \"Remover duplicatas\" no banner amarelo do topo antes de aplicar via IA — sem isso, a reescrita pegaria várias versões."
                  : 'O erro não identifica em qual capítulo a correção entra. Leia a sugestão abaixo e edite o roteiro manualmente no Step 4.'}
              </span>
            </div>
          </div>
        )}

        {isInformativo && !error.applied && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle className="size-4 text-amber-700 mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-bold text-amber-900 uppercase tracking-wide">
                {canApplyViaAi
                  ? "Sem trecho âncora — aplicar via IA"
                  : "Revisão manual necessária"}
              </span>
              <span className="text-xs text-amber-900 leading-relaxed">
                {canApplyViaAi
                  ? "A revisora não conseguiu propor um trecho literal. Use \"Aplicar via IA\" abaixo — o Opus reescreve o escopo afetado seguindo a sugestão."
                  : "A revisora não conseguiu propor um trecho literal pra aplicar automaticamente. Leia a sugestão abaixo e edite o roteiro manualmente no Step 4."}
              </span>
            </div>
          </div>
        )}

        {(aiPending || aiPreview) && !error.applied && (
          <div className="rounded-md border border-sky-300 bg-sky-50/60 px-3 py-2.5 flex flex-col gap-1.5">
            <span className="text-xs font-bold text-sky-900 uppercase tracking-wide flex items-center gap-2">
              {aiPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Reescrita via IA {aiPending ? "(em andamento)" : "(pronta)"}
            </span>
            {aiPreview && (
              <div className="text-[12px] text-sky-950/80 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {aiPreview.length > 2000
                  ? `…${aiPreview.slice(-2000)}`
                  : aiPreview}
              </div>
            )}
          </div>
        )}

        {aiError && !error.applied && (
          <div className="rounded-md border-2 border-red-400 bg-red-50 px-3 py-2.5 flex items-start gap-2">
            <AlertTriangle className="size-4 text-red-700 mt-0.5 shrink-0" />
            <span className="text-xs text-red-900 leading-relaxed">
              {aiError}
            </span>
          </div>
        )}

        {error.trechoOriginal?.trim() && (
          <Section
            label={
              isInsertion
                ? "📍 Trecho âncora (não muda — só serve pra localizar onde inserir)"
                : "📍 Trecho original"
            }
            content={error.trechoOriginal}
            tone="original"
          />
        )}
        {isInsertion && variant.addedText ? (
          <Section
            label="✏️ Texto a inserir após o âncora"
            content={variant.addedText}
            tone="fixed"
          />
        ) : (
          error.trechoCorrigido?.trim() && (
            <Section
              label={
                isInformativo ? "🛠️ Ação sugerida" : "✏️ Trecho corrigido"
              }
              content={error.trechoCorrigido}
              tone="fixed"
            />
          )
        )}
        {error.porqueAlterado && !hasAviso && (
          <Section
            label="💡 Por que foi alterado"
            content={error.porqueAlterado}
            tone="reason"
          />
        )}

        <div className="flex items-center gap-2 flex-wrap pt-1">
          {error.applied ? (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="gap-2 text-emerald-700"
            >
              <CheckCircle2 className="size-4" />
              Correção aplicada no roteiro
            </Button>
          ) : kind === "literal" ? (
            <Button
              size="sm"
              onClick={handleApply}
              disabled={disabled || pending}
              className="gap-2"
              title={
                disabled
                  ? "Gere o roteiro no Step 4 primeiro"
                  : isInsertion
                  ? "Insere o trecho novo após o âncora no roteiro do Step 4"
                  : "Substitui o trecho original pelo corrigido no roteiro do Step 4"
              }
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Wand2 className="size-4" />
              )}
              {pending
                ? "Aplicando…"
                : isInsertion
                ? "Inserir esse trecho"
                : "Aplicar essa correção"}
            </Button>
          ) : canApplyViaAi ? (
            aiPending ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelAi}
                className="gap-2"
              >
                <Loader2 className="size-4 animate-spin" />
                Cancelar
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => handleApplyViaAi()}
                disabled={disabled}
                className={cn(
                  "gap-2 text-white",
                  scopeRequiresConfirmation
                    ? "bg-amber-600 hover:bg-amber-700"
                    : "bg-sky-600 hover:bg-sky-700",
                )}
                title={
                  scopeRequiresConfirmation
                    ? "Sem trecho âncora cirúrgico — vai pedir confirmação porque o Opus reescreve o capítulo inteiro"
                    : "Opus reescreve só uma janela de ~5 parágrafos ao redor do trecho, mantendo o resto do capítulo intacto"
                }
              >
                <Sparkles className="size-4" />
                {scopeRequiresConfirmation ? "Aplicar via IA (reescreve cap)" : "Aplicar via IA"}
              </Button>
            )
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="gap-2 text-muted-foreground"
              title="Sem trecho âncora nem ação sugerida — edite manualmente no Step 4"
            >
              <AlertTriangle className="size-4" />
              Aplicar manualmente no Step 4
            </Button>
          )}
          {localFailed && !error.applied && (
            <span className="text-xs text-amber-800 leading-relaxed">
              O trecho âncora não foi encontrado no roteiro (mesmo com match
              tolerante). Tente &quot;Aplicar via IA&quot; ou regere a revisão.
            </span>
          )}
        </div>
      </div>
    </details>
  );
});

function Section({
  label,
  content,
  tone,
}: {
  label: string;
  content: string;
  tone: "original" | "fixed" | "reason";
}) {
  const toneClasses: Record<typeof tone, string> = {
    original: "border-l-amber-400 bg-amber-50/60 text-amber-950",
    fixed: "border-l-emerald-500 bg-emerald-50/60 text-emerald-950",
    reason: "border-l-primary/40 bg-primary/5 text-foreground",
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
        {label}
      </span>
      <div
        className={cn(
          "whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed border-l-2 pl-4 pr-3 py-2.5 rounded-r-md",
          toneClasses[tone],
        )}
      >
        {content}
      </div>
    </div>
  );
}
