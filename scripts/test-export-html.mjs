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
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildEscritaHtmlDocument,
  detectMaleLeadFromFullRoteiro,
  detectMaleLeadName,
  escritaContentToHtml,
  escritaContentToPlainText,
  extractFemaleLeadNameFromEstrutura,
  extractFemaleLeadFullNameFromEstrutura,
  extractMaleLeadNameFromEstrutura,
  extractMaleLeadFullNameFromEstrutura,
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

// alpha-king: Estrutura no formato INLINE do guia (rótulo "ALPHA KING (MMC)" /
// "HEROÍNA (FMC)", nome logo após a tag, SEM linha "Nome:" separada).
const ESTRUTURA_ALPHAKING = `🙋 HEROÍNA (FMC) — Lyra Nightshade; 22 anos; ômega rejeitada; forte e sarcástica quando ferida; segredo: lobo raro adormecido.
👤 ALPHA KING (MMC) — Cael Ashford; 34 anos; Alpha King da alcateia do Norte; passado de traição; ciúmes territorial absoluto.
`;

// alpha-king: P1 implícita (heroína, sem ✦). P2 alterna ✦ LYRA (FMC) e ✦ CAEL
// (MMC/Alpha) — e o trecho do Alpha é MAIS LONGO que o da heroína. É o caso que
// INVERTE a heurística "menos palavras = MMC" (ela retornaria a FMC). Com os
// nomes vindos da Estrutura, o verde tem que cair no Cael e a fala da Lyra
// NUNCA pode ficar verde.
const ROTEIRO_ALPHAKING_MMC_LONGO = `# PARTE 1

## Capítulo 1 — A Clareira

${prose(1500)}

# PARTE 2

## Capítulo 7 — A Lua Cheia

✦ LYRA

${prose(300)}

— Eu não vou fugir — eu disse.

✦ CAEL

${prose(900)}

— Você é minha — rosnei.
`;

// alpha-king: Estrutura com Thoren (MMC) e Sieva (FMC) — cenário do print da
// regressão (mansão Voss, calabouço, uivo).
const ESTRUTURA_ALPHAKING_THOREN = `🙋 HEROÍNA (FMC) — Sieva Voss; 21 anos; prisioneira da mansão Voss; forte.
👤 ALPHA KING (MMC) — Thoren; 30 anos; Alpha King do Norte; vínculo com a heroína.
`;

// alpha-king: Parte 2 com um excerto MARCADO do Alpha (✦ THOREN) seguido de
// uma cena da heroína SEM marcador ✦ (ela é a narradora-padrão), separados por
// um '---'. BUG RECORRENTE (print): o POV do ✦ THOREN vazava pelo '---' e
// pintava a cena da heroína de verde. A FMC NUNCA pode ficar verde.
const ROTEIRO_ALPHAKING_HEROINA_APOS_EXCERTO = `# PARTE 2

## Capítulo 7 — O Uivo no Norte

✦ THOREN

${prose(300)}

Se Darius Voss ainda estivesse de pé quando eu chegasse, ele não estaria depois.

---

A pedra do calabouço gelava de um jeito que eu conhecia desde menina.

Acordei com a costela latejando e o gosto de ferro na boca.

Reconhecível como o próprio batimento dentro do meu peito. Thoren.
`;

// ============================================================================
// Asserts (modo padrão)
// ============================================================================

