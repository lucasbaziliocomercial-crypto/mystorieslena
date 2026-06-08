import type {
  RevisorError,
  StepGenerationSnapshot,
  StepOutput,
} from "@/types/roteiro";

/**
 * Agrega os títulos dos erros já destacados em rodadas anteriores de revisão —
 * o output corrente (rodada prestes a ser arquivada) + todos os snapshots no
 * histórico do step — pra mandar pro agente como `previousRevisorErrors`
 * ("não relista esses"), forçando refinamento incremental rodada após rodada.
 *
 * **Escopado por step pelo caller:** passe SÓ o output e o histórico de UM step
 * de revisor (revisor1 OU revisor2) — erros de uma Parte não devem vazar pra
 * continuação da outra.
 *
 * Cada erro vira `"<título> (Parte N, Cap. M) [Gravidade]"`, deduplicado por
 * título+localização (a mesma issue ressurgindo em rodadas diferentes entra uma
 * vez só). Devolve `[]` quando não há nada a evitar.
 *
 * Extraído do `StepShell` (era inline no modo "Continuar revisão") pra ser
 * reusável agora que a continuação roda pela fila, não no componente.
 */
export function aggregatePreviousRevisorErrors(
  currentOutput: StepOutput | undefined,
  history: StepGenerationSnapshot[] | undefined,
): string[] {
  const seen = new Set<string>();
  const aggregate: string[] = [];

  const pushIfNew = (e: RevisorError) => {
    const loc: string[] = [];
    if (typeof e.parte === "number") loc.push(`Parte ${e.parte}`);
    if (typeof e.capitulo === "number") loc.push(`Cap. ${e.capitulo}`);
    const locStr = loc.length > 0 ? ` (${loc.join(", ")})` : "";
    const gravLabel =
      e.gravidade === "gravissimo"
        ? "Gravíssimo"
        : e.gravidade === "interfere"
          ? "Interfere"
          : e.gravidade === "atencao"
            ? "Atenção"
            : "Não interfere";
    const formatted = `${e.titulo.trim()}${locStr} [${gravLabel}]`;
    const key = formatted.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    aggregate.push(formatted);
  };

  // Output corrente (rodada que está sendo arquivada agora).
  if (currentOutput?.metadata?.errors) {
    for (const e of currentOutput.metadata.errors) pushIfNew(e);
  }
  // Snapshots históricos (rodadas anteriores já arquivadas).
  for (const snap of history ?? []) {
    if (snap.metadata?.errors) {
      for (const e of snap.metadata.errors) pushIfNew(e);
    }
  }

  return aggregate;
}
