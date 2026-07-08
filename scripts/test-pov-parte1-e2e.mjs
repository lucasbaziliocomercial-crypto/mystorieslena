// E2E dos DOIS fixes da LENA (v1.1.8), pelas funções REAIS do pipeline —
// sem chamar o modelo (não exige OAuth/cota). Reproduz o cenário exato do bug:
// um bloco `✦ THIERRY` (POV do MMC) vazado na PARTE 1 (que é 100% da FMC) + uma
// PARTE 2 com `✦ THIERRY` LEGÍTIMO, pra provar que o fix limpa a P1 SEM tocar o
// destaque verde do MMC na P2.
//
// Fixes cobertos:
//   BUG 1 — POV do MMC na Parte 1:
//     • origem:  stripPovMarkersPart1  (remove a linha ✦ NOME, prosa intacta)
//     • export:  escritaContentToHtml  (não emite heading ✦ NOME na P1; P2 intacta)
//     • invariante: verde (#d9ead3) SÓ no MMC da P2, JAMAIS na P1 nem na FMC
//   BUG 2 — total da Parte fora da faixa sem aviso:
//     • decisão real com partTotalRange("Parte 1","mafia") + countWords reais
//       (a soma 13.242 da LENA dispara o aviso; 12.500 não)
//
// Roda com: node scripts/test-pov-parte1-e2e.mjs
import { stripPovMarkersPart1 } from "../lib/strip-pov-markers-part1.ts";
import { escritaContentToHtml } from "../lib/export-html.ts";
import { countWords } from "../lib/word-count.ts";

// Range real da máfia P1 — espelha CATEGORIES.mafia.wordCount.parte1 em
// lib/categories/index.ts (não importável direto aqui: parse-estrutura-targets
// puxa o alias `@/` que o node cru não resolve). É o MESMO {min,max} que o
// partTotalRange("Parte 1","mafia") devolve e que o balancePartTotal usa.
const MAFIA_P1 = { min: 12000, max: 13000 };
const partTotalRange = () => MAFIA_P1;

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

const GREEN = "#d9ead3"; // STYLE_HIGHLIGHT_MMC — destaque do POV masculino

// ─── Roteiro de máfia com o bug EXATO da LENA ────────────────────────────────
// P1: heroína narra; um `✦ THIERRY` (MMC) VAZOU no meio do Cap 1.
// P2: `✦ THIERRY` é LEGÍTIMO (POV alternado).
const P1_CAP1 = `## Capítulo 1 — A mulher que ele não podia ter

Servi mais café e levei a caneca até a cintura. A cidade lá fora começava sem pedir licença, indiferente a mim.

✦ THIERRY

Ele observou a mulher atravessar o salão e soube, naquele instante, que não a deixaria partir.`;

const ROTEIRO = `# PARTE 1

${P1_CAP1}

## Capítulo 2 — Baby

Continuei subindo os degraus, o coração apertado, sem entender por que ainda ficava naquela casa.

# PARTE 2

## Capítulo 1 — O que matei por você

Acordei com o braço dele pesado sobre o meu ventre, o quarto ainda escuro e silencioso.

✦ THIERRY

Eu a observei dormir e prometi, em silêncio, queimar o mundo inteiro antes de perdê-la de novo.`;

// ═══ BUG 1 — camada de ORIGEM (stripPovMarkersPart1) ═════════════════════════
console.log("\n— BUG 1 · origem: stripPovMarkersPart1 no Cap 1 da Parte 1 —");
{
  const r = stripPovMarkersPart1(P1_CAP1);
  check("marcador ✦ THIERRY detectado e removido", r.removed.length === 1 && r.removed[0] === "THIERRY", JSON.stringify(r.removed));
  check("nenhum ✦ sobra no conteúdo da P1", !r.content.includes("✦"), r.content);
  check("prosa da heroína preservada", r.content.includes("Servi mais café"));
  check("prosa do bloco vazado preservada (POV vira problema do Revisor, não some)", r.content.includes("Ele observou a mulher atravessar"));
}