const GREEN_SPAN = '<span style="background-color: #d9ead3">';
// Wrap NEUTRO = fundo BRANCO que envolve TODO texto não-MMC (prosa da heroína +
// títulos) — trava anti-vazamento do verde no paste do Google Docs (branco
// SOBRESCREVE verde herdado/retido; `transparent` o Docs ignora). Ver
// STYLE_NO_HIGHLIGHT em lib/export-html.ts.
const NO_HIGHLIGHT_SPAN = '<span style="background-color: #ffffff">';

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

  console.log("\n— anti-vazamento do verde no paste do Google Docs (BUG 'roteiro todo verde ao copiar') —");
  {
    // O Docs HERDA/RETÉM o destaque (do run do MMC OU de uma colagem anterior no
    // doc) pros runs que não têm cor de fundo PRÓPRIA — daí o verde pintava o
    // roteiro inteiro, INCLUSIVE a Parte 1 e os TÍTULOS (que não têm verde no
    // HTML). A trava: TODO texto não-MMC (prosa + títulos) sai dentro de
    // <span style="background-color: #ffffff"> — branco SOBRESCREVE o verde
    // herdado (transparent o Docs ignora). Ver STYLE_NO_HIGHLIGHT.
    const html = escritaContentToHtml(ROTEIRO_COMPLETO);
    const { parte1, parte2 } = splitRoteiroByParts(ROTEIRO_COMPLETO);
    const mmc = detectMaleLeadFromFullRoteiro(ROTEIRO_COMPLETO);
    const htmlP2 = escritaContentToHtml(parte2, { maleLeadName: mmc, forceParte2: true });
    const htmlP1 = escritaContentToHtml(parte1, { maleLeadName: null });

    // NENHUM parágrafo de prosa pode sair "pelado" (texto colado no <p> sem um
    // <span> de background): seria exatamente o run que o Docs pinta de verde.
    // O estilo de prosa começa com `margin: 0 0 11pt` (o bullet usa outro), então
    // o regex pega só parágrafos de prosa que NÃO abrem com <span>.
    const nakedRe = /<p style="margin: 0 0 11pt[^>]*">(?!<span)/g;
    const nakedFull = (html.match(nakedRe) || []).length;
    const nakedP2 = (htmlP2.match(nakedRe) || []).length;
    const nakedP1 = (htmlP1.match(nakedRe) || []).length;
    allOk = assertEq("Roteiro completo: 0 parágrafos de prosa sem <span> de fundo", nakedFull, 0) && allOk;
    allOk = assertEq("Parte 2 isolada (CopyPart): 0 parágrafos pelados", nakedP2, 0) && allOk;
    allOk = assertEq("Parte 1 isolada (CopyPart): 0 parágrafos pelados", nakedP1, 0) && allOk;

    // NENHUM título (h1/h2/h3) pode sair "pelado" — o título do capítulo também
    // saía verde no print da roteirista (herança do Docs). Todo heading abre com
    // o <span> branco logo após o `>`.
    const nakedHeadRe = /<h[123][^>]*>(?!<span)/g;
    const nakedHeadFull = (html.match(nakedHeadRe) || []).length;
    const nakedHeadP1 = (htmlP1.match(nakedHeadRe) || []).length;
    allOk = assertEq("Roteiro completo: 0 títulos h1/h2/h3 sem <span> de fundo", nakedHeadFull, 0) && allOk;
    allOk = assertEq("Parte 1 isolada: 0 títulos pelados (o título do cap não fica verde)", nakedHeadP1, 0) && allOk;

    // A prosa da FMC sai com fundo BRANCO explícito — não verde, mas também não
    // pelada. (Parte 2 começa pelo POV da FMC = Iris.)
    allOk = assertContains(
      "Prosa da FMC (Iris) sai com fundo branco explícito",
      htmlP2,
      `${NO_HIGHLIGHT_SPAN}Quinta-feira, vinte e três e trinta`,
    ) && allOk;
    allOk = assertEq(
      "Prosa da FMC (Iris) NÃO está no destaque verde",
      htmlP2.includes(`${GREEN_SPAN}Quinta-feira, vinte e três e trinta`),
      false,
    ) && allOk;
    // E o título do capítulo da Parte 1 sai branco (não verde) — sintoma do print.
    allOk = assertContains(
      "Título do Capítulo 1 da Parte 1 sai com fundo branco (não verde)",
      htmlP1,
      `${NO_HIGHLIGHT_SPAN}Capítulo 1 — A Frase no Corredor</span></h2>`,
    ) && allOk;
    // E a Parte 1 inteira (toda FMC) sai neutra explícita, nunca pelada.
    allOk = assertContains(
      "Prosa da Parte 1 sai com fundo branco explícito",
      htmlP1,
      `${NO_HIGHLIGHT_SPAN}A primeira coisa que ele tinha jurado`,
    ) && allOk;
    // E o MMC continua verde (a trava NÃO mexe em QUEM fica verde).
    allOk = assertContains(
      "MMC (Caspian) continua com destaque verde",
      htmlP2,
      `${GREEN_SPAN}Eu vi a mala antes de ela entrar`,
    ) && allOk;
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

  console.log("\n— alpha-king: extração inline 'ALPHA KING (MMC) — Nome' / 'HEROÍNA (FMC) — Nome' —");
  {
    allOk = assertEq(
      "Extrai MMC 'Cael' do formato inline alpha-king",
      extractMaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING),
      "Cael",
    ) && allOk;
    allOk = assertEq(
      "Extrai FMC 'Lyra' do formato inline alpha-king",
      extractFemaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING),
      "Lyra",
    ) && allOk;
  }

  console.log("\n— alpha-king: MMC com trecho MAIS LONGO que a FMC (heurística inverteria) —");
  {
    // A heurística de contagem retornaria a FMC (Lyra), pois o Alpha tem MAIS
    // palavras na P2 — exatamente o bug reportado (verde no POV feminino).
    const mmcHeuristic = detectMaleLeadFromFullRoteiro(ROTEIRO_ALPHAKING_MMC_LONGO);
    allOk = assertEq(
      "Heurística de palavras INVERTE (retorna 'LYRA', a FMC) — por isso usamos a Estrutura",
      mmcHeuristic,
      "LYRA",
    ) && allOk;

    // Com os nomes vindos da Estrutura, o destaque cai no Cael (MMC) e a fala
    // da Lyra (FMC) fica de fora — travado.
    const maleLeadName = extractMaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING);
    const femaleLeadName = extractFemaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING);
    const { parte2 } = splitRoteiroByParts(ROTEIRO_ALPHAKING_MMC_LONGO);
    const html = escritaContentToHtml(parte2, {
      maleLeadName,
      femaleLeadName,
      forceParte2: true,
    });

    allOk = assertContains("HTML da P2 contém destaque verde (no Cael)", html, GREEN_SPAN) && allOk;
    const mmcGreenHit = html.includes(`${GREEN_SPAN}— Você é minha — rosnei.`);
    allOk = assertEq("Fala do MMC (Cael) ESTÁ destacada", mmcGreenHit, true) && allOk;
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Eu não vou fugir — eu disse.`);
    allOk = assertEq("Fala da FMC (Lyra) NÃO está destacada", fmcGreenHit, false) && allOk;
  }

  console.log("\n— alpha-king: trava da FMC vale mesmo se o nome do MMC falhar —");
  {
    // Sem maleLeadName (detecção do MMC falhou), mas com femaleLeadName da
    // Estrutura: todo POV nomeado da P2 que NÃO é a FMC vira verde (= o MMC).
    const femaleLeadName = extractFemaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING);
    const { parte2 } = splitRoteiroByParts(ROTEIRO_ALPHAKING_MMC_LONGO);
    const html = escritaContentToHtml(parte2, {
      maleLeadName: null,
      femaleLeadName,
      forceParte2: true,
    });
    const mmcGreenHit = html.includes(`${GREEN_SPAN}— Você é minha — rosnei.`);
    allOk = assertEq("Cael fica verde por exclusão (não é a FMC)", mmcGreenHit, true) && allOk;
    const fmcGreenHit = html.includes(`${GREEN_SPAN}— Eu não vou fugir — eu disse.`);
    allOk = assertEq("Lyra (FMC) continua sem destaque", fmcGreenHit, false) && allOk;
  }

  console.log("\n— alpha-king: heroína (sem ✦) após excerto do Alpha + '---' NÃO fica verde (BUG DO PRINT) —");
  {
    const maleLeadName = extractMaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING_THOREN);
    const femaleLeadName = extractFemaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING_THOREN);
    allOk = assertEq("MMC = 'Thoren'", maleLeadName, "Thoren") && allOk;
    allOk = assertEq("FMC = 'Sieva'", femaleLeadName, "Sieva") && allOk;

    const { parte2 } = splitRoteiroByParts(ROTEIRO_ALPHAKING_HEROINA_APOS_EXCERTO);
    const html = escritaContentToHtml(parte2, {
      maleLeadName,
      femaleLeadName,
      forceParte2: true,
    });

    // Excerto do Alpha (Thoren / MMC) — ANTES do '---' — FICA verde.
    const mmcGreen = html.includes(
      `${GREEN_SPAN}Se Darius Voss ainda estivesse de pé quando eu chegasse, ele não estaria depois.`,
    );
    allOk = assertEq("Excerto do Alpha (Thoren) ESTÁ verde", mmcGreen, true) && allOk;

    // Cena da heroína — DEPOIS do '---', sem marcador ✦ — NÃO pode ficar verde.
    const fmc1 = html.includes(`${GREEN_SPAN}A pedra do calabouço gelava`);
    allOk = assertEq("Cena da heroína após '---' NÃO fica verde (1)", fmc1, false) && allOk;
    const fmc2 = html.includes(`${GREEN_SPAN}Acordei com a costela latejando`);
    allOk = assertEq("Cena da heroína após '---' NÃO fica verde (2)", fmc2, false) && allOk;
    const fmc3 = html.includes(`${GREEN_SPAN}Reconhecível como o próprio batimento`);
    allOk = assertEq("Cena da heroína após '---' NÃO fica verde (3)", fmc3, false) && allOk;

    // E o '---' vira <hr> (separador de cena), não some nem vaza como prosa.
    allOk = assertContains("'---' virou <hr> (separador de cena)", html, "<hr ") && allOk;

    // POV FEMININO identificável: a cena da heroína (FMC = Sieva), que narra
    // SEM marcador ✦, agora ganha o rótulo "✦ Sieva — POV feminino" (mesmo
    // formato do masculino, mas SEM verde) no começo do trecho dela. Antes
    // ficava sem identificação nenhuma — era a queixa da roteirista.
    // O rótulo sai DENTRO do <span> branco (noHighlight) — não-verde e não-pelado.
    allOk = assertContains("POV feminino: rótulo '✦ Sieva — POV feminino'", html, `>${NO_HIGHLIGHT_SPAN}✦ Sieva — POV feminino</span></h3>`) && allOk;
    allOk = assertNotContains("Rótulo da FMC NÃO é verde", html, `${GREEN_SPAN}✦ Sieva`) && allOk;
    // POV MASCULINO identificável: o cabeçalho do Alpha (✦ THOREN) ganha a
    // etiqueta "— POV masculino" na Parte 2 (o verde fica na PROSA, não aqui;
    // o cabeçalho sai com fundo branco como os outros títulos).
    allOk = assertContains("POV masculino: cabeçalho '✦ THOREN — POV masculino'", html, `>${NO_HIGHLIGHT_SPAN}✦ THOREN — POV masculino</span></h3>`) && allOk;
  }

  console.log("\n— POV feminino P2: nome da heroína AUSENTE → fallback '✦ POV feminino' —");
  {
    // Estrutura quebrada / sem tag (FMC): femaleLeadName = null. Mesmo assim,
    // como há alternância de POV (✦ THOREN), o trecho implícito da heroína
    // PRECISA ser identificável — cai pro rótulo genérico. Era o caso real
    // (projeto de máfia com Estrutura P1 quebrada) onde a heroína sumia sem
    // identificação nenhuma.
    const { parte2 } = splitRoteiroByParts(ROTEIRO_ALPHAKING_HEROINA_APOS_EXCERTO);
    const html = escritaContentToHtml(parte2, {
      maleLeadName: "Thoren",
      femaleLeadName: null,
      forceParte2: true,
    });
    allOk = assertContains("Sem nome da FMC → fallback '✦ POV feminino'", html, `>${NO_HIGHLIGHT_SPAN}✦ POV feminino</span></h3>`) && allOk;
    const fmcGreen = html.includes(`${GREEN_SPAN}A pedra do calabouço gelava`);
    allOk = assertEq("Heroína sem nome ainda NÃO fica verde", fmcGreen, false) && allOk;
  }

  console.log("\n— POV feminino P2: roteiro sem ✦ (todo FMC, ex.: milionário-3p) NÃO ganha rótulo —");
  {
    // Parte 2 narrada 100% pela heroína, sem NENHUM marcador ✦ (caso do
    // milionário-3p, sem alternância de POV). Mesmo passando femaleLeadName, o
    // export NÃO deve inventar rótulos "✦ NOME" — sem alternância não há o que
    // distinguir, e os rótulos seriam ruído.
    const p2SemPov = `# PARTE 2

