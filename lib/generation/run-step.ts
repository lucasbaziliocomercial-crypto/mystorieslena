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
import { splitThinking } from "@/lib/stream-markers";
import { normalizeEstruturaTargets } from "@/lib/normalize-estrutura-targets";
import { countChaptersInEstrutura } from "@/lib/parse-estrutura-chapters";
import { expectedMinChapters } from "@/lib/expected-min-chapters";
import {
  detectHardMarker,
  detectErroMarker,
  isQuotaErroMarker,
  isTransientErroMarker,
} from "@/lib/generation/stream-error-markers";

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

/**
 * Teto de silêncio do stream: se NENHUM byte chegar nesse intervalo, o watchdog
 * em `readResponseText` aborta o read travado. Mesmo valor da Escrita
 * (`run-escrita.ts`) — 180s cobre folgado o maior gap real entre chunks sob carga.
 */
const STREAM_STALL_TIMEOUT_MS = 180_000;

/**
 * Stream ficou em silêncio além de `STREAM_STALL_TIMEOUT_MS`. Sem isto, um stream
 * de chamada única (Estrutura/Revisor/Overview/Premissa/Cânone) que pendura sob
 * carga concorrente (duas gerações na MESMA conta OAuth) deixava o job "running"
 * pra sempre, com a saída em branco e sem aviso — o slot da fila ficava preso e a
 * roteirista via "uma das duas em branco". Convertido num erro recuperável pelo
 * chamador (o `QueueRunner` marca o job como `error` e o botão "Gerar" volta).
 */
class StreamStallError extends Error {
  constructor() {
    super(
      `O stream do modelo travou (sem dados por ${Math.round(
        STREAM_STALL_TIMEOUT_MS / 1000,
      )}s). Tente gerar de novo.`,
    );
    this.name = "StreamStallError";
  }
}

/**
 * A rota injetou no CORPO do stream um marcador de erro TRANSIENTE (socket do
 * `claude.exe` caiu, subprocesso morreu, cota estourou) — o "conteúdo" recebido
 * é uma mensagem de erro disfarçada, NÃO a estrutura/revisão. Tratado como
 * recuperável: `withStallRetry` refaz a chamada INTEIRA (idempotente — nada é
 * mutado antes da resposta chegar). Fecha o buraco "socket connection was closed
 * unexpectedly" que ANTES salvava a estrutura truncada + o `[ERRO]` como se fosse
 * conteúdo (a Escrita já retentava isso; o motor de chamada única, não). Bug da
 * máquina fraca da roteirista (pressão de memória derruba o socket), 13/07/2026.
 */
class TransientStreamError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TransientStreamError";
  }
}

/**
 * A rota injetou um marcador FATAL (login expirado, binário ausente) ou um
 * `[ERRO]` genuíno da SDK que repetir NÃO resolve. Propaga com a causa real — o
 * `QueueRunner`/`StepShell` marca o job como erro e mostra "Gerar novamente" com
 * a explicação. JAMAIS salvo como conteúdo (era o que truncava a estrutura).
 */
