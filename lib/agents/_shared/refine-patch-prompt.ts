/**
 * Helpers para montar a instrução de saída em refineMode — quando a roteirista
 * pediu uma CORREÇÃO PONTUAL e o agente NÃO deve regenerar o output inteiro.
 *
 * Formato de saída: pares `<alteracao><original>…</original><corrigido>…</corrigido></alteracao>`
 * casados pelo frontend via [lib/parse-correction-patches.ts](../parse-correction-patches.ts)
 * (`parseCorrectionPatches` + `applyCorrectionPatches`). Find+replace literal com
 * fallback fuzzy.
 *
 * Esse padrão já existia inline em [lib/agents/mafia/revisor.ts] e
 * [lib/agents/milionario1p/estrutura1.ts]; centralizado aqui pra ser
 * compartilhado também por Premissa e Overview a partir da 1.0.62 (a Premissa
 * regenerava o resumo inteiro mesmo em instruções pontuais — feedback da
 * roteirista, 2026-05-12).
 *
 * Sentinela `[NENHUMA_ALTERACAO_NECESSARIA]` (linha 1165 do StepShell) é
 * respeitada — se o modelo julgar que a instrução não exige mudança, devolve
 * só essa string e o frontend mantém o output corrente intacto.
 */

export interface RefinePatchPromptOpts {
  /** Texto curto que descreve o que é o "output atual" — ex.: "RESUMO ATUAL", "ROTEIRO ATUAL". */
  currentLabel: string;
  /** Conteúdo atual do step que vai servir de base do find+replace. */
  currentOutput: string;
  /** Instrução de correção da roteirista. */
  userInstruction: string;
  /** Regras extras opcionais (formato/quebra/voz narrativa) que precisam ser preservadas. */
  extraRules?: string[];
}

/**
 * Monta o user message completo para um agente rodando em refineMode. Já
 * inclui o cabeçalho "FORMATO DE SAÍDA OBRIGATÓRIO" com exemplos e regras.
 */
export function buildRefinePatchPrompt(opts: RefinePatchPromptOpts): string {
  const { currentLabel, currentOutput, userInstruction, extraRules = [] } = opts;
  const parts: string[] = [];

  parts.push(
    "Você JÁ entregou esse conteúdo. A roteirista pediu uma CORREÇÃO PONTUAL — NÃO regenere do zero, NÃO reescreva trechos que ela não pediu pra mudar. Devolva APENAS as alterações no formato XML descrito abaixo.",
  );

  parts.push(
    `━━━ ${currentLabel} (consulte mas NÃO devolva inteiro) ━━━\n\n${currentOutput.trim()}`,
  );

  parts.push(
    `━━━ INSTRUÇÃO DE CORREÇÃO DA ROTEIRISTA ━━━\n\n${userInstruction.trim()}`,
  );

  const extraBlock =
    extraRules.length > 0
      ? `\n\nREGRAS ESPECÍFICAS QUE PRECISAM SER PRESERVADAS (não viole no <corrigido>):\n${extraRules.map((r) => `• ${r}`).join("\n")}`
      : "";

  parts.push(
    [
      "━━━ FORMATO DE SAÍDA OBRIGATÓRIO ━━━",
      "",
      "Para cada trecho que precisa mudar, emita um bloco:",
      "",
      "<alteracao>",
      "<descricao>linha curta explicando o que muda</descricao>",
      "<original>",
      "[trecho EXATO do texto atual — copie LITERAL, com mesma quebra de linha, mesmas aspas, mesmos travessões, mesmos cabeçalhos. Tem que ser ÚNICO no texto atual (pegue contexto suficiente pra não casar em outro trecho parecido).]",
      "</original>",
      "<corrigido>",
      "[trecho novo que substitui o original. Pode ser vazio (string vazia) se a intenção é REMOVER o trecho. Mantenha o MESMO formato/estrutura/quebra de parágrafo do original — só mude o conteúdo que a instrução pediu.]",
      "</corrigido>",
      "</alteracao>",
      "",
      "REGRAS RIGOROSAS:",
      "• Um bloco <alteracao> por trecho que muda. Pode haver vários.",
      "• <original> precisa ser cópia LITERAL e ÚNICA no texto atual.",
      "• NÃO mexa em trechos que a instrução não pediu pra mudar — fica como está.",
      "• NÃO devolva o texto inteiro. NÃO escreva markdown explicativo fora dos blocos <alteracao>.",
      "• Se a instrução for AMPLA DEMAIS pra ser pontual (ex.: \"reescreva tudo num tom mais sombrio\"), responda APENAS [NENHUMA_ALTERACAO_NECESSARIA] e nada mais — o frontend mostrará à roteirista que ela precisa usar o botão de regenerar do zero.",
      "• Se a instrução pedir mudar um nome/lugar/detalhe que aparece em VÁRIAS partes, emita um <alteracao> por ocorrência (cada um com contexto único no <original>).",
      `${extraBlock}`,
      "",
      "Comece direto pelo primeiro <alteracao>. Sem preâmbulo, sem perguntas.",
    ].join("\n"),
  );

  return parts.join("\n\n");
}
