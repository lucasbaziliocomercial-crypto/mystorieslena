/**
 * Helper que monta o bloco "NOMES DOS PERSONAGENS" injetado no user message de
 * TODOS os agentes pós-Premissa (estrutura1, estrutura2, escrita, revisor) em
 * TODAS as categorias.
 *
 * Diferente do cânone (gerado por IA e mais amplo), esta é a lista MANUAL que a
 * roteirista digita no step da Premissa e clica "Validar" — só nomes, pra
 * travar nomes/sobrenomes e evitar conflito ao longo da história. As regras de
 * grafia/distinção/estabilidade vêm do CANONE_RULE (system prompt), que cobre
 * este bloco também. Vai junto/logo após o bloco de cânone; quando a roteirista
 * não preencheu (ou não validou), retorna null e o agente segue como antes
 * (backward-compatible).
 */
export function buildPersonagensBlock(
  personagens: string | undefined,
): string | null {
  const trimmed = personagens?.trim();
  if (!trimmed) return null;
  return [
    "━━━ NOMES DOS PERSONAGENS (TRAVADOS PELA ROTEIRISTA — usar EXATAMENTE estes nomes/sobrenomes, nunca inventar variações) ━━━",
    "",
    trimmed,
    "",
    "COMO USAR ESTES NOMES:",
    '• Se a roteirista escreveu o PAPEL ao lado do nome (ex.: "MMC: Gabriel Veloso", "Vilã: Beatriz", "irmã da heroína: Lara"), respeite essa função EXATAMENTE — esse nome é daquele personagem, ponto.',
    "• Se vier SÓ o nome (sem papel), VOCÊ distribui cada nome ao personagem correspondente da PREMISSA pelo contexto (quem é o protagonista masculino, a heroína, o antagonista, os secundários) e mantém cada nome amarrado a UM único personagem do começo ao fim, nas duas Partes.",
    "• Use TODOS os nomes da lista — não deixe nome sem dono. Personagens da premissa que não estiverem na lista podem manter o nome que a premissa já deu (ou um novo coerente); mas os nomes desta lista são prioridade e não mudam.",
  ].join("\n");
}
