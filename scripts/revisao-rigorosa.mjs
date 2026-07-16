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

// ── POV da Parte 2: marcador ✦ batendo com quem narra (Escrita + Revisor) ──
// Bug 13/06/2026 (testes LENA/máfia + Selena/alpha-king): "muita troca de POV ou
// colocação de POV errado na Parte 2" — `✦ OSRIC` (masculino) sobre bloco da
// heroína, voz trocando no meio da cena íntima sem marcador. Trava nas DUAS
// camadas, igual a cânone/tempo verbal. SÓ nas 3 categorias com POV alternado
// (milionario-3p é onisciente e PROÍBE ✦ — por isso fica de fora de propósito).
console.log("\n[POV Parte 2] marcador ✦ travado na Escrita + Revisor (3 categorias com POV alternado)");
const POV_CATS = ["milionario1p", "mafia", "alphaking"];
for (const cat of POV_CATS) {
  const e = read(`lib/agents/${cat}/escrita.ts`);
  has(e, "POV_MARKER_RULE")
    ? ok(`${cat}: POV_MARKER_RULE na Escrita`)
    : bad(`${cat}: FALTA POV_MARKER_RULE em lib/agents/${cat}/escrita.ts`);
  const r = read(`lib/agents/${cat}/revisor.ts`);
  has(r, "POV_MARKER_REVISOR_CHECKLIST")
    ? ok(`${cat}: POV_MARKER_REVISOR_CHECKLIST no Revisor`)
    : bad(`${cat}: FALTA POV_MARKER_REVISOR_CHECKLIST em lib/agents/${cat}/revisor.ts`);
}
const pov = read("lib/agents/_shared/pov-marker-rule.ts");
has(pov, "POV_MARKER_RULE") && has(pov, "POV_MARKER_REVISOR_CHECKLIST")
  ? ok("pov-marker-rule.ts exporta POV_MARKER_RULE + POV_MARKER_REVISOR_CHECKLIST")
  : bad("pov-marker-rule.ts faltando export(s)");
// milionario-3p NÃO pode receber o bloco de marcador (ele proíbe ✦ — onisciente).
has(read("lib/agents/milionario3p/escrita.ts"), "POV_MARKER_RULE") ||
has(read("lib/agents/milionario3p/revisor.ts"), "POV_MARKER_REVISOR_CHECKLIST")
  ? bad("milionario3p recebeu o bloco de marcador ✦ — ela é onisciente e PROÍBE ✦; remova")
  : ok("milionario3p sem o bloco de marcador ✦ (correto — é onisciente, proíbe ✦)");

// ── NARRAÇÃO LIMITADA (não-onisciência) + FIDELIDADE À PREMISSA ──
// Bug 29/06/2026: nota despencando na revisão, principalmente na PARTE 1, com
// erros 💀/🔴 de ONISCIÊNCIA em 1ª pessoa (nomear antes de apresentar, cravar a
// mente do outro, ler a tela do celular dele, info-dump) + caso extremo de
// Parte 1 TODA fora do cânone da premissa (chefe da máfia virou herdeiro de
// hotelaria). Travado nas 3 categorias de 1ª pessoa (máfia + alpha-king em
// 1.1.1; milionário-1p em 1.1.3, pq o inline dele ainda escorregava — ex.: Kai
// com "Maelle lê o celular do Torin"). milionário-3p fica de FORA de propósito:
// é 3ª pessoa e a Parte 2 é ONISCIENTE — a regra de 1ª pessoa quebraria isso;
// ele já tem a trava própria (P1 limitada à FMC). Trava nas DUAS camadas.
console.log("\n[Narração limitada + fidelidade à premissa] travado na Escrita + Revisor (3 categorias de 1ª pessoa)");
const KNOWLEDGE_CATS = ["mafia", "alphaking", "milionario1p"];
for (const cat of KNOWLEDGE_CATS) {
  const e = read(`lib/agents/${cat}/escrita.ts`);
  has(e, "NARRATOR_KNOWLEDGE_RULE")
    ? ok(`${cat}: NARRATOR_KNOWLEDGE_RULE na Escrita`)
    : bad(`${cat}: FALTA NARRATOR_KNOWLEDGE_RULE em lib/agents/${cat}/escrita.ts`);
  const r = read(`lib/agents/${cat}/revisor.ts`);
  has(r, "NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST")
    ? ok(`${cat}: NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST no Revisor`)
    : bad(`${cat}: FALTA NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST em lib/agents/${cat}/revisor.ts`);
}
// milionário-3p NÃO pode receber o bloco de 1ª pessoa (é 3ª pessoa, P2 onisciente).
has(read("lib/agents/milionario3p/escrita.ts"), "NARRATOR_KNOWLEDGE_RULE") ||
has(read("lib/agents/milionario3p/revisor.ts"), "NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST")
  ? bad("milionario3p recebeu o bloco de não-onisciência de 1ª pessoa — ele é 3ª pessoa/P2 onisciente; remova")
  : ok("milionario3p sem o bloco de 1ª pessoa (correto — 3ª pessoa, P2 onisciente, trava própria inline)");
