/**
 * Motor headless dos steps de chamada ÚNICA (Estrutura 1/2, Revisor 1/2) — pra
 * rodarem no gerenciador persistente (`QueueRunner`) e sobreviverem a trocar/
 * fechar a guia, igual à Escrita. Espelha FIELMENTE a finalização do branch
 * correspondente no `StepShell.tsx`, reusando os MESMOS parsers (parseRevisorErrors,
 * stripErrosDetalhados, etc.) — a lógica que define a saída é compartilhada.
 *
 * Só cobre o modo "regenerar do zero". Os modos especiais (refine / "continuar
 * revisão" / "continuar de onde parou") seguem no componente — são pontuais e
 * dependem de estado/UI local.
 *
 * ⚠️ Se mexer na finalização de Estrutura/Revisor no `StepShell`, atualize aqui também.
 */
import { getRoteiro } from "@/lib/storage";
import type { Roteiro, StepId, StepOutput } from "@/types/roteiro";
import { isRevisorStep, partOfRevisorStep } from "@/types/roteiro";
import { concatenateChapters } from "@/lib/parse-escrita-output";
import {
  countMarkdownErrorNumbers,
  hashEscritaContent,
  parseMarkdownErrorList,
  parseRevisorErrors,
  stripErrosDetalhados,
} from "@/lib/parse-revisor-output";
import { normalizeEstruturaTargets } from "@/lib/normalize-estrutura-targets";

/** Steps que o motor genérico de chamada única sabe rodar. */
export const STREAMING_STEPS = [
  "estrutura1",
  "estrutura2",
  "revisor1",
  "revisor2",
  "overview",
] as const;
export type StreamingStep = (typeof STREAMING_STEPS)[number];

export function isStreamingStep(step: StepId): step is StreamingStep {
  return (STREAMING_STEPS as readonly string[]).includes(step);
}

export interface RunStepHooks {
  signal: AbortSignal;
  /** Rótulo de fase pra UI (ex.: "Gerando estrutura…", "Revisando…"). */
  onPhase?: (label: string) => void;
  /** Texto cru chegando do stream (throttled ~80ms) — pra preview ao vivo. */
  onLiveText?: (text: string) => void;
}

/** Params da Premissa (2 fases) — espelha o body/finalização do PremissaWizard. */
export interface RunPremissaParams {
  phase: "resumo" | "estrutura";
  /** Resumo aprovado — só na fase "estrutura". */
  approvedResumo?: string;
  /** Briefing (ideia) capturado no clique — vira metadata.premissaBriefing. */
  briefing?: string;
}

