// E2E do RÓTULO DE POV no marcador (`✦ NOME — POV masculino/feminino`), pelas
// funções REAIS do pipeline — sem chamar o modelo (não exige OAuth/cota).
//
// Percorre o caminho inteiro que um roteiro faz no app:
//   Estrutura (nomes MMC/FMC) ─┐
//   saída bruta da Escrita ──► travas do run-escrita (stripInternalDuplication,
//     stripPovMarkersPart1 / stripDuplicateConsecutivePovMarkers, dedupChaptersLast)
//     ──► concatenateChapters (o que fica salvo) ──► export:
//            • roteiro inteiro   (DownloadEscritaButton → PDF/HTML)
//            • só a Parte 2      (CopyPartButton → colar no Google Docs)
//            • texto puro        (fallback do copiar)
//
// Bug de origem (21/07/2026): a roteirista abriu a Parte 2 e viu "✦ LUCA" sem
// NADA escrito identificando o POV masculino — ela lê o rótulo, não a cor.
// Causas: o rótulo só existia no export e sumia sem os `Nome:` da Estrutura; e
// quando o marcador JÁ trazia o rótulo, o export anexava outro por cima.
//
// Invariantes travadas aqui (as duas regras fixas da roteirista):
//   POV  · todo marcador da P2 sai com o rótulo do papel — masculino E feminino
//   POV  · rótulo nunca duplica, nunca contradiz a prosa, P1 nunca tem ✦
//   DUP  · nenhum parágrafo aparece repetido no roteiro final
//
// Roda com: node scripts/test-pov-role-tag-e2e.mjs
import { stripInternalDuplication } from "../lib/strip-internal-duplication.ts";
import { stripPovMarkersPart1 } from "../lib/strip-pov-markers-part1.ts";
import { stripDuplicateConsecutivePovMarkers } from "../lib/strip-duplicate-pov-markers.ts";
import { dedupChaptersLast } from "../lib/dedup-chapters.ts";
import { concatenateChapters } from "../lib/parse-escrita-output.ts";
import {
  escritaContentToHtml,
  escritaContentToPlainText,
  splitRoteiroByParts,
  extractMaleLeadFullNameFromEstrutura,
  extractFemaleLeadFullNameFromEstrutura,
} from "../lib/export-html.ts";

const GREEN = "#d9ead3"; // STYLE_HIGHLIGHT_MMC — destaque do POV masculino

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

// ─── Estrutura 1 (de onde saem os nomes do MMC/FMC) ──────────────────────────
const ESTRUTURA1 = `## PROTAGONISTA FEMININA (FMC)
Nome: Ivy Calloway
Idade: 27

## PROTAGONISTA MASCULINO (MMC)
Nome: Luca Ferrante
Idade: 34`;

// ─── Saída BRUTA da Escrita (com os defeitos que o modelo comete) ────────────
// P1 Cap 1: marcador do MMC VAZOU (formato novo, com rótulo) + duplicação
//           interna (o modelo reinicia e refaz o fim do capítulo).
// ⚠️ ≥200 palavras de propósito: o `stripInternalDuplication` só dispara em
// bloco repetido com ≥200 palavras e ≥30% do capítulo — o limiar existe pra não
// trimar prosa legítima (carta relida, refrão). Um fixture menor NÃO dispararia
// a trava e o teste estaria medindo a coisa errada.
const P1_BLOCO_A = `A cozinha estava fria daquele jeito bom, o mármore ainda segurando o resto da noite, e eu desci a escada descalça porque tinha aprendido, nos últimos meses, que o barulho do sapato acordava a casa inteira antes da hora e trazia perguntas que eu não queria responder naquele horário.

Coloquei o café na máquina e fiquei olhando a rua acordar sem pedir licença, indiferente a mim, ao que eu tinha decidido na madrugada e ao envelope que continuava em cima da bancada desde a noite anterior, fechado, esperando que alguém tivesse coragem de abrir primeiro.

Três fotos. Três casas. Todas fora do centro, todas com quintal, todas caras demais pra quem ainda fingia não ter escolhido nada e repetia, pra si mesma, que aquilo era só curiosidade de quem gosta de olhar vitrine sem entrar na loja.

Peguei a caneca com as duas mãos, encostei na pia e contei até dez do jeito que minha mãe ensinou, como se contar resolvesse alguma coisa além de me dar tempo de inventar uma frase que não entregasse o que eu estava sentindo.

O relógio do fogão marcava quatro e onze, e eu já sabia que não ia voltar a dormir, porque quem dorme é quem não tem uma pasta escondida embaixo de uma pilha de contas antigas na primeira gaveta do armário da cozinha.

Guardei a pasta antes que alguém descesse e perguntasse o que eu estava olhando com tanta atenção às quatro da manhã, e apaguei a luz da cozinha, e subi os degraus pisando na madeira do lado direito, que era a única que não rangia.`;