## Capítulo 6 — O Reencontro

${prose(200)}

Ela soube, naquele instante, que nada voltaria a ser como antes.
`;
    const html = escritaContentToHtml(p2SemPov, {
      femaleLeadName: "Helena",
      forceParte2: true,
    });
    allOk = assertNotContains("Sem ✦ no roteiro → nenhum rótulo '✦ Helena'", html, "✦ Helena") && allOk;
    allOk = assertNotContains("Sem ✦ no roteiro → nenhum heading de POV sintetizado", html, ">✦ ") && allOk;
  }

  console.log("\n— máfia P2: ✦ SOZINHO (separador de cena) RESETA o POV; heroína depois NÃO fica verde (BUG DA CALLA) —");
  {
    // Formato real da máfia/alpha-king: o trecho do MMC é marcado `✦ NOME`, e
    // o RETORNO à heroína vem por um `✦` SOZINHO (separador de cena, sem nome).
    // Sem tratar o `✦` solto como quebra de cena, o POV do MMC vazava por ele e
    // pintava a cena seguinte da heroína de verde — o bug do print da Calla.
    const p2 = `# PARTE 2

## Capítulo 1 — A Reunião

✦ MARCO

${prose(120)}

Eu não me mexi quando o velho ameaçou a Calla.

✦

