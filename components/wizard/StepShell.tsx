"use client";

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  FileText,
  Loader2,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import {
  STEP_LABELS,
  STEP_ORDER,
  isRevisorStep,
  nextStep,
  partOfRevisorStep,
  prevStep,
  type BatchMissingChapters,
  type EscritaChapter,
  type EscritaSynopsis,
  type RevisorError,
  type StepId,
  type StepOutput,
} from "@/types/roteiro";
import { useWizard } from "@/store/wizard";
import { useDraft } from "@/lib/use-draft";
import { getAgent } from "@/lib/agents";
import { CATEGORIES } from "@/lib/categories";
import { DEFAULT_CATEGORY } from "@/types/roteiro";
import {
  filterMemoryBlockForDisplay,
  parseEscritaChaptersDirect,
} from "@/lib/parse-escrita-output";
import {
  countMarkdownErrorNumbers,
  hashEscritaContent,
  parseMarkdownErrorList,
  parseRevisorErrors,
  serializeRevisorErrors,
  stripErrosDetalhados,
} from "@/lib/parse-revisor-output";
import {
  applyCorrectionPatches,
  parseCorrectionPatches,
} from "@/lib/parse-correction-patches";
import { mergeContinuation } from "@/lib/parse-continuation-overlap";
import { RevisorErrorsView } from "@/components/wizard/RevisorErrorsView";
import {
  countChaptersInEstrutura,
  planBatches,
} from "@/lib/parse-estrutura-chapters";
import { parseEscritaBatch } from "@/lib/parse-escrita-batch";
import {
  extractChapterTargets,
  isWithinTarget,
} from "@/lib/parse-estrutura-targets";
import { MemoryVivaCard } from "@/components/wizard/MemoryVivaCard";
import { WordCountBadge } from "@/components/wizard/WordCountBadge";
// countWords sempre da lib canônica — mesmo contador que a UI usa pra
// exibir os totais. Ver CLAUDE.md seção "Contagem de palavras".
import { countWords } from "@/lib/word-count";
import { HistoryPanel } from "@/components/wizard/HistoryPanel";
import { DownloadEscritaButton } from "@/components/wizard/DownloadEscritaButton";
import { CopyPartButton } from "@/components/wizard/CopyPartButton";
import { ReferenceImageUpload } from "@/components/wizard/ReferenceImageUpload";
import { CanoneCard } from "@/components/wizard/CanoneCard";
import { Prose } from "@/components/ui/prose";
import { cn } from "@/lib/utils";

// Lê um stream do servidor acumulando o texto e atualizando o liveStream no
// máximo 1×/frame (~60Hz). Sem o throttle, cada chunk disparava setState com
// a string crescendo + re-render do React — em batches longos da Escrita isso
// virava pressão de memória O(n²) que crashava o renderer (OOM exit -36861).
//
// `onCheckpoint` (opcional): callback chamado a cada `checkpointMs` ms (default
// 2500ms) com o `acc` corrente. Usado pelos steps Estrutura P1/P2 pra persistir
// o output parcial em localStorage durante o stream — assim, se o app é
// fechado/freeze no meio, ao reabrir o roteiro o texto parcial está preservado
// e a UI oferece "Continuar de onde parou". Frequência baixa (2-3s) é
// intencional: o setOutput no callback dispara scheduleSave (debounce 600ms +
// lz-string compress), e chamar isso a cada chunk derruba o renderer com OOM.
async function readStreamThrottled(
  res: Response,
  setLive: (v: string) => void,
  signal?: AbortSignal,
  onCheckpoint?: (text: string) => void,
  checkpointMs: number = 2500,
): Promise<string> {
  if (!res.body) throw new Error("Stream sem corpo");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let acc = "";
  let pending: string | null = null;
  let rafId: number | null = null;
  const flush = () => {
    if (pending !== null) setLive(pending);
    pending = null;
    rafId = null;
  };
  let checkpointId: ReturnType<typeof setInterval> | null = null;
  let lastCheckpointed = "";
  if (onCheckpoint) {
    checkpointId = setInterval(() => {
      if (acc.length > 0 && acc !== lastCheckpointed) {
        lastCheckpointed = acc;
        onCheckpoint(acc);
      }
    }, checkpointMs);
  }
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      pending = acc;
      if (rafId === null && typeof requestAnimationFrame !== "undefined") {
        rafId = requestAnimationFrame(flush);
      }
    }
  } finally {
    if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(rafId);
    }
    if (checkpointId !== null) clearInterval(checkpointId);
    // Último checkpoint garante que se o stream terminar entre dois ticks do
    // intervalo, o partial mais recente seja persistido (ainda como partial —
    // o callsite limpa o flag depois quando concluir o concat final).
    if (onCheckpoint && acc.length > 0 && acc !== lastCheckpointed) {
      onCheckpoint(acc);
    }
    setLive(acc);
  }
  return acc;
}

type WizardProgress =
  | {
      kind: "writing";
      batchIndex: number;
      totalBatches: number;
      part: "Parte 1" | "Parte 2";
      chapters: number[];
    }
  | {
      kind: "revising";
      chaptersCount: number;
    };

const PART_BANNER = (part: string) =>
  `═══════════════════════════════════════\n${part.toUpperCase()}\n═══════════════════════════════════════`;

// Contador de palavras: SEMPRE `countWords` de @/lib/word-count.
// Importado acima. NUNCA criar outro contador local — split(/\s+/) ingênuo
// conta diferente porque não trata `—`, `–`, `-` (separadores em diálogo).
// Toda divergência entre o contador do backend e o da UI vira bug de
// fix-wordcount/balance pedindo expansão errada.

function concatenateChapters(chapters: EscritaChapter[]): string {
  const blocks: string[] = [];
  let currentPart: string | undefined;
  for (const c of chapters) {
    if (c.part && c.part !== currentPart) {
      blocks.push(PART_BANNER(c.part));
      currentPart = c.part;
    }
    const header = c.title
      ? `# Capítulo ${c.number} — ${c.title}`
      : `# Capítulo ${c.number}`;
    blocks.push(`${header}\n\n${c.content.trim()}`);
  }
  return blocks.join("\n\n");
}

interface Props {
  step: StepId;
}