const P1_CAP1_BRUTO = `${P1_BLOCO_A}

✦ LUCA — POV masculino

Ele a observou da porta e soube, naquele instante, que não a deixaria partir de novo.

${P1_BLOCO_A}`;

const P1_CAP2_BRUTO = `Continuei subindo os degraus com o coração apertado, sem entender por que ainda ficava naquela casa depois de tudo o que tinha ouvido.

A porta do escritório estava encostada, e a luz de dentro dizia que ele não tinha dormido também.`;

// P2 Cap 1: heroína abre SEM marcador (o modelo a trata como padrão), marcador
// do MMC DUPLICADO em sequência, e o retorno dela com o nome em **negrito**.
const P2_CAP1_BRUTO = `Acordei com o braço dele pesado sobre o meu ventre, o quarto ainda escuro, e por um segundo inteiro não lembrei de nada do que tinha acontecido na véspera.

✦ LUCA — POV masculino

✦ LUCA — POV masculino

Eu a vi dormir e prometi, em silêncio, queimar o mundo inteiro antes de perdê-la outra vez.

✦ **IVY** — POV feminino

Desci pra biblioteca antes do sol nascer, com a pasta debaixo do braço e a decisão já tomada.`;

// ─── ETAPA 1 · travas do run-escrita (mesma ordem do motor da Escrita) ───────
console.log("\n— ETAPA 1 · travas determinísticas da Escrita —");
const chapters = [
  { number: 1, part: "Parte 1", title: "A ligação das quatro da manhã", content: P1_CAP1_BRUTO },
  { number: 2, part: "Parte 1", title: "Baby", content: P1_CAP2_BRUTO },
  { number: 1, part: "Parte 2", title: "O que eu matei por você", content: P2_CAP1_BRUTO },
];

let povRemovidos = [];
let marcadoresColapsados = 0;
let capsTrimados = [];
for (const ch of chapters) {
  const dup = stripInternalDuplication(ch.content);
  if (dup.trimmed) {
    ch.content = dup.content;
    capsTrimados.push(ch.number);
  }
  if (ch.part === "Parte 1") {
    const pov = stripPovMarkersPart1(ch.content);
    if (pov.removed.length > 0) {
      ch.content = pov.content;
      povRemovidos.push(...pov.removed);
    }
  } else {
    const dupPov = stripDuplicateConsecutivePovMarkers(ch.content);
    if (dupPov.removed > 0) {
      ch.content = dupPov.content;
      marcadoresColapsados += dupPov.removed;
    }
  }
}
const dedup = dedupChaptersLast(chapters);

check("DUP · duplicação interna do Cap 1 da P1 removida", capsTrimados.includes(1), `trimados=${capsTrimados}`);
check("POV · marcador do MMC vazado na P1 removido (com rótulo novo)", povRemovidos.length === 1 && povRemovidos[0].startsWith("LUCA"), JSON.stringify(povRemovidos));
check("POV · marcador duplicado em sequência na P2 colapsado", marcadoresColapsados === 1, `removidos=${marcadoresColapsados}`);
check("nenhum capítulo perdido no dedup", dedup.chapters.length === 3, `${dedup.chapters.length}`);