async function readResponseText(
  res: Response,
  signal: AbortSignal,
  onLive?: (text: string) => void,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  // Throttle por tempo (~80ms ≈ 12 updates/s) — leve no store, suave na UI.
  let lastEmit = 0;
  for (;;) {
    if (signal.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (onLive) {
      const now = Date.now();
      if (now - lastEmit > 80) {
        lastEmit = now;
        onLive(acc);
      }
    }
  }
  if (onLive) onLive(acc);
  return acc;
}

/**
 * Roda um step de chamada única e devolve o `StepOutput` finalizado (pronto pra
 * gravar). `userInput` é o snapshot dos "Ajustes opcionais" capturado no clique
 * (evita race com o debounce de save).
 */
export async function runStreamingStep(
  roteiroId: string,
  step: StreamingStep,
  userInput: string | undefined,
  hooks: RunStepHooks,
): Promise<StepOutput> {
  const r = getRoteiro(roteiroId);
  if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");
  if (isRevisorStep(step)) return runRevisorStep(r, step, userInput, hooks);
  if (step === "overview") return runOverviewStep(r, userInput, hooks);
  return runEstruturaStep(r, step, userInput, hooks);
}

/**
 * Overview Final headless — espelha a finalização do branch `overview` do
 * `StepShell` (analisa P1+P2, parseia erros com prefixo `ov-`). Body genérico.
 */
async function runOverviewStep(
  r: Roteiro,
  userInput: string | undefined,
  hooks: RunStepHooks,
): Promise<StepOutput> {
  hooks.onPhase?.("Analisando o roteiro completo…");
  const res = await fetch(`/api/agent/overview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: r.category,
      previousOutputs: r.outputs,
      userInput,
      referenceImage: r.referenceImage,
      ...(r.canone?.trim() ? { canone: r.canone } : {}),
    }),
    signal: hooks.signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || res.statusText);
  }
  const acc = await readResponseText(res, hooks.signal, (raw) =>
    hooks.onLiveText?.(stripErrosDetalhados(raw)),
  );
  // IDs prefixados com `ov-` pra não colidir com os do Revisor (p1-/p2-).
  const errors = parseRevisorErrors(acc).map((e) => ({
    ...e,
    id: `ov-${e.id}`,
  }));
  const cleanContent = stripErrosDetalhados(acc);
  const escritaContent = r.outputs.escrita?.content?.trim() ?? "";
  const escritaSnapshotHash = escritaContent
    ? hashEscritaContent(escritaContent)
    : undefined;
  return {
    content: cleanContent,
    metadata: {
      errors,
      ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Cânone de Entidades headless — espelha `CanoneCard.generate`. Extrai as
 * entidades da premissa via /api/canone. Devolve o markdown do cânone (o
 * QueueRunner grava em `roteiro.canone`, não em `outputs[step]`).
 */
export async function runCanone(
  roteiroId: string,
  hooks: RunStepHooks,
): Promise<string> {
  const r = getRoteiro(roteiroId);
  if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");
  const premissa = r.outputs.premissa?.content?.trim() ?? "";
  if (!premissa) throw new Error("Gere a premissa antes do cânone.");
  hooks.onPhase?.("Extraindo entidades da premissa…");
  const res = await fetch("/api/canone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ premissa }),
    signal: hooks.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await readResponseText(res, hooks.signal, hooks.onLiveText)).trim();
}

/**
 * Premissa (2 fases) headless — espelha `generateResumo` /
 * `approveAndGenerateEstrutura` do `PremissaWizard`. `userInput` é o
 * briefing+instrução já montado, capturado no clique.
 */
export async function runPremissa(
  roteiroId: string,
  params: RunPremissaParams,
  userInput: string | undefined,
  hooks: RunStepHooks,
): Promise<StepOutput> {
  const r = getRoteiro(roteiroId);
  if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");
  const meta = r.outputs.premissa?.metadata ?? {};
  const now = new Date().toISOString();

  if (params.phase === "resumo") {
    hooks.onPhase?.("Gerando resumo…");
    const res = await fetch("/api/agent/premissa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: r.category,
        userInput,
        referenceImage: r.referenceImage,
        premissaPhase: "resumo",
      }),
      signal: hooks.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`,
      );
    }
    const fullText = (
      await readResponseText(res, hooks.signal, hooks.onLiveText)
    ).trim();
    if (!fullText) {
      throw new Error("O agente não retornou nenhum texto. Tente novamente.");
    }
    return {
      // content vazio: o downstream só consome a premissa final (pós-Fase 2).
      content: "",
      generatedAt: now,
      metadata: {
        ...meta,
        ...(params.briefing ? { premissaBriefing: params.briefing } : {}),
        premissaResumo: fullText,
        premissaResumoApproved: false,
        premissaManualPaste: false,
      },
    };
  }

  // Fase estrutura: gera os blocos a partir do resumo aprovado.
  hooks.onPhase?.("Gerando estrutura…");
  const approvedResumo = (params.approvedResumo ?? "").trim();
  const res = await fetch("/api/agent/premissa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: r.category,
      userInput,
      referenceImage: r.referenceImage,
      premissaPhase: "estrutura",
      approvedResumo,
    }),
    signal: hooks.signal,
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`,
    );
  }
  const estrutura = (
    await readResponseText(res, hooks.signal, hooks.onLiveText)
  ).trim();
  if (!estrutura) {
    throw new Error("O agente não retornou nenhuma estrutura. Tente novamente.");
  }
  const fullContent = `# RESUMO\n\n${approvedResumo}\n\n# ESTRUTURA COMPLETA\n\n${estrutura}`;
  return {
    content: fullContent,
    generatedAt: now,
    metadata: {
      ...meta,
      ...(params.briefing ? { premissaBriefing: params.briefing } : {}),
      premissaResumo: approvedResumo,
      premissaResumoApproved: true,
      premissaResumoApprovedAt: now,
      premissaManualPaste: false,
    },
  };
}

