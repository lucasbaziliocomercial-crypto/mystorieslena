// Verificação rápida: roda parseMarkdownErrorList contra amostras reais de
// formato que o Revisor emite. Roda com: node scripts/test-parse-markdown-errors.mjs
import {
  parseMarkdownErrorList,
  countMarkdownErrorNumbers,
  parseRevisorNota,
  parseRevisorHateRisk,
  computeRevisorEval,
  hasCanonMeta,
  stripCanonMeta,
  hasCanonBanner,
  stripCanonBanner,
  hasEditorialNote,
  stripEditorialNote,
  isNoOpCorrection,
  applyCorrections,
  parseRevisorErrors,
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

// ── CÂNONE nas correções (bug recorrente): o cânone JAMAIS pode entrar na prosa
//    nem no card. stripCanonMeta (cards) limpa tarja + citação ENDURECIDA;
//    stripCanonBanner (prosa) limpa SÓ a tarja. Prosa legítima com "o cânone"
//    como substantivo ("o cânone bíblico", "segundo o cânone da Igreja") fica
//    INTACTA — é o falso-positivo GRAVÍSSIMO que apagaria texto da autora. ──
const canonStrip = [
  // [input, esperado] — stripCanonMeta (caminho dos CARDS).
  ["Helena entrou na sala, conforme o cânone.", "Helena entrou na sala."],
  ["Ela sorriu (conforme o cânone).", "Ela sorriu."],
  [
    "Helena Marques entrou, alinhado com o CÂNONE (Helena Marques, 32 anos).",
    "Helena Marques entrou.",
  ],
  // Citação com vírgula imediata depois de "cânone" (pontuação terminal) → casa.
  ["Ele assentiu, segundo o cânone, e saiu.", "Ele assentiu, e saiu."],
  // Tarja do bloco de cânone vazada → some (sobra a prosa real).
  [
    "━━━ CÂNONE DE ENTIDADES — fonte canônica ━━━\nHelena entrou.",
    "\nHelena entrou.",
  ],
  // PROSA LEGÍTIMA com "cânone" SUBSTANTIVO (seguido de palavra) → INTACTA.
  // Estes 3 são exatamente o falso-positivo que o revisor-rigoroso pegou.
  ["Segundo o cânone da Igreja Católica, isso era pecado.", "Segundo o cânone da Igreja Católica, isso era pecado."],
  ["De acordo com o cânone budista, o desejo é a raiz do sofrimento.", "De acordo com o cânone budista, o desejo é a raiz do sofrimento."],
  ["Conforme o cânone bíblico, havia setenta e três livros.", "Conforme o cânone bíblico, havia setenta e três livros."],
  ["Ela estudou o cânone literário na faculdade.", "Ela estudou o cânone literário na faculdade."],
  ["Conforme combinado, ela saiu mais cedo.", "Conforme combinado, ela saiu mais cedo."],
];
for (const [input, expected] of canonStrip) {
  const got = stripCanonMeta(input);
  const ok = got === expected;
  console.log(
    `${ok ? "✅ PASS" : "❌ FAIL"} stripCanonMeta(${JSON.stringify(input.slice(0, 40))}) → ${JSON.stringify(got)}`,
  );
  if (ok) totalPass++; else { totalFail++; console.log(`   esperado ${JSON.stringify(expected)}`); }
}
// stripCanonBanner (caminho da PROSA): remove SÓ a tarja; JAMAIS a citação inline
// (na prosa, a citação daria falso-positivo). Trava a separação dos dois caminhos.
const bannerCases = [
  ["━━━ CÂNONE DE ENTIDADES — fonte ━━━\nHelena.", "\nHelena."],
  // Citação inline NA PROSA fica INTACTA (banner-only não toca).
  ["Ela sorriu (conforme o cânone).", "Ela sorriu (conforme o cânone)."],
  ["Segundo o cânone da Igreja, isso era pecado.", "Segundo o cânone da Igreja, isso era pecado."],
];
for (const [input, expected] of bannerCases) {
  const got = stripCanonBanner(input);
  const ok = got === expected;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} stripCanonBanner(${JSON.stringify(input.slice(0, 38))}) → ${JSON.stringify(got)}`);
  if (ok) totalPass++; else { totalFail++; console.log(`   esperado ${JSON.stringify(expected)}`); }
}
// hasCanonMeta (cards): true só pro meta; false pra "o cânone" substantivo.
for (const [input, expectMeta] of [
  ["conforme o cânone", true],
  ["CÂNONE DE ENTIDADES", true],
  ["segundo o cânone budista", false],
  ["o cânone literário", false],
  ["uma tarde qualquer", false],
]) {
  const got = hasCanonMeta(input);
  const ok = got === expectMeta;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} hasCanonMeta(${JSON.stringify(input)}) → ${got}`);
  if (ok) totalPass++; else totalFail++;
}
// hasCanonBanner (prosa): só a tarja conta; citação inline NÃO.
for (const [input, expectBanner] of [
  ["CÂNONE DE ENTIDADES", true],
  ["conforme o cânone", false],
  ["Segundo o cânone da Igreja", false],
]) {
  const got = hasCanonBanner(input);
  const ok = got === expectBanner;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} hasCanonBanner(${JSON.stringify(input)}) → ${got}`);
  if (ok) totalPass++; else totalFail++;
}
// applyCorrections: trecho_corrigido contaminado por cânone NÃO chega na prosa.
{
  const base = "Helen entrou na sala.";
  const errs = [
    {
      id: "1", numero: "1", gravidade: "gravissimo", titulo: "nome",
      trechoOriginal: "Helen entrou na sala.",
      trechoCorrigido: "Helena entrou na sala, conforme o cânone.",
      porqueAlterado: "padronização",
    },
  ];
  const { text, appliedIds } = applyCorrections(base, errs);
  const ok = text === "Helena entrou na sala." && appliedIds.length === 1 && !hasCanonMeta(text);
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} applyCorrections strips canon from prose → ${JSON.stringify(text)}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify({ text, appliedIds }, null, 2)); }
}
// parseRevisorErrors: o trecho_corrigido do card já sai sem cânone.
{
  const xml = `<erros_detalhados>
