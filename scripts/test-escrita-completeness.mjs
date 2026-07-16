// Testa findIncompleteProblems — o guard que impede a Escrita de entregar um
// roteiro CURTO em silêncio (capítulo faltando OU soma abaixo do piso da faixa).
// Roda com: node scripts/test-escrita-completeness.mjs
//
// Invariante protegido (escolha da roteirista 16/07/2026): bloquear e pedir
// "Continuar geração" em vez de marcar "pronto" um roteiro incompleto/curto.

import { findIncompleteProblems } from "../lib/escrita-completeness.ts";

let passed = 0;
let failed = 0;

function check(label, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

// Helper: monta uma Parte "saudável" (todos os caps, soma na faixa) e permite override.
function part(over = {}) {
  return {
    part: "Parte 1",
    gotChapters: 6,
    expectedChapters: 6,
    words: 12500,
    minWords: 12000,
    ...over,
  };
}

console.log("─── findIncompleteProblems ───");

// Roteiro saudável (2 Partes completas, soma na faixa) → SEM problemas.
check(
  "roteiro saudável (6+6 caps, soma na faixa) → sem problemas",
  findIncompleteProblems([
    part(),
    part({ part: "Parte 2", words: 13250, minWords: 13000 }),
  ]).length === 0,
);

// Parte vazia (0 capítulos).
check(
  "Parte vazia (0 caps) → bloqueia",
  findIncompleteProblems([part({ gotChapters: 0 })]).some((m) =>
    m.includes("vazia"),
  ),
);

// Capítulo faltando (4 de 6) — o caso da roteirista (lote largado por cota).
check(
  "4 de 6 caps → bloqueia (incompleta)",
  findIncompleteProblems([part({ gotChapters: 4 })]).some((m) =>
    m.includes("4 de 6"),
  ),
);

// Todos os caps presentes, mas soma ABAIXO do piso (calibração/balanço falhou).
check(
  "6 de 6 caps mas soma 8958 < 12000 → bloqueia (contagem mínima)",
  findIncompleteProblems([part({ words: 8958 })]).some((m) =>
    m.includes("abaixo da contagem mínima"),
  ),
);

// Soma EXATAMENTE no piso → OK (não bloqueia).
check(
  "soma == piso → OK",
  findIncompleteProblems([part({ words: 12000 })]).length === 0,
);

// Soma ACIMA do teto NÃO é "incompleto" (longo é outro problema, não bloqueia aqui).
check(
  "soma acima do teto → NÃO bloqueia (não é 'faltando')",
  findIncompleteProblems([part({ words: 14000, minWords: 12000 })]).length === 0,
);

// Parte não declarada na Estrutura (expectedChapters=0) → ignorada.
check(
  "expectedChapters=0 → Parte ignorada",
  findIncompleteProblems([part({ expectedChapters: 0, gotChapters: 0, words: 0 })])
    .length === 0,
);

// Duas Partes com problemas distintos → reporta as duas.
check(
  "P1 incompleta + P2 curta → 2 problemas",
  findIncompleteProblems([
    part({ part: "Parte 1", gotChapters: 5 }),
    part({ part: "Parte 2", words: 9000, minWords: 13000 }),
  ]).length === 2,
);

// minWords=0 (faixa desconhecida) → não bloqueia por contagem.
check(
  "minWords=0 → não bloqueia por soma",
  findIncompleteProblems([part({ words: 10, minWords: 0 })]).length === 0,
);

console.log(`\n${passed} passaram · ${failed} falharam`);
if (failed > 0) process.exit(1);
