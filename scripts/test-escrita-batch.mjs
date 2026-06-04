// Smoke tests das funções puras do fluxo 2-em-2 do Escrita.
// Roda com: node scripts/test-escrita-batch.mjs
//
// Cobre:
//   - countChaptersInEstrutura — extração de número de capítulos
//   - planBatches              — pareamento respeitando fronteira de Parte
//   - parseEscritaBatch        — parsing do output esperado de um batch

import {
  countChaptersInEstrutura,
  planBatches,
} from "../lib/parse-estrutura-chapters.ts";
import { parseEscritaBatch } from "../lib/parse-escrita-batch.ts";
import {
  extractChapterTargets,
  isWithinTarget,
  targetRange,
} from "../lib/parse-estrutura-targets.ts";

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

console.log("─── countChaptersInEstrutura ───");

eq(countChaptersInEstrutura(""), 0, "vazio → 0");
eq(countChaptersInEstrutura(undefined), 0, "undefined → 0");
eq(
  countChaptersInEstrutura(`# Capítulo 1 — A Chegada\nlorem\n# Capítulo 2 — A Cena\nipsum`),
  2,
  "2 capítulos com h1",
);
eq(
  countChaptersInEstrutura(`## Capítulo 1\n## Capítulo 2\n## Capítulo 3`),
  3,
  "3 capítulos com h2 sem título",
);
eq(
  countChaptersInEstrutura(`### Capitulo 1 — sem til\n### Capitulo 2 — sem til`),
  2,
  "tolera 'Capitulo' sem til",
);
eq(
  countChaptersInEstrutura(`# Capítulo 1\n# Capítulo 1\n# Capítulo 2`),
  2,
  "deduplica número repetido",
);
eq(
  countChaptersInEstrutura(`Texto solto sem cabeçalho.`),
  0,
  "sem cabeçalhos → 0",
);

console.log("\n─── planBatches ───");

// Fallback default (mid de cada Parte): P1=11500/N, P2=13250/N
eq(
  planBatches(6, 5),
  [
    { part: "Parte 1", chapters: [1, 2], totalInPart: 6, batchIndex: 1, targets: [1917, 1917] },
    { part: "Parte 1", chapters: [3, 4], totalInPart: 6, batchIndex: 2, targets: [1917, 1917] },
    { part: "Parte 1", chapters: [5, 6], totalInPart: 6, batchIndex: 3, targets: [1917, 1917] },
    { part: "Parte 2", chapters: [1, 2], totalInPart: 5, batchIndex: 4, targets: [2650, 2650] },
    { part: "Parte 2", chapters: [3, 4], totalInPart: 5, batchIndex: 5, targets: [2650, 2650] },
    { part: "Parte 2", chapters: [5], totalInPart: 5, batchIndex: 6, targets: [2650] },
  ],
  "P1=6, P2=5 → 6 batches com fallbacks (P1=11500/6, P2=13250/5)",
);

eq(
  planBatches(2, 2, [3000, 3500], [4000, 4500]),
  [
    { part: "Parte 1", chapters: [1, 2], totalInPart: 2, batchIndex: 1, targets: [3000, 3500] },
    { part: "Parte 2", chapters: [1, 2], totalInPart: 2, batchIndex: 2, targets: [4000, 4500] },
  ],
  "P1=2, P2=2 com targets explícitos",
);

console.log("\n─── parseEscritaBatch ───");

const sampleBatch = `## Capítulo 1 — A Chegada

A casa surgiu no fim da estrada de terra. Eu apertei o volante.

Era exatamente como na foto.

## Capítulo 2 — O Encontro

Ele estava parado na porta. De braços cruzados.

— Você se atrasou — ele disse, sem tirar os olhos de mim.

═══ SINOPSES ═══
- Cap 1: Lara chega à mansão herdada, primeira impressão de isolamento e mistério. Tom: contemplativo. Cliffhanger: silhueta na janela. ~2.480 palavras.
- Cap 2: Encontro tenso com Damon, primeira fricção. Tom: fricção contida. Cliffhanger: ele segura o pulso dela. ~2.510 palavras.
`;

const parsed = parseEscritaBatch(sampleBatch, "Parte 1");

eq(parsed.chapters.length, 2, "extraiu 2 capítulos");
eq(parsed.chapters[0].number, 1, "cap 1 número");
eq(parsed.chapters[0].title, "A Chegada", "cap 1 título");
eq(parsed.chapters[0].part, "Parte 1", "cap 1 parte");
eq(
  parsed.chapters[0].content.startsWith("A casa surgiu"),
  true,
  "cap 1 conteúdo começa correto",
);
eq(
  parsed.chapters[0].content.includes("Era exatamente como na foto."),
  true,
  "cap 1 inclui linha solta",
);
eq(
  parsed.chapters[0].content.includes("═══ SINOPSES"),
  false,
  "cap 1 NÃO inclui banner de sinopses",
);
eq(parsed.chapters[1].number, 2, "cap 2 número");
eq(parsed.chapters[1].title, "O Encontro", "cap 2 título");
eq(
  parsed.chapters[1].content.endsWith("os olhos de mim."),
  true,
  "cap 2 conteúdo termina antes do banner",
);

