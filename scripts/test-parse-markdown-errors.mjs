// Verificação rápida: roda parseMarkdownErrorList contra amostras reais de
// formato que o Revisor emite. Roda com: node scripts/test-parse-markdown-errors.mjs
import { parseMarkdownErrorList, countMarkdownErrorNumbers } from "../lib/parse-revisor-output.ts";

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

console.log(`\n${totalPass} passed, ${totalFail} failed`);
process.exit(totalFail > 0 ? 1 : 0);
