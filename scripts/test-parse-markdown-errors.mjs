// Verificação rápida: roda parseMarkdownErrorList contra amostras reais de
// formato que o Revisor emite. Roda com: node scripts/test-parse-markdown-errors.mjs
import {
  parseMarkdownErrorList,
  countMarkdownErrorNumbers,
  parseRevisorNota,
  parseRevisorHateRisk,
  computeRevisorEval,
} from "../lib/parse-revisor-output.ts";
import { appendEvalSnapshot } from "../lib/eval-log.ts";

const samples = {
  "spec-do-prompt (emoji antes, com #)": `# ❌ PRINCIPAIS ERROS

🔴 Erro #1 [Gravíssimo] — Contaminação de metadados. Texto editorial vazou.

🟠 Erro #2 [Interfere] — Cena íntima na Parte 1. Quebra a regra de elipse.

🟡 Erro #3 [Atenção] — Repetição de "em poucos minutos" em parágrafos próximos.

# ✏️ SUGESTÕES`,

  "model-drift (emoji depois, sem #)": `# ❌ PRINCIPAIS ERROS

Erro 3 🔴 [Interfere] — Inconsistência grave de tempo de casamento. P1 Cap. 1: "vinte e dois meses".

Erro 4 🔴 [Interfere] — Contradição: "vigésima terceira semana". Quebra logicamente.

Erro 5 🔴 [Interfere] — Helena conhece o anel de Saverio antes de o ver. Falha de POV.

# ✏️ SUGESTÕES`,

  "com markdown bold": `# ❌ PRINCIPAIS ERROS

**Erro #1** 🔴 [Gravíssimo] — Erro grave bold.

**Erro 2** 🟠 [Interfere] — Outro erro bold sem hash.

# Sugestões`,

  "sufixo letra (3a, 3b)": `# ❌ PRINCIPAIS ERROS

🔴 Erro #3a [Gravíssimo] — Primeiro pedaço.

🔴 Erro #3b [Gravíssimo] — Segundo pedaço.

# fim`,

  "mafia 💀": `# ❌ PRINCIPAIS ERROS

💀 Erro #1 [Gravíssimo] — Categoria máfia.

🔴 Erro #2 [Interfere] — Outro.

# fim`,
};

