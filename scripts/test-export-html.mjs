// Servidor local + asserts para o output de lib/export-html.ts.
//
// Modo padrão (sem args): roda os asserts e sai com exit code 0/1.
//   node scripts/test-export-html.mjs
//
// Modo servidor visual:
//   node scripts/test-export-html.mjs --serve
// Sobe HTTP em http://localhost:4567 pra inspecionar visualmente o HTML
// gerado em cada cenário (PARTE como h1, Capítulo como h2, ✦ POV como h3,
// destaque verde nas falas do MMC).

import http from "node:http";
import {
  buildEscritaHtmlDocument,
  detectMaleLeadFromFullRoteiro,
  detectMaleLeadName,
  escritaContentToHtml,
  extractMaleLeadNameFromEstrutura,
  splitRoteiroByParts,
} from "../lib/export-html.ts";

const ROTEIRO_COMPLETO = `# PARTE 1

## Capítulo 1 — A Frase no Corredor

A primeira coisa que ele tinha jurado pra mim foi numa quinta-feira de fevereiro num corredor de mansão, *que ia ser cuidadoso*. Ele tinha cumprido. Mesmo no pior, ele tinha cumprido.

Eu não respondi com palavra. A garganta tinha fechado.

Caspian olhou pra mim como quem olha pra alguém que já decidiu alguma coisa antes de saber que decidiu.

## Capítulo 2 — A Mansão

A casa em cima da minha mesa é pequena. Branca. Dois andares baixos, varanda que abre para o oceano, cozinha com uma janela tão grande que parece um quadro vivo.

Eu olho para essas plantas há semanas como quem olha para um filho que ainda não nasceu.

# PARTE 2

## Capítulo 7 — Reencontro

### ✦ Iris

Quinta-feira, vinte e três e trinta. Apartamento que Caspian alugou para mim em Chicago para os dias em que eu precisasse estar na cidade — coisa que ele explicou, com uma calma tão ensaiada que doeu, no segundo dia em que a gente voltou da casa da praia.

O apartamento é no décimo segundo andar, dois quartos, um sofá cinza claro, uma janela enorme virada para o rio. Eu estava deitada no sofá, sem maquiagem, com uma camiseta dele que eu tinha pegado por engano na mala.

### ✦ Caspian

Eu vi a mala antes de ela entrar no meu campo de visão.

Eu tinha sentido a casa diferente desde as seis da manhã — o jeito como o ar de uma casa fica quando alguém acordou pra ir embora. A Sra. Devereaux tinha andado mais devagar pelo corredor.

Quando a mala apareceu no patamar da escada, na mão dela, eu fechei o documento que estava na minha tela sem salvar.

### ✦ Iris

Eu cliquei no nome.

Celeste Moreau. Sessenta e poucos mil seguidores. Foto de perfil em preto e branco, ela em frente a uma janela de imobiliária com letreiro elegante.

## Capítulo 8 — Confronto

### ✦ Iris

Eu não dormi naquela noite. Fiquei olhando o teto até as cinco, contando as veias da madeira.

### ✦ Caspian

Eu acordei às cinco da manhã, como tenho acordado todos os dias desde que o Dr. Kessler colocou três palavras em cima da mesa. Faz três semanas que minhas pernas voltaram a obedecer.

### ✦ Iris

Quando ele entrou no quarto, eu fingi que estava dormindo.
`;

const ROTEIRO_SO_FMC = `# PARTE 1

## Capítulo 1 — Sem POV markers

Tudo da FMC, sem ✦. Esse é o caso típico da Parte 1 isolada.

Mais um parágrafo só pra ter texto.

## Capítulo 2 — Continua

Outro capítulo todo da FMC.
`;

// milionario-3p: Parte 1 narrada limitada à FMC (Maelys), Parte 2 inteira
// pelo POV do MMC (Sebastian). É o cenário do screenshot da regressão.
const ROTEIRO_3P_PARTE2_MMC_ONLY = `# PARTE 1

## Capítulo 1 — Inicio

### ✦ Maelys

Tudo aqui é POV da Maelys. Parte 1 inteira limitada a ela.

# PARTE 2

## Capítulo 1 — A Pasta na Primeira Gaveta

### ✦ Sebastian

A cozinha estava em silêncio do jeito que eu nunca soube apreciar antes dela.

— Você vai me cobrar entrada se ficar aí muito tempo — ela disse, sem levantar os olhos da tela.

Eu fiquei parado.

— Boa tarde — eu disse.
`;

