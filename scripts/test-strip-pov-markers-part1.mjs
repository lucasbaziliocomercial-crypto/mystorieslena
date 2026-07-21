// Testa a trava determinística que remove marcadores de POV `✦ NOME` que vazam
// pra PARTE 1 (lib/strip-pov-markers-part1.ts). A Parte 1 é 100% da FMC — o
// `✦ NOME` é EXCLUSIVO da Parte 2. Bug reportado na história da LENA (máfia):
// `✦ THIERRY` (POV do MMC) apareceu no meio da Parte 1.
//
// Foco DUPLO:
//   • RECALL — remove o marcador nomeado (`✦ THIERRY`, `✦ **NOME**`, `### ✦ N`).
//   • PRECISÃO — NÃO toca em divisória decorativa (`✦`, `✦ ✦ ✦`) nem em prosa.
//
// Importa o .ts direto (Node ≥ 22 strip-types). Run:
//   node scripts/test-strip-pov-markers-part1.mjs
import { stripPovMarkersPart1 } from "../lib/strip-pov-markers-part1.ts";

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

// ── RECALL: remove marcador nomeado ────────────────────────────────────────
{
  const content = [
    "Servi mais café. Levei a caneca até a cintura.",
    "",
    "✦ THIERRY",
    "",
    "Ele observou a mulher sair pela porta lateral, o café esfriando.",
  ].join("\n");
  const r = stripPovMarkersPart1(content);
  check("remove `✦ THIERRY` isolado", r.removed.length === 1 && r.removed[0] === "THIERRY", JSON.stringify(r.removed));
  check("prosa preservada após remoção", r.content.includes("Servi mais café") && r.content.includes("Ele observou a mulher"), r.content);
  check("marcador some do conteúdo", !r.content.includes("✦"), r.content);
  check("sem quebra tripla remanescente", !/\n{3,}/.test(r.content), JSON.stringify(r.content));
}

// negrito no nome / no marcador inteiro
{
  const a = stripPovMarkersPart1("Linha um.\n\n✦ **SALVATORE**\n\nLinha dois.");
  check("remove `✦ **NOME**`", a.removed.length === 1 && a.removed[0] === "SALVATORE", JSON.stringify(a.removed));
  const b = stripPovMarkersPart1("Linha um.\n\n**✦ GENNARO**\n\nLinha dois.");
  check("remove `**✦ NOME**`", b.removed.length === 1 && b.removed[0] === "GENNARO", JSON.stringify(b.removed));
}

// forma já promovida a heading (### ✦ NOME) — caso o strip rode sobre conteúdo curado
{
  const r = stripPovMarkersPart1("Prosa.\n\n### ✦ THIERRY\n\nMais prosa.");
  check("remove `### ✦ NOME` (heading promovido)", r.removed.length === 1 && r.removed[0] === "THIERRY", JSON.stringify(r.removed));
}

// look-alikes ♦ ◆
{
  const r = stripPovMarkersPart1("Prosa.\n\n♦ MARCO\n\nMais.\n\n◆ LUCA\n\nFim.");
  check("remove look-alikes ♦/◆ nomeados", r.removed.length === 2, JSON.stringify(r.removed));
}

// múltiplos marcadores no mesmo capítulo
{
  const r = stripPovMarkersPart1("A.\n\n✦ THIERRY\n\nB.\n\n✦ NADIA\n\nC.");
  check("remove múltiplos marcadores", r.removed.length === 2 && r.content.includes("A.") && r.content.includes("B.") && r.content.includes("C."), JSON.stringify(r));
}

