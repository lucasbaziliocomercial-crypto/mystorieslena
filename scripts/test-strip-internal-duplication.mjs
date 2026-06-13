// Testa o detector/removedor de DUPLICAÇÃO INTERNA de capítulo
// (lib/strip-internal-duplication.ts) — o "restart" do modelo, em que o cap
// reinicia no meio e re-emite cenas que já tinha escrito, SEM novo cabeçalho.
//
// Foco DUPLO:
//   • RECALL — pega o restart inequívoco (o bug "Cap. 3 — bloco inteiro repetido").
//   • PRECISÃO — NÃO toca em prosa legítima (eco curto, carta relida com cena
//     depois, repetição abaixo do limiar). Falso-positivo aqui apaga cap bom.
//
// Importa o .ts direto (Node ≥ 22 strip-types). Run:
//   node scripts/test-strip-internal-duplication.mjs
import {
  detectInternalDuplication,
  stripInternalDuplication,
} from "../lib/strip-internal-duplication.ts";

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

// Gera um parágrafo determinístico com ~`words` palavras e um rótulo único, em
// tom de prosa (pontuação real, pra `countWords` contar parecido com romance).
function para(label, words) {
  const sentence = [];
  for (let i = 0; i < words; i++) sentence.push(`${label}${i}`);
  // Vira uma frase com vírgulas/ponto — countWords ignora pontuação.
  return sentence.join(" ") + ".";
}

const wc = (s) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>~|—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length;

// ── Blocos reutilizáveis (cada um bem acima de qualquer limiar isolado) ──
const intro = para("intro", 60);
const sceneA = para("alfa", 150);
const sceneB = para("beta", 130);
const restartScene = `${sceneA}\n\n${sceneB}`; // 2 parágrafos, ~280 palavras

// 1) RESTART INTEIRO — cap = [cópia boa] + [mesma cópia verbatim até o fim].
{
  const good = `${sceneA}\n\n${sceneB}`;
  const chapter = `${good}\n\n${good}`;
  const r = stripInternalDuplication(chapter);
  check(
    "1. restart inteiro é cortado",
    r.trimmed && r.content.trim() === good.trim(),
    `trimmed=${r.trimmed}, len=${wc(r.content)} (esperado ${wc(good)})`,
  );
  check(
    "1b. removeu ~a cópia repetida",
    r.trimmedWords >= 250,
    `trimmedWords=${r.trimmedWords}`,
  );
}

// 2) RESTART DO MEIO — intro + cena, depois reinicia a cena até o fim.
{
  const head = `${intro}\n\n${sceneA}\n\n${sceneB}`;
  const chapter = `${head}\n\n${restartScene}`; // restart = sceneA+sceneB de novo
  const r = stripInternalDuplication(chapter);
  check(
    "2. restart do meio mantém intro+1ª cena, corta o restart",
    r.trimmed && r.content.trim() === head.trim(),
    `trimmed=${r.trimmed}\n--- got ---\n${r.content}\n--- want ---\n${head}`,
  );
}

// 3) PRECISÃO — cap limpo (zero repetição) fica INTOCADO (mesma string).
{
  const clean = `${intro}\n\n${sceneA}\n\n${sceneB}\n\n${para("gamma", 140)}`;
  const r = stripInternalDuplication(clean);
  check(
    "3. cap limpo não é tocado (idêntico)",
    !r.trimmed && r.content === clean,
    `trimmed=${r.trimmed}`,
  );
}

// 4) PRECISÃO — repetição ABAIXO do limiar (bloco curto) NÃO é cortada.
{
  const tiny = para("curto", 30); // ~30 palavras < 200
  const chapter = `${intro}\n\n${tiny}\n\n${sceneA}\n\n${tiny}`;
  const r = stripInternalDuplication(chapter);
  check(
    "4. repetição curta (<200 palavras) NÃO é cortada",
    !r.trimmed && r.content === chapter,
    `trimmed=${r.trimmed}, trimmedWords=${r.trimmedWords}`,
  );
}

