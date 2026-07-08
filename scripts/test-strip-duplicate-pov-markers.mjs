// Testa a trava determinística que COLAPSA marcadores de POV `✦ NOME` DUPLICADOS
// em sequência na PARTE 2 (lib/strip-duplicate-pov-markers.ts). Bug reportado na
// história de máfia da Mina/Dante: `✦ DANTE — POV masculino` emitido 2× seguidas
// (resíduo de copiar-colar), listado como GRAVÍSSIMO.
//
// Foco DUPLO:
//   • RECALL — colapsa marcadores IGUAIS adjacentes (mesmo nome), mantendo o
//     ÚLTIMO (colado à prosa). Cobre cadeias de 3+, sufixo "— POV masculino",
//     negrito, heading, look-alikes.
//   • PRECISÃO — NÃO toca marcadores de nomes DIFERENTES adjacentes (ambíguo →
//     Revisor), nem marcadores separados por prosa, nem divisórias, nem prosa.
//
// Importa o .ts direto (Node ≥ 22 strip-types). Run:
//   node scripts/test-strip-duplicate-pov-markers.mjs
import {
  stripDuplicateConsecutivePovMarkers,
  normalizeMarkerName,
} from "../lib/strip-duplicate-pov-markers.ts";

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

// ── RECALL: colapsa duplicata adjacente ────────────────────────────────────
{
  // O caso reportado: mesmo marcador com sufixo, 2× seguidas.
  const content = [
    "✦ DANTE — POV masculino",
    "",
    "✦ DANTE — POV masculino",
    "",
    "Dirigi em silêncio, os nós dos dedos brancos no volante.",
  ].join("\n");
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("colapsa `✦ DANTE — POV masculino` duplicado", r.removed === 1, JSON.stringify(r));
  check(
    "mantém UMA ocorrência do marcador (a colada à prosa)",
    (r.content.match(/✦ DANTE/g) ?? []).length === 1,
    JSON.stringify(r.content),
  );
  check("prosa preservada", r.content.includes("Dirigi em silêncio"), r.content);
  check("sem quebra tripla remanescente", !/\n{3,}/.test(r.content), JSON.stringify(r.content));
}

// cadeia de 3 marcadores iguais → mantém 1
{
  const content = [
    "✦ ANAÏS",
    "",
    "✦ ANAÏS",
    "",
    "✦ ANAÏS",
    "",
    "Desci a escada de serviço antes do sol nascer.",
  ].join("\n");
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("colapsa cadeia de 3 iguais (remove 2)", r.removed === 2, JSON.stringify(r));
  check("resta 1 marcador", (r.content.match(/✦ ANAÏS/g) ?? []).length === 1, r.content);
}

// nome com sufixo diferente mas MESMO nome (com e sem "— POV") → mesma pessoa, colapsa
{
  const content = "✦ DANTE\n\n✦ DANTE — POV masculino\n\nAcendi o cigarro.";
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("colapsa mesmo nome com/sem sufixo POV", r.removed === 1, JSON.stringify(r));
  check(
    "mantém o ÚLTIMO (colado à prosa)",
    r.content.startsWith("✦ DANTE — POV masculino"),
    JSON.stringify(r.content),
  );
}

// negrito / heading / look-alikes duplicados
{
  const a = stripDuplicateConsecutivePovMarkers("✦ **MINA**\n\n✦ **MINA**\n\nProsa.");
  check("colapsa `✦ **NOME**` duplicado", a.removed === 1, JSON.stringify(a));
  const b = stripDuplicateConsecutivePovMarkers("### ✦ THIERRY\n\n### ✦ THIERRY\n\nProsa.");
  check("colapsa `### ✦ NOME` duplicado", b.removed === 1, JSON.stringify(b));
  const c = stripDuplicateConsecutivePovMarkers("♦ LUCA\n\n♦ LUCA\n\nProsa.");
  check("colapsa look-alike `♦ NOME` duplicado", c.removed === 1, JSON.stringify(c));
}

// caso realista: capítulo com duplicata no meio + marcadores legítimos ao redor
{
  const content = [
    "✦ MINA",
    "",
    "Acordei com a agulha do soro na mão.",
    "",
    "✦ DANTE",
    "",
    "✦ DANTE",
    "",
    "A observei da porta, sem coragem de entrar.",
    "",
    "✦ MINA",
    "",
    "Ele voltou ao quarto quando o médico saiu.",
  ].join("\n");
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("colapsa só a duplicata do meio", r.removed === 1, JSON.stringify(r));
  check("preserva os 3 marcadores legítimos distintos", (r.content.match(/✦/g) ?? []).length === 3, r.content);
  check("preserva a prosa inteira", r.content.includes("Acordei com a agulha") && r.content.includes("Ele voltou ao quarto"), r.content);
}

// ── PRECISÃO: NÃO toca casos que não são duplicata inequívoca ──────────────
{
  // nomes DIFERENTES adjacentes (troca de POV colada, não duplicata) → intocado
  const content = "✦ DANTE\n\n✦ MINA\n\nSubi os degraus, o coração apertado.";
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("NÃO toca nomes diferentes adjacentes (ambíguo)", r.removed === 0 && r.content === content, JSON.stringify(r));
}

{
  // mesmo nome mas COM PROSA entre eles → dois blocos legítimos, intocado
  const content = "✦ DANTE\n\nDirigi até o cais.\n\n✦ DANTE\n\nVoltei tarde da noite.";
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("NÃO toca mesmo nome com prosa entre eles", r.removed === 0 && r.content === content, JSON.stringify(r));
}

{
  // divisórias decorativas duplicadas (sem nome) → intocado
  const content = "Cena um.\n\n✦ ✦ ✦\n\n✦ ✦ ✦\n\nCena dois.";
  const r = stripDuplicateConsecutivePovMarkers(content);
  check("NÃO toca divisórias `✦ ✦ ✦` (sem nome)", r.removed === 0, JSON.stringify(r));
}

{
  // conteúdo sem marcadores duplicados → no-op (mesma referência de string)
  const clean = "✦ MINA\n\nParágrafo um.\n\nParágrafo dois.";
  const r = stripDuplicateConsecutivePovMarkers(clean);
  check("no-op em conteúdo sem duplicata (mesma string)", r.removed === 0 && r.content === clean, JSON.stringify(r));
}

// idempotência: rodar de novo no resultado não muda nada
{
  const once = stripDuplicateConsecutivePovMarkers("✦ DANTE\n\n✦ DANTE\n\nProsa.");
  const twice = stripDuplicateConsecutivePovMarkers(once.content);
  check("idempotente (2ª passada é no-op)", twice.removed === 0 && twice.content === once.content, JSON.stringify(twice));
}

// ── normalizeMarkerName (unidade) ──────────────────────────────────────────
{
  check("normalizeMarkerName extrai nome sem sufixo POV", normalizeMarkerName("✦ DANTE — POV masculino") === "dante", normalizeMarkerName("✦ DANTE — POV masculino"));
  check("normalizeMarkerName remove negrito", normalizeMarkerName("✦ **Mina**") === "mina", String(normalizeMarkerName("✦ **Mina**")));
  check("normalizeMarkerName divisória → null", normalizeMarkerName("✦ ✦ ✦") === null, String(normalizeMarkerName("✦ ✦ ✦")));
  check("normalizeMarkerName linha de prosa → null", normalizeMarkerName("Ele olhou pela janela.") === null, String(normalizeMarkerName("Ele olhou pela janela.")));
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail > 0 ? 1 : 0);
