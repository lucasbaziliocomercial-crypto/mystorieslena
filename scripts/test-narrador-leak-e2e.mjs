// E2E do fix "vazamento do metadado 'o narrador'" na milionário-3p (Parte 2).
//
// NÃO chama o modelo (isso exige OAuth + cota). Cobre o caminho DETERMINÍSTICO
// que o fix depende de ponta a ponta: uma vez que o Revisor reforçado emite o
// card do vazamento, o app TEM que produzir uma correção APLICÁVEL de 1 clique
// que remove o "narrador" da prosa — que era justamente o que estava quebrado
// (o Revisor velho ou não gerava card, ou o subclassificava).
//
// Fluxo testado: relatório enxuto do Revisor (markdown + <erros_detalhados>)
//   → parseRevisorErrors  → cards aplicáveis, gravidade certa (💀 duro / 🟡 didático)
//   → applyCorrections     → prosa final com ZERO "narrador", onisciência legítima intacta
//
// Além do caminho feliz, trava as duas defesas que o prompt reforçado exige do
// Revisor: par no-op (trecho_original ≡ corrigido) e nota editorial entre
// colchetes JAMAIS viram correção aplicável (não cravam metadado na prosa).
//
// Roda com: node scripts/test-narrador-leak-e2e.mjs
import {
  parseRevisorErrors,
  applyCorrections,
  isNoOpCorrection,
  hasEditorialNote,
} from "../lib/parse-revisor-output.ts";

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

// ─────────────────────────────────────────────────────────────────────────
// Prosa da Escrita (Parte 2 onisciente, milionário-3p) com os vazamentos
// REAIS extraídos dos roteiros da roteirista ("87 rowan" / "TESTE ROWAN").
// Inclui de propósito UMA linha de onisciência LEGÍTIMA que NÃO pode ser tocada.
// ─────────────────────────────────────────────────────────────────────────
const LEGIT_OMNISCIENT =
  "Ela sentiu a garganta apertar. No fundo, sabia que aquela noite terminaria mal.";

const chapterProse = `## Capítulo 2 — O reencontro

O salão dos Hawthorne fervilhava de convidados. Noelle chegou tarde, o vestido cor de vinho, o cabelo em coque baixo. Griffin, do outro lado do salão, viu-a antes que ela o visse — e o narrador registrou o instante exato em que ele esqueceu a conversa com o investidor à frente e precisou de um segundo inteiro para retomar o fôlego.

${LEGIT_OMNISCIENT}

— Eu tenho medo — ele confessou. E o narrador registrou o quanto aquela palavra pesava na boca dele.

Bennett, do lado de dentro, sabia exatamente o que ela estava pensando. Ele aprendeu a ler a tensão minúscula que aparecia entre as sobrancelhas dela quando o medo antigo subia.`;

// ─────────────────────────────────────────────────────────────────────────
// Relatório ENXUTO que o Revisor reforçado emite: 2 vazamentos duros (💀) +
// 1 "narrador didático" (🟡). trecho_corrigido = prosa pura que CONTA o fato.
// ─────────────────────────────────────────────────────────────────────────
const revisorOutput = `# ❌ PRINCIPAIS ERROS

💀 Erro #1 [Gravíssimo] — Vazamento do metadado "o narrador" na prosa (Griffin no salão).
💀 Erro #2 [Gravíssimo] — Vazamento do metadado "o narrador" (confissão de medo).
🟡 Erro #3 [Atenção] — Narrador didático: anúncio onisciente redundante (Bennett).

🎯 NÍVEL DE RISCO DE HATE: 🟡 MÉDIO — a quebra de imersão do narrador visível irrita.

💣 NOTA FINAL (0 a 10): 7 — boa prosa, mas o narrador se anuncia várias vezes na Parte 2.

<erros_detalhados>
<erro numero="1" gravidade="gravissimo" parte="2" capitulo="2" titulo="Metadado o narrador (salao)">
<trecho_original>
Griffin, do outro lado do salão, viu-a antes que ela o visse — e o narrador registrou o instante exato em que ele esqueceu a conversa com o investidor à frente e precisou de um segundo inteiro para retomar o fôlego.
</trecho_original>
<trecho_corrigido>
Griffin, do outro lado do salão, viu-a antes que ela o visse — e naquele instante esqueceu a conversa com o investidor à frente e precisou de um segundo inteiro para retomar o fôlego.
</trecho_corrigido>
<por_que_alterado>
Remove a personificação do narrador; conta o instante direto, mantendo o foco onisciente em Griffin.
</por_que_alterado>
</erro>
<erro numero="2" gravidade="gravissimo" parte="2" capitulo="2" titulo="Metadado o narrador (medo)">
<trecho_original>
— Eu tenho medo — ele confessou. E o narrador registrou o quanto aquela palavra pesava na boca dele.
</trecho_original>
<trecho_corrigido>
— Eu tenho medo — ele confessou, e a palavra pesou na boca dele.
</trecho_corrigido>
<por_que_alterado>
Elimina "o narrador registrou"; a onisciência continua, contada de forma direta.
</por_que_alterado>
</erro>
<erro numero="3" gravidade="atencao" parte="2" capitulo="2" titulo="Narrador didatico (Bennett)">
<trecho_original>
Bennett, do lado de dentro, sabia exatamente o que ela estava pensando. Ele aprendeu a ler a tensão minúscula que aparecia entre as sobrancelhas dela quando o medo antigo subia.
</trecho_original>
<trecho_corrigido>
Bennett sabia exatamente o que ela estava pensando. Tinha aprendido a ler a tensão minúscula que aparecia entre as sobrancelhas dela quando o medo antigo subia.
</trecho_corrigido>
<por_que_alterado>
Corta o anúncio didático "do lado de dentro" — a onisciência legítima permanece, sem editorializar.
</por_que_alterado>
</erro>
</erros_detalhados>`;

