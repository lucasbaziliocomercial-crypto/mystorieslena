// Golden check do REVISOR — pega regressão de qualidade quando você mexe nos
// prompts do Revisor, SEM regerar histórias do zero (pouca cota da equipe).
//
// Para cada amostra fixa em scripts/golden/*.json, roda SÓ o Revisor (≈1 chamada
// por amostra) num dev server rodando, extrai NOTA + risco de hate + nº de erros,
// salva em scripts/golden/results/<ISO>.json, compara com a rodada anterior e
// imprime a tabela com o Δ. Sai != 0 se a nota cair além do limiar ou o hate
// piorar — pra você segurar o release quando uma mudança de prompt regrediu.
//
// Pré-requisitos (é MANUAL/local — não roda no CI):
//   1. `npm run dev` rodando (ou `npm run electron:dev`), logado na conta Claude.
//   2. Amostras populadas em scripts/golden/*.json (veja scripts/golden/README.md).
//
// Uso:
//   npm run golden                 # roda Parte 1 (revisor1) de cada amostra
//   npm run golden -- --p2         # também roda a Parte 2 (revisor2)
//   GOLDEN_BASE=http://localhost:3001 npm run golden   # outra porta
//
// Roda com Node >= 22 (importa .ts direto, como os outros scripts de teste).

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseRevisorNota,
  parseRevisorHateRisk,
  countMarkdownErrorNumbers,
} from "../lib/parse-revisor-output.ts";
import { countWords } from "../lib/word-count.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "golden");
const RESULTS_DIR = join(GOLDEN_DIR, "results");
const BASE = process.env.GOLDEN_BASE || "http://localhost:3000";
const INCLUDE_P2 = process.argv.includes("--p2");
// Quanto a nota pode cair vs a rodada anterior antes de falhar o check.
const NOTA_DROP_LIMIT = 0.5;
const HATE_ORDER = { "🟢": 0, "🟡": 1, "🔴": 2 };

function loadSamples() {
  let files;
  try {
    files = readdirSync(GOLDEN_DIR).filter(
      (f) => f.endsWith(".json") && f !== "package.json",
    );
  } catch {
    return [];
  }
  const samples = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(GOLDEN_DIR, f), "utf8");
      const data = JSON.parse(raw);
      if (data && data.category && data.outputs) {
        samples.push({ name: f.replace(/\.json$/, ""), ...data });
      } else {
        console.warn(`⚠️  ${f}: faltam campos { category, outputs } — pulando.`);
      }
    } catch (e) {
      console.warn(`⚠️  ${f}: JSON inválido (${e.message}) — pulando.`);
    }
  }
  return samples;
}

function wordsForPart(outputs, partLabel) {
  const chapters = outputs?.escrita?.metadata?.chapters;
  if (Array.isArray(chapters) && chapters.length > 0) {
    const sum = chapters
      .filter((c) => (c.part ?? "Parte 1") === partLabel)
      .reduce((acc, c) => acc + countWords(c.content ?? ""), 0);
    if (sum > 0) return sum;
  }
  return countWords(outputs?.escrita?.content ?? "");
}

async function runRevisor(sample, step) {
  const partLabel = step === "revisor1" ? "Parte 1" : "Parte 2";
  const res = await fetch(`${BASE}/api/agent/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: sample.category,
      previousOutputs: sample.outputs,
      ...(sample.canone ? { canone: sample.canone } : {}),
      leanRevisorReport: true,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${msg.slice(0, 200)}`);
  }
  const content = await res.text();
  if (/\[LOGIN NECESS|\[ERRO\]/.test(content)) {
    throw new Error(
      "resposta sentinela (login/erro) — confira se você está logado na conta Claude.",
    );
  }
  return {
    sample: sample.name,
    category: sample.category,
    step,
    part: partLabel,
    nota: parseRevisorNota(content),
    hate: parseRevisorHateRisk(content),
    errors: countMarkdownErrorNumbers(content),
    words: wordsForPart(sample.outputs, partLabel),
  };
}

