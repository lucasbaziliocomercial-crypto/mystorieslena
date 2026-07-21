// Anti-duplicação de PARÁGRAFOS no pós-revisão (bug relatado pela roteirista em
// 21/07/2026: revisou tudo, aplicou os cards, colou no Google Docs e o roteiro
// tinha blocos de prosa repetidos).
//
// Dois vetores reais, ambos reproduzidos com o código de produção:
//
//   VETOR 1 — `applyCorrections` (lib/parse-revisor-output.ts) trocava TODAS as
//   ocorrências do `trecho_original`. Isso é certo pra correção LOCAL (erro
//   transversal: trocar uma palavra/frase repetida), mas quando o card INSERE
//   parágrafos (o Revisor pode emitir de 3 a 15 num `trecho_corrigido`), uma
//   âncora curta que aparece 2× no roteiro fazia o MESMO bloco de prosa ser
//   cravado nos dois lugares. Agora inserção de bloco → só a 1ª ocorrência.
//   Mesmo defeito estava clonado em `lib/apply-suggestion.ts`.
//
//   VETOR 2 — `dedupChapters` (estratégia "longest", usada em todo save/load)
//   punha o TÍTULO cru na chave, então o mesmo capítulo re-emitido com caixa
//   diferente ("O acordo" / "O Acordo") escapava do dedup e `concatenateChapters`
//   escrevia o capítulo DUAS VEZES no content.
//
// ⚠️ O que este teste também PROTEGE (não regredir "consertando" demais):
//   • a troca de todas as ocorrências continua valendo pra correção local;
//   • capítulos de Partes diferentes com o mesmo número NUNCA são fundidos
//     (a estratégia "longest" apagaria um deles — perder capítulo é pior).
//
// Roda com: node scripts/test-no-paragraph-duplication.mjs
import {
  applyCorrections,
  insertsParagraphs,
} from "../lib/parse-revisor-output.ts";
import { dedupChapters, dedupChaptersLast } from "../lib/dedup-chapters.ts";
import { concatenateChapters } from "../lib/parse-escrita-output.ts";

let pass = 0;
let fail = 0;
function check(nome, cond) {
  if (cond) {
    pass++;
    console.log(`✅ PASS  ${nome}`);
  } else {
    fail++;
    console.log(`❌ FAIL  ${nome}`);
  }
}

const err = (id, o, c) => ({
  id,
  gravidade: "interfere",
  titulo: id,
  descricao: "",
  porQueAlterado: "",
  trechoOriginal: o,
  trechoCorrigido: c,
});
const cap = (part, number, title, content) => ({ part, number, title, content });
const conta = (texto, agulha) => texto.split(agulha).length - 1;

console.log("─── insertsParagraphs (o discriminador) ───");
check(
  "troca de frase por frase → NÃO é inserção de bloco",
  insertsParagraphs("Ela sorriu.", "Ela sorriu, sem vontade nenhuma.") === false,
);
check(
  "parágrafo reescrito (bem maior, mas 1 parágrafo) → NÃO é bloco",
  insertsParagraphs("Ele saiu.", "Ele saiu batendo a porta, ".repeat(20)) === false,
);
check(
  "1 parágrafo → 3 parágrafos → É inserção de bloco",
  insertsParagraphs("Ela sorriu.", "Ela sorriu.\n\nEle não.\n\nO relógio bateu."),
);
check(
  "2 parágrafos → 2 parágrafos → NÃO é bloco",
  insertsParagraphs("A.\n\nB.", "A corrigido.\n\nB corrigido.") === false,
);
check(
  "quebra com espaços na linha em branco também conta",
  insertsParagraphs("Ela sorriu.", "Ela sorriu.\n   \nEle não."),
);

