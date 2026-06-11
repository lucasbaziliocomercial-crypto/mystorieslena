import { create } from "zustand";
import type {
  EscritaChapter,
  ProductionStepKey,
  RevisorError,
  Roteiro,
  RoteiroDrafts,
  RoteiroReferenceImage,
  StepGenerationSnapshot,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { STEP_ORDER, REVISOR_STEPS, isRevisorStep } from "@/types/roteiro";
import { scheduleSave, flushPendingSave, HISTORY_CAP } from "@/lib/storage";
import {
  applyCorrections,
  computeRevisorEval,
  stripXmlCruft,
} from "@/lib/parse-revisor-output";
import { appendEvalSnapshot } from "@/lib/eval-log";
import { accrueProductionTime } from "@/lib/production-time";
import { dedupChapters } from "@/lib/dedup-chapters";
import { concatenateChapters } from "@/lib/parse-escrita-output";
import { normalizeEscritaOutput } from "@/lib/normalize-escrita";

/**
 * Steps cujo `metadata.errors[]` alimenta os cards de correção 1-clique.
 * Hoje: revisor1, revisor2 (cada um escopado por Parte) + overview (varredura
 * estrutural sobre P1+P2 inteiros). As funções `applyRevisorCorrection*`
 * iteram esta lista pra encontrar o erro pelo id e marcar `applied: true` no
 * step de origem certo. Adicionar um novo step com cards = adicionar aqui.
 */
const ERROR_SOURCE_STEPS = [...REVISOR_STEPS, "overview"] as const;
type ErrorSourceStepKey = (typeof ERROR_SOURCE_STEPS)[number];

interface WizardState {
  roteiro: Roteiro | null;
  isGenerating: boolean;
  autoAdvance: boolean;
  /**
   * Texto sendo gerado AO VIVO por um job da fila em 2º plano, quando o roteiro
   * do job é o que está aberto. Transient (NÃO persiste no localStorage) — é só
   * o preview do stream. O QueueRunner alimenta via `setQueueLiveStream` (só pro
   * roteiro ativo) e limpa ao concluir/abortar. O foreground (StepShell) tem seu
   * próprio `liveStream` local e NÃO usa este campo.
   *
   * **Mapa por step** (chave = `job.step`): com revisor1 ‖ revisor2 rodando no
   * MESMO roteiro aberto, um campo único faria os dois previews se sobrescreverem
   * (o preview embaixo da Parte 1 mostrando texto da Parte 2). Cada step lê só a
   * sua chave (`queueLiveStream[step]`).
   */
  queueLiveStream: Record<string, string>;
  setQueueLiveStream: (step: string, text: string) => void;
  setRoteiro: (r: Roteiro) => void;
  setCurrentStep: (step: StepId) => void;
  setOutput: (step: StepId, output: StepOutput) => void;
  /**
   * Registra um eval de qualidade (conceito do Karpathy) no log append-only do
   * roteiro, derivado do relatório de revisão recém-gerado. Chamar SÓ na
   * conclusão de uma geração de revisão (não em refine/aplicar correção) — o log
   * é uma trilha de gerações, não de toda mutação. Dedup interno: re-commit
   * idêntico não anexa.
   */
  recordEval: (step: StepId, output: StepOutput) => void;
  /**
   * Acumula `elapsedMs` de geração ativa do `step` no cronômetro de produção do
   * roteiro (ver [ProductionTime]). Chamado pelo `QueueRunner` ao concluir cada
   * step (caminho do roteiro ATIVO; o caminho 2º plano grava direto no storage).
   * Só soma tempo de geração — nunca de pausa/edição.
   */
  recordProductionTime: (step: ProductionStepKey, elapsedMs: number) => void;
  updateOutputContent: (step: StepId, content: string) => void;
  /**
   * Salva o input/correção do step indicado. Cada step tem sua própria
   * caixa de "Instruções adicionais" — input escrito em Estrutura 1 NÃO
   * é enviado pra Escrita ou Revisor.
   */
  setUserInput: (step: StepId, input: string) => void;
  /**
   * Salva o rascunho de um textarea (não-commitado). Cada step tem seus
   * próprios campos (ver [RoteiroDrafts]). Strings vazias / só whitespace
   * deletam o draft em vez de salvar lixo. Usado pelo hook `useDraft` em
   * intervalos debounced — nunca chamar em todo keystroke direto.
   */
  setDraft: <S extends keyof RoteiroDrafts>(
    step: S,
    field: keyof NonNullable<RoteiroDrafts[S]>,
    value: string,
  ) => void;
  /**
   * Limpa o rascunho de um campo específico, ou de todos os campos do step
   * se `field` for omitido. Chamado depois que o valor vira oficial (botão
   * Gerar / Aplicar / Salvar).
   */
  clearDraft: <S extends keyof RoteiroDrafts>(
    step: S,
    field?: keyof NonNullable<RoteiroDrafts[S]>,
  ) => void;
  setReferenceImage: (image: RoteiroReferenceImage | null) => void;
  setTitle: (title: string) => void;
  setIsGenerating: (v: boolean) => void;
  setAutoAdvance: (v: boolean) => void;
  /** Salva o output atual do step no histórico (se houver conteúdo). */
  pushOutputToHistory: (step: StepId, customLabel?: string) => void;
  /** Restaura uma versão do histórico para o output atual.
   * O output atual (se existir) vai pro histórico antes da troca. */
  restoreFromHistory: (step: StepId, snapshotId: string) => void;
  /** Remove um snapshot do histórico. */
  deleteFromHistory: (step: StepId, snapshotId: string) => void;
  /**
   * Aplica correções do Revisor (find+replace) no output da Escrita.
   * Recebe IDs dos erros marcados — busca em metadata.errors do revisor,
   * pega trecho_original / trecho_corrigido e substitui no output.escrita
   * (com fuzzy fallback pra aspas curvas/travessões/whitespace).
   * Atualiza chapter.content também quando o erro tiver capítulo. Marca
   * cada erro aplicado em metadata.errors[].applied=true.
   *
   * `snapshotLabel` (opcional) sobrescreve o rótulo do snapshot da Escrita
   * criado antes de mexer — útil pra distinguir aplicação singular vs lote.
   *
   * Devolve { applied: ids[], failed: ids[] } pra UI exibir feedback.
   */
  applyRevisorCorrections: (
    errorIds: string[],
    snapshotLabel?: string,
  ) => {
    applied: string[];
    failed: string[];
  };
  /**
   * Aplica UMA única correção do Revisor (1 clique no card). Wrapper sobre
   * applyRevisorCorrections com snapshot rotulado pelo número do erro.
   * Devolve estado pontual pra UI atualizar o card específico.
   */
  applyRevisorCorrection: (errorId: string) => {
    applied: boolean;
    found: boolean;
  };
  /**
   * Commit do resultado de uma aplicação via IA (fallback Opus em escopo
   * cirúrgico). Usado quando o find+replace literal falha (trecho_original
   * fora de sincronia) ou quando o erro é informativo (sem âncora). Quem
   * gera os argumentos é o caminho `applySuggestionToScope` da UI — esta
   * action só recebe o conteúdo já reescrito + chapters atualizados,
   * tira snapshot da Escrita, atualiza output, e marca o erro como aplicado.
   */
  applyRevisorCorrectionViaAi: (
    errorId: string,
    newContent: string,
    newChapters: EscritaChapter[],
  ) => void;
  /**
   * Remove capítulos duplicados na Escrita (mesmo part+number+title aparecendo
   * 2+ vezes). Mantém a versão com mais palavras de cada grupo. Push de
   * snapshot pra history stack permite undo. Sem IA — instantâneo.
   *
   * Devolve resumo dos grupos removidos pra UI exibir feedback ("3 cópias do
   * Cap. 4 removidas").
   */
  dedupRevisorChapters: () => {
    removedCount: number;
    groups: Array<{ part?: string; number: number; copiesRemoved: number }>;
  };
  /**
   * Atualiza o cânone de entidades do roteiro. Persiste no localStorage e
   * desmarca a aprovação se o conteúdo mudar (toda edição depois de aprovar
   * exige re-aprovar). Strings vazias / só whitespace deletam o campo.
   */
  setCanone: (canone: string) => void;
  /** Marca o cânone como aprovado pela roteirista, destravando o avanço pra
   *  Estrutura P1. Idempotente. */
  approveCanone: () => void;
  /** Limpa o cânone (markdown + flag de aprovação + timestamp). Usado quando
   *  a roteirista quer regerar do zero. */
  clearCanone: () => void;
  reset: () => void;
}

function persist(r: Roteiro): Roteiro {
  // Coalesce + idle: ver lib/storage.ts. A gravação real (compress + setItem)
  // sai do critical path do keystroke — sem isso, digitar travava o app.
  scheduleSave(r);
  return r;
}

function makeSnapshotId(): string {
  return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function snapshotFromOutput(
  output: StepOutput,
  customLabel?: string,
): StepGenerationSnapshot {
  return {
    id: makeSnapshotId(),
    savedAt: new Date().toISOString(),
    content: output.content,
    metadata: output.metadata,
    edited: output.edited,
    editedAt: output.editedAt,
    generatedAt: output.generatedAt,
    label: customLabel,
  };
}

export const useWizard = create<WizardState>((set, get) => ({
  roteiro: null,
  isGenerating: false,
  autoAdvance: false,
  queueLiveStream: {},

  setQueueLiveStream: (step, text) =>
    set((s) => ({ queueLiveStream: { ...s.queueLiveStream, [step]: text } })),

  setRoteiro: (r) => {
    // Flush antes de trocar — o roteiro anterior em mem pode ter pendências
    // que ainda não bateram no localStorage por causa do debounce.
    flushPendingSave();
    // Limpa o preview ao vivo: ele é específico do roteiro anterior. Se o novo
    // roteiro tiver um job rodando, o QueueRunner volta a alimentar.
    set({ roteiro: r, queueLiveStream: {} });
  },

  setCurrentStep: (step) => {
    // Antes de navegar, garante que qualquer rascunho/output pendente do
    // step atual já está em localStorage. O scheduleSave debouncer pode ter
    // até 600ms enfileirado — sem flush, fechar o roteiro/app rápido perderia.
    flushPendingSave();
    set((s) => {
      if (!s.roteiro) return s;
      return { roteiro: persist({ ...s.roteiro, currentStep: step }) };
    });
  },

  setOutput: (step, output) =>
    set((s) => {
      if (!s.roteiro) return s;
      // Barreira final da invariante "outputs.escrita sem duplicatas por
      // (canonPart, number); content = f(chapters) exceto se edited=true".
      // Qualquer caller que esqueça de dedupar é silenciosamente corrigido —
      // protege contra regressões futuras. Estratégia "longest" (segura por
      // default); callers do batch loop chamam normalize com "last" ANTES
      // de chegar aqui, e a passagem por aqui é idempotente.
      const finalOutput =
        step === "escrita"
          ? normalizeEscritaOutput(output, {
              strategy: "longest",
              source: "store:setOutput",
            }).output
          : output;
      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: { ...s.roteiro.outputs, [step]: finalOutput },
        }),
      };
    }),

  recordEval: (step, output) =>
    set((s) => {
      if (!s.roteiro) return s;
      if (!isRevisorStep(step)) return s;
      const data = computeRevisorEval(
        step,
        output.content ?? "",
        output.metadata?.errors ?? [],
        output.metadata?.escritaSnapshotHash,
      );
      if (!data) return s; // sentinela / step não-revisor — nada a registrar
      const now = new Date().toISOString();
      const evals = appendEvalSnapshot(s.roteiro.evals, data, now);
      if (evals === s.roteiro.evals) return s; // dedup: nada novo
      return { roteiro: persist({ ...s.roteiro, evals }) };
    }),

  recordProductionTime: (step, elapsedMs) =>
    set((s) => {
      if (!s.roteiro) return s;
      if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return s;
      const production = accrueProductionTime(
        s.roteiro.production,
        step,
        elapsedMs,
        new Date().toISOString(),
      );
      return { roteiro: persist({ ...s.roteiro, production }) };
    }),

  updateOutputContent: (step, content) =>
    set((s) => {
      if (!s.roteiro) return s;
      const current = s.roteiro.outputs[step];
      const output: StepOutput = {
        content,
        metadata: current?.metadata,
        generatedAt: current?.generatedAt,
        editedAt: new Date().toISOString(),
        edited: true,
      };
      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: { ...s.roteiro.outputs, [step]: output },
        }),
      };
    }),

  setUserInput: (step, input) =>
    set((s) => {
      if (!s.roteiro) return s;
      const userInputs = { ...(s.roteiro.userInputs ?? {}), [step]: input };
      return {
        roteiro: persist({ ...s.roteiro, userInputs }),
      };
    }),

  setDraft: (step, field, value) =>
    set((s) => {
      if (!s.roteiro) return s;
      const drafts = { ...(s.roteiro.drafts ?? {}) } as RoteiroDrafts;
      const stepDrafts = {
        ...((drafts[step] as Record<string, string> | undefined) ?? {}),
      } as Record<string, string>;
      // Whitespace-only ou vazio deleta — não engorda localStorage com lixo
      // e mantém a semântica "rascunho ausente" igual a "nunca digitou".
      if (value.trim().length === 0) {
        delete stepDrafts[field as string];
      } else {
        stepDrafts[field as string] = value;
      }
      if (Object.keys(stepDrafts).length === 0) {
        delete drafts[step];
      } else {
        (drafts as Record<string, unknown>)[step] = stepDrafts;
      }
      const next: Roteiro = { ...s.roteiro };
      if (Object.keys(drafts).length === 0) {
        delete next.drafts;
      } else {
        next.drafts = drafts;
      }
      return { roteiro: persist(next) };
    }),

  clearDraft: (step, field) =>
    set((s) => {
      if (!s.roteiro?.drafts?.[step]) return s;
      const drafts = { ...s.roteiro.drafts } as RoteiroDrafts;
      if (field === undefined) {
        delete drafts[step];
      } else {
        const stepDrafts = {
          ...((drafts[step] as Record<string, string> | undefined) ?? {}),
        } as Record<string, string>;
        delete stepDrafts[field as string];
        if (Object.keys(stepDrafts).length === 0) {
          delete drafts[step];
        } else {
          (drafts as Record<string, unknown>)[step] = stepDrafts;
        }
      }
      const next: Roteiro = { ...s.roteiro };
      if (Object.keys(drafts).length === 0) {
        delete next.drafts;
      } else {
        next.drafts = drafts;
      }
      return { roteiro: persist(next) };
    }),

  setReferenceImage: (image) =>
    set((s) => {
      if (!s.roteiro) return s;
      const next: Roteiro = { ...s.roteiro };
      if (image) {
        next.referenceImage = image;
      } else {
        delete next.referenceImage;
      }
      return { roteiro: persist(next) };
    }),

  setTitle: (title) =>
    set((s) => {
      if (!s.roteiro) return s;
      return { roteiro: persist({ ...s.roteiro, title }) };
    }),

  setIsGenerating: (v) => set({ isGenerating: v }),

  setAutoAdvance: (v) => set({ autoAdvance: v }),

  pushOutputToHistory: (step, customLabel) =>
    set((s) => {
      if (!s.roteiro) return s;
      const current = s.roteiro.outputs[step];
      // Não salva no histórico se não há conteúdo significativo.
      if (!current?.content?.trim()) return s;

      const history = { ...(s.roteiro.history ?? {}) };
      const stack = history[step] ? [...history[step]!] : [];
      stack.unshift(snapshotFromOutput(current, customLabel));
      // Limite de HISTORY_CAP snapshots por step pra não estourar localStorage.
      // O texto da Escrita (~200KB por snapshot) sozinho enchia os 5MB. O cap
      // vem de `@/lib/storage` (mesma constante do prune de leitura) — o
      // `pruneHistory` em listRoteiros() trunca pilhas antigas na 1ª leitura.
      if (stack.length > HISTORY_CAP) stack.length = HISTORY_CAP;
      history[step] = stack;

      return {
        roteiro: persist({ ...s.roteiro, history }),
      };
    }),

  restoreFromHistory: (step, snapshotId) =>
    set((s) => {
      if (!s.roteiro) return s;
      const stack = s.roteiro.history?.[step];
      if (!stack) return s;
      const snapshot = stack.find((sn) => sn.id === snapshotId);
      if (!snapshot) return s;

      // Move o output atual pro histórico antes de substituir.
      const newHistoryStack = stack.filter((sn) => sn.id !== snapshotId);
      const current = s.roteiro.outputs[step];
      if (current?.content?.trim()) {
        newHistoryStack.unshift(snapshotFromOutput(current));
      }
      if (newHistoryStack.length > HISTORY_CAP) newHistoryStack.length = HISTORY_CAP;

      const restoredOutput: StepOutput = {
        content: snapshot.content,
        metadata: snapshot.metadata,
        generatedAt: snapshot.generatedAt ?? snapshot.savedAt,
        edited: snapshot.edited,
        editedAt: snapshot.editedAt,
      };

      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: { ...s.roteiro.outputs, [step]: restoredOutput },
          history: {
            ...(s.roteiro.history ?? {}),
            [step]: newHistoryStack,
          },
        }),
      };
    }),

  deleteFromHistory: (step, snapshotId) =>
    set((s) => {
      if (!s.roteiro) return s;
      const stack = s.roteiro.history?.[step];
      if (!stack) return s;
      const newStack = stack.filter((sn) => sn.id !== snapshotId);
      return {
        roteiro: persist({
          ...s.roteiro,
          history: { ...(s.roteiro.history ?? {}), [step]: newStack },
        }),
      };
    }),

  applyRevisorCorrections: (errorIds, snapshotLabel) => {
    const state = get();
    const roteiro = state.roteiro;
    if (!roteiro) return { applied: [], failed: errorIds };

    const escritaOutput = roteiro.outputs.escrita;
    if (!escritaOutput?.content) {
      return { applied: [], failed: errorIds };
    }

    // Os erros vivem em vários steps: revisor1 (P1), revisor2 (P2) e
    // overview (varredura estrutural P1+P2). Procura em todos — cada erro
    // carrega seu próprio step de origem pra que a marcação `applied: true`
    // volte pro metadata correto depois (sem isso, marcar erro do overview
    // como aplicado iria pisar no metadata do revisor1 vazio).
    const allErrorsByStep: Array<{
      err: RevisorError;
      step: ErrorSourceStepKey;
    }> = [];
    for (const stepKey of ERROR_SOURCE_STEPS) {
      const errs = roteiro.outputs[stepKey]?.metadata?.errors ?? [];
      for (const err of errs) allErrorsByStep.push({ err, step: stepKey });
    }
    if (allErrorsByStep.length === 0) {
      return { applied: [], failed: errorIds };
    }

    // Filtra os erros marcados que ainda não foram aplicados.
    const targets = allErrorsByStep.filter(
      ({ err }) => errorIds.includes(err.id) && !err.applied,
    );
    if (targets.length === 0) {
      return { applied: [], failed: errorIds };
    }
    const targetErrors = targets.map((t) => t.err);

    // Antes de mexer, salva snapshot da Escrita no histórico pra reversão.
    state.pushOutputToHistory(
      "escrita",
      snapshotLabel ?? "Antes das correções do Revisor",
    );

    // 1) Aplica no content monolítico (sempre existe).
    const monolithic = applyCorrections(escritaOutput.content, targetErrors);

    // 2) Aplica nos chapters[] também — varre todos os capítulos e tenta
    //    substituir cada trecho. Como o monolithic já anota quais aplicaram,
    //    aqui só atualizamos chapters que mudaram.
    let updatedChapters: EscritaChapter[] | undefined =
      escritaOutput.metadata?.chapters
        ? escritaOutput.metadata.chapters.map((ch) => {
            const res = applyCorrections(ch.content, targetErrors);
            if (res.appliedIds.length === 0) return ch;
            return {
              ...ch,
              content: res.text,
              edited: true,
              editedAt: new Date().toISOString(),
            };
          })
        : undefined;

    // União dos IDs aplicados: tanto os que pegaram no monolítico quanto
    // os que pegaram em algum chapter — pra não falsamente marcar fail.
    const appliedSet = new Set(monolithic.appliedIds);
    if (updatedChapters) {
      for (const ch of escritaOutput.metadata?.chapters ?? []) {
        const res = applyCorrections(ch.content, targetErrors);
        for (const id of res.appliedIds) appliedSet.add(id);
      }
    }
    // Última defesa: se o content NÃO mudou de verdade (whitespace ignorado),
    // a "aplicação" foi no-op silencioso. Acontecia quando trecho_original ===
    // trecho_corrigido OU quando o `applyCorrections` antigo trocava só a 1ª
    // ocorrência mas o usuário esperava ver mudança visível. Não marca applied.
    if (
      appliedSet.size > 0 &&
      monolithic.text.replace(/\s+/g, " ").trim() ===
        escritaOutput.content.replace(/\s+/g, " ").trim()
    ) {
      return { applied: [], failed: errorIds };
    }
    const applied = targetErrors
      .filter((e) => appliedSet.has(e.id))
      .map((e) => e.id);
    const failed = targetErrors
      .filter((e) => !appliedSet.has(e.id))
      .map((e) => e.id);

    if (applied.length === 0) {
      return { applied: [], failed };
    }

    // Agrupa os erros aplicados por step de origem — cada um vai atualizar
    // SEU metadata, sem cruzar pro outro source.
    const appliedByStep: Record<ErrorSourceStepKey, Set<string>> = {
      revisor1: new Set(),
      revisor2: new Set(),
      overview: new Set(),
    };
    for (const t of targets) {
      if (applied.includes(t.err.id)) appliedByStep[t.step].add(t.err.id);
    }

    const now = new Date().toISOString();

    set((s) => {
      if (!s.roteiro) return s;

      // Atualiza output da Escrita (content + chapters + edited flags)
      const updatedEscrita: StepOutput = {
        ...s.roteiro.outputs.escrita!,
        content: monolithic.text,
        edited: true,
        editedAt: now,
        ...(updatedChapters && {
          metadata: {
            ...s.roteiro.outputs.escrita!.metadata,
            chapters: updatedChapters,
          },
        }),
      };

      // Marca os erros aplicados em cada outputs.<step>.metadata.errors[].
      const stepPatches: Partial<Record<ErrorSourceStepKey, StepOutput>> = {};
      for (const stepKey of ERROR_SOURCE_STEPS) {
        const source = s.roteiro.outputs[stepKey];
        const stepApplied = appliedByStep[stepKey];
        if (!source || stepApplied.size === 0) continue;
        stepPatches[stepKey] = {
          ...source,
          metadata: {
            ...source.metadata,
            errors: (source.metadata?.errors ?? []).map((e) =>
              stepApplied.has(e.id)
                ? { ...e, applied: true, appliedAt: now }
                : e,
            ),
          },
        };
      }

      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: {
            ...s.roteiro.outputs,
            escrita: updatedEscrita,
            ...(stepPatches.revisor1 && { revisor1: stepPatches.revisor1 }),
            ...(stepPatches.revisor2 && { revisor2: stepPatches.revisor2 }),
            ...(stepPatches.overview && { overview: stepPatches.overview }),
          },
        }),
      };
    });

    return { applied, failed };
  },

  applyRevisorCorrection: (errorId) => {
    const state = get();
    const outputs = state.roteiro?.outputs;
    let err: RevisorError | undefined;
    for (const k of ERROR_SOURCE_STEPS) {
      err = outputs?.[k]?.metadata?.errors?.find((e) => e.id === errorId);
      if (err) break;
    }
    const label = err
      ? `Antes da correção do Erro #${err.numero}`
      : "Antes da correção do Revisor";
    const result = state.applyRevisorCorrections([errorId], label);
    return {
      applied: result.applied.includes(errorId),
      found: result.applied.includes(errorId),
    };
  },

  applyRevisorCorrectionViaAi: (errorId, newContent, newChapters) => {
    const state = get();
    const roteiro = state.roteiro;
    if (!roteiro) return;
    const outputs = roteiro.outputs;
    if (!outputs.escrita?.content) return;

    // Descobre em qual step de origem está esse erro (revisor1, revisor2, overview).
    let stepKey: ErrorSourceStepKey | null = null;
    let err: RevisorError | undefined;
    for (const k of ERROR_SOURCE_STEPS) {
      const found = outputs[k]?.metadata?.errors?.find((e) => e.id === errorId);
      if (found) {
        stepKey = k;
        err = found;
        break;
      }
    }
    if (!stepKey || !err) return;

    state.pushOutputToHistory(
      "escrita",
      `Antes da correção via IA do Erro #${err.numero}`,
    );

    const now = new Date().toISOString();

    // Defesa final: sanitiza o conteúdo + chapters vindos da IA antes de
    // gravar. Cobre o caso (raro) em que o agente de correção via IA emite
    // um capítulo com tag XML do schema cravada — mesma família de bug do
    // applyCorrections via find+replace.
    const sanitizedContent = stripXmlCruft(newContent);
    const sanitizedChapters: EscritaChapter[] = newChapters.map((ch) => ({
      ...ch,
      content: stripXmlCruft(ch.content),
    }));

    set((s) => {
      if (!s.roteiro) return s;

      const updatedEscrita: StepOutput = {
        ...s.roteiro.outputs.escrita!,
        content: sanitizedContent,
        edited: true,
        editedAt: now,
        metadata: {
          ...s.roteiro.outputs.escrita!.metadata,
          chapters: sanitizedChapters,
        },
      };

      const revisor = s.roteiro.outputs[stepKey!];
      if (!revisor) {
        return {
          roteiro: persist({
            ...s.roteiro,
            outputs: { ...s.roteiro.outputs, escrita: updatedEscrita },
          }),
        };
      }
      const updatedRevisor: StepOutput = {
        ...revisor,
        metadata: {
          ...revisor.metadata,
          errors: (revisor.metadata?.errors ?? []).map((e) =>
            e.id === errorId ? { ...e, applied: true, appliedAt: now } : e,
          ),
        },
      };

      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: {
            ...s.roteiro.outputs,
            escrita: updatedEscrita,
            [stepKey!]: updatedRevisor,
          },
        }),
      };
    });
  },

  dedupRevisorChapters: () => {
    const state = get();
    const roteiro = state.roteiro;
    const empty = { removedCount: 0, groups: [] as Array<{ part?: string; number: number; copiesRemoved: number }> };
    if (!roteiro) return empty;
    const escrita = roteiro.outputs.escrita;
    const chapters = escrita?.metadata?.chapters;
    if (!escrita?.content || !chapters || chapters.length === 0) return empty;

    const { chapters: deduped, removed } = dedupChapters(chapters);
    if (removed.length === 0) return empty;

    state.pushOutputToHistory("escrita", "Antes de remover capítulos duplicados");

    const now = new Date().toISOString();
    const newContent = concatenateChapters(deduped);

    set((s) => {
      if (!s.roteiro?.outputs.escrita) return s;
      const updatedEscrita: StepOutput = {
        ...s.roteiro.outputs.escrita,
        content: newContent,
        edited: true,
        editedAt: now,
        metadata: {
          ...s.roteiro.outputs.escrita.metadata,
          chapters: deduped,
        },
      };
      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: { ...s.roteiro.outputs, escrita: updatedEscrita },
        }),
      };
    });

    return {
      removedCount: removed.reduce((acc, g) => acc + (g.indices.length - 1), 0),
      groups: removed.map((g) => ({
        part: g.part,
        number: g.number,
        copiesRemoved: g.indices.length - 1,
      })),
    };
  },

  setCanone: (canone) =>
    set((s) => {
      if (!s.roteiro) return s;
      const trimmed = canone.trim();
      const next: Roteiro = { ...s.roteiro };
      // Edição depois de aprovar invalida a aprovação — força re-aprovar.
      // Sem isso, mexer 1 caractere já permitiria seguir pra Estrutura.
      if (s.roteiro.canoneApproved && trimmed !== (s.roteiro.canone ?? "").trim()) {
        next.canoneApproved = false;
        delete next.canoneApprovedAt;
      }
      if (trimmed.length === 0) {
        delete next.canone;
      } else {
        next.canone = canone;
      }
      return { roteiro: persist(next) };
    }),

  approveCanone: () =>
    set((s) => {
      if (!s.roteiro) return s;
      if (!s.roteiro.canone?.trim()) return s;
      return {
        roteiro: persist({
          ...s.roteiro,
          canoneApproved: true,
          canoneApprovedAt: new Date().toISOString(),
        }),
      };
    }),

  clearCanone: () =>
    set((s) => {
      if (!s.roteiro) return s;
      const next: Roteiro = { ...s.roteiro };
      delete next.canone;
      delete next.canoneApproved;
      delete next.canoneApprovedAt;
      return { roteiro: persist(next) };
    }),

  reset: () => {
    // Flush antes de zerar — o roteiro que estava em mem pode ter mutações
    // pendentes não persistidas. Sem isso, "Voltar à lista" logo após digitar
    // perderia a última edição.
    flushPendingSave();
    set({
      roteiro: null,
      isGenerating: false,
      autoAdvance: false,
      queueLiveStream: {},
    });
  },
}));

export { STEP_ORDER };
