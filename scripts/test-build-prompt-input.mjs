// E2E do prompt builder — confirma que o user message vai com cache_control
// na forma estruturada esperada pelo Anthropic prompt caching.
// Roda com: node --experimental-strip-types scripts/test-build-prompt-input.mjs
import { buildPromptInput } from "../lib/claude.ts";

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

// CASE 1: texto simples (sem imagem) — caso default do Revisor
{
  const iter = buildPromptInput({ userMessage: "Roteiro fake aqui." });
  const yields = [];
  for await (const m of iter) yields.push(m);

  check("CASE 1: yields exatamente 1 message", yields.length === 1);
  const msg = yields[0];
  check("CASE 1: type=user", msg?.type === "user");
  check("CASE 1: role=user", msg?.message?.role === "user");
  check(
    "CASE 1: content é array",
    Array.isArray(msg?.message?.content),
  );
  const content = msg.message.content;
  check("CASE 1: 1 block de content (só texto)", content.length === 1);
  const textBlock = content[0];
  check("CASE 1: block é text", textBlock?.type === "text");
  check(
    "CASE 1: text contém o userMessage",
    textBlock?.text === "Roteiro fake aqui.",
  );
  check(
    "CASE 1: cache_control = ephemeral ✨ (o teste-chave)",
    textBlock?.cache_control?.type === "ephemeral",
    `cache_control real: ${JSON.stringify(textBlock?.cache_control)}`,
  );
}

// CASE 2: com imagem (Estrutura 1 com referência visual) — texto também tem cache_control
{
  const iter = buildPromptInput({
    userMessage: "Premissa fake.",
    image: {
      base64Data: "FAKEBASE64",
      mimeType: "image/jpeg",
    },
  });
  const yields = [];
  for await (const m of iter) yields.push(m);

  const content = yields[0]?.message?.content ?? [];
  check("CASE 2: 2 blocks (imagem + texto)", content.length === 2);
  check("CASE 2: primeiro block é image", content[0]?.type === "image");
  check(
    "CASE 2: imagem NÃO tem cache_control (só o texto)",
    content[0]?.cache_control === undefined,
  );
  check("CASE 2: segundo block é text", content[1]?.type === "text");
  check(
    "CASE 2: texto TEM cache_control ephemeral",
    content[1]?.cache_control?.type === "ephemeral",
  );
}

// CASE 3: garantir que múltiplas chamadas com mesmo userMessage geram conteúdo IDÊNTICO
// (cache key é derivada do conteúdo — qualquer drift entre chamadas mata o hit)
{
  const a = buildPromptInput({ userMessage: "X" });
  const b = buildPromptInput({ userMessage: "X" });
  const ya = [];
  const yb = [];
  for await (const m of a) ya.push(m);
  for await (const m of b) yb.push(m);
  check(
    "CASE 3: chamadas idempotentes geram JSON idêntico (cache key estável)",
    JSON.stringify(ya) === JSON.stringify(yb),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