// Helper: gera prosa de N palavras aproximadas, repetindo uma frase base.
function prose(words) {
  const sentence =
    "Esta é uma frase de teste razoavelmente longa pra atingir contagem de palavras realista no fixture.";
  // sentence ≈ 16 palavras. Repete até passar do alvo.
  const rounds = Math.max(1, Math.ceil(words / 16));
  return Array.from({ length: rounds }, () => sentence).join(" ");
}

// mafia normal: Parte 1 toda implícita (FMC narra sem ✦, conforme prompt),
// Parte 2 com ✦ HELENA (FMC) e ✦ SAVERIO (MMC) alternando, FMC com mais
// palavras que MMC. Formato real do prompt da máfia: linha isolada `✦ NOME`
// em CAIXA ALTA, SEM `### ` na frente.
const ROTEIRO_MAFIA_NORMAL = `# PARTE 1

## Capítulo 1 — Entrada

${prose(1500)}

# PARTE 2

## Capítulo 7 — Reencontro

✦ HELENA

${prose(700)}

— Boa noite — eu disse.

✦ SAVERIO

${prose(300)}

— Boa noite — respondi.
`;

// mafia com cliffhanger MMC: Parte 1 majoritariamente implícita (FMC) +
// um trecho curto ✦ SAVERIO no fim (cliffhanger MMC). Parte 2 com ambos.
const ROTEIRO_MAFIA_CLIFFHANGER = `# PARTE 1

## Capítulo 1 — Início

${prose(1500)}

## Capítulo 6 — Cliffhanger

✦ SAVERIO

${prose(200)}

# PARTE 2

## Capítulo 7 — Reencontro

✦ HELENA

${prose(600)}

— Boa noite — eu disse.

✦ SAVERIO

${prose(300)}

— Boa noite — respondi.
`;

// mafia onde o LLM escorregou e emitiu ♦ (BLACK DIAMOND SUIT, U+2666) no
// lugar de ✦ (FOUR POINTED BLACK STAR, U+2726) em alguns trechos do MMC.
// Cenário real do bug reportado: alguns ♦ DANTE no Google Docs viram texto
// solto (sem virar Heading 3 nem ganhar destaque verde) e a Parte 2 fica
// pintada parcialmente. O exporter precisa tolerar ambos os codepoints.
const ROTEIRO_MAFIA_DIAMANTE = `# PARTE 1

## Capítulo 1 — Entrada

${prose(1500)}

# PARTE 2

## Capítulo 7 — Reencontro

✦ HELENA

${prose(600)}

— Boa noite — eu disse.

♦ DANTE

${prose(300)}

— Boa noite — respondi.

## Capítulo 8 — Confronto

♦ DANTE

${prose(250)}

— Estou aqui — falei.
`;

// milionario-3p: Parte 2 começa pelo MMC e depois alterna pra FMC.
const ROTEIRO_3P_PARTE2_MMC_PRIMEIRO = `# PARTE 1

## Capítulo 1 — Inicio

### ✦ Maelys

Parte 1 só da FMC.

# PARTE 2

## Capítulo 1 — Abertura

### ✦ Sebastian

Eu acordei antes do despertador.

— Bom dia — eu disse.

### ✦ Maelys

Eu já estava na cozinha quando ele apareceu.

— Bom dia — respondi.
`;

// ============================================================================
// Asserts (modo padrão)
// ============================================================================

const GREEN_SPAN = '<span style="background-color: #d9ead3">';

function assertEq(label, actual, expected) {
  const ok = actual === expected;
  const status = ok ? "PASS" : "FAIL";
  console.log(`  [${status}] ${label}`);
  if (!ok) {
    console.log(`         esperado: ${JSON.stringify(expected)}`);
    console.log(`         recebido: ${JSON.stringify(actual)}`);
  }
  return ok;
}

