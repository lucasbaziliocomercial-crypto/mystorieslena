// Trava os detectores COMPARTILHADOS de marcador de erro injetado no stream
// (lib/generation/stream-error-markers.ts) — a fonte única que o motor de
// chamada única (run-step.ts: Estrutura/Revisor/Premissa/Overview/Cânone) e o
// motor da Escrita (run-escrita.ts) usam pra decidir RETRY (socket caído/cota)
// vs ABORT (login/binário/erro genuíno).
//
// PROBLEMA #1 (socket na Estrutura): a queda "socket connection was closed
// unexpectedly" na máquina fraca da roteirista, injetada como [ERRO] no corpo do
// stream, precisa ser classificada como TRANSIENTE pra Estrutura RETENTAR em vez
// de salvar a estrutura truncada. 2+ casos por classe.
//
// Roda com: node scripts/test-stream-error-markers.mjs   (Node ≥ 22)
import {
  detectHardMarker,
  detectErroMarker,
  isQuotaErroMarker,
  isTransientErroMarker,
} from "../lib/generation/stream-error-markers.ts";

let pass = 0;
let fail = 0;
function check(name, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`✅ PASS  ${name}`);
  } else {
    fail++;
    console.log(`❌ FAIL  ${name}  ${detail}`);
  }
}

// Forma EXATA que a rota injeta: "\n\n[ERRO] <msg>" ao fim do stream.
const inject = (msg) => `## Capítulo 3 — O corvo\n\nProsa qualquer.\n\n[ERRO] ${msg}`;

// ── (1) SOCKET CAÍDO = TRANSIENTE (retenta) — o bug da roteirista, 2 formas ──
const SOCKET_CASES = [
  "Claude Code returned an error result: API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
  "The socket connection was closed unexpectedly",
];
for (const msg of SOCKET_CASES) {
  const text = inject(msg);
  check(`socket → transiente: "${msg.slice(0, 44)}"`, isTransientErroMarker(text), msg);
  check(`socket → NÃO cota: "${msg.slice(0, 44)}"`, !isQuotaErroMarker(text), msg);
  check(`socket → NÃO hard: "${msg.slice(0, 44)}"`, detectHardMarker(text) === null, msg);
}

// ── (2) OUTRAS QUEDAS TRANSIENTES do subprocesso (≥2 casos) ──────────────────
for (const msg of [
  "Claude Code process exited with code 3",
  "read ECONNRESET",
  "socket hang up",
  "fetch failed",
]) {
  check(`transiente: "${msg}"`, isTransientErroMarker(inject(msg)), msg);
}

// ── (3) COTA/rate-limit = transiente de cota (≥2 casos) ──────────────────────
for (const msg of [
  "429 Too Many Requests",
  "rate_limit_error: usage limit reached",
  "Overloaded",
]) {
  const text = inject(msg);
  check(`cota: "${msg}"`, isQuotaErroMarker(text), msg);
  // Cota NÃO deve ser classificada como queda transiente de subprocesso.
  check(`cota ≠ subprocesso: "${msg}"`, !isTransientErroMarker(text), msg);
}

// ── (4) HARD (login/binário) = FATAL, propaga com a causa (≥2 casos) ─────────
check(
  "login → hard reason",
  typeof detectHardMarker("prosa\n\n[LOGIN NECESSÁRIO NO CLAUDE]\n\nfaça login") ===
    "string",
);
check(
  "binário → hard reason",
  typeof detectHardMarker("[BINÁRIO CLAUDE NÃO ENCONTRADO]\n\nreinstale") === "string",
);

// ── (5) ERRO GENUÍNO da SDK = FATAL, NÃO retenta (≥2 casos) ──────────────────
for (const msg of [
  "TypeError: cannot read properties of undefined",
  "Invalid request: malformed JSON schema",
]) {
  const text = inject(msg);
  check(`genuíno → NÃO transiente: "${msg.slice(0, 40)}"`, !isTransientErroMarker(text), msg);
  check(`genuíno → NÃO cota: "${msg.slice(0, 40)}"`, !isQuotaErroMarker(text), msg);
  check(`genuíno → detectErroMarker dá mensagem: "${msg.slice(0, 40)}"`, !!detectErroMarker(text), msg);
}

// ── (6) SEM marcador (estrutura/prosa legítima) = nada dispara ───────────────
const CLEAN = [
  "## Capítulo 1 — Início (~2.400 palavras)\n\nEla abriu a porta.",
  "O detetive resolveu o erro do caso sem drama nenhum.", // "erro" no meio da prosa
  "",
];
for (const text of CLEAN) {
  check(`limpo → sem hard: "${text.slice(0, 36) || "(vazio)"}"`, detectHardMarker(text) === null, text);
  check(`limpo → sem transiente: "${text.slice(0, 36) || "(vazio)"}"`, !isTransientErroMarker(text), text);
  check(`limpo → sem cota: "${text.slice(0, 36) || "(vazio)"}"`, !isQuotaErroMarker(text), text);
  check(`limpo → detectErroMarker null: "${text.slice(0, 36) || "(vazio)"}"`, detectErroMarker(text) === null, text);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