// 5) PRECISÃO — bloco grande repetido NO MEIO, com cena depois (cauda longa):
//    é o caso "carta relida e DEPOIS continua a história". NÃO cortar.
{
  const letter = `${para("carta", 130)}\n\n${para("carta2", 120)}`; // ~250
  const tailScene = para("depois", 120); // cauda > 40 palavras
  const chapter = `${intro}\n\n${letter}\n\n${para("meio", 80)}\n\n${letter}\n\n${tailScene}`;
  const r = stripInternalDuplication(chapter);
  check(
    "5. repetição grande no MEIO (com cena depois) NÃO é cortada",
    !r.trimmed && r.content === chapter,
    `trimmed=${r.trimmed} — falso-positivo destruiria a cena final`,
  );
}

// 6) IDEMPOTÊNCIA — rodar de novo no resultado já limpo não muda nada.
{
  const good = `${sceneA}\n\n${sceneB}`;
  const once = stripInternalDuplication(`${good}\n\n${good}`);
  const twice = stripInternalDuplication(once.content);
  check(
    "6. idempotente (2º passe não corta nada)",
    !twice.trimmed && twice.content === once.content,
    `twice.trimmed=${twice.trimmed}`,
  );
}

// 7) RESTART DUPLO — 3 cópias coladas convergem pra 1 (dentro de MAX_PASSES).
{
  const copy = `${para("aa", 120)}\n\n${para("bb", 120)}`;
  const chapter = `${copy}\n\n${copy}\n\n${copy}`;
  const r = stripInternalDuplication(chapter);
  check(
    "7. restart triplo converge pra 1 cópia",
    r.trimmed && r.content.trim() === copy.trim(),
    `got len=${wc(r.content)} (esperado ${wc(copy)})`,
  );
}

// 8) PRECISÃO — eco literário curto (frase de impacto repetida) NÃO dispara.
{
  const refrain = "Eu não devia.";
  const chapter = `${refrain}\n\n${sceneA}\n\n${refrain}\n\n${sceneB}\n\n${refrain}`;
  const r = stripInternalDuplication(chapter);
  check(
    "8. eco curto repetido (frase de impacto) NÃO é cortado",
    !r.trimmed && r.content === chapter,
    `trimmed=${r.trimmed}`,
  );
}

// 9) detect() devolve null pra cap saudável e objeto pro restart.
{
  const good = `${sceneA}\n\n${sceneB}`;
  check(
    "9a. detect(limpo) = null",
    detectInternalDuplication(`${intro}\n\n${good}`) === null,
  );
  const d = detectInternalDuplication(`${good}\n\n${good}`);
  check(
    "9b. detect(restart) aponta o bloco e o tamanho",
    d !== null && d.startBlock === 2 && d.blocks === 2 && d.words >= 250,
    `d=${JSON.stringify(d)}`,
  );
}

// 10) P2 com marcadores ✦ de POV — restart re-emite os marcadores; corta igual,
//     mantém a 1ª cópia (não quebra a lógica de POV/verde do export).
{
  const pov = `✦ RAFAEL — POV masculino\n\n${para("pov", 150)}\n\n${para("pov2", 120)}`;
  const chapter = `${pov}\n\n${pov}`;
  const r = stripInternalDuplication(chapter);
  check(
    "10. restart em P2 (com ✦) é cortado, mantém a 1ª cópia",
    r.trimmed && r.content.trim() === pov.trim(),
    `trimmed=${r.trimmed}`,
  );
}

// 11) PRECISÃO (ressalva da revisão rigorosa) — carta/documento relido VERBATIM
//     bem no FIM do cap (cauda 0), mas fração pequena do cap. A cobertura ≥30%
//     impede o falso-positivo (a carta é ~20% → preservada).
{
  const letterDoc = `${para("carta", 130)}\n\n${para("carta2", 120)}`; // ~250, 2 paras
  const middle = `${para("m1", 200)}\n\n${para("m2", 200)}\n\n${para("m3", 160)}`; // ~560
  // intro + carta + cena longa + a MESMA carta no fim (releitura legítima).
  const chapter = `${intro}\n\n${letterDoc}\n\n${middle}\n\n${letterDoc}`;
  const cov = wc(letterDoc) / wc(chapter);
  const r = stripInternalDuplication(chapter);
  check(
    "11. carta relida verbatim NO FIM (fração pequena) NÃO é cortada",
    !r.trimmed && r.content === chapter,
    `trimmed=${r.trimmed}, cobertura=${(cov * 100).toFixed(0)}% — cobertura<30% deve preservar`,
  );
}

console.log(`\n${pass} passou · ${fail} falhou`);
process.exit(fail > 0 ? 1 : 0);