// ── 1) PARSE ───────────────────────────────────────────────────────────────
const errors = parseRevisorErrors(revisorOutput, 2);
check("1. parseia os 3 cards do bloco <erros_detalhados>", errors.length === 3, `n=${errors.length}`);

const [e1, e2, e3] = errors;
check(
  "2. gravidades certas — 💀/💀/🟡 (duro=gravissimo, didático=atencao)",
  e1?.gravidade === "gravissimo" &&
    e2?.gravidade === "gravissimo" &&
    e3?.gravidade === "atencao",
  `${e1?.gravidade} / ${e2?.gravidade} / ${e3?.gravidade}`,
);

check(
  "3. todos os cards são APLICÁVEIS (trecho_corrigido não-vazio, não zerado)",
  errors.every((e) => typeof e.trechoCorrigido === "string" && e.trechoCorrigido.trim().length > 0),
);

check(
  "4. nenhum card é no-op (trecho_original ≠ trecho_corrigido)",
  errors.every((e) => !isNoOpCorrection(e.trechoOriginal ?? "", e.trechoCorrigido ?? "")),
);

check(
  "5. nenhum trecho_corrigido tem nota editorial entre colchetes",
  errors.every((e) => !hasEditorialNote(e.trechoCorrigido ?? "")),
);

check(
  "6. nenhum trecho_corrigido reintroduz a palavra 'narrador'",
  errors.every((e) => !/\bnarrador\b/i.test(e.trechoCorrigido ?? "")),
);

// ── 2) APPLY ────────────────────────────────────────────────────────────────
const { text, appliedIds, failedIds } = applyCorrections(chapterProse, errors);

check(
  "7. applyCorrections aplica os 3 cards (nenhum falha)",
  appliedIds.length === 3 && failedIds.length === 0,
  `applied=${appliedIds.length} failed=${failedIds.length}`,
);

check(
  "8. a prosa final tem ZERO 'narrador' (vazamento eliminado)",
  !/\bnarrador\b/i.test(text),
);

check(
  "9. o vazamento duro foi trocado pela narração direta",
  text.includes("e naquele instante esqueceu a conversa com o investidor à frente") &&
    text.includes("ele confessou, e a palavra pesou na boca dele"),
);

check(
  "10. onisciência LEGÍTIMA preservada intacta (não mutilou prosa boa)",
  text.includes(LEGIT_OMNISCIENT),
);

check(
  "11. a correção didática 🟡 também foi aplicada (Bennett sem 'do lado de dentro')",
  text.includes("Bennett sabia exatamente o que ela estava pensando. Tinha aprendido") &&
    !text.includes("Bennett, do lado de dentro"),
);

// ── 3) DEFESAS que o prompt reforçado exige do Revisor ───────────────────────
// (a) par NO-OP: correção real enterrada no por_que_alterado → NÃO aplica.
{
  const noOpReport = `<erros_detalhados>
<erro numero="1" gravidade="gravissimo" parte="2" capitulo="2" titulo="No-op">
<trecho_original>
E o narrador registrou o quanto aquela palavra pesava na boca dele.
</trecho_original>
<trecho_corrigido>
E o narrador registrou o quanto aquela palavra pesava na boca dele.
</trecho_corrigido>
<por_que_alterado>
AVISO: trocar "o narrador registrou o quanto" por "e a palavra pesava".
</por_que_alterado>
</erro>
</erros_detalhados>`;
  const errs = parseRevisorErrors(noOpReport, 2);
  const base = "E o narrador registrou o quanto aquela palavra pesava na boca dele.";
  const res = applyCorrections(base, errs);
  check(
    "12. par no-op vira card informativo e NÃO é aplicado (não some prosa nem finge aplicar)",
    res.appliedIds.length === 0 && res.text === base,
    `applied=${res.appliedIds.length}`,
  );
}

// (b) NOTA EDITORIAL entre colchetes no corrigido → JAMAIS crava metadado na prosa.
{
  const notaReport = `<erros_detalhados>
<erro numero="1" gravidade="gravissimo" parte="2" capitulo="2" titulo="Nota editorial">
<trecho_original>
E o narrador registrou o quanto aquela palavra pesava na boca dele.
</trecho_original>
<trecho_corrigido>
[substitua "o narrador registrou" pela narração direta antes de aplicar a correção]
</trecho_corrigido>
<por_que_alterado>
Metadado do narrador na prosa.
</por_que_alterado>
</erro>
</erros_detalhados>`;
  const errs = parseRevisorErrors(notaReport, 2);
  const base = "E o narrador registrou o quanto aquela palavra pesava na boca dele.";
  const res = applyCorrections(base, errs);
  check(
    "13. nota editorial [entre colchetes] não é aplicada — prosa nunca recebe metadado",
    res.appliedIds.length === 0 && !/\[substitua/i.test(res.text),
    `applied=${res.appliedIds.length}`,
  );
}

console.log(`\n${pass} passou · ${fail} falhou`);
process.exit(fail > 0 ? 1 : 0);
