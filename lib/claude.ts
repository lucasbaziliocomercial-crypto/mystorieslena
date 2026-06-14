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
      // `ttl` opcional: "5m" (default ephemeral) ou "1h" (estendido). Marcamos
      // o prefixo cacheável da Escrita com "1h" EXPLÍCITO pra empatar com o 1h
      // que o CLI injeta no último bloco (sem isso, 5m antes de 1h = 400). Ver
      // o comentário em buildPromptInput.
      cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
    };

/**
 * Constrói o AsyncIterable<SDKUserMessage> que vai pro `query()`. Sempre
 * usa a forma estruturada (content array) — a forma de string simples
 * não permite cache_control.
 *
 * Sem o sentinela CACHE_PREFIX_BOUNDARY (Revisor/Estrutura/calibração/refine):
 * UM text block com cache_control ephemeral default — re-run idêntico em 5 min
 * lê do cache (Revisor cai de ~2.5min cold pra ~32s warm).
 *
 * COM o sentinela (só a Escrita): DOIS text blocks, ambos cache_control
 * ttl='1h' — o prefixo estável (~20k tokens) vira cache_read cross-batch nos
 * ~10-12 batches da geração (ataca a cota compartilhada da equipe + TTFT). Ver
 * o comentário extenso no corpo da função pro porquê do ttl='1h' explícito.
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
  // Se a mensagem traz o sentinela (só a Escrita usa), quebramos em DOIS text
  // blocks: prefixo ESTÁVEL (cânone+premissa+estrutura, ~20k tokens, idêntico
  // em todos os ~10-12 batches da geração) | sufixo VARIÁVEL (intro+sinopses+
  // alvos+AÇÃO). AMBOS marcados com cache_control ttl='1h' → o prefixo passa a
  // ser lido do cache (cache_read) batch a batch e cruzado entre os loops P1‖P2,
  // em vez de reprocessado a cada chamada (ataca a cota compartilhada da equipe).
  //
  // ⚠️ POR QUÊ ttl='1h' EXPLÍCITO nos dois (aprendido na marra): o Claude CLI
  // injeta SOZINHO um cache_control ttl='1h' no ÚLTIMO bloco da mensagem. A trava
  // da API é "um bloco ttl='1h' não pode vir DEPOIS de um ttl='5m'". Na 1.0.74 o
  // prefixo tinha ephemeral DEFAULT (=5m) e o 1h do CLI vinha no fim → 1h depois
  // de 5m = 400 ("a ttl='1h' cache_control block must not come after a ttl='5m'
  // ...") e a Escrita quebrava. A correção é deixar TUDO 1h (prefixo + sufixo +
  // o 1h do CLI no último bloco): sem nenhum 5m, a ordenação é impossível de
  // violar. NÃO basta tirar o cache_control do prefixo (era a versão anterior, que
  // funcionava mas SEM cache de prefixo cross-batch — exatamente o que reativamos
  // aqui). O branch de bloco único abaixo segue ephemeral default: é sempre o
  // ÚLTIMO bloco (Revisor/Estrutura/calibração/refine), então o 1h do CLI cai
  // nele sem nenhum 5m antes — sem risco de ordenação.
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
    // Prefixo COM cache_control ttl='1h' — este é o breakpoint que reativa o
    // cache de prefixo cross-batch. ttl='1h' (não default) pra não ficar ANTES
    // do 1h do CLI com um 5m (= 400). Ver comentário acima.
    if (prefix) {
      userContent.push({
        type: "text",
        text: prefix,
        cache_control: { type: "ephemeral", ttl: "1h" },
      });
    }
    // Sufixo (último bloco) também ttl='1h' pra empatar com o que o CLI injeta —
    // garante que não existe nenhum 5m em lugar nenhum da mensagem.
    userContent.push({
      type: "text",
      text: suffix,
      cache_control: { type: "ephemeral", ttl: "1h" },
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
 * Nº máximo de tentativas de UMA chamada ao SDK (1 original + 2 retries). Cobre
 * a janela de uma corrida de refresh de token OAuth: vários processos `claude`
 * concorrentes (revisor1‖revisor2, P1‖P2, vários jobs na fila) competem pela
 * renovação do token em ~/.claude/.credentials.json — o perdedor leva um 401
 * transiente. Ver streamClaudeText (recursão de retry) e isRetryableClaudeError.
 */
const MAX_ATTEMPTS = 3;

/**
 * Erro do SDK que vale REPETIR (transiente) em vez de estourar pro usuário como
 * "[LOGIN NECESSÁRIO NO CLAUDE]"/"[ERRO]". É superset do `isAuthError` da rota
 * (app/api/agent/[step]/route.ts) — tudo que hoje vira bloco de login é
 * retentado ANTES — somado aos transientes de cota/rede que a Escrita já
 * reconhece (espelha o regex de cota de lib/generation/run-escrita.ts):
 *   • corrida de auth/refresh: authentication · 401 · invalid auth · unauthorized · credentials
 *   • cota/sobrecarga:         429 · rate limit · overloaded · capacity
 *   • rede:                    ECONNRESET · socket hang up · network · fetch failed · terminated
 * Exportada pra teste (scripts/test-claude-retry.mjs).
 */
export function isRetryableClaudeError(msg: string): boolean {
  return /authentication|401|invalid auth|unauthorized|credentials|429|rate.?limit|overloaded|capacity|ECONNRESET|socket hang up|network|fetch failed|terminated/i.test(
    msg,
  );
}