eq(parsed.synopses.length, 2, "extraiu 2 sinopses");
eq(parsed.synopses[0].number, 1, "sinopse 1 número");
eq(parsed.synopses[0].part, "Parte 1", "sinopse 1 parte");
eq(
  parsed.synopses[0].synopsis.includes("Lara chega"),
  true,
  "sinopse 1 conteúdo",
);
eq(parsed.synopses[1].number, 2, "sinopse 2 número");

// Caso último batch com 1 cap só
const singleBatch = `## Capítulo 5 — Final da Parte

Texto solo do último capítulo.

═══ SINOPSES ═══
- Cap 5: Fim da Parte 1, hook sutil de transição. Tom: introspectivo. ~2.300 palavras.
`;
const singleParsed = parseEscritaBatch(singleBatch, "Parte 1");
eq(singleParsed.chapters.length, 1, "batch de 1 cap só");
eq(singleParsed.chapters[0].number, 5, "número do único cap");
eq(singleParsed.synopses.length, 1, "sinopse única");

// Caso vazio
eq(parseEscritaBatch("", "Parte 1"), { chapters: [], synopses: [] }, "vazio");

// Caso sem banner SINOPSES (modelo esqueceu) — não quebra
const noSynopses = `## Capítulo 1 — Teste
Conteúdo.
## Capítulo 2 — Teste 2
Mais conteúdo.`;
const noSynParsed = parseEscritaBatch(noSynopses, "Parte 2");
eq(noSynParsed.chapters.length, 2, "sem banner de sinopses → ainda extrai caps");
eq(noSynParsed.synopses.length, 0, "sem banner → sinopses vazias");
eq(noSynParsed.chapters[0].part, "Parte 2", "atribui Parte 2 corretamente");

console.log("\n─── extractChapterTargets ───");

eq(
  extractChapterTargets(`# Capítulo 1 — A Chegada
- Cena 1: foo
- Alvo: ~2.500 palavras

# Capítulo 2 — O Encontro
- Cena: bar
- (2300 palavras)

# Capítulo 3 — Final
- Sem alvo declarado.`),
  [
    { number: 1, target: 2500 },
    { number: 2, target: 2300 },
    { number: 3, target: undefined },
  ],
  "extrai 3 alvos com formatos mistos (~X.XXX, (X), nenhum)",
);

eq(
  extractChapterTargets(`# Capítulo 1
Contagem: 2300-2700 palavras`),
  [{ number: 1, target: 2500 }],
  "faixa A-B → média",
);

eq(
  extractChapterTargets(`# Capítulo 1
Aproximadamente 1800 palavras na cena`),
  [{ number: 1, target: 1800 }],
  "tolera 'aproximadamente'",
);

eq(extractChapterTargets(""), [], "vazio → []");
eq(extractChapterTargets(undefined), [], "undefined → []");

// FORMATO REAL DO PROMPT MESTRE: alvo entre parênteses no header
eq(
  extractChapterTargets(`# 📚 CAPÍTULOS

## Capítulo 1 — A Chegada (~1.380 palavras — ritmo rápido)
[O que acontece + papel ativo da FMC + gancho para o próximo]

## Capítulo 2 — O Anfitrião (~1.610 palavras — ritmo rápido)
[idem]

## Capítulo 3 — O Pacto (~2.070 palavras — ritmo equilibrado)
[idem]

## Capítulo 4 — Compromisso (~2.300 palavras — ritmo equilibrado/intenso)
[idem]

## Capítulo 5 — Resolução (~2.070 palavras — ritmo desenvolvido)
[idem]

## Capítulo 6 — Final (~2.070 palavras — ritmo desenvolvido)
[idem]`),
  [
    { number: 1, target: 1380 },
    { number: 2, target: 1610 },
    { number: 3, target: 2070 },
    { number: 4, target: 2300 },
    { number: 5, target: 2070 },
    { number: 6, target: 2070 },
  ],
  "FORMATO REAL: alvo nos parênteses do header da Parte 1",
);

console.log("\n─── targetRange / isWithinTarget ───");

eq(targetRange(2500), { min: 2425, max: 2575 }, "±3% de 2500");
eq(targetRange(1000), { min: 970, max: 1030 }, "±3% de 1000");
eq(targetRange(500), { min: 470, max: 530 }, "min 30 enforced em alvos pequenos");
eq(isWithinTarget(2450, 2500), true, "2450 dentro de 2500 ±3%");
eq(isWithinTarget(2600, 2500), false, "2600 fora de 2500 ±3%");
eq(isWithinTarget(2575, 2500), true, "limite superior incluso");

console.log(`\n${passed} passed · ${failed} failed`);
if (failed > 0) process.exit(1);
