#!/usr/bin/env node
// Revisão Rigorosa — gate DETERMINÍSTICO das invariantes de produção do MyStoriesLena.
//
// Varre o código-fonte e confirma que as REGRAS FIXAS continuam TRAVADAS no código:
//   • narração/cânone travados na Escrita (prevenção) E no Revisor (detecção), nas 4 categorias
//   • tempo verbal ortogonal à pessoa (seguro até pra milionario-3p)
//   • Parte 2 = exatamente 6 capítulos nas 4 categorias (sem reintroduzir "5 e 6" como contagem)
//   • guard de metadado (sanitize) e a KEY do storage no lugar
//
// É a 1ª linha (estática, instantânea, sem rede, sem cota) da revisão rigorosa.
// O subagente `revisor-rigoroso` roda ESTE script + `npm run typecheck` + `npm test`
// + `node scripts/test-export-html.mjs`, e só então faz a revisão semântica que regex não pega.
//
// Uso:  npm run revisao     (ou)     node scripts/revisao-rigorosa.mjs
// Código de saída: 0 = aprovado · 1 = QUALQUER reprovação.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATS = ["milionario1p", "milionario3p", "mafia", "alphaking"];

let fails = 0;
let warns = 0;
let passes = 0;
const ok = (m) => { passes++; console.log(`  OK   ${m}`); };
const bad = (m) => { fails++; console.log(`  FAIL ${m}`); };
const warn = (m) => { warns++; console.log(`  WARN ${m}`); };

const read = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};
const has = (txt, needle) => txt != null && txt.includes(needle);
// Extrai o CORPO de um `export const NOME = \`...\`` (ignora comentários do arquivo).
const extractTemplate = (txt, name) => {
  if (txt == null) return null;
  const m = txt.match(new RegExp("export const " + name + "\\s*=\\s*`([\\s\\S]*?)`"));
  return m ? m[1] : null;
};

console.log("\n=== REVISÃO RIGOROSA — invariantes de produção (estático) ===\n");

// ── REGRAS 5/6/7: travas na ESCRITA (prevenção) das 4 categorias ──
console.log("[Escrita] cânone de nomes + tempo verbal travados nas 4 categorias");
for (const cat of CATS) {
  const rel = `lib/agents/${cat}/escrita.ts`;
  const t = read(rel);
  if (t == null) { bad(`${rel} NÃO encontrado`); continue; }
  has(t, "CANONE_RULE") ? ok(`${cat}: CANONE_RULE`) : bad(`${cat}: FALTA CANONE_RULE em ${rel}`);
  has(t, "TENSE_RULE") ? ok(`${cat}: TENSE_RULE`) : bad(`${cat}: FALTA TENSE_RULE em ${rel}`);
}

// ── REGRAS 5/6/7: travas no REVISOR (detecção) das 4 categorias ──
console.log("\n[Revisor] checklists de cânone + tempo verbal nas 4 categorias");
for (const cat of CATS) {
  const rel = `lib/agents/${cat}/revisor.ts`;
  const t = read(rel);
  if (t == null) { bad(`${rel} NÃO encontrado`); continue; }
  has(t, "CANONE_REVISOR_CHECKLIST")
    ? ok(`${cat}: CANONE_REVISOR_CHECKLIST`)
    : bad(`${cat}: FALTA CANONE_REVISOR_CHECKLIST em ${rel}`);
  has(t, "TENSE_REVISOR_CHECKLIST")
    ? ok(`${cat}: TENSE_REVISOR_CHECKLIST`)
    : bad(`${cat}: FALTA TENSE_REVISOR_CHECKLIST em ${rel}`);
}

// ── Blocos compartilhados íntegros + tempo verbal ORTOGONAL à pessoa ──
console.log("\n[_shared] blocos compartilhados íntegros");
const canone = read("lib/agents/_shared/canone-rule.ts");
const tense = read("lib/agents/_shared/narration-tense-rule.ts");
has(canone, "CANONE_RULE") && has(canone, "CANONE_REVISOR_CHECKLIST")
  ? ok("canone-rule.ts exporta CANONE_RULE + CANONE_REVISOR_CHECKLIST")
  : bad("canone-rule.ts faltando export(s)");
has(tense, "TENSE_RULE") && has(tense, "TENSE_REVISOR_CHECKLIST")
  ? ok("narration-tense-rule.ts exporta TENSE_RULE + TENSE_REVISOR_CHECKLIST")
  : bad("narration-tense-rule.ts faltando export(s)");
// REGRA 7: o CORPO das regras de tempo verbal NÃO pode citar pessoa gramatical
// (senão quebra a milionario-3p). Checa só as strings exportadas, não os comentários.
{
  const corpo = [extractTemplate(tense, "TENSE_RULE"), extractTemplate(tense, "TENSE_REVISOR_CHECKLIST")]
    .filter(Boolean)
    .join("\n");
  if (!corpo) {
    bad("narration-tense-rule.ts: não consegui extrair TENSE_RULE/TENSE_REVISOR_CHECKLIST");
  } else {
    /primeira pessoa|terceira pessoa|1ª pessoa|3ª pessoa|\bFMC\b|\bMMC\b/i.test(corpo)
      ? bad("regra de tempo verbal cita pessoa gramatical — quebra a ortogonalidade (vale tb p/ milionario-3p)")
      : ok("tempo verbal ortogonal à pessoa (corpo não cita 1ª/3ª pessoa)");
  }
}