export function StepShell({ step }: Props) {
  const roteiro = useWizard((s) => s.roteiro);
  const isGenerating = useWizard((s) => s.isGenerating);
  const autoAdvance = useWizard((s) => s.autoAdvance);
  const setAutoAdvance = useWizard((s) => s.setAutoAdvance);
  const setIsGenerating = useWizard((s) => s.setIsGenerating);
  const setOutput = useWizard((s) => s.setOutput);
  const updateOutputContent = useWizard((s) => s.updateOutputContent);
  const setUserInput = useWizard((s) => s.setUserInput);
  const clearDraft = useWizard((s) => s.clearDraft);
  const setCurrentStep = useWizard((s) => s.setCurrentStep);
  const pushOutputToHistory = useWizard((s) => s.pushOutputToHistory);

  const category = roteiro?.category ?? DEFAULT_CATEGORY;
  const agent = getAgent(category, step);
  const output = roteiro?.outputs[step];
  const idx = STEP_ORDER.indexOf(step);
  const prev = prevStep(step);
  const next = nextStep(step);

  const [draft, setDraft] = useState(output?.content ?? "");
  const [liveStream, setLiveStream] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<WizardProgress | null>(
    null,
  );
  // Fase corrente do Revisor — usado nos steps "revisor1"/"revisor2".
  // "streaming" durante o /api/agent/revisorN; "extracting" durante o
  // fallback automático /api/revisor-extract-errors. Mostrado no
  // BatchProgressPanel pra usuária saber em qual etapa do fluxo está (sem
  // isso a tela parece "em branco" por 1-2min entre clique e primeiro chunk
  // + 3min de fallback).
  const [revisorPhase, setRevisorPhase] = useState<
    "streaming" | "extracting" | null
  >(null);
  // Tempo decorrido desde o início da geração corrente, em segundos. Zera
  // quando isGenerating cai pra false. Atualiza a cada 1s via useEffect.
  const [elapsedSec, setElapsedSec] = useState(0);
  // Input/correção salvo desse step específico — input de outro step NÃO
  // vaza pra cá. Roteiros antigos (campo legado `userInput` único, global
  // pro roteiro) começam com input vazio em todos os steps; o legado é
  // ignorado pra evitar exatamente o problema de "o texto aparece em todos
  // os steps".
  const savedStepInput = roteiro?.userInputs?.[step] ?? "";
  // Limpa progresso local quando o usuário troca de step. Sem isso, um
  // batchProgress da Escrita (kind:"writing") fica visível no Revisor se
  // o usuário navegar durante uma geração — a UI mostraria "Par X de Y"
  // dentro do step Revisor, dando a falsa impressão de que a extensão
  // está rodando junto com a Escrita.
  useEffect(() => {
    setBatchProgress(null);
    setLiveStream("");
    setRevisorPhase(null);
  }, [step]);
  const abortRef = useRef<AbortController | null>(null);
  // Início da geração corrente — usado pra calcular elapsedSec no painel.
  // Setado em generate() quando isGenerating vira true, lido aqui no tick.
  const generationStartRef = useRef<number | null>(null);

  // Tick a cada segundo enquanto está gerando — alimenta o elapsedSec
  // mostrado no BatchProgressPanel. Zera quando isGenerating cai pra false
  // pra não vazar timer entre rodadas.
  useEffect(() => {
    if (!isGenerating) {
      setElapsedSec(0);
      setRevisorPhase(null);
      return;
    }
    const start = generationStartRef.current ?? Date.now();
    const tick = () =>
      setElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isGenerating]);

  // Em caso de auto-reload do Electron (ver crash handler em main.js), aborta
  // streams em flight pra liberar a memória que o renderer estava acumulando
  // antes de morrer. Sem isso, o reload partiria com requests órfãs ao server.
  useEffect(() => {
    const handler = () => abortRef.current?.abort();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const previousOutputsSummary = useMemo(() => {
    if (!roteiro) return [];
    return STEP_ORDER.slice(0, idx).map((s) => ({
      id: s,
      label: STEP_LABELS[s],
      content: roteiro.outputs[s]?.content ?? "",
    }));
  }, [roteiro, idx]);

  const hasContent = !!output?.content;
  const hasMetadata = !!(
    output?.metadata?.report ||
    output?.metadata?.memory ||
    output?.metadata?.validation
  );
  const validationStatus = output?.metadata?.validationStatus;

  const chapters = output?.metadata?.chapters ?? [];
  const chapterCount = chapters.length;
  // Capítulos esperados conforme estruturas aprovadas (Step 2 + Step 3) —
  // usado pra avisar visualmente quando a Escrita pulou cap (banner do
  // BatchWarningsBanner cobre o caso por batch; aqui é o contador no topo
  // do textarea de instruções, que indica o estado geral do roteiro).
  const expectedChapterCount = useMemo(() => {
    if (step !== "escrita") return 0;
    return (
      countChaptersInEstrutura(roteiro?.outputs.estrutura1?.content) +
      countChaptersInEstrutura(roteiro?.outputs.estrutura2?.content)
    );
  }, [step, roteiro?.outputs.estrutura1?.content, roteiro?.outputs.estrutura2?.content]);
  // Map (part, number) → target de palavras pro feedback ±3% nos cap cards.
  // Sem isso, a UI mostra a contagem real sem sinal visual de se está dentro
  // do esperado da estrutura — o usuário só descobre via Revisor (~5min).
  //
  // extractChapterTargets pode retornar múltiplos entries com mesmo `number`
  // se a estrutura tiver linhas tipo "Capítulo 1, primeira metade (~1.000
  // palavras)" — submenções que casam com o regex tolerante. Pegamos só o
  // PRIMEIRO entry de cada number (que é o header principal `## Capítulo N`,
  // por estar mais alto no texto). Sem isso, o alvo do cap principal era
  // sobrescrito pelo alvo de uma sub-cena.
  const chapterTargets = useMemo(() => {
    if (step !== "escrita") return new Map<string, number>();
    const map = new Map<string, number>();
    const t1 = extractChapterTargets(roteiro?.outputs.estrutura1?.content);
    const t2 = extractChapterTargets(roteiro?.outputs.estrutura2?.content);
    for (const t of t1) {
      const key = `Parte 1:${t.number}`;
      if (typeof t.target === "number" && !map.has(key)) map.set(key, t.target);
    }
    for (const t of t2) {
      const key = `Parte 2:${t.number}`;
      if (typeof t.target === "number" && !map.has(key)) map.set(key, t.target);
    }
    return map;
  }, [step, roteiro?.outputs.estrutura1?.content, roteiro?.outputs.estrutura2?.content]);
  const generateLabel = useMemo(() => {
    if (step === "escrita")
      return hasContent ? "Gerar roteiro novamente" : "Gerar roteiro completo";
    return hasContent ? "Gerar novamente" : "Gerar";
  }, [step, hasContent]);

  const historyStack = roteiro?.history?.[step] ?? [];

  // Faixa-alvo de palavras por step pro WordCountBadge — agora category-aware:
  // soma os totais de P1+P2 da categoria atual (milionário ≠ máfia).
  const wordCountTarget = useMemo<{
    min?: number;
    max?: number;
    label?: string;
  }>(() => {
    if (step === "escrita") {
      const wc = CATEGORIES[category].wordCount;
      return {
        min: wc.parte1.min + wc.parte2.min,
        max: wc.parte1.max + wc.parte2.max,
        label: "Total",
      };
    }
    return {};
  }, [step, category]);

  const generate = useCallback(async (
    /**
     * - `regenerate` (default): zera o output e gera do zero.
     * - `refine`: ajuste pontual em cima da versão corrente (find+replace por
     *   patches no agente).
     * - `continue` (Estrutura P1/P2 apenas): retoma uma geração anterior que
     *   foi interrompida no meio do stream. Lê o output parcial corrente,
     *   manda pro agente como `currentOutput` com `continuationMode: true`,
     *   e ao terminar concatena partial + delta (com detecção de overlap pra
     *   descartar texto duplicado caso o modelo redundantemente repita).
     *   NÃO faz pushToHistory — o partial é a mesma geração sendo terminada.
     */
    mode: "regenerate" | "refine" | "continue" = "regenerate",
    userInputOverride?: string,
    historyLabel?: string,
    /**
     * Modo "Continuar revisão" do step Revisor — quando true, agrega os
     * títulos dos erros já destacados em rodadas anteriores (output corrente +
     * todos os snapshots no histórico) e envia pro agente como
     * `previousRevisorErrors`. O prompt do Revisor usa essa lista pra evitar
     * relistar erros equivalentes — força refinamento incremental rodada
     * após rodada. Só relevante pros steps "revisor1"/"revisor2"; outros ignoram.
     */
    continuation?: boolean,
  ) => {
    if (!roteiro) return;

    // userInput pode vir do store OU de um override (caso o caller acabou
    // de comitar via setUserInput e ainda não viu o re-render do Zustand —
    // ex.: botão "Aplicar correção" da caixa, que comita+dispara num clique).
    // Lê só o input desse step específico — input de outro step NÃO vaza
    // pra essa chamada.
    //
    // Draft do textarea de "Instruções adicionais" tem prioridade sobre
    // userInputs[step]: o draft só persiste quando pending !== committed
    // (lib/use-draft.ts), logo é por definição mais novo. Sem ler draft, a
    // primeira geração antes de qualquer "Aplicar correção" ignora silenciosa-
    // mente o que o usuário digitou.
    const draftInput = (
      (roteiro.drafts?.[step] as { input?: string } | undefined)?.input ?? ""
    ).trim();
    const committedInput = (roteiro.userInputs?.[step] ?? "").trim();
    const effectiveUserInput =
      userInputOverride !== undefined
        ? userInputOverride.trim()
        : draftInput || committedInput;

    // Modo correção precisa de output existente + instrução escrita.
    if (mode === "refine") {
      if (!output?.content?.trim() || !effectiveUserInput) return;
    }

    // Modo "Continuar revisão": agrega os títulos dos erros já destacados em
    // rodadas anteriores — output corrente (prestes a virar histórico) +
    // todos os snapshots já no histórico — pra mandar pro agente como
    // contexto "não repita". Captura ANTES de qualquer setState porque o
    // pushOutputToHistory + setOutput("") vão zerar `output` em seguida.
    // Escopado por step: erros de revisor1 não vazam pra revisor2 e
    // vice-versa (cada revisor tem seu próprio histórico).
    let previousRevisorErrors: string[] | undefined;
    if (continuation && isRevisorStep(step)) {
      const seen = new Set<string>();
      const aggregate: string[] = [];
      const pushIfNew = (e: RevisorError) => {
        const loc: string[] = [];
        if (typeof e.parte === "number") loc.push(`Parte ${e.parte}`);
        if (typeof e.capitulo === "number") loc.push(`Cap. ${e.capitulo}`);
        const locStr = loc.length > 0 ? ` (${loc.join(", ")})` : "";
        const gravLabel =
          e.gravidade === "gravissimo"
            ? "Gravíssimo"
            : e.gravidade === "interfere"
              ? "Interfere"
              : e.gravidade === "atencao"
                ? "Atenção"
                : "Não interfere";
        const formatted = `${e.titulo.trim()}${locStr} [${gravLabel}]`;
        // Dedup por título+localização — se a mesma issue ressurgiu em rodadas
        // diferentes, manda só uma vez (o agente já entende que não pode repetir).
        const key = formatted.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        aggregate.push(formatted);
      };
      // Output corrente (rodada que está sendo arquivada agora).
      if (output?.metadata?.errors) {
        for (const e of output.metadata.errors) pushIfNew(e);
      }
      // Snapshots históricos (rodadas anteriores já arquivadas) — só do step
      // ativo, sem cruzar revisor1/revisor2.
      const history = roteiro.history?.[step] ?? [];
      for (const snap of history) {
        if (snap.metadata?.errors) {
          for (const e of snap.metadata.errors) pushIfNew(e);
        }
      }
      if (aggregate.length > 0) previousRevisorErrors = aggregate;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Modo "continue" só faz sentido pra Estrutura P1/P2 com partial preservado.
    // Bloqueia silenciosamente em outros casos pra evitar prompts inválidos.
    if (mode === "continue") {
      const isEstrutura = step === "estrutura1" || step === "estrutura2";
      if (!isEstrutura || !output?.content?.trim()) return;
    }

    // Antes de gerar, salva o output atual no histórico (incluindo Escrita
    // 2-em-2 — a versão anterior é preservada). Em modo correção também
    // salvamos pra que a roteirista possa voltar pra versão antes da correção.
    // Em modo "continue", NÃO salvamos: o partial não é uma versão anterior,
    // é a MESMA geração sendo terminada — vai virar o output final por concat.
    const baseContent = output?.content?.trim() ?? "";
    if (baseContent && mode !== "continue") {
      pushOutputToHistory(
        step,
        historyLabel ?? (mode === "refine" ? "Antes da correção" : undefined),
      );
    }

    // Pra correção pontual da Escrita, o agente devolve APENAS os capítulos
    // que mudaram — precisamos dos existentes pra fazer merge depois.
    const previousChapters: EscritaChapter[] =
      output?.metadata?.chapters ? [...output.metadata.chapters] : [];
    const previousSynopsesAll: EscritaSynopsis[] =
      output?.metadata?.synopses ? [...output.metadata.synopses] : [];

    setIsGenerating(true);
    setLiveStream("");
    setBatchProgress(null);
    setRevisorPhase(null);
    generationStartRef.current = Date.now();
    setElapsedSec(0);
    const startedAt = new Date().toISOString();

    // Em correção pontual (qualquer step), NÃO zere o output corrente:
    //  - Escrita: a resposta é parcial (só os caps corrigidos) — o resto
    //    do roteiro precisa continuar exibido durante a chamada.
    //  - Estrutura 1/2 e Revisor: a resposta é só patches <alteracao> que
    //    o frontend aplica no output atual via find+replace literal.
    // O stream parcial vai pra liveStream (área secundária) e só a
    // finalização toca no output de fato (merge da Escrita ou apply dos
    // patches dos demais).
    const isRefine = mode === "refine";
    const isContinue = mode === "continue";
    const isEscritaRefine = step === "escrita" && isRefine;
    const isEstruturaStep = step === "estrutura1" || step === "estrutura2";
    // Em modo "continue", o partialBase é o que já está no output e vai ser
    // concatenado com o delta da continuação no fim do stream (com detecção
    // de overlap pra evitar texto duplicado se o modelo redundantemente
    // repetir). Pros demais modos, partialBase = "" (regen do zero ou refine).
    const partialBase = isContinue ? (output?.content ?? "") : "";
    if (!isRefine) {
      setDraft("");
      if (isContinue) {
        // Mantém o partial visível durante a continuação. Re-marca partial:true
        // pra que checkpoints intermediários e o estado de interrupção fiquem
        // consistentes (se a continuação também for interrompida, ainda vê o
        // banner de "geração interrompida").
        setOutput(step, {
          content: partialBase,
          metadata: {
            ...(output?.metadata ?? {}),
            partial: true,
            streamingStartedAt: startedAt,
          },
          generatedAt: output?.generatedAt ?? startedAt,
        });
      } else if (isEstruturaStep) {
        // Regenerate do zero pra Estrutura 1/2: zera o conteúdo MAS já marca
        // partial:true. Assim, se for interrompido durante o stream, o partial
        // checkpointed fica consistentemente flagged e a UI oferece "continuar
        // de onde parou" ao invés de mostrar nada.
        setOutput(step, {
          content: "",
          metadata: { partial: true, streamingStartedAt: startedAt },
          generatedAt: startedAt,
        });
      } else {
        setOutput(step, { content: "", generatedAt: startedAt });
      }
    }

    // ─── Branch Escrita: loop 2-em-2 (sem fix-wordcount nem revisor) ────
    // Calibração de palavras e revisão gramatical/estrutural acontecem no
    // step Revisor — aqui só geramos os capítulos.
    //
    // Em modo correção, pulamos o loop 2-em-2 e caímos no branch padrão
    // (1 chamada com refineMode: true). O agente da Escrita devolve o
    // roteiro inteiro corrigido em uma única passada.
    if (step === "escrita" && mode !== "refine") {
      const estrutura1 = roteiro.outputs.estrutura1?.content;
      const estrutura2 = roteiro.outputs.estrutura2?.content;
      const totalP1 = countChaptersInEstrutura(estrutura1);
      const totalP2 = countChaptersInEstrutura(estrutura2);

      if (totalP1 === 0 || totalP2 === 0) {
        // Quando a detecção falha, mostra um snippet da estrutura faltante pra
        // a roteirista entender o que está na estrutura — facilita decidir se
        // edita à mão ou regenera.
        const failingPart =
          totalP1 === 0 && totalP2 === 0
            ? "Partes 1 e 2"
            : totalP1 === 0
              ? "Parte 1"
              : "Parte 2";
        const failingContent =
          totalP1 === 0
            ? estrutura1
            : estrutura2;
        const snippet = (failingContent ?? "")
          .trim()
          .slice(0, 600)
          .trim();
        const snippetBlock = snippet
          ? `\n\n━━━ Trecho atual da ${totalP1 === 0 ? "Estrutura da Parte 1" : "Estrutura da Parte 2"} (primeiros 600 caracteres) ━━━\n\n${snippet}${snippet.length >= 600 ? "\n[...]" : ""}`
          : `\n\n⚠️ A ${failingPart} está vazia — gere a estrutura no step anterior antes de tentar a Escrita.`;
        setOutput(step, {
          content: `[ERRO] Não consegui detectar capítulos na ${failingPart}. Detectei: Parte 1 = ${totalP1} capítulos, Parte 2 = ${totalP2} capítulos.\n\nO parser aceita várias formas de cabeçalho ("## Capítulo 1 — Título", "Capítulo 1 — Título", "**Capítulo 1**", "Cap. 1") desde que comecem no início da linha. Se o seu modelo gerou os capítulos com outra palavra (ex.: "Etapa", "Cena") ou dentro de uma tabela, a Escrita não consegue planejar os batches.\n\n💡 Como resolver:\n• Volte ao Step ${totalP1 === 0 ? "2" : "3"}, clique em "Editar" na estrutura e renomeie cada cabeçalho pro padrão "## Capítulo N — Título"\n• Ou clique em "Gerar novamente" no Step ${totalP1 === 0 ? "2" : "3"} pra regenerar a estrutura no formato correto${snippetBlock}`,
          generatedAt: startedAt,
        });
        setIsGenerating(false);
        return;
      }

      // planBatches ainda usa targets pra dar contexto ao agente, mas a UI
      // não mais checa programaticamente o output — a calibração é feita
      // pelo step Revisor. Targets de fallback respeitam a categoria atual.
      const targetsP1Raw = extractChapterTargets(estrutura1);
      const targetsP2Raw = extractChapterTargets(estrutura2);
      const targetP1Total = CATEGORIES[category].wordCount.parte1.target;
      const targetP2Total = CATEGORIES[category].wordCount.parte2.target;
      const targetsP1 = Array.from({ length: totalP1 }, (_, i) =>
        targetsP1Raw.find((t) => t.number === i + 1)?.target ??
        Math.round(targetP1Total / totalP1),
      );
      const targetsP2 = Array.from({ length: totalP2 }, (_, i) =>
        targetsP2Raw.find((t) => t.number === i + 1)?.target ??
        Math.round(targetP2Total / totalP2),
      );

      const plan = planBatches(totalP1, totalP2, targetsP1, targetsP2, category);
      const accChapters: EscritaChapter[] = [];
      const accSynopses: EscritaSynopsis[] = [];
      // Warnings de batches em que o agente Escrita emitiu menos cabeçalhos
      // `## Capítulo N` do que os esperados pelo plano. Detecta o caso em que
      // o agente "engole" um cap silenciosamente — sem isso o usuário só
      // descobre no Revisor depois de gastar 30+ minutos do pipeline.
      const accBatchWarnings: BatchMissingChapters[] = [];

      // ─── helpers locais ──────────────────────────────────────────────
      const readStreamFully = (res: Response) =>
        readStreamThrottled(res, setLiveStream, ctrl.signal);

      const persist = () => {
        const newContent = concatenateChapters(accChapters);
        setOutput(step, {
          content: newContent,
          metadata: {
            chapters: [...accChapters],
            synopses: [...accSynopses],
            ...(accBatchWarnings.length > 0
              ? { batchWarnings: [...accBatchWarnings] }
              : {}),
          },
          generatedAt: startedAt,
        });
        setDraft(newContent);
      };

      const failBatch = async (msg: string, batchIdx: number) => {
        const errContent =
          accChapters.length > 0
            ? `${concatenateChapters(accChapters)}\n\n[ERRO no Par ${batchIdx} de ${plan.length}] ${msg}`
            : `[ERRO no Par ${batchIdx} de ${plan.length}] ${msg}`;
        setOutput(step, {
          content: errContent,
          metadata: { chapters: accChapters, synopses: accSynopses },
          generatedAt: startedAt,
        });
      };

      try {
        // ═══ Loop 2-em-2: gera batches e acumula ════════════════════════
        for (const b of plan) {
          if (ctrl.signal.aborted) break;
          setBatchProgress({
            kind: "writing",
            batchIndex: b.batchIndex,
            totalBatches: plan.length,
            part: b.part,
            chapters: b.chapters,
          });
          setLiveStream("");

          const res = await fetch(`/api/agent/${step}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              category,
              previousOutputs: roteiro.outputs,
              userInput: effectiveUserInput,
              referenceImage: roteiro.referenceImage,
              ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
              batch: {
                part: b.part,
                chapters: b.chapters,
                totalInPart: b.totalInPart,
                batchIndex: b.batchIndex,
                totalBatches: plan.length,
              },
              previousSynopses: accSynopses,
            }),
            signal: ctrl.signal,
          });

          if (!res.ok || !res.body) {
            await failBatch(
              (await res.text()) || res.statusText,
              b.batchIndex,
            );
            setIsGenerating(false);
            setBatchProgress(null);
            return;
          }

          const acc = await readStreamFully(res);
          if (ctrl.signal.aborted) break;

          const parsed = parseEscritaBatch(acc, b.part);

          // Sanity check: se o parser caiu no fallback (cap número 0)
          // significa que o modelo não devolveu cabeçalho `## Capítulo N`.
          // Não tem sentido tentar fix-wordcount em cima disso. Para o
          // loop com erro claro pra a roteirista regenerar.
          const fallbackOnly = parsed.chapters.every((c) => c.number === 0);
          if (fallbackOnly && parsed.chapters.length > 0) {
            await failBatch(
              `O modelo não seguiu o formato esperado (sem cabeçalhos "## Capítulo N — Título"). Tente regenerar o batch.`,
              b.batchIndex,
            );
            setIsGenerating(false);
            setBatchProgress(null);
            return;
          }

          if (ctrl.signal.aborted) break;

          // Detecta caps que o batch deveria ter mas o agente não emitiu.
          // Compara b.chapters esperados vs numbers parseados (ignora 0 do
          // fallback). Se faltar algum, registra warning visível pro usuário.
          const expectedNumbers = b.chapters;
          const gotNumbers = new Set(
            parsed.chapters.map((c) => c.number).filter((n) => n > 0),
          );
          const missingNumbers = expectedNumbers.filter(
            (n) => !gotNumbers.has(n),
          );
          if (missingNumbers.length > 0) {
            accBatchWarnings.push({
              batchIndex: b.batchIndex,
              part: b.part,
              expected: expectedNumbers,
              missing: missingNumbers,
            });
          }

          accChapters.push(...parsed.chapters);
          accSynopses.push(...parsed.synopses);
          persist();
        }

        if (ctrl.signal.aborted) {
          setLiveStream("");
          setBatchProgress(null);
          setIsGenerating(false);
          return;
        }

        setLiveStream("");
        setBatchProgress(null);
        setIsGenerating(false);

        if (autoAdvance && next && !ctrl.signal.aborted) {
          setCurrentStep(next);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(err);
        }
        setIsGenerating(false);
        setBatchProgress(null);
      }
      return;
    }

    // ─── Branch Revisor: revisão XML estruturada (escopada por Parte) ────
    // Em modo correção, caímos no branch padrão (1 chamada com refineMode).
    // Cada step (revisor1, revisor2) processa SOMENTE os capítulos da sua
    // Parte. Isso evita revisões superficiais que ocorriam quando o agente
    // analisava P1 e P2 juntas e (a) deixava passar erros graves, (b)
    // introduzia inconsistências cruzadas — sugestões para a P2 que
    // contradiziam escolhas da P1 e vice-versa.
    if (isRevisorStep(step) && mode !== "refine") {
      const revisorPart = partOfRevisorStep(step);
      const partLabel = revisorPart === 1 ? "Parte 1" : "Parte 2";
      const escritaOutput = roteiro.outputs.escrita;
      const allChapters: EscritaChapter[] = escritaOutput?.metadata?.chapters
        ? [...escritaOutput.metadata.chapters]
        : [];
      // Filtra só os capítulos da Parte alvo. Capítulos sem `part` viram
      // Parte 1 (mesmo fallback usado na factory build-revisor-agent).
      const accChapters = allChapters.filter((ch) => {
        const chPart = ch.part ?? "Parte 1";
        return chPart === partLabel;
      });

      if (allChapters.length === 0) {
        setOutput(step, {
          content: `[ERRO] O Step 4 (Escrita) ainda não tem capítulos parseados — gere o roteiro completo antes de revisar.`,
          generatedAt: startedAt,
        });
        setIsGenerating(false);
        return;
      }
      if (accChapters.length === 0) {
        setOutput(step, {
          content: `[ERRO] O Step 4 (Escrita) não tem capítulos da ${partLabel} — gere o roteiro completo antes de revisar esta Parte.`,
          generatedAt: startedAt,
        });
        setIsGenerating(false);
        return;
      }

      try {
        setBatchProgress({
          kind: "revising",
          chaptersCount: accChapters.length,
        });
        setRevisorPhase("streaming");
        setLiveStream("");

        // Hash escopado pela Parte — editar capítulos da Parte 2 não
        // invalida a revisão da Parte 1, e vice-versa.
        const escritaContent = concatenateChapters(accChapters);
        const escritaSnapshotHash = hashEscritaContent(escritaContent);

        const res = await fetch(`/api/agent/${step}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            previousOutputs: roteiro.outputs,
            userInput: effectiveUserInput,
            referenceImage: roteiro.referenceImage,
            ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
            ...(previousRevisorErrors && previousRevisorErrors.length > 0
              ? { previousRevisorErrors }
              : {}),
          }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          const msg = await res.text();
          setOutput(step, {
            content: `[ERRO] ${msg || res.statusText}`,
            generatedAt: startedAt,
          });
          setIsGenerating(false);
          setBatchProgress(null);
          return;
        }

        // Throttle via RAF + escreve em liveStream (state local, sem persist).
        // Sem isso, cada chunk disparava setOutput → saveRoteiro → JSON.parse +
        // stringify do localStorage inteiro, OOM no renderer em outputs grandes
        // (Revisor escreve ~14k tokens). Custom setter mantém o XML
        // <erros_detalhados> escondido do preview ao vivo.
        const acc = await readStreamThrottled(
          res,
          (raw) => setLiveStream(stripErrosDetalhados(raw)),
          ctrl.signal,
        );

        if (ctrl.signal.aborted) {
          setLiveStream("");
          setBatchProgress(null);
          setIsGenerating(false);
          return;
        }

        // forcedPart faz o parser carimbar parte=N e prefixar id com pN-
        // (sem isso, IDs do revisor1 colidem com IDs do revisor2 — ambos
        // numeram a partir de 1 — e applyRevisorCorrections marca o erro
        // errado como aplicado).
        let errors = parseRevisorErrors(acc, revisorPart);
        const cleanContent = stripErrosDetalhados(acc);

        // Fallback: dispara extração estruturada quando o XML emitido
        // tem MENOS erros do que o markdown lista em PRINCIPAIS ERROS.
        // Casos:
        //   - errors=0 e markdown lista 5 → modelo esqueceu o XML inteiro
        //   - errors=1 e markdown lista 5 → modelo truncou o XML após o 1º
        //   - errors=N e markdown lista N → tudo OK, pula fallback
        const expectedCount = countMarkdownErrorNumbers(cleanContent);
        if (expectedCount > 0 && errors.length < expectedCount) {
          console.info(
            `[revisor] XML tem ${errors.length} erro(s), markdown lista ${expectedCount} — disparando fallback de extração estruturada`,
          );
          setRevisorPhase("extracting");
          try {
            const fbRes = await fetch("/api/revisor-extract-errors", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category,
                revisaoMarkdown: cleanContent,
                escritaContent,
              }),
              signal: ctrl.signal,
            });
            if (fbRes.ok && fbRes.body) {
              const fbReader = fbRes.body.getReader();
              const fbDecoder = new TextDecoder();
              let fbAcc = "";
              while (true) {
                const { done, value } = await fbReader.read();
                if (done) break;
                fbAcc += fbDecoder.decode(value, { stream: true });
              }
              const fallbackErrors = parseRevisorErrors(fbAcc, revisorPart);
              if (fallbackErrors.length > errors.length) {
                console.info(
                  `[revisor] fallback extraiu ${fallbackErrors.length} erro(s) (vs ${errors.length} originais) — usando fallback`,
                );
                errors = fallbackErrors;
              } else if (fallbackErrors.length > 0) {
                console.info(
                  `[revisor] fallback extraiu ${fallbackErrors.length} erro(s) — não supera os ${errors.length} originais, mantendo originais`,
                );
              } else {
                console.warn(
                  "[revisor] fallback rodou mas não devolveu erros parseáveis — mantendo originais",
                );
              }
            } else {
              console.warn(
                `[revisor] fallback HTTP ${fbRes.status} — mantendo ${errors.length} erro(s) originais`,
              );
            }
          } catch (fbErr) {
            if ((fbErr as Error).name !== "AbortError") {
              console.warn("[revisor] fallback falhou:", fbErr);
            }
          }
        }

        // Defesa final: se ainda há erros listados em PRINCIPAIS ERROS que
        // não viraram <erro> XML (nem o LLM principal nem o fallback do
        // servidor pegaram), gera cards informativos sintéticos parseando
        // o markdown direto. Garante que a roteirista vê TODOS os erros.
        const markdownErrors = parseMarkdownErrorList(cleanContent, revisorPart);
        const xmlNumbers = new Set(errors.map((e) => e.numero.toLowerCase()));
        const missingFromXml = markdownErrors.filter(
          (m) => !xmlNumbers.has(m.numero.toLowerCase()),
        );
        if (missingFromXml.length > 0) {
          console.info(
            `[revisor] ${missingFromXml.length} erro(s) listado(s) em PRINCIPAIS ERROS não viraram XML — adicionando como cards informativos`,
          );
          errors = [...errors, ...missingFromXml].sort((a, b) => {
            const na = parseInt(a.numero, 10);
            const nb = parseInt(b.numero, 10);
            if (Number.isNaN(na) || Number.isNaN(nb)) {
              return a.numero.localeCompare(b.numero);
            }
            return na - nb;
          });
        }

        setOutput(step, {
          content: cleanContent,
          metadata: {
            errors,
            escritaSnapshotHash,
          },
          generatedAt: startedAt,
        });
        setDraft(cleanContent);
        setLiveStream("");
        setBatchProgress(null);
        setIsGenerating(false);

        if (autoAdvance && next && !ctrl.signal.aborted) {
          setCurrentStep(next);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(err);
        }
        setIsGenerating(false);
        setBatchProgress(null);
      }
      return;
    }

    // ─── Branch padrão: 1 request, 1 stream ─────────────────────────────
    // Atende:
    //   - Premissa, Estrutura 1/2 (regenerate ou refine)
    //   - Escrita em modo REFINE (correção pontual: 1 chamada com refineMode,
    //     pula o loop 2-em-2)
    //   - Revisor em modo REFINE (correção pontual: 1 chamada com refineMode,
    //     pula a pré-fase de extensão/balance)
    // Pro Revisor refine, o agente precisa enxergar o XML <erros_detalhados>
    // pra poder mexer nele via patches. O `output.content` corrente foi
    // stripado do XML quando salvamos no store — reconstituímos a partir
    // de `metadata.errors` antes de enviar.
    const currentOutputForAgent =
      isRefine && isRevisorStep(step) && output?.metadata?.errors
        ? `${baseContent}\n\n${serializeRevisorErrors(output.metadata.errors)}`
        : baseContent;

    try {
      const res = await fetch(`/api/agent/${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          previousOutputs: roteiro.outputs,
          userInput: effectiveUserInput,
          referenceImage: roteiro.referenceImage,
          ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
          ...(mode === "refine" && {
            refineMode: true,
            currentOutput: currentOutputForAgent,
          }),
          ...(isContinue && {
            continuationMode: true,
            currentOutput: partialBase,
          }),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const msg = await res.text();
        setOutput(step, {
          content: `[ERRO] ${msg || res.statusText}`,
          generatedAt: startedAt,
        });
        setIsGenerating(false);
        return;
      }

      // Throttle via RAF + escreve em liveStream (state local). Cobre tanto
      // refine (mostra patches/<alteracao> chegando) quanto generate-do-zero
      // de Estrutura 1/2. Sem isso, cada chunk persistia o roteiro inteiro
      // no localStorage e o renderer estourava OOM em outputs grandes —
      // mesma classe de bug que derrubou Escrita antes do throttle.
      // Finalização (parsers/setOutput) acontece nos blocos abaixo, com `acc`
      // já completo.
      //
      // Pra Estrutura 1/2 não-refine, registramos um onCheckpoint a cada ~2.5s
      // que persiste o partial em localStorage com `partial:true`. Se o app é
      // fechado/freeze/crash no meio, ao reabrir o roteiro a UI detecta o flag
      // e oferece "Continuar de onde parou" — sem isso, todo o stream perdido
      // ficava em RAM apenas. Frequência baixa é intencional: setOutput
      // dispara scheduleSave (debounce 600ms + lz-string compress); chamar
      // a cada chunk derrubava o renderer (OOM exit -36861).
      const checkpointPartial =
        isEstruturaStep && !isRefine
          ? (text: string) =>
              setOutput(step, {
                content: isContinue ? partialBase + text : text,
                metadata: { partial: true, streamingStartedAt: startedAt },
                generatedAt: startedAt,
              })
          : undefined;
      const acc = await readStreamThrottled(
        res,
        setLiveStream,
        ctrl.signal,
        checkpointPartial,
      );

      if (ctrl.signal.aborted) {
        setIsGenerating(false);
        return;
      }

      // ── Finalização específica por step ────────────────────────────────

      if (isRevisorStep(step) && !isRefine && acc.trim()) {
        // Branch defensivo: o revisor tem caminho dedicado (acima, com return)
        // que escopa por Parte. Se por qualquer motivo a execução chegar
        // aqui, repetimos o parse com `forcedPart` derivado do step.
        const fallbackPart = partOfRevisorStep(step);
        // Geração do zero do Revisor: parse <erros_detalhados> pra popular
        // os cards de correção automática. Snapshot da Escrita pra detectar
        // drift na UI.
        let errors = parseRevisorErrors(acc, fallbackPart);
        const cleanContent = stripErrosDetalhados(acc);
        const escritaContent =
          roteiro.outputs.escrita?.content?.trim() ?? "";
        const escritaSnapshotHash = escritaContent
          ? hashEscritaContent(escritaContent)
          : undefined;

        if (
          errors.length === 0 &&
          /Erro\s*#?\s*\d+/i.test(cleanContent) &&
          escritaContent
        ) {
          console.info(
            "[revisor] XML <erros_detalhados> ausente — disparando fallback de extração estruturada",
          );
          try {
            const fbRes = await fetch("/api/revisor-extract-errors", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category,
                revisaoMarkdown: cleanContent,
                escritaContent,
              }),
              signal: ctrl.signal,
            });
            if (fbRes.ok && fbRes.body) {
              const fbReader = fbRes.body.getReader();
              const fbDecoder = new TextDecoder();
              let fbAcc = "";
              while (true) {
                const { done, value } = await fbReader.read();
                if (done) break;
                fbAcc += fbDecoder.decode(value, { stream: true });
              }
              const fallbackErrors = parseRevisorErrors(fbAcc, fallbackPart);
              if (fallbackErrors.length > 0) errors = fallbackErrors;
            }
          } catch (fbErr) {
            if ((fbErr as Error).name !== "AbortError") {
              console.warn("[revisor] fallback falhou:", fbErr);
            }
          }
        }

        // Defesa final: se ainda há erros listados em PRINCIPAIS ERROS que
        // não viraram <erro> XML (nem o LLM principal nem o fallback do
        // servidor pegaram), gera cards informativos sintéticos parseando
        // o markdown direto. Garante que a roteirista vê TODOS os erros
        // mesmo quando o XML é truncado/omitido na regeneração.
        const markdownErrors = parseMarkdownErrorList(cleanContent, fallbackPart);
        const xmlNumbers = new Set(errors.map((e) => e.numero.toLowerCase()));
        const missingFromXml = markdownErrors.filter(
          (m) => !xmlNumbers.has(m.numero.toLowerCase()),
        );
        if (missingFromXml.length > 0) {
          console.info(
            `[revisor regenerate] ${missingFromXml.length} erro(s) em PRINCIPAIS ERROS não viraram XML — adicionando como cards informativos`,
          );
          errors = [...errors, ...missingFromXml].sort((a, b) => {
            const na = parseInt(a.numero, 10);
            const nb = parseInt(b.numero, 10);
            if (Number.isNaN(na) || Number.isNaN(nb)) {
              return a.numero.localeCompare(b.numero);
            }
            return na - nb;
          });
        }

        setOutput(step, {
          content: cleanContent,
          metadata: {
            errors,
            ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
          },
          generatedAt: startedAt,
        });
        setDraft(cleanContent);
      } else if (
        isRefine &&
        (step === "estrutura1" ||
          step === "estrutura2" ||
          isRevisorStep(step)) &&
        acc.trim()
      ) {
        // Correção pontual em Estrutura 1, Estrutura 2 ou Revisor: o agente
        // devolve apenas pares <alteracao>/<original>/<corrigido>. Aplicamos
        // via find+replace literal no output corrente — trechos não tocados
        // permanecem byte-a-byte. Pra Revisor, o XML <erros_detalhados> faz
        // parte da base do patch (foi reconstituído via serializeRevisorErrors
        // antes da chamada) e os erros são reparseados ao final.
        const trimmed = acc.trim();

        if (/\[NENHUMA_ALTERACAO_NECESSARIA\]/i.test(trimmed)) {
          console.info(
            `[${step} refine] agente respondeu NENHUMA_ALTERACAO_NECESSARIA — mantendo output intacto`,
          );
          setLiveStream("");
        } else {
          const patches = parseCorrectionPatches(trimmed);
          if (patches.length === 0) {
            console.warn(
              `[${step} refine] nenhum bloco <alteracao> detectado — descartando resposta`,
            );
            setOutput(step, {
              content: output?.content ?? "",
              metadata: {
                ...(output?.metadata ?? {}),
                parseWarning:
                  "A correção não pôde ser aplicada — o agente respondeu em formato inesperado. Tente uma instrução mais específica.",
              },
              generatedAt: output?.generatedAt ?? startedAt,
            });
            setLiveStream("");
          } else {
            // Pro Revisor, base inclui o XML reconstituído (mesma string que
            // foi enviada ao agente). Pros demais, base = output.content cru.
            const patchBase = currentOutputForAgent;
            const result = applyCorrectionPatches(patchBase, patches);
            console.info(
              `[${step} refine] aplicados ${result.appliedIndices.length}/${patches.length} patches (${result.failedIndices.length} falharam)`,
            );

            if (isRevisorStep(step)) {
              // forcedPart = step ativo. Em refine, o agente devolve patches
              // sobre o XML — quando reparseamos, prefixamos os IDs com p1-/p2-
              // pra continuar consistente com a geração do zero.
              const refinePart = partOfRevisorStep(step);
              const newErrors = parseRevisorErrors(result.text, refinePart);
              const cleanContent = stripErrosDetalhados(result.text);
              const escritaContent =
                roteiro.outputs.escrita?.content?.trim() ?? "";
              const escritaSnapshotHash = escritaContent
                ? hashEscritaContent(escritaContent)
                : output?.metadata?.escritaSnapshotHash;
              setOutput(step, {
                content: cleanContent,
                metadata: {
                  errors: newErrors,
                  ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
                },
                generatedAt: startedAt,
              });
              setDraft(cleanContent);
            } else {
              // Estrutura 1 / 2: o output é texto plano markdown.
              setOutput(step, {
                content: result.text,
                metadata: { ...(output?.metadata ?? {}) },
                generatedAt: startedAt,
              });
              setDraft(result.text);
            }
            setLiveStream("");

            // Avisa via console quando patches falharam (a UI continua
            // mostrando o output com os patches que deram certo aplicados).
            if (result.failedIndices.length > 0) {
              const failedLabels = result.failedIndices
                .map((i) => patches[i]?.descricao ?? `#${i + 1}`)
                .join(", ");
              console.warn(
                `[${step} refine] patches que não casaram: ${failedLabels}`,
              );
            }
          }
        }
      } else if (isEscritaRefine && acc.trim()) {
        // Pós-correção pontual da Escrita: o agente devolve APENAS os caps
        // que mudaram (banner ═══ PARTE X ═══ + ## Capítulo N — Título +
        // texto completo do cap). Mesclamos com os capítulos existentes —
        // os intactos ficam exatamente como estavam.
        const trimmed = acc.trim();

        // Sentinela: agente decidiu que nenhuma alteração é necessária.
        if (/\[NENHUMA_ALTERACAO_NECESSARIA\]/i.test(trimmed)) {
          console.info(
            "[escrita refine] agente respondeu NENHUMA_ALTERACAO_NECESSARIA — mantendo roteiro intacto",
          );
          // Restaura o output do snapshot (já mexemos só em userInput).
          // Não há o que fazer — o output atual no store já está intacto.
          setLiveStream("");
        } else {
          // Parser direto (sem o pré-corte de parseEscritaOutput) — pega os
          // banners ═══ PARTE 1/2 ═══ no próprio texto pra atribuir a Parte
          // certa a cada capítulo retornado.
          const incoming = parseEscritaChaptersDirect(trimmed).filter(
            (c) => c.number > 0,
          );

          if (incoming.length === 0) {
            console.warn(
              "[escrita refine] parser não detectou capítulos no output corrigido — descartando resposta",
            );
            // Não sobrescreve o roteiro corrente; avisa o usuário via parseWarning
            // sem destruir os capítulos.
            setOutput(step, {
              content: output?.content ?? "",
              metadata: {
                ...(output?.metadata ?? {}),
                parseWarning:
                  "A correção não pôde ser aplicada — o agente respondeu em formato inesperado. Tente reescrever a correção mais específica (ex.: \"refaça o cap 5 da Parte 2 deixando o tom mais íntimo\").",
              },
              generatedAt: output?.generatedAt ?? startedAt,
            });
            setLiveStream("");
          } else {
            // Merge: substitui capítulos existentes com mesmo (number, part);
            // se vier um cap novo (não existia antes), adiciona no final da
            // sua Parte. Os caps intactos permanecem inalterados.
            const merged: EscritaChapter[] = previousChapters.map((existing) => {
              const replacement = incoming.find(
                (i) =>
                  i.number === existing.number &&
                  (i.part ?? "") === (existing.part ?? ""),
              );
              return replacement
                ? {
                    ...existing,
                    title: replacement.title ?? existing.title,
                    content: replacement.content,
                    edited: false,
                    generatedAt: new Date().toISOString(),
                  }
                : existing;
            });
            // Caps novos (não casaram com nada existente) — append.
            const newOnes = incoming.filter(
              (i) =>
                !previousChapters.some(
                  (e) =>
                    e.number === i.number &&
                    (e.part ?? "") === (i.part ?? ""),
                ),
            );
            merged.push(...newOnes);

            const finalContent = concatenateChapters(merged);
            setOutput(step, {
              content: finalContent,
              metadata: {
                chapters: merged,
                ...(previousSynopsesAll.length > 0
                  ? { synopses: previousSynopsesAll }
                  : {}),
              },
              generatedAt: startedAt,
            });
            setDraft(finalContent);
            setLiveStream("");
            console.info(
              `[escrita refine] mesclados ${incoming.length} cap(s) corrigido(s) (${newOnes.length} novo(s), ${incoming.length - newOnes.length} substituído(s))`,
            );
          }
        }
      } else if (
        !isRefine &&
        (step === "estrutura1" || step === "estrutura2") &&
        acc.trim()
      ) {
        // Geração do zero / continuação pra Estrutura 1/2: comita o conteúdo
        // final em uma única gravação no fim do throttle. Pro modo "continue",
        // concatena partialBase + acc com detecção de overlap pra descartar
        // texto duplicado caso o modelo redundantemente repita o final do
        // partial. Sem `metadata`, o flag `partial:true` deixado pelos
        // checkpoints é limpo automaticamente — a UI para de mostrar o banner
        // de "geração interrompida".
        const finalContent = isContinue
          ? mergeContinuation(partialBase, acc)
          : acc;
        setOutput(step, {
          content: finalContent,
          generatedAt: startedAt,
        });
        setDraft(finalContent);
        setLiveStream("");
      }

      setIsGenerating(false);

      if (autoAdvance && next) {
        setCurrentStep(next);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error(err);
      }
      setIsGenerating(false);
    }
  }, [
    roteiro,
    step,
    next,
    autoAdvance,
    output,
    setOutput,
    setIsGenerating,
    setCurrentStep,
    pushOutputToHistory,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
  }, [setIsGenerating]);

  const saveEdit = useCallback(() => {
    if (
      step === "escrita" &&
      output?.metadata?.chapters &&
      output.metadata.chapters.length > 0
    ) {
      const chapters = [...output.metadata.chapters];
      const lastIdx = chapters.length - 1;
      const last = chapters[lastIdx]!;
      chapters[lastIdx] = {
        ...last,
        content: draft,
        edited: true,
        editedAt: new Date().toISOString(),
      };
      const newConcat = concatenateChapters(chapters);
      setOutput(step, {
        ...output,
        content: newConcat,
        metadata: { ...output.metadata, chapters },
      });
    } else {
      updateOutputContent(step, draft);
    }
    setIsEditing(false);
  }, [draft, step, output, setOutput, updateOutputContent]);

  const copyOutput = useCallback(async () => {
    if (!output?.content) return;
    await navigator.clipboard.writeText(output.content);
  }, [output]);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  // Callback estável pro sub-componente isolado da caixa de input. O
  // sub-componente é memo'd e tem estado próprio do textarea, então cada
  // tecla NÃO re-renderiza o StepShell inteiro (que tem EscritaOutputView,
  // chapters[], etc — tudo pesado). Aplica a correção: comita o input
  // escopado nesse step + dispara generate("refine") com override pra
  // evitar race com o re-render do Zustand.
  const handleApplyCorrection = useCallback(
    (text: string) => {
      setUserInput(step, text);
      // Texto vira oficial em userInputs[step]; o rascunho persistido pode
      // ser apagado. Cobre estrutura1/2, escrita, revisor — o único caminho
      // de "Aplicar correção" pra steps não-Premissa passa por aqui.
      if (step !== "premissa") {
        clearDraft(step, "input");
      }
      void generate("refine", text);
    },
    [step, setUserInput, clearDraft, generate],
  );

  if (!roteiro) return null;

  // Bloqueio de avanço pra revisor2: a roteirista precisa concluir e aprovar
  // a revisão da Parte 1 antes de revisar a Parte 2. Sem isso, o revisor2
  // perderia o contexto da revisão1 (que vai como referência narrativa pro
  // agente) e a divisão em duas Partes não traria os benefícios que motivaram
  // a refatoração — análise focada e sem inconsistências cruzadas.
  if (step === "revisor2" && !roteiro.outputs.revisor1?.content?.trim()) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <Badge variant="secondary" className="font-normal w-fit">
            Etapa {idx + 1} de {STEP_ORDER.length}
          </Badge>
          <h2 className="text-2xl sm:text-3xl font-serif tracking-tight">
            {STEP_LABELS[step]}
          </h2>
        </header>
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50/60 p-6 sm:p-8 flex flex-col items-center text-center gap-4">
          <AlertTriangle className="size-8 text-amber-600" />
          <div className="flex flex-col gap-2 max-w-xl">
            <h3 className="text-lg font-semibold">
              Conclua a revisão da Parte 1 antes
            </h3>
            <p className="text-sm text-muted-foreground">
              A revisão da Parte 2 é alimentada pelo relatório da revisão da
              Parte 1 — assim o agente mantém consistência narrativa e não
              levanta &quot;inconsistências&quot; contra escolhas que a Parte 1
              já consolidou. Volte ao Revisor — Parte 1, gere a revisão e
              aplique as correções; depois siga em frente.
            </p>
          </div>
          <Button
            onClick={() => setCurrentStep("revisor1")}
            size="lg"
            className="gap-2"
          >
            <ArrowLeft className="size-4" />
            Ir para Revisor — Parte 1
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              Etapa {idx + 1} de {STEP_ORDER.length}
            </Badge>
            {agent.placeholder && (
              <Badge
                variant="outline"
                className="font-normal text-amber-700 border-amber-300 bg-amber-50"
              >
                Prompt placeholder
              </Badge>
            )}
          </div>
          <h2 className="text-2xl sm:text-3xl font-serif tracking-tight">
            {STEP_LABELS[step]}
          </h2>
          <p className="text-sm text-muted-foreground">{agent.description}</p>
        </div>

        {step !== "premissa" && (
        <div className="flex items-center gap-2 flex-wrap">
          <label
            className={cn(
              "flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-md border cursor-pointer transition",
              autoAdvance
                ? "bg-primary/10 border-primary/40 text-primary"
                : "bg-background border-border text-muted-foreground hover:bg-muted",
            )}
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
            />
            <Zap className="size-3.5" />
            Avançar auto
          </label>
        </div>
        )}
      </header>

      {previousOutputsSummary.some((p) => p.content) && (
        <details className="group border rounded-lg bg-muted/30">
          <summary className="list-none cursor-pointer px-4 py-3 text-sm font-medium flex items-center justify-between">
            <span>Contexto das etapas anteriores</span>
            <span className="text-xs text-muted-foreground group-open:hidden">
              clique para expandir
            </span>
          </summary>
          <div className="px-4 pb-4 flex flex-col gap-3">
            {previousOutputsSummary.map((p) =>
              p.content ? (
                <div key={p.id} className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {p.label}
                  </span>
                  <div className="bg-background border rounded-md p-3 max-h-40 overflow-auto">
                    <Prose size="sm">{p.content}</Prose>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </details>
      )}

      {step === "premissa" ? (
        <>
          <PremissaWizard />
          <CanoneCard />
        </>
      ) : (
        <StepUserInputBox
          step={step}
          idx={idx}
          chapterCount={chapterCount}
          expectedChapterCount={expectedChapterCount}
          savedInput={savedStepInput}
          hasOutput={!!output?.content?.trim()}
          isGenerating={isGenerating}
          onApply={handleApplyCorrection}
        />
      )}

      {step !== "premissa" && (
      <>
      <Separator />

      {/* Banner "geração interrompida" — Estrutura 1/2 apenas. Aparece quando
          o output corrente tem `partial:true` no metadata e não há geração
          rodando agora. Indica que um stream anterior foi cortado no meio
          (freeze, app fechado, crash, perda de rede) e o partial ficou
          preservado via checkpoints periódicos durante o stream. Oferece dois
          caminhos: continuar de onde parou (concat partial + delta com
          detecção de overlap) ou descartar e regenerar (parcial vai pro
          histórico). */}
      {(step === "estrutura1" || step === "estrutura2") &&
        output?.metadata?.partial === true &&
        !isGenerating &&
        output.content && (
          <InterruptedGenerationBanner
            startedAt={output.metadata.streamingStartedAt}
            partialLength={output.content.length}
            onContinue={() => generate("continue")}
            onDiscardAndRegenerate={() =>
              generate("regenerate", undefined, "Parcial descartado")
            }
          />
        )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-sm font-semibold">
              {step === "escrita" ? "Capítulo gerado" : `Saída do agente ${agent.label}`}
            </Label>
            {validationStatus === "APROVADO" && (
              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 font-normal gap-1">
                <CheckCircle2 className="size-3" />
                Validado
              </Badge>
            )}
            {validationStatus === "BLOQUEADO" && (
              <Badge className="bg-red-100 text-red-800 border-red-300 font-normal gap-1">
                <AlertTriangle className="size-3" />
                Bloqueado — revisar antes de avançar
              </Badge>
            )}
            {hasContent &&
              !isEditing &&
              (step === "escrita" || step === "estrutura1" || step === "estrutura2") && (
                <WordCountBadge
                  content={output?.content ?? ""}
                  targetMin={wordCountTarget.min}
                  targetMax={wordCountTarget.max}
                  margin={500}
                  label={wordCountTarget.label}
                />
              )}
          </div>
          <div className="flex items-center gap-2">
            {hasContent && !isEditing && (
              <>
                {/* No Escrita com chapters[], cada ChapterCard tem seu próprio
                    botão Editar — então não exibimos o "Editar global" aqui
                    pra evitar dois caminhos de edição. Demais steps mantêm o
                    Editar global que abre a Textarea com o markdown completo. */}
                {!(step === "escrita" && chapters.length > 0) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(output?.content ?? "");
                      setIsEditing(true);
                    }}
                  >
                    <Pencil className="size-3.5" />
                    Editar
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={copyOutput}>
                  <Copy className="size-3.5" /> Copiar
                </Button>
              </>
            )}
            {isEditing && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
                  Cancelar
                </Button>
                <Button size="sm" onClick={saveEdit}>
                  Salvar edição
                </Button>
              </>
            )}
          </div>
        </div>

        {isEditing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            className="font-mono text-sm"
          />
        ) : step === "escrita" ? (
          <div className="flex flex-col gap-4">
            {chapters.length > 0 && (
              <EscritaOutputView
                output={output!}
                chapterTargets={chapterTargets}
              />
            )}
            {chapters.length === 0 && hasContent && !isGenerating && (
              <>
                {output?.metadata?.parseWarning && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 text-sm flex items-start gap-2">
                    <AlertTriangle className="size-4 flex-none mt-0.5" />
                    <span>{output.metadata.parseWarning}</span>
                  </div>
                )}
                <div className="rounded-lg border bg-card p-4 sm:p-6 max-h-[50vh] overflow-auto">
                  <Prose>{output?.content ?? ""}</Prose>
                </div>
              </>
            )}
            {isGenerating && batchProgress && batchProgress.kind === "writing" && (
              <BatchProgressPanel
                progress={batchProgress}
                liveStream={liveStream}
                elapsedSec={elapsedSec}
              />
            )}
            {isGenerating && !batchProgress && (
              <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.03] px-4 sm:px-5 py-4 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  <span className="text-sm font-semibold text-primary">
                    Aplicando correção pontual no roteiro…
                  </span>
                </div>
                {liveStream && (
                  <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-muted-foreground max-h-48 overflow-auto border-t border-primary/20 pt-3">
                    {liveStream.slice(-2000)}
                  </pre>
                )}
              </div>
            )}
            {!isGenerating && !hasContent && (
              <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center">
                <Sparkles className="size-6 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  Clique em <span className="font-semibold">Gerar</span> para
                  executar o agente{" "}
                  <span className="font-semibold">{agent.label}</span> em pares
                  de capítulos.
                </p>
              </div>
            )}
          </div>
        ) : isRevisorStep(step) && isGenerating ? (
          batchProgress && batchProgress.kind !== "writing" ? (
            <BatchProgressPanel
              progress={batchProgress}
              liveStream={liveStream}
              revisorPhase={revisorPhase}
              elapsedSec={elapsedSec}
            />
          ) : (
            <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.03] px-4 sm:px-5 py-6 flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm font-semibold text-primary">
                Iniciando revisão…
              </span>
              <span className="ml-auto text-xs font-mono text-foreground/70 tabular-nums">
                ⏱ {formatElapsed(elapsedSec)}
              </span>
            </div>
          )
        ) : isGenerating ? (
          // Estrutura 1/2 generating do zero: o stream não persiste mais por
          // chunk no output (evita OOM), então mostramos o texto crescendo no
          // painel ao vivo e só comitamos no output quando termina.
          <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.03] px-4 sm:px-5 py-4 flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm font-semibold text-primary">
                Gerando {agent.label}…
              </span>
            </div>
            {liveStream ? (
              <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground/85 max-h-[55vh] overflow-auto border-t border-primary/20 pt-3">
                {liveStream}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Conectando ao agente…
              </p>
            )}
          </div>
        ) : hasContent ? (
          <div className="rounded-lg border bg-card p-4 sm:p-6 max-h-[50vh] overflow-auto">
            <Prose>{output?.content ?? ""}</Prose>
            {output?.edited && (
              <p className="text-[11px] text-muted-foreground mt-3">
                Editado manualmente em{" "}
                {output.editedAt
                  ? new Date(output.editedAt).toLocaleString("pt-BR")
                  : "—"}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center">
            <Sparkles className="size-6 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              Clique em <span className="font-semibold">Gerar</span> para
              executar o agente{" "}
              <span className="font-semibold">{agent.label}</span>.
            </p>
          </div>
        )}

        {isRevisorStep(step) &&
          hasContent &&
          !isGenerating &&
          !isEditing &&
          (output?.metadata?.errors?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Wand2 className="size-4 text-primary" />
                <Label className="text-sm font-semibold">
                  Correção automática
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  abra cada card e clique em &quot;Aplicar essa correção&quot; — o
                  trecho corrigido substitui o original no roteiro do Step 4
                </span>
              </div>
              <RevisorErrorsView
                errors={output!.metadata!.errors!}
                {...(output?.metadata?.escritaSnapshotHash
                  ? { escritaSnapshotHash: output.metadata.escritaSnapshotHash }
                  : {})}
              />
            </div>
          )}

        <div className="flex items-center gap-2 flex-wrap pt-2">
          {!isGenerating ? (
            isRevisorStep(step) && hasContent ? (
              <>
                <Button
                  onClick={() => generate("regenerate")}
                  size="lg"
                  variant="outline"
                  className="gap-2"
                >
                  <RotateCcw className="size-4" />
                  Gerar novamente
                </Button>
                <Button
                  onClick={() =>
                    generate(
                      "regenerate",
                      undefined,
                      "Antes de continuar revisão",
                      true,
                    )
                  }
                  size="lg"
                  className="gap-2"
                >
                  <Sparkles className="size-4" />
                  Continuar revisão
                </Button>
              </>
            ) : (
              <Button onClick={() => generate("regenerate")} size="lg" className="gap-2">
                {step === "escrita" && chapterCount > 0 ? (
                  <ArrowRight className="size-4" />
                ) : hasContent ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {generateLabel}
              </Button>
            )
          ) : (
            <Button
              onClick={cancel}
              size="lg"
              variant="secondary"
              className="gap-2"
            >
              <Loader2 className="size-4 animate-spin" />
              Gerando... (clique para cancelar)
            </Button>
          )}
        </div>
      </section>

      {hasMetadata && !isGenerating && step !== "escrita" && (
        <MetadataPanel
          report={output?.metadata?.report}
          memory={output?.metadata?.memory}
          validation={output?.metadata?.validation}
          validationStatus={validationStatus}
          onCopy={copyText}
        />
      )}

      {!isGenerating && historyStack.length > 0 && (
        <HistoryPanel step={step} history={historyStack} />
      )}
      </>
      )}

      <Separator />

      <footer className="flex items-center justify-between gap-2 flex-wrap">
        <Button
          variant="outline"
          disabled={!prev}
          onClick={() => prev && setCurrentStep(prev)}
        >
          <ArrowLeft className="size-4" /> Voltar
        </Button>

        <div className="flex items-center gap-2 flex-wrap">
          {step === "escrita" && hasContent && (
            <>
              <CopyPartButton roteiro={roteiro} part={1} />
              <CopyPartButton roteiro={roteiro} part={2} />
              <DownloadEscritaButton roteiro={roteiro} />
            </>
          )}
          {isRevisorStep(step) && (
            <>
              <CopyPartButton roteiro={roteiro} part={1} />
              <CopyPartButton roteiro={roteiro} part={2} />
              <DownloadEscritaButton roteiro={roteiro} />
            </>
          )}
          {next && (() => {
            // Trava o avanço da Premissa pra Estrutura P1 quando há cânone
            // gerado mas a roteirista ainda não aprovou. Roteiros legados
            // (sem cânone) não bloqueiam — comportamento backward-compatible.
            const canoneBlocksAdvance =
              step === "premissa" &&
              !!roteiro?.canone?.trim() &&
              !roteiro?.canoneApproved;
            return (
              <Button
                onClick={() => setCurrentStep(next)}
                className="gap-2"
                disabled={canoneBlocksAdvance}
                title={
                  canoneBlocksAdvance
                    ? "Aprove o cânone de entidades antes de avançar."
                    : undefined
                }
              >
                Avançar <ArrowRight className="size-4" />
              </Button>
            );
          })()}
        </div>
      </footer>
    </div>
  );
}

// ─── Caixa de "Instruções adicionais" / "Aplicar correção" ─────────────
//
// Componente isolado E memo'd: estado do textarea fica AQUI dentro, então
// cada tecla digitada só re-renderiza esta caixa, NÃO o StepShell inteiro
// (que tem EscritaOutputView, lista de chapters, MetadataPanel, etc — tudo
// pesado). Sem essa separação, digitar 1 letra disparava re-render de tudo
// e a roteirista percebia lag visível em roteiros grandes.
//
// O pai injeta `savedInput` (escopado por step) e `onApply` (estável via
// useCallback). O sub-componente sincroniza pendingInput → savedInput
// quando o roteiro/step troca.
interface StepUserInputBoxProps {
  step: StepId;
  idx: number;
  chapterCount: number;
  expectedChapterCount: number;
  savedInput: string;
  hasOutput: boolean;
  isGenerating: boolean;
  onApply: (text: string) => void;
}

const StepUserInputBox = memo(function StepUserInputBox({
  step,
  idx,
  chapterCount,
  expectedChapterCount,
  savedInput,
  hasOutput,
  isGenerating,
  onApply,
}: StepUserInputBoxProps) {
  // Step "premissa" tem fluxo próprio (PremissaWizard) e não chega aqui.
  // O `as` abaixo é só pra estreitar o tipo do useDraft pra exatamente um
  // dos steps que possuem campo `input`.
  const draftStep = step as
    | "estrutura1"
    | "estrutura2"
    | "escrita"
    | "revisor1"
    | "revisor2";
  const [pendingInput, setPendingInput] = useDraft(
    draftStep,
    "input",
    savedInput,
  );

  const trimmedPending = pendingInput.trim();
  const isDirty = pendingInput !== savedInput;
  const hasInputContent = trimmedPending.length > 0;
  const canApply = hasInputContent && hasOutput && !isGenerating;

  const placeholder =
    step === "escrita"
      ? "Ex.: deixe o tom mais intenso na Parte 2 · enfatize o conflito interno do MMC · adicione mais humor nos primeiros capítulos\n\n(Deixe vazio para o agente derivar 100% das estruturas aprovadas)"
      : idx === 0
        ? "Ex.: romance com executiva herdeira que retorna pra cidade natal..."
        : "Ex.: deixe o tom mais intenso, foco no conflito interno...";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <Label htmlFor="user-input" className="text-sm">
          {step === "escrita"
            ? "Ajustes opcionais para o roteiro"
            : "Instruções adicionais (opcional)"}
        </Label>
        {step === "escrita" && (
          <span
            className={`text-[11px] ${
              chapterCount > 0 &&
              expectedChapterCount > 0 &&
              chapterCount !== expectedChapterCount
                ? "text-amber-700 font-medium"
                : "text-muted-foreground"
            }`}
          >
            {chapterCount === 0
              ? "O agente derivará tudo das estruturas aprovadas"
              : expectedChapterCount > 0 && chapterCount !== expectedChapterCount
                ? `⚠️ ${chapterCount} de ${expectedChapterCount} capítulos esperados · regenerar substitui tudo`
                : `${chapterCount} capítulo${chapterCount === 1 ? "" : "s"} no roteiro atual · regenerar substitui tudo`}
          </span>
        )}
      </div>
      <Textarea
        id="user-input"
        placeholder={placeholder}
        value={pendingInput}
        onChange={(e) => setPendingInput(e.target.value)}
        rows={step === "escrita" ? 4 : 3}
        className="resize-none"
      />
      <div className="flex items-center justify-end gap-2 flex-wrap">
        {!isDirty && hasInputContent && (
          <Badge
            variant="outline"
            className="font-normal gap-1 border-emerald-300 bg-emerald-50 text-emerald-800"
          >
            <CheckCircle2 className="size-3" />
            Correção aplicada
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={!canApply}
          onClick={() => onApply(pendingInput)}
          className="gap-2"
          title={
            !hasInputContent
              ? "Digite a correção primeiro"
              : !hasOutput
                ? "Gere o conteúdo desse step antes de aplicar uma correção"
                : "Aplica essa correção pontual no step atual sem regerar do zero"
          }
        >
          <Send className="size-3.5" />
          Aplicar correção
        </Button>
      </div>
    </section>
  );
});

// ─── Premissa em duas fases ───────────────────────────────────────────
//
// Fluxo (modo automático):
//   1. briefing  → usuário descreve a ideia, clica "Gerar resumo"
//   2. streaming → /api/agent/premissa com premissaPhase: "resumo" (Bloco 0)
//   3. approving → resumo aparece editável; usuário ajusta e aprova
//   4. streaming → /api/agent/premissa com premissaPhase: "estrutura" (Blocos 1-8)
//   5. done      → outputs.premissa.content recebe "RESUMO + ESTRUTURA"
//
// Handle exposto pelos textareas isolados da Premissa: o pai chama `flush()`
// antes de submeter (garante que o draft está no Zustand) e `getValue()` pra
// ler o valor mais recente sem assinar um state que invalide a cada tecla.
// `setValue` cobre os casos em que o pai precisa setar programaticamente
// (após receber resposta da API, ao cancelar edição, ao trocar de modo).
type DraftTextareaHandle = {
  flush: () => void;
  getValue: () => string;
  setValue: (v: string) => void;
};

interface PremissaDraftTextareaProps {
  ref?: React.Ref<DraftTextareaHandle>;
  // useDraft é genérico em S = keyof RoteiroDrafts. Aqui travamos no step
  // "premissa" pra simplificar — todos os usos no wizard da Premissa.
  field: "briefing" | "resumo" | "content" | "instruction";
  committedValue: string;
  rows: number;
  placeholder?: string;
  className?: string;
  id?: string;
}

// memo + state local: a chave da otimização. Cada keystroke só re-renderiza
// ESTE componente — o PremissaWizard pai (com header, IIFE da caixa de
// instruções, ReferenceImageUpload, botões "Gerar resumo") fica intocado.
// Sem isso, digitar 1 letra no briefing reconciliava a árvore inteira do
// wizard a cada tecla, e era o gargalo dominante de "lentidão ao digitar"
// que a roteirista sentia (especialmente no Windows).
//
// Mesmo padrão usado pelo StepUserInputBox (steps 2-5). A Premissa havia
// sido esquecida — `useDraft` ficava direto no PremissaWizard.
const PremissaDraftTextarea = memo(function PremissaDraftTextarea({
  ref,
  field,
  committedValue,
  rows,
  placeholder,
  className,
  id,
}: PremissaDraftTextareaProps) {
  const [value, setValue, flush] = useDraft("premissa", field, committedValue);

  // Expõe leitura imperativa pro parent. Sem isso, o parent precisaria
  // assinar o value (e re-renderizar a cada keystroke) só pra saber o
  // texto atual no momento de chamar generateResumo / applyInstruction.
  useImperativeHandle(
    ref,
    () => ({
      flush,
      getValue: () => value,
      setValue,
    }),
    [flush, setValue, value],
  );

  // Handler estável — sem isso, cada keystroke criava uma arrow inline nova,
  // o que faz o Chromium re-bindar o listener `onchange` no <textarea> nativo
  // a cada tecla. Setup do listener é micro-cost mas mensurável no Windows
  // em rajadas longas. setValue é estável (useCallback dentro do useDraft).
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
    },
    [setValue],
  );

  return (
    <Textarea
      id={id}
      value={value}
      onChange={handleChange}
      placeholder={placeholder}
      rows={rows}
      className={className}
    />
  );
});

// Fluxo (modo manual): toggle "Já tenho a premissa pronta" → textarea
// livre, content gravado direto. Mantido como fallback.
function PremissaWizard() {
  const roteiro = useWizard((s) => s.roteiro);
  const setOutput = useWizard((s) => s.setOutput);
  const setUserInput = useWizard((s) => s.setUserInput);
  const clearDraft = useWizard((s) => s.clearDraft);
  const setIsGenerating = useWizard((s) => s.setIsGenerating);
  const pushOutputToHistory = useWizard((s) => s.pushOutputToHistory);
  const isGenerating = useWizard((s) => s.isGenerating);

  // Categoria do roteiro — propagada para os fetches do fluxo automático
  // da Premissa para que o backend escolha o conjunto correto de prompts.
  const category = roteiro?.category ?? DEFAULT_CATEGORY;

  const output = roteiro?.outputs.premissa;
  const meta = output?.metadata ?? {};
  const briefing = meta.premissaBriefing ?? "";
  const resumo = meta.premissaResumo ?? "";
  const approved = !!meta.premissaResumoApproved;
  const manual = !!meta.premissaManualPaste;
  const content = output?.content ?? "";
  // Instruções adicionais escopadas só pra Premissa — não vazam pros outros
  // steps. Salvas em `userInputs.premissa` e injetadas como contexto extra
  // em qualquer regeneração (resumo ou estrutura).
  const savedInstruction = roteiro?.userInputs?.premissa ?? "";

  // Drafts persistidos em roteiro.drafts.premissa.* — sobrevivem à troca
  // de step. Limpos quando o usuário cometer o valor (Gerar resumo, Salvar
  // edição, Aplicar instrução). Sem isso, digitar no briefing e clicar em
  // Avançar antes de gerar perdia tudo.
  //
  // Os textareas usam `useDraft` ESCONDIDO dentro de PremissaDraftTextarea
  // (memo'd). Aqui o pai só guarda refs imperativas — sem isso, cada
  // keystroke re-renderizava o PremissaWizard inteiro (header, IIFE da
  // caixa de instruções, ReferenceImageUpload, botões), que era o gargalo
  // de "lentidão ao digitar".
  const briefingRef = useRef<DraftTextareaHandle>(null);
  const resumoRef = useRef<DraftTextareaHandle>(null);
  const contentRef = useRef<DraftTextareaHandle>(null);
  const instructionRef = useRef<DraftTextareaHandle>(null);

  // Selectors atomizados pra ler os drafts persistidos. Causam re-render
  // do pai SÓ quando o setDraft do Zustand dispara (debounce 400ms do
  // useDraft) — não a cada tecla. Usados em flags de UI que precisam
  // refletir o draft (botões disabled, badges "instrução salva").
  const briefingDraftStored = useWizard(
    (s) => s.roteiro?.drafts?.premissa?.briefing ?? "",
  );
  const resumoDraftStored = useWizard(
    (s) => s.roteiro?.drafts?.premissa?.resumo ?? "",
  );
  const contentDraftStored = useWizard(
    (s) => s.roteiro?.drafts?.premissa?.content ?? "",
  );
  const instructionDraftStored = useWizard(
    (s) => s.roteiro?.drafts?.premissa?.instruction ?? "",
  );
  const [liveStream, setLiveStream] = useState("");
  const [streamingPhase, setStreamingPhase] = useState<
    null | "resumo" | "estrutura"
  >(null);
  const [isEditingResumo, setIsEditingResumo] = useState(false);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const [isEditingManual, setIsEditingManual] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Aborta stream quando o componente desmonta (usuário trocou de step).
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Aborta streams em flight no auto-reload do Electron (crash handler).
  useEffect(() => {
    const handler = () => abortRef.current?.abort();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Roteiros antigos (pré-fluxo automático) têm `content` mas nenhum metadado
  // novo. Tratamos como "manual" para preservar a premissa que o usuário já
  // tinha — sem isso, a tela de briefing apareceria por cima do conteúdo.
  const isLegacy = !!content && !resumo && !manual && !approved;
  const phase: "manual" | "briefing" | "approving" | "done" =
    manual || isLegacy
      ? "manual"
      : !resumo
        ? "briefing"
        : !approved || !content
          ? "approving"
          : "done";

  // ─── Streaming helpers ──────────────────────────────────────────────
  const readStreamFully = (res: Response, signal: AbortSignal) =>
    readStreamThrottled(res, setLiveStream, signal);

  // ─── Fase 1: gerar resumo (Bloco 0) ─────────────────────────────────
  const generateResumo = useCallback(async (instructionOverride?: string) => {
    // Lê o briefing atual via ref imperativo — sem isso, precisaríamos
    // assinar o local state do useDraft no pai (e re-renderizar a cada
    // tecla). flush() garante que o draft mais recente esteja gravado
    // no Zustand antes de ler.
    briefingRef.current?.flush();
    const briefingDraft =
      briefingRef.current?.getValue() ?? briefingDraftStored ?? briefing;
    const briefingTrim = briefingDraft.trim();
    if (!briefingTrim || isGenerating) return;

    if (resumo) {
      pushOutputToHistory("premissa", "Antes de regenerar resumo");
    }

    // Instrução adicional vem ou do override (caller acabou de salvar) ou
    // do que está persistido em userInputs.premissa. Draft do textarea
    // tem prioridade sobre savedInstruction — useDraft só persiste quando
    // pending !== committed, então é por definição mais novo. Sem isso, a
    // primeira geração antes de "Salvar instrução" ignorava o que foi digitado.
    instructionRef.current?.flush();
    const draftInstruction = (
      instructionRef.current?.getValue() ?? instructionDraftStored
    ).trim();
    const instruction = (
      instructionOverride ?? (draftInstruction || savedInstruction)
    ).trim();
    const fullUserInput = instruction
      ? `${briefingTrim}\n\n━━━ INSTRUÇÕES ADICIONAIS DA AUTORA ━━━\n${instruction}`
      : briefingTrim;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsGenerating(true);
    setLiveStream("");
    setStreamingPhase("resumo");

    const startedAt = new Date().toISOString();

    // Persiste o briefing no metadata logo no início — assim, se a
    // geração falhar, o usuário não perde o que digitou.
    setOutput("premissa", {
      content,
      generatedAt: output?.generatedAt ?? startedAt,
      metadata: { ...meta, premissaBriefing: briefingTrim },
    });

    try {
      const res = await fetch("/api/agent/premissa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          userInput: fullUserInput,
          referenceImage: roteiro?.referenceImage,
          premissaPhase: "resumo",
        }),
        signal: ctrl.signal,
      });
      if (!res.ok && res.status !== 200) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const fullText = (await readStreamFully(res, ctrl.signal)).trim();
      if (!fullText) return;

      const now = new Date().toISOString();
      setOutput("premissa", {
        // O conteúdo final só é populado depois da Fase 2; aqui zeramos
        // pra que o downstream (Estrutura 1/2) não consuma um resumo
        // ainda não aprovado como se fosse a premissa final.
        content: "",
        generatedAt: now,
        metadata: {
          ...meta,
          premissaBriefing: briefingTrim,
          premissaResumo: fullText,
          premissaResumoApproved: false,
          premissaManualPaste: false,
        },
      });
      // Briefing e resumo viraram oficiais (metadata) — apaga drafts pra
      // que próximas remontagens leiam do metadata, não do draft antigo.
      clearDraft("premissa", "briefing");
      clearDraft("premissa", "resumo");
      // Sincroniza o local state do textarea de resumo (memo'd) com o
      // texto recém-gerado — o useEffect interno do useDraft não dispara
      // porque committedValue ainda é o valor antigo até o próximo render.
      resumoRef.current?.setValue(fullText);
      setIsEditingResumo(false);
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        console.error("[premissa] erro fase resumo:", e);
      }
    } finally {
      setIsGenerating(false);
      setStreamingPhase(null);
      setLiveStream("");
    }
  }, [
    briefing,
    briefingDraftStored,
    category,
    isGenerating,
    resumo,
    savedInstruction,
    instructionDraftStored,
    pushOutputToHistory,
    setIsGenerating,
    setOutput,
    clearDraft,
    content,
    output?.generatedAt,
    meta,
    roteiro?.referenceImage,
  ]);

  // ─── Fase 2: aprovar resumo + gerar Blocos 1-7 ──────────────────────
  const approveAndGenerateEstrutura = useCallback(async (instructionOverride?: string) => {
    resumoRef.current?.flush();
    briefingRef.current?.flush();
    const resumoDraft =
      resumoRef.current?.getValue() ?? resumoDraftStored ?? resumo;
    const briefingDraft =
      briefingRef.current?.getValue() ?? briefingDraftStored ?? briefing;
    const resumoTrim = resumoDraft.trim();
    const briefingTrim = briefingDraft.trim() || briefing;
    if (!resumoTrim || isGenerating) return;

    if (content) {
      pushOutputToHistory("premissa", "Antes de regenerar estrutura");
    }

    // Draft tem prioridade sobre savedInstruction — ver comentário em
    // generateResumo. Mesmo bug aplicado a essa fase também.
    instructionRef.current?.flush();
    const draftInstruction = (
      instructionRef.current?.getValue() ?? instructionDraftStored
    ).trim();
    const instruction = (
      instructionOverride ?? (draftInstruction || savedInstruction)
    ).trim();
    const fullUserInput = instruction
      ? `${briefingTrim}\n\n━━━ INSTRUÇÕES ADICIONAIS DA AUTORA ━━━\n${instruction}`
      : briefingTrim;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsGenerating(true);
    setLiveStream("");
    setStreamingPhase("estrutura");

    try {
      const res = await fetch("/api/agent/premissa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          userInput: fullUserInput,
          referenceImage: roteiro?.referenceImage,
          premissaPhase: "estrutura",
          approvedResumo: resumoTrim,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok && res.status !== 200) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const estrutura = (await readStreamFully(res, ctrl.signal)).trim();
      if (!estrutura) return;

      const fullContent = `# RESUMO\n\n${resumoTrim}\n\n# ESTRUTURA COMPLETA\n\n${estrutura}`;
      const now = new Date().toISOString();
      setOutput("premissa", {
        content: fullContent,
        generatedAt: now,
        metadata: {
          ...meta,
          premissaBriefing: briefingTrim,
          premissaResumo: resumoTrim,
          premissaResumoApproved: true,
          premissaResumoApprovedAt: now,
          premissaManualPaste: false,
        },
      });
      // Estrutura aprovada — todos os campos da Premissa viraram oficiais
      // (briefing/resumo no metadata, content no output). Apaga drafts.
      clearDraft("premissa");
      contentRef.current?.setValue(fullContent);
      setIsEditingResumo(false);
      setIsEditingContent(false);
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        console.error("[premissa] erro fase estrutura:", e);
      }
    } finally {
      setIsGenerating(false);
      setStreamingPhase(null);
      setLiveStream("");
    }
  }, [
    briefing,
    briefingDraftStored,
    category,
    resumo,
    resumoDraftStored,
    isGenerating,
    content,
    savedInstruction,
    instructionDraftStored,
    pushOutputToHistory,
    setIsGenerating,
    setOutput,
    clearDraft,
    meta,
    roteiro?.referenceImage,
  ]);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setStreamingPhase(null);
    setLiveStream("");
  }, [setIsGenerating]);

  // ─── Aplicar instrução adicional (caixa de "chat") ─────────────────
  // Comportamento por fase:
  //   • briefing  → só salva (usado quando clicar em "Gerar resumo")
  //   • approving → regenera o resumo já injetando a instrução
  //   • done      → regenera a estrutura mantendo o resumo, com a
  //                 instrução baked no prompt
  const applyInstruction = useCallback(async () => {
    instructionRef.current?.flush();
    const pendingInstruction =
      instructionRef.current?.getValue() ?? instructionDraftStored;
    const trimmed = pendingInstruction.trim();
    if (!trimmed || isGenerating) return;
    setUserInput("premissa", trimmed);
    // Instrução virou oficial em userInputs.premissa — apaga draft pra
    // evitar reidratar o textarea com o mesmo texto na próxima visita.
    clearDraft("premissa", "instruction");
    if (phase === "approving") {
      await generateResumo(trimmed);
    } else if (phase === "done") {
      await approveAndGenerateEstrutura(trimmed);
    }
    // briefing phase: instrução fica salva; será aplicada no próximo "Gerar resumo".
  }, [
    instructionDraftStored,
    isGenerating,
    phase,
    setUserInput,
    clearDraft,
    generateResumo,
    approveAndGenerateEstrutura,
  ]);

  // ─── Manual paste ───────────────────────────────────────────────────
  const switchToManual = useCallback(() => {
    setOutput("premissa", {
      content,
      generatedAt: output?.generatedAt ?? new Date().toISOString(),
      metadata: { ...meta, premissaManualPaste: true },
    });
    setIsEditingManual(!content);
  }, [setOutput, content, output?.generatedAt, meta]);

  const switchToAutomatic = useCallback(() => {
    setOutput("premissa", {
      content: "",
      generatedAt: new Date().toISOString(),
      metadata: { ...meta, premissaManualPaste: false },
    });
    contentRef.current?.setValue("");
    setIsEditingManual(false);
  }, [setOutput, meta]);

  const saveManualEdit = useCallback(() => {
    contentRef.current?.flush();
    const contentDraft =
      contentRef.current?.getValue() ?? contentDraftStored ?? content;
    setOutput("premissa", {
      content: contentDraft,
      generatedAt: output?.generatedAt ?? new Date().toISOString(),
      editedAt: new Date().toISOString(),
      edited: true,
      metadata: { ...meta, premissaManualPaste: true },
    });
    clearDraft("premissa", "content");
    setIsEditingManual(false);
  }, [setOutput, clearDraft, content, contentDraftStored, output?.generatedAt, meta]);

  const saveContentEdit = useCallback(() => {
    contentRef.current?.flush();
    const contentDraft =
      contentRef.current?.getValue() ?? contentDraftStored ?? content;
    setOutput("premissa", {
      content: contentDraft,
      generatedAt: output?.generatedAt ?? new Date().toISOString(),
      editedAt: new Date().toISOString(),
      edited: true,
      metadata: meta,
    });
    clearDraft("premissa", "content");
    setIsEditingContent(false);
  }, [setOutput, clearDraft, content, contentDraftStored, output?.generatedAt, meta]);

  // ─── Word counts (regra do CLAUDE.md: usar countWords) ─────────────
  // Usa o draft GRAVADO (debounced 400ms) — se houver — senão o oficial.
  // Trade-off: contador atualiza só após pausa de digitação, não em tempo
  // real. É aceitável: ninguém edita resumo contando palavras a cada
  // keystroke. O ganho de não re-renderizar o pai a cada tecla compensa.
  const resumoWordCount = useMemo(
    () => countWords(resumoDraftStored || resumo),
    [resumoDraftStored, resumo],
  );
  const contentWordCount = useMemo(
    () => countWords(contentDraftStored || content),
    [contentDraftStored, content],
  );
  const resumoTargetMin = 1200;
  const resumoTargetMax = 1800;
  const resumoOutOfTarget =
    resumoWordCount > 0 &&
    (resumoWordCount < resumoTargetMin || resumoWordCount > resumoTargetMax);

  // ─── Streaming view (compartilhada entre fase resumo e estrutura) ──
  if (streamingPhase) {
    return (
      <section className="flex flex-col gap-3">
        <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.03] px-4 sm:px-5 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm font-semibold text-primary">
                {streamingPhase === "resumo"
                  ? "Gerando resumo (Bloco 0)…"
                  : "Construindo estrutura completa da história (Blocos 1-7)…"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={cancelStream}
              className="gap-2"
            >
              Cancelar
            </Button>
          </div>
          {streamingPhase === "estrutura" && (
            <p className="text-[11px] text-muted-foreground">
              Esta fase é mais detalhada — pode levar 1 a 3 minutos. O resumo
              aprovado já está salvo; se algo der errado, ele permanece
              disponível para regenerar a estrutura.
            </p>
          )}
          {liveStream && (
            <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground/85 max-h-[55vh] overflow-auto border-t border-primary/20 pt-3">
              {liveStream}
            </pre>
          )}
        </div>
      </section>
    );
  }

  // ─── Modo manual ────────────────────────────────────────────────────
  if (phase === "manual") {
    const tooLongManual = contentWordCount > 1000;
    return (
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="premissa-manual" className="text-sm font-semibold">
              {isEditingManual ? "Cole a premissa pronta" : "Premissa (modo manual)"}
            </Label>
            <span className="text-[11px] text-muted-foreground">
              Texto colado direto vai para os Steps 2/3/4 sem passar pelo agente.
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!!content && (
              <Badge
                className={cn(
                  "font-normal gap-1",
                  tooLongManual
                    ? "bg-amber-100 text-amber-800 border-amber-300"
                    : "bg-emerald-100 text-emerald-800 border-emerald-300",
                )}
              >
                <CheckCircle2 className="size-3" />
                {contentWordCount.toLocaleString("pt-BR")} palavra
                {contentWordCount === 1 ? "" : "s"}
                {tooLongManual ? " (acima do limite)" : ""}
              </Badge>
            )}
            {!isEditingManual && !!content && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  contentRef.current?.setValue(content);
                  setIsEditingManual(true);
                }}
              >
                <Pencil className="size-3.5" />
                Editar
              </Button>
            )}
            {isEditingManual && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    contentRef.current?.setValue(content);
                    setIsEditingManual(!content);
                  }}
                >
                  Cancelar
                </Button>
                <Button size="sm" onClick={saveManualEdit}>
                  Salvar
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={switchToAutomatic}
              className="text-muted-foreground"
            >
              Voltar ao modo automático
            </Button>
          </div>
        </div>

        {isEditingManual ? (
          <PremissaDraftTextarea
            ref={contentRef}
            field="content"
            committedValue={content}
            id="premissa-manual"
            placeholder={`Cole aqui a premissa completa.\n\nFormato sugerido:\n\n# PARTE 1\n[texto corrido]\n\n# PARTE 2\n[texto corrido]`}
            rows={20}
            className="font-sans text-[14px] leading-relaxed resize-y min-h-[400px]"
          />
        ) : (
          <div className="rounded-lg border bg-card p-4 sm:p-6 max-h-[60vh] overflow-auto">
            {content ? (
              <Prose>{content}</Prose>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Sem conteúdo. Clique em <span className="font-semibold">Editar</span> e cole o texto.
              </p>
            )}
          </div>
        )}

        <ReferenceImageUpload />
      </section>
    );
  }

  // ─── Modo automático: briefing → approving → done ───────────────────
  return (
    <section className="flex flex-col gap-4">
      <div className="rounded-md border border-primary/25 bg-primary/[0.04] px-4 py-3 flex items-start gap-2.5">
        <Sparkles className="size-4 text-primary mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-primary">
            Romance de Bilionário — fluxo em duas fases
          </p>
          <p className="text-[11px] text-foreground/75 leading-relaxed">
            <span className="font-semibold">Fase 1:</span> descreva sua ideia, o agente gera um resumo (Parte 1 + Parte 2). <span className="font-semibold">Fase 2:</span> você aprova ou edita o resumo, e o agente constrói a estrutura completa (elenco, cenários, contexto histórico, 20 etapas) que vai alimentar Estrutura 1, 2 e Escrita.
          </p>
        </div>
      </div>

      {/* ─── Briefing ─── */}
      {(phase === "briefing" || phase === "approving") && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <Label htmlFor="premissa-briefing" className="text-sm font-semibold">
              Sua ideia
            </Label>
            <span className="text-[11px] text-muted-foreground">
              {phase === "briefing"
                ? "Quanto mais detalhe, melhor o resumo"
                : "Edite e clique em Regenerar resumo se quiser ajustar"}
            </span>
          </div>
          <PremissaDraftTextarea
            ref={briefingRef}
            field="briefing"
            committedValue={briefing}
            id="premissa-briefing"
            placeholder={`Ex.: Nova York, finanças/Wall Street. MMC: CEO de um conglomerado financeiro que herdou a empresa após o pai morrer. FMC: jornalista de 28 anos que perdeu o emprego e descobre que o apartamento dela foi comprado pela empresa dele. Gatilho: convivência forçada quando ela aceita um trabalho temporário na fundação cultural dele. Vilã: ex-noiva dele que ainda circula no meio social. Segredo central: o pai dele deixou uma cláusula que obriga o MMC a casar até os 35 ou perder o controle da empresa.\n\nMencione (opcional):\n• cidade (Nova York, Chicago, Seattle, Dallas, LA, San Francisco, Miami, Boston, Londres, Paris, Mônaco, Genebra, Zurique, Milão, Roma, Madri, Barcelona, Dubai, Hong Kong, Singapura, Tóquio)\n• tipo de fortuna (tecnologia, finanças, hotelaria, moda, herança antiga, imobiliário, indústria, mídia)\n• profissão e situação inicial da FMC\n• trauma central de cada um\n• gatilho inicial (humilhação pública, casamento por contrato, namoro falso, convivência forçada, dívida, projeto compartilhado)\n• segredo central que você quer ver pago\n• tipo de vilão (ex, sogra, sócio, rival corporativo)`}
            rows={phase === "briefing" ? 12 : 5}
            className="font-sans text-[14px] leading-relaxed resize-y"
          />
        </div>
      )}

      {/* ─── Resumo: aprovar/editar/regenerar ─── */}
      {phase === "approving" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="premissa-resumo" className="text-sm font-semibold">
                Resumo gerado (Parte 1 + Parte 2)
              </Label>
              <span className="text-[11px] text-muted-foreground">
                Edite à vontade. Quando estiver bom, aprove para gerar o universo completo.
              </span>
            </div>
            <Badge
              className={cn(
                "font-normal gap-1",
                resumoOutOfTarget
                  ? "bg-amber-100 text-amber-800 border-amber-300"
                  : "bg-emerald-100 text-emerald-800 border-emerald-300",
              )}
            >
              <CheckCircle2 className="size-3" />
              {resumoWordCount.toLocaleString("pt-BR")} palavras
              {resumoOutOfTarget
                ? ` (alvo ${resumoTargetMin}-${resumoTargetMax})`
                : ""}
            </Badge>
          </div>
          {isEditingResumo ? (
            <PremissaDraftTextarea
              ref={resumoRef}
              field="resumo"
              committedValue={resumo}
              id="premissa-resumo"
              rows={20}
              className="font-sans text-[14px] leading-relaxed resize-y min-h-[400px]"
            />
          ) : (
            <div className="rounded-lg border bg-card p-4 sm:p-6 max-h-[55vh] overflow-auto">
              <Prose>{resumoDraftStored || resumo}</Prose>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 flex-wrap pt-1">
            {!isEditingResumo ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingResumo(true)}
              >
                <Pencil className="size-3.5" /> Editar resumo
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    resumoRef.current?.setValue(resumo);
                    setIsEditingResumo(false);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    resumoRef.current?.flush();
                    const resumoDraft =
                      resumoRef.current?.getValue() ?? resumoDraftStored ?? resumo;
                    setOutput("premissa", {
                      content,
                      generatedAt: output?.generatedAt ?? new Date().toISOString(),
                      metadata: { ...meta, premissaResumo: resumoDraft.trim() },
                    });
                    clearDraft("premissa", "resumo");
                    setIsEditingResumo(false);
                  }}
                >
                  Salvar edição
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ─── Caixa de instruções adicionais (chat de refinamento) ─── */}
      {(() => {
        // Lê do store (debounced 400ms). O badge "Será aplicado / Correção
        // aplicada" e o estado disabled do botão atualizam após pausa de
        // digitação, não em tempo real — trade-off aceitável pelo ganho
        // de não re-renderizar PremissaWizard a cada tecla.
        const pendingInstruction = instructionDraftStored;
        const trimmedInstruction = pendingInstruction.trim();
        const instructionDirty = pendingInstruction !== savedInstruction;
        const hasInstructionContent = trimmedInstruction.length > 0;
        const canApply = hasInstructionContent && !isGenerating;
        const placeholder =
          phase === "briefing"
            ? "Ex.: tom mais intenso, foco no conflito interno do MMC, troque a cidade pra Paris..."
            : phase === "approving"
              ? "Ex.: deixe a Parte 2 mais intensa · faça a FMC ser sommelier em vez de jornalista · troque o vilão pra ex-noiva..."
              : "Ex.: ajuste a Etapa 5 pra incluir uma viagem · troque o nome do antagonista · adicione um POV do MMC na Etapa 12...";
        const buttonLabel =
          phase === "briefing" ? "Salvar instrução" : "Aplicar correção";
        const buttonTitle = !hasInstructionContent
          ? "Digite a instrução primeiro"
          : phase === "briefing"
            ? "Salva a instrução pra ser aplicada quando você clicar em Gerar resumo"
            : phase === "approving"
              ? "Regenera o resumo aplicando essa instrução"
              : "Regenera a estrutura aplicando essa instrução (mantém o resumo aprovado)";
        return (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <Label htmlFor="premissa-instructions" className="text-sm font-semibold">
                Instruções adicionais (opcional)
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {phase === "briefing"
                  ? "Salvas e aplicadas no próximo Gerar resumo"
                  : phase === "approving"
                    ? "Aplicar regenera o resumo já com essa instrução"
                    : "Aplicar regenera a estrutura mantendo o resumo aprovado"}
              </span>
            </div>
            <PremissaDraftTextarea
              ref={instructionRef}
              field="instruction"
              committedValue={savedInstruction}
              id="premissa-instructions"
              placeholder={placeholder}
              rows={3}
              className="resize-none"
            />
            <div className="flex items-center justify-end gap-2 flex-wrap">
              {!instructionDirty && hasInstructionContent && (
                <Badge
                  variant="outline"
                  className="font-normal gap-1 border-emerald-300 bg-emerald-50 text-emerald-800"
                >
                  <CheckCircle2 className="size-3" />
                  {phase === "briefing"
                    ? "Será aplicado ao gerar"
                    : "Correção aplicada"}
                </Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!canApply}
                onClick={applyInstruction}
                className="gap-2"
                title={buttonTitle}
              >
                <Send className="size-3.5" />
                {buttonLabel}
              </Button>
            </div>
          </div>
        );
      })()}

      <ReferenceImageUpload />

      {/* ─── Conteúdo final (Blocos 1-7) ─── */}
      {phase === "done" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="flex flex-col gap-0.5">
              <Label className="text-sm font-semibold">
                Universo completo da história
              </Label>
              <span className="text-[11px] text-muted-foreground">
                Resumo aprovado + Blocos 1 a 7. Vai alimentar Estrutura 1, 2 e Escrita.
              </span>
            </div>
            <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 font-normal gap-1">
              <CheckCircle2 className="size-3" />
              {contentWordCount.toLocaleString("pt-BR")} palavras
            </Badge>
          </div>
          {isEditingContent ? (
            <>
              <PremissaDraftTextarea
                ref={contentRef}
                field="content"
                committedValue={content}
                rows={24}
                className="font-mono text-[13px] leading-relaxed resize-y min-h-[500px]"
              />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    contentRef.current?.setValue(content);
                    setIsEditingContent(false);
                  }}
                >
                  Cancelar
                </Button>
                <Button size="sm" onClick={saveContentEdit}>
                  Salvar edição
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg border bg-card p-4 sm:p-6 max-h-[60vh] overflow-auto">
                <Prose>{content}</Prose>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    contentRef.current?.setValue(content);
                    setIsEditingContent(true);
                  }}
                >
                  <Pencil className="size-3.5" /> Editar
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Botões de ação por fase ─── */}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {phase === "briefing" && (
          <Button
            onClick={() => generateResumo()}
            disabled={!(briefingDraftStored || briefing).trim() || isGenerating}
            size="lg"
            className="gap-2"
          >
            <Sparkles className="size-4" /> Gerar resumo
          </Button>
        )}
        {phase === "approving" && (
          <>
            <Button
              onClick={() => approveAndGenerateEstrutura()}
              disabled={!(resumoDraftStored || resumo).trim() || isGenerating}
              size="lg"
              className="gap-2"
            >
              <CheckCircle2 className="size-4" /> Aprovar e gerar estrutura
            </Button>
            <Button
              onClick={() => generateResumo()}
              disabled={!(briefingDraftStored || briefing).trim() || isGenerating}
              variant="outline"
              size="lg"
              className="gap-2"
            >
              <RotateCcw className="size-4" /> Regenerar resumo
            </Button>
          </>
        )}
        {phase === "done" && (
          <Button
            onClick={() => approveAndGenerateEstrutura()}
            disabled={!(resumoDraftStored || resumo).trim() || isGenerating}
            variant="outline"
            size="sm"
            className="gap-2"
          >
            <RotateCcw className="size-3.5" /> Regenerar estrutura
          </Button>
        )}
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={switchToManual}
            className="text-muted-foreground"
          >
            Já tenho a premissa pronta — colar manualmente
          </Button>
        </div>
      </div>
    </section>
  );
}