A primeira luz entrou pela janela e eu estava enrolada no peito dele, sem calcular nada pela primeira vez na vida.
`;
    const html = escritaContentToHtml(p2, {
      maleLeadName: "Marco",
      femaleLeadName: "Calla",
      forceParte2: true,
    });
    const mmcGreen = html.includes(`${GREEN_SPAN}Eu não me mexi quando o velho ameaçou a Calla.`);
    allOk = assertEq("Trecho do Marco (✦ MARCO) ESTÁ verde", mmcGreen, true) && allOk;
    const fmcGreen = html.includes(`${GREEN_SPAN}A primeira luz entrou pela janela`);
    allOk = assertEq("Heroína APÓS o ✦ solto NÃO fica verde", fmcGreen, false) && allOk;
    // O ✦ solto vira <hr> (separador), não fica como parágrafo de prosa.
    allOk = assertContains("✦ solto virou <hr>", html, "<hr ") && allOk;
    allOk = assertNotContains("✦ solto NÃO sai como prosa", html, "✦</p>") && allOk;
    // E como o POV resetou, a heroína volta a ser identificada (rótulo não-verde).
    allOk = assertContains("Heroína re-rotulada após o ✦ solto", html, "✦ Calla — POV feminino") && allOk;
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

  console.log("\n— Filtro: marca de direção/edição '[Volta para Calla.]' não vai pra exportação —");
  {
    // Stage directions que o modelo crava na prosa (bug reportado pela roteirista,
    // Erro #12 "Metadado/instrução de roteiro cravado na prosa"). Devem SUMIR.
    const direcoes = [
      "[Volta para Calla.]",
      "[POV: Damiano]",
      "[POV de Calla]",
      "[Transição de cena]",
      "[Corte para o flashback]",
      "[Retoma a perspectiva da Luna]",
      "*[Volta para Calla.]*",
    ];
    for (const tag of direcoes) {
      const raw = `# PARTE 2\n\n## Capítulo 1 — Fim\n\nEle subiu os degraus dois a dois.\n\n${tag}\n\n✦ CALLA\n\nEu o observei de longe.\n`;
      const html = escritaContentToHtml(raw);
      allOk = assertNotContains(`HTML não contém a marca '${tag}'`, html, tag.replace(/^\*|\*$/g, "")) && allOk;
      // A prosa em volta E o marcador de POV ✦ CALLA continuam presentes.
      allOk = assertContains(`HTML mantém a prosa antes da marca (${tag})`, html, "Ele subiu os degraus dois a dois.") && allOk;
      allOk = assertContains(`HTML mantém a prosa depois da marca (${tag})`, html, "Eu o observei de longe.") && allOk;
    }

    // Sanity NEGATIVA: placa/bilhete em caixa-alta que o personagem lê (sem sinal
    // de direção) NÃO pode ser removida — é conteúdo, não metadado.
    const rawPlaca = `# PARTE 2\n\n## Capítulo 1\n\nEla parou diante da porta.\n\n[FECHADO PARA REFORMA]\n\nO coração afundou.\n`;
    const htmlPlaca = escritaContentToHtml(rawPlaca);
    allOk = assertContains("Placa '[FECHADO PARA REFORMA]' (sem sinal de direção) NÃO é removida", htmlPlaca, "FECHADO PARA REFORMA") && allOk;
  }

  console.log("\n— alpha-king: capítulo com UM '#' só (legado) vira <h2>, não divisor de PARTE —");
  {
    // Alpha-king e roteiros antigos emitem `# Capítulo N — …` com um único `#`.
    // Antes, o walker tratava como <h1 part-divider> (centralizado + page-break
    // por cap). Deve virar <h2> de capítulo, sem nenhum part-divider.
    const raw = `# PARTE 1\n\n# Capítulo 1 — A sombra do salão (~1.900 palavras — ritmo rápido)\n\nAcordei antes do sol.\n\n# Capítulo 2 — O baile lunar\n\nA porta estava aberta.`;
    const { parte1 } = splitRoteiroByParts(raw);
    const html = escritaContentToHtml(parte1, { maleLeadName: null });
    // O título sai DENTRO do <span> de fundo branco (noHighlight) — assim o verde
    // herdado/retido do Docs não pinta o título do capítulo.
    allOk = assertContains("Capítulo 1 vira <h2> (título embrulhado em branco)", html, `>${NO_HIGHLIGHT_SPAN}Capítulo 1 — A sombra do salão</span></h2>`) && allOk;
    allOk = assertContains("Capítulo 2 vira <h2> (título embrulhado em branco)", html, `>${NO_HIGHLIGHT_SPAN}Capítulo 2 — O baile lunar</span></h2>`) && allOk;
    allOk = assertNotContains("Nenhum part-divider em capítulo de '#' só", html, "part-divider") && allOk;
    allOk = assertNotContains("Nenhum page-break forçado entre capítulos", html, "page-break-before") && allOk;
    allOk = assertNotContains("Anotação de palavras some do título", html, "1.900 palavras") && allOk;
  }

  console.log("\n— escritaContentToPlainText: fallback de clipboard sem ruído markdown —");
  {
    const raw = `# PARTE 1\n\n# Capítulo 1 — A sombra do salão (~1.900 palavras — ritmo rápido)\n\n**Levantei.** O chão mordia meus *pés* descalços.\n\n(1.901 palavras)\n\n# Capítulo 2 — O baile`;
    const { parte1 } = splitRoteiroByParts(raw);
    const txt = escritaContentToPlainText(parte1);
    allOk = assertNotContains("Sem '#' no texto puro", txt, "#") && allOk;
    allOk = assertNotContains("Sem '**' no texto puro", txt, "**") && allOk;
    allOk = assertNotContains("Sem linha de contagem de palavras", txt, "1.901 palavras") && allOk;
    allOk = assertNotContains("Sem anotação de planejamento no título", txt, "1.900 palavras") && allOk;
    allOk = assertContains("Título do capítulo preservado limpo", txt, "Capítulo 1 — A sombra do salão") && allOk;
    allOk = assertContains("Prosa preservada sem marcadores", txt, "Levantei. O chão mordia meus pés descalços.") && allOk;
  }

  console.log(
    "\n— máfia: heroína 'Anaïs Lenoir' (trema) marcada ora ✦ Anaïs ora ✦ Lenoir —",
  );
  {
    const estrutura = `🙋 PROTAGONISTA FEMININA (FMC)
Nome: Anaïs Lenoir
Idade: 27

👤 PROTAGONISTA MASCULINO (MMC)
Nome: Thierry Moreau
Idade: 38`;
    // (1) DETECÇÃO com trema: o "ï" de "Anaïs" NÃO pode fazer o detector pular o
    // primeiro nome e cair no sobrenome "Lenoir" (era a raiz do bug).
    const fmc = extractFemaleLeadFullNameFromEstrutura(estrutura);
    const mmc = extractMaleLeadFullNameFromEstrutura(estrutura);
    allOk = assertEq("FMC completa detectada = 'Anaïs Lenoir' (trema OK)", fmc, "Anaïs Lenoir") && allOk;
    allOk = assertEq("MMC completo detectado = 'Thierry Moreau'", mmc, "Thierry Moreau") && allOk;
    // 1º nome ainda funciona (compat): retorna 'Anaïs', não 'Lenoir'.
    allOk = assertEq("FMC 1º nome = 'Anaïs' (não o sobrenome)", extractFemaleLeadNameFromEstrutura(estrutura), "Anaïs") && allOk;

    const p2 = `## Capítulo 1 — A Foto Que Ninguém Devia Ter

✦ Anaïs

Acordei antes do despertador, o corpo de Léo quente contra o meu.

✦ Thierry

Ela dormia como quem finalmente baixou a guarda. Eu observei os dois.

✦ Lenoir

Levei Léo pra escola e senti os olhos dele em mim.`;
    const html = escritaContentToHtml(p2, {
      maleLeadName: mmc,
      femaleLeadName: fmc,
      forceParte2: true,
    });
    // (2) MATCH por token: a heroína marcada por PRIMEIRO NOME (✦ Anaïs) E por
    // SOBRENOME (✦ Lenoir) NUNCA fica verde; só o MMC (Thierry).
    allOk = assertNotContains("✦ Anaïs (heroína) NÃO fica verde", html, GREEN_SPAN + "Acordei antes do despertador") && allOk;
    allOk = assertNotContains("✦ Lenoir (heroína, sobrenome) NÃO fica verde", html, GREEN_SPAN + "Levei Léo pra escola") && allOk;
    allOk = assertContains("✦ Thierry (MMC) FICA verde", html, GREEN_SPAN + "Ela dormia como quem") && allOk;
    // (3) invariante: exatamente 1 bloco verde (só o MMC), nunca 2.
    const greenBlocks = (html.match(/#d9ead3/g) || []).length;
    allOk = assertEq("exatamente 1 bloco verde (só o MMC)", greenBlocks, 1) && allOk;
    // (4) rótulos: Anaïs e Lenoir = POV feminino; Thierry = POV masculino.
    allOk = assertContains("✦ Anaïs rotulado POV feminino", html, "POV feminino") && allOk;
    allOk = assertContains("✦ Thierry rotulado POV masculino", html, "POV masculino") && allOk;
    allOk = assertNotContains("nenhum bloco da heroína virou 'POV masculino' por engano", html, GREEN_SPAN + "Acordei") && allOk;

    // (5) REGRESSÃO (pega na revisão): marcador da heroína com o 1º nome CERTO +
    // um token EXTRA que NÃO está no nome canônico dela (nome do meio / sobrenome
    // divergente) NÃO pode fazê-la ficar verde. O match é por INTERSEÇÃO de
    // tokens (compartilhar "Anaïs" basta), não subconjunto.
    const p2extra = `## Capítulo 2 — O Método Errado

✦ Anaïs Marie

Fechei a porta do quarto de Léo com o cuidado de sempre.

✦ Thierry

Fiquei olhando os dois pela fresta, sem saber o que fazer das mãos.

✦ Anaïs Beaumont

O café tinha esfriado na caneca e eu nem tinha percebido.`;
    const htmlExtra = escritaContentToHtml(p2extra, {
      maleLeadName: mmc,
      femaleLeadName: fmc,
      forceParte2: true,
    });
    allOk = assertNotContains("✦ Anaïs Marie (heroína + nome do meio) NÃO fica verde", htmlExtra, GREEN_SPAN + "Fechei a porta do quarto") && allOk;
    allOk = assertNotContains("✦ Anaïs Beaumont (heroína + sobrenome divergente) NÃO fica verde", htmlExtra, GREEN_SPAN + "O café tinha esfriado") && allOk;
    allOk = assertContains("✦ Thierry ainda FICA verde nesse bloco", htmlExtra, GREEN_SPAN + "Fiquei olhando os dois") && allOk;
    const greenExtra = (htmlExtra.match(/#d9ead3/g) || []).length;
    allOk = assertEq("exatamente 1 bloco verde mesmo com marcadores extras da heroína", greenExtra, 1) && allOk;
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

// Escapa texto pra colocar dentro de <textarea> sem quebrar o HTML.
function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Lê o corpo de um POST (form urlencoded) como string.
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

// O roteiro já tem cabeçalho de Parte 2? (legado ═══ ou novo #). Se tiver, o
// walker detecta a Parte sozinho e o forceParte2 deixa de ser necessário —
// evita o footgun de marcar forceParte2 num roteiro COMPLETO (pintaria a P1).
function hasParte2Marker(raw) {
  return (
    /^#\s+PARTE 2\s*$/m.test(raw) ||
    /═{3,}\s*\n\s*PARTE 2\s*\n\s*═{3,}/.test(raw)
  );
}

// Renderiza o conteúdo colado igual o app: nomes vêm da Estrutura
// (extractLeadName MMC/FMC); o MMC cai pro detector heurístico só se a
// Estrutura não der. Retorna o HTML + os nomes detectados pra inspeção.
function renderPlayground(estrutura, roteiro, forceParte2) {
  const est = (estrutura || "").trim();
  let mmc = est ? extractMaleLeadNameFromEstrutura(est) : null;
  const fmc = est ? extractFemaleLeadNameFromEstrutura(est) : null;
  if (!mmc) mmc = detectMaleLeadFromFullRoteiro(roteiro || "");
  const effForce = hasParte2Marker(roteiro || "") ? false : forceParte2;
  const result = escritaContentToHtml(roteiro || "", {
    maleLeadName: mmc,
    femaleLeadName: fmc,
    forceParte2: effForce,
  });
  return { result, mmc, fmc };
}

const PLAYGROUND_NAV = `
  <a href="/projetos"><strong>★ meus projetos reais</strong></a>
  <a href="/playground">▶ playground (colar roteiro)</a>
  <a href="/alphaking-print">exemplo do print</a>
  <a href="/">fixtures 1p</a>
  <a href="/mafia-normal">mafia</a>
  <a href="/3p-mmc-primeiro">3p</a>
  <a href="/so-fmc">só FMC</a>`;

// ----------------------------------------------------------------------------
// Projetos REAIS do app instalado (lê o backup automático mais recente).
// O app grava snapshots JSON em %APPDATA%/MyStoriesLena/backups a cada
// auto-backup (JSON.stringify da biblioteca, imagens inline). Renderizamos
// pelo MESMO caminho do DownloadEscritaButton, com o exporter já corrigido.
// ----------------------------------------------------------------------------
function backupsDir() {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "MyStoriesLena", "backups");
}

function latestBackup() {
  try {
    const dir = backupsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("veludo-roteiros-") && f.endsWith(".json"))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return { path: path.join(dir, files[0].name), name: files[0].name, mtime: files[0].mtime };
  } catch {
    return null;
  }
}

function loadBackupRoteiros() {
  const f = latestBackup();
  if (!f) return { roteiros: [], backupName: null, mtime: null };
  try {
    const arr = JSON.parse(fs.readFileSync(f.path, "utf8"));
    return {
      roteiros: Array.isArray(arr) ? arr : [],
      backupName: f.name,
      mtime: f.mtime,
    };
  } catch {
    return { roteiros: [], backupName: f.name, mtime: f.mtime };
  }
}

// Replica EXATAMENTE o DownloadEscritaButton do app: nomes da estrutura1 ??
// estrutura2 ?? heurística (MMC); estrutura1 ?? estrutura2 (FMC); passa os
// chapters do metadata como fonte da verdade da Parte.
function renderRoteiroLikeApp(r) {
  const escritaContent = (r.outputs?.escrita?.content || "").trim();
  const maleLeadName =
    extractMaleLeadNameFromEstrutura(r.outputs?.estrutura1?.content) ??
    extractMaleLeadNameFromEstrutura(r.outputs?.estrutura2?.content) ??
    detectMaleLeadFromFullRoteiro(escritaContent);
  const femaleLeadName =
    extractFemaleLeadNameFromEstrutura(r.outputs?.estrutura1?.content) ??
    extractFemaleLeadNameFromEstrutura(r.outputs?.estrutura2?.content);
  const chapters = r.outputs?.escrita?.metadata?.chapters;
  const body = escritaContentToHtml(escritaContent, {
    maleLeadName,
    femaleLeadName,
    chapters,
  });
  return { body, mmc: maleLeadName, fmc: femaleLeadName, escritaContent };
}

// Conta parágrafos verdes que pertencem ao POV da FMC — DEVE ser 0. É o
// "detector de regressão" do bug: se algum trecho da heroína ficar verde,
// esse número sobe.
function countFmcGreenLeaks(body, fmc) {
  if (!fmc) return null;
  // Heurística simples de inspeção: procura spans verdes cujo texto soa 1ª
  // pessoa feminina forte ("sozinha", "menina", "grávida") — sinaliza pra
  // inspeção manual, não é prova. A prova real é visual.
  const greenChunks = body.match(/#d9ead3">[^<]*/g) || [];
  return greenChunks.length;
}

function projetosListPage({ roteiros, backupName, mtime }) {
  const stamp = mtime
    ? new Date(mtime).toLocaleString("pt-BR")
    : "desconhecido";
  const finished = roteiros.filter(
    (r) => (r.outputs?.escrita?.content || "").trim().length > 0,
  );
  const rows = finished
    .map((r) => {
      const { mmc, fmc, body } = renderRoteiroLikeApp(r);
      const caps = r.outputs?.escrita?.metadata?.chapters?.length ?? 0;
      const greens = countFmcGreenLeaks(body, fmc);
      return `<tr>
        <td><a href="/projeto?id=${encodeURIComponent(r.id)}"><strong>${htmlEscape(r.title || "(sem título)")}</strong></a></td>
        <td>${htmlEscape(r.category || "?")}</td>
        <td>MMC <code>${htmlEscape(mmc || "—")}</code><br>FMC <code>${htmlEscape(fmc || "—")}</code></td>
        <td>${caps} caps</td>
        <td>${greens ?? "—"} spans verdes</td>
        <td><a href="/projeto?id=${encodeURIComponent(r.id)}">abrir →</a></td>
      </tr>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Meus projetos reais</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
  .top { background: #fff8dc; border-bottom: 1px solid #ddd; padding: 12px 24px; font-size: 13px; }
  .top a { color: #0066cc; margin-right: 14px; text-decoration: none; }
  .wrap { padding: 16px 24px; }
  table { background: #fff; border-collapse: collapse; box-shadow: 0 1px 4px rgba(0,0,0,.1); border-radius: 6px; overflow: hidden; }
  td, th { padding: 10px 14px; border-bottom: 1px solid #eee; font-size: 13px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; }
  .meta { color: #666; font-size: 12px; margin: 8px 0 16px; }
</style></head>
<body>
  <div class="top"><strong>★ Projetos reais do app</strong>${PLAYGROUND_NAV}</div>
  <div class="wrap">
    <p class="meta">Lendo do backup automático mais recente: <code>${htmlEscape(backupName || "(nenhum)")}</code> — ${stamp}. ${finished.length} projeto(s) com Escrita gerada. Renderizado pelo MESMO caminho do botão "Baixar roteiro" do app, com o exporter já corrigido.</p>
    <table>
      <tr><th>Projeto</th><th>Categoria</th><th>Protagonistas</th><th>Capítulos</th><th>Destaque</th><th></th></tr>
      ${rows || '<tr><td colspan="6">Nenhum projeto com Escrita no backup.</td></tr>'}
    </table>
  </div>
</body></html>`;
}

// Página do playground: dois textareas (estrutura + roteiro) + checkbox, e o
// HTML renderizado ao lado, do jeitinho que o app exporta.
function playgroundPage({ estrutura, roteiro, forceParte2, result, mmc, fmc }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Playground — destaque verde do POV</title>
<style>
  body { font-family: Arial, sans-serif; margin: 0; padding: 0; background: #f5f5f5; color: #222; }
  .top { background: #fff8dc; border-bottom: 1px solid #ddd; padding: 12px 24px; font-size: 13px; }
  .top a { color: #0066cc; margin-right: 14px; text-decoration: none; }
  .top a:hover { text-decoration: underline; }
  .wrap { display: flex; gap: 16px; padding: 16px 24px; align-items: flex-start; flex-wrap: wrap; }
  form { flex: 1 1 420px; min-width: 340px; background: #fff; padding: 16px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
  label { display: block; font-weight: bold; font-size: 13px; margin: 12px 0 4px; }
  label.cb { font-weight: normal; font-size: 12px; color: #555; }
  textarea { width: 100%; box-sizing: border-box; font-family: Consolas, monospace; font-size: 12px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
  .est { height: 110px; }
  .rot { height: 380px; }
  button { margin-top: 12px; background: #2563eb; color: #fff; border: 0; padding: 10px 20px; border-radius: 4px; font-size: 14px; cursor: pointer; }
  .result { flex: 1 1 480px; min-width: 380px; }
  .names { background: #fff; padding: 10px 14px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
  .names code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
  .doc { background: #fff; padding: 28px 36px; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.1); }
  .legend { font-size: 12px; color: #555; margin: 6px 0 0; }
  .chip { background: #d9ead3; padding: 1px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <div class="top">
    <strong>🧪 Playground do destaque verde</strong> — cole o roteiro + a estrutura e clique Renderizar. <span class="chip">verde</span> = POV masculino (MMC). A heroína (FMC) <strong>NUNCA</strong> pode ficar verde.
    <div style="margin-top:8px">${PLAYGROUND_NAV}</div>
  </div>
  <div class="wrap">
    <form method="POST" action="/playground">
      <label>Estrutura <span style="font-weight:normal;color:#777">(pra detectar os nomes MMC/FMC — opcional)</span></label>
      <textarea class="est" name="estrutura" placeholder="Cole a saída da Estrutura (com (MMC)/(FMC) ou linhas Nome:)">${htmlEscape(estrutura)}</textarea>
      <label>Roteiro <span style="font-weight:normal;color:#777">(markdown da Escrita)</span></label>
      <textarea class="rot" name="roteiro" placeholder="Cole o roteiro — Parte 2, ou completo com # PARTE 1 / # PARTE 2">${htmlEscape(roteiro)}</textarea>
      <label class="cb"><input type="checkbox" name="forceParte2" ${forceParte2 ? "checked" : ""}> Forçar Parte 2 (marque se colou SÓ a Parte 2, sem o cabeçalho <code>#&nbsp;PARTE&nbsp;2</code>; ignorado se o texto já tiver esse cabeçalho)</label>
      <button type="submit">Renderizar →</button>
    </form>
    <div class="result">
      <div class="names">
        MMC detectado: <code>${htmlEscape(mmc ?? "—")}</code> (fica verde) &nbsp;·&nbsp; FMC detectada: <code>${htmlEscape(fmc ?? "—")}</code> (nunca verde)
        <p class="legend">✅ Confira: trechos do MMC com fundo verde; toda a narração da heroína — <strong>inclusive depois de um <code>---</code></strong> — SEM cor.</p>
      </div>
      <div class="doc">${result || "<em style='color:#999'>O resultado renderizado aparece aqui.</em>"}</div>
    </div>
  </div>
</body>
</html>`;
}

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
  <div style="margin-top:8px">${PLAYGROUND_NAV}</div>
</div>
<div class="doc">
${html}
</div>
</body>
</html>`;
  return wrapper;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];

    // Playground — formulário pra colar roteiro + estrutura e renderizar.
    if (url === "/playground") {
      let estrutura = ESTRUTURA_ALPHAKING_THOREN;
      let roteiro = ROTEIRO_ALPHAKING_HEROINA_APOS_EXCERTO;
      let forceParte2 = true;
      if (req.method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        estrutura = params.get("estrutura") || "";
        roteiro = params.get("roteiro") || "";
        forceParte2 = params.get("forceParte2") === "on";
      }
      const { result, mmc, fmc } = renderPlayground(estrutura, roteiro, forceParte2);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(playgroundPage({ estrutura, roteiro, forceParte2, result, mmc, fmc }));
      return;
    }

    // Lista dos projetos REAIS do app (backup mais recente).
    if (url === "/projetos") {
      const data = loadBackupRoteiros();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(projetosListPage(data));
      return;
    }

    // Render de UM projeto real, igual o DownloadEscritaButton do app.
    if (url === "/projeto") {
      const id = new URLSearchParams((req.url || "").split("?")[1] || "").get("id");
      const { roteiros, backupName } = loadBackupRoteiros();
      const r = roteiros.find((x) => x.id === id);
      if (!r) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<p style="font-family:Arial;padding:24px">Projeto <code>${htmlEscape(id || "")}</code> não encontrado no backup <code>${htmlEscape(backupName || "")}</code>. <a href="/projetos">← voltar</a></p>`);
        return;
      }
      const { body: docBody, mmc, fmc } = renderRoteiroLikeApp(r);
      const title = `${r.title || "Roteiro"} — ${r.category}`;
      const info = `Projeto REAL do app · MMC <code>${htmlEscape(mmc || "—")}</code> (fica verde) · FMC <code>${htmlEscape(fmc || "—")}</code> (NUNCA verde). Role a Parte 2: o homem em verde, a heroína SEM cor mesmo depois dos <code>---</code>.`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageWith(title, docBody, info));
      return;
    }

    let title, body, info;

    if (url === "/alphaking-print") {
      // Cenário EXATO do print: excerto ✦ THOREN (MMC) + cena da heroína sem
      // marcador depois de um '---'. O verde tem que parar no '---'.
      const { parte2 } = splitRoteiroByParts(ROTEIRO_ALPHAKING_HEROINA_APOS_EXCERTO);
      const maleLeadName = extractMaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING_THOREN);
      const femaleLeadName = extractFemaleLeadNameFromEstrutura(ESTRUTURA_ALPHAKING_THOREN);
      title = "alpha-king — cena do print (Thoren + heroína após '---')";
      info = `MMC: <code>${maleLeadName}</code> (verde) · FMC: <code>${femaleLeadName}</code> (NUNCA verde). O excerto do Thoren fica verde; a cena da heroína DEPOIS do '---' fica SEM cor.`;
      body = escritaContentToHtml(parte2, { maleLeadName, femaleLeadName, forceParte2: true });
    } else if (url === "/parte2") {
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
    console.log(`\n  👉 TESTE A CORREÇÃO AQUI:`);
    console.log(`  /projetos          → SEUS projetos reais do app (backup mais recente)`);
    console.log(`  /playground        → COLE seu roteiro + estrutura e renderize`);
    console.log(`  /alphaking-print   → o cenário exato do print (já corrigido)`);
    console.log(`\n  Fixtures de referência:`);
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
