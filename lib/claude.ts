import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";

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
  userContent.push({
    type: "text",
    text: params.userMessage,
    cache_control: { type: "ephemeral" },
  });
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

    for await (const msg of iter) {
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta"
        ) {
          yield ev.delta.text;
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