const know = read("lib/agents/_shared/narrator-knowledge-rule.ts");
has(know, "NARRATOR_KNOWLEDGE_RULE") && has(know, "NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST")
  ? ok("narrator-knowledge-rule.ts exporta NARRATOR_KNOWLEDGE_RULE + NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST")
  : bad("narrator-knowledge-rule.ts faltando export(s)");

// ── CONTINUIDADE NAS JUNÇÕES (callback fiel + conhecimento rastreável) ──
// Bug 08/07/2026: enxurrada de graves/gravíssimos concentrados nas JUNÇÕES —
// callback reconstruído de memória (objeto muda de cor/tipo, dia da semana muda,
// escada/lugar errado no epílogo, fala-chave repetida), personagem age sobre
// info que ninguém lhe contou, fio de trama plantado e abandonado. Regra ADITIVA
// e ortogonal (não mexe em pessoa/tempo/POV/nome), então vale nas 4 categorias
// INCLUSIVE a milionario-3p (continuidade factual independe de quem narra).
// Trava nas DUAS camadas: Escrita (previne) + Revisor (detecta).
console.log("\n[Continuidade nas junções] travado na Escrita + Revisor (4 categorias)");
for (const cat of CATS) {
  const e = read(`lib/agents/${cat}/escrita.ts`);
  has(e, "JUNCTION_CONTINUITY_RULE")
    ? ok(`${cat}: JUNCTION_CONTINUITY_RULE na Escrita`)
    : bad(`${cat}: FALTA JUNCTION_CONTINUITY_RULE em lib/agents/${cat}/escrita.ts`);
  const r = read(`lib/agents/${cat}/revisor.ts`);
  has(r, "JUNCTION_CONTINUITY_REVISOR_CHECKLIST")
    ? ok(`${cat}: JUNCTION_CONTINUITY_REVISOR_CHECKLIST no Revisor`)
    : bad(`${cat}: FALTA JUNCTION_CONTINUITY_REVISOR_CHECKLIST em lib/agents/${cat}/revisor.ts`);
}
{
  const jc = read("lib/agents/_shared/junction-continuity-rule.ts");
  has(jc, "JUNCTION_CONTINUITY_RULE") && has(jc, "JUNCTION_CONTINUITY_REVISOR_CHECKLIST")
    ? ok("junction-continuity-rule.ts exporta JUNCTION_CONTINUITY_RULE + JUNCTION_CONTINUITY_REVISOR_CHECKLIST")
    : bad("junction-continuity-rule.ts faltando export(s)");
}

// ── Marcador ✦ DUPLICADO em sequência (Parte 2) colapsado na ORIGEM ──
// Bug 08/07/2026: `✦ DANTE — POV masculino` emitido 2× seguidas (copiar-colar),
// listado como GRAVÍSSIMO. dedup de capítulo/bloco não pega (é só a linha).
// Trava determinística na Escrita (stripDuplicateConsecutivePovMarkers, SÓ P2 —
// na P1 o conserto é remover TODOS via stripPovMarkersPart1) + Revisor pega resíduo.
console.log("\n[POV Parte 2] marcador ✦ duplicado em sequência colapsado na origem");
{
  const dup = read("lib/strip-duplicate-pov-markers.ts");
  has(dup, "export function stripDuplicateConsecutivePovMarkers")
    ? ok("strip-duplicate-pov-markers.ts exporta stripDuplicateConsecutivePovMarkers")
    : bad("lib/strip-duplicate-pov-markers.ts: FALTA stripDuplicateConsecutivePovMarkers");
  const re = read("lib/generation/run-escrita.ts");
  has(re, "stripDuplicateConsecutivePovMarkers")
    ? ok("run-escrita.ts aplica stripDuplicateConsecutivePovMarkers (Parte 2)")
    : bad("lib/generation/run-escrita.ts: NÃO aplica stripDuplicateConsecutivePovMarkers");
}