function assertContains(label, haystack, needle) {
  const ok = haystack.includes(needle);
  const status = ok ? "PASS" : "FAIL";
  console.log(`  [${status}] ${label}`);
  if (!ok) {
    console.log(`         esperava conter: ${JSON.stringify(needle)}`);
  }
  return ok;
}

function assertNotContains(label, haystack, needle) {
  const ok = !haystack.includes(needle);
  const status = ok ? "PASS" : "FAIL";
  console.log(`  [${status}] ${label}`);
  if (!ok) {
    console.log(`         NÃO devia conter: ${JSON.stringify(needle)}`);
  }
  return ok;
}

function runAsserts() {
  let allOk = true;

  console.log("\n— 1p: roteiro completo (FMC=Iris, MMC=Caspian) —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_COMPLETO);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna 'Caspian'", mmcFull, "Caspian") && allOk;
    const html = escritaContentToHtml(ROTEIRO_COMPLETO);
    allOk = assertContains("Parte 2 do MMC tem destaque verde", html, GREEN_SPAN) && allOk;
  }

  console.log("\n— 1p: só Parte 2 isolada (CopyPartButton com forceParte2) —");
  {
    const { parte1, parte2 } = splitRoteiroByParts(ROTEIRO_COMPLETO);
    const mmcSlice = detectMaleLeadFromFullRoteiro(ROTEIRO_COMPLETO);
    allOk = assertEq("MMC detectado a partir do roteiro completo", mmcSlice, "Caspian") && allOk;

    const htmlP2 = escritaContentToHtml(parte2, { maleLeadName: mmcSlice, forceParte2: true });
    allOk = assertContains("HTML da Parte 2 contém destaque verde nas falas do MMC", htmlP2, GREEN_SPAN) && allOk;

    // Copiando Parte 1 isolada: maleLeadName: null (CopyPartButton path).
    const htmlP1 = escritaContentToHtml(parte1, { maleLeadName: null });
    allOk = assertNotContains("HTML da Parte 1 isolada NÃO tem destaque", htmlP1, GREEN_SPAN) && allOk;
  }

  console.log("\n— so-fmc: roteiro sem ✦ markers —");
  {
    const mmc = detectMaleLeadFromFullRoteiro(ROTEIRO_SO_FMC);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna null", mmc, null) && allOk;
    const html = escritaContentToHtml(ROTEIRO_SO_FMC);
    allOk = assertNotContains("Nenhum destaque verde no HTML", html, GREEN_SPAN) && allOk;
  }

  console.log("\n— 3p Parte 2 só com MMC (regressão do screenshot) —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_3P_PARTE2_MMC_ONLY);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna 'Sebastian'", mmcFull, "Sebastian") && allOk;

    // Heurística antiga: applied no recorte da Parte 2 sozinho, ela inverte/none.
    const { parte2 } = splitRoteiroByParts(ROTEIRO_3P_PARTE2_MMC_ONLY);
    const mmcLegacy = detectMaleLeadName(parte2);
    allOk = assertEq("Heurística legada NÃO consegue detectar (Parte 2 só com MMC)", mmcLegacy, null) && allOk;

    // Mas com o novo detector usando o roteiro completo, pegamos certo.
    const html = escritaContentToHtml(parte2, { maleLeadName: mmcFull, forceParte2: true });
    allOk = assertContains("HTML da Parte 2 contém destaque verde", html, GREEN_SPAN) && allOk;
  }

  console.log("\n— 3p Parte 2 começa pelo MMC, depois alterna —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_3P_PARTE2_MMC_PRIMEIRO);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna 'Sebastian'", mmcFull, "Sebastian") && allOk;

    // Heurística antiga aplicada no recorte da Parte 2 detectaria 'Maelys' como MMC (errado).
    const { parte2 } = splitRoteiroByParts(ROTEIRO_3P_PARTE2_MMC_PRIMEIRO);
    const mmcLegacy = detectMaleLeadName(parte2);
    allOk = assertEq("Heurística legada inverte (detecta 'Maelys' como MMC)", mmcLegacy, "Maelys") && allOk;

    const html = escritaContentToHtml(parte2, { maleLeadName: mmcFull, forceParte2: true });
    allOk = assertContains("HTML da Parte 2 contém destaque verde", html, GREEN_SPAN) && allOk;
    // E o destaque NÃO deve cobrir a fala da FMC (— Bom dia — respondi).
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Bom dia — respondi.`);
    allOk = assertEq("Fala da FMC NÃO está dentro do destaque verde", fmcGreenHit, false) && allOk;
  }

  console.log("\n— mafia normal: P1 toda implícita, P2 alterna FMC/MMC —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_MAFIA_NORMAL);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna 'SAVERIO'", mmcFull, "SAVERIO") && allOk;

    const { parte2 } = splitRoteiroByParts(ROTEIRO_MAFIA_NORMAL);
    const html = escritaContentToHtml(parte2, { maleLeadName: mmcFull, forceParte2: true });
    allOk = assertContains("HTML da Parte 2 contém destaque verde nas falas do MMC", html, GREEN_SPAN) && allOk;
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Boa noite — eu disse.`);
    allOk = assertEq("Fala da FMC NÃO está destacada", fmcGreenHit, false) && allOk;
  }

  console.log("\n— mafia cliffhanger: cliffhanger MMC em P1 NÃO pode destacar —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_MAFIA_CLIFFHANGER);
    allOk = assertEq("detectMaleLeadFromFullRoteiro retorna 'SAVERIO'", mmcFull, "SAVERIO") && allOk;

    const html = escritaContentToHtml(ROTEIRO_MAFIA_CLIFFHANGER, { maleLeadName: mmcFull });
    allOk = assertContains("HTML completo contém destaque verde (na P2)", html, GREEN_SPAN) && allOk;
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Boa noite — eu disse.`);
    allOk = assertEq("Fala da FMC NÃO está destacada", fmcGreenHit, false) && allOk;

    // Confirmar que o destaque só aparece DEPOIS do header de Parte 2.
    const partTwoIdx = html.indexOf("PARTE 2");
    const firstGreenIdx = html.indexOf(GREEN_SPAN);
    allOk = assertEq(
      "Primeiro destaque verde aparece DEPOIS de '# PARTE 2' (cliffhanger MMC em P1 não pinta)",
      firstGreenIdx > partTwoIdx && partTwoIdx !== -1,
      true,
    ) && allOk;
  }

  console.log("\n— mafia com ♦ no lugar de ✦: tolerância a look-alikes —");
  {
    const mmcFull = detectMaleLeadFromFullRoteiro(ROTEIRO_MAFIA_DIAMANTE);
    allOk = assertEq(
      "detectMaleLeadFromFullRoteiro pega 'DANTE' mesmo só com ♦",
      mmcFull,
      "DANTE",
    ) && allOk;

    const html = escritaContentToHtml(ROTEIRO_MAFIA_DIAMANTE, { maleLeadName: mmcFull });

    // O ♦ DANTE deve ter sido normalizado pra <h3>✦ DANTE</h3> (Heading 3 no
    // Docs → entrada no painel "Guias do documento").
    allOk = assertContains(
      "♦ DANTE virou <h3>✦ DANTE</h3> (Heading 3, vai pro painel de Guias)",
      html,
      "<h3 ",
    ) && allOk;
    allOk = assertNotContains(
      "Linha crua '♦ DANTE' não vaza pro HTML como parágrafo",
      html,
      "<p style=\"margin: 0 0 11pt 0; text-align: justify; line-height: 1.5; font-size: 11pt; font-weight: 400; font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;\">♦ DANTE",
    ) && allOk;

    // Conta ocorrências do destaque verde — esperamos pelo menos 2 (cap 7 +
    // cap 8 do MMC). Se a tolerância não funcionasse, sairia 0.
    const greenCount = html.split(GREEN_SPAN).length - 1;
    allOk = assertEq(
      "Pelo menos 2 spans de destaque verde (um por capítulo do MMC)",
      greenCount >= 2,
      true,
    ) && allOk;

    // Fala da FMC NÃO entra no destaque.
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Boa noite — eu disse.`);
    allOk = assertEq("Fala da FMC NÃO está destacada", fmcGreenHit, false) && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: 1p (# 🤵 + bullet) —");
  {
    const estrutura1p = `# 👩 PROTAGONISTA FEMININA (FMC)
- Nome: Iris Holloway
- Idade: 24

# 🤵 PROTAGONISTA MASCULINO (MMC)
- Nome: Caspian Vale
- Idade: 35
- Quem ele é: CEO frio.
`;
    allOk = assertEq("Extrai 'Caspian' do formato 1p", extractMaleLeadNameFromEstrutura(estrutura1p), "Caspian") && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: 3p (sem # + sem bullet) —");
  {
    const estrutura3p = `🙋 PROTAGONISTA FEMININA (FMC)
Nome: Maelys Carmichael
Idade: 26

👤 PROTAGONISTA MASCULINO (MMC)
Nome: Sebastian Wolfe
Idade: 38
Quem ele é: Observado pelos atos.
`;
    allOk = assertEq("Extrai 'Sebastian' do formato 3p", extractMaleLeadNameFromEstrutura(estrutura3p), "Sebastian") && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: mafia (👤 sem #) —");
  {
    const estruturaMafia = `🙋 PROTAGONISTA FEMININA (FMC)
Nome: Helena Romano

👤 PROTAGONISTA MASCULINO (MMC)
Nome: Saverio Aldobrandini
Idade: 38
Quem ele é: Mafioso italiano.
`;
    allOk = assertEq("Extrai 'Saverio' do formato máfia", extractMaleLeadNameFromEstrutura(estruturaMafia), "Saverio") && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: estrutura ausente/quebrada —");
  {
    allOk = assertEq("Retorna null para undefined", extractMaleLeadNameFromEstrutura(undefined), null) && allOk;
    allOk = assertEq("Retorna null para string sem rótulo", extractMaleLeadNameFromEstrutura("texto qualquer sem MMC"), null) && allOk;
    allOk = assertEq(
      "Retorna null se a seção MMC não tem campo Nome",
      extractMaleLeadNameFromEstrutura("PROTAGONISTA MASCULINO (MMC)\nIdade: 30\n"),
      null,
    ) && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: prioriza 'Nome corrigido' sobre 'Nome' com aviso ⚠️ —");
  {
    // Cenário REAL do roteiro "teste" antigo no localStorage: o LLM avisa que
    // o primeiro nome bateu com a lista de proibidos e re-anota o nome real
    // numa segunda linha "Nome corrigido:". Sem priorizar a correção, o
    // detector retorna "⚠️" e nenhum POV do MMC fica verde no export.
    const estruturaComCorrecao = `## PROTAGONISTA MASCULINO (MMC)

- **Nome:** ⚠️ ATENÇÃO: A premissa usa o nome "Enzo", que está na lista de nomes PROIBIDOS do sistema. O nome foi substituído.
- **Nome corrigido:** **Cael Valmont**
- **Idade:** 32 anos
- **Quem ele é:** CEO da Valmont Capital Group.
`;
    allOk = assertEq(
      "Extrai 'Cael' (segundo Nome, depois do aviso ⚠️)",
      extractMaleLeadNameFromEstrutura(estruturaComCorrecao),
      "Cael",
    ) && allOk;

    // Variações do disclaimer que devem ser ignoradas.
    const disclaimers = [
      { label: "⚠️ no início", txt: `PROTAGONISTA MASCULINO (MMC)\nNome: ⚠️ aviso\nNome corrigido: Saverio\n` },
      { label: "ATENÇÃO em CAIXA", txt: `PROTAGONISTA MASCULINO (MMC)\nNome: ATENÇÃO disclaimer\nNome real: Cassian\n` },
      { label: "(a definir)", txt: `PROTAGONISTA MASCULINO (MMC)\nNome: (a definir)\nNome corrigido: Lucian\n` },
      { label: "sem nome", txt: `PROTAGONISTA MASCULINO (MMC)\nNome: sem nome\nNome corrigido: Marco\n` },
    ];
    for (const d of disclaimers) {
      const expected = d.txt.match(/Nome\s+(?:corrigido|real)\s*[:\-—]\s*(\w+)/);
      allOk = assertEq(
        `Ignora aviso e pega correção (${d.label})`,
        extractMaleLeadNameFromEstrutura(d.txt),
        expected ? expected[1] : null,
      ) && allOk;
    }

    // E o cenário simples (sem disclaimer) continua funcionando.
    const simples = `PROTAGONISTA MASCULINO (MMC)\nNome: Saverio Aldobrandini\n`;
    allOk = assertEq(
      "Continua extraindo 'Saverio' quando só tem um Nome plausível",
      extractMaleLeadNameFromEstrutura(simples),
      "Saverio",
    ) && allOk;
  }

  console.log("\n— extractMaleLeadNameFromEstrutura: tolera variações (negrito, separadores) —");
  {
    const variantes = [
      { label: "negrito **Nome**", txt: `PROTAGONISTA MASCULINO (MMC)\n**Nome:** Saverio Aldobrandini\n` },
      { label: "travessão Nome —", txt: `PROTAGONISTA MASCULINO (MMC)\nNome — Saverio\n` },
      { label: "case insensitive 'protagonista MASCULINO (mmc)'", txt: `protagonista MASCULINO (mmc)\nNome: Saverio\n` },
    ];
    for (const v of variantes) {
      allOk = assertEq(`Extrai 'Saverio' (${v.label})`, extractMaleLeadNameFromEstrutura(v.txt), "Saverio") && allOk;
    }
  }

  console.log("\n— Filtro: linha de contagem '(N palavras)' não vai pra exportação —");
  {
    const variantes = [
      "(2.097 palavras)",
      "(2097 palavras)",
      "2.097 palavras",
      "(~2.097 palavras)",
      "(1 palavra)",
      "  (2.097 palavras)  ",
      "*(2.103 palavras)*", // itálico (caso reportado pelo usuário)
      "**(2.103 palavras)**", // negrito
      "*2.103 palavras*",
      "**2103 palavras**",
      "_2.103 palavras_",
      "*(~2.103 palavras)*",
      "(Contagem: 1.764 palavras)", // formato com prefixo (segundo screenshot)
      "Contagem: 1.764 palavras",
      "*Contagem: 1.764 palavras*",
      "Contagem de palavras: 1764",
      "(Contagem de palavras: 1764)",
      "Total: 2.103 palavras",
      "Total de palavras: 2103",
      "(Total: 2103 palavras)",
    ];
    for (const tag of variantes) {
      const raw = `# PARTE 2\n\n## Capítulo 1 — Fim\n\nÚltima frase do capítulo.\n\n${tag}\n`;
      const html = escritaContentToHtml(raw);
      allOk = assertNotContains(`HTML não contém '${tag.trim()}'`, html, tag.trim()) && allOk;
      // Sanity: a frase normal continua presente.
      allOk = assertContains(`HTML contém a frase normal do capítulo (${tag.trim()})`, html, "Última frase do capítulo.") && allOk;
    }

    // Sanity negativa: frase com a palavra "palavras" no meio NÃO deve ser removida.
    const rawProsa = `# PARTE 2\n\n## Capítulo 1\n\nEla escreveu 200 palavras antes de parar de chorar.\n`;
    const htmlProsa = escritaContentToHtml(rawProsa);
    allOk = assertContains(
      "Frase de prosa com 'palavras' no meio NÃO é removida",
      htmlProsa,
      "Ela escreveu 200 palavras antes de parar de chorar.",
    ) && allOk;
  }

  console.log("\n— Resultado final —");
  if (allOk) {
    console.log("  Todos os asserts passaram.");
  } else {
    console.log("  FALHOU. Veja acima.");
    process.exitCode = 1;
  }
}

// ============================================================================
// Servidor visual (modo --serve)
// ============================================================================

function pageWith(title, html, info) {
  const wrapper = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; }
  .info { background: #fff8dc; border-bottom: 1px solid #ddd; padding: 12px 24px; font-size: 13px; color: #444; }
  .info code { background: #fff; padding: 2px 6px; border-radius: 3px; }
  .info a { color: #0066cc; margin-right: 12px; }
  .doc { max-width: 720px; margin: 24px auto; padding: 32px 48px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
</style>
</head>
<body>
<div class="info">
  <strong>${title}</strong> — ${info}
  &nbsp;|&nbsp;
  <a href="/">/</a>
  <a href="/parte2">/parte2</a>
  <a href="/so-fmc">/so-fmc</a>
</div>
<div class="doc">
${html}
</div>
</body>
</html>`;
  return wrapper;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];

    let title, body, info;

    if (url === "/parte2") {
      const { parte2 } = splitRoteiroByParts(ROTEIRO_COMPLETO);
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_COMPLETO);
      title = "1p — só Parte 2 (CopyPartButton)";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Caspian</code>. Highlight verde só nos parágrafos abaixo de ✦ Caspian.`;
      body = escritaContentToHtml(parte2, { maleLeadName, forceParte2: true });
    } else if (url === "/so-fmc") {
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_SO_FMC);
      title = "Só FMC (sem POVs)";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>null</code>. Nenhum highlight verde.`;
      body = escritaContentToHtml(ROTEIRO_SO_FMC);
    } else if (url === "/3p-mmc-only") {
      const { parte2 } = splitRoteiroByParts(ROTEIRO_3P_PARTE2_MMC_ONLY);
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_3P_PARTE2_MMC_ONLY);
      title = "3p — Parte 2 só com MMC (regressão do screenshot)";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Sebastian</code>. Falas do Sebastian em verde.`;
      body = escritaContentToHtml(parte2, { maleLeadName, forceParte2: true });
    } else if (url === "/3p-mmc-primeiro") {
      const { parte2 } = splitRoteiroByParts(ROTEIRO_3P_PARTE2_MMC_PRIMEIRO);
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_3P_PARTE2_MMC_PRIMEIRO);
      title = "3p — Parte 2 começa pelo MMC e alterna";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Sebastian</code>. Só falas do Sebastian em verde, Maelys sem cor.`;
      body = escritaContentToHtml(parte2, { maleLeadName, forceParte2: true });
    } else if (url === "/mafia-normal") {
      const { parte2 } = splitRoteiroByParts(ROTEIRO_MAFIA_NORMAL);
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_MAFIA_NORMAL);
      title = "mafia — P1 implícita, P2 alterna FMC/MMC";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Saverio</code>. Falas do Saverio em verde, Helena sem cor.`;
      body = escritaContentToHtml(parte2, { maleLeadName, forceParte2: true });
    } else if (url === "/mafia-cliffhanger") {
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_MAFIA_CLIFFHANGER);
      title = "mafia — P1 implícita + cliffhanger MMC, P2 com ambos";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Saverio</code>. Cliffhanger MMC em P1 SEM cor; só P2 do Saverio em verde.`;
      body = escritaContentToHtml(ROTEIRO_MAFIA_CLIFFHANGER, { maleLeadName });
    } else {
      const maleLeadName = detectMaleLeadFromFullRoteiro(ROTEIRO_COMPLETO);
      title = "1p — roteiro completo (DownloadEscritaButton)";
      info = `MMC: <code>${maleLeadName ?? "null"}</code> — esperado <code>Caspian</code>. PARTE=h1, Capítulo=h2, ✦ POV=h3.`;
      body = escritaContentToHtml(ROTEIRO_COMPLETO);
    }

    void buildEscritaHtmlDocument(title, body);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageWith(title, body, info));
  });

  const PORT = 4567;
  server.listen(PORT, () => {
    console.log(`\nServidor visual em http://localhost:${PORT}/`);
    console.log(`  /                  → 1p completo`);
    console.log(`  /parte2            → 1p só Parte 2`);
    console.log(`  /so-fmc            → só Parte 1 sem POVs`);
    console.log(`  /3p-mmc-only       → 3p Parte 2 só com MMC`);
    console.log(`  /3p-mmc-primeiro   → 3p Parte 2 começa pelo MMC`);
    console.log(`  /mafia-normal      → mafia P1 implícita, P2 alterna`);
    console.log(`  /mafia-cliffhanger → mafia P1 implícita + cliffhanger MMC\n`);
    console.log(`Ctrl+C pra parar.`);
  });
}

if (process.argv.includes("--serve")) {
  startServer();
} else {
  runAsserts();
}