<erro numero="1" gravidade="gravissimo" titulo="nome">
<trecho_original>Helen sorriu.</trecho_original>
<trecho_corrigido>Helena sorriu (conforme o cânone).</trecho_corrigido>
<por_que_alterado>padronização pela 1ª aparição</por_que_alterado>
</erro>
</erros_detalhados>`;
  const errs = parseRevisorErrors(xml, 1);
  const tc = errs[0]?.trechoCorrigido ?? "";
  const ok = errs.length === 1 && tc === "Helena sorriu." && !hasCanonMeta(tc);
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} parseRevisorErrors strips canon from card → ${JSON.stringify(tc)}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify(errs, null, 2)); }
}

// ── NOTA EDITORIAL do Revisor entre colchetes (bug 1.0.88, "muito grave"): o
//    Revisor, sem o nome canônico, escreve "[substitua X pelo nome do cânone…]"
//    no lugar da prosa e o find+replace cravava o metadado na história final.
//    hasEditorialNote detecta SÓ o colchete + marcador editorial (zero falso-
//    positivo na prosa); a correção com nota vira INFORMATIVA (trecho_corrigido
//    zerado) e JAMAIS é aplicada. ──
const SOREN_NOTE =
  '[NOME NÃO MENCIONE — substitua "Soren Malvorne" e todas as ocorrências de "Soren" pelo nome que a roteirista definir para este personagem no cânone, ou adicione-o ao cânone de entidades antes de aplicar a correção automática.]';
for (const [input, expected] of [
  [SOREN_NOTE, true],
  ["[adicione ao cânone de entidades antes de prosseguir]", true],
  ["[substitua o nome aqui]", true],
  ["[NOME NÃO MENCIONE — definir depois]", true],
  ["[ver ocorrências de Soren no capítulo]", true],
  ["[nota da roteirista pendente]", true],
  // Benignos: colchete SEM marcador editorial → NÃO casa (não vira contaminação).
  ["[1]", false],
  ["[risos]", false],
  ["[...]", false],
  // Sem colchete: "substitua"/"cânone" soltos na prosa NÃO casam (exige colchete).
  ["Ela pediu que ele substituísse a fechadura.", false],
  ["Segundo o cânone da Igreja, era pecado.", false],
  ["uma tarde qualquer", false],
]) {
  const got = hasEditorialNote(input);
  const ok = got === expected;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} hasEditorialNote(${JSON.stringify(input.slice(0, 42))}) → ${got}`);
  if (ok) totalPass++; else totalFail++;
}
// stripEditorialNote (caminho da PROSA): remove a nota colapsando o espaço,
// preserva a prosa legítima.
for (const [input, expected] of [
  ["Aksel subiu e [NOME NÃO MENCIONE — substitua Soren] correu atrás dele.", "Aksel subiu e correu atrás dele."],
  // Sem nota → passthrough idêntico (early-return).
  ["Helena entrou na sala devagar.", "Helena entrou na sala devagar."],
  // Prosa legítima com "o cânone" substantivo (sem colchete) → intacta.
  ["Segundo o cânone da Igreja, era pecado.", "Segundo o cânone da Igreja, era pecado."],
]) {
  const got = stripEditorialNote(input);
  const ok = got === expected;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} stripEditorialNote(${JSON.stringify(input.slice(0, 46))}) → ${JSON.stringify(got)}`);
  if (ok) totalPass++; else { totalFail++; console.log(`   esperado ${JSON.stringify(expected)}`); }
}
// parseRevisorErrors: trecho_corrigido com nota editorial → ZERADO (card vira
// informativo); o por_que_alterado sobrevive pra a roteirista decidir.
{
  const xml = `<erros_detalhados>