// ── PRECISÃO: NÃO toca divisória decorativa nem prosa ──────────────────────
{
  const div1 = stripPovMarkersPart1("Cena um termina.\n\n✦\n\nCena dois começa.");
  check("preserva `✦` sozinho (divisória)", div1.removed.length === 0 && div1.content.includes("✦"), JSON.stringify(div1));

  const div3 = stripPovMarkersPart1("Cena um.\n\n✦ ✦ ✦\n\nCena dois.");
  check("preserva `✦ ✦ ✦` (divisória tripla)", div3.removed.length === 0 && div3.content.includes("✦ ✦ ✦"), JSON.stringify(div3));

  const divBold = stripPovMarkersPart1("Cena.\n\n**✦ ✦ ✦**\n\nCena.");
  check("preserva `**✦ ✦ ✦**` (divisória em negrito)", divBold.removed.length === 0, JSON.stringify(divBold));
}

// RÓTULO DE PAPEL no marcador (formato do POV_MARKER_RULE desde 1.1.19).
// A combinação negrito + sufixo (`✦ **NOME** — POV masculino`) punha o rótulo
// DEPOIS do `**` de fecho e a linha deixava de casar — a trava de origem caía
// justo no bug recorrente do POV do MMC vazando pra Parte 1.
{
  const c1 = stripPovMarkersPart1("Linha um.\n\n✦ THIERRY — POV masculino\n\nLinha dois.");
  check("remove `✦ NOME — POV masculino`", c1.removed.length === 1 && c1.removed[0] === "THIERRY", JSON.stringify(c1.removed));

  const c2 = stripPovMarkersPart1("Linha um.\n\n✦ **THIERRY** — POV masculino\n\nLinha dois.");
  check("remove `✦ **NOME** — POV masculino` (negrito + rótulo)", c2.removed.length === 1 && c2.removed[0] === "THIERRY", JSON.stringify(c2.removed));

  const c3 = stripPovMarkersPart1("Linha um.\n\n### ✦ **SOLVEIG** — POV feminino\n\nLinha dois.");
  check("remove `### ✦ **NOME** — POV feminino`", c3.removed.length === 1 && c3.removed[0] === "SOLVEIG", JSON.stringify(c3.removed));

  const c4 = stripPovMarkersPart1("Linha um.\n\n**✦ GENNARO — POV masculino**\n\nLinha dois.");
  check("remove `**✦ NOME — POV masculino**` (negrito na linha toda)", c4.removed.length === 1, JSON.stringify(c4.removed));

  // Rótulo em CAIXA ALTA: os prompts pedem o NOME em caixa alta e o modelo
  // uniformiza a linha inteira. Sem o flag `i` na regex, o par negrito+caixa
  // escapava da trava.
  const c4b = stripPovMarkersPart1("Linha um.\n\n✦ **DANTE** — POV MASCULINO\n\nLinha dois.");
  check("remove `✦ **NOME** — POV MASCULINO` (rótulo em caixa alta)", c4b.removed.length === 1 && c4b.removed[0] === "DANTE", JSON.stringify(c4b.removed));

  const c4c = stripPovMarkersPart1("Linha um.\n\n### ✦ **SOLVEIG** — POV FEMININO\n\nLinha dois.");
  check("remove `### ✦ **NOME** — POV FEMININO` (caixa alta)", c4c.removed.length === 1 && c4c.removed[0] === "SOLVEIG", JSON.stringify(c4c.removed));

  const c5 = stripPovMarkersPart1("Cena.\n\n✦ ✦ ✦\n\nCena.");
  check("divisória `✦ ✦ ✦` segue preservada (não ganhou rótulo)", c5.removed.length === 0, JSON.stringify(c5.removed));
}

{
  // prosa que MENCIONA ✦ no meio da frase (não é linha isolada de marcador) — mantém
  const prose = stripPovMarkersPart1("Ela desenhou uma estrela ✦ THIERRY no guardanapo, rindo.");
  check("preserva ✦ no MEIO de frase de prosa", prose.removed.length === 0, JSON.stringify(prose));
}

{
  // conteúdo totalmente limpo → no-op (mesma referência de string)
  const clean = "Parágrafo um.\n\nParágrafo dois.\n\nParágrafo três.";
  const r = stripPovMarkersPart1(clean);
  check("no-op em conteúdo limpo", r.removed.length === 0 && r.content === clean, JSON.stringify(r.removed));
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail > 0 ? 1 : 0);