// ── Resiliência a marcador de erro injetado (socket caído) — Estrutura + Escrita ──
// Bug 13/07/2026: "socket connection was closed unexpectedly" na máquina fraca da
// roteirista era injetado como [ERRO] no corpo do stream. A Escrita já retentava;
// a Estrutura/Revisor (run-step.ts) NÃO — salvava a estrutura truncada + o [ERRO]
// como conteúdo (contagem de capítulos/palavras quebrava). Fonte única = módulo
// compartilhado stream-error-markers.ts; run-step retenta transiente/aborta fatal;
// o sanitizer limpa o [ERRO] absorvido na prosa (cura roteiros já quebrados).
console.log("\n[Resiliência] marcador de erro injetado (socket) tratado na Estrutura + limpo na prosa");
{
  const sem = read("lib/generation/stream-error-markers.ts");
  if (sem == null) {
    bad("lib/generation/stream-error-markers.ts NÃO encontrado (fonte única dos detectores)");
  } else {
    ["isTransientErroMarker", "isQuotaErroMarker", "detectHardMarker", "detectErroMarker"].forEach(
      (fn) =>
        has(sem, `export function ${fn}`)
          ? ok(`stream-error-markers.ts exporta ${fn}`)
          : bad(`lib/generation/stream-error-markers.ts: FALTA export ${fn}`),
    );
    has(sem, "socket connection was closed")
      ? ok("stream-error-markers.ts cobre 'socket connection was closed'")
      : bad("lib/generation/stream-error-markers.ts: NÃO cobre a queda de socket");
  }
  const rstep = read("lib/generation/run-step.ts");
  if (rstep == null) {
    bad("lib/generation/run-step.ts NÃO encontrado");
  } else {
    has(rstep, "stream-error-markers")
      ? ok("run-step.ts importa os detectores compartilhados")
      : bad("lib/generation/run-step.ts: NÃO importa stream-error-markers (Estrutura não retenta socket)");
    has(rstep, "TransientStreamError") && has(rstep, "FatalStreamMarkerError")
      ? ok("run-step.ts distingue transiente (retry) de fatal (aborta)")
      : bad("lib/generation/run-step.ts: FALTA TransientStreamError/FatalStreamMarkerError");
  }
  const rescrita = read("lib/generation/run-escrita.ts");
  if (rescrita && !has(rescrita, "stream-error-markers")) {
    bad("lib/generation/run-escrita.ts: NÃO importa a fonte única stream-error-markers (drift de regex)");
  } else if (rescrita) {
    ok("run-escrita.ts usa a fonte única stream-error-markers");
  }
  const san = read("lib/sanitize-escrita-content.ts");
  if (san == null) {
    bad("lib/sanitize-escrita-content.ts NÃO encontrado");
  } else {
    has(san, "export function stripInjectedErrorMarkers")
      ? ok("sanitize: stripInjectedErrorMarkers presente (limpa [ERRO] absorvido na prosa)")
      : bad("lib/sanitize-escrita-content.ts: FALTA stripInjectedErrorMarkers");
    has(san, "NEXT_CHAPTER_HEADER_RE")
      ? ok("sanitize: corte por próximo cabeçalho (não apaga capítulos seguintes)")
      : bad("lib/sanitize-escrita-content.ts: FALTA corte por cabeçalho (risco de apagar capítulos)");
  }
}