// ─── ETAPA 2 · roteiro salvo (o que a roteirista vê no app) ──────────────────
console.log("\n— ETAPA 2 · roteiro salvo (texto cru) —");
const ROTEIRO = concatenateChapters(dedup.chapters);

check("P1 · ZERO marcador ✦ no texto salvo", !ROTEIRO.split("PARTE 2")[0].includes("✦"), "sobrou ✦ na P1");
check("P2 · marcador do MMC com rótulo escrito no texto cru", ROTEIRO.includes("✦ LUCA — POV masculino"));
check("P2 · marcador da heroína com rótulo escrito no texto cru", /✦ \*{0,2}IVY\*{0,2} — POV feminino/.test(ROTEIRO));
check("P2 · marcador do MMC aparece 1× só (duplicata não voltou)", (ROTEIRO.match(/✦ LUCA — POV masculino/g) || []).length === 1);

// DUP · nenhum parágrafo repetido no roteiro inteiro (regra fixa da roteirista)
{
  const paras = ROTEIRO.split(/\n{2,}/)
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((p) => p.length > 80); // só prosa, ignora títulos/marcadores
  const vistos = new Set();
  const repetidos = paras.filter((p) => (vistos.has(p) ? true : (vistos.add(p), false)));
  check("DUP · nenhum parágrafo repetido no roteiro final", repetidos.length === 0, `${repetidos.length} repetido(s)`);
}

// ─── ETAPA 3 · nomes vindos da Estrutura (como os botões fazem) ──────────────
console.log("\n— ETAPA 3 · export do roteiro inteiro (download PDF/HTML) —");
const maleLeadName = extractMaleLeadFullNameFromEstrutura(ESTRUTURA1);
const femaleLeadName = extractFemaleLeadFullNameFromEstrutura(ESTRUTURA1);
check("nome completo do MMC lido da Estrutura", maleLeadName === "Luca Ferrante", String(maleLeadName));
check("nome completo da FMC lido da Estrutura", femaleLeadName === "Ivy Calloway", String(femaleLeadName));

