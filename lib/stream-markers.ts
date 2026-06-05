/**
 * Marcadores de controle no stream `text/plain` que separam o bloco de
 * raciocínio (thinking) do conteúdo final do modelo.
 *
 * Só os agentes de Estrutura (thinking: "adaptive") emitem raciocínio — os
 * demais steps rodam com thinking desabilitado e NUNCA produzem marcadores,
 * então `splitThinking` é identidade pra eles (zero impacto).
 *
 * Por que marcadores e não dois streams: o transporte é um único `text/plain`
 * (route → cliente). Emitir o raciocínio no MESMO stream, cercado por estes
 * sentinelas, deixa os leitores (`readStreamThrottled` no foreground,
 * `readResponseText` no motor headless) separarem as duas faixas na entrada —
 * o `acc` que alimenta TODA finalização já sai limpo (sem raciocínio), e o
 * texto cru com marcadores vai só pro preview ao vivo, onde a UI o exibe
 * esmaecido como "Pensando…".
 *
 * Usamos U+0001 (START OF HEADING), um caractere de controle que NUNCA aparece
 * em texto de roteiro/markdown — sem risco de colisão com o conteúdo real.
 * Construído via String.fromCharCode pra não carregar byte de controle cru no
 * arquivo-fonte (frágil em editores/diffs).
 */
// ⚠️ lib/claude.ts replica THINKING_OPEN/THINKING_CLOSE inline (não importa daqui
// — é carregado pelo test via node puro, que não resolve `@/`). Se mudar os
// marcadores aqui, mude lá também.
const SOH = String.fromCharCode(1);
export const THINKING_OPEN = `${SOH}T${SOH}`;
export const THINKING_CLOSE = `${SOH}/T${SOH}`;

export interface SplitThinking {
  /** Texto do raciocínio (entre OPEN e CLOSE). Vazio quando não houve thinking. */
  thinking: string;
  /** Conteúdo final, sem marcadores nem raciocínio — o que é salvo/parseado. */
  content: string;
}

/**
 * Separa o raciocínio do conteúdo num texto (parcial ou completo) que pode
 * conter os marcadores. Tolerante a estado parcial durante o stream:
 *  - sem OPEN → tudo é conteúdo (caso comum: thinking desabilitado).
 *  - OPEN sem CLOSE → ainda pensando: thinking é o que veio depois do OPEN,
 *    conteúdo é só o que veio ANTES do OPEN (normalmente vazio).
 *  - OPEN + CLOSE → thinking é o miolo; conteúdo é o que está fora da região.
 */
export function splitThinking(raw: string): SplitThinking {
  const open = raw.indexOf(THINKING_OPEN);
  if (open === -1) return { thinking: "", content: raw };
  const afterOpen = open + THINKING_OPEN.length;
  const before = raw.slice(0, open);
  const close = raw.indexOf(THINKING_CLOSE, afterOpen);
  if (close === -1) {
    return { thinking: raw.slice(afterOpen), content: before };
  }
  const thinking = raw.slice(afterOpen, close);
  const content = before + raw.slice(close + THINKING_CLOSE.length);
  return { thinking, content };
}