async function runEstruturaStep(
  r: Roteiro,
  step: StreamingStep,
  userInput: string | undefined,
  hooks: RunStepHooks,
): Promise<StepOutput> {
  hooks.onPhase?.("Gerando estrutura…");
  const res = await fetch(`/api/agent/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: r.category,
      previousOutputs: r.outputs,
      userInput,
      referenceImage: r.referenceImage,
      ...(r.canone?.trim() ? { canone: r.canone } : {}),
    }),
    signal: hooks.signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || res.statusText);
  }
  const acc = await readResponseText(res, hooks.signal, hooks.onLiveText);

  // Trava determinística: garante que os alvos por capítulo somem dentro da
  // faixa total da Parte (o modelo costuma estourar quando o prompt usa
  // placeholders em vez de números fixos). Reescala silenciosamente se preciso.
  const part = step === "estrutura1" ? "Parte 1" : "Parte 2";
  const normalized = normalizeEstruturaTargets(acc.trim(), part, r.category);
  if (normalized.rescaled) {
    console.info(
      `[estrutura] ${step} reescalado: soma ${normalized.sumBefore} → ${normalized.sumAfter} (dentro da faixa da ${part})`,
    );
  }
  return { content: normalized.text, generatedAt: new Date().toISOString() };
}

async function runRevisorStep(
  r: Roteiro,
  step: StreamingStep,
  userInput: string | undefined,
  hooks: RunStepHooks,
): Promise<StepOutput> {
  const revisorPart = partOfRevisorStep(step as "revisor1" | "revisor2");
  const partLabel = revisorPart === 1 ? "Parte 1" : "Parte 2";
  const allChapters = r.outputs.escrita?.metadata?.chapters ?? [];
  const accChapters = allChapters.filter(
    (ch) => (ch.part ?? "Parte 1") === partLabel,
  );
  if (allChapters.length === 0) {
    return {
      content:
        "[ERRO] O Step 4 (Escrita) ainda não tem capítulos parseados — gere o roteiro completo antes de revisar.",
      generatedAt: new Date().toISOString(),
    };
  }

  hooks.onPhase?.("Revisando…");
  const escritaContent = concatenateChapters(accChapters);
  const escritaSnapshotHash = hashEscritaContent(escritaContent);

  // Relatório enxuto a partir da 2ª passada: se já existe um relatório anterior
  // deste step (output corrente não-sentinela OU entrada no histórico), pede só
  // o bloco de erros — a 1ª passada já entregou o relatório completo. Espelha o
  // branch "Continuar revisão" do StepShell (mantenha os dois em sincronia).
  const priorContent = r.outputs[step]?.content?.trim() ?? "";
  const hadPriorReport =
    (priorContent.length > 0 && !priorContent.startsWith("[")) ||
    (r.history?.[step]?.length ?? 0) > 0;

  const res = await fetch(`/api/agent/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: r.category,
      previousOutputs: r.outputs,
      userInput,
      referenceImage: r.referenceImage,
      ...(r.canone?.trim() ? { canone: r.canone } : {}),
      ...(hadPriorReport ? { leanRevisorReport: true } : {}),
    }),
    signal: hooks.signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || res.statusText);
  }
  const acc = await readResponseText(res, hooks.signal, (raw) =>
    hooks.onLiveText?.(stripErrosDetalhados(raw)),
  );

  let errors = parseRevisorErrors(acc, revisorPart);
  const cleanContent = stripErrosDetalhados(acc);

  // Fallback: XML com menos erros que o markdown lista → extração estruturada.
  const expectedCount = countMarkdownErrorNumbers(cleanContent);
  if (expectedCount > 0 && errors.length < expectedCount) {
    hooks.onPhase?.("Extraindo erros…");
    try {
      const fbRes = await fetch("/api/revisor-extract-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: r.category,
          revisaoMarkdown: cleanContent,
          escritaContent,
        }),
        signal: hooks.signal,
      });
      if (fbRes.ok && fbRes.body) {
        const fbAcc = await readResponseText(fbRes, hooks.signal);
        const fallbackErrors = parseRevisorErrors(fbAcc, revisorPart);
        if (fallbackErrors.length > 0) errors = fallbackErrors;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
  }

  // Defesa: erros em PRINCIPAIS ERROS que não viraram XML → cards informativos.
  const markdownErrors = parseMarkdownErrorList(cleanContent, revisorPart);
  const xmlNumbers = new Set(errors.map((e) => e.numero.toLowerCase()));
  const missingFromXml = markdownErrors.filter(
    (m) => !xmlNumbers.has(m.numero.toLowerCase()),
  );
  if (missingFromXml.length > 0) {
    errors = [...errors, ...missingFromXml].sort((a, b) => {
      const na = parseInt(a.numero, 10);
      const nb = parseInt(b.numero, 10);
      if (Number.isNaN(na) || Number.isNaN(nb)) {
        return a.numero.localeCompare(b.numero);
      }
      return na - nb;
    });
  }

  return {
    content: cleanContent,
    metadata: {
      errors,
      ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
    },
    generatedAt: new Date().toISOString(),
  };
}
