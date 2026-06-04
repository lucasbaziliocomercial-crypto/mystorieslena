// Pega roteiros do JSON descomprimido, passa pela escritaContentToHtml (com o
// fix aplicado em lib/export-html.ts) e cospe HTML pra disco. Pra cada roteiro
// gera 3 arquivos:
//   - <id>-original.html         — escrita como está no localStorage
//   - <id>-mutado-diamante.html  — versão onde ~metade dos ✦ viraram ♦
//   - <id>-baseline-todos-✦.html — versão onde todos os ♦/◆ viraram ✦
//                                  (pra comparar com a mutada e provar que o
//                                  output deve ser EQUIVALENTE)
//
// Se a mutada e a baseline produzem o MESMO destaque verde nos mesmos lugares,
// o fix está funcionando — a tolerância ao ♦ está ativa.

import { readFileSync, writeFileSync } from "node:fs";
import {
  escritaContentToHtml,
  buildEscritaHtmlDocument,
  splitRoteiroByParts,
  detectMaleLeadFromFullRoteiro,
  extractMaleLeadNameFromEstrutura,
} from "../lib/export-html.ts";

const file = process.argv[2];
if (!file) {
  console.error("uso: node export-roteiros.mjs <json-file> [roteiro-id ...]");
  process.exit(1);
}
const targetIds = process.argv.slice(3);

const data = JSON.parse(readFileSync(file, "utf8"));
const roteiros = targetIds.length > 0
  ? data.filter((r) => targetIds.includes(r.id))
  : data.filter((r) => {
      const e = r?.outputs?.escrita;
      const c = typeof e === "string" ? e : e?.content;
      return typeof c === "string" && c.length > 1000;
    });

console.log(`Exportando ${roteiros.length} roteiros...`);

for (const r of roteiros) {
  const e = r?.outputs?.escrita;
  const escritaContent = typeof e === "string" ? e : (e?.content || "");
  if (!escritaContent) continue;

  const estruturaContent =
    r?.outputs?.estrutura1?.content || r?.outputs?.estrutura1 || "";
  const maleLeadFromStructure = extractMaleLeadNameFromEstrutura(
    typeof estruturaContent === "string" ? estruturaContent : estruturaContent?.content || "",
  );
  const maleLead =
    maleLeadFromStructure ?? detectMaleLeadFromFullRoteiro(escritaContent);

  console.log(`\n=== ${r.id} (${r.category}) "${r.title}" ===`);
  console.log(`  MMC detectado: ${maleLead || "(nenhum)"}`);

  // Variante 1 — ORIGINAL (como está no localStorage).
  const html1 = escritaContentToHtml(escritaContent, { maleLeadName: maleLead });
  const doc1 = buildEscritaHtmlDocument(r.title || r.id, html1);
  const f1 = `.\\export-${r.id}-original.html`;
  writeFileSync(f1, doc1, "utf8");
  const greens1 = (doc1.match(/background-color: #d9ead3/g) || []).length;
  console.log(`  → ${f1} (${doc1.length} bytes, ${greens1} spans verdes)`);

  // Variante 2 — MUTADA: troca ~metade dos ✦ por ♦ (BLACK DIAMOND SUIT).
  // Trocamos só metade pra simular o cenário real: alguns markers ficam ✦
  // (highlight funciona) e outros ♦ (precisariam falhar SEM o fix). Com o
  // fix, todos viram destaque igual.
  let n = 0;
  const mutated = escritaContent.replace(/✦/g, (m) => {
    n++;
    return n % 2 === 0 ? "♦" : m;
  });
  const html2 = escritaContentToHtml(mutated, { maleLeadName: maleLead });
  const doc2 = buildEscritaHtmlDocument(r.title || r.id, html2);
  const f2 = `.\\export-${r.id}-mutado-diamante.html`;
  writeFileSync(f2, doc2, "utf8");
  const greens2 = (doc2.match(/background-color: #d9ead3/g) || []).length;
  console.log(`  → ${f2} (${doc2.length} bytes, ${greens2} spans verdes)`);

  // Variante 3 — TUDO ♦ (estresse): todos os ✦ viram ♦.
  const allDiamond = escritaContent.replace(/✦/g, "♦");
  const html3 = escritaContentToHtml(allDiamond, { maleLeadName: maleLead });
  const doc3 = buildEscritaHtmlDocument(r.title || r.id, html3);
  const f3 = `.\\export-${r.id}-todos-diamante.html`;
  writeFileSync(f3, doc3, "utf8");
  const greens3 = (doc3.match(/background-color: #d9ead3/g) || []).length;
  console.log(`  → ${f3} (${doc3.length} bytes, ${greens3} spans verdes)`);

  // Sanity: original e tudo-♦ deveriam ter o MESMO número de spans verdes.
  if (greens1 === greens3) {
    console.log(`  ✓ FIX OK: original (${greens1}) === todos-♦ (${greens3}) — tolerância ativa`);
  } else {
    console.log(`  ✗ DIVERGÊNCIA: original=${greens1}, todos-♦=${greens3} (esperado igual)`);
  }
}