const htmlFull = escritaContentToHtml(ROTEIRO, {
  maleLeadName,
  femaleLeadName,
  chapters: dedup.chapters,
});
const headings = (html) =>
  [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
const corte = htmlFull.indexOf("PARTE 2");
const htmlP1 = htmlFull.slice(0, corte);
const htmlP2 = htmlFull.slice(corte);

check("P1 · nenhum heading de POV (marcador vazado não vira nó no Docs)", headings(htmlP1).length === 0, JSON.stringify(headings(htmlP1)));
check("P1 · ZERO destaque verde", !htmlP1.includes(GREEN));
check("P1 · prosa da heroína preservada", htmlP1.includes("A cozinha estava fria"));
check("P1 · prosa do bloco vazado preservada (só o marcador saiu)", htmlP1.includes("Ele a observou da porta"));

const hP2 = headings(htmlP2);
check("P2 · heading do MMC com rótulo, sem duplicar", hP2.includes("✦ LUCA — POV masculino"), JSON.stringify(hP2));
check("P2 · heading da heroína com rótulo (negrito normalizado)", hP2.includes("✦ IVY — POV feminino"), JSON.stringify(hP2));
check("P2 · trecho implícito da heroína (sem ✦) recebe rótulo feminino", hP2.includes("✦ Ivy Calloway — POV feminino"), JSON.stringify(hP2));
check("P2 · NENHUM heading com rótulo duplicado", !hP2.some((h) => (h.match(/POV (masculino|feminino)/g) || []).length > 1), JSON.stringify(hP2));
check("P2 · TODO heading de POV tem rótulo (nenhum '✦ NOME' pelado)", hP2.every((h) => !h.startsWith("✦") || /— POV (masculino|feminino)$/.test(h)), JSON.stringify(hP2));
// ⚠️ Verde é checado NO PARÁGRAFO, não com `verde[^]*trecho` — esse regex casa
// o documento inteiro e dá verde como "presente" pra qualquer trecho que venha
// DEPOIS do bloco do MMC (falso-positivo que passa despercebido).
const paraCom = (html, trecho) =>
  [...html.matchAll(/<p [^>]*>[\s\S]*?<\/p>/g)]
    .map((m) => m[0])
    .find((p) => p.includes(trecho)) ?? "";
const ehVerde = (html, trecho) => paraCom(html, trecho).includes(GREEN);

check("P2 · prosa do MMC fica VERDE", ehVerde(htmlP2, "Eu a vi dormir"));
check("P2 · prosa da heroína NUNCA fica verde (abertura)", !ehVerde(htmlP2, "Acordei com o braço dele"));
check("P2 · prosa da heroína NUNCA fica verde (retorno)", !ehVerde(htmlP2, "Desci pra biblioteca"));
check("doc · verde aparece exatamente 1× (só o parágrafo do MMC)", (htmlFull.match(new RegExp(GREEN, "g")) || []).length === 1, `${(htmlFull.match(new RegExp(GREEN, "g")) || []).length}`);

// ─── ETAPA 4 · copiar SÓ a Parte 2 (colar no Google Docs) ────────────────────
console.log("\n— ETAPA 4 · copiar a Parte 2 (CopyPartButton) —");
{
  const { parte2 } = splitRoteiroByParts(ROTEIRO);
  const html = escritaContentToHtml(parte2, {
    maleLeadName,
    femaleLeadName,
    forceParte2: true,
    chapters: dedup.chapters.filter((c) => c.part === "Parte 2"),
  });
  const h = headings(html);
  check("copiar P2 · rótulos idênticos ao do doc inteiro", h.includes("✦ LUCA — POV masculino") && h.includes("✦ IVY — POV feminino"), JSON.stringify(h));
  check("copiar P2 · sem rótulo duplicado", !h.some((x) => (x.match(/POV (masculino|feminino)/g) || []).length > 1), JSON.stringify(h));
  check("copiar P2 · verde só no MMC", (html.match(new RegExp(GREEN, "g")) || []).length === 1);

  // Fallback texto puro (quando o destino não aceita HTML): o rótulo tem que
  // sobreviver — é o texto cru que ela lê, sem cor nenhuma.
  const texto = escritaContentToPlainText(parte2);
  check("copiar P2 · texto puro mantém o rótulo masculino", texto.includes("POV masculino"), texto.slice(0, 120));
  check("copiar P2 · texto puro mantém o rótulo feminino", texto.includes("POV feminino"), texto.slice(0, 120));
}

// ─── ETAPA 5 · idempotência (reexportar não muda nada) ───────────────────────
console.log("\n— ETAPA 5 · idempotência —");
{
  const again = escritaContentToHtml(ROTEIRO, {
    maleLeadName,
    femaleLeadName,
    chapters: dedup.chapters,
  });
  check("exportar 2× dá o MESMO HTML", again === htmlFull);

  // Rodar as travas de novo no conteúdo já limpo não pode mexer em nada.
  const reStrip = dedup.chapters.map((c) => {
    const d = stripInternalDuplication(c.content);
    const p =
      c.part === "Parte 1"
        ? stripPovMarkersPart1(d.content)
        : { content: stripDuplicateConsecutivePovMarkers(d.content).content, removed: [] };
    return p.content === c.content;
  });
  check("travas são no-op em roteiro já limpo", reStrip.every(Boolean));
}

console.log(`\n${pass} passaram · ${fail} falharam`);
if (fail > 0) process.exit(1);
