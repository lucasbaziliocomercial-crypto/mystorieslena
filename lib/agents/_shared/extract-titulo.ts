/**
 * Extrai o TÍTULO PROVISÓRIO da premissa colada pela roteirista.
 *
 * Toda premissa gerada pelos agentes Premissa começa com a linha
 * `TÍTULO PROVISÓRIO: <nome>` (ver lib/agents/<categoria>/premissa-prompt.ts).
 * Esse título precisa ser pré-extraído antes de ir pro estrutura1, porque
 * o hook da Parte 1 é OBRIGATORIAMENTE a expansão do título — sem isolá-lo
 * num bloco prioritário, o modelo perde o foco em premissas longas e
 * inventa o hook a partir dos temas.
 *
 * Tolerâncias: aceita variantes "TÍTULO:", "Título:", "# Título",
 * "**Título:**", com ou sem acento, com ou sem espaços antes do `:`.
 * Limita a busca às primeiras 80 linhas — o título sempre aparece no topo.
 *
 * Retorna `null` em ausência/ambiguidade. Quem chama decide o que fazer
 * (no estrutura1, ausência bloqueia a geração do hook).
 */
export function extractTituloFromPremissa(premissa: string): string | null {
  if (!premissa) return null;
  const linhas = premissa.split(/\r?\n/).slice(0, 80);

  const padroes: RegExp[] = [
    /^\s*[#>*\-\s]*\**\s*t[íi]tulo\s+provis[óo]rio\s*\**\s*[:：]\s*(.+)$/i,
    /^\s*[#>*\-\s]*\**\s*t[íi]tulo\s*\**\s*[:：]\s*(.+)$/i,
  ];

  for (const linha of linhas) {
    for (const padrao of padroes) {
      const match = linha.match(padrao);
      if (match) {
        const bruto = match[1] ?? "";
        const limpo = bruto
          .replace(/\*+/g, "")
          .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
          .trim();
        if (limpo && !/^\[.*\]$/.test(limpo)) {
          return limpo;
        }
      }
    }
  }

  return null;
}
