import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
// Log de consumo de tokens (server-side, só observabilidade). Import com
// extensão .ts explícita: typecheck aceita (allowImportingTsExtensions),
// o teste em node --experimental-strip-types resolve, e o Turbopack também.
// usage-log.ts não importa `@/...` de valor, então não quebra o teste.
import { recordUsageEvent } from "./usage-log.ts";

// Marcadores que cercam o raciocínio (thinking) no stream text/plain. DEVEM
// casar byte-a-byte com lib/stream-markers.ts (onde `splitThinking` os consome
// no cliente). Definidos inline aqui — e NÃO importados — porque claude.ts é
// carregado direto pelo test (`node scripts/test-build-prompt-input.mjs`), que
// não resolve o alias `@/` nem import relativo sem extensão. Ver stream-markers.ts.
const SOH = String.fromCharCode(1);
const THINKING_OPEN = `${SOH}T${SOH}`;
const THINKING_CLOSE = `${SOH}/T${SOH}`;

// Sentinela do prefixo cacheável. DEVE casar byte-a-byte com
// lib/agents/_shared/prompt-cache.ts (CACHE_PREFIX_BOUNDARY) — replicado aqui
// inline pelo mesmo motivo dos markers acima (o test roda em node puro e não
// resolve o alias `@/`). Se mudar lá, mude aqui também. Quando a userMessage
// contém este marcador, buildPromptInput a quebra em dois text blocks num
// breakpoint de prompt caching (prefixo estático cacheável + sufixo variável).
const STX = String.fromCharCode(2);
const CACHE_PREFIX_BOUNDARY = `${STX}CACHE_BOUNDARY${STX}`;

// Acumulador de uso por processo (Pilar C — medição do loop fechado). Somado a
// cada `result` em streamClaudeText e logado como linha `cumulative:` pra tornar
// o hit% de cache observável ao longo de uma geração.
const usageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/**
 * Snapshot do uso acumulado nesta sessão do server Next (zera no restart do
 * server). Exposto via `/api/claude-usage` pro painel de métricas mostrar o
 * hit% de cache e o total de tokens consumidos da cota compartilhada — só
 * observabilidade, não muda nada na geração.
 */
export function getUsageTotals() {
  const cacheable = usageTotals.input + usageTotals.cacheRead;
  const hitPct =
    cacheable > 0 ? Math.round((usageTotals.cacheRead / cacheable) * 100) : 0;
  return { ...usageTotals, hitPct };
}

export type ClaudeImageMime =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

/**
 * Resolve o caminho do binário claude.exe (nativo). Em modo packaged o
 * Electron já passa via MYSTORIESLENA_CLAUDE_EXEC — mas se o env var estiver
 * ausente ou inválido, tentamos resolver aqui pra não depender só do main
 * process. NOTA: a lista de subPaths está duplicada em electron/main.js
 * (`getClaudeExecutablePath`); se mudar lá, mude aqui também.
 */
let cachedExecutable: { value: string | undefined } | null = null;

function resolveClaudeExecutable(): string | undefined {
  if (cachedExecutable) return cachedExecutable.value;

  const envPath = process.env.MYSTORIESLENA_CLAUDE_EXEC;
  if (envPath && fs.existsSync(envPath)) {
    cachedExecutable = { value: envPath };
    return envPath;
  }
  if (envPath) {
    console.warn(
      `[claude.ts] MYSTORIESLENA_CLAUDE_EXEC aponta pra arquivo inexistente: ${envPath} — caindo em fallback`,
    );
  }

  const platform = process.platform;
  const arch = process.arch;
  const platArch = `${platform}-${arch}`;
  const exe = platform === "win32" ? "claude.exe" : "claude";

  const subPaths = [
    `node_modules/@anthropic-ai/claude-agent-sdk-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code/bin/${exe}`,
  ];

  const roots = [process.cwd(), path.dirname(process.execPath)];
  const tested: string[] = [];
  for (const root of roots) {
    for (const sub of subPaths) {
      const full = path.join(root, sub);
      tested.push(full);
      if (fs.existsSync(full)) {
        console.log(`[claude.ts] fallback resolveu binário em: ${full}`);
        cachedExecutable = { value: full };
        return full;
      }
    }
  }

  console.error(
    `[claude.ts] FALHA ao resolver binário claude — testados ${tested.length} caminhos:\n  ${tested.join("\n  ")}`,
  );
  cachedExecutable = { value: undefined };
  return undefined;
}

