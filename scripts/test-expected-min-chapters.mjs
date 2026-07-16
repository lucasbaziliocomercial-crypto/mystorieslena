// Testa o piso de capítulos por categoria/Parte (backstop de Estrutura truncada).
// Roda com: node scripts/test-expected-min-chapters.mjs
//
// Cobre:
//   - expectedMinChapters — valores travados por categoria × Parte
//   - a lógica de detecção de truncamento (countChaptersInEstrutura < mínimo)
//     que runEstruturaStep (run-step.ts) usa pra RETENTAR uma Estrutura curta.
//
// Invariante protegido: Parte 2 = SEMPRE 6 nas 4 categorias; Parte 1 = 6
// (milionario-1p, alpha-king) ou 5 (milionario-3p, mafia). Ver CLAUDE.md.

import { expectedMinChapters } from "../lib/expected-min-chapters.ts";

// Contador local de cabeçalhos "## Capítulo N" — espelha countChaptersInEstrutura
// só o suficiente pra exercitar a DECISÃO (count < piso). Não importamos
// parse-estrutura-chapters.ts porque ela tem imports de VALOR via `@/` que o node
// (--experimental-strip-types) não resolve.
function countChaptersInEstrutura(txt) {
  if (!txt) return 0;
  const seen = new Set();
  const re = /^#{0,4}\s*\*{0,2}\s*Cap[ií]tulo\s+(\d+)\b/gim;
  let m;
  while ((m = re.exec(txt)) !== null) seen.add(parseInt(m[1], 10));
  return seen.size;
}

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${e}`);
    console.log(`      actual:   ${a}`);
  }
}

console.log("─── expectedMinChapters (piso por categoria × Parte) ───");

// Parte 2 = SEMPRE 6 nas 4 categorias (invariante travado).
eq(expectedMinChapters("Parte 2", "milionario-1p"), 6, "P2 milionario-1p = 6");
eq(expectedMinChapters("Parte 2", "milionario-3p"), 6, "P2 milionario-3p = 6");
eq(expectedMinChapters("Parte 2", "mafia"), 6, "P2 mafia = 6");
eq(expectedMinChapters("Parte 2", "alpha-king"), 6, "P2 alpha-king = 6");

// Parte 1 = 6 (1p/alpha) ou 5 (3p/mafia — prompts deixam "5 a 6").
eq(expectedMinChapters("Parte 1", "milionario-1p"), 6, "P1 milionario-1p = 6");
eq(expectedMinChapters("Parte 1", "alpha-king"), 6, "P1 alpha-king = 6");
eq(expectedMinChapters("Parte 1", "milionario-3p"), 5, "P1 milionario-3p = 5");
eq(expectedMinChapters("Parte 1", "mafia"), 5, "P1 mafia = 5");

// Default de categoria = milionario-1p.
eq(expectedMinChapters("Parte 1"), 6, "P1 default (milionario-1p) = 6");

console.log("\n─── detecção de truncamento (o que runEstruturaStep decide) ───");

function isTruncated(estrutura, part, category) {
  return countChaptersInEstrutura(estrutura) < expectedMinChapters(part, category);
}

const estrutura6 = Array.from(
  { length: 6 },
  (_, i) => `## Capítulo ${i + 1} — Título ${i + 1} (~2.100 palavras)\nlorem ipsum`,
).join("\n\n");
const estrutura4 = Array.from(
  { length: 4 },
  (_, i) => `## Capítulo ${i + 1} — Título ${i + 1} (~2.100 palavras)\nlorem ipsum`,
).join("\n\n");
const estrutura5 = Array.from(
  { length: 5 },
  (_, i) => `## Capítulo ${i + 1} — Título ${i + 1} (~2.100 palavras)\nlorem ipsum`,
).join("\n\n");

// O bug reportado: P1 milionario-1p com 4 capítulos (socket caiu) → TRUNCADA → retenta.
eq(isTruncated(estrutura4, "Parte 1", "milionario-1p"), true, "P1 1p com 4 caps → truncada (retenta)");
// Estrutura completa (6 caps) → NÃO truncada (passa).
eq(isTruncated(estrutura6, "Parte 1", "milionario-1p"), false, "P1 1p com 6 caps → OK");
// P2 com 5 caps em qualquer categoria → TRUNCADA (P2 é sempre 6).
eq(isTruncated(estrutura5, "Parte 2", "mafia"), true, "P2 mafia com 5 caps → truncada (retenta)");
// P1 5-6: 5 caps na máfia é LEGÍTIMO → NÃO truncada (sem falso-positivo).
eq(isTruncated(estrutura5, "Parte 1", "mafia"), false, "P1 mafia com 5 caps → OK (5-6 legítimo)");
eq(isTruncated(estrutura6, "Parte 1", "milionario-3p"), false, "P1 3p com 6 caps → OK");
eq(isTruncated(estrutura4, "Parte 1", "mafia"), true, "P1 mafia com 4 caps → truncada (abaixo do piso 5)");

console.log(`\n${passed} passaram · ${failed} falharam`);
if (failed > 0) process.exit(1);