/**
 * O SDK completou SEM erro porém NÃO emitiu nenhum texto/raciocínio (um `result`
 * subtype `success` com conteúdo vazio). É a manifestação SILENCIOSA da corrida
 * de refresh do token OAuth sob concorrência (o processo `claude` perdedor às
 * vezes devolve um result success VAZIO em vez de lançar 401) — escapava do
 * retry (que só via erro LANÇADO) E do watchdog de stall (não há hang, o stream
 * fecha na hora), então o passo (cânone/estrutura/revisor/escrita) saía EM
 * BRANCO quando se geram DOIS ao mesmo tempo, sem erro nenhum. Tratado como
 * transiente: `streamClaudeText` retenta (query fresca) e, esgotadas as
 * tentativas, vira erro claro (a rota → [ERRO] recuperável) em vez de vazio mudo.
 */
class EmptyResultError extends Error {
  constructor() {
    super("Claude Agent SDK: resposta vazia (result success sem conteúdo)");
    this.name = "EmptyResultError";
  }
}

/**
 * Backoff exponencial (500ms · 1s · 2s … teto 4s) + jitter aleatório de 0..base.
 * O jitter DESSINCRONIZA as tentativas dos processos concorrentes — sem ele,
 * todos retentariam juntos e recriariam a mesma corrida de refresh ("thundering
 * herd"). Math.random é OK aqui (server-side; não é script de Workflow).
 */
function retryBackoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * base);
}

/** Sleep que resolve cedo se o `signal` abortar (não trava o cancelamento). */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
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
 * Runs a single-turn generation via the Claude Agent SDK (uses the local
 * Claude Code CLI auth — the user's subscription — instead of an API key).
 *
 * Defaults otimizados para VELOCIDADE em geração criativa:
 * - thinking desabilitado (não gasta tempo "pensando" antes de escrever)
 * - effort low
 * - sem tools, sem session persist, sem setting sources
 *
 * Yields text chunks as they stream from the model.
 *
 * Resiliência: erros TRANSIENTES/auth antes do 1º chunk (corrida de refresh do
 * token OAuth sob concorrência, 429, rede) são RETENTADOS com backoff via
 * recursão — `attempt` é o contador interno, NÃO passar nas chamadas normais.
 */
export async function* streamClaudeText(
  params: StreamClaudeParams,
  attempt = 1,
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

  // True assim que QUALQUER chunk (raciocínio ou texto) já foi emitido ao cliente
  // nesta tentativa. O retry só dispara com yieldedAny=false — erros de
  // auth/refresh falham no handshake (antes de qualquer texto), então repetir é
  // seguro; se já saiu prosa, NÃO repete (jamais duplica saída).
  let yieldedAny = false;

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
              yieldedAny = true;
              yield THINKING_OPEN;
            }
            yield ev.delta.thinking;
          } else if (ev.delta.type === "text_delta") {
            if (thinkingOpened && !thinkingClosed) {
              thinkingClosed = true;
              yield THINKING_CLOSE;
            }
            yieldedAny = true;
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

    // "Sucesso vazio": o for-await terminou SEM erro, mas o modelo não emitiu
    // NENHUM texto/raciocínio (yieldedAny=false). Lança pro catch tratar como
    // transiente (retry com query fresca) — é a causa silenciosa do "gera dois ao
    // mesmo tempo e um sai em branco" (ver EmptyResultError). Só quando NÃO foi
    // abortado (abort = cancelamento intencional da usuária, não erro).
    if (!yieldedAny && !params.signal?.aborted) {
      throw new EmptyResultError();
    }
  } catch (e) {
    // Retry de erro TRANSIENTE/auth antes de estourar pro usuário (a rota
    // transformaria num "[LOGIN NECESSÁRIO]"/"[ERRO]" e a revisão/escrita morreria
    // mesmo com a usuária logada). Causa nº 1: corrida de refresh do token OAuth
    // quando vários processos `claude` rodam concorrentes — o perdedor leva um 401
    // transiente. Repetir re-lê a credencial já renovada e segue. Só quando NADA
    // foi emitido (yieldedAny=false), não foi cancelado e ainda há tentativa:
    // delega a uma invocação FRESCA (promptInput/query/abortController novos) via
    // yield*. Senão, rethrow → a rota mostra o bloco de login/erro (último recurso).
    const m = e instanceof Error ? e.message : String(e);
    const isEmpty = e instanceof EmptyResultError;
    if (
      !yieldedAny &&
      attempt < MAX_ATTEMPTS &&
      !params.signal?.aborted &&
      (isEmpty || isRetryableClaudeError(m))
    ) {
      console.warn(
        `[claude.ts] tentativa ${attempt}/${MAX_ATTEMPTS} ${
          isEmpty
            ? "retornou VAZIA (result success sem conteúdo)"
            : "falhou (transiente/auth)"
        }, repetindo em backoff: ${m.slice(0, 160)}`,
      );
      await sleepWithSignal(retryBackoffMs(attempt), params.signal);
      // O backoff pode ter terminado cedo porque o usuário CANCELOU — nesse caso
      // NÃO dispare outra tentativa: ela criaria um query() que não observa o
      // abort já disparado (listener pós-abort não re-dispara) e gastaria cota da
      // assinatura compartilhada à toa.
      if (params.signal?.aborted) return;
      yield* streamClaudeText(params, attempt + 1);
      return;
    }
    // Vazio que esgotou as tentativas → erro CLARO (a rota vira [ERRO] recuperável,
    // a roteirista regenera) em vez de devolver string vazia muda, que seria salva
    // como "passo em branco" silencioso. Abort durante o caminho já retornou acima.
    if (isEmpty) {
      if (params.signal?.aborted) return;
      throw new Error(
        `O modelo não retornou conteúdo (resposta vazia após ${MAX_ATTEMPTS} tentativas). Tente gerar de novo.`,
      );
    }
    throw e;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}
