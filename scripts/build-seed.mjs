// Junta todos os roteiros das 2 origens (dev localhost:3000 + packaged
// 127.0.0.1:17310) num único array deduplicado por id. Salva o resultado
// em public/dev-roteiros.json pra ser servido pelo Next dev.
//
// O seed.html em public/dev-seed.html lê esse JSON e injeta no localStorage
// do localhost:3000 (onde o npm run dev fica), redireciona pra "/" — pronto
// pra testar.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const sources = [
  "./roteiros-_http___localhost_3000__veludo_roteiros.json",
  "./roteiros-_http___127_0_0_1_17310__veludo_roteiros.json",
];

const seen = new Map(); // id -> roteiro (mais recente vence)
let total = 0;
for (const src of sources) {
  const arr = JSON.parse(readFileSync(src, "utf8"));
  for (const r of arr) {
    total++;
    const existing = seen.get(r.id);
    if (!existing) {
      seen.set(r.id, r);
      continue;
    }
    // Compara updatedAt — fica com o mais recente.
    const aT = new Date(existing.updatedAt || existing.createdAt || 0).getTime();
    const bT = new Date(r.updatedAt || r.createdAt || 0).getTime();
    if (bT > aT) seen.set(r.id, r);
  }
}

const merged = [...seen.values()].sort((a, b) => {
  const aT = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const bT = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return bT - aT;
});

console.log(`Lidas ${total} entradas, ${merged.length} únicas após dedup.`);
console.log("Roteiros (mais recente primeiro):");
for (const r of merged) {
  const e = r?.outputs?.escrita;
  const c = typeof e === "string" ? e : e?.content || "";
  console.log(`  - ${r.id} | ${r.category} | ${(c.length / 1000).toFixed(0)}KB | ${r.title}`);
}

mkdirSync("../public", { recursive: true });
writeFileSync("../public/dev-roteiros.json", JSON.stringify(merged), "utf8");
const sizeMB = (JSON.stringify(merged).length / 1024 / 1024).toFixed(1);
console.log(`\nSalvo em public/dev-roteiros.json (${sizeMB} MB).`);