class FatalStreamMarkerError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FatalStreamMarkerError";
  }
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
  try {
    for (;;) {
      if (signal.aborted) break;
      // Watchdog de silêncio: corrida entre o próximo chunk e um timer recriado a
      // CADA iteração (reseta a cada byte que chega). Só dispara se NENHUM byte
      // chegar por STREAM_STALL_TIMEOUT_MS seguidos, convertendo um hang infinito
      // num StreamStallError. Espelha run-escrita.ts (lá os batches têm watchdog;
      // os steps de chamada única não tinham — era o buraco do "duas ao mesmo
      // tempo, uma fica em branco").
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new StreamStallError()),
          STREAM_STALL_TIMEOUT_MS,
        );
      });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), stall]);
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
      const { done, value } = chunk;
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      if (onLive) {
        const now = Date.now();
        if (now - lastEmit > 80) {
          lastEmit = now;
          // CRU (com marcadores) pro preview ao vivo — a UI separa o raciocínio
          // esmaecido. O retorno limpo abaixo é o que vira conteúdo salvo.
          onLive(acc);
        }
      }
    }
  } catch (e) {
    // Watchdog disparou: cancela o reader pra liberar a conexão pendurada e
    // propaga. O QueueRunner trata como erro recuperável (job → error, sem
    // pendurar o slot da fila pra sempre).
    if (e instanceof StreamStallError) {
      try {
        await reader.cancel();
      } catch {
        /* reader já morto — ignora */
      }
    }
    throw e;
  }
  if (onLive) onLive(acc);

  // A rota (`app/api/agent/[step]/route.ts`) injeta marcadores de erro NO CORPO
  // do stream quando a SDK falha COM res.ok=true — indetectável pelo status HTTP.
  // Se aparecerem, o que veio NÃO é estrutura/revisão: é uma mensagem de erro
  // disfarçada. Sem esta checagem, o motor salvava o texto truncado + `[ERRO]`
  // como se fosse o conteúdo (estrutura cortada no meio → contagem de capítulos/
  // palavras quebrada downstream). Ordem = a MESMA da Escrita (run-escrita.ts):
  // hard (login/binário) → cota → queda transiente → `[ERRO]` genuíno.
  //   • hard/genuíno → FatalStreamMarkerError (propaga a causa real; não salva).
  //   • cota/socket caído/subprocesso morto → TransientStreamError (withStallRetry
  //     refaz a chamada inteira; idempotente). É a correção do "socket connection
  //     was closed unexpectedly" na máquina fraca da roteirista.
  const hardReason = detectHardMarker(acc);
  if (hardReason) throw new FatalStreamMarkerError(hardReason);
  if (isQuotaErroMarker(acc) || isTransientErroMarker(acc)) {
    throw new TransientStreamError(
      detectErroMarker(acc) ?? "A conexão com o modelo caiu no meio da geração.",
    );
  }
  const erroReason = detectErroMarker(acc);
  if (erroReason) throw new FatalStreamMarkerError(erroReason);

  // Retorna o conteúdo final SEM o raciocínio (thinking). Pros steps sem
  // thinking (Revisor/Premissa/Overview), splitThinking é identidade.
  return splitThinking(acc).content;
}

/**
 * Nº de re-tentativas automáticas quando o STREAM TRAVA (`StreamStallError`) num
 * passo de chamada única. Self-heal sem a roteirista reclicar: o stall costuma ser
 * engasgo transiente da conta compartilhada sob 2 gerações concorrentes, e uma
 * requisição NOVA quase sempre volta a fluir. Bounded (pior caso raro).
 */
const MAX_STALL_RETRIES = 2;

/** Sleep que resolve cedo se o signal abortar (não trava o cancelamento). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Roda `fn` e, se o stream TRAVAR (`StreamStallError`) ou a rota injetar um
 * marcador de erro TRANSIENTE (`TransientStreamError` — socket caído, subprocesso
 * morto, cota), refaz a chamada INTEIRA até `MAX_STALL_RETRIES` com backoff curto
 * (abort-aware). Self-heal pros casos "duas gerações concorrentes, uma engasga" e
 * "socket caiu no meio na máquina fraca" — a roteirista não reclica. Só esses dois
 * são retentados; QUALQUER outro erro (HTTP, abort, `FatalStreamMarkerError` de
 * login/binário/erro genuíno, erro de conteúdo) propaga na hora (não mascara falha
 * real). Esgotadas as tentativas, propaga e o `QueueRunner` marca o job como erro
 * recuperável ("Gerar novamente"), em vez de salvar o `[ERRO]` como conteúdo.
 * `onPhase` avisa a re-tentativa.
 */