let totalPass = 0;
let totalFail = 0;
for (const [name, content] of Object.entries(samples)) {
  const errors = parseMarkdownErrorList(content);
  const count = countMarkdownErrorNumbers(content);
  const expected = (content.match(/Erro\s*#?\s*\d/gi) ?? []).length;
  const ok = errors.length === expected && count === expected;
  console.log(
    `${ok ? "✅ PASS" : "❌ FAIL"} ${name} — parsed=${errors.length} count=${count} expected=${expected}`,
  );
  if (!ok) {
    totalFail++;
    console.log(JSON.stringify(errors, null, 2));
  } else {
    totalPass++;
    // Show first error to confirm shape is right
    if (errors[0]) {
      console.log(
        `   first: numero=${errors[0].numero} gravidade=${errors[0].gravidade} titulo="${errors[0].titulo.slice(0, 60)}..."`,
      );
    }
  }
}

// parseRevisorNota — extrai a Nota do relatório (alimenta o banner de veredito).
const notaCases = [
  ["**Nota: 8/10**", 8],
  ["# ⭐ NOTA FINAL (0 a 10)\n**Nota: 9/10**\nbla", 9],
  ["Nota 7/10", 7],
  ["**Nota: 8,5/10**", 8.5],
  ["sem nota aqui", null],
  ["# ⭐ NOTA FINAL (0 a 10)\n(sem valor numérico)", null],
  // SEM "/10" — formato real que o modelo emitiu (bug do banner "Nota —" 11/06/2026).
  ["🧨 NOTA FINAL: 7,8", 7.8],
  ["**NOTA FINAL: 7,8**\nJustificativa: o Cap 4 acelera demais.", 7.8],
  // Engodo "(0 a 10)" + nota sem barra: pega 8,5, NÃO o "0"/"10" do range.
  ["# 🧨 NOTA FINAL (0 a 10): 8,5", 8.5],
  // Nota inteira 10 sem barra.
  ["NOTA FINAL: 10", 10],
  // Malformado: cabeçalho NOTA FINAL sem valor + número ("Cap 4") na justificativa
  // → NÃO pode capturar o 4; melhor null que nota errada (banner é advisory).
  ["🧨 NOTA FINAL — veja o Cap 4 e o Cap 5", null],
];
for (const [input, expected] of notaCases) {
  const got = parseRevisorNota(input);
  const ok = got === expected;
  console.log(
    `${ok ? "✅ PASS" : "❌ FAIL"} parseRevisorNota(${JSON.stringify(input.slice(0, 28))}) → ${got} (esperado ${expected})`,
  );
  if (ok) totalPass++;
  else totalFail++;
}

// parseRevisorHateRisk — extrai o nível de risco de hate do relatório.
const hateCases = [
  ["# 🎯 NÍVEL DE RISCO DE HATE\n🔴 ALTO — grande chance de abandono", "alto"],
  ["# 🎯 NÍVEL DE RISCO DE HATE\n🟡 MÉDIO — pode gerar críticas", "medio"],
  ["# 🎯 NÍVEL DE RISCO DE HATE\n🟢 BAIXO — quase sem risco", "baixo"],
  // Eco do template com a escolha embutida no fim (— após ALTO) → alto.
  ["NÍVEL DE RISCO DE HATE\n🟢 BAIXO / 🟡 MÉDIO / 🔴 ALTO — justificativa", "alto"],
  // Só emoji, sem travessão → fallback por emoji.
  ["NÍVEL DE RISCO DE HATE\n🟡 médio risco detectado", "medio"],
  ["sem seção de hate aqui", null],
];
for (const [input, expected] of hateCases) {
  const got = parseRevisorHateRisk(input);
  const ok = got === expected;
  console.log(
    `${ok ? "✅ PASS" : "❌ FAIL"} parseRevisorHateRisk(${JSON.stringify(input.slice(0, 40))}) → ${got} (esperado ${expected})`,
  );
  if (ok) totalPass++;
  else totalFail++;
}

// computeRevisorEval — deriva o eval estruturado do relatório + erros.
{
  const report = "# 🎯 NÍVEL DE RISCO DE HATE\n🟢 BAIXO — ok\n# ⭐ NOTA FINAL\n**Nota: 9/10**";
  const errs = [
    { id: "1", numero: "1", gravidade: "atencao", titulo: "x", trechoOriginal: "", trechoCorrigido: "", porqueAlterado: "" },
    { id: "2", numero: "2", gravidade: "interfere", titulo: "y", trechoOriginal: "", trechoCorrigido: "", porqueAlterado: "" },
  ];
  const ev = computeRevisorEval("revisor1", report, errs, "hash-abc");
  const ok =
    ev &&
    ev.step === "revisor1" &&
    ev.parte === 1 &&
    ev.nota === 9 &&
    ev.hateRisk === "baixo" &&
    ev.errorTotal === 2 &&
    ev.counts.atencao === 1 &&
    ev.counts.interfere === 1 &&
    ev.canFinish === true &&
    ev.escritaHash === "hash-abc";
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} computeRevisorEval(revisor1, nota 9, 0 gravíssimos) → canFinish=${ev?.canFinish}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify(ev, null, 2)); }

  // Nota < 8 OU gravíssimo presente → canFinish false.
  const ev2 = computeRevisorEval("revisor2", "**Nota: 6/10**", errs, undefined);
  const ok2 = ev2 && ev2.parte === 2 && ev2.canFinish === false && ev2.escritaHash === undefined;
  console.log(`${ok2 ? "✅ PASS" : "❌ FAIL"} computeRevisorEval(revisor2, nota 6) → canFinish=${ev2?.canFinish}`);
  if (ok2) totalPass++; else { totalFail++; console.log(JSON.stringify(ev2, null, 2)); }

  // Step não-revisor / sentinela → null.
  const ev3 = computeRevisorEval("overview", "**Nota: 9/10**", [], undefined);
  const ev4 = computeRevisorEval("revisor1", "[ERRO] login necessário", [], undefined);
  const ok3 = ev3 === null && ev4 === null;
  console.log(`${ok3 ? "✅ PASS" : "❌ FAIL"} computeRevisorEval(overview / sentinela) → null`);
  if (ok3) totalPass++; else totalFail++;
}

// appendEvalSnapshot — dedup: re-commit idêntico não anexa; mudança anexa.
{
  const base = { step: "revisor1", parte: 1, nota: 8, hateRisk: "baixo", counts: { gravissimo: 0, interfere: 1, atencao: 2, naoInterfere: 0 }, errorTotal: 3, canFinish: true, escritaHash: "h1" };
  const l1 = appendEvalSnapshot(undefined, base, "2026-06-05T10:00:00.000Z");
  const l2 = appendEvalSnapshot(l1, base, "2026-06-05T10:05:00.000Z"); // idêntico → dedup
  const l3 = appendEvalSnapshot(l2, { ...base, nota: 9, escritaHash: "h2" }, "2026-06-05T10:10:00.000Z"); // mudou → anexa
  // revisor2 nunca dedupa contra revisor1 (step diferente).
  const l4 = appendEvalSnapshot(l3, { ...base, step: "revisor2", parte: 2 }, "2026-06-05T10:11:00.000Z");
  const ok =
    l1.length === 1 &&
    l2 === l1 && // mesma referência (dedup, sem persist)
    l3.length === 2 &&
    l3[1].nota === 9 &&
    l3[1].id === "revisor1-2026-06-05T10:10:00.000Z" &&
    l4.length === 3;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} appendEvalSnapshot dedup+append (len ${l1.length}→${l2.length}→${l3.length}→${l4.length})`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify({ l1, l3, l4 }, null, 2)); }
}

console.log(`\n${totalPass} passed, ${totalFail} failed`);
process.exit(totalFail > 0 ? 1 : 0);
