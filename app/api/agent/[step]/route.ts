import { NextRequest } from "next/server";
import { streamClaudeText, type ClaudeImageInput, type ClaudeImageMime } from "@/lib/claude";
import { getAgent } from "@/lib/agents";
import type {
  EscritaSynopsis,
  RoteiroCategory,
  RoteiroReferenceImage,
  StepId,
  StepOutput,
} from "@/types/roteiro";
import { DEFAULT_CATEGORY, STEP_ORDER } from "@/types/roteiro";
import type { AgentBatchContext } from "@/lib/agents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  /**
   * Sub-nicho do roteiro — define qual conjunto de prompts/agentes este step
   * usa. Se ausente, default "milionario-1p" (compatibilidade com legado).
   */
  category?: RoteiroCategory;
  previousOutputs?: Partial<Record<StepId, StepOutput>>;
  userInput?: string;
  /** Imagem de referência anexada na Premissa (passada por todos steps; só
   *  agentes com acceptsReferenceImage=true recebem como input multimodal). */
  referenceImage?: RoteiroReferenceImage;
  /** Modo correção: usa currentOutput como base e userInput como instrução
   *  de ajuste pontual, sem regenerar do zero. */
  refineMode?: boolean;
  /** Versão atual do output desse step (base do modo correção). */
  currentOutput?: string;
  /** Modo 2-em-2 do Escrita — descreve qual par o agente deve gerar agora. */
  batch?: AgentBatchContext;
  /** Sinopses dos capítulos já gerados em batches anteriores. */
  previousSynopses?: EscritaSynopsis[];
  /** Sinopses da OUTRA Parte já escritas (contexto cruzado P1 → P2 na Escrita
   *  paralela). A P2 usa pra não contradizer fatos já narrados na P1. */
  crossPartSynopses?: EscritaSynopsis[];
  /** Fase do agente Premissa: "resumo" (Bloco 0) ou "estrutura" (Blocos 1-8). */
  premissaPhase?: "resumo" | "estrutura";
  /** Resumo (Bloco 0) já aprovado pelo usuário — exigido na fase "estrutura". */
  approvedResumo?: string;
  /** Modo "Continuar revisão": títulos dos erros já destacados em rodadas
   *  anteriores. O agente Revisor recebe instrução de não repetir esses erros
   *  e focar em refinamentos novos. Só relevante pros steps "revisor1"/"revisor2". */
  previousRevisorErrors?: string[];
  /** Modo "relatório enxuto" do Revisor: a partir da 2ª passada, gera só o
   *  bloco de erros (PRINCIPAIS ERROS + <erros_detalhados>), pulando o ensaio
   *  (Análise de Leitor/Hater/Nota/Melhorias). Só relevante pros revisores. */
  leanRevisorReport?: boolean;
  /** Modo "Continuar de onde parou" (Estrutura P1/P2): quando true, o agente
   *  recebe o `currentOutput` como partial e deve continuar exatamente daquele
   *  ponto sem repetir nem recomeçar. */
  continuationMode?: boolean;
  /** Cânone de Entidades — bloco markdown estruturado com nomes/idades/lugares/
   *  datas/relações fixados a partir da Premissa e aprovado pela roteirista.
   *  Quando presente, agentes pós-Premissa injetam como referência canônica
   *  no user message (ver `lib/agents/_shared/canone-block.ts`). */
  canone?: string;
  /** Id do roteiro — só pra atribuição no log de consumo de tokens
   *  (`lib/usage-log`). Não influencia a geração. */
  roteiroId?: string;
}