function BatchWarningsBanner({
  warnings,
}: {
  warnings: BatchMissingChapters[];
}) {
  const totalMissing = warnings.reduce((sum, w) => sum + w.missing.length, 0);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex gap-3">
      <AlertTriangle className="size-5 flex-none text-amber-700 mt-0.5" />
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium text-amber-900">
          {totalMissing === 1
            ? "1 capítulo não foi gerado"
            : `${totalMissing} capítulos não foram gerados`}
        </p>
        <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
          {warnings.map((w, i) => (
            <li key={`${w.batchIndex}-${i}`}>
              <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                {w.part} · Par {w.batchIndex}
              </span>
              esperado capítulo
              {w.expected.length === 1 ? " " : "s "}
              {w.expected.join(", ")} — não detectado
              {w.missing.length === 1 ? ": " : "s: "}
              <strong>{w.missing.join(", ")}</strong>
            </li>
          ))}
        </ul>
        <p className="text-amber-800/80 text-xs">
          O agente Opus emitiu menos cabeçalhos{" "}
          <code className="text-[11px]">## Capítulo N</code> do que o esperado
          neste par. Clique em <strong>Gerar roteiro novamente</strong> pra
          refazer.
        </p>
      </div>
    </div>
  );
}

function EscritaOutputView({
  output,
  chapterTargets,
}: {
  output: StepOutput;
  chapterTargets?: Map<string, number>;
}) {
  const setOutput = useWizard((s) => s.setOutput);
  const pushOutputToHistory = useWizard((s) => s.pushOutputToHistory);

  const chapters = output.metadata?.chapters ?? [];
  const memory = output.metadata?.memory;
  const report = output.metadata?.report;
  const validation = output.metadata?.validation;
  const validationStatus = output.metadata?.validationStatus;
  const batchWarnings = output.metadata?.batchWarnings ?? [];

  // Edição inline por capítulo: substitui o conteúdo do capítulo no metadata,
  // re-concatena `output.content` e empurra um snapshot pro histórico antes
  // de aplicar (mesmo padrão das demais edições). Sem isso a edição manual de
  // um capítulo não-último era impossível pelo header (que só editava o último).
  const saveChapter = useCallback(
    (idx: number, newContent: string) => {
      const current = output.metadata?.chapters;
      if (!current || !current[idx]) return;
      pushOutputToHistory("escrita", `Antes da edição manual do Cap ${current[idx].number}`);
      const next = [...current];
      next[idx] = {
        ...next[idx]!,
        content: newContent,
        edited: true,
        editedAt: new Date().toISOString(),
      };
      setOutput("escrita", {
        ...output,
        content: concatenateChapters(next),
        metadata: { ...output.metadata, chapters: next },
        edited: true,
        editedAt: new Date().toISOString(),
      });
    },
    [output, setOutput, pushOutputToHistory],
  );

  // Fallback — output sem chapters[]: renderiza monolítico (output cru).
  if (chapters.length === 0) {
    return (
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex flex-col divide-y divide-border/60">
          <SectionBanner label="CAPÍTULO" />
          <div className="px-4 sm:px-6 py-5">
            <Prose>{output.content}</Prose>
          </div>
          {report && (
            <>
              <SectionBanner label="RELATÓRIO DE AUTO-REVISÃO" />
              <div className="px-4 sm:px-6 py-5">
                <Prose size="sm">{report}</Prose>
              </div>
            </>
          )}
          {memory && (
            <>
              <SectionBanner label="MEMÓRIA VIVA ATUALIZADA" />
              <div className="px-4 sm:px-5 py-4">
                <MemoryVivaCard memoryJson={memory} />
              </div>
            </>
          )}
          {validation && (
            <>
              <SectionBanner label="VALIDAÇÃO" />
              <div className="px-4 sm:px-6 py-5">
                <Prose size="sm">{validation}</Prose>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {batchWarnings.length > 0 && (
        <BatchWarningsBanner warnings={batchWarnings} />
      )}
      <div className="flex flex-col gap-3">
        {chapters.map((ch, i) => {
          const isLast = i === chapters.length - 1;
          // key por número+parte é estável: reordenação/inserção não bagunça
          // a identidade dos cards (era key={i} antes — que misturava a state
          // local de `isEditing`/`draft` quando a lista mudava).
          const key = `${ch.part ?? "x"}-${ch.number}`;
          const target = ch.part
            ? chapterTargets?.get(`${ch.part}:${ch.number}`)
            : undefined;
          return (
            <ChapterCard
              key={key}
              chapter={ch}
              chapterIndex={i}
              defaultOpen={isLast}
              targetWordCount={target}
              onSave={saveChapter}
            />
          );
        })}
      </div>

      {report && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <SectionBanner label="RELATÓRIO DE AUTO-REVISÃO" />
          <div className="px-4 sm:px-6 py-5">
            <Prose size="sm">{report}</Prose>
          </div>
        </div>
      )}

      {memory && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <SectionBanner label="MEMÓRIA VIVA ATUALIZADA" />
          <div className="px-4 sm:px-5 py-4">
            <MemoryVivaCard memoryJson={memory} />
          </div>
        </div>
      )}

      {validation && (
        <div className="rounded-lg border bg-card overflow-hidden">
          <SectionBanner
            label={
              validationStatus === "BLOQUEADO"
                ? "VALIDAÇÃO — BLOQUEADO"
                : validationStatus === "APROVADO"
                  ? "VALIDAÇÃO — APROVADO"
                  : "VALIDAÇÃO"
            }
          />
          <div className="px-4 sm:px-6 py-5">
            <Prose size="sm">{validation}</Prose>
          </div>
        </div>
      )}
    </div>
  );
}

// React.memo: ChapterCard é renderizado em lista (até 14 cards na tela ao mesmo
// tempo durante a Escrita). Sem memo, qualquer re-render do parent (typing num
// textarea próximo, tick de stream throttled, mudança em metadata) reconciliava
// todos os cards. Como `chapter` é objeto, dependemos de o pai usar referências
// estáveis vindas do store (useWizard preserva a identidade quando o item não
// muda). `onSave` recebe (idx, content) — sem isso, o pai precisaria criar uma
// arrow inline por render `(c) => save(i, c)` que invalida o memo.
const ChapterCard = memo(function ChapterCard({
  chapter,
  chapterIndex,
  defaultOpen,
  targetWordCount,
  onSave,
}: {
  chapter: EscritaChapter;
  chapterIndex: number;
  defaultOpen: boolean;
  targetWordCount?: number;
  onSave?: (idx: number, newContent: string) => void;
}) {
  const titleLabel = chapter.title
    ? `Capítulo ${chapter.number} — ${chapter.title}`
    : `Capítulo ${chapter.number}`;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(chapter.content);

  // realCount é usado no header — sem memo, era recalculado a cada render do
  // card, mesmo quando o conteúdo do capítulo (até 1k palavras) não tinha mudado.
  const realCount = useMemo(() => countWords(chapter.content), [chapter.content]);

  // Se o conteúdo do capítulo mudar (ex: revisor aplicou correção, ou snapshot
  // restaurado), sincroniza o draft local quando NÃO estiver editando.
  useEffect(() => {
    if (!isEditing) setDraft(chapter.content);
  }, [chapter.content, isEditing]);

  const startEdit = useCallback(() => {
    setDraft(chapter.content);
    setIsEditing(true);
  }, [chapter.content]);

  const cancelEdit = useCallback(() => {
    setDraft(chapter.content);
    setIsEditing(false);
  }, [chapter.content]);

  const saveEdit = useCallback(() => {
    if (onSave) onSave(chapterIndex, draft);
    setIsEditing(false);
  }, [chapterIndex, draft, onSave]);

  return (
    <details
      open={defaultOpen || isEditing}
      className="group rounded-lg border bg-card overflow-hidden"
    >
      <summary className="list-none cursor-pointer px-4 sm:px-5 py-3 flex items-center gap-3 bg-muted/30 hover:bg-muted/50 transition">
        <span className="size-8 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">
          {chapter.number}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="font-serif text-base tracking-tight truncate">
            {titleLabel}
          </span>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            {chapter.part && (
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                {chapter.part}
              </span>
            )}
            {(() => {
              const declaredCount = chapter.wordCount;
              const showDeclared =
                typeof declaredCount === "number" &&
                Math.abs(declaredCount - realCount) > 30;
              const withinTarget =
                typeof targetWordCount === "number"
                  ? isWithinTarget(realCount, targetWordCount)
                  : null;
              const targetClass =
                withinTarget === true
                  ? "text-emerald-700"
                  : withinTarget === false
                    ? "text-amber-700"
                    : "text-muted-foreground";
              const targetIcon =
                withinTarget === true ? "✓" : withinTarget === false ? "⚠" : "";
              return (
                <span className={`text-[10px] ${targetClass}`}>
                  {targetIcon && <span className="mr-1">{targetIcon}</span>}
                  {realCount.toLocaleString("pt-BR")} palavras
                  {typeof targetWordCount === "number" && (
                    <span
                      className="ml-1 opacity-70"
                      title={`Alvo da estrutura: ${targetWordCount.toLocaleString("pt-BR")} ±3%`}
                    >
                      / {targetWordCount.toLocaleString("pt-BR")}
                    </span>
                  )}
                  {showDeclared && (
                    <span
                      className="ml-1 text-amber-700"
                      title="A contagem que o agente declarou difere do conteúdo real"
                    >
                      (declarou {declaredCount?.toLocaleString("pt-BR")})
                    </span>
                  )}
                </span>
              );
            })()}
            {chapter.edited && (
              <span className="text-[10px] text-amber-700">
                editado manualmente
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

      <div className="flex flex-col divide-y divide-border/60">
        <div className="px-4 sm:px-6 py-5">
          {onSave && (
            <div className="flex items-center justify-end gap-2 mb-3">
              {!isEditing ? (
                <Button variant="ghost" size="sm" onClick={startEdit}>
                  <Pencil className="size-3.5" />
                  Editar
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={cancelEdit}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={saveEdit}>
                    Salvar
                  </Button>
                </>
              )}
            </div>
          )}

          {isEditing ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={20}
              className="font-mono text-sm"
            />
          ) : (
            <Prose>{chapter.content}</Prose>
          )}

          {chapter.cliffhanger && !isEditing && (
            <p className="text-[12px] text-foreground/70 mt-3 italic border-l-2 border-primary/40 pl-3">
              <span className="font-semibold not-italic text-primary/80">
                Cliffhanger:
              </span>{" "}
              {chapter.cliffhanger}
            </p>
          )}
          {chapter.edited && !isEditing && (
            <p className="text-[11px] text-muted-foreground mt-3">
              Editado manualmente em{" "}
              {chapter.editedAt
                ? new Date(chapter.editedAt).toLocaleString("pt-BR")
                : "—"}
            </p>
          )}
        </div>
      </div>
    </details>
  );
});

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Formata "tempo decorrido desde X" em pt-BR amigável: "agora há pouco",
 * "há X minutos", "há X horas", "há X dias". Usado pelo banner de geração
 * interrompida pra mostrar há quanto tempo o stream foi cortado.
 */
function formatTimeSince(iso: string | undefined): string {
  if (!iso) return "agora há pouco";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "agora há pouco";
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return "agora há pouco";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} minuto${diffMin === 1 ? "" : "s"}`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `há ${diffH} hora${diffH === 1 ? "" : "s"}`;
  const diffD = Math.floor(diffH / 24);
  return `há ${diffD} dia${diffD === 1 ? "" : "s"}`;
}

/**
 * Banner mostrado em Estrutura 1/2 quando o output corrente tem o flag
 * `partial:true` (geração interrompida no meio do stream — freeze, app
 * fechado, crash, perda de rede). O texto parcial está preservado em
 * `output.content` e os botões oferecem dois caminhos:
 *
 * - Continuar de onde parou: dispara `generate("continue")` que envia o
 *   partial pro agente como `currentOutput` + `continuationMode: true`. O
 *   agente Estrutura recebe um prompt instruindo a continuar exatamente do
 *   ponto onde o partial termina, sem repetir nem recomeçar.
 * - Descartar e regenerar: dispara `generate("regenerate", "Parcial
 *   descartado")` — o partial vira histórico (recuperável) e o stream começa
 *   do zero.
 *
 * O campo "Instruções adicionais" (acima do output, sub-componente
 * StepUserInputBox) continua disponível e é incorporado no prompt da
 * continuação automaticamente — útil pra ajustes ("foque mais no MMC").
 */
function InterruptedGenerationBanner({
  startedAt,
  partialLength,
  onContinue,
  onDiscardAndRegenerate,
}: {
  startedAt?: string;
  partialLength: number;
  onContinue: () => void;
  onDiscardAndRegenerate: () => void;
}) {
  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-4 sm:px-5 py-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 flex-none text-amber-700 mt-0.5" />
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">
            Geração interrompida {formatTimeSince(startedAt)} — output parcial
            preservado abaixo
          </p>
          <p className="text-xs text-amber-800/90">
            {partialLength.toLocaleString("pt-BR")} caracteres salvos. Você
            pode continuar de onde a IA parou (mantém o que já foi gerado) ou
            descartar e gerar do zero. Use a caixa de &quot;Instruções
            adicionais&quot; acima se quiser orientar a continuação.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <Button
          onClick={onContinue}
          size="sm"
          className="gap-2 bg-amber-700 hover:bg-amber-800 text-white"
        >
          <Sparkles className="size-3.5" />
          Continuar de onde parou
        </Button>
        <Button
          onClick={onDiscardAndRegenerate}
          size="sm"
          variant="outline"
          className="gap-2 border-amber-300 text-amber-900 hover:bg-amber-100"
        >
          <RotateCcw className="size-3.5" />
          Descartar e regenerar
        </Button>
      </div>
    </div>
  );
}

function BatchProgressPanel({
  progress,
  liveStream,
  revisorPhase,
  elapsedSec,
}: {
  progress: WizardProgress;
  liveStream: string;
  revisorPhase?: "streaming" | "extracting" | null;
  elapsedSec?: number;
}) {
  let title: string;
  let subtitle: string;
  let placeholder: string;
  let phaseBanner: string | null = null;

  if (progress.kind === "writing") {
    const chapsLabel =
      progress.chapters.length === 2
        ? `Capítulos ${progress.chapters[0]} e ${progress.chapters[1]}`
        : `Capítulo ${progress.chapters[0]}`;
    title = `Par ${progress.batchIndex} de ${progress.totalBatches}`;
    subtitle = `· ${chapsLabel} da ${progress.part}`;
    placeholder = "Conectando ao agente…";
  } else {
    // revising
    title = "Revisão final";
    subtitle = `· ${progress.chaptersCount} capítulos · Opus`;
    if (revisorPhase === "extracting") {
      phaseBanner = "Etapa 2/2 — Extraindo cards de correção (~3min)";
      placeholder =
        "Relendo a revisão pra estruturar os cards… os cards aparecem assim que terminar.";
    } else {
      // streaming (default)
      phaseBanner = "Etapa 1/2 — Análise narrativa do roteiro (~5min)";
      placeholder =
        "Revisor lendo o roteiro completo… os primeiros parágrafos costumam levar 1-2min pra aparecer.";
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.03] overflow-hidden">
      <div className="px-4 sm:px-5 py-3 bg-primary/10 border-b border-primary/30 flex items-center gap-3 flex-wrap">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span className="text-sm font-semibold text-primary">{title}</span>
        <span className="text-xs text-foreground/70">{subtitle}</span>
        {typeof elapsedSec === "number" && (
          <span className="ml-auto text-xs font-mono text-foreground/70 tabular-nums">
            ⏱ {formatElapsed(elapsedSec)}
          </span>
        )}
      </div>
      {phaseBanner && (
        <div className="px-4 sm:px-5 py-2 bg-primary/[0.06] border-b border-primary/20 text-xs text-foreground/75">
          {phaseBanner}
        </div>
      )}
      <div className="px-4 sm:px-5 py-4 max-h-[55vh] overflow-auto">
        {liveStream ? (
          <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed">
            {liveStream}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground italic">{placeholder}</p>
        )}
      </div>
    </div>
  );
}

function SectionBanner({ label }: { label: string }) {
  return (
    <div className="px-4 sm:px-5 py-2.5 bg-muted/40 border-y border-border/60 flex items-center gap-2">
      <span className="text-muted-foreground text-xs select-none">
        ═══════════
      </span>
      <span className="text-[11px] font-bold tracking-[0.2em] text-foreground/70 uppercase">
        {label}
      </span>
      <span className="text-muted-foreground text-xs select-none flex-1 overflow-hidden">
        ═══════════════════════════════════════
      </span>
    </div>
  );
}

interface MetadataPanelProps {
  report?: string;
  memory?: string;
  validation?: string;
  validationStatus?: "APROVADO" | "BLOQUEADO";
  onCopy: (text: string) => void;
}

function MetadataPanel({
  report,
  memory,
  validation,
  validationStatus,
  onCopy,
}: MetadataPanelProps) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ClipboardCheck className="size-4 text-muted-foreground" />
        <Label className="text-sm font-semibold text-muted-foreground">
          Dados auxiliares da geração
        </Label>
      </div>

      <div className="flex flex-col gap-2">
        {report && (
          <MetadataBlock
            icon={<FileText className="size-4" />}
            title="Relatório de auto-revisão"
            subtitle="Passadas focadas (espaço, tempo, cruzamento, POV, 1ª pessoa) e checklist"
            content={report}
            onCopy={() => onCopy(report)}
            monospace={false}
          />
        )}
        {memory && (
          <MetadataBlock
            icon={<Sparkles className="size-4" />}
            title="Memória viva (JSON)"
            subtitle="Estado vivo da história — usada automaticamente no próximo capítulo"
            content={memory}
            onCopy={() => onCopy(memory)}
            monospace={true}
          />
        )}
        {validation && (
          <MetadataBlock
            icon={
              validationStatus === "BLOQUEADO" ? (
                <AlertTriangle className="size-4 text-red-600" />
              ) : (
                <CheckCircle2 className="size-4 text-emerald-600" />
              )
            }
            title={`Validação — ${validationStatus ?? "sem status"}`}
            subtitle="8 regras bloqueantes verificadas após a auto-revisão"
            content={validation}
            onCopy={() => onCopy(validation)}
            monospace={false}
          />
        )}
      </div>
    </section>
  );
}

interface MetadataBlockProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  content: string;
  onCopy: () => void;
  monospace: boolean;
}

function MetadataBlock({
  icon,
  title,
  subtitle,
  content,
  onCopy,
  monospace,
}: MetadataBlockProps) {
  return (
    <details className="group border rounded-lg bg-muted/20">
      <summary className="list-none cursor-pointer px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground">{icon}</span>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-medium truncate">{title}</span>
            <span className="text-[11px] text-muted-foreground truncate">
              {subtitle}
            </span>
          </div>
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0 group-open:hidden">
          expandir
        </span>
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-2">
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault();
              onCopy();
            }}
            className="text-xs h-7"
          >
            <Copy className="size-3" /> Copiar
          </Button>
        </div>
        {monospace ? (
          <pre className="text-xs whitespace-pre-wrap bg-background border rounded-md p-3 max-h-80 overflow-auto font-mono">
            {content}
          </pre>
        ) : (
          <div className="bg-background border rounded-md p-4 max-h-80 overflow-auto">
            <Prose size="sm">{content}</Prose>
          </div>
        )}
      </div>
    </details>
  );
}