// ── Concorrência ADAPTATIVA à RAM (máquina fraca) — 8GB+ fica IDÊNTICO ──
// A máquina ≤6GB reduz os streams Opus simultâneos (menos pressão de memória =
// menos queda de socket). Invariante: a decisão vem de isLowMemMachine e os
// valores da máquina NORMAL não podem regredir (gen 2 / calib 5 / jobs 4).
console.log("\n[Adaptativo] concorrência à RAM — normal intacto, fraca reduz");
{
  const cal = read("lib/escrita-calibration.ts");
  if (cal == null) {
    bad("lib/escrita-calibration.ts NÃO encontrado");
  } else {
    has(cal, "export function isLowMemMachine")
      ? ok("escrita-calibration.ts exporta isLowMemMachine (decisão pura/testável)")
      : bad("lib/escrita-calibration.ts: FALTA isLowMemMachine");
    /IS_LOW_MEM_MACHINE\s*\?\s*1\s*:\s*2/.test(cal)
      ? ok("GEN_STREAM_CONCURRENCY: fraca=1 / normal=2 (normal intacto)")
      : bad("lib/escrita-calibration.ts: GEN_STREAM_CONCURRENCY normal deixou de ser 2");
    /IS_LOW_MEM_MACHINE\s*\?\s*2\s*:\s*5/.test(cal)
      ? ok("CALIBRATION_CONCURRENCY: fraca=2 / normal=5 (normal intacto)")
      : bad("lib/escrita-calibration.ts: CALIBRATION_CONCURRENCY normal deixou de ser 5");
    has(cal, "LOW_MEM_THRESHOLD_MB = 6144")
      ? ok("limiar 6144MB espelha o heap adaptativo do main")
      : bad("lib/escrita-calibration.ts: limiar ≠ 6144 (dessincronizou do heap adaptativo)");
  }
  const qr = read("components/queue/QueueRunner.tsx");
  if (qr && !/IS_LOW_MEM_MACHINE\s*\?\s*2\s*:\s*4/.test(qr)) {
    bad("components/queue/QueueRunner.tsx: MAX_CONCURRENT_STREAMS normal deixou de ser 4");
  } else if (qr) {
    ok("MAX_CONCURRENT_STREAMS: fraca=2 / normal=4 (normal intacto)");
  }
  const pre = read("electron/preload.js");
  if (pre && !has(pre, "totalMemMB")) {
    bad("electron/preload.js: NÃO expõe totalMemMB (renderer não sabe a RAM)");
  } else if (pre) {
    ok("preload expõe totalMemMB (RAM síncrona pro renderer)");
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

// ── Parte 2: piso de palavras por capítulo (~2.000) — nenhum cap minúsculo ──
// Bug 15/06/2026 "último capítulo de 800 palavras": a Estrutura P2 declarava o
// último cap com ~800 palavras (epílogo curto) e os outros ~2.300-2.900; como a
// SOMA seguia na faixa, NADA corrigia e a Escrita gerava o cap minúsculo. Trava
// em DUAS pontas: (1) os 4 prompts P2 exigem MÍNIMO ~2.000/cap; (2)
// `enforceMinChapterShare` (lib/balance-chapter-distribution.ts) eleva
// deterministicamente qualquer cap abaixo do piso, chamado por
// `normalizeEstruturaTargets` SÓ na Parte 2 (a P1 tem caps curtos legítimos).
console.log("\n[Estrutura P2] piso de palavras por capítulo (~2.000) travado");
const MIN_CAP_RE = /m[íi]nimo[^\n]{0,40}2\.?000[^\n]{0,40}por\s+cap[íi]tulo/i;
for (const cat of CATS) {
  const rel = `lib/agents/${cat}/estrutura2-prompt.ts`;
  const t = read(rel);
  if (t == null) { bad(`${rel} NÃO encontrado`); continue; }
  MIN_CAP_RE.test(t)
    ? ok(`${cat}: regra de MÍNIMO ~2.000 palavras por capítulo presente`)
    : bad(`${cat}: FALTA a regra de MÍNIMO ~2.000 palavras por capítulo em ${rel}`);
}
{
  const bal = read("lib/balance-chapter-distribution.ts");
  has(bal, "export function enforceMinChapterShare")
    ? ok("balance-chapter-distribution.ts exporta enforceMinChapterShare")
    : bad("lib/balance-chapter-distribution.ts: FALTA enforceMinChapterShare (trava de distribuição P2)");
  const norm = read("lib/normalize-estrutura-targets.ts") ?? "";
  has(norm, "enforceMinChapterShare") && /part\s*===\s*"Parte 2"/.test(norm)
    ? ok('normalizeEstruturaTargets aplica a trava SÓ na Parte 2 (guard part === "Parte 2")')
    : bad('lib/normalize-estrutura-targets.ts: trava de distribuição não plugada com guard part === "Parte 2" (P2-only — não pode vazar pra P1)');
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

// ── Storage: history em chaves laterais (perf — não re-comprimir ~9 MB por save) ──
// O history (~55% da biblioteca) mora em `veludo:history:<id>` FORA do blob quente,
// pra os saves do streaming pararem de re-comprimir a biblioteca inteira na main
// thread (causa do travamento com vários roteiros gerando juntos). Travas anti-
// regressão: a chave existe, o rastreador por-identidade existe (skip do caminho
// quente), o delete limpa a chave (senão vaza quota), o strip mantém inline em
// falha de quota (nunca perde), e o backup segue lendo o cache (cópia COMPLETA
// com history inline). Ver `target`/`refimg` como precedente do mesmo padrão.
console.log("\n[Storage] history nas chaves laterais (perf)");
{
  const st = read("lib/storage.ts") ?? "";
  has(st, 'HISTORY_PREFIX = "veludo:history:"')
    ? ok("HISTORY_PREFIX veludo:history: presente")
    : bad("lib/storage.ts: HISTORY_PREFIX (veludo:history:) sumiu — history voltou pro blob quente");
  has(st, "lastWrittenHistory")
    ? ok("rastreador lastWrittenHistory presente (skip por identidade no streaming)")
    : bad("lib/storage.ts: lastWrittenHistory sumiu — saves do streaming voltam a reescrever o history");
  has(st, "function stripHistory(") && has(st, "function hydrateHistory(")
    ? ok("stripHistory + hydrateHistory presentes")
    : bad("lib/storage.ts: stripHistory/hydrateHistory sumiram — history volta pro blob quente");
  has(st, "removeItem(HISTORY_PREFIX")
    ? ok("deleteRoteiro limpa a chave lateral de history")
    : bad("lib/storage.ts: deleteRoteiro NÃO remove HISTORY_PREFIX — chave lateral órfã vaza quota");
  has(st, "NUNCA perder o history")
    ? ok("stripHistory mantém inline em falha de quota (não perde o history)")
    : bad("lib/storage.ts: stripHistory sem fallback keep-inline — risco de perder history em quota");
  /serializeLibraryForBackup[\s\S]*?getCache\(\)/.test(st)
    ? ok("serializeLibraryForBackup lê getCache() (backup completo, history inline)")
    : bad("lib/storage.ts: serializeLibraryForBackup não lê mais getCache() — backup pode sair sem history");
}

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

// ── Backstop de Estrutura TRUNCADA (socket cai limpo → poucos capítulos) ──
// A Estrutura pode sair com menos capítulos que o mínimo da categoria quando o
// socket do claude.exe encerra o stream cedo SEM injetar [ERRO] (máquina fraca).
// runEstruturaStep tem que RETENTAR nesse caso (senão a Escrita gera fiel aos
// poucos caps → contagem quebrada no Docs). Confirma que o guard está plugado.
console.log("\n[Estrutura] backstop de truncamento (retenta se vier com poucos capítulos)");
{
  const pec = read("lib/expected-min-chapters.ts");
  pec && /export function expectedMinChapters\(/.test(pec)
    ? ok("expected-min-chapters.ts exporta expectedMinChapters")
    : bad("lib/expected-min-chapters.ts: FALTA expectedMinChapters (piso de capítulos por categoria)");
  // Parte 2 = SEMPRE 6 nas 4 categorias no piso (invariante travado).
  pec && (pec.match(/"Parte 2":\s*6/g) || []).length >= 4
    ? ok("piso Parte 2 = 6 nas 4 categorias")
    : bad("lib/expected-min-chapters.ts: piso da Parte 2 deveria ser 6 nas 4 categorias");
  const rs = read("lib/generation/run-step.ts");
  rs && has(rs, "expectedMinChapters") && /gotChapters\s*<\s*minChapters/.test(rs) && has(rs, "TransientStreamError")
    ? ok("runEstruturaStep retenta Estrutura truncada (TransientStreamError)")
    : bad("lib/generation/run-step.ts: runEstruturaStep NÃO retenta Estrutura truncada (guard de contagem ausente)");
}

// ── Guard de completude da Escrita (não entregar roteiro CURTO em silêncio) ──
// A Escrita não pode marcar "pronto" um roteiro com capítulo faltando OU com a
// soma da Parte abaixo do piso da faixa (calibração/balanço falhou por cota).
// Deve lançar EscritaIncompleteError → "Continuar geração". Escolha da roteirista.
console.log("\n[Escrita] guard de completude (capítulo faltando / soma abaixo do piso → bloqueia)");
{
  const ec = read("lib/escrita-completeness.ts");
  ec && /export function findIncompleteProblems\(/.test(ec)
    ? ok("escrita-completeness.ts exporta findIncompleteProblems")
    : bad("lib/escrita-completeness.ts: FALTA findIncompleteProblems");
  const re = read("lib/generation/run-escrita.ts");
  re && has(re, "findIncompleteProblems") && has(re, "EscritaIncompleteError")
    ? ok("run-escrita.ts bloqueia entrega incompleta (findIncompleteProblems → EscritaIncompleteError)")
    : bad("lib/generation/run-escrita.ts: guard de completude NÃO usa findIncompleteProblems");
  // A UI mostra "Continuar geração" também quando a soma fecha abaixo do piso
  // (partTotalOutOfRange < min) — persiste após reiniciar o app.
  const ss = read("components/wizard/StepShell.tsx");
  ss && /partTotalOutOfRange\.total\s*<\s*w\.partTotalOutOfRange\.min/.test(ss)
    ? ok("StepShell trata partTotalOutOfRange (abaixo do min) como incompleto")
    : bad("components/wizard/StepShell.tsx: escritaIncomplete NÃO reconhece partTotalOutOfRange abaixo do min");
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
