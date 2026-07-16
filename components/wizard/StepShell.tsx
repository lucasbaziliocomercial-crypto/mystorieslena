"use client";

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
  displayNodeIndex,
  isRevisorStep,
  nextStep,
  partOfRevisorStep,
  prevStep,
  type BatchMissingChapters,
  type EscritaChapter,
  type EscritaSynopsis,
  type EvalSnapshot,
  type RevisorError,
  type RevisorHateRisk,
  type StepId,
  type StepOutput,
} from "@/types/roteiro";
import { useWizard } from "@/store/wizard";
import { useQueue } from "@/store/queue";
import { abortJob } from "@/lib/generation/job-control";
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
  gravityLabel,
  hashEscritaContent,
  parseMarkdownErrorList,
  parseRevisorErrors,
  parseRevisorHateRisk,
  parseRevisorNota,
  serializeRevisorErrors,
  stripErrosDetalhados,
} from "@/lib/parse-revisor-output";
import {
  applyCorrectionPatches,
  parseCorrectionPatches,
} from "@/lib/parse-correction-patches";
import { mergeContinuation } from "@/lib/parse-continuation-overlap";
import { aggregatePreviousRevisorErrors } from "@/lib/revisor-continuation";
import { RevisorErrorsView } from "@/components/wizard/RevisorErrorsView";
import { RevisorPartTabs } from "@/components/wizard/RevisorPartTabs";
import {
  countChaptersInEstrutura,
  planBatches,
} from "@/lib/parse-estrutura-chapters";
import { parseEscritaBatch } from "@/lib/parse-escrita-batch";
import { canonPart, dedupChaptersLast } from "@/lib/dedup-chapters";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  CALIBRATION_THRESHOLD,
  CALIBRATION_CONCURRENCY,
} from "@/lib/escrita-calibration";
import {
  extractChapterTargets,
  isWithinTarget,
} from "@/lib/parse-estrutura-targets";
import { normalizeEstruturaTargets } from "@/lib/normalize-estrutura-targets";
import { splitThinking } from "@/lib/stream-markers";
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
  // O checkpoint persiste APENAS o conteúdo final (sem o raciocínio) — o
  // partial salvo em localStorage não pode carregar marcadores nem thinking.
  // O preview ao vivo (setLive) recebe o texto CRU com marcadores; a UI
  // separa e mostra o raciocínio esmaecido. Ver lib/stream-markers.ts.
  if (onCheckpoint) {
    checkpointId = setInterval(() => {
      const clean = splitThinking(acc).content;
      if (clean.length > 0 && clean !== lastCheckpointed) {
        lastCheckpointed = clean;
        onCheckpoint(clean);
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
    if (onCheckpoint) {
      const clean = splitThinking(acc).content;
      if (clean.length > 0 && clean !== lastCheckpointed) {
        onCheckpoint(clean);
      }
    }
    setLive(acc);
  }
  // Retorna o conteúdo final SEM o raciocínio — todo callsite que finaliza
  // (parse, setOutput, merge) consome texto limpo, sem precisar saber dos
  // marcadores. Pros steps sem thinking, splitThinking é identidade.
  return splitThinking(acc).content;
}

/**
 * Preview ao vivo que separa o raciocínio (thinking) do conteúdo. Enquanto o
 * modelo só pensa (Estrutura roda com thinking adaptive), mostra o raciocínio
 * ESMAECIDO sob o rótulo "Pensando…"; assim que o texto real começa a fluir,
 * troca pro conteúdo no estilo normal. Pros steps sem thinking, `raw` nunca tem
 * marcadores e isto renderiza só o conteúdo (idêntico ao comportamento antigo).
 * Ver lib/stream-markers.ts.
 */
function LiveStreamPreview({
  raw,
  contentClassName,
  tail,
}: {
  raw: string;
  contentClassName: string;
  tail?: number;
}) {
  const { thinking, content } = splitThinking(raw);
  // Clipa a CAUDA (proteção OOM: um output anômalo não pode inflar o <pre> e
  // sufocar o renderer — ver MEMORY.md). Prefixa um aviso quando trunca.
  const clip = (s: string) =>
    tail && s.length > tail
      ? `… (mostrando o trecho mais recente)\n\n${s.slice(-tail)}`
      : s;
  if (content) {
    return <pre className={contentClassName}>{clip(content)}</pre>;
  }
  if (thinking) {
    return (
      <div className="flex flex-col gap-1.5 border-t border-primary/20 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" />
          Pensando…
        </span>
        <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed italic text-muted-foreground/60 max-h-48 overflow-auto">
          {clip(thinking)}
        </pre>
      </div>
    );
  }
  return null;
}

/**
 * Banner de veredito do Revisor (advisory — NUNCA bloqueia). Mostra a Nota e a
 * contagem de erros por gravidade e sugere se a roteirista PODE FINALIZAR ou se
 * VALE MAIS UMA RODADA. Critério (decisão do usuário): Nota ≥ 8 E zero erros
 * gravíssimos. Computado no display a partir do relatório + metadata.errors —
 * objetivo: cortar a 3ª revisão por hábito quando 2 já bastam (a 1ª geração é a
 * mais lenta, então pular uma rodada economiza tempo real). Ver MEMORY.md.
 */
const HATE_RISK_LABEL: Record<
  RevisorHateRisk,
  { emoji: string; label: string }
> = {
  baixo: { emoji: "🟢", label: "hate baixo" },
  medio: { emoji: "🟡", label: "hate médio" },
  alto: { emoji: "🔴", label: "hate alto" },
};

/** Tempo relativo compacto pra trilha de qualidade ("agora", "há 5 min"…). */
function evalRelTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

function RevisorVerdictBanner({
  content,
  errors,
  evals,
  part,
}: {
  content: string;
  errors: RevisorError[];
  evals: EvalSnapshot[];
  part: 1 | 2;
}) {
  const nota = parseRevisorNota(content);
  const hateRisk = parseRevisorHateRisk(content);
  const counts = { gravissimo: 0, interfere: 0, atencao: 0, naoInterfere: 0 };
  // SÓ os pendentes contam pro veredito. Um erro aplicado (`applied`) continua no
  // array (vai pra seção "correções já aplicadas"), então contá-lo travava o
  // banner em amarelo pra sempre: mesmo depois de corrigir todos os gravíssimos,
  // `counts.gravissimo` nunca zerava e "✅ Pode finalizar" nunca aparecia. Contar
  // só os não-aplicados alinha o banner ao "N pendentes" das abas e deixa ele
  // virar verde assim que os graves são aplicados.
  for (const e of errors) if (!e.applied) counts[e.gravidade] += 1;

  const order = ["gravissimo", "interfere", "atencao", "naoInterfere"] as const;
  const countChips = order
    .filter((g) => counts[g] > 0)
    .map(
      (g) =>
        `${gravityLabel(g).emoji} ${counts[g]} ${gravityLabel(g).label.toLowerCase()}`,
    )
    .join(" · ");

  const canFinish = nota !== null && nota >= 8 && counts.gravissimo === 0;
  const reason =
    nota === null
      ? "nota não detectada — confira no relatório"
      : counts.gravissimo > 0
        ? `${counts.gravissimo} gravíssimo${counts.gravissimo > 1 ? "s" : ""} a resolver`
        : nota < 8
          ? "nota abaixo de 8"
          : "";

  // Trilha versionada desta Parte (mais antigo → mais recente). O eval da
  // rodada atual já foi gravado quando a geração terminou, então o último item
  // é o atual e o penúltimo é a rodada anterior (base do Δ).
  const partEvals = evals.filter((e) => e.parte === part);
  const prev =
    partEvals.length >= 2 ? partEvals[partEvals.length - 2] : undefined;
  const delta =
    nota !== null && prev?.nota != null
      ? Math.round((nota - prev.nota) * 10) / 10
      : null;
  // Últimas rodadas (mais recente primeiro), cap 6, pra o histórico de qualidade.
  const recent = [...partEvals].reverse().slice(0, 6);

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 flex flex-col gap-2",
        canFinish
          ? "border-emerald-300 bg-emerald-50"
          : "border-amber-300 bg-amber-50",
      )}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold tabular-nums">
          ⭐ Nota {nota !== null ? `${nota}/10` : "—"}
        </span>
        {delta !== null && delta !== 0 && (
          <span
            className={cn(
              "text-xs font-semibold tabular-nums",
              delta > 0 ? "text-emerald-700" : "text-rose-700",
            )}
            title="Variação vs a rodada de revisão anterior desta Parte"
          >
            {delta > 0 ? `▲ +${delta}` : `▼ ${delta}`}
          </span>
        )}
        {hateRisk && (
          <span className="text-xs font-medium tabular-nums">
            {HATE_RISK_LABEL[hateRisk].emoji} {HATE_RISK_LABEL[hateRisk].label}
          </span>
        )}
        <span
          className={cn(
            "text-sm font-semibold",
            canFinish ? "text-emerald-800" : "text-amber-800",
          )}
        >
          {canFinish ? "✅ Pode finalizar" : "⚠️ Vale mais uma rodada"}
        </span>
        {!canFinish && reason && (
          <span className="text-xs text-muted-foreground">({reason})</span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {countChips || "Nenhum erro estruturado apontado."}
      </div>

      {!canFinish && counts.gravissimo > 0 && (
        <div className="text-xs leading-snug text-amber-900 bg-amber-100/70 border border-amber-200 rounded px-2.5 py-1.5">
          <span className="font-semibold">
            Re-rodar a revisão NÃO tira estes erros graves.
          </span>{" "}
          Eles estão no texto da história — revisar de novo sem mudar o texto
          acha sempre os mesmos. Para zerar: aplique a correção de cada erro
          grave no botão <span className="font-semibold">Aplicar</span> do card
          (quando o card for um AVISO, ajuste o trecho no Step 4) e só{" "}
          <span className="font-semibold">depois</span> re-revise uma vez.
        </div>
      )}

      {canFinish && counts.interfere + counts.atencao > 0 && (
        <div className="text-xs leading-snug text-emerald-900 bg-emerald-100/70 border border-emerald-200 rounded px-2.5 py-1.5">
          <span className="font-semibold">
            Este roteiro já pode ser finalizado.
          </span>{" "}
          Os {counts.interfere + counts.atencao} pontos restantes (
          {counts.interfere > 0 ? "Interfere/Atenção" : "Atenção"}) são
          refinamentos <span className="font-semibold">opcionais</span> — não
          são gravíssimos e não travam a entrega. Aplique pelos cards os que
          quiser; <span className="font-semibold">não</span> precisa re-gerar
          nem re-revisar pra "zerar".
        </div>
      )}

      {recent.length >= 2 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
            📈 Histórico de qualidade ({partEvals.length} rodada
            {partEvals.length > 1 ? "s" : ""})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {recent.map((ev, i) => {
              const erros =
                ev.counts.gravissimo +
                ev.counts.interfere +
                ev.counts.atencao +
                ev.counts.naoInterfere;
              return (
                <li
                  key={ev.id}
                  className="flex items-center gap-2 tabular-nums text-muted-foreground"
                >
                  <span className="font-semibold text-foreground">
                    {ev.nota !== null ? `${ev.nota}/10` : "—"}
                  </span>
                  {ev.hateRisk && (
                    <span>{HATE_RISK_LABEL[ev.hateRisk].emoji}</span>
                  )}
                  <span>
                    {erros} erro{erros === 1 ? "" : "s"}
                  </span>
                  {ev.canFinish && <span className="text-emerald-700">✅</span>}
                  <span className="text-muted-foreground/60">
                    {evalRelTime(ev.at)}
                    {i === 0 ? " · atual" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      <p className="text-[10px] text-muted-foreground/70">
        Sugestão automática (Nota ≥ 8 e sem gravíssimos) — você decide; não trava
        nada. O histórico mostra se cada re-rodada melhorou ou piorou.
      </p>
    </div>
  );
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
    }
  | {
      // Calibração automática de word count — só dispara pra caps que saem
      // >15% fora do alvo declarado na Estrutura. Idempotente: caps já dentro
      // da faixa são pulados; rodar de novo após nova geração é seguro.
      kind: "calibrating";
      part: "Parte 1" | "Parte 2";
      chapter: number;
      currentWords: number;
      targetWords: number;
      /** Posição no loop pra UI mostrar "calibrando 2 de 5". */
      currentIndex: number;
      totalToCalibrate: number;
    };

const PART_BANNER = (part: string) =>
  `═══════════════════════════════════════\n${part.toUpperCase()}\n═══════════════════════════════════════`;

// Contador de palavras: SEMPRE `countWords` de @/lib/word-count.
// Importado acima. NUNCA criar outro contador local — split(/\s+/) ingênuo
// conta diferente porque não trata `—`, `–`, `-` (separadores em diálogo).
// Toda divergência entre o contador do backend e o da UI vira bug de
// fix-wordcount/balance pedindo expansão errada.

/**
 * Saídas-sentinela: strings curtas que um agente devolve em vez de conteúdo
 * real (ex.: bloqueio por falta de título, "nenhuma alteração necessária").
 * Avançar a automação com uma dessas contamina os steps seguintes — então a
 * "Avançar auto" precisa parar nelas e deixar a saída visível pra roteirista.
 */
function isSentinelOutput(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (/^\[[^\]]*\]$/.test(t)) return true; // saída inteira é um único marcador [..]
  return /^\[(TÍTULO AUSENTE|NENHUMA_ALTERACAO_NECESSARIA)/i.test(t);
}

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
  const recordEval = useWizard((s) => s.recordEval);
  const updateOutputContent = useWizard((s) => s.updateOutputContent);
  const setUserInput = useWizard((s) => s.setUserInput);
  const clearDraft = useWizard((s) => s.clearDraft);
  const setCurrentStep = useWizard((s) => s.setCurrentStep);
  const pushOutputToHistory = useWizard((s) => s.pushOutputToHistory);
  // Texto ao vivo de um job rodando em 2º plano (alimentado pelo QueueRunner só
  // quando o roteiro do job é este). Só usado no banner do stepJob abaixo.
  // Mapa por step → lê só a chave DESTE step (revisor1 e revisor2 rodam juntos e
  // não podem clobberar o preview um do outro).
  const queueLiveStream = useWizard((s) => s.queueLiveStream[step] ?? "");
  const enqueueStep = useQueue((s) => s.enqueue);
  const removeJob = useQueue((s) => s.removeJob);
  const queueJobs = useQueue((s) => s.jobs);

  // Steps que rodam no gerenciador persistente (sobrevivem a trocar/fechar guia).
  const isPersistentStep =
    step === "escrita" ||
    step === "estrutura1" ||
    step === "estrutura2" ||
    isRevisorStep(step) ||
    step === "overview";

  // Job ATIVO (rodando/na fila) deste roteiro+step — quando existe, a geração
  // está acontecendo no gerenciador persistente, não no componente.
  const stepJob =
    roteiro && isPersistentStep
      ? queueJobs.find(
          (j) =>
            j.roteiroId === roteiro.id &&
            j.step === step &&
            (j.status === "running" || j.status === "queued"),
        )
      : undefined;

  // Algum job de Revisão (P1 ou P2) ativo neste roteiro — usado pelo botão
  // "Revisar as duas Partes em paralelo" pra refletir estado e desabilitar.
  const revisorJobActive =
    !!roteiro &&
    queueJobs.some(
      (j) =>
        j.roteiroId === roteiro.id &&
        (j.step === "revisor1" || j.step === "revisor2") &&
        (j.status === "running" || j.status === "queued"),
    );

  // Último job com ERRO deste roteiro+step (Escrita) — pra mostrar a causa real
  // (login/cota/rede) no banner de "interrompida", em vez de só "interrompida".
  const erroredJob =
    roteiro && step === "escrita" && !stepJob
      ? queueJobs.find(
          (j) =>
            j.roteiroId === roteiro.id &&
            j.step === step &&
            j.status === "error",
        )
      : undefined;

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
  // Índice (em metadata.chapters) do capítulo sendo regerado individualmente
  // via botão "Regerar" no card. null quando nada está em curso. Usado pra
  // mostrar spinner no card certo e desabilitar os outros botões durante a
  // regeração — sem isso, dois cliques rápidos disparam regerações concorrentes
  // sobre o mesmo array de chapters e duplicatam estado.
  const [regeneratingChapterIdx, setRegeneratingChapterIdx] = useState<
    number | null
  >(null);
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

  // [perf] loga no console o tempo de cada geração FOREGROUND (refine, continue,
  // "Continuar revisão"). O caminho que enfileira na fila retorna ANTES de
  // setIsGenerating(true)/generationStartRef, então só caem aqui as gerações de
  // fato no componente — as gerações "Gerar" pesadas são cronometradas no
  // QueueRunner. Loga na transição true→false e zera o ref pra não duplicar.
  useEffect(() => {
    if (isGenerating || generationStartRef.current == null) return;
    const secs = ((Date.now() - generationStartRef.current) / 1000).toFixed(1);
    console.info(`[perf] ${step} (foreground) levou ${secs}s`);
    generationStartRef.current = null;
  }, [isGenerating, step]);

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
  // Escrita incompleta: já tem capítulos salvos (rodada anterior persistida via
  // `onPartial`), mas faltam — gerou menos que o esperado pelas estruturas, ou
  // algum batch deixou warning de cap faltando/erro fatal. Só conta como
  // "retomável" quando não há job rodando/na fila pra este roteiro+step.
  const escritaIncomplete = useMemo(() => {
    if (step !== "escrita" || stepJob || isGenerating) return false;
    if (chapterCount === 0 || expectedChapterCount === 0) return false;
    const warnings = output?.metadata?.batchWarnings ?? [];
    const hasGap = warnings.some(
      (w) =>
        w.fatalError ||
        (w.missing?.length ?? 0) > 0 ||
        // Total da Parte fechou ABAIXO do piso da faixa (calibração/balanço
        // falhou por cota) — o aviso fica SALVO em batchWarnings, então o banner
        // de "Continuar geração" persiste mesmo após reiniciar o app (quando o
        // job com erro já foi podado). Só o lado CURTO conta como incompleto;
        // acima do teto (raro) não é "faltando". Espelha o guard de completude
        // do motor (run-escrita.ts / escrita-completeness.ts). Bug "o doc não
        // respeita a contagem", 16/07/2026.
        (w.partTotalOutOfRange != null &&
          w.partTotalOutOfRange.total < w.partTotalOutOfRange.min),
    );
    return chapterCount < expectedChapterCount || hasGap;
  }, [step, stepJob, isGenerating, chapterCount, expectedChapterCount, output?.metadata?.batchWarnings]);
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

  // Conteúdo por Parte (só Escrita com chapters) pros selos de palavras
  // separados. Agrupa por canonPart; a CONTAGEM fica a cargo do WordCountBadge
  // (countWords — a junção por "\n\n" conta igual à soma por capítulo dos cards).
  // `all` = só a prosa dos capítulos (sem cabeçalhos/markers do output.content),
  // então Parte 1 + Parte 2 == Total EXATO — e bate com os alvos por-Parte (que
  // são medidos na prosa) e com a contagem de cada ChapterCard.
  const escritaPartContent = useMemo(() => {
    if (step !== "escrita" || chapters.length === 0) return null;
    const p1: string[] = [];
    const p2: string[] = [];
    for (const ch of chapters) {
      (canonPart(ch.part) === "parte 2" ? p2 : p1).push(ch.content);
    }
    return {
      p1: p1.join("\n\n"),
      p2: p2.join("\n\n"),
      all: [...p1, ...p2].join("\n\n"),
    };
  }, [step, chapters]);

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

    // ── Geração "do zero" roda no GERENCIADOR persistente/concorrente ─────
    // Em vez do loop no componente (que morre ao trocar de guia), enfileira no
    // QueueRunner (montado no layout): a geração sobrevive a trocar/fechar a
    // guia E roda em paralelo com outras abas. Cobre Escrita + Estrutura 1/2 +
    // Revisor 1/2. Os modos pontuais (refine / "continuar de onde parou" /
    // "continuar revisão") seguem no componente. O input "Ajustes opcionais" vai
    // como snapshot no job (evita race com o debounce de save).
    if (
      mode !== "refine" &&
      (step === "escrita" ||
        ((step === "estrutura1" ||
          step === "estrutura2" ||
          isRevisorStep(step) ||
          step === "overview") &&
          mode === "regenerate"))
    ) {
      // Limpa jobs já concluídos/errados deste roteiro+step antes de re-enfileirar
      // — senão um job "error" anterior fica preso no painel e o banner de erro
      // continua aparecendo mesmo com a nova geração rodando.
      for (const j of queueJobs) {
        if (
          j.roteiroId === roteiro.id &&
          j.step === step &&
          (j.status === "error" || j.status === "done")
        ) {
          removeJob(j.id);
        }
      }
      enqueueStep(
        roteiro.id,
        roteiro.title,
        step as
          | "escrita"
          | "estrutura1"
          | "estrutura2"
          | "revisor1"
          | "revisor2"
          | "overview",
        effectiveUserInput || undefined,
      );
      return;
    }

    // Nota: o "Continuar revisão" do Revisor NÃO passa mais por aqui — virou
    // `continueRevisorPart`/`continueBothParts`, que enfileiram na fila (paralelo
    // + sobrevive à navegação) e agregam os erros anteriores via
    // `aggregatePreviousRevisorErrors`. Este caminho foreground cobre só
    // regenerate (que é interceptado e enfileirado acima) e refine pontual.

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

    // ─── Branch Escrita: loop 2-em-2 + calibração deferida ──────────────
    // Geramos os capítulos em batches 2-em-2 (encadeados por sinopses) e, só
    // DEPOIS de todos os batches, rodamos a calibração de word-count
    // (CALIBRATION_THRESHOLD de @/lib/escrita-calibration) em PARALELO sobre os
    // caps fora da faixa — cada cap é uma reescrita Opus independente. A revisão
    // gramatical/estrutural continua no step Revisor (que também faz um ajuste
    // fino de ±3%).
    //
    // Em modo correção, pulamos o loop 2-em-2 e caímos no branch padrão
    // (1 chamada com refineMode: true). O agente da Escrita devolve o
    // roteiro inteiro corrigido em uma única passada.
    //
    // NOTA: a full-gen da Escrita SEMPRE é interceptada antes (enqueue no
    // QueueRunner) — este branch é caminho morto pra full-gen. Por isso a lógica
    // de RETOMADA (pular batches já feitos) vive só no motor da fila
    // (lib/generation/run-escrita.ts), não aqui.
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

      // Falha não-fatal: registra warning, persiste o que já tem e segue.
      // Substitui o `failBatch` anterior que retornava cedo do loop — a regra
      // é "continue gerando mesmo assim": uma falha num batch da Parte 1 NÃO
      // pode pular a geração inteira da Parte 2 (e vice-versa). A roteirista
      // pode regerar os batches faltantes via "Gerar capítulo X novamente"
      // depois de ver o banner.
      const recordBatchFailure = (msg: string, b: (typeof plan)[number]) => {
        accBatchWarnings.push({
          batchIndex: b.batchIndex,
          part: b.part,
          expected: b.chapters,
          missing: b.chapters,
          fatalError: msg,
        });
        console.warn(
          `[escrita batch ${b.batchIndex}] FATAL: ${msg} — seguindo pro próximo batch`,
        );
      };

      try {
        // ═══ Loop 2-em-2: gera batches e acumula ════════════════════════
        // Retry automático: se um batch deixar de emitir alguns dos caps
        // esperados, o sistema pede de novo os faltantes (até 2 retries).
        // Validado pela roteirista — sem isso, a Parte 2 com cap 1+2 e 3+4
        // ausentes (caso real reportado) exigiria clicar "Gerar novamente"
        // e re-rodar a Parte 1 inteira, gastando minutos de Opus à toa.
        const MAX_RETRIES_PER_BATCH = 2;
        for (const b of plan) {
          if (ctrl.signal.aborted) break;

          let chaptersToRequest = [...b.chapters];
          let targetsToRequest = [...b.targets];
          let attempt = 0;
          let finalMissing: number[] = chaptersToRequest;
          let batchFatalError: string | null = null;

          while (
            chaptersToRequest.length > 0 &&
            attempt <= MAX_RETRIES_PER_BATCH
          ) {
            if (ctrl.signal.aborted) break;
            attempt += 1;
            setBatchProgress({
              kind: "writing",
              batchIndex: b.batchIndex,
              totalBatches: plan.length,
              part: b.part,
              chapters: chaptersToRequest,
            });
            setLiveStream("");

            const res = await fetch(`/api/agent/${step}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category,
                roteiroId: roteiro.id,
                previousOutputs: roteiro.outputs,
                userInput: effectiveUserInput,
                referenceImage: roteiro.referenceImage,
                ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
                batch: {
                  part: b.part,
                  chapters: chaptersToRequest,
                  totalInPart: b.totalInPart,
                  batchIndex: b.batchIndex,
                  totalBatches: plan.length,
                  chapterTargets: targetsToRequest,
                },
                previousSynopses: accSynopses,
              }),
              signal: ctrl.signal,
            });

            if (!res.ok || !res.body) {
              batchFatalError = (await res.text()) || res.statusText;
              break;
            }

            const acc = await readStreamFully(res);
            if (ctrl.signal.aborted) break;

            const parsed = parseEscritaBatch(acc, b.part);

            // Fallback do parser (cap número 0): modelo não devolveu nenhum
            // cabeçalho `## Capítulo N`. Tenta de novo se ainda há retries;
            // senão, falha o batch.
            const fallbackOnly = parsed.chapters.every((c) => c.number === 0);
            if (fallbackOnly && parsed.chapters.length > 0) {
              if (attempt <= MAX_RETRIES_PER_BATCH) {
                console.warn(
                  `[escrita batch ${b.batchIndex}] tentativa ${attempt}: output sem cabeçalhos — retentando`,
                );
                continue;
              } else {
                batchFatalError = `O modelo não seguiu o formato esperado (sem cabeçalhos "## Capítulo N — Título"). Tente regenerar o batch.`;
                break;
              }
            }

            if (ctrl.signal.aborted) break;

            // Acumula o que veio (mesmo que parcial). O dedupChaptersLast
            // mais abaixo descarta duplicatas se uma tentativa anterior já
            // tinha entregado o mesmo cap (mantém o mais recente).
            accChapters.push(...parsed.chapters);
            accSynopses.push(...parsed.synopses);

            const gotNumbers = new Set(
              parsed.chapters.map((c) => c.number).filter((n) => n > 0),
            );
            const stillMissing = chaptersToRequest.filter(
              (n) => !gotNumbers.has(n),
            );

            if (stillMissing.length === 0) {
              finalMissing = [];
              break;
            }

            // Setup pro próximo retry: pede só os faltantes com targets
            // correspondentes. Mantém numeração e contexto original.
            const stillMissingTargets = stillMissing.map((n) => {
              const idx = b.chapters.indexOf(n);
              return idx >= 0 ? b.targets[idx]! : 0;
            });
            console.warn(
              `[escrita batch ${b.batchIndex}] tentativa ${attempt}: faltam caps ${stillMissing.join(", ")} — ${attempt <= MAX_RETRIES_PER_BATCH ? "retentando" : "desistindo"}`,
            );
            chaptersToRequest = stillMissing;
            targetsToRequest = stillMissingTargets;
            finalMissing = stillMissing;
          }

          if (batchFatalError) {
            recordBatchFailure(batchFatalError, b);
            persist();
            // Importante: `continue` (não `return`). O loop precisa atravessar
            // a fronteira P1→P2 mesmo se um batch falhar — a regra "continue
            // gerando mesmo assim" exige que a Parte 2 sempre seja tentada.
            continue;
          }

          // Se sobraram caps faltando depois de todas as tentativas, registra
          // warning pro usuário ver e regenerar manualmente.
          if (finalMissing.length > 0) {
            accBatchWarnings.push({
              batchIndex: b.batchIndex,
              part: b.part,
              expected: b.chapters,
              missing: finalMissing,
            });
          }

          // Dedup por (canonPart, number) com estratégia "last": se o batch
          // atual emitiu cap que já existia em accChapters (overlap, retry,
          // regeneração no meio), o mais recente vence — semântica de "a
          // última regeneração é a intencional". A barreira final do store
          // (setOutput) também dedupa, mas aqui usamos "last" especificamente
          // pra preservar o cap recém-gerado em vez do antigo mais longo.
          const dedupResult = dedupChaptersLast(accChapters);
          if (dedupResult.removed > 0) {
            accChapters.length = 0;
            accChapters.push(...dedupResult.chapters);
            accBatchWarnings.push({
              batchIndex: b.batchIndex,
              part: b.part,
              expected: [],
              missing: [],
              duplicatesRemoved: dedupResult.removed,
            });
            console.warn(
              `[escrita batch] removidas ${dedupResult.removed} duplicata(s) no batch ${b.batchIndex}`,
            );
          }

          persist();
          setLiveStream("");
        }

        // ─── Calibração automática de word count (deferida + PARALELA) ──────
        // Roda UMA vez, após TODOS os batches. Threshold/concorrência em
        // @/lib/escrita-calibration (hoje ±8%, folga sobre o ±3% do prompt) — o
        // Opus desobedece word count com frequência mesmo com regra rígida.
        // Cada cap fora da faixa é uma reescrita Opus
        // INDEPENDENTE (escreve um índice distinto de accChapters, só LÊ
        // accSynopses já completas), então rodamos em paralelo com cap de
        // concorrência — mesmo resultado da versão sequencial, só mais rápido.
        // Espelha lib/generation/run-escrita.ts (manter os dois em sincronia).
        if (!ctrl.signal.aborted) {
          const targetForChapter = (ch: EscritaChapter): number | null => {
            if (!ch.number || ch.number < 1) return null;
            const arr =
              ch.part === "Parte 2"
                ? targetsP2
                : ch.part === "Parte 1"
                  ? targetsP1
                  : null;
            return arr ? (arr[ch.number - 1] ?? null) : null;
          };
          const calibrationCandidates = accChapters
            .map((chapter, arrIndex) => ({
              arrIndex,
              chapter,
              target: targetForChapter(chapter),
            }))
            .filter(
              (
                c,
              ): c is { arrIndex: number; chapter: EscritaChapter; target: number } => {
                if (!c.target) return false;
                const current = countWords(c.chapter.content);
                return (
                  Math.abs(current - c.target) / c.target > CALIBRATION_THRESHOLD
                );
              },
            );

          // Lê o stream da calibração SEM atualizar o liveStream — vários
          // streams concorrentes embaralhariam o preview. O badge "calibrando
          // cap X de Y" (setBatchProgress) já comunica o progresso.
          const readStreamSilent = (res: Response) =>
            readStreamThrottled(res, () => {}, ctrl.signal);

          let calibrationDone = 0;
          await mapWithConcurrency(
            calibrationCandidates,
            CALIBRATION_CONCURRENCY,
            async (cand) => {
              if (ctrl.signal.aborted) return;
              const current = countWords(cand.chapter.content);
              calibrationDone += 1;
              setBatchProgress({
                kind: "calibrating",
                part: cand.chapter.part as "Parte 1" | "Parte 2",
                chapter: cand.chapter.number,
                currentWords: current,
                targetWords: cand.target,
                currentIndex: calibrationDone,
                totalToCalibrate: calibrationCandidates.length,
              });

              // Sinopses dos caps vizinhos (Parte igual, número ±1) pra não
              // contradizer continuidade ao reescrever.
              const neighborSynopses = accSynopses
                .filter(
                  (s) =>
                    s.part === cand.chapter.part &&
                    Math.abs(s.number - cand.chapter.number) <= 1,
                )
                .map((s) => ({
                  number: s.number,
                  part: s.part,
                  synopsis: s.synopsis,
                }));

              try {
                const fixRes = await fetch("/api/escrita-fix-wordcount", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    category,
                    chapter: {
                      number: cand.chapter.number,
                      title: cand.chapter.title,
                      part: cand.chapter.part as "Parte 1" | "Parte 2",
                      content: cand.chapter.content,
                    },
                    currentWords: current,
                    targetWords: cand.target,
                    premissa: roteiro.outputs.premissa?.content,
                    neighborSynopses,
                  }),
                  signal: ctrl.signal,
                });
                if (!fixRes.ok || !fixRes.body) {
                  console.warn(
                    `[calibração] cap ${cand.chapter.number} (${cand.chapter.part}): HTTP ${fixRes.status} — mantendo original`,
                  );
                  return;
                }
                const fixAcc = await readStreamSilent(fixRes);
                if (ctrl.signal.aborted) return;

                const parsedFix = parseEscritaChaptersDirect(fixAcc);
                const newCh = parsedFix.find(
                  (p) => p.number === cand.chapter.number,
                );
                if (newCh?.content) {
                  accChapters[cand.arrIndex] = {
                    ...cand.chapter,
                    content: newCh.content,
                    title: newCh.title ?? cand.chapter.title,
                    generatedAt: new Date().toISOString(),
                  };
                  persist();
                } else {
                  console.warn(
                    `[calibração] cap ${cand.chapter.number} (${cand.chapter.part}): parser não achou cap no output — mantendo original`,
                  );
                }
              } catch (e) {
                if ((e as Error).name === "AbortError") throw e;
                console.warn(
                  `[calibração] cap ${cand.chapter.number} (${cand.chapter.part}):`,
                  e,
                );
              }
            },
            { signal: ctrl.signal },
          );
          setLiveStream("");
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
            roteiroId: roteiro.id,
            previousOutputs: roteiro.outputs,
            userInput: effectiveUserInput,
            referenceImage: roteiro.referenceImage,
            ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
            // Re-revisão por definição (refine pontual) — relatório enxuto: só o
            // bloco de erros, sem o ensaio. Espelha a detecção do run-step.ts
            // headless e o caminho da fila.
            leanRevisorReport: true,
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
                roteiroId: roteiro.id,
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
        // Eval de qualidade (Karpathy): registra nota+hate+erros no log
        // versionado. Custo zero de cota — deriva do relatório recém-gerado.
        recordEval(step, {
          content: cleanContent,
          metadata: { errors, escritaSnapshotHash },
          generatedAt: startedAt,
        });
        setDraft(cleanContent);
        setLiveStream("");
        setBatchProgress(null);
        setIsGenerating(false);

        if (
          autoAdvance &&
          next &&
          !ctrl.signal.aborted &&
          !isSentinelOutput(cleanContent)
        ) {
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
    //   - Revisor / Overview em modo REFINE (correção pontual: 1 chamada com
    //     refineMode; Overview também usa <erros_detalhados>, mesmo padrão).
    // Pro Revisor/Overview refine, o agente precisa enxergar o XML
    // <erros_detalhados> pra poder mexer nele via patches. O `output.content`
    // corrente foi stripado do XML quando salvamos no store — reconstituímos
    // a partir de `metadata.errors` antes de enviar.
    const currentOutputForAgent =
      isRefine &&
      (isRevisorStep(step) || step === "overview") &&
      output?.metadata?.errors
        ? `${baseContent}\n\n${serializeRevisorErrors(output.metadata.errors)}`
        : baseContent;

    try {
      const res = await fetch(`/api/agent/${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          roteiroId: roteiro.id,
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
                roteiroId: roteiro.id,
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
        // Eval de qualidade (Karpathy): registra no log versionado a cada
        // re-geração de revisão — é o sinal de "melhorou ou piorou".
        if (isRevisorStep(step)) {
          recordEval(step, {
            content: cleanContent,
            metadata: {
              errors,
              ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
            },
            generatedAt: startedAt,
          });
        }
        setDraft(cleanContent);
      } else if (
        isRefine &&
        (step === "estrutura1" ||
          step === "estrutura2" ||
          isRevisorStep(step) ||
          step === "overview") &&
        acc.trim()
      ) {
        // Correção pontual em Estrutura 1, Estrutura 2, Revisor ou Overview:
        // o agente devolve apenas pares <alteracao>/<original>/<corrigido>.
        // Aplicamos via find+replace literal no output corrente — trechos
        // não tocados permanecem byte-a-byte. Pra Revisor/Overview, o XML
        // <erros_detalhados> faz parte da base do patch (foi reconstituído
        // via serializeRevisorErrors antes da chamada) e os erros são
        // reparseados ao final.
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
            } else if (step === "overview") {
              // Overview refine: mesmo fluxo do Revisor — patches aplicados
              // sobre base reconstituída, depois reparseamos os erros com
              // prefixo `ov-` (linha 1357) pra não colidir com IDs `p1-/p2-`
              // do Revisor caso ambos coexistam na UI.
              const newErrors = parseRevisorErrors(result.text).map((e) => ({
                ...e,
                id: `ov-${e.id}`,
              }));
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
              // Estrutura 1 / 2: o output é texto plano markdown. Reaplica a
              // trava de soma (uma correção pode ter empurrado o total pra fora
              // da faixa da Parte).
              const estruturaPart =
                step === "estrutura1" ? "Parte 1" : "Parte 2";
              const norm = normalizeEstruturaTargets(
                result.text,
                estruturaPart,
                category,
              );
              if (norm.rescaled) {
                console.info(
                  `[estrutura] ${step} refine reescalado: soma ${norm.sumBefore} → ${norm.sumAfter}`,
                );
              }
              setOutput(step, {
                content: norm.text,
                metadata: { ...(output?.metadata ?? {}) },
                generatedAt: startedAt,
              });
              setDraft(norm.text);
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
            //
            // canonPart normaliza undefined/null/""/"Parte 1"/"parte 1" para
            // a mesma chave — sem isso, um cap incoming sem `part` definida
            // não casava com o existing `part: "Parte 1"` e era classificado
            // como newOne, gerando duplicata (regressão do commit 54f8d01).
            const merged: EscritaChapter[] = previousChapters.map((existing) => {
              const replacement = incoming.find(
                (i) =>
                  i.number === existing.number &&
                  canonPart(i.part) === canonPart(existing.part),
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
                    canonPart(e.part) === canonPart(i.part),
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
        const mergedContent = isContinue
          ? mergeContinuation(partialBase, acc)
          : acc;
        // Trava determinística: reescala os alvos por capítulo pra somar dentro
        // da faixa da Parte (espelha o motor headless em run-step.ts).
        const estruturaPart = step === "estrutura1" ? "Parte 1" : "Parte 2";
        const norm = normalizeEstruturaTargets(
          mergedContent,
          estruturaPart,
          category,
        );
        if (norm.rescaled) {
          console.info(
            `[estrutura] ${step} reescalado: soma ${norm.sumBefore} → ${norm.sumAfter} (dentro da faixa da ${estruturaPart})`,
          );
        }
        const finalContent = norm.text;
        setOutput(step, {
          content: finalContent,
          generatedAt: startedAt,
        });
        setDraft(finalContent);
        setLiveStream("");
      } else if (!isRefine && step === "overview" && acc.trim()) {
        // Overview Final — analisa o roteiro completo (P1+P2) procurando
        // erros estruturais e devolve markdown + bloco <erros_detalhados>
        // no mesmo formato do Revisor. Parseamos o XML pra popular os
        // cards de correção 1-clique e snapshotamos o hash da Escrita pra
        // a UI detectar drift (escrita editada depois desta análise).
        // Prefixamos os IDs com `ov-` pra não colidir com IDs do Revisor
        // (que usa `p1-`/`p2-`) caso ambos apareçam ao mesmo tempo na UI.
        const parsedErrors = parseRevisorErrors(acc).map((e) => ({
          ...e,
          id: `ov-${e.id}`,
        }));
        const cleanContent = stripErrosDetalhados(acc);
        const escritaContent =
          roteiro.outputs.escrita?.content?.trim() ?? "";
        const escritaSnapshotHash = escritaContent
          ? hashEscritaContent(escritaContent)
          : undefined;

        setOutput(step, {
          content: cleanContent,
          metadata: {
            errors: parsedErrors,
            ...(escritaSnapshotHash ? { escritaSnapshotHash } : {}),
          },
          generatedAt: startedAt,
        });
        setDraft(cleanContent);
        setLiveStream("");
      }

      setIsGenerating(false);

      if (autoAdvance && next && !isSentinelOutput(acc)) {
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
    recordEval,
    setIsGenerating,
    setCurrentStep,
    pushOutputToHistory,
    enqueueStep,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
  }, [setIsGenerating]);

  // Cancela a geração em andamento no gerenciador (aborta + remove o job).
  // Diferente de `cancel` (que aborta a geração in-componente).
  const cancelStepJob = useCallback(() => {
    if (!stepJob) return;
    removeJob(stepJob.id);
    abortJob(stepJob.id);
  }, [stepJob, removeJob]);

  // Continuar a Escrita interrompida: enfileira com resume=true → o motor
  // (run-escrita) semeia os capítulos já salvos e pula os batches concluídos,
  // gerando só o que falta. Snapshot do input "Instruções adicionais" (draft ou
  // commit) igual ao caminho normal de enqueue.
  const continueEscrita = useCallback(() => {
    if (!roteiro) return;
    const draftInput = (
      (roteiro.drafts?.escrita as { input?: string } | undefined)?.input ?? ""
    ).trim();
    const committedInput = (roteiro.userInputs?.escrita ?? "").trim();
    // Limpa jobs concluídos/errados deste roteiro+escrita antes de retomar.
    for (const j of queueJobs) {
      if (
        j.roteiroId === roteiro.id &&
        j.step === "escrita" &&
        (j.status === "error" || j.status === "done")
      ) {
        removeJob(j.id);
      }
    }
    enqueueStep(
      roteiro.id,
      roteiro.title,
      "escrita",
      draftInput || committedInput || undefined,
      true,
    );
  }, [roteiro, enqueueStep, queueJobs, removeJob]);

  // "Gerar as duas Partes" — enfileira revisor1 E revisor2 do ZERO de uma vez.
  // O lock do QueueRunner é por `${roteiroId}:${step}`, então as duas rodam ao
  // mesmo tempo na fila (cada uma grava sua própria chave de step; limitado por
  // MAX_CONCURRENT_STREAMS). ~Corta pela metade o wall-clock da revisão (antes 7+7
  // sequencial). A P2 roda SEM o relatório consolidado da P1 como contexto nesta
  // 1ª passada — re-rodar a P2 depois (enxuta/rápida) pega inconsistências
  // cruzadas. Snapshot do input "Ajustes opcionais" de cada step. `enqueue` é
  // idempotente por (roteiro, step), então não duplica se uma Parte já estiver
  // rodando.
  const reviseBothParts = useCallback(() => {
    if (!roteiro) return;
    for (const j of queueJobs) {
      if (
        j.roteiroId === roteiro.id &&
        (j.step === "revisor1" || j.step === "revisor2") &&
        (j.status === "error" || j.status === "done")
      ) {
        removeJob(j.id);
      }
    }
    enqueueStep(
      roteiro.id,
      roteiro.title,
      "revisor1",
      roteiro.userInputs?.revisor1 || undefined,
    );
    enqueueStep(
      roteiro.id,
      roteiro.title,
      "revisor2",
      roteiro.userInputs?.revisor2 || undefined,
    );
  }, [roteiro, enqueueStep, queueJobs, removeJob]);

  // "Continuar revisão" de UMA Parte, pela fila (paralelo + sobrevive à
  // navegação). Agrega os erros já apontados (output atual + histórico DESTE
  // step) e manda como `previousRevisorErrors` ("não relista esses"). Arquiva a
  // versão atual no histórico ANTES de enfileirar — a fila não arquiva sozinha
  // (ver QueueRunner#applyStepOutput); sem isso o revert sumiria. Lê o output do
  // `targetStep` direto do roteiro (não do `output`/`step` do componente), pra
  // funcionar também quando continua a Parte que NÃO está aberta.
  const continueRevisorPart = useCallback(
    (targetStep: "revisor1" | "revisor2") => {
      if (!roteiro) return;
      const targetOutput = roteiro.outputs[targetStep];
      if (!targetOutput?.content?.trim()) return; // nada a continuar
      const prevErrors = aggregatePreviousRevisorErrors(
        targetOutput,
        roteiro.history?.[targetStep],
      );
      pushOutputToHistory(targetStep, "Antes de continuar revisão");
      for (const j of queueJobs) {
        if (
          j.roteiroId === roteiro.id &&
          j.step === targetStep &&
          (j.status === "error" || j.status === "done")
        ) {
          removeJob(j.id);
        }
      }
      enqueueStep(
        roteiro.id,
        roteiro.title,
        targetStep,
        roteiro.userInputs?.[targetStep] || undefined,
        undefined,
        undefined,
        prevErrors.length > 0 ? prevErrors : undefined,
      );
    },
    [roteiro, enqueueStep, queueJobs, removeJob, pushOutputToHistory],
  );

  // Regerar UM capítulo individual no step Escrita. Reusa o pipeline 2-em-2
  // disparando um batch de 1 capítulo + sinopses dos vizinhos (todas
  // disponíveis em metadata.synopses) pra preservar continuidade.
  // dedupChaptersLast substitui o cap antigo pelo novo no merge final.
  // Calibração automática (CALIBRATION_THRESHOLD) roda igual ao loop principal.
  const handleRegenerateChapter = useCallback(
    async (idx: number) => {
      if (!roteiro || step !== "escrita") return;
      if (isGenerating || regeneratingChapterIdx !== null) return;

      const escritaOutput = roteiro.outputs.escrita;
      const allChapters = escritaOutput?.metadata?.chapters;
      const allSynopses = escritaOutput?.metadata?.synopses ?? [];
      const target = allChapters?.[idx];
      if (!escritaOutput || !allChapters || !target) return;

      const part: "Parte 1" | "Parte 2" =
        target.part === "Parte 2" ? "Parte 2" : "Parte 1";

      // Confirmação — texto extra quando o capítulo está marcado como
      // editado manualmente (a edição da roteirista será sobrescrita; o
      // histórico preserva, mas merece aviso explícito).
      const editedNote = target.edited
        ? `\n\n⚠️ Este capítulo foi editado manualmente${target.editedAt ? ` em ${new Date(target.editedAt).toLocaleString("pt-BR")}` : ""}. A regeração vai sobrescrever sua edição.`
        : "";
      const ok = window.confirm(
        `Regerar o Capítulo ${target.number} da ${part}?\n\nA versão atual será salva no histórico e pode ser restaurada.${editedNote}`,
      );
      if (!ok) return;

      // Recupera o alvo de palavras da estrutura — mesma lógica de fallback
      // do loop principal (linhas ~612-623). Se a estrutura não declarar
      // alvo por cap, usa total da categoria dividido pelo total de caps.
      const estrutura1 = roteiro.outputs.estrutura1?.content;
      const estrutura2 = roteiro.outputs.estrutura2?.content;
      const totalInPart =
        part === "Parte 1"
          ? countChaptersInEstrutura(estrutura1)
          : countChaptersInEstrutura(estrutura2);
      if (totalInPart === 0) {
        alert(
          `Não consegui detectar capítulos na estrutura da ${part}. Verifique o Step ${part === "Parte 1" ? 2 : 3}.`,
        );
        return;
      }
      const targetsRaw = extractChapterTargets(
        part === "Parte 1" ? estrutura1 : estrutura2,
      );
      const fallbackTotal =
        CATEGORIES[category].wordCount[part === "Parte 1" ? "parte1" : "parte2"]
          .target;
      const targetWords =
        targetsRaw.find((t) => t.number === target.number)?.target ??
        Math.round(fallbackTotal / totalInPart);

      // Snapshot ANTES de qualquer mutação. Mesmo se o fetch falhar, a
      // roteirista consegue restaurar pelo HistoryPanel.
      pushOutputToHistory(
        "escrita",
        `Antes regeração Cap ${target.number} da ${part}`,
      );

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setIsGenerating(true);
      setRegeneratingChapterIdx(idx);
      setLiveStream("");
      // NÃO setBatchProgress — o BatchProgressPanel é só pra geração global.
      // O feedback visual fica no próprio botão do card (spinner inline).
      generationStartRef.current = Date.now();
      setElapsedSec(0);
      const startedAt = new Date().toISOString();

      // Usa input persistido do step (sem o draft, porque o draft do textarea
      // de instruções pode estar sendo digitado num contexto que não se
      // aplica a este capítulo específico). Roteirista pode commitar via
      // setUserInput antes se quiser passar instrução pontual.
      const committedInput = (roteiro.userInputs?.escrita ?? "").trim();
      const effectiveUserInput = committedInput;

      // Contexto da história inteira pro modelo regerar com continuidade:
      // mandamos TODAS as sinopses (caps anteriores E POSTERIORES — para que
      // o cap regerado prepare o que vem depois, pague cliffhangers
      // anteriores, mantenha tom/personagens), EXCETO a do próprio cap.
      // Se mandássemos a do próprio cap, o modelo veria "Cap N: aconteceu X,
      // cliffhanger Y" como fato consolidado e tenderia a reproduzir o
      // mesmo conteúdo. O prompt da Escrita rotula essa lista como
      // "SINOPSES DOS CAPÍTULOS JÁ ESCRITOS" — pra continuidade plena,
      // todos os OUTROS caps contam como "já escritos".
      const contextSynopses = allSynopses.filter(
        (s) => !(s.number === target.number && s.part === part),
      );

      try {
        const res = await fetch(`/api/agent/escrita`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            roteiroId: roteiro.id,
            previousOutputs: roteiro.outputs,
            userInput: effectiveUserInput,
            referenceImage: roteiro.referenceImage,
            ...(roteiro.canone?.trim() ? { canone: roteiro.canone } : {}),
            batch: {
              part,
              chapters: [target.number],
              totalInPart,
              batchIndex: 1,
              totalBatches: 1,
              chapterTargets: [targetWords],
            },
            previousSynopses: contextSynopses,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error((await res.text()) || res.statusText || "Falha");
        }

        const acc = await readStreamThrottled(res, setLiveStream, ctrl.signal);
        if (ctrl.signal.aborted) return;

        const parsed = parseEscritaBatch(acc, part);
        const newCap = parsed.chapters.find(
          (c) => c.number === target.number && c.content?.trim(),
        );
        if (!newCap) {
          throw new Error(
            `O modelo não devolveu o Capítulo ${target.number} no formato esperado.`,
          );
        }
        const newSyn = parsed.synopses.find((s) => s.number === target.number);

        // Merge: append + dedupChaptersLast mantém o cap recém-gerado.
        // Sinopses: substitui o entry do cap regerado (filter + push).
        // Aqui leio direto do store pra evitar usar valores stale da closure.
        const freshOutput =
          useWizard.getState().roteiro?.outputs.escrita ?? escritaOutput;
        const freshChapters = freshOutput.metadata?.chapters ?? [];
        const freshSynopses = freshOutput.metadata?.synopses ?? [];
        const mergedChapters = dedupChaptersLast([
          ...freshChapters,
          { ...newCap, part },
        ]).chapters;
        const mergedSynopses = newSyn
          ? [
              ...freshSynopses.filter(
                (s) => !(s.number === target.number && s.part === part),
              ),
              { ...newSyn, part },
            ]
          : freshSynopses;

        setOutput("escrita", {
          ...freshOutput,
          content: concatenateChapters(mergedChapters),
          metadata: {
            ...(freshOutput.metadata ?? {}),
            chapters: mergedChapters,
            synopses: mergedSynopses,
          },
          generatedAt: new Date().toISOString(),
          edited: false,
          editedAt: undefined,
        });
        setLiveStream("");

        // ─── Calibração automática (mesmo gatilho do loop principal) ───
        const realCount = countWords(newCap.content);
        const ratio = Math.abs(realCount - targetWords) / targetWords;
        if (ratio > 0.05 && !ctrl.signal.aborted) {
          setBatchProgress({
            kind: "calibrating",
            part,
            chapter: target.number,
            currentWords: realCount,
            targetWords,
            currentIndex: 1,
            totalToCalibrate: 1,
          });
          const neighborSynopses = mergedSynopses
            .filter(
              (s) =>
                s.part === part && Math.abs(s.number - target.number) <= 1,
            )
            .map((s) => ({
              number: s.number,
              part: s.part,
              synopsis: s.synopsis,
            }));
          try {
            const fixRes = await fetch("/api/escrita-fix-wordcount", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                category,
                chapter: {
                  number: newCap.number,
                  title: newCap.title,
                  part,
                  content: newCap.content,
                },
                currentWords: realCount,
                targetWords,
                premissa: roteiro.outputs.premissa?.content,
                neighborSynopses,
              }),
              signal: ctrl.signal,
            });
            if (fixRes.ok && fixRes.body) {
              const fixAcc = await readStreamThrottled(
                fixRes,
                setLiveStream,
                ctrl.signal,
              );
              if (!ctrl.signal.aborted) {
                const parsedFix = parseEscritaChaptersDirect(fixAcc);
                const calibrated = parsedFix.find(
                  (p) => p.number === target.number,
                );
                if (calibrated?.content) {
                  const freshOutput2 =
                    useWizard.getState().roteiro?.outputs.escrita ?? freshOutput;
                  const freshChapters2 =
                    freshOutput2.metadata?.chapters ?? mergedChapters;
                  const mergedChapters2 = dedupChaptersLast([
                    ...freshChapters2,
                    {
                      ...newCap,
                      part,
                      content: calibrated.content,
                      title: calibrated.title ?? newCap.title,
                      generatedAt: new Date().toISOString(),
                    },
                  ]).chapters;
                  setOutput("escrita", {
                    ...freshOutput2,
                    content: concatenateChapters(mergedChapters2),
                    metadata: {
                      ...(freshOutput2.metadata ?? {}),
                      chapters: mergedChapters2,
                      synopses: mergedSynopses,
                    },
                    generatedAt: new Date().toISOString(),
                    edited: false,
                    editedAt: undefined,
                  });
                }
              }
            } else {
              console.warn(
                `[regerar cap ${target.number}] calibração: HTTP ${fixRes.status} — mantendo original`,
              );
            }
          } catch (e) {
            if ((e as Error).name !== "AbortError") {
              console.warn(
                `[regerar cap ${target.number}] calibração falhou:`,
                e,
              );
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(err);
          alert(
            `Não foi possível regerar o Capítulo ${target.number}: ${err instanceof Error ? err.message : String(err)}\n\nA versão anterior está preservada no histórico.`,
          );
        }
      } finally {
        setLiveStream("");
        setBatchProgress(null);
        setIsGenerating(false);
        setRegeneratingChapterIdx(null);
      }
    },
    [
      roteiro,
      step,
      category,
      isGenerating,
      regeneratingChapterIdx,
      setOutput,
      setIsGenerating,
      pushOutputToHistory,
    ],
  );

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

  // (Antes havia aqui uma PAREDE de bloqueio do revisor2 — escondia a tela
  // inteira até a Parte 1 ser revisada. Removida: as duas Partes geram em
  // paralelo; o estado de cada Parte (nota/hate/pendências) aparece nas abas
  // do RevisorPartTabs, no topo, e clicar troca de Parte sem sair do step.)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              Etapa {displayNodeIndex(step).index} de {displayNodeIndex(step).total}
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

      {isRevisorStep(step) && (
        <RevisorPartTabs currentStep={step as "revisor1" | "revisor2"} />
      )}

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

      {/* Banner "Escrita interrompida" — aparece quando há capítulos salvos mas
          a geração não terminou (menos caps que o esperado, ou batch com gap),
          e nenhum job está rodando/na fila. "Continuar geração" retoma de onde
          parou (motor pula os batches já feitos); "Gerar tudo do zero" regera. */}
      {(escritaIncomplete || erroredJob) && (
        <EscritaIncompleteBanner
          chapterCount={chapterCount}
          expectedChapterCount={expectedChapterCount}
          onContinue={continueEscrita}
          onRegenerate={() => generate("regenerate")}
          {...(erroredJob?.error ? { errorReason: erroredJob.error } : {})}
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
              (step === "escrita" || step === "estrutura1" || step === "estrutura2") &&
              (step === "escrita" && escritaPartContent ? (
                // Escrita: Parte 1 + Parte 2 separadas + Total (cada uma com seu
                // alvo/cor). Pra saber onde estão as palavras de cada Parte.
                <>
                  <WordCountBadge
                    content={escritaPartContent.p1}
                    targetMin={CATEGORIES[category].wordCount.parte1.min}
                    targetMax={CATEGORIES[category].wordCount.parte1.max}
                    margin={300}
                    label="Parte 1"
                  />
                  <WordCountBadge
                    content={escritaPartContent.p2}
                    targetMin={CATEGORIES[category].wordCount.parte2.min}
                    targetMax={CATEGORIES[category].wordCount.parte2.max}
                    margin={300}
                    label="Parte 2"
                  />
                  <WordCountBadge
                    content={escritaPartContent.all}
                    targetMin={wordCountTarget.min}
                    targetMax={wordCountTarget.max}
                    margin={500}
                    label="Total"
                  />
                </>
              ) : (
                // Estrutura, ou Escrita legada sem chapters: selo único de hoje.
                <WordCountBadge
                  content={output?.content ?? ""}
                  targetMin={wordCountTarget.min}
                  targetMax={wordCountTarget.max}
                  margin={500}
                  label={wordCountTarget.label}
                />
              ))}
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

        {/* Veredito do Revisor (advisory): Nota + erros + "pode finalizar?" —
            ajuda a parar em 2 rodadas quando já está bom. Não bloqueia. */}
        {isRevisorStep(step) &&
          hasContent &&
          !isGenerating &&
          !isEditing &&
          !output?.content?.trim().startsWith("[") && (
            <RevisorVerdictBanner
              content={output?.content ?? ""}
              errors={output?.metadata?.errors ?? []}
              evals={roteiro?.evals ?? []}
              part={partOfRevisorStep(step)}
            />
          )}

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
                onRegenerate={handleRegenerateChapter}
                regeneratingChapterIdx={regeneratingChapterIdx}
                regenerateDisabled={isGenerating}
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
              // Renderiza só a CAUDA do stream (proteção OOM — ver MEMORY.md) e
              // separa o raciocínio (esmaecido "Pensando…") do conteúdo.
              <LiveStreamPreview
                raw={liveStream}
                tail={8000}
                contentClassName="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground/85 max-h-[55vh] overflow-auto border-t border-primary/20 pt-3"
              />
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

        {(isRevisorStep(step) || step === "overview") &&
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

        {stepJob && (
          <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.04] px-4 sm:px-5 py-4 flex flex-col gap-2 mb-2">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm font-semibold text-primary">
                {stepJob.status === "queued"
                  ? "Na fila — começa em instantes…"
                  : stepJob.progress
                    ? stepJob.progress.kind === "writing"
                      ? `Gerando ${stepJob.progress.part} — cap. ${stepJob.progress.chapters.join(" e ")} (batch ${stepJob.progress.batchIndex}/${stepJob.progress.totalBatches})`
                      : `Calibrando ${stepJob.progress.part} — cap. ${stepJob.progress.chapter} (${stepJob.progress.currentIndex}/${stepJob.progress.totalToCalibrate})`
                    : (stepJob.phase ?? "Iniciando…")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs text-destructive hover:text-destructive"
                onClick={cancelStepJob}
              >
                Cancelar
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Rodando em 2º plano — você pode trocar de guia ou fechar esta que a
              geração continua.
            </p>
            {/* Preview ao vivo do texto sendo gerado. Na Escrita é o batch atual
                (calibração roda silenciosa, vazio entre batches). Na Estrutura,
                mostra o raciocínio esmaecido ("Pensando…") até o texto começar a
                fluir — ver LiveStreamPreview/lib/stream-markers.ts. */}
            {queueLiveStream && (
              <LiveStreamPreview
                raw={queueLiveStream}
                tail={2000}
                contentClassName="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground/80 max-h-64 overflow-auto border-t border-primary/20 pt-3 mt-1"
              />
            )}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap pt-2">
          {!isGenerating ? (
            isRevisorStep(step) ? (
              // Step ÚNICO de Revisor: as abas (no topo) trocam de Parte; aqui no
              // rodapé ficam as ações. "Gerar as duas Partes" enfileira revisor1 +
              // revisor2 do zero (rodam em paralelo na fila — cobre também a 1ª
              // geração). "Continuar somente Parte N" re-roda só a Parte da aba
              // ativa em modo continuação ("não relista os erros já apontados").
              <>
                <Button
                  onClick={reviseBothParts}
                  size="lg"
                  className="gap-2"
                  disabled={revisorJobActive}
                  title="Enfileira a revisão da Parte 1 e da Parte 2 ao mesmo tempo (rodam em paralelo)."
                >
                  {revisorJobActive ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Gerar as duas Partes
                </Button>
                <Button
                  onClick={() =>
                    continueRevisorPart(step as "revisor1" | "revisor2")
                  }
                  size="lg"
                  variant="outline"
                  className="gap-2"
                  disabled={revisorJobActive || !hasContent}
                  title={
                    hasContent
                      ? "Re-roda só esta Parte em modo continuação (não relista os erros já apontados)."
                      : "Gere esta Parte primeiro (use “Gerar as duas Partes”)."
                  }
                >
                  <RotateCcw className="size-4" />
                  Continuar somente Parte{" "}
                  {partOfRevisorStep(step as "revisor1" | "revisor2")}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => generate("regenerate")}
                size="lg"
                className="gap-2"
                disabled={!!stepJob}
              >
                {stepJob ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : step === "escrita" && chapterCount > 0 ? (
                  <ArrowRight className="size-4" />
                ) : hasContent ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {stepJob ? "Gerando em 2º plano…" : generateLabel}
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
          {(isRevisorStep(step) || step === "overview") && (
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
    | "revisor2"
    | "overview";
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
      : step === "overview"
        ? "Ex.: foque em duplicações no clímax · cheque nomes na cena íntima do Cap. 14\n\n(Deixe vazio para varredura estrutural completa)"
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
  // True quando o stream em curso é uma correção CIRÚRGICA (refineMode) — o
  // header muda pra "Aplicando correção pontual…" em vez de "Gerando resumo…",
  // deixando claro pra roteirista que o restante do output será preservado.
  const [isStreamingRefine, setIsStreamingRefine] = useState(false);
  // Erro inline mostrado próximo aos botões. Sem isso, falhas (stream vazio,
  // HTTP 500, fetch error) ficavam só em console.error — invisível pra revisora,
  // que via o botão "não fazer nada" e clicava de novo no vácuo.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Mensagem informativa (não-erro) — usada quando a IA recusa aplicar uma
  // correção cirúrgica porque a instrução é ampla demais. Renderizada em
  // amarelo (vs vermelho do errorMessage) pra deixar claro que NÃO é falha
  // técnica — é a IA pedindo pra roteirista reformular ou clicar em "Regenerar".
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
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

  // Job de Premissa ATIVO deste roteiro — quando existe, a geração (resumo ou
  // estrutura) está rodando no gerenciador persistente (sobrevive a trocar/
  // fechar guia + roda concorrente com outros projetos), não no componente.
  const enqueue = useQueue((s) => s.enqueue);
  const removeQueueJob = useQueue((s) => s.removeJob);
  const queuePremissaLive = useWizard((s) => s.queueLiveStream["premissa"] ?? "");
  const premissaJob = useQueue((s) =>
    roteiro
      ? s.jobs.find(
          (j) =>
            j.roteiroId === roteiro.id &&
            j.step === "premissa" &&
            (j.status === "running" || j.status === "queued"),
        )
      : undefined,
  );

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
    if (!briefingTrim || premissaJob) return;

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

    if (!roteiro) return;
    setErrorMessage(null);
    const startedAt = new Date().toISOString();

    // Persiste o briefing no metadata logo no início (não se perde se falhar)
    // e limpa o draft.
    setOutput("premissa", {
      content,
      generatedAt: output?.generatedAt ?? startedAt,
      metadata: { ...meta, premissaBriefing: briefingTrim },
    });
    clearDraft("premissa", "briefing");

    // Enfileira no GERENCIADOR persistente — a geração do resumo sobrevive a
    // trocar/fechar a guia e roda concorrente com outros projetos. O resultado
    // (metadata.premissaResumo) aparece na aba quando termina.
    enqueue(roteiro.id, roteiro.title, "premissa", fullUserInput, false, {
      phase: "resumo",
      briefing: briefingTrim,
    });
  }, [
    briefing,
    briefingDraftStored,
    premissaJob,
    resumo,
    savedInstruction,
    instructionDraftStored,
    pushOutputToHistory,
    setOutput,
    clearDraft,
    content,
    output?.generatedAt,
    meta,
    roteiro,
    enqueue,
  ]);

  // ─── Fase 2: aprovar resumo + gerar Blocos 1-7 ──────────────────────
  const approveAndGenerateEstrutura = useCallback(async (instructionOverride?: string) => {
    resumoRef.current?.flush();
    briefingRef.current?.flush();
    // resumoRef só está montado quando isEditingResumo=true (ver render do
    // bloco resumo). No fluxo padrão "gerou → aprovou direto", a ref é null
    // e getValue() retorna undefined. Usa `||` em vez de `??` para que o
    // fallback caia corretamente: resumoDraftStored vem do selector com `?? ""`,
    // e `??` não cai em string vazia, então a cadeia retornaria "" e o
    // botão "Aprovar e gerar estrutura" travaria sem feedback (caminho mais
    // comum do bug — `if (!resumoTrim) return;` silencioso).
    const resumoDraft =
      resumoRef.current?.getValue() || resumoDraftStored || resumo;
    const briefingDraft =
      briefingRef.current?.getValue() || briefingDraftStored || briefing;
    const resumoTrim = resumoDraft.trim();
    const briefingTrim = briefingDraft.trim() || briefing;
    if (!resumoTrim || premissaJob) return;

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

    if (!roteiro) return;
    setErrorMessage(null);

    // Salva o resumo aprovado no metadata já (não se perde) e limpa drafts.
    const startedAt = new Date().toISOString();
    setOutput("premissa", {
      content,
      generatedAt: output?.generatedAt ?? startedAt,
      metadata: {
        ...meta,
        premissaBriefing: briefingTrim,
        premissaResumo: resumoTrim,
      },
    });
    clearDraft("premissa");

    // Enfileira a Fase 2 (estrutura) no GERENCIADOR persistente — sobrevive a
    // trocar/fechar a guia. O content final aparece quando termina.
    enqueue(roteiro.id, roteiro.title, "premissa", fullUserInput, false, {
      phase: "estrutura",
      approvedResumo: resumoTrim,
      briefing: briefingTrim,
    });
  }, [
    briefing,
    briefingDraftStored,
    resumo,
    resumoDraftStored,
    premissaJob,
    content,
    output?.generatedAt,
    savedInstruction,
    instructionDraftStored,
    pushOutputToHistory,
    setOutput,
    clearDraft,
    meta,
    roteiro,
    enqueue,
  ]);

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
    setStreamingPhase(null);
    setIsStreamingRefine(false);
    setLiveStream("");
    setErrorMessage(null);
  }, [setIsGenerating]);

  // ─── Aplicar instrução adicional CIRÚRGICO (refineMode) ─────────────
  // Diferente do `generateResumo`/`approveAndGenerateEstrutura` que regeram
  // o conteúdo inteiro do zero, este caminho pede ao agente patches XML
  // `<alteracao>` e aplica via find+replace literal (fallback fuzzy) — só
  // os trechos que a instrução pediu mudam. Reclamação da roteirista
  // (2026-05-12): "essa caixa tava mexendo no step inteiro" — antes,
  // qualquer instrução pontual regerava tudo. Agora "Aplicar correção"
  // sempre é cirúrgico; regeneração total exige clicar nos botões
  // dedicados "Regenerar resumo" / "Regenerar estrutura".
  //
  // Se o agente devolver 0 patches (instrução ampla demais ou âncora não
  // encontrada), NADA é alterado em outputs.premissa — só mostra aviso
  // sugerindo regenerar do zero.
  const applyInstructionCirurgico = useCallback(
    async (instruction: string) => {
      const trimmed = instruction.trim();
      if (!trimmed || isGenerating) return;
      if (phase !== "approving" && phase !== "done") return;

      // Base do patch:
      // • approving → resumo (Bloco 0) que está em meta.premissaResumo
      //   (content fica vazio até a estrutura ser aprovada).
      // • done → output.content completo (RESUMO + ESTRUTURA COMPLETA).
      const currentOutput = (
        phase === "approving" ? resumoDraftStored || resumo : content
      ).trim();
      if (!currentOutput) {
        setNoticeMessage(
          "Nada pra corrigir ainda — gere o resumo primeiro pra poder pedir ajustes pontuais.",
        );
        return;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setIsGenerating(true);
      setLiveStream("");
      setStreamingPhase(phase === "approving" ? "resumo" : "estrutura");
      setIsStreamingRefine(true);
      setErrorMessage(null);
      setNoticeMessage(null);

      try {
        const res = await fetch("/api/agent/premissa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            ...(roteiro?.id ? { roteiroId: roteiro.id } : {}),
            userInput: trimmed,
            refineMode: true,
            currentOutput,
            referenceImage: roteiro?.referenceImage,
            premissaPhase: phase === "approving" ? "resumo" : "estrutura",
          }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          throw new Error(
            `HTTP ${res.status}: ${errText.slice(0, 200) || res.statusText}`,
          );
        }

        const acc = (await readStreamFully(res, ctrl.signal)).trim();
        if (ctrl.signal.aborted) return;

        // Sentinela: agente julgou que nada precisa mudar.
        if (/\[NENHUMA_ALTERACAO_NECESSARIA\]/i.test(acc)) {
          setNoticeMessage(
            "O agente avaliou que essa correção não exige alteração. Reformule a instrução ou edite o resumo direto pelo botão Editar resumo.",
          );
          return;
        }

        const patches = parseCorrectionPatches(acc);
        if (patches.length === 0) {
          // Instrução ampla demais ou âncoras não encontradas — não toca
          // em outputs.premissa. Roteirista decide regenerar do zero.
          setNoticeMessage(
            phase === "approving"
              ? 'A IA não conseguiu aplicar essa correção pontualmente — a instrução pode ser ampla demais. Tente uma instrução mais específica (cite um trecho ou nome exato), ou clique em "Regenerar resumo" pra refazer o resumo do zero.'
              : 'A IA não conseguiu aplicar essa correção pontualmente — a instrução pode ser ampla demais. Tente uma instrução mais específica (cite Etapa/Bloco/nome), ou clique em "Regenerar estrutura" pra refazer os Blocos 1-7 do zero.',
          );
          return;
        }

        const result = applyCorrectionPatches(currentOutput, patches);
        console.info(
          `[premissa refine ${phase}] aplicados ${result.appliedIndices.length}/${patches.length} patches (${result.failedIndices.length} falharam)`,
        );

        // Snapshot histórico antes de mutar — roteirista pode reverter via
        // HistoryPanel se a correção sair pior que o esperado.
        pushOutputToHistory("premissa", "Antes de aplicar correção cirúrgica");

        const now = new Date().toISOString();
        if (phase === "approving") {
          setOutput("premissa", {
            content: "",
            generatedAt: now,
            metadata: {
              ...meta,
              premissaResumo: result.text,
              premissaResumoApproved: false,
              premissaManualPaste: false,
            },
          });
          clearDraft("premissa", "resumo");
          clearDraft("premissa", "instruction");
          resumoRef.current?.setValue(result.text);
          setIsEditingResumo(false);
        } else {
          // Fase done: content tem `# RESUMO\n\n...\n\n# ESTRUTURA COMPLETA\n\n...`.
          // Re-extrai o resumo do novo content pra manter meta.premissaResumo
          // consistente — patches podem ter tocado o trecho do resumo.
          const resumoMatch = result.text.match(
            /#\s*RESUMO\s*\n+([\s\S]*?)\n+#\s*ESTRUTURA\s+COMPLETA/i,
          );
          const updatedResumo =
            resumoMatch?.[1]?.trim() || meta.premissaResumo || "";
          setOutput("premissa", {
            content: result.text,
            generatedAt: now,
            metadata: {
              ...meta,
              premissaResumo: updatedResumo,
              premissaResumoApproved: true,
              premissaManualPaste: false,
            },
          });
          clearDraft("premissa", "content");
          clearDraft("premissa", "instruction");
          contentRef.current?.setValue(result.text);
          setIsEditingContent(false);
        }
        setUserInput("premissa", trimmed);

        if (result.failedIndices.length > 0) {
          // Patches parciais aplicaram OK — só loga os que não casaram.
          console.warn(
            `[premissa refine ${phase}] ${result.failedIndices.length} patches não casaram (pulados)`,
          );
        }
      } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) {
          console.error("[premissa] erro refineMode:", e);
          setErrorMessage(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setIsGenerating(false);
        setStreamingPhase(null);
        setIsStreamingRefine(false);
        setLiveStream("");
      }
    },
    [
      category,
      clearDraft,
      content,
      isGenerating,
      meta,
      phase,
      pushOutputToHistory,
      resumo,
      resumoDraftStored,
      roteiro?.referenceImage,
      setIsGenerating,
      setOutput,
      setUserInput,
    ],
  );

  // ─── Aplicar instrução adicional (caixa de "chat") ─────────────────
  // Comportamento por fase:
  //   • briefing  → só salva (usado quando clicar em "Gerar resumo")
  //   • approving → CIRÚRGICO: pede patches via refineMode e aplica
  //                 find+replace no resumo (Bloco 0)
  //   • done      → CIRÚRGICO: pede patches via refineMode e aplica
  //                 find+replace no content (resumo + Blocos 1-7)
  // Regeneração total ainda existe — botões "Regenerar resumo" e
  // "Regenerar estrutura" continuam chamando generateResumo /
  // approveAndGenerateEstrutura diretamente.
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
    if (phase === "approving" || phase === "done") {
      await applyInstructionCirurgico(trimmed);
    }
    // briefing phase: instrução fica salva; será aplicada no próximo "Gerar resumo".
  }, [
    instructionDraftStored,
    isGenerating,
    phase,
    setUserInput,
    clearDraft,
    applyInstructionCirurgico,
  ]);

  // ─── Manual paste ───────────────────────────────────────────────────
  const switchToManual = useCallback(() => {
    setOutput("premissa", {
      content,
      generatedAt: output?.generatedAt ?? new Date().toISOString(),
      metadata: { ...meta, premissaManualPaste: true },
    });
    setIsEditingManual(!content);
    setErrorMessage(null);
  }, [setOutput, content, output?.generatedAt, meta]);

  // Fluxo MANUAL-only: a geração automática da premissa (briefing → resumo →
  // Blocos 1-7) foi removida do fluxo. Um roteiro novo abriria na fase
  // "briefing"; sem esse fluxo, jogamos direto no modo manual pra colar a
  // premissa que veio pronta de fora. useLayoutEffect evita o flash da UI
  // automática antes do flip. Só dispara em roteiro realmente novo (sem
  // briefing digitado e sem job em andamento) — roteiros legados que ficaram
  // no meio do fluxo automático seguem intactos até concluir.
  useLayoutEffect(() => {
    if (phase === "briefing" && !briefing && !premissaJob) {
      switchToManual();
    }
  }, [phase, briefing, premissaJob, switchToManual]);

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
                {isStreamingRefine
                  ? streamingPhase === "resumo"
                    ? "Aplicando correção pontual no resumo…"
                    : "Aplicando correção pontual na estrutura…"
                  : streamingPhase === "resumo"
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

      {premissaJob && (
        <div className="rounded-lg border-2 border-primary/40 bg-primary/[0.04] px-4 sm:px-5 py-4 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span className="text-sm font-semibold text-primary">
              {premissaJob.status === "queued"
                ? "Na fila — começa em instantes…"
                : (premissaJob.phase ?? "Gerando…")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs text-destructive hover:text-destructive"
              onClick={() => {
                removeQueueJob(premissaJob.id);
                abortJob(premissaJob.id);
              }}
            >
              Cancelar
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Rodando em 2º plano — você pode trocar de guia ou fechar esta que a
            geração continua.
          </p>
          {queuePremissaLive && (
            <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground/80 max-h-64 overflow-auto border-t border-primary/20 pt-3 mt-1">
              {queuePremissaLive.slice(-2000)}
            </pre>
          )}
        </div>
      )}

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
              ? "Aplica só a correção que você pediu no resumo (sem regerar o resto)"
              : "Aplica só a correção que você pediu na estrutura (sem regerar os outros Blocos)";
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
                    ? "Aplica só na parte que você pediu — sem mexer no resto"
                    : "Aplica só na parte que você pediu — sem regerar os outros Blocos"}
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

      {/* ─── Banner de erro inline ─── */}
      {/* Sem isso, falhas (stream vazio, HTTP 500, fetch error) ficavam só em
          console.error — invisível pra revisora, que via o botão "não fazer nada"
          e clicava de novo no vácuo. */}
      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold">Falha ao gerar — clique no botão de novo para tentar.</p>
            <p className="text-xs opacity-80 mt-0.5">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            aria-label="Fechar aviso"
            className="text-base leading-none opacity-60 hover:opacity-100 px-1"
          >
            ×
          </button>
        </div>
      )}

      {/* ─── Banner de aviso informativo (não-erro) ─── */}
      {/* Usado quando a IA não consegue aplicar uma correção cirúrgica (instrução
          ampla demais ou âncora não encontrada). Amarelo pra deixar claro que o
          resumo NÃO foi alterado — diferente do banner vermelho de erro técnico. */}
      {noticeMessage && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 shrink-0 text-amber-700" />
          <div className="flex-1">
            <p className="font-semibold">Correção não aplicada</p>
            <p className="text-xs opacity-90 mt-0.5">{noticeMessage}</p>
          </div>
          <button
            type="button"
            onClick={() => setNoticeMessage(null)}
            aria-label="Fechar aviso"
            className="text-base leading-none opacity-60 hover:opacity-100 px-1"
          >
            ×
          </button>
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
  // Erros fatais (HTTP/rede/parser zero-cabeçalho) ficam num bloco separado em
  // vermelho — são bem mais sérios que "agente engoliu cap" (amarelo). Quando
  // ocorre fatal, todos os caps do batch ficam em `missing`, então excluímos
  // esses batches do bloco amarelo de missing pra não duplicar a informação.
  const fatalWarnings = warnings.filter((w) => w.fatalError);
  const nonFatal = warnings.filter((w) => !w.fatalError);
  const totalMissing = nonFatal.reduce((sum, w) => sum + w.missing.length, 0);
  const totalDuplicates = nonFatal.reduce(
    (sum, w) => sum + (w.duplicatesRemoved ?? 0),
    0,
  );
  const totalInternalDup = nonFatal.reduce(
    (sum, w) => sum + (w.internalDuplicateChapters?.length ?? 0),
    0,
  );
  const missingWarnings = nonFatal.filter((w) => w.missing.length > 0);
  const duplicateWarnings = nonFatal.filter(
    (w) => (w.duplicatesRemoved ?? 0) > 0,
  );
  const internalDupWarnings = nonFatal.filter(
    (w) => (w.internalDuplicateChapters?.length ?? 0) > 0,
  );
  const totalPovStripped = nonFatal.reduce(
    (sum, w) => sum + (w.povMarkersStrippedPart1?.length ?? 0),
    0,
  );
  const povStrippedWarnings = nonFatal.filter(
    (w) => (w.povMarkersStrippedPart1?.length ?? 0) > 0,
  );
  const totalDupPovMarker = nonFatal.reduce(
    (sum, w) => sum + (w.duplicatePovMarkersRemovedPart2?.length ?? 0),
    0,
  );
  const dupPovMarkerWarnings = nonFatal.filter(
    (w) => (w.duplicatePovMarkersRemovedPart2?.length ?? 0) > 0,
  );
  const partTotalWarnings = nonFatal.filter((w) => w.partTotalOutOfRange);
  return (
    <div className="flex flex-col gap-3">
      {fatalWarnings.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex gap-3">
          <AlertTriangle className="size-5 flex-none text-red-700 mt-0.5" />
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-red-900">
              {fatalWarnings.length === 1
                ? "1 batch falhou durante a geração"
                : `${fatalWarnings.length} batches falharam durante a geração`}
            </p>
            <ul className="text-red-900/90 list-disc pl-5 space-y-1">
              {fatalWarnings.map((w, i) => (
                <li key={`fatal-${w.batchIndex}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-red-200/60 mr-1">
                    {w.part} · Par {w.batchIndex}
                  </span>
                  capítulo
                  {w.expected.length === 1 ? " " : "s "}
                  {w.expected.join(", ")} —{" "}
                  <span className="text-red-900/80">{w.fatalError}</span>
                </li>
              ))}
            </ul>
            <p className="text-red-800/80 text-xs">
              Os demais batches do plano foram gerados normalmente. Clique em{" "}
              <strong>Gerar capítulo N novamente</strong> em cada card faltante,
              ou em <strong>Gerar roteiro novamente</strong> pra refazer tudo.
            </p>
          </div>
        </div>
      )}
      {(totalMissing > 0 ||
        totalDuplicates > 0 ||
        totalInternalDup > 0 ||
        totalPovStripped > 0) && (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex gap-3">
      <AlertTriangle className="size-5 flex-none text-amber-700 mt-0.5" />
      <div className="flex flex-col gap-2 text-sm">
        {totalMissing > 0 && (
          <>
            <p className="font-medium text-amber-900">
              {totalMissing === 1
                ? "1 capítulo não foi gerado"
                : `${totalMissing} capítulos não foram gerados`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {missingWarnings.map((w, i) => (
                <li key={`miss-${w.batchIndex}-${i}`}>
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
              <code className="text-[11px]">## Capítulo N</code> do que o
              esperado neste par. Clique em{" "}
              <strong>Gerar roteiro novamente</strong> pra refazer.
            </p>
          </>
        )}
        {totalDuplicates > 0 && (
          <>
            <p className="font-medium text-amber-900">
              {totalDuplicates === 1
                ? "1 capítulo duplicado foi removido automaticamente"
                : `${totalDuplicates} capítulos duplicados foram removidos automaticamente`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {duplicateWarnings.map((w, i) => (
                <li key={`dup-${w.batchIndex}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                    {w.part} · Par {w.batchIndex}
                  </span>
                  removidos: <strong>{w.duplicatesRemoved}</strong>
                </li>
              ))}
            </ul>
            <p className="text-amber-800/80 text-xs">
              O agente re-emitiu capítulos que já existiam — a versão mais
              recente foi mantida e as anteriores descartadas.
            </p>
          </>
        )}
        {totalInternalDup > 0 && (
          <>
            <p className="font-medium text-amber-900">
              {totalInternalDup === 1
                ? "1 capítulo tinha um bloco duplicado por dentro — removido automaticamente"
                : `${totalInternalDup} capítulos tinham bloco duplicado por dentro — removidos automaticamente`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {internalDupWarnings.map((w, i) => (
                <li key={`intdup-${w.batchIndex}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                    {w.part} · Par {w.batchIndex}
                  </span>
                  capítulo
                  {(w.internalDuplicateChapters?.length ?? 0) === 1 ? " " : "s "}
                  <strong>{(w.internalDuplicateChapters ?? []).join(", ")}</strong>
                </li>
              ))}
            </ul>
            <p className="text-amber-800/80 text-xs">
              O agente reiniciou o capítulo no meio e reescreveu cenas que já
              tinha escrito (a segunda metade refazia a primeira). O trecho
              repetido foi cortado e a primeira versão, mantida — antes isso
              passava direto e só aparecia na revisão.
            </p>
          </>
        )}
        {totalPovStripped > 0 && (
          <>
            <p className="font-medium text-amber-900">
              {totalPovStripped === 1
                ? "1 capítulo da Parte 1 tinha um marcador de POV do MMC (✦) — removido automaticamente"
                : `${totalPovStripped} capítulos da Parte 1 tinham marcador de POV do MMC (✦) — removidos automaticamente`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {povStrippedWarnings.map((w, i) => (
                <li key={`pov-${w.batchIndex}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                    {w.part} · Par {w.batchIndex}
                  </span>
                  capítulo
                  {(w.povMarkersStrippedPart1?.length ?? 0) === 1 ? " " : "s "}
                  <strong>
                    {(w.povMarkersStrippedPart1 ?? []).join(", ")}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="text-amber-800/80 text-xs">
              A Parte 1 é narrada só pela heroína — o agente inseriu um bloco de
              POV do MMC (<code className="text-[11px]">✦ NOME</code>) onde não
              devia. O marcador foi removido; rode o <strong>Revisor</strong> pra
              conferir se a prosa desse trecho não ficou na voz dele.
            </p>
          </>
        )}
        {totalDupPovMarker > 0 && (
          <>
            <p className="font-medium text-amber-900">
              {totalDupPovMarker === 1
                ? "1 capítulo da Parte 2 tinha um marcador de POV (✦) duplicado em sequência — colapsado automaticamente"
                : `${totalDupPovMarker} capítulos da Parte 2 tinham marcador de POV (✦) duplicado em sequência — colapsados automaticamente`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {dupPovMarkerWarnings.map((w, i) => (
                <li key={`duppov-${w.batchIndex}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                    {w.part} · Par {w.batchIndex}
                  </span>
                  capítulo
                  {(w.duplicatePovMarkersRemovedPart2?.length ?? 0) === 1
                    ? " "
                    : "s "}
                  <strong>
                    {(w.duplicatePovMarkersRemovedPart2 ?? []).join(", ")}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="text-amber-800/80 text-xs">
              O agente repetiu o mesmo marcador de POV
              (<code className="text-[11px]">✦ NOME</code>) duas vezes seguidas
              (resíduo de copiar-colar). A linha redundante foi removida e o
              marcador colado à prosa foi mantido — a prosa ficou intacta.
            </p>
          </>
        )}
      </div>
    </div>
      )}
      {partTotalWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex gap-3">
          <AlertTriangle className="size-5 flex-none text-amber-700 mt-0.5" />
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-amber-900">
              {partTotalWarnings.length === 1
                ? "1 Parte fechou FORA da faixa de palavras"
                : `${partTotalWarnings.length} Partes fecharam FORA da faixa de palavras`}
            </p>
            <ul className="text-amber-900/90 list-disc pl-5 space-y-0.5">
              {partTotalWarnings.map((w, i) => (
                <li key={`pt-${w.part}-${i}`}>
                  <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-amber-200/60 mr-1">
                    {w.part}
                  </span>
                  <strong>
                    {w.partTotalOutOfRange?.total.toLocaleString("pt-BR")}
                  </strong>{" "}
                  palavras — faixa{" "}
                  {w.partTotalOutOfRange?.min.toLocaleString("pt-BR")}–
                  {w.partTotalOutOfRange?.max.toLocaleString("pt-BR")}
                </li>
              ))}
            </ul>
            <p className="text-amber-800/80 text-xs">
              O balanço de contagem não conseguiu fechar dentro da faixa (quase
              sempre por saturação da cota compartilhada — as reescritas de ajuste
              falham em silêncio). Clique em{" "}
              <strong>Gerar roteiro novamente</strong> quando a cota liberar — o
              ajuste é idempotente e só mexe no que ainda está fora.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function EscritaOutputView({
  output,
  chapterTargets,
  onRegenerate,
  regeneratingChapterIdx,
  regenerateDisabled,
}: {
  output: StepOutput;
  chapterTargets?: Map<string, number>;
  onRegenerate?: (idx: number) => void;
  regeneratingChapterIdx?: number | null;
  regenerateDisabled?: boolean;
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
              onRegenerate={onRegenerate}
              isRegenerating={regeneratingChapterIdx === i}
              regenerateDisabled={regenerateDisabled}
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
  onRegenerate,
  isRegenerating,
  regenerateDisabled,
}: {
  chapter: EscritaChapter;
  chapterIndex: number;
  defaultOpen: boolean;
  targetWordCount?: number;
  onSave?: (idx: number, newContent: string) => void;
  onRegenerate?: (idx: number) => void;
  isRegenerating?: boolean;
  regenerateDisabled?: boolean;
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
          {(onSave || onRegenerate) && (
            <div className="flex items-center justify-end gap-2 mb-3">
              {!isEditing ? (
                <>
                  {onRegenerate && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={regenerateDisabled || isRegenerating}
                      onClick={() => onRegenerate(chapterIndex)}
                    >
                      {isRegenerating ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Regenerando…
                        </>
                      ) : (
                        <>
                          <RotateCcw className="size-3.5" />
                          Regerar
                        </>
                      )}
                    </Button>
                  )}
                  {onSave && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={startEdit}
                      disabled={isRegenerating}
                    >
                      <Pencil className="size-3.5" />
                      Editar
                    </Button>
                  )}
                </>
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

/**
 * Banner de Escrita interrompida no meio (app fechado, crash, cancelamento,
 * erro de cota/rede). Os capítulos prontos já estão salvos; oferece retomar
 * gerando só o que falta, ou regerar tudo do zero.
 */
function EscritaIncompleteBanner({
  chapterCount,
  expectedChapterCount,
  onContinue,
  onRegenerate,
  errorReason,
}: {
  chapterCount: number;
  expectedChapterCount: number;
  onContinue: () => void;
  onRegenerate: () => void;
  /** Causa real da interrupção (login/cota/rede), quando o job terminou em erro. */
  errorReason?: string;
}) {
  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-4 sm:px-5 py-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 flex-none text-amber-700 mt-0.5" />
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">
            Geração interrompida — {chapterCount} de {expectedChapterCount}{" "}
            capítulos prontos
          </p>
          {errorReason && (
            <p className="text-xs font-medium text-amber-900 bg-amber-100 border border-amber-300 rounded px-2 py-1.5">
              Motivo: {errorReason}
            </p>
          )}
          <p className="text-xs text-amber-800/90">
            Os capítulos já gerados estão salvos. Você pode continuar de onde
            parou (gera só os que faltam, mantendo o que já existe) ou gerar
            tudo do zero.
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
          Continuar geração
        </Button>
        <Button
          onClick={onRegenerate}
          size="sm"
          variant="outline"
          className="gap-2 border-amber-300 text-amber-900 hover:bg-amber-100"
        >
          <RotateCcw className="size-3.5" />
          Gerar tudo do zero
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
  } else if (progress.kind === "calibrating") {
    const action =
      progress.currentWords > progress.targetWords ? "Encurtando" : "Expandindo";
    title = `${action} cap ${progress.chapter}`;
    subtitle = `· ${progress.part} · ${progress.currentWords.toLocaleString("pt-BR")} → alvo ${progress.targetWords.toLocaleString("pt-BR")} palavras`;
    phaseBanner = `Calibração ${progress.currentIndex} de ${progress.totalToCalibrate} — ajustando capítulo pra ficar dentro do alvo da Estrutura`;
    placeholder =
      "Reescrevendo o capítulo respeitando cenas, falas-chave e cliffhanger — só ajustando densidade pra atingir o alvo de palavras.";
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