// ── REGRA 4: Parte 2 = exatamente 6 capítulos nas 4 categorias ──
console.log("\n[Estrutura P2] exatamente 6 capítulos nas 4 categorias");
// Padrões PROIBIDOS = contagem "5 e 6 / 5-6 / 5 a 6 / 5 ou 6 / máximo 6" na P2.
// Propositalmente NÃO casa o "caps 5 e 6" solto (bloco final de ritmo, legítimo).
const PROIBIDO_P2 = [
  /entre\s+5\s+e\s+6/i,
  /\b5\s*-\s*6\s+cap/i,
  /\b5\s+a\s+6\s+cap/i,
  /\b5\s+ou\s+6\s+cap/i,
  /m[áa]ximo\s+(de\s+)?6\s+cap/i,
  /entre\s+cinco\s+e\s+seis/i,
];
for (const cat of CATS) {
  const rel = `lib/agents/${cat}/estrutura2-prompt.ts`;
  const t = read(rel);
  if (t == null) { bad(`${rel} NÃO encontrado`); continue; }
  /exatamente\s+6|exatamente\s+seis/i.test(t)
    ? ok(`${cat}: trava "exatamente 6" presente`)
    : bad(`${cat}: FALTA a trava "exatamente 6" em ${rel}`);
  const proib = PROIBIDO_P2.find((re) => re.test(t));
  if (proib) bad(`${cat}: contagem PROIBIDA na P2 (regex ${proib}) em ${rel}`);
}

// ── REGRA 2: nada de metadado na prosa final (guard no código) ──
console.log("\n[Prosa final] guard de sanitização no lugar");
existsSync(join(ROOT, "lib/sanitize-escrita-content.ts"))
  ? ok("lib/sanitize-escrita-content.ts presente")
  : bad("lib/sanitize-escrita-content.ts SUMIU — risco de metadado/contagem vazar na prosa");

// ── Storage: KEY veludo:roteiros jamais renomeada ──
console.log("\n[Storage] KEY veludo:roteiros intacta");
has(read("lib/storage.ts"), "veludo:roteiros")
  ? ok("KEY veludo:roteiros intacta em lib/storage.ts")
  : bad("KEY veludo:roteiros NÃO encontrada em lib/storage.ts — NUNCA renomear");

// ── countWords única fonte: aviso brando (split de nome != contagem; semântico fica c/ o subagente) ──
console.log("\n[Contagem] countWords como única fonte");
const wc = read("lib/word-count.ts");
wc && has(wc, "export") && /countWords/.test(wc)
  ? ok("lib/word-count.ts exporta countWords")
  : warn("lib/word-count.ts: confirmar manualmente que countWords segue como única fonte");

// ── Word-count guard: normalize LÊ e REESCREVE o alvo pelo HEADER (header-first) ──
// Bug 12/06/2026 "normalize infla a Estrutura": o LEITOR (extractTargetFromBlock) e o
// ESCRITOR (rewriteTargetInBlock) PRECISAM concordar que o alvo do capítulo vive no
// HEADER (1ª linha). Se um deles voltar a varrer o CORPO primeiro, uma faixa de
// sub-cena do trecho ✦ ("237-297 palavras") é lida/reescrita como alvo e o normalize
// reescala a estrutura inteira PRA CIMA (totais estouram a faixa da Parte). Trava as
// duas pontas em sincronia — ver `target_capitulo_vem_do_header` na memória.
console.log("\n[Word-count] normalize header-first (leitor + escritor em sincronia)");
{
  const windowAfter = (txt, decl, n = 700) => {
    if (txt == null) return "";
    const i = txt.indexOf(decl);
    return i === -1 ? "" : txt.slice(i, i + n);
  };
  const NL = 'indexOf("\\n")';
  // LEITOR: extractTargetFromBlock deve ler o header (1ª linha) ANTES do corpo.
  const rdr = windowAfter(read("lib/parse-estrutura-targets.ts"), "function extractTargetFromBlock(");
  rdr.includes(NL) && /extractTargetFromText\(\s*header\s*\)/.test(rdr)
    ? ok("leitor extractTargetFromBlock é header-first")
    : bad("lib/parse-estrutura-targets.ts: extractTargetFromBlock NÃO é header-first (faixa de sub-cena pode sequestrar o alvo)");
  // ESCRITOR: rewriteTargetInBlock deve reescrever o header ANTES do fallback pro corpo.
  const norm = read("lib/normalize-estrutura-targets.ts");
  const wtr = windowAfter(norm, "function rewriteTargetInBlock(");
  wtr.includes(NL) && /rewriteTargetInText\(\s*header\s*,/.test(wtr)
    ? ok("escritor rewriteTargetInBlock é header-first")
    : bad("lib/normalize-estrutura-targets.ts: rewriteTargetInBlock NÃO é header-first (reescreve a faixa de sub-cena em vez do header → estrutura infla)");
  // Rodapé-resumo ("Soma das contagens declaradas: …") sincronizado no reescalonamento
  // (pedido da roteirista 12/06): sem isso a linha volta a mostrar a soma velha e confunde.
  norm && /function rewriteFooterSum\(/.test(norm) && /rewriteFooterSum\(\s*newText/.test(norm)
    ? ok("rodapé-resumo sincronizado no reescalonamento (rewriteFooterSum)")
    : bad("lib/normalize-estrutura-targets.ts: rewriteFooterSum sumiu/não é chamado no reescalonamento (rodapé volta a confundir)");
}

// ── Veredito ──
console.log(`\n${"-".repeat(60)}`);
console.log(`Resultado estático: ${passes} OK · ${warns} avisos · ${fails} reprovações`);
if (fails > 0) {
  console.log("\nREVISÃO RIGOROSA (estática): REPROVADA — corrija os FAIL acima.");
  console.log("Rode também: npm run typecheck · npm test · node scripts/test-export-html.mjs");
  process.exit(1);
}
console.log("\nREVISÃO RIGOROSA (estática): APROVADA.");
console.log("Próximo (gates dinâmicos): npm run typecheck · npm test · node scripts/test-export-html.mjs");
process.exit(0);