<erro numero="1" gravidade="gravissimo" titulo="nome fora do cânone">
<trecho_original>e Soren correu atrás dele para alcançá-lo.</trecho_original>
<trecho_corrigido>e ${SOREN_NOTE} — Aksel — ele disse.</trecho_corrigido>
<por_que_alterado>"Soren Malvorne" não está no cânone; a roteirista precisa definir o nome.</por_que_alterado>
</erro>
</erros_detalhados>`;
  const errs = parseRevisorErrors(xml, 2);
  const e = errs[0];
  const ok =
    errs.length === 1 &&
    e.trechoCorrigido === "" &&
    !hasEditorialNote(e.trechoCorrigido) &&
    e.porqueAlterado.includes("cânone");
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} parseRevisorErrors zera trecho_corrigido com nota editorial → ${JSON.stringify(e?.trechoCorrigido)}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify(errs, null, 2)); }
}
// applyCorrections: erro com nota editorial JAMAIS aplicado — a prosa fica
// intacta e o metadado NUNCA é cravado (a queixa central da roteirista).
{
  const base = "Aksel subiu os degraus e Soren correu atrás dele para alcançá-lo.";
  const errs = [
    {
      id: "1", numero: "1", gravidade: "gravissimo", titulo: "nome",
      trechoOriginal: "e Soren correu atrás dele para alcançá-lo.",
      trechoCorrigido: `e ${SOREN_NOTE} — Aksel disse.`,
      porqueAlterado: "nome fora do cânone",
    },
  ];
  const { text, appliedIds, failedIds } = applyCorrections(base, errs);
  const ok = text === base && appliedIds.length === 0 && failedIds.includes("1") && !hasEditorialNote(text);
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} applyCorrections NÃO aplica correção com nota editorial → prosa intacta`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify({ text, appliedIds, failedIds }, null, 2)); }
}
// applyCorrections sweep final: nota editorial JÁ cravada na prosa (roteiro
// contaminado na 1.0.88) é limpa ao aplicar qualquer correção não-relacionada.
{
  const base = `Aksel subiu e ${SOREN_NOTE} correu atrás dele. Helen sorriu.`;
  const errs = [
    {
      id: "1", numero: "1", gravidade: "interfere", titulo: "nome",
      trechoOriginal: "Helen sorriu.",
      trechoCorrigido: "Helena sorriu.",
      porqueAlterado: "padronização",
    },
  ];
  const { text } = applyCorrections(base, errs);
  const ok =
    !hasEditorialNote(text) &&
    text.includes("Helena sorriu.") &&
    text.includes("Aksel subiu e correu atrás dele.");
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} applyCorrections sweep final limpa nota pré-existente da prosa → ${JSON.stringify(text)}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify({ text }, null, 2)); }
}

