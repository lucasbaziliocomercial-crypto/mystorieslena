// Testa o dedup de rascunhos repetidos da Estrutura (keepLastChapterRun) — bug
// ROTEIRO 59 (17/07/2026): a Estrutura vinha TRIPLICADA (3 blocos de 6 capítulos
// = 18 headers) com o alvo no header valendo ~1/3 do real. A soma dos 18 parecia
// "na faixa" e o rescale + o piso viravam no-op → a Parte 2 nascia com ~1/3
// (4.758 palavras em vez de ~13.250). Enxergar só o ÚLTIMO run reativa o rescale.
//
// Contrato verificado:
//   • run único → intacto (não mexe em Estrutura normal);
//   • repetido (×2/×3) → devolve só o ÚLTIMO run;
//   • bloco parcial + cheio → devolve o cheio (último);
//   • novo run começa quando number <= anterior; guardas de borda.
//
// Só o keepLastChapterRun é node-testável (puro/dep-free em lib/chapter-runs.ts);
// a integração com splitChapterBlocks/normalizeEstruturaTargets (que importam
// `@/lib/categories`) é coberta por `npm run typecheck`.
//
// Importa o .ts direto (Node ≥ 22 strip-types). Run:
//   node scripts/test-keep-last-chapter-run.mjs
import { keepLastChapterRun } from "../lib/chapter-runs.ts";

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

const B = (nums) => nums.map((n) => ({ number: n, tag: `c${n}` }));
const nums = (blocks) => blocks.map((b) => b.number).join(",");

// ── run único → intacto ────────────────────────────────────────────────────
check(
  "run único (1..6) → intacto",
  nums(keepLastChapterRun(B([1, 2, 3, 4, 5, 6]))) === "1,2,3,4,5,6",
);

// ── triplicado (o bug real do ROTEIRO 59) → último run ─────────────────────
{
  const out = keepLastChapterRun(
    B([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]),
  );
  check("triplicado (1..6 ×3) → 6 blocos", out.length === 6, `len=${out.length}`);
  check("triplicado → sequência 1..6", nums(out) === "1,2,3,4,5,6");
}

// ── duplicado (×2) → segundo run ───────────────────────────────────────────
check(
  "duplicado (1..6 ×2) → último run",
  nums(keepLastChapterRun(B([1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6]))) ===
    "1,2,3,4,5,6",
);

// ── bloco parcial + cheio → devolve o cheio (último run) ───────────────────
check(
  "parcial [1,2,3] + cheio [1..6] → [1..6]",
  nums(keepLastChapterRun(B([1, 2, 3, 1, 2, 3, 4, 5, 6]))) === "1,2,3,4,5,6",
);

// ── pega o CONTEÚDO do último run (não do primeiro) ────────────────────────
{
  const first = [{ number: 1, tag: "velho" }];
  const last = [{ number: 1, tag: "novo" }];
  // sequência: 1(velho), 2, entao 1(novo) inicia novo run
  const input = [first[0], { number: 2, tag: "x" }, last[0]];
  const out = keepLastChapterRun(input);
  check(
    "mantém o ÚLTIMO run (conteúdo 'novo', não 'velho')",
    out.length === 1 && out[0].tag === "novo",
    `out=${JSON.stringify(out)}`,
  );
}

// ── novo run quando number <= anterior (repetição do mesmo número) ─────────
check(
  "número repetido (1,2,2,3) → novo run no 2º '2'",
  nums(keepLastChapterRun(B([1, 2, 2, 3]))) === "2,3",
);

// ── guardas de borda ───────────────────────────────────────────────────────
check("vazio → vazio", keepLastChapterRun([]).length === 0);
check("1 bloco → intacto", keepLastChapterRun(B([1])).length === 1);
check(
  "run único não-começando-em-1 (5,6,7) → intacto",
  nums(keepLastChapterRun(B([5, 6, 7]))) === "5,6,7",
);

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
