// Trava a limpeza dos MARCADORES DE ERRO injetados que vazam pra prosa da Escrita
// (lib/sanitize-escrita-content.ts). Quando o socket do claude.exe cai DEPOIS que
// já saiu prosa (máquina fraca), o "[ERRO] ...socket connection was closed..." é
// absorvido no corpo do último capítulo e ANTES chegava até o Google Docs — o
// "os erros no meio do texto" que a roteirista reportou (PROBLEMA #3). Também
// infla a contagem de palavras (PROBLEMA #2). O REPORT_ANCHORS do sanitizer NÃO
// pegava [ERRO], então adicionamos stripInjectedErrorMarkers.
//
// CRÍTICO: o corte vai só do marcador até o PRÓXIMO cabeçalho de capítulo — no
// conteúdo monolítico concatenado ele JAMAIS pode apagar os capítulos seguintes.
//
// Roda com: node scripts/test-strip-injected-error-markers.mjs   (Node ≥ 22)
import {
  hasInjectedErrorMarker,
  stripInjectedErrorMarkers,
  hasEscritaContamination,
  stripEscritaContamination,
} from "../lib/sanitize-escrita-content.ts";
import { countWords } from "../lib/word-count.ts";

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

const SOCKET =
  "[ERRO] Claude Code returned an error result: API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

// ── PROBLEMA #3, caso (a): marcador absorvido NO FIM do corpo de UM capítulo ──
{
  const dirty = `Ela abriu a porta e o encarou em silêncio.\n\n${SOCKET}`;
  check("a) detecta marcador no corpo", hasInjectedErrorMarker(dirty));
  const clean = stripInjectedErrorMarkers(dirty);
  check("a) prosa preservada", clean.includes("Ela abriu a porta e o encarou em silêncio."));
  check("a) marcador removido", !hasInjectedErrorMarker(clean));
  check("a) sem 'socket connection'", !/socket connection/i.test(clean));
}

// ── PROBLEMA #3, caso (b) — CRÍTICO: marcador no MEIO do monolítico NÃO pode ──
//    apagar os capítulos seguintes. Corta só até o próximo "## Capítulo".
{
  const dirty = [
    "## Capítulo 1 — O encontro",
    "",
    "Prosa do capítulo um até aqui.",
    "",
    SOCKET,
    "",
    "## Capítulo 2 — A ruptura",
    "",
    "Prosa do capítulo dois, inteirinha, que NÃO pode sumir.",
    "",
    "## Capítulo 3 — O retorno",
    "",
    "E o capítulo três fecha a Parte.",
  ].join("\n");
  const clean = stripInjectedErrorMarkers(dirty);
  check("b) marcador removido", !hasInjectedErrorMarker(clean));
  check("b) cap 1 preservado", clean.includes("Prosa do capítulo um até aqui."));
  check("b) cap 2 PRESERVADO (não apagou o resto)", clean.includes("Prosa do capítulo dois, inteirinha, que NÃO pode sumir."));
  check("b) cap 3 preservado", clean.includes("E o capítulo três fecha a Parte."));
  check("b) header cap 2 preservado", clean.includes("## Capítulo 2 — A ruptura"));
}

// ── PROBLEMA #2: sem o lixo, a contagem de palavras não vem inflada ──────────
{
  const prose = "Frase curta de prosa.";
  const dirty = `${prose}\n\n${SOCKET}`;
  const clean = stripInjectedErrorMarkers(dirty);
  check("#2 lixo inflava a contagem", countWords(dirty) > countWords(prose));
  check("#2 após limpar bate com a prosa pura", countWords(clean) === countWords(prose));
}

// ── Bloco de LOGIN absorvido (multi-linha) também é removido ─────────────────
{
  const dirty = `Prosa final do capítulo.\n\n[LOGIN NECESSÁRIO NO CLAUDE]\n\nVocê precisa estar logado.\nDetalhe técnico: 401`;
  const clean = stripInjectedErrorMarkers(dirty);
  check("login removido", !hasInjectedErrorMarker(clean));
  check("login: prosa preservada", clean.includes("Prosa final do capítulo."));
  check("login: sem 'precisa estar logado'", !/precisa estar logado/i.test(clean));
}

// ── Integração: hasEscritaContamination + stripEscritaContamination pegam ────
{
  const dirty = `## Capítulo 6 — Fim\n\nO último beijo.\n\n${SOCKET}`;
  check("contaminação detectada pela via geral", hasEscritaContamination(dirty));
  const clean = stripEscritaContamination(dirty);
  check("stripEscritaContamination remove o marcador", !hasInjectedErrorMarker(clean));
  check("stripEscritaContamination preserva a prosa", clean.includes("O último beijo."));
}

// ── Idempotência + NÃO tocar prosa legítima que menciona "erro" ──────────────
{
  const clean1 = stripInjectedErrorMarkers(`Prosa.\n\n${SOCKET}`);
  const clean2 = stripInjectedErrorMarkers(clean1);
  check("idempotente", clean1 === clean2);

  const legit = "Ele reconheceu o erro e pediu desculpas. Foi um erro de cálculo.";
  check("prosa com 'erro' não é contaminação", !hasInjectedErrorMarker(legit));
  check("prosa com 'erro' fica intacta", stripInjectedErrorMarkers(legit) === legit);
  check("texto limpo é no-op (===)", stripInjectedErrorMarkers(legit) === legit);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