async function withStallRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  onPhase?: (label: string) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal.aborted || (e as Error).name === "AbortError") throw e;
      const retryable =
        e instanceof StreamStallError || e instanceof TransientStreamError;
      if (retryable && attempt < MAX_STALL_RETRIES) {
        onPhase?.(
          e instanceof TransientStreamError
            ? `A conexão caiu — tentando de novo (${attempt + 1}/${MAX_STALL_RETRIES})…`
            : `O modelo engasgou — tentando de novo (${attempt + 1}/${MAX_STALL_RETRIES})…`,
        );
        await sleep(1500 * (attempt + 1), signal);
        if (signal.aborted) throw e;
        continue;
      }
      throw e;
    }
  }
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
  /**
   * Só revisor1/revisor2 — contexto do "Continuar revisão" (títulos dos erros já
   * destacados em rodadas anteriores). Quando presente, vai pro agente como
   * `previousRevisorErrors` ("não relista esses"). Snapshot vindo do job da fila.
   */
  previousRevisorErrors?: string[],
): Promise<StepOutput> {
  const r = getRoteiro(roteiroId);
  if (!r) throw new Error("Roteiro não encontrado (foi excluído?).");
  // Self-heal: se o stream travar (watchdog), refaz a chamada inteira (estrutura/
  // revisor/overview) até MAX_STALL_RETRIES antes de errar — a roteirista não
  // reclica. Idempotente: cada tentativa re-fetcha com os mesmos inputs (nada é
  // mutado antes da resposta chegar).
  return withStallRetry(
    () => {
      if (isRevisorStep(step))
        return runRevisorStep(r, step, userInput, hooks, previousRevisorErrors);
      if (step === "overview") return runOverviewStep(r, userInput, hooks);
      return runEstruturaStep(r, step, userInput, hooks);
    },
    hooks.signal,
    hooks.onPhase,
  );
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
      roteiroId: r.id,
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
    body: JSON.stringify({ premissa, roteiroId }),
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
        roteiroId: r.id,
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
      roteiroId: r.id,
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
      roteiroId: r.id,
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

  const part = step === "estrutura1" ? "Parte 1" : "Parte 2";

  // Backstop de TRUNCAMENTO da Estrutura: quando o socket do `claude.exe` cai
  // "limpo" no meio do stream (encerra cedo SEM injetar [ERRO] — pressão de
  // memória na máquina fraca da roteirista), a Estrutura sai com menos capítulos
  // que o mínimo da categoria (ex.: 4 de 6). Sem isto, a Escrita gerava fiel aos
  // poucos caps (~8k palavras em vez de ~12k; "poucos capítulos, contagem não
  // bate no Docs") e NADA conferia — o [ERRO] acima só pega queda COM marcador, e
  // o guard de completude da Escrita só dispara com a Parte VAZIA. Trata como
  // transiente → withStallRetry refaz a chamada inteira (idempotente); esgotadas
  // as tentativas, o job erra ("Gerar novamente") em vez de salvar a Estrutura
  // curta. Bug recorrente da máquina fraca (socket cai no meio da Estrutura), 16/07/2026.
  const gotChapters = countChaptersInEstrutura(acc);
  const minChapters = expectedMinChapters(part, r.category);
  if (gotChapters < minChapters) {
    throw new TransientStreamError(
      `A estrutura da ${part} saiu truncada (${gotChapters} de ${minChapters} capítulos esperados). O stream provavelmente caiu no meio — tentando gerar de novo.`,
    );
  }

  // Trava determinística: garante que os alvos por capítulo somem dentro da
  // faixa total da Parte (o modelo costuma estourar quando o prompt usa
  // placeholders em vez de números fixos). Reescala silenciosamente se preciso.
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
  previousRevisorErrors?: string[],
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

  // Relatório enxuto SEMPRE — inclusive na 1ª passada. Como OUTPUT domina o
  // wall-clock e só 3 coisas do relatório são consumidas por código (o bloco
  // <erros_detalhados>, a NOTA FINAL e a lista PRINCIPAIS ERROS — ver
  // lib/parse-revisor-output.ts), o ensaio (Sugestões Práticas / Análise como
  // Leitor / Melhorias) é texto só pra leitura e custa caro. O modo enxuto já
  // preserva o que importa (erros + NOTA + ANÁLISE/RISCO DE HATER, travados em
  // buildLeanReportInstruction). Antes só ligava da 2ª passada em diante; a
  // roteirista optou por enxugar já na 1ª pra acelerar a revisão (ver MEMORY.md
  // / CLAUDE.md). Espelha o branch "Continuar revisão" do StepShell, que também
  // manda leanRevisorReport: true (mantenha os dois em sincronia).
  const res = await fetch(`/api/agent/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: r.category,
      roteiroId: r.id,
      previousOutputs: r.outputs,
      userInput,
      referenceImage: r.referenceImage,
      ...(r.canone?.trim() ? { canone: r.canone } : {}),
      ...(previousRevisorErrors && previousRevisorErrors.length > 0
        ? { previousRevisorErrors }
        : {}),
      leanRevisorReport: true,
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
          roteiroId: r.id,
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
