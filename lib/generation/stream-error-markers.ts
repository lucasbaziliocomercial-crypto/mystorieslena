/**
 * Detectores dos MARCADORES DE ERRO que a rota (`app/api/agent/[step]/route.ts`)
 * injeta NO CORPO do stream quando a SDK do Claude falha — com `res.ok=true`,
 * então NÃO dá pra detectar pelo status HTTP. Fonte ÚNICA compartilhada pelos
 * dois motores headless:
 *
 *   • `lib/generation/run-escrita.ts` — geração 2-em-2 (Escrita).
 *   • `lib/generation/run-step.ts`    — chamada única (Estrutura/Revisor/
 *                                       Premissa/Overview/Cânone).
 *
 * Antes só a Escrita tinha essa detecção (inline). A Estrutura/Revisor salvavam o
 * texto com o `[ERRO]` injetado COMO SE FOSSE conteúdo válido (estrutura truncada
 * no meio + a mensagem de erro na prosa) — o bug "socket connection was closed"
 * na máquina fraca da roteirista, que quebrava a contagem de capítulos/palavras
 * downstream. Extrair pra cá deixa os dois motores tratarem os marcadores
 * IDENTICAMENTE. Funções puras, sem DOM/storage — testável por node
 * (`scripts/test-stream-error-markers.mjs`).
 */

/**
 * Marcadores FORTES (login/binário) — nunca aparecem em prosa/estrutura legítima,
 * abortam na hora com a causa real (repetir não resolve: precisa relogar ou
 * reinstalar). A rota os injeta como blocos multi-linha bem definidos.
 */
export const FATAL_STREAM_MARKERS: { marker: string; reason: string }[] = [
  {
    marker: "[LOGIN NECESSÁRIO NO CLAUDE]",
    reason:
      "Login necessário no Claude — sua sessão expirou ou você bateu no limite de uso da assinatura. Faça login novamente (ou aguarde a renovação da cota) e clique em \"Gerar novamente\".",
  },
  {
    marker: "[BINÁRIO CLAUDE NÃO ENCONTRADO]",
    reason:
      "O binário do Claude Code não foi encontrado neste pacote. Reinstale o app pela última versão e tente \"Gerar novamente\".",
  },
];

/** Marcadores FORTES (login/binário) — nunca aparecem em prosa, abortam na hora. */
export function detectHardMarker(text: string): string | null {
  for (const { marker, reason } of FATAL_STREAM_MARKERS) {
    if (text.includes(marker)) return reason;
  }
  return null;
}

/**
 * Marcador genérico `[ERRO] <msg>` — qualquer exceção da SDK que NÃO é
 * login/binário (ex.: limite de uso/cota, queda de socket, erro de servidor).
 * Retorna a causa amigável (ou null se não houver `[ERRO]`).
 */
export function detectErroMarker(text: string): string | null {
  const generic = /\[ERRO\]\s*([\s\S]*)$/.exec(text);
  if (!generic) return null;
  const detail = generic[1]?.trim().slice(0, 300);
  const isQuota = /rate.?limit|quota|usage|limit|429|overloaded|capacity/i.test(
    detail ?? "",
  );
  return isQuota
    ? `Limite de uso da assinatura Claude atingido (ou servidor sobrecarregado). Aguarde alguns minutos e clique em "Gerar novamente". Detalhe: ${detail}`
    : `Erro ao gerar: ${detail || "falha desconhecida na SDK do Claude"}.`;
}

/**
 * `true` quando o `[ERRO]` injetado é de COTA/rate-limit (transiente) — vs um
 * erro genuíno da SDK/binário (fatal). Espelha a heurística `isQuota` interna do
 * `detectErroMarker` (regex idêntica), mas como predicado, pra o chamador
 * decidir RETRY (cota) vs ABORT (resto).
 */
export function isQuotaErroMarker(text: string): boolean {
  const generic = /\[ERRO\]\s*([\s\S]*)$/.exec(text);
  if (!generic) return false;
  const detail = generic[1]?.trim().slice(0, 300) ?? "";
  return /rate.?limit|quota|usage|limit|429|overloaded|capacity/i.test(detail);
}

/**
 * `true` quando o `[ERRO]` injetado é uma QUEDA TRANSIENTE do subprocesso do
 * Claude — o binário/CLI que a SDK spawna (`claude.exe`) morreu no meio da
 * geração ("process exited with code N", SIGKILL/SIGTERM, conexão resetada,
 * `fetch failed`) — vs um erro GENUÍNO de código/SDK (fatal). Login/binário
 * ausente já foram tratados antes (`detectHardMarker`); aqui sobra: cota
 * (`isQuotaErroMarker`), queda transitória (este) ou erro real. A queda é quase
 * sempre instabilidade curta: passa no retry.
 *
 * "socket connection was closed unexpectedly"/"closed unexpectedly": o socket do
 * subprocesso `claude.exe` cai sob PRESSÃO DE MEMÓRIA (máquina fraca) no meio do
 * lote — some quando a máquina tem folga (só aparecia na roteirista, nunca no
 * dev). Roteado pra retry como as outras quedas do subprocesso. Bug 10/07/2026.
 */
export function isTransientErroMarker(text: string): boolean {
  const generic = /\[ERRO\]\s*([\s\S]*)$/.exec(text);
  if (!generic) return false;
  const detail = generic[1]?.trim().slice(0, 300) ?? "";
  return /exited with code|process (?:was )?killed|sigkill|sigterm|econnreset|socket hang ?up|socket connection was closed|closed unexpectedly|fetch failed|network error|terminated unexpectedly/i.test(
    detail,
  );
}
