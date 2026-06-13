// Trava do round-trip da chave lateral de `history` (lib/storage.ts).
//
// O `history` (~55% da biblioteca) foi movido do blob quente `veludo:roteiros`
// pra chaves laterais `veludo:history:<id>` (mesmo padrão da imagem de referência)
// pra os saves do streaming pararem de re-comprimir 9 MB na main thread a cada
// ~2,5 s — era isso que travava o app com vários roteiros gerando ao mesmo tempo.
//
// Este teste é PURO (não importa storage.ts, que puxa `window`/aliases `@/`):
// replica a codificação de `stripHistory` (LZ1:+compressToUTF16(JSON.stringify))
// e a decodificação de `hydrateHistory` (parse com degradação a undefined em
// falha — NUNCA lança, NUNCA perde o roteiro), e confirma:
//   • round-trip exato de um history realista (travessões/acentos da prosa);
//   • chave corrompida / ausente → history undefined, SEM throw (auto-cura);
//   • history vazio / multi-step round-trips.
//
// Run: node scripts/test-history-sidekey-roundtrip.mjs   (Node ≥ 22)
import lzString from "lz-string";

const { compressToUTF16, decompressFromUTF16 } = lzString;

// Espelha COMPRESSED_PREFIX de lib/storage.ts. Se mudar lá, muda aqui.
const COMPRESSED_PREFIX = "LZ1:";

/** Espelha o ramo "mudou" de `stripHistory`: comprime o history pra a chave lateral. */
function encodeHistory(history) {
  return COMPRESSED_PREFIX + compressToUTF16(JSON.stringify(history));
}

/**
 * Espelha a leitura de `hydrateHistory`: descomprime+parseia o valor da chave
 * lateral; QUALQUER falha (descompressão nula, JSON inválido) degrada pra
 * `undefined` SEM lançar (auto-cura: o próximo strip limpa a chave órfã).
 * `raw === null` (chave ausente) também → undefined.
 */
function decodeHistory(raw) {
  if (raw == null) return undefined;
  try {
    const json = raw.startsWith(COMPRESSED_PREFIX)
      ? (decompressFromUTF16(raw.slice(COMPRESSED_PREFIX.length)) ?? "")
      : raw;
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── History realista: pilhas cap-2 por step, com a prosa cheia de travessões ──
const proseSnap = (id, n) => ({
  id,
  savedAt: "2026-06-13T20:55:49.301Z",
  content: ("— Boa tarde. — Ele sorriu, e eu senti o chão sumir.\n".repeat(n)),
  metadata: {
    chapters: Array.from({ length: 6 }, (_, i) => ({
      number: i + 1,
      part: i < 3 ? "Parte 1" : "Parte 2",
      title: `Capítulo ${i + 1} — Não é o que parece`,
      content: ("Çãéíõ — diálogo, travessão, aspas “curvas”. ".repeat(n)),
      generatedAt: "2026-06-13T20:00:00.000Z",
    })),
  },
  label: "v1",
});

const realisticHistory = {
  escrita: [proseSnap("snap_a", 400), proseSnap("snap_b", 350)],
  revisor1: [{ id: "snap_r", savedAt: "2026-06-13T21:00:00.000Z", content: "NOTA FINAL (0 a 10): 9,1\n".repeat(50) }],
};

// CASE 0: round-trip exato de um history realista.
{
  const back = decodeHistory(encodeHistory(realisticHistory));
  check("CASE 0: round-trip de history realista é deep-equal", eq(back, realisticHistory));
}

// CASE 1: history multi-step com pilha de 2 snapshots round-trips.
{
  const h = { escrita: [proseSnap("x", 5), proseSnap("y", 7)], estrutura1: [proseSnap("z", 3)] };
  const back = decodeHistory(encodeHistory(h));
  check("CASE 1: multi-step cap-2 round-trips", eq(back, h));
}

// CASE 2: chave CORROMPIDA (LZ1: + lixo) → undefined, SEM throw.
{
  let threw = false;
  let out;
  try {
    out = decodeHistory(COMPRESSED_PREFIX + "?lixo-não-descomprime?");
  } catch {
    threw = true;
  }
  check("CASE 2: chave corrompida não lança", !threw);
  check("CASE 2: chave corrompida degrada pra undefined", out === undefined, `out=${JSON.stringify(out)}`);
}

// CASE 3: JSON inválido após descompressão válida → undefined, SEM throw.
{
  const raw = COMPRESSED_PREFIX + compressToUTF16("isto não é json {");
  let threw = false;
  let out;
  try {
    out = decodeHistory(raw);
  } catch {
    threw = true;
  }
  check("CASE 3: JSON inválido não lança", !threw);
  check("CASE 3: JSON inválido degrada pra undefined", out === undefined);
}

// CASE 4: chave AUSENTE (raw null) → undefined.
{
  check("CASE 4: chave ausente (null) → undefined", decodeHistory(null) === undefined);
}

// CASE 5: history com objeto vazio `{}` round-trips como `{}` (não vira undefined).
{
  const back = decodeHistory(encodeHistory({}));
  check("CASE 5: history {} round-trips como {}", eq(back, {}));
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
