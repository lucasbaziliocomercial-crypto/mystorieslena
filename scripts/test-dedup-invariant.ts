/**
 * Testes da invariante anti-duplicação da Escrita.
 *
 * Roda com:  npx tsx scripts/test-dedup-invariant.mts
 *
 * Cobre os 5 cenários do plano de fix:
 *   1. dedup-invariant: normalize remove duplicatas (longest), idempotente.
 *   2. refine-merge-part-canon: canonPart casa "Parte 1" com undefined.
 *   3. batch-overlap: dedupChaptersLast prefere o mais recente.
 *   4. monolithic-edit-preserves: edited=true preserva content editado.
 *   5. load-autoheal: normalize em load corrige roteiro corrompido.
 *
 * Sem suíte formal no projeto — scripts standalone são o padrão (vide
 * scripts/test-escrita-batch.mjs, test-build-prompt-input.mjs etc).
 */

import {
  canonPart,
  dedupChaptersLast,
  dedupChapters,
} from "../lib/dedup-chapters.ts";
import { normalizeEscritaOutput } from "../lib/normalize-escrita.ts";
import type { EscritaChapter, StepOutput } from "../types/roteiro.ts";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function eq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${e}`);
    console.log(`      actual:   ${a}`);
  }
}

function mkCh(
  number: number,
  part: string | undefined,
  body: string,
  title?: string,
): EscritaChapter {
  return {
    number,
    part,
    title: title ?? `Cap ${number}`,
    content: body,
    generatedAt: new Date(2026, 0, 1).toISOString(),
  };
}

// ─── 1. canonPart ─────────────────────────────────────────────────────
console.log("─── canonPart ───");
eq(canonPart(undefined), "parte 1", "undefined → 'parte 1'");
eq(canonPart(null), "parte 1", "null → 'parte 1'");
eq(canonPart(""), "parte 1", "'' → 'parte 1'");
eq(canonPart("Parte 1"), "parte 1", "'Parte 1' → 'parte 1'");
eq(canonPart(" parte 1 "), "parte 1", "'  parte 1  ' → 'parte 1'");
eq(canonPart("PARTE 2"), "parte 2", "'PARTE 2' → 'parte 2'");

// ─── 2. dedup-invariant via normalizeEscritaOutput (longest) ──────────
console.log("\n─── normalizeEscritaOutput (longest) ───");
{
  // dedupChapters faz tiebreak por countWords — content precisa ter
  // palavras reais separadas por espaço (não "x".repeat) pra tiebreak rodar.
  const words = (w: string, n: number) => Array(n).fill(w).join(" ");
  const chapters = [
    mkCh(1, "Parte 1", words("alfa", 100), "A"),
    mkCh(2, "Parte 1", words("beta", 200), "B"),
    mkCh(2, "Parte 1", words("gamma", 500), "B"), // duplicata mais longa
    mkCh(2, "Parte 1", words("delta", 150), "B"),
    mkCh(3, "Parte 2", words("eps", 300), "C"),
  ];
  const out: StepOutput = { content: "old", metadata: { chapters } };
  const r = normalizeEscritaOutput(out, { strategy: "longest", source: "test" });
  eq(r.changed, true, "longest: muda quando há duplicata");
  eq(r.removed, 2, "longest: remove 2 duplicatas de Cap 2");
  eq(r.output.metadata!.chapters!.length, 3, "longest: array com 3 caps");
  const cap2 = r.output.metadata!.chapters!.find((c) => c.number === 2)!;
  assert(
    cap2.content.startsWith("gamma"),
    "longest: Cap 2 mantém versão mais longa (gamma × 500 palavras)",
  );
  assert(
    r.output.content.includes("# Capítulo 1"),
    "longest: content tem header Cap 1",
  );
  assert(
    r.output.content.includes("# Capítulo 2"),
    "longest: content tem header Cap 2",
  );
  assert(
    r.output.content.split("# Capítulo 2").length === 2,
    "longest: header Cap 2 aparece exatamente 1 vez no content",
  );

  // Idempotência: rodar novamente é no-op
  const r2 = normalizeEscritaOutput(r.output, {
    strategy: "longest",
    source: "test",
  });
  eq(r2.changed, false, "longest: idempotente (segundo run não muda)");
  eq(r2.removed, 0, "longest: idempotente (zero removidos no segundo run)");
}

// ─── 3. refine-merge-part-canon ───────────────────────────────────────
console.log("\n─── refine-merge: canonPart casa undefined com 'Parte 1' ───");
{
  // Cenário: previousChapters tem cap com part="Parte 1", incoming tem cap
  // sem part definida. Sem canonPart eles não casam → duplicata.
  const previous: EscritaChapter[] = [
    mkCh(5, "Parte 1", "antigo", "Antigo"),
  ];
  const incoming: EscritaChapter[] = [
    { ...mkCh(5, undefined, "novo", "Novo") },
  ];

  const merged = previous.map((existing) => {
    const replacement = incoming.find(
      (i) =>
        i.number === existing.number &&
        canonPart(i.part) === canonPart(existing.part),
    );
    return replacement
      ? { ...existing, title: replacement.title, content: replacement.content }
      : existing;
  });
  const newOnes = incoming.filter(
    (i) =>
      !previous.some(
        (e) =>
          e.number === i.number && canonPart(e.part) === canonPart(i.part),
      ),
  );
  merged.push(...newOnes);

  eq(merged.length, 1, "refine-merge: 1 cap final (não 2)");
  eq(merged[0]!.content, "novo", "refine-merge: content é o incoming");
  eq(newOnes.length, 0, "refine-merge: zero newOnes (não vira append)");
}

// ─── 4. batch-overlap: dedupChaptersLast prefere o último ─────────────
console.log("\n─── dedupChaptersLast (semântica 'last') ───");
{
  // Simula loop de batches: batch 1 emite Cap 5 com 800 palavras de content;
  // batch 2 (regeneração no meio) emite Cap 5 com 1200 palavras.
  // Estratégia "last" deve manter o segundo (mais recente), não o mais longo.
  const accChapters: EscritaChapter[] = [
    mkCh(5, "Parte 1", "primeira-versao " + "x".repeat(800)),
    mkCh(6, "Parte 1", "outro"),
    mkCh(5, "Parte 1", "segunda-versao " + "x".repeat(1200)),
  ];
  const r = dedupChaptersLast(accChapters);
  eq(r.removed, 1, "batch-overlap: 1 duplicata removida");
  eq(r.chapters.length, 2, "batch-overlap: 2 caps restantes");
  const cap5 = r.chapters.find((c) => c.number === 5)!;
  assert(
    cap5.content.startsWith("segunda-versao"),
    "batch-overlap: Cap 5 mantém a versão mais recente (segunda)",
  );
}

// ─── 5. monolithic-edit-preserves ─────────────────────────────────────
console.log("\n─── normalizeEscritaOutput preserva edição manual ───");
{
  const chapters = [
    mkCh(1, "Parte 1", "original-a"),
    mkCh(2, "Parte 1", "original-b"),
  ];
  // Roteirista editou o content monolítico — flag edited=true protege a edição.
  const edited: StepOutput = {
    content: "TEXTO TOTALMENTE EDITADO PELA ROTEIRISTA",
    metadata: { chapters },
    edited: true,
  };
  const r = normalizeEscritaOutput(edited, { strategy: "longest" });
  eq(
    r.output.content,
    "TEXTO TOTALMENTE EDITADO PELA ROTEIRISTA",
    "edit-preserves: content editado não é re-derivado",
  );
  eq(
    r.output.metadata!.chapters!.length,
    2,
    "edit-preserves: chapters intacto",
  );

  // Mesmo cenário mas com duplicatas — chapters dedupa, content fica.
  const chaptersDup = [
    mkCh(1, "Parte 1", "a"),
    mkCh(1, "Parte 1", "a-longer"),
    mkCh(2, "Parte 1", "b"),
  ];
  const editedDup: StepOutput = {
    content: "TEXTO EDITADO",
    metadata: { chapters: chaptersDup },
    edited: true,
  };
  const rDup = normalizeEscritaOutput(editedDup, { strategy: "longest" });
  eq(
    rDup.output.content,
    "TEXTO EDITADO",
    "edit-preserves: content editado preservado mesmo com duplicatas",
  );
  eq(
    rDup.output.metadata!.chapters!.length,
    2,
    "edit-preserves: chapters dedupado (3 → 2)",
  );
}

// ─── 6. load-autoheal: roteiro de 40k é normalizado ───────────────────
console.log("\n─── load-autoheal: simulação do roteiro corrompido ───");
{
  // Reproduz o cenário do screenshot: 11 capítulos esperados mas 5 duplicados.
  // Cada cap ~2300 palavras → total real ~25k. Duplicados inflam pra ~40k.
  const chapters: EscritaChapter[] = [];
  for (let i = 1; i <= 5; i++) {
    chapters.push(mkCh(i, "Parte 1", `cap-${i}-original `.repeat(300)));
  }
  // 5 duplicatas com content mais curto (simulando regen anterior parcial)
  for (let i = 1; i <= 5; i++) {
    chapters.push(mkCh(i, "Parte 1", `cap-${i}-shorter `.repeat(200)));
  }
  for (let i = 6; i <= 11; i++) {
    chapters.push(mkCh(i, "Parte 1", `cap-${i}-original `.repeat(300)));
  }
  const corrupted: StepOutput = {
    content: chapters.map((c) => c.content).join("\n\n"),
    metadata: { chapters },
  };
  eq(corrupted.metadata!.chapters!.length, 16, "load-autoheal: input tem 16 caps (11 + 5 duplicatas)");
  const r = normalizeEscritaOutput(corrupted, {
    strategy: "longest",
    source: "test-load",
  });
  eq(r.removed, 5, "load-autoheal: 5 duplicatas removidas");
  eq(r.output.metadata!.chapters!.length, 11, "load-autoheal: 11 caps restantes");
  // Versões mantidas: as "original" (mais longas, 300x) vs "shorter" (200x).
  // dedupChapters mantém a maior — mas só agrupa por (part, number, title),
  // então as 2 versões precisam ter MESMO title pra dedupar. mkCh usa o mesmo
  // título quando não passa custom — então os Cap 1..5 originais e duplicatas
  // têm o mesmo title "Cap N".
  for (let i = 1; i <= 5; i++) {
    const cap = r.output.metadata!.chapters!.find((c) => c.number === i)!;
    assert(
      cap.content.includes("original"),
      `load-autoheal: Cap ${i} mantém a versão 'original' (mais longa)`,
    );
  }
}

// ─── 7. Idempotência da camada de store ───────────────────────────────
// Garante que mesmo se normalize roda 2x (uma no batch loop com "last", outra
// no setOutput com "longest"), o resultado é estável e não há perda de caps.
console.log("\n─── idempotência: last + longest em sequência ───");
{
  const chapters = [
    mkCh(1, "Parte 1", "a-original"),
    mkCh(2, "Parte 1", "b-original"),
    mkCh(2, "Parte 1", "b-regen-newer"),
    mkCh(3, "Parte 2", "c-original"),
  ];
  const lastResult = dedupChaptersLast(chapters);
  eq(lastResult.removed, 1, "seq: last remove 1 (mantém o segundo Cap 2)");
  eq(lastResult.chapters.length, 3, "seq: last → 3 caps");

  const stepOutput: StepOutput = {
    content: "",
    metadata: { chapters: lastResult.chapters },
  };
  const r = normalizeEscritaOutput(stepOutput, { strategy: "longest" });
  eq(r.removed, 0, "seq: longest sobre last-deduped → 0 a remover");
  eq(r.changed, true, "seq: longest re-deriva content (content vazio era stale)");
}

// ─── Resultados ────────────────────────────────────────────────────────
console.log(`\n─── Resultados: ${passed} passou, ${failed} falhou ───`);
if (failed > 0) process.exit(1);
