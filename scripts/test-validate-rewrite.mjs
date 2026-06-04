// Smoke test do validate-rewrite — reproduz o cenário exato do bug da
// usuária Mac (instrução ecoada no lugar do capítulo) e casos de borda.
//
// Importa direto do .ts via node --import experimental? Não, projeto não
// usa tsx. Pra evitar setup, replica a função aqui em JS puro com a MESMA
// lógica do lib/validate-rewrite.ts. Se a lógica do .ts mudar, esse teste
// fica fora de sincronia — o que é OK pra script de smoke ad-hoc.
//
// Run: node scripts/test-validate-rewrite.mjs

function countWords(text) {
  if (!text) return 0;
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>~|—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length;
}

const INSTRUCTION_PREFIX_RE =
  /^\s*(?:Expandir|Encurtar|Adicionar|Remover|Reescrever|Incluir|Aplicar|Corrigir|Mudar|Substituir|Alterar|Trocar|Ajustar|Refazer)\b[^\n]{0,400}?(?:\([a-z]\)|aproximadamente\s+\d|conforme\s+(?:cravado|a\s+estrutura|o\s+aprovado))/i;

function normalizeForCompare(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function echoCoverage(triggerWords, windowText) {
  if (triggerWords.length === 0) return 0;
  const windowWords = windowText.split(" ").filter(Boolean);
  if (windowWords.length === 0) return 0;
  let bestRun = 0;
  for (let i = 0; i < windowWords.length; i++) {
    let run = 0;
    while (
      i + run < windowWords.length &&
      run < triggerWords.length &&
      windowWords[i + run] === triggerWords[run]
    ) {
      run++;
    }
    if (run > bestRun) bestRun = run;
  }
  return bestRun / triggerWords.length;
}

function validateRewrite({ newContent, originalContent, triggerText, targetWords }) {
  const trimmed = (newContent ?? "").trim();
  if (INSTRUCTION_PREFIX_RE.test(trimmed)) {
    return { ok: false, reason: "instruction-prefix" };
  }
  const newWords = countWords(newContent);
  const baseline = targetWords ?? countWords(originalContent ?? "");
  if (baseline > 0) {
    if (newWords < Math.max(30, Math.floor(baseline * 0.5))) {
      return { ok: false, reason: "too-short", newWords, baseline };
    }
    if (newWords > Math.ceil(baseline * 2.0)) {
      return { ok: false, reason: "too-long", newWords, baseline };
    }
  }
  if (triggerText && triggerText.trim()) {
    const normalizedTrigger = normalizeForCompare(triggerText);
    const triggerWords = normalizedTrigger.split(" ").filter(Boolean);
    if (triggerWords.length >= 8 && newWords >= 30) {
      const normalizedNew = normalizeForCompare(newContent);
      const allWords = normalizedNew.split(" ").filter(Boolean);
      const prefixLen = Math.max(triggerWords.length, Math.floor(allWords.length * 0.3));
      const prefix = allWords.slice(0, prefixLen).join(" ");
      const coverage = echoCoverage(triggerWords, prefix);
      if (coverage >= 0.8) {
        return { ok: false, reason: "echo", coverage };
      }
    }
  }
  return { ok: true };
}

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// --- CASO DO BUG REAL DA USUÁRIA (screenshot) ---
const userInstruction = `Expandir a seção POV Damien do Cap. 1 P2 para aproximadamente 1.000 palavras, conforme cravado na estrutura aprovada. Incluir: (a) panorama emocional dos três meses de paz vistos por dentro dele, com cenas curtas concretas (não apenas listas de cheiros); (b) a chegada à torre na manhã da bomba, com o contexto da contratação imposta de Reverie por Lennox; (c) a entrada na sala, a tentativa de Reverie no sofá em câmera lenta, o empurrão dele, o sussurro dela ("ela já está subindo, vai dar tudo certo"), e o congelamento exato no segundo em que a maçaneta gira.`;

const malformedFromOpus = `${userInstruction} Encerrar o POV no instante em que Maren entra no plano, e só então passar para o POV dela. Cheiro de magnólia sintética do shampoo da Briar quando ela passava o fim de semana com a gente e largava a toalha em cima da bancada do banheiro de hóspedes. Cheiro do antisséptico distante da clínica de Long Island, onde Ottilie agora ria de coisas que eu não entendia mas que faziam Maren respirar como se o peito fosse mais largo.

Três meses. Foi o que eu tive antes de tudo voltar a ser ferro.

Ela tinha mudado de cor em janeiro. Eu reparei numa terça à noite, quando ela passou pela sala de mãos vazias e apenas se sentou ao meu lado no sofá, sem agenda, sem caneta, sem motivo. Encostou a têmpora no meu ombro. Eu fiquei sem respirar por dois segundos porque, pela primeira vez em catorze anos, estava sendo tocado sem cálculo.`;

const originalChapter = `Três meses. Foi o que eu tive antes de tudo voltar a ser ferro. Ela tinha mudado de cor em janeiro. Eu reparei numa terça à noite, quando ela passou pela sala de mãos vazias e apenas se sentou ao meu lado no sofá, sem agenda, sem caneta, sem motivo.`;

t("BUG REAL: instrução ecoada como capítulo deve ser rejeitada", () => {
  const r = validateRewrite({
    newContent: malformedFromOpus,
    originalContent: originalChapter,
    triggerText: userInstruction,
    targetWords: 1000,
  });
  if (r.ok) throw new Error(`Esperava rejeitar, mas passou: ${JSON.stringify(r)}`);
  return `rejeitou com reason="${r.reason}"`;
});

t("BUG REAL: instruction-prefix sozinho já pega", () => {
  const r = validateRewrite({
    newContent: userInstruction,
    originalContent: originalChapter,
    targetWords: 1000,
  });
  if (r.ok || r.reason !== "instruction-prefix")
    throw new Error(`Esperava instruction-prefix, veio ${JSON.stringify(r)}`);
  return "ok";
});

// --- CASO BOM: capítulo narrativo legítimo ---
const goodChapter = `Três meses. Foi o que eu tive antes de tudo voltar a ser ferro.

Ela tinha mudado de cor em janeiro. Eu reparei numa terça à noite, quando ela passou pela sala de mãos vazias e apenas se sentou ao meu lado no sofá, sem agenda, sem caneta, sem motivo. Encostou a têmpora no meu ombro. Eu fiquei sem respirar por dois segundos porque, pela primeira vez em catorze anos, estava sendo tocado sem cálculo. Foi nesse instante que eu entendi que tinha caído mais fundo do que ela imaginava.

Em fevereiro, ela contou uma piada na mesa de jantar com Stellan, Briar e a minha mãe. Não me lembro do conteúdo, só do som da risada dela quando os outros riram primeiro — um som que eu nunca tinha escutado, áspero e curto, sem o cuidado de soar bonito. Foi nesse instante que eu entendi outra coisa: ela estava começando a confiar de verdade, daquela forma que só acontece quando o corpo decide antes da cabeça.

Em março, foi o gesto. Eu estava no escritório lendo um relatório de risco e ela entrou sem bater, descalça, com o cabelo molhado da piscina. Atravessou o tapete e se inclinou sobre o meu ombro pra ler o que eu lia. Não disse nada. Só ficou ali, respirando perto do meu pescoço, com a mão pousada nas costas da minha cadeira como se aquele móvel também fosse dela. Eu não virei. Eu não falei. Eu só fechei os olhos por um segundo pra gravar a sensação, sabendo, de algum modo idiota, que eu ia precisar daquela memória depois. Quase como se o corpo soubesse que isso ia acabar.`;

t("CASO BOM: capítulo narrativo realista deve passar", () => {
  const r = validateRewrite({
    newContent: goodChapter,
    originalContent: originalChapter,
    triggerText: userInstruction,
    targetWords: 280,
  });
  if (!r.ok) throw new Error(`Esperava passar, rejeitou com ${JSON.stringify(r)}`);
  return "ok";
});

// --- CASO BORDA: truncado (poucas palavras) ---
t("CASO BORDA: capítulo truncado (10 palavras) deve falhar como too-short", () => {
  const r = validateRewrite({
    newContent: "Três meses. Foi o que eu tive antes de tudo voltar.",
    originalContent: originalChapter,
    targetWords: 1000,
  });
  if (r.ok || r.reason !== "too-short")
    throw new Error(`Esperava too-short, veio ${JSON.stringify(r)}`);
  return "ok";
});

// --- CASO BORDA: trigger curto demais não dispara echo ---
t("CASO BORDA: triggerText curto não dispara false-positive de echo", () => {
  const r = validateRewrite({
    newContent: goodChapter,
    originalContent: originalChapter,
    triggerText: "ajusta",
    targetWords: 280,
  });
  if (!r.ok) throw new Error(`Esperava passar, veio ${JSON.stringify(r)}`);
  return "ok";
});

// --- CASO BORDA: capítulo não começa com instrução, mas tem briefing no meio ---
t("CASO BORDA: briefing no meio do texto NÃO dispara instruction-prefix", () => {
  const text = `Eu estava no carro quando ouvi a primeira sirene.

Expandir o peito ficou impossível. (Mais palavras pra completar o capítulo realista no estilo Helô. Cheiros, texturas, diálogos curtos. ${"palavra ".repeat(200)})`;
  const r = validateRewrite({
    newContent: text,
    originalContent: originalChapter,
    targetWords: 280,
  });
  if (!r.ok) throw new Error(`Esperava passar, veio ${JSON.stringify(r)}`);
  return "ok";
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    const out = fn();
    console.log(`✓ ${name} — ${out ?? ""}`);
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n   ${e.message}`);
    failed++;
  }
}
console.log(`\n${passed}/${tests.length} passou${failed ? `, ${failed} falhou` : ""}`);
process.exit(failed ? 1 : 0);
