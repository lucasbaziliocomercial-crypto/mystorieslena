/**
 * Helper compartilhado pelos agentes Estrutura P1/P2 (milionario-1p,
 * milionario-3p, mafia) — monta o user message no modo "Continuar de onde
 * parou" quando a geração anterior foi interrompida no meio do stream.
 *
 * O agente recebe o trecho parcial em `partial` e deve continuar
 * EXATAMENTE de onde parou: sem repetir, sem recomeçar, sem resumir,
 * mantendo numeração, formato de tabela, estilo e tom idênticos.
 *
 * Diferente do modo `refineMode` (que ajusta uma versão completa).
 */
import { buildCanoneBlock } from "./_shared/canone-block";

export function buildEstruturaContinuationMessage(args: {
  parteLabel: "PARTE 1" | "PARTE 2";
  partial: string;
  userInput?: string;
  /** Cânone de Entidades — se presente, vai como referência canônica
   *  para nomes/idades/lugares/datas durante a continuação. */
  canone?: string;
}): string {
  const { parteLabel, partial, userInput, canone } = args;
  const sections: string[] = [];

  sections.push(
    [
      `⚠ MODO CONTINUAÇÃO — geração da ESTRUTURA da ${parteLabel} foi interrompida ⚠`,
      "",
      "Abaixo está EXATAMENTE o que você já gerou na rodada anterior antes de ser interrompido. Sua tarefa agora é CONTINUAR a partir do ponto onde o trecho termina — não repita, não recomece, não resuma, não comente, não anuncie que está continuando.",
      "",
      "REGRAS DURAS:",
      "• Mantenha numeração, formato de tabela, cabeçalhos, estilo e tom IDÊNTICOS ao trecho parcial.",
      "• Se o último parágrafo/linha do parcial está cortado no meio (frase incompleta, palavra cortada, linha de tabela truncada), COMPLETE-O primeiro antes de seguir adiante.",
      "• Se o parcial já terminou um capítulo limpo, prossiga direto pro próximo capítulo (não duplique cabeçalho).",
      "• Não escreva nada antes do texto novo — sem preâmbulo do tipo \"Continuando…\" ou \"…\". Comece direto pelo caractere que vem depois do último caractere do parcial.",
      "• Mantenha as mesmas regras de tamanho de palavras, ritmo e estrutura definidas no system prompt — você está terminando a MESMA estrutura, não fazendo uma nova.",
    ].join("\n"),
  );

  const canoneBlock = buildCanoneBlock(canone);
  if (canoneBlock) {
    sections.push(canoneBlock);
  }

  if (userInput?.trim()) {
    sections.push(
      `━━━ INSTRUÇÕES ADICIONAIS DA ROTEIRISTA (ajustes opcionais para a continuação) ━━━\n\n${userInput.trim()}`,
    );
  }

  sections.push(
    `━━━ TRECHO JÁ GERADO (PARCIAL — continue exatamente daqui) ━━━\n\n${partial}\n\n━━━ FIM DO TRECHO PARCIAL — CONTINUE A PARTIR DAQUI ━━━`,
  );

  return sections.join("\n\n");
}
