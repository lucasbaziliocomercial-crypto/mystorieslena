// Testa a trava DETERMINÍSTICA de DISTRIBUIÇÃO por capítulo da Parte 2
// (lib/balance-chapter-distribution.ts) — o bug "último capítulo de 800
// palavras": a Estrutura P2 declarava um capítulo minúsculo enquanto os outros
// ficavam ~2.300-2.900, a soma seguia na faixa e nada corrigia.
//
// Contrato verificado:
//   • eleva qualquer capítulo abaixo do piso (~2.000) até o piso;
//   • CONSERVA a soma (tira das sobras dos mais longos, proporcional);
//   • idempotente (2ª passada = null);
//   • no-op quando todos já estão no piso;
//   • caso degenerado (vários minúsculos) → reescala proporcional pro alvo.
//
// Importa o .ts direto (Node ≥ 22 strip-types). Run:
//   node scripts/test-normalize-estrutura-distribution.mjs
import {
  enforceMinChapterShare,
  MIN_SHARE_FRAC,
} from "../lib/balance-chapter-distribution.ts";

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

const sum = (a) => a.reduce((x, y) => x + y, 0);
const floorOf = (partTarget, n) =>
  Math.round((partTarget / n) * MIN_SHARE_FRAC);

// ── CASO 1 — o bug real (máfia P2, alvo 13.500) ────────────────────────────
{
  const input = [2450, 2350, 2300, 2700, 2900, 800];
  const partTarget = 13500;
  const floor = floorOf(partTarget, input.length); // 2025
  const out = enforceMinChapterShare(input, partTarget);

  check("caso1: dispara (retorna novo array)", out !== null);
  if (out) {
    check(
      "caso1: soma CONSERVADA (13.500)",
      sum(out) === sum(input),
      `soma=${sum(out)} (esperado ${sum(input)})`,
    );
    check(
      "caso1: nenhum capítulo abaixo do piso",
      Math.min(...out) >= floor,
      `min=${Math.min(...out)} < piso ${floor}`,
    );
    check(
      "caso1: último capítulo subiu de 800 pro piso",
      out[5] >= floor && out[5] > input[5],
      `último=${out[5]} (piso ${floor})`,
    );
    check(
      "caso1: doadores mais longos cederam (2.900 e 2.700 baixaram)",
      out[4] < input[4] && out[3] < input[3],
      `[3]=${out[3]} [4]=${out[4]}`,
    );
    check(
      "caso1: todos inteiros",
      out.every((t) => Number.isInteger(t)),
    );
  }
}

// ── CASO 2 — idempotência (2ª passada não mexe) ────────────────────────────
{
  const input = [2450, 2350, 2300, 2700, 2900, 800];
  const once = enforceMinChapterShare(input, 13500);
  const twice = enforceMinChapterShare(once, 13500);
  check("caso2: 2ª passada é no-op (null)", twice === null);
}

// ── CASO 3 — já equilibrado → no-op ────────────────────────────────────────
{
  const input = [2250, 2250, 2250, 2250, 2250, 2250];
  check(
    "caso3: distribuição uniforme → null",
    enforceMinChapterShare(input, 13500) === null,
  );
}

// ── CASO 4 — todos ACIMA do piso (variação natural) → no-op ────────────────
{
  // floor(13500,6)=2025; todos >= 2025, soma 13.500.
  const input = [2100, 2200, 2300, 2400, 2475, 2025];
  check(
    "caso4: variação natural toda >= piso → null (não achata à toa)",
    enforceMinChapterShare(input, 13500) === null,
    `soma=${sum(input)}`,
  );
}

// ── CASO 5 — outra categoria (milionário-1p, alvo 13.250) ──────────────────
{
  const partTarget = 13250;
  const input = [2300, 2300, 2300, 2300, 2200, 1850]; // soma 13.250; 1850 < piso
  const floor = floorOf(partTarget, input.length); // 1988
  const out = enforceMinChapterShare(input, partTarget);
  check("caso5: dispara p/ alvo 13.250", out !== null);
  if (out) {
    check(
      "caso5: soma conservada (13.250)",
      sum(out) === sum(input),
      `soma=${sum(out)}`,
    );
    check(
      "caso5: último >= piso (1.988)",
      Math.min(...out) >= floor,
      `min=${Math.min(...out)} piso=${floor}`,
    );
  }
}

// ── CASO 6 — DOIS capítulos abaixo do piso ─────────────────────────────────
{
  const input = [1500, 1500, 2625, 2625, 2625, 2625]; // soma 13.500
  const floor = floorOf(13500, 6); // 2025
  const out = enforceMinChapterShare(input, 13500);
  check("caso6: dois curtos → dispara", out !== null);
  if (out) {
    check("caso6: soma conservada", sum(out) === 13500, `soma=${sum(out)}`);
    check(
      "caso6: ambos os curtos sobem ao piso",
      Math.min(...out) >= floor,
      `min=${Math.min(...out)}`,
    );
  }
}

// ── CASO 7 — degenerado (todos minúsculos) → reescala pro alvo ─────────────
{
  const input = [100, 100, 100, 100, 100, 100];
  const out = enforceMinChapterShare(input, 13500);
  check("caso7: degenerado dispara (fallback)", out !== null);
  if (out) {
    check(
      "caso7: fallback reescala pro alvo total (13.500)",
      sum(out) === 13500,
      `soma=${sum(out)}`,
    );
  }
}

// ── CASO 8 — guardas de borda ──────────────────────────────────────────────
{
  check("caso8: array vazio → null", enforceMinChapterShare([], 13500) === null);
  check(
    "caso8: partTarget 0 → null",
    enforceMinChapterShare([2000, 2000], 0) === null,
  );
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