export interface ClaudeImageInput {
  /** Apenas o base64 puro, SEM o prefixo "data:image/...;base64,". */
  base64Data: string;
  mimeType: ClaudeImageMime;
}

/**
 * Item content possível em um SDKUserMessage. Suporta imagem multimodal
 * e texto com cache_control ephemeral pra prompt caching da Anthropic.
 */
export type UserContentBlock =
  | {
      type: "image";
      source: { type: "base64"; media_type: ClaudeImageMime; data: string };
    }
  | {
      type: "text";
      text: string;
      cache_control?: { type: "ephemeral" };
    };

/**
 * Constrói o AsyncIterable<SDKUserMessage> que vai pro `query()`. Sempre
 * usa a forma estruturada (content array) — a forma de string simples
 * não permite cache_control. Anexa cache_control: ephemeral no último
 * text block, marcando system prompt + user message inteiros como
 * cacheáveis. Segunda chamada idêntica em 5 min lê do cache (Revisor
 * cai de ~2.5min cold pra ~32s warm).
 *
 * Exportada pra ser testável em isolamento.
 */
export function buildPromptInput(params: {
  userMessage: string;
  image?: ClaudeImageInput;
}): AsyncGenerator<{
  type: "user";
  parent_tool_use_id: null;
  message: { role: "user"; content: UserContentBlock[] };
}> {
  const userContent: UserContentBlock[] = [];
  if (params.image) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: params.image.mimeType,
        data: params.image.base64Data,
      },
    });
  }
  // Se a mensagem traz o sentinela, quebramos em DOIS text blocks só pra PODER
  // remover o caractere de controle do meio (prefixo estável | sufixo variável).
  // O cache_control vai SÓ no ÚLTIMO bloco (o sufixo) — NUNCA num bloco anterior.
  //
  // ⚠️ POR QUÊ (aprendido na marra): o Claude CLI injeta SOZINHO um cache_control
  // ttl='1h' no ÚLTIMO bloco da mensagem, independente do que a gente manda.
  // Qualquer cache_control NOSSO num bloco anterior vira ttl='5m' e fica ANTES
  // desse 1h → a API rejeita com 400 ("a ttl='1h' cache_control block must not
  // come after a ttl='5m' cache_control block", apontando o último bloco). Foi o
  // que quebrou a Escrita na 1.0.74: o breakpoint no prefixo (5m) vinha antes do
  // 1h que o CLI põe no fim. A geração single-block (1.0.73) sempre funcionou
  // justamente porque tem UM bloco só, e o cache cai nele (= último) → o 1h do
  // CLI não tem nenhum 5m antes. Aqui replicamos isso: cache_control só no fim.
  // Trade-off: perdemos o cache de prefixo cross-batch — reativá-lo exigiria
  // marcar o prefixo com ttl='1h' EXPLÍCITO (pra empatar com o 1h do fim), não
  // com ephemeral default; só fazer depois de validar que o CLI honra o ttl.
  const boundaryIdx = params.userMessage.indexOf(CACHE_PREFIX_BOUNDARY);
  if (boundaryIdx === -1) {
    userContent.push({
      type: "text",
      text: params.userMessage,
      cache_control: { type: "ephemeral" },
    });
  } else {
    const prefix = params.userMessage.slice(0, boundaryIdx).trimEnd();
    // Defensivo: remove qualquer sentinela remanescente do sufixo (os builders
    // inserem exatamente um) pra garantir que o caractere de controle NUNCA
    // vaze pro texto enviado ao modelo.
    const suffix = params.userMessage
      .slice(boundaryIdx + CACHE_PREFIX_BOUNDARY.length)
      .split(CACHE_PREFIX_BOUNDARY)
      .join("\n\n")
      .trimStart();
    // Prefixo SEM cache_control (não pode haver breakpoint antes do último bloco).
    if (prefix) {
      userContent.push({
        type: "text",
        text: prefix,
      });
    }
    // Cache_control SÓ no último bloco (sufixo) — espelha a 1.0.73 que funciona.
    userContent.push({
      type: "text",
      text: suffix,
      cache_control: { type: "ephemeral" },
    });
  }
  return (async function* () {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: userContent,
      },
    };
  })();
}