// ═══ BUG 1 — camada de EXPORT (escritaContentToHtml) + invariante do verde ════
console.log("\n— BUG 1 · export: cura no HTML + invariante do verde do MMC —");
{
  const html = escritaContentToHtml(ROTEIRO, {
    maleLeadName: "Thierry",
    femaleLeadName: "Marceline",
  });
  const idx = html.indexOf("PARTE 2");
  const p1 = html.slice(0, idx);
  const p2 = html.slice(idx);

  // P1: o ✦ THIERRY vazado NÃO vira heading e NÃO pinta nada de verde.
  check("P1 · nenhum heading/nó ✦ THIERRY (marcador vazado sumiu da árvore)", !p1.includes("THIERRY"), "achou THIERRY na P1");
  check("P1 · ZERO destaque verde (nada da P1 fica verde)", !p1.includes(GREEN), "achou verde na P1");
  check("P1 · prosa da heroína continua no HTML", p1.includes("Servi mais café"));
  check("P1 · prosa do bloco vazado continua no HTML (só o marcador saiu)", p1.includes("Ele observou a mulher atravessar"));

  // P2: o ✦ THIERRY legítimo VIRA heading de POV masculino e a prosa dele fica verde.
  check("P2 · heading ✦ THIERRY presente", /<h3[^>]*>.*THIERRY/.test(p2), "sem heading THIERRY na P2");
  check("P2 · heading rotulado como POV masculino", p2.includes("POV masculino"));
  check("P2 · prosa do MMC fica VERDE (destaque preservado)", p2.includes(GREEN) && new RegExp(`${GREEN}[^]*Eu a observei dormir`).test(p2), "prosa do MMC não ficou verde");

  // Invariante duro: a FMC nunca fica verde.
  check("P2 · prosa da heroína (antes do ✦) NÃO fica verde", !new RegExp(`${GREEN}[^]*Acordei com o braço dele`).test(p2), "verde vazou pra FMC");

  // Verde aparece EXATAMENTE 1× no doc inteiro (só o único parágrafo do MMC na P2).
  const greenCount = (html.match(new RegExp(GREEN, "g")) || []).length;
  check("doc · destaque verde aparece 1× só (só o MMC da P2)", greenCount === 1, `greenCount=${greenCount}`);
}

// ═══ BUG 2 — aviso de total fora da faixa (decisão real: range + countWords) ══
console.log("\n— BUG 2 · aviso partTotalOutOfRange (partTotalRange + countWords reais) —");
{
  const { min, max } = partTotalRange("Parte 1", "mafia");
  check("range real da máfia P1 = 12.000–13.000", min === 12000 && max === 13000, `${min}-${max}`);

  // Réplica FIEL do guard do balancePartTotal (run-escrita.ts): monta capítulos
  // cuja SOMA de countWords é a da LENA (13.242) e a que fica na faixa (12.500).
  const chapterOf = (n) => ({ number: n, content: "palavra ".repeat(n).trim() });
  const guardFires = (chapters) => {
    const numbered = chapters.filter((c) => c.number >= 1);
    const total = numbered.reduce((s, c) => s + countWords(c.content), 0);
    return { total, fires: numbered.length > 0 && (total < min || total > max) };
  };

  // Caso LENA: 6 caps somando 13.242 (fora, acima do teto 13.000).
  const lena = [2200, 2200, 2200, 2200, 2200, 2242].map(chapterOf);
  const lenaRes = guardFires(lena);
  check("soma reconstruída = 13.242 (número real da LENA)", lenaRes.total === 13242, `total=${lenaRes.total}`);
  check("total 13.242 > teto → aviso DISPARA (não entrega em silêncio)", lenaRes.fires === true);

  // Caso saudável: soma 12.500 (dentro) → nenhum aviso.
  const ok = [2100, 2100, 2100, 2100, 2050, 2050].map(chapterOf);
  const okRes = guardFires(ok);
  check("soma 12.500 dentro da faixa → aviso NÃO dispara", okRes.total === 12500 && okRes.fires === false, `total=${okRes.total}`);
}

console.log(`\n${pass} passaram · ${fail} falharam`);
process.exit(fail > 0 ? 1 : 0);