function loadPreviousResults() {
  let files;
  try {
    files = readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  try {
    const last = files[files.length - 1];
    return JSON.parse(readFileSync(join(RESULTS_DIR, last), "utf8"));
  } catch {
    return null;
  }
}

function key(r) {
  return `${r.sample}::${r.step}`;
}

function fmtDelta(now, before) {
  if (now == null || before == null) return "";
  const d = now - before;
  if (Math.abs(d) < 0.05) return "  =";
  return d > 0 ? `  ▲+${d.toFixed(1)}` : `  ▼${d.toFixed(1)}`;
}

async function main() {
  const samples = loadSamples();
  if (samples.length === 0) {
    console.error(
      `\n❌ Nenhuma amostra em ${GOLDEN_DIR}.\n` +
        `   Veja scripts/golden/README.md pra adicionar 3-5 histórias boas.\n`,
    );
    process.exit(1);
  }

  console.log(
    `\n🏁 Golden Revisor — ${samples.length} amostra(s), base ${BASE}` +
      `${INCLUDE_P2 ? " (P1+P2)" : " (só P1)"}\n`,
  );

  const steps = INCLUDE_P2 ? ["revisor1", "revisor2"] : ["revisor1"];
  const results = [];
  for (const sample of samples) {
    for (const step of steps) {
      process.stdout.write(`   ${sample.name} · ${step} … `);
      try {
        const r = await runRevisor(sample, step);
        results.push(r);
        console.log(
          `nota ${r.nota ?? "?"} · hate ${r.hate ?? "?"} · ${r.errors} erro(s)`,
        );
      } catch (e) {
        console.log(`ERRO: ${e.message}`);
        results.push({
          sample: sample.name,
          category: sample.category,
          step,
          error: e.message,
        });
      }
    }
  }

  // Compara com a rodada anterior.
  const prev = loadPreviousResults();
  const prevMap = new Map();
  if (prev?.results) for (const r of prev.results) prevMap.set(key(r), r);

  console.log("\n──────── Comparação com a rodada anterior ────────");
  let regressed = false;
  for (const r of results) {
    if (r.error) {
      regressed = true;
      continue;
    }
    const before = prevMap.get(key(r));
    const notaDelta = fmtDelta(r.nota, before?.nota);
    console.log(
      `  ${r.sample} · ${r.step}: nota ${r.nota ?? "?"}${notaDelta}` +
        ` · hate ${r.hate ?? "?"}${before ? ` (antes ${before.hate ?? "?"})` : ""}`,
    );
    if (
      before &&
      typeof r.nota === "number" &&
      typeof before.nota === "number" &&
      before.nota - r.nota >= NOTA_DROP_LIMIT
    ) {
      regressed = true;
      console.log(
        `     ⚠️  REGRESSÃO: nota caiu ${(before.nota - r.nota).toFixed(1)} (limiar ${NOTA_DROP_LIMIT}).`,
      );
    }
    if (
      before &&
      r.hate &&
      before.hate &&
      (HATE_ORDER[r.hate] ?? 0) > (HATE_ORDER[before.hate] ?? 0)
    ) {
      regressed = true;
      console.log(`     ⚠️  REGRESSÃO: risco de hate piorou.`);
    }
  }

  // Grava o resultado desta rodada (append-only por timestamp).
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(RESULTS_DIR, `${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2),
    "utf8",
  );
  console.log(`\n💾 Resultado salvo em ${outFile}`);

  if (regressed) {
    console.error("\n❌ Golden check FALHOU — houve regressão ou erro acima.\n");
    process.exit(1);
  }
  console.log("\n✅ Golden check OK — sem regressão de nota/hate.\n");
}

main().catch((e) => {
  console.error(`\n❌ Falha geral: ${e.message}`);
  if (/fetch failed|ECONNREFUSED/.test(String(e.message))) {
    console.error(
      `   O dev server está rodando em ${BASE}? Rode \`npm run dev\` e logue na conta Claude.\n`,
    );
  }
  process.exit(1);
});