export interface StreamClaudeParams {
  systemPrompt: string;
  userMessage: string;
  model: string;
  /** Override thinking mode. Default: disabled (maior velocidade). */
  thinking?: "disabled" | "adaptive";
  /**
   * Effort level. Only aplicável com thinking=adaptive.
   * Default: "low" (maior velocidade).
   */
  effort?: "low" | "medium" | "high";
  /**
   * Imagem opcional anexada como input multimodal. Quando presente, o
   * prompt é enviado como AsyncIterable<SDKUserMessage> com [imageBlock,
   * textBlock] em vez de string simples.
   */
  image?: ClaudeImageInput;
  signal?: AbortSignal;
  /**
   * Metadados de observabilidade pro log de consumo de tokens (`lib/usage-log`).
   * Opcional — chamadas sem `meta` seguem funcionando, só ficam sem atribuição.
   * Não influencia NADA na geração (não vai pro modelo).
   */
  meta?: {
    step?: string;
    category?: string;
    model?: string;
    roteiroId?: string;
    writer?: string;
  };
}

/**
 * Runs a single-turn generation via the Claude Agent SDK (uses the local
 * Claude Code CLI auth — the user's subscription — instead of an API key).
 *
 * Defaults otimizados para VELOCIDADE em geração criativa:
 * - thinking desabilitado (não gasta tempo "pensando" antes de escrever)
 * - effort low
 * - sem tools, sem session persist, sem setting sources
 *
 * Yields text chunks as they stream from the model.
 */
