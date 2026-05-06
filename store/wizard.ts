import { create } from "zustand";
import type {
  EscritaChapter,
  RevisorError,
  Roteiro,
  RoteiroDrafts,
  RoteiroReferenceImage,
  StepGenerationSnapshot,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { STEP_ORDER, REVISOR_STEPS } from "@/types/roteiro";
import { scheduleSave, flushPendingSave } from "@/lib/storage";
import { applyCorrections } from "@/lib/parse-revisor-output";

type RevisorStepKey = (typeof REVISOR_STEPS)[number];

interface WizardState {
  roteiro: Roteiro | null;
  isGenerating: boolean;
  autoAdvance: boolean;
  setRoteiro: (r: Roteiro) => void;
  setCurrentStep: (step: StepId) => void;
  setOutput: (step: StepId, output: StepOutput) => void;
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

  setRoteiro: (r) => {
    // Flush antes de trocar — o roteiro anterior em mem pode ter pendências
    // que ainda não bateram no localStorage por causa do debounce.
    flushPendingSave();
    set({ roteiro: r });
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
      return {
        roteiro: persist({
          ...s.roteiro,
          outputs: { ...s.roteiro.outputs, [step]: output },
        }),
      };
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
      // Limite de 5 snapshots por step pra não estourar localStorage. Antes
      // era 20, mas o texto da Escrita (~200KB por snapshot) sozinho enchia
      // os 5MB. O prune correspondente em listRoteiros() trunca pilhas
      // antigas (até 20) na primeira leitura após a atualização.
      if (stack.length > 5) stack.length = 5;
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
      if (newHistoryStack.length > 5) newHistoryStack.length = 5;

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

    // Os erros vivem em DOIS steps agora: revisor1 (Parte 1) e revisor2
    // (Parte 2). Procura em ambos — cada erro carrega seu próprio step de
    // origem pra que a marcação `applied: true` volte pro metadata correto
    // depois (sem isso, marcar erro do revisor2 como aplicado iria pisar
    // no metadata do revisor1 vazio).
    const allErrorsByStep: Array<{ err: RevisorError; step: RevisorStepKey }> =
      [];
    for (const stepKey of REVISOR_STEPS) {
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
    // SEU metadata, sem cruzar pro outro revisor.
    const appliedByStep: Record<RevisorStepKey, Set<string>> = {
      revisor1: new Set(),
      revisor2: new Set(),
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

      // Marca os erros aplicados em cada outputs.revisorN.metadata.errors[].
      const revisorPatches: Partial<Record<RevisorStepKey, StepOutput>> = {};
      for (const stepKey of REVISOR_STEPS) {
        const revisor = s.roteiro.outputs[stepKey];
        const stepApplied = appliedByStep[stepKey];
        if (!revisor || stepApplied.size === 0) continue;
        revisorPatches[stepKey] = {
          ...revisor,
          metadata: {
            ...revisor.metadata,
            errors: (revisor.metadata?.errors ?? []).map((e) =>
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
            ...(revisorPatches.revisor1 && { revisor1: revisorPatches.revisor1 }),
            ...(revisorPatches.revisor2 && { revisor2: revisorPatches.revisor2 }),
          },
        }),
      };
    });

    return { applied, failed };
  },

  applyRevisorCorrection: (errorId) => {
    const state = get();
    const outputs = state.roteiro?.outputs;
    const err =
      outputs?.revisor1?.metadata?.errors?.find((e) => e.id === errorId) ??
      outputs?.revisor2?.metadata?.errors?.find((e) => e.id === errorId);
    const label = err
      ? `Antes da correção do Erro #${err.numero}`
      : "Antes da correção do Revisor";
    const result = state.applyRevisorCorrections([errorId], label);
    return {
      applied: result.applied.includes(errorId),
      found: result.applied.includes(errorId),
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
    set({ roteiro: null, isGenerating: false, autoAdvance: false });
  },
}));

export { STEP_ORDER };