// ── NO-OP (bug 12/06/2026): o Revisor cita a âncora, repete-a IDÊNTICA no
//    trecho_corrigido e descreve a correção real só no por_que_alterado/AVISO.
//    A engine rejeita o par igual e a UI mostrava "trecho não encontrado" num
//    trecho que EXISTE. isNoOpCorrection detecta (normaliza só whitespace
//    horizontal, preserva quebras) → o parser zera o trecho_corrigido (card
//    informativo). ──
for (const [a, b, expected, nome] of [
  ["Marco Rinaldi não dizia obrigado.", "Marco Rinaldi não dizia obrigado.", true, "idêntico"],
  ["Eu fui   para a mesa.\n", "Eu fui para a mesa.", true, "só whitespace horizontal difere"],
  // Substituição real (palavras diferentes) → NÃO é no-op.
  ["com a planilha aberta na minha frente vazia", "com a planilha aberta na frente dele, vazia", false, "substituição real"],
  // Re-quebra de parágrafo ("a b" → "a\n\nb") É mudança real → NÃO é no-op.
  ["Ele entrou. Ela saiu.", "Ele entrou.\n\nEla saiu.", false, "re-quebra de parágrafo"],
  // Inserção (âncora + texto novo) → MAIS LONGO → NÃO é no-op.
  ["Ela fechou a porta.", "Ela fechou a porta.\n\nNa manhã seguinte, o café estava pronto.", false, "inserção âncora"],
  // Troca só de aspas (« por ") É correção legítima → NÃO é no-op.
  ['Ele disse «oi».', 'Ele disse "oi".', false, "troca de aspas"],
]) {
  const got = isNoOpCorrection(a, b);
  const ok = got === expected;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} isNoOpCorrection [${nome}] → ${got}`);
  if (ok) totalPass++; else { totalFail++; console.log(`   esperado ${expected}`); }
}
// parseRevisorErrors: par no-op → trecho_corrigido ZERADO (card informativo);
// o por_que_alterado/AVISO com a correção real sobrevive pra a roteirista.
{
  const para = "Eu fui para a minha mesa e refiz a coluna F. Levou vinte minutos.";
  const xml = `<erros_detalhados>
<erro numero="2" gravidade="interfere" parte="1" capitulo="3" titulo="Frase truncada sobre a planilha">
<trecho_original>${para}</trecho_original>
<trecho_corrigido>${para}</trecho_corrigido>
<por_que_alterado>AVISO: o erro real é a frase anterior "com a planilha aberta na minha frente vazia" — substituir por "com a planilha aberta na frente dele, vazia".</por_que_alterado>
</erro>
</erros_detalhados>`;
  const errs = parseRevisorErrors(xml, 1);
  const e = errs[0];
  const ok =
    errs.length === 1 &&
    e.trechoCorrigido === "" &&
    e.trechoOriginal === para &&
    e.porqueAlterado.includes("AVISO:");
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} parseRevisorErrors zera trecho_corrigido em par no-op → ${JSON.stringify(e?.trechoCorrigido)}`);
  if (ok) totalPass++; else { totalFail++; console.log(JSON.stringify(errs, null, 2)); }
}

console.log(`\n${totalPass} passed, ${totalFail} failed`);
process.exit(totalFail > 0 ? 1 : 0);
