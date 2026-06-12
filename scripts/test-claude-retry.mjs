// Trava o classificador de retry de erros do SDK (lib/claude.ts#isRetryableClaudeError).
// Garante: (a) tudo que a ROTA hoje trata como auth (→ "[LOGIN NECESSÁRIO]") é
// RETENTADO antes (superset do isAuthError da rota); (b) transientes de cota/rede
// também repetem; (c) erros que NÃO se resolvem com retry (binário ausente, prosa,
// vazio) NÃO disparam retry. Defende a correção da corrida de refresh OAuth sob
// concorrência (revisor que morria com vários projetos).
// Roda com: node --experimental-strip-types scripts/test-claude-retry.mjs
import { isRetryableClaudeError } from "../lib/claude.ts";

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

// Regex EXATA da rota (app/api/agent/[step]/route.ts) — mantida em sincronia: todo
// erro que a rota classificaria como auth (bloco de login) DEVE ser retentável.
const ROUTE_AUTH_RE = /authentication|401|invalid auth|unauthorized|credentials/i;
// Regex de binário ausente da rota — NÃO se resolve com retry, não deve repetir.
const ROUTE_BINARY_RE =
  /native binary not found|claude\.exe.*not found|pathToClaudeCodeExecutable/i;

// ── (1) DEVE retentar: corrida de auth/refresh (a causa do bug) ──────────────
const AUTH_MESSAGES = [
  "Claude Agent SDK falhou: 401 Unauthorized",
  "authentication_error: invalid bearer token",
  "invalid auth: token expired",
  "Request failed: unauthorized",
  "OAuth credentials are invalid or expired",
  "401",
];
for (const msg of AUTH_MESSAGES) {
  check(`retenta auth: "${msg.slice(0, 48)}"`, isRetryableClaudeError(msg), msg);
  // Invariante de SUPERSET: se a rota chama de auth, o retry tem que cobrir.
  if (ROUTE_AUTH_RE.test(msg)) {
    check(
      `superset do isAuthError da rota: "${msg.slice(0, 40)}"`,
      isRetryableClaudeError(msg),
      msg,
    );
  }
}

// ── (2) DEVE retentar: cota/sobrecarga + rede (transientes sob concorrência) ──
const TRANSIENT_MESSAGES = [
  "429 Too Many Requests",
  "rate_limit_error: usage limit",
  "rate limit exceeded",
  "Overloaded",
  "server is at capacity",
  "ECONNRESET",
  "socket hang up",
  "fetch failed",
  "network timeout",
  "terminated",
];
for (const msg of TRANSIENT_MESSAGES) {
  check(
    `retenta transiente: "${msg.slice(0, 48)}"`,
    isRetryableClaudeError(msg),
    msg,
  );
}

// ── (3) NÃO deve retentar: não se resolve repetindo ──────────────────────────
const NON_RETRYABLE = [
  "native binary not found", // reinstalar, não repetir
  "claude.exe could not be found", // idem (binário)
  "Erro desconhecido",
  "O agente não retornou nenhum texto. Tente novamente.",
  "A história fala sobre um milionário e sua secretária.", // prosa qualquer
  "",
];
for (const msg of NON_RETRYABLE) {
  check(
    `NÃO retenta: "${msg.slice(0, 48) || "(vazio)"}"`,
    !isRetryableClaudeError(msg),
    msg,
  );
}

// Binário ausente: a rota classifica como binário (não auth); o retry NÃO pode
// pegá-lo (repetir não traz o binário de volta).
check(
  "binário ausente é classificado pela rota como binário, não auth",
  ROUTE_BINARY_RE.test("native binary not found") &&
    !ROUTE_AUTH_RE.test("native binary not found"),
);
check(
  "binário ausente NÃO é retentável",
  !isRetryableClaudeError("native binary not found"),
);

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
