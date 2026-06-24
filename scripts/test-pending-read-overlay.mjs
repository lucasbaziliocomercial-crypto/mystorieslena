// Trava de regressão da CORRIDA DE LEITURA do cache (lib/storage.ts) — o bug do
// "projeto que terminou EM 2º PLANO abre EM BRANCO" na geração simultânea.
//
// CAUSA: `scheduleSave()` grava o resultado fresco em `pendingRoteiros`, mas o
// cache em memória só é atualizado depois, no drain assíncrono/idle (que ainda
// faz early-return quando há outra compressão em voo — comum com 2 jobs). Se a
// roteirista ABRE o projeto nessa janela, `getRoteiro()`/`listRoteiros()` liam o
// cache DEFASADO → tela em branco. FIX: a leitura passa a sobrepor o pendente.
//
// Este teste exercita o storage.ts REAL (não replica a lógica) — por isso ele
// PEGA uma regressão de verdade se alguém reverter o overlay. Usa o caminho
// SÍNCRONO (saveRoteiro/flushPendingSave) pra ser determinístico e não depender
// do Web Worker (indisponível em node — o código já degrada pra compress síncrono).
//
// Run: node scripts/test-pending-read-overlay.mjs   (Node ≥ 23)
import { register } from "node:module";

// ── Shim mínimo de browser ANTES de importar o storage (ele só toca `window` em
//    tempo de CHAMADA, então basta estar pronto antes dos asserts). ────────────
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = {
  localStorage,
  dispatchEvent: () => true,
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
};
globalThis.localStorage = localStorage;

// ── Registra o resolvedor de alias `@/` e importa o storage REAL. ─────────────
register("./_ts-alias-hooks.mjs", import.meta.url);
const storage = await import("../lib/storage.ts");
const {
  saveRoteiro,
  scheduleSave,
  getRoteiro,
  listRoteiros,
  flushPendingSave,
  deleteRoteiro,
  resetRoteirosCache,
} = storage;

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

const now = "2026-06-16T12:00:00.000Z";
function makeRoteiro(id, chapterContent) {
  return {
    id,
    title: `Projeto ${id}`,
    category: "milionario-1p",
    currentStep: "escrita",
    createdAt: now,
    updatedAt: now,
    outputs: {
      escrita: {
        content: chapterContent,
        metadata: {
          chapters: [
            {
              number: 1,
              part: "Parte 1",
              title: "Capítulo 1 — Início",
              content: chapterContent,
              generatedAt: now,
            },
          ],
        },
        generatedAt: now,
      },
    },
    history: {},
  };
}

const contentOf = (r) => r?.outputs?.escrita?.content ?? null;

// Estado limpo (limpa cache + pendentes).
resetRoteirosCache();
store.clear();

// ── CASE 1: o CORAÇÃO do bug — ler durante a janela pré-drain devolve o fresco ──
// Simula: cache tem a versão velha; um job de 2º plano acabou de gravar a nova
// via scheduleSave (ainda em pendingRoteiros, SEM drain). Abrir o projeto agora
// (getRoteiro) DEVE devolver a versão nova, não o cache defasado.
{
  saveRoteiro(makeRoteiro("A", "VERSAO_VELHA")); // cache + disco = velha
  check(
    "CASE 1: pré-condição — cache tem a versão velha",
    contentOf(getRoteiro("A")) === "VERSAO_VELHA",
  );
  scheduleSave(makeRoteiro("A", "VERSAO_NOVA")); // só em pendingRoteiros (sem drain)
  check(
    "CASE 1: getRoteiro devolve o PENDENTE (não o cache defasado)",
    contentOf(getRoteiro("A")) === "VERSAO_NOVA",
    `veio "${contentOf(getRoteiro("A"))}"`,
  );
  const listed = listRoteiros().find((r) => r.id === "A");
  check(
    "CASE 1: listRoteiros sobrepõe o pendente",
    contentOf(listed) === "VERSAO_NOVA",
    `veio "${contentOf(listed)}"`,
  );
}

// ── CASE 2: depois do drain síncrono, o cache fica em dia e o pendente some ────
{
  flushPendingSave(); // drena pendentes pro cache + grava no disco (síncrono)
  check(
    "CASE 2: pós-drain — getRoteiro segue na versão nova (agora do cache)",
    contentOf(getRoteiro("A")) === "VERSAO_NOVA",
  );
  // Outra leitura idêntica não deve regredir (idempotente).
  check(
    "CASE 2: leitura repetida estável",
    contentOf(getRoteiro("A")) === "VERSAO_NOVA",
  );
}

// ── CASE 3: roteiro NOVO que só existe em pendingRoteiros (nunca drenado) ──────
// Um projeto cuja 1ª gravação ainda não drenou também tem que ser visível.
{
  scheduleSave(makeRoteiro("C", "SO_PENDENTE"));
  check(
    "CASE 3: getRoteiro acha roteiro que só está em pendente",
    contentOf(getRoteiro("C")) === "SO_PENDENTE",
  );
  check(
    "CASE 3: listRoteiros inclui o roteiro só-pendente",
    !!listRoteiros().find((r) => r.id === "C"),
  );
  flushPendingSave();
}

// ── CASE 4: resetRoteirosCache descarta pendentes (import/restore) ────────────
// Defensivo: um pendente de antes não pode "ressuscitar" pelo overlay depois de
// um import/restore que substitui a biblioteca.
{
  scheduleSave(makeRoteiro("A", "PENDENTE_DESCARTAVEL"));
  resetRoteirosCache(); // import/restore limparia o cache E os pendentes
  // Pós-reset a leitura vem do disco e passa pela normalização (que pode embrulhar
  // o conteúdo com cabeçalho de PARTE), então comparamos por inclusão, não exato.
  const afterReset = contentOf(getRoteiro("A")) ?? "";
  check(
    "CASE 4: pós-reset, getRoteiro NÃO devolve o pendente descartado",
    !afterReset.includes("PENDENTE_DESCARTAVEL") &&
      afterReset.includes("VERSAO_NOVA"),
    `veio "${afterReset}"`,
  );
}

// ── CASE 5: deleteRoteiro vence o pendente (some da leitura) ──────────────────
{
  saveRoteiro(makeRoteiro("B", "B_VELHA"));
  scheduleSave(makeRoteiro("B", "B_PENDENTE"));
  deleteRoteiro("B");
  check("CASE 5: getRoteiro do excluído → null", getRoteiro("B") === null);
  check(
    "CASE 5: listRoteiros não lista o excluído",
    !listRoteiros().find((r) => r.id === "B"),
  );
}

// Cancela timers pendentes do scheduleSave pra o processo poder sair limpo.
flushPendingSave();

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
