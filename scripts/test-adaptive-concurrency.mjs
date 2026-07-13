// Trava a decisão de CONCORRÊNCIA ADAPTATIVA À RAM (lib/escrita-calibration.ts).
// Numa máquina fraca (≤6GB, ex.: o Celeron 4GB da roteirista) reduzimos os tetos
// de streams Opus concorrentes — menos pressão de memória = menos queda do socket
// do claude.exe. Máquinas 8GB+ ficam IDÊNTICAS (zero regressão pro time). Fora do
// Electron (web/SSR/build) = sem RAM conhecida → assume máquina normal.
//
// Roda com: node scripts/test-adaptive-concurrency.mjs   (Node ≥ 22)
import {
  isLowMemMachine,
  LOW_MEM_THRESHOLD_MB,
} from "../lib/escrita-calibration.ts";

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

check("limiar espelha o heap adaptativo (6144MB)", LOW_MEM_THRESHOLD_MB === 6144);

// ── MÁQUINA FRACA (≤6GB) → LIGA a redução (≥2 casos) ─────────────────────────
for (const mb of [4096, 3925 /* 3.83GB usável da roteirista */, 2048, 6144 /* fronteira inclusiva */, 6000]) {
  check(`${mb}MB → máquina fraca (reduz)`, isLowMemMachine(mb) === true, String(mb));
}

// ── MÁQUINA NORMAL (>6GB) → NÃO reduz (idêntica ao time) (≥2 casos) ──────────
for (const mb of [6145 /* logo acima da fronteira */, 8192, 16384, 32768]) {
  check(`${mb}MB → máquina normal (sem redução)`, isLowMemMachine(mb) === false, String(mb));
}

// ── DESCONHECIDA (fora do Electron) → assume normal (fail-safe) (≥2 casos) ───
for (const v of [null, undefined, 0, -1, NaN]) {
  check(`RAM ${String(v)} → assume normal`, isLowMemMachine(v) === false, String(v));
}

// ── Mapeamento dos tetos (o que a decisão produz) — documenta o contrato ─────
// Numa máquina fraca: GEN_STREAM_CONCURRENCY=1 (serializa P1‖P2),
// CALIBRATION_CONCURRENCY=2, MAX_CONCURRENT_STREAMS=2. Normal: 2/5/4.
// (Os consts em si leem window no browser; aqui validamos a REGRA de decisão.)
const caps = (mb) =>
  isLowMemMachine(mb)
    ? { gen: 1, calib: 2, jobs: 2 }
    : { gen: 2, calib: 5, jobs: 4 };
check("4GB → gen 1 / calib 2 / jobs 2", JSON.stringify(caps(4096)) === JSON.stringify({ gen: 1, calib: 2, jobs: 2 }));
check("16GB → gen 2 / calib 5 / jobs 4", JSON.stringify(caps(16384)) === JSON.stringify({ gen: 2, calib: 5, jobs: 4 }));

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
