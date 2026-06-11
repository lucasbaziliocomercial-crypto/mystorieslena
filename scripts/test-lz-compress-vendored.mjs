// Trava de drift do compressor lz-string VENDORIZADO que roda no Web Worker de
// compressão (lib/lz-compress-worker-source.ts). O worker usa uma cópia verbatim
// do `_compress` do lz-string; este teste constrói essa cópia via `new Function`
// e confirma que a saída é BYTE-IDÊNTICA ao `compressToUTF16` do npm, e que o
// `decompressFromUTF16` do npm faz o round-trip. Se alguém editar a cópia e ela
// divergir, o app gravaria blobs que a leitura não descomprime → este teste pega.
//
// Run: node --experimental-strip-types scripts/test-lz-compress-vendored.mjs
import { COMPRESS_FN_SOURCE } from "../lib/lz-compress-worker-source.ts";
import lzString from "lz-string";

const { compressToUTF16: npmCompress, decompressFromUTF16: npmDecompress } =
  lzString;

// Constrói o compressToUTF16 VENDORIZADO (mesmo código que vai pro worker), sem
// instanciar um Worker. Retorna já com o prefixo "LZ1:".
const vendoredCompress = new Function(
  `${COMPRESS_FN_SOURCE}\nreturn compressToUTF16;`,
)();

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

const cases = [
  "",
  "a",
  "Olá, mundo! — travessão e acentuação çãé.",
  JSON.stringify({ id: "r_1", outputs: { escrita: { content: "x".repeat(5000) } } }),
  JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({
      id: `r_${i}`,
      title: `Roteiro ${i} — Máfia`,
      body: "Lorem ipsê — diálogo: — Boa tarde. ".repeat(200),
    })),
  ),
];

for (let i = 0; i < cases.length; i++) {
  const json = cases[i];
  const vend = vendoredCompress(json);
  const expected = "LZ1:" + npmCompress(json);
  check(
    `CASE ${i}: vendorizado === "LZ1:" + npm.compressToUTF16 (len ${json.length})`,
    vend === expected,
    `vend.len=${vend.length} expected.len=${expected.length}`,
  );
  // Round-trip: tira o prefixo "LZ1:" e descomprime com o npm.
  const back = npmDecompress(vend.slice(4));
  check(
    `CASE ${i}: round-trip decompress === original`,
    back === json,
    `back.len=${back == null ? "null" : back.length} orig.len=${json.length}`,
  );
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