const ACCEPTED_IMAGE_MIMES: ClaudeImageMime[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** Extrai base64 puro de uma data URL "data:image/jpeg;base64,...". */
function dataUrlToImageInput(
  dataUrl: string,
  mime: ClaudeImageMime,
): ClaudeImageInput | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const detectedMime = m[1] as ClaudeImageMime;
  const data = m[2];
  if (!ACCEPTED_IMAGE_MIMES.includes(detectedMime)) return null;
  return { mimeType: detectedMime || mime, base64Data: data };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ step: string }> },
) {
  const { step } = await ctx.params;

  if (!STEP_ORDER.includes(step as StepId)) {
    return new Response(`Etapa inválida: ${step}`, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  if (
    step === "premissa" &&
    body.premissaPhase === "estrutura" &&
    !body.refineMode &&
    !body.approvedResumo?.trim()
  ) {
    return new Response(
      "Para gerar a estrutura (Blocos 1-8) é necessário enviar o resumo aprovado pelo usuário em `approvedResumo`.",
      { status: 400 },
    );
  }

  const agent = getAgent(body.category ?? DEFAULT_CATEGORY, step as StepId);
  const userMessage = agent.buildUserMessage({
    previousOutputs: body.previousOutputs ?? {},
    userInput: body.userInput,
    referenceImage: body.referenceImage,
    refineMode: body.refineMode,
    currentOutput: body.currentOutput,
    ...(body.batch ? { batch: body.batch } : {}),
    ...(body.previousSynopses
      ? { previousSynopses: body.previousSynopses }
      : {}),
    ...(body.crossPartSynopses && body.crossPartSynopses.length > 0
      ? { crossPartSynopses: body.crossPartSynopses }
      : {}),
    ...(body.premissaPhase ? { premissaPhase: body.premissaPhase } : {}),
    ...(body.approvedResumo ? { approvedResumo: body.approvedResumo } : {}),
    ...(body.previousRevisorErrors && body.previousRevisorErrors.length > 0
      ? { previousRevisorErrors: body.previousRevisorErrors }
      : {}),
    ...(body.leanRevisorReport ? { leanRevisorReport: true } : {}),
    ...(body.continuationMode ? { continuationMode: true } : {}),
    ...(body.canone?.trim() ? { canone: body.canone } : {}),
  });

  // Image multimodal — só vai pro modelo se o agente declarou acceptsReferenceImage.
  // Steps que não aceitam imagem ignoram (mantém prompt mais barato/leve).
  const imageInput =
    agent.acceptsReferenceImage && body.referenceImage
      ? dataUrlToImageInput(
          body.referenceImage.dataUrl,
          body.referenceImage.mimeType,
        )
      : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamClaudeText({
          systemPrompt: agent.systemPrompt,
          userMessage,
          model: agent.model,
          thinking: agent.thinking,
          effort: agent.effort,
          ...(imageInput ? { image: imageInput } : {}),
          signal: req.signal,
          meta: {
            step,
            category: body.category ?? DEFAULT_CATEGORY,
            model: agent.model,
            ...(body.roteiroId ? { roteiroId: body.roteiroId } : {}),
          },
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Erro desconhecido";
        const isBinaryError =
          /native binary not found|claude\.exe.*not found|pathToClaudeCodeExecutable/i.test(msg);
        const isAuthError =
          /authentication|401|invalid auth|unauthorized|credentials/i.test(msg);
        if (isBinaryError) {
          const installerHint =
            process.platform === "darwin"
              ? `2. Baixe o "MyStoriesLena-x.y.z-arm64.dmg" (Apple Silicon) ou "MyStoriesLena-x.y.z-x64.dmg" (Macs Intel) — pra saber qual, vá em → Sobre Este Mac → "Chip".\n3. Abra o .dmg e arraste o app pra pasta Aplicativos (substituindo a versão atual). Seus roteiros ficam salvos no localStorage e não são perdidos.\n4. Abra o app de novo e tente gerar.`
              : `2. Rode o "MyStoriesLena-Setup-x.y.z.exe" — ele substitui a instalação atual sem perder seus roteiros (ficam salvos no localStorage).\n3. Abra o app de novo e tente gerar.`;
          const devToolsHint =
            process.platform === "darwin"
              ? "Cmd+Option+I"
              : "Ctrl+Shift+I";
          controller.enqueue(
            encoder.encode(
              `\n\n[BINÁRIO CLAUDE NÃO ENCONTRADO]\n\nO binário do Claude Code não está disponível neste pacote do app. Isso costuma acontecer quando a instalação ficou incompleta ou foi corrompida durante uma atualização.\n\n💡 COMO RESOLVER:\n\n1. Baixe o instalador mais recente em:\n   https://github.com/lucasbaziliocomercial-crypto/mystorieslena/releases\n${installerHint}\n\nSe persistir mesmo após reinstalar, abra um issue colando os logs do DevTools:\n   • Pressione ${devToolsHint} dentro do app pra abrir o DevTools\n   • Vá na aba "Console" e copie as linhas que começam com [claude]\n   • Reporte em https://github.com/lucasbaziliocomercial-crypto/mystorieslena/issues\n\n--- Detalhe técnico ---\n${msg}`,
            ),
          );
        } else if (isAuthError) {
          const loginSteps =
            process.platform === "darwin"
              ? `1. No app, volte pra tela inicial (clique no logo ou no botão "Voltar").\n2. No card "Conectar Claude", clique em "Conectar conta Claude" — vai abrir o Terminal.\n3. No Terminal que abriu, digite \`/login\` e aperte Enter.\n4. O navegador vai pedir pra fazer login com sua conta Claude — autorize.\n5. Quando voltar pro Terminal, digite \`/quit\` pra fechar.\n6. Clique em "Já loguei — verificar" no app e tente gerar de novo.`
              : `1. Abra o PowerShell (Iniciar → digite "PowerShell" → Enter)\n2. Cole este comando e aperte Enter:\n\n       claude\n\n3. Vai abrir o navegador pedindo pra fazer login com sua conta Claude.\n4. Autorize. Quando voltar pro PowerShell, pode fechar.\n5. Volte aqui no MyStoriesLena e clique em "Gerar novamente" — não precisa reiniciar o app.`;
          controller.enqueue(
            encoder.encode(
              `\n\n[LOGIN NECESSÁRIO NO CLAUDE]\n\nVocê precisa estar logado na sua conta Claude Pro/Max pra usar o MyStoriesLena. Pode ser a primeira vez que abre o app, ou o token expirou.\n\n💡 COMO RESOLVER (1 minuto):\n\n${loginSteps}\n\n--- Detalhe técnico ---\n${msg}`,
            ),
          );
        } else {
          controller.enqueue(encoder.encode(`\n\n[ERRO] ${msg}`));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