console.log("\n─── VETOR 1 · applyCorrections ───");
{
  // A mesma frase curta aparece em dois pontos legítimos do roteiro.
  const texto = [
    "## Capítulo 1",
    "",
    "Ela olhou pela janela.",
    "",
    "O silêncio pesava na sala.",
    "",
    "## Capítulo 4",
    "",
    "Outra cena, outro dia.",
    "",
    "O silêncio pesava na sala.",
    "",
    "Ele fechou a porta.",
  ].join("\n");

  const bloco = [
    "O silêncio pesava na sala como um corpo estranho.",
    "",
    "Ela contou os segundos até que ele falasse.",
    "",
    "Nada veio — só o tique do relógio.",
  ].join("\n");

  const r = applyCorrections(texto, [
    err("A1", "O silêncio pesava na sala.", bloco),
  ]);
  check(
    "card que INSERE bloco → aplicado só 1×, sem duplicar prosa",
    conta(r.text, "Ela contou os segundos") === 1,
  );
  check("card de inserção conta como aplicado", r.appliedIds.includes("A1"));
  check(
    "a 2ª ocorrência da âncora fica INTACTA (roteirista decide)",
    conta(r.text, "O silêncio pesava na sala.") === 1,
  );

  // Correção LOCAL: comportamento transversal PRESERVADO.
  const r2 = applyCorrections(texto, [
    err("A2", "O silêncio pesava na sala.", "O silêncio pesava no quarto."),
  ]);
  check(
    "correção local → continua trocando TODAS as ocorrências",
    conta(r2.text, "O silêncio pesava no quarto.") === 2,
  );
  check(
    "correção local não deixa resíduo da versão antiga",
    conta(r2.text, "O silêncio pesava na sala.") === 0,
  );

  // Inserção aditiva num texto com ocorrência única: segue funcionando.
  const unico = "Ela abriu a carta.\n\nEle esperava.";
  const r3 = applyCorrections(unico, [
    err("A3", "Ela abriu a carta.", "Ela abriu a carta.\n\nAs mãos tremiam."),
  ]);
  check(
    "inserção aditiva com ocorrência única → aplica normalmente",
    conta(r3.text, "As mãos tremiam.") === 1,
  );
  check(
    "inserção aditiva não some com o texto original",
    conta(r3.text, "Ela abriu a carta.") === 1,
  );
}

console.log("\n─── VETOR 2 · dedupChapters (título com caixa diferente) ───");
{
  const chapters = [
    cap("Parte 2", 3, "O acordo", "Ela assinou sem ler.\n\nEra tarde demais."),
    cap("Parte 2", 3, "O Acordo", "Ela assinou sem ler.\n\nEra tarde demais."),
  ];
  const { chapters: deduped } = dedupChapters(chapters);
  check("mesmo cap com caixa diferente no título → 1 capítulo", deduped.length === 1);
  const content = concatenateChapters(deduped);
  check(
    "content final sem parágrafo repetido",
    conta(content, "Ela assinou sem ler.") === 1,
  );

  const espacos = [
    cap("Parte 1", 2, "A  fuga ", "Correu.\n\nNão olhou pra trás."),
    cap("Parte 1", 2, "A fuga", "Correu.\n\nNão olhou pra trás."),
  ];
  check(
    "título com espaço extra/sobra também colapsa",
    dedupChapters(espacos).chapters.length === 1,
  );
}

console.log("\n─── Guardas: NÃO fundir o que é legitimamente diferente ───");
{
  // Cap 3 da Parte 1 e cap 3 da Parte 2 são capítulos DIFERENTES.
  const partes = [
    cap("Parte 1", 3, "O encontro", "Texto da Parte 1."),
    cap("Parte 2", 3, "O encontro", "Texto da Parte 2."),
  ];
  check(
    "mesmo número em Partes diferentes → NUNCA funde (não perde capítulo)",
    dedupChapters(partes).chapters.length === 2,
  );
  check(
    "os dois textos sobrevivem no content",
    conta(concatenateChapters(dedupChapters(partes).chapters), "Texto da Parte") === 2,
  );

  // Títulos realmente diferentes seguem sendo capítulos distintos.
  const titulos = [
    cap("Parte 2", 5, "A partida", "Um."),
    cap("Parte 2", 5, "O retorno", "Dois."),
  ];
  check(
    "títulos genuinamente diferentes NÃO colapsam",
    dedupChapters(titulos).chapters.length === 2,
  );

  // dedupChaptersLast (Escrita) não foi tocado.
  const last = dedupChaptersLast([
    cap("Parte 2", 4, "X", "velho"),
    cap("Parte 2", 4, "X", "novo"),
  ]);
  check(
    "dedupChaptersLast segue last-wins (intacto)",
    last.chapters.length === 1 && last.chapters[0].content === "novo",
  );
}

console.log(`\n${pass} passaram · ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