export async function* streamClaudeText(
  params: StreamClaudeParams,
): AsyncGenerator<string, void, void> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  params.signal?.addEventListener("abort", onAbort, { once: true });

  const thinking =
    params.thinking === "adaptive"
      ? ({ type: "adaptive" } as const)
      : ({ type: "disabled" } as const);

  // Sanitiza o env: remove ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL contaminados
  // (mesmo vazios eles fazem o SDK tentar API key mode em vez de OAuth do
  // plano do usuário, causando 401). Mantém o resto do env intacto.
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  if (cleanEnv.ANTHROPIC_API_KEY !== undefined && !cleanEnv.ANTHROPIC_API_KEY) {
    delete cleanEnv.ANTHROPIC_API_KEY;
  }
  if (cleanEnv.ANTHROPIC_AUTH_TOKEN !== undefined && !cleanEnv.ANTHROPIC_AUTH_TOKEN) {
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
  }
  // Remove BASE_URL custom — usa o default do CLI logado
  if (cleanEnv.ANTHROPIC_BASE_URL) {
    delete cleanEnv.ANTHROPIC_BASE_URL;
  }

  // Quando empacotado pelo Electron, o subpacote nativo @anthropic-ai/
  // claude-agent-sdk-win32-x64 fica em app.asar.unpacked, fora do alcance
  // do require.resolve do SDK. O Electron passa o caminho exato do
  // claude.exe via MYSTORIESLENA_CLAUDE_EXEC pra resolver isso.
  //
  // Fallback robusto: se o env var não estiver setado OU apontar pra um
  // arquivo que não existe (ex: boot do Electron falhou em encontrar o
  // binário), tenta resolver aqui mesmo a partir de process.cwd() e
  // dirname(process.execPath). Em modo packaged, cwd === resources/app/.
  const pathToClaudeCodeExecutable = resolveClaudeExecutable();

  const promptInput = buildPromptInput(params);

  try {
    const iter = query({
      prompt: promptInput,
      options: {
        model: params.model,
        // System prompt como array com o marcador SYSTEM_PROMPT_DYNAMIC_BOUNDARY:
        // tudo ANTES do marcador vira prefixo estático cacheável entre chamadas
        // (cross-call), DEPOIS não. Como nosso system prompt é 100% estático por
        // categoria/step, marcamos ele inteiro como cacheável e deixamos o
        // boundary no fim (sem sufixo dinâmico). Isso reaproveita o system prompt
        // (grande) nos 6+ lotes da Escrita, nas calibrações paralelas, nas fases
        // do Revisor e no fallback — sem mudar 1 byte do que o modelo lê. O
        // cache_control ephemeral da mensagem do usuário (buildPromptInput)
        // continua cobrindo re-runs idênticos. Evidência: `cache_read` nos logs
        // de usage abaixo.
        systemPrompt: [params.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
        tools: [],
        maxTurns: 1,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [],
        thinking,
        effort: params.effort ?? "low",
        env: cleanEnv,
        abortController,
        ...(pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable }
          : {}),
      },
    });

    // Estado pra cercar o raciocínio (thinking) com marcadores no stream. Só
    // os agentes de Estrutura (thinking adaptive) produzem thinking_delta; pros
    // demais, nada disso dispara e a saída é texto puro. Os marcadores deixam o
    // cliente exibir o raciocínio ao vivo (esmaecido) sem que ele contamine o
    // conteúdo final salvo. Ver lib/stream-markers.ts.
    let thinkingOpened = false;
    let thinkingClosed = false;

    for await (const msg of iter) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "thinking_delta") {
            // Ignora raciocínio que reapareça DEPOIS do texto começar (raro em
            // maxTurns:1) — fechamos a região uma vez só pra não poluir o
            // conteúdo com texto que não casa o split de faixa única.
            if (thinkingClosed) continue;
            if (!thinkingOpened) {
              thinkingOpened = true;
              yield THINKING_OPEN;
            }
            yield ev.delta.thinking;
          } else if (ev.delta.type === "text_delta") {
            if (thinkingOpened && !thinkingClosed) {
              thinkingClosed = true;
              yield THINKING_CLOSE;
            }
            yield ev.delta.text;
          }
        }
      } else if (msg.type === "result") {
        // Loga usage stats — útil pra confirmar que prompt caching está
        // funcionando. Se cache_creation_input_tokens > 0 na 1ª chamada
        // e cache_read_input_tokens > 0 na 2ª, o cache_control está
        // sendo honrado. Sem isso, só temos timing como evidência indireta.
        const u = (msg as { usage?: Record<string, unknown> }).usage;
        if (u && typeof u === "object") {
          const inp = (u as Record<string, unknown>).input_tokens;
          const out = (u as Record<string, unknown>).output_tokens;
          const cw = (u as Record<string, unknown>).cache_creation_input_tokens;
          const cr = (u as Record<string, unknown>).cache_read_input_tokens;
          console.log(
            `[claude.ts] usage: input=${inp ?? "?"} output=${out ?? "?"} cache_write=${cw ?? 0} cache_read=${cr ?? 0}` +
              (typeof cr === "number" && cr > 0 ? "  ← CACHE HIT" : ""),
          );

          // Acumulado por processo (o módulo vive 1× no Next server) — torna o
          // ganho do prefixo cacheável VISÍVEL: o hit% deve subir batch a batch
          // (1º batch grava ~20k, os demais leem). Se um reorder quebrar o
          // prefixo, cache_read despenca e o hit% cai — regressão fácil de
          // pegar. Risco zero: só observabilidade.
          if (typeof inp === "number") usageTotals.input += inp;
          if (typeof out === "number") usageTotals.output += out;
          if (typeof cw === "number") usageTotals.cacheWrite += cw;
          if (typeof cr === "number") usageTotals.cacheRead += cr;
          const cacheable = usageTotals.input + usageTotals.cacheRead;
          const hitPct =
            cacheable > 0
              ? Math.round((usageTotals.cacheRead / cacheable) * 100)
              : 0;
          console.log(
            `[claude.ts] cumulative: input=${usageTotals.input} cache_read=${usageTotals.cacheRead} cache_write=${usageTotals.cacheWrite} output=${usageTotals.output} hit=${hitPct}%`,
          );

          // Grava o evento no log de consumo de tokens (local + Sheets central).
          // Best-effort/non-blocking — recordUsageEvent nunca lança. Só
          // observabilidade da cota compartilhada da equipe; o `meta` traz a
          // atribuição (roteirista/roteiro/passo/categoria/modelo).
          recordUsageEvent({
            ...(params.meta ?? {}),
            model: params.meta?.model ?? params.model,
            input: typeof inp === "number" ? inp : 0,
            output: typeof out === "number" ? out : 0,
            cacheRead: typeof cr === "number" ? cr : 0,
            cacheWrite: typeof cw === "number" ? cw : 0,
          });
        }
        if (msg.subtype !== "success") {
          const errMsg = msg.errors?.join("; ") || msg.subtype;
          throw new Error(`Claude Agent SDK falhou: ${errMsg}`);
        }
      }
    }
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}
