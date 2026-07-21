// Rótulo de PAPEL no marcador de POV (`✦ NOME — POV masculino/feminino`) —
// pelas funções REAIS do export (sem chamar o modelo).
//
// Bug relatado pela roteirista (21/07/2026): no roteiro exportado o marcador saía
// só como "✦ LUCA", sem NADA identificando que aquele bloco é o POV masculino.
// Dois defeitos:
//   • o rótulo só existia no EXPORT e sumia quando a Estrutura não trazia os
//     campos `Nome:` do MMC/FMC (roleTag vazio → "✦ LUCA" pelado);
//   • se o marcador JÁ vinha com o rótulo (novo formato do POV_MARKER_RULE), o
//     export ANEXAVA de novo → "✦ LUCA — POV masculino — POV masculino".
//
// Invariantes cobertas aqui:
//   1. rótulo NUNCA duplica;
//   2. roteiro antigo (só `✦ NOME`) ganha o rótulo pelo export;
//   3. rótulo escrito na origem SOBREVIVE mesmo sem os nomes da Estrutura;
//   4. `### Subtítulo` comum (sem ✦) não vira marcador nem ganha rótulo;
//   5. Parte 1 continua sem NENHUM marcador (a trava antiga não regrediu);
//   6. o destaque verde do MMC continua saindo só na Parte 2.
//
// Roda com: node scripts/test-pov-role-tag.mjs
import { escritaContentToHtml } from "../lib/export-html.ts";

const GREEN = "#d9ead3"; // STYLE_HIGHLIGHT_MMC
const LEADS = { maleLeadName: "Luca Ferrante", femaleLeadName: "Ivy Calloway" };
const SEM_LEADS = { maleLeadName: null, femaleLeadName: null };

let pass = 0,
  fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`✅ PASS  ${name}`);
  } else {
    fail++;
    console.log(`❌ FAIL  ${name}${extra ? "  — " + extra : ""}`);
  }
}

const headings = (html) =>
  [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, ""),
  );

const parte2 = (marcadorMmc, marcadorFmc) => `# PARTE 2

## Capítulo 1 — The Four in the Morning Call

${marcadorMmc}

The kitchen was cold in that good way, and I came down the stairs barefoot.

${marcadorFmc}

I heard him on the stairs and pretended to sleep.

### Uma semana depois

Prosa sob um subtítulo comum, sem marcador de POV.
`;

// ── 1. Roteiro NOVO: o modelo já escreve o rótulo ────────────────────────
{
  const h = headings(
    escritaContentToHtml(
      parte2("✦ LUCA — POV masculino", "✦ IVY — POV feminino"),
      LEADS,
    ),
  );
  check("1. rótulo da origem não duplica (MMC)", h[0] === "✦ LUCA — POV masculino", h[0]);
  check("1. rótulo da origem não duplica (FMC)", h[1] === "✦ IVY — POV feminino", h[1]);
  check("1. subtítulo comum intocado", h[2] === "Uma semana depois", h[2]);
}

// ── 2. Roteiro ANTIGO (só ✦ NOME): o export rotula ───────────────────────
{
  const html = escritaContentToHtml(parte2("✦ LUCA", "✦ IVY"), LEADS);
  const h = headings(html);
  check("2. roteiro antigo ganha rótulo masculino", h[0] === "✦ LUCA — POV masculino", h[0]);
  check("2. roteiro antigo ganha rótulo feminino", h[1] === "✦ IVY — POV feminino", h[1]);
  check("2. verde do MMC continua saindo", html.includes(GREEN));
}

// ── 3. Rótulo na origem + Estrutura SEM os nomes ─────────────────────────
// Antes do fix o export descartava o rótulo aqui e sobrava "✦ LUCA" pelado —
// exatamente o print da roteirista.
{
  const h = headings(
    escritaContentToHtml(
      parte2("✦ LUCA — POV masculino", "✦ IVY — POV feminino"),
      SEM_LEADS,
    ),
  );
  check("3. rótulo sobrevive sem os nomes da Estrutura (MMC)", h[0] === "✦ LUCA — POV masculino", h[0]);
  check("3. rótulo sobrevive sem os nomes da Estrutura (FMC)", h[1] === "✦ IVY — POV feminino", h[1]);
}

// ── 4. Variações de escrita do rótulo (hífen, caixa, negrito) ────────────
{
  const h = headings(
    escritaContentToHtml(parte2("✦ **LUCA** - pov masculino", "✦ IVY – POV Feminino"), LEADS),
  );
  check("4. hífen/caixa/negrito normalizados (MMC)", h[0] === "✦ LUCA — POV masculino", h[0]);
  check("4. hífen/caixa/negrito normalizados (FMC)", h[1] === "✦ IVY — POV feminino", h[1]);
}

// ── 5. PARTE 1 — nenhum marcador sobrevive, nenhum verde ─────────────────
{
  const html = escritaContentToHtml(
    `# PARTE 1

## Capítulo 1 — Primeiro dia

✦ LUCA — POV masculino

Bloco do MMC vazado na Parte 1 — o marcador tem que sumir do export.
`,
    LEADS,
  );
  check("5. Parte 1 sem marcador ✦ (com rótulo, formato novo)", headings(html).length === 0);
  check("5. Parte 1 sem destaque verde", !html.includes(GREEN));
}

// ── 6. Heroína narrando SEM marcador na P2 continua rotulada ─────────────
{
  const h = headings(
    escritaContentToHtml(
      `# PARTE 2

## Capítulo 1 — Volta dela

A cozinha estava fria e eu desci descalça — trecho da heroína, sem marcador.

✦ LUCA — POV masculino

Eu a ouvi na escada.
`,
      LEADS,
    ),
  );
  check("6. rótulo implícito da heroína preservado", h[0] === "✦ Ivy Calloway — POV feminino", h[0]);
  check("6. marcador do MMC com rótulo único", h[1] === "✦ LUCA — POV masculino", h[1]);
}

console.log(`\n${pass} passaram · ${fail} falharam`);
if (fail > 0) process.exit(1);
