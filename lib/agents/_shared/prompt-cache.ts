/**
 * Sentinela que separa o PREFIXO ESTÁVEL (cânone + premissa + estrutura1 +
 * estrutura2 — idêntico em todos os batches de uma geração) do SUFIXO VARIÁVEL
 * (intro do batch + sinopses + ajustes + AÇÃO) dentro da mensagem do usuário da
 * Escrita.
 *
 * `lib/claude.ts#buildPromptInput` consome este marcador: quando presente,
 * quebra a mensagem em DOIS text blocks com `cache_control: ephemeral` cada,
 * criando um breakpoint de prompt caching. O prefixo (~20k tokens) passa a ser
 * lido do cache (`cache_read`) nos 6+ batches da Parte e cruzado entre os loops
 * P1‖P2 — em vez de reprocessado a cada chamada. Sem o marcador (Revisor,
 * Estrutura, calibração, refine), o comportamento é o de bloco único.
 *
 * Usamos U+0002 (STX), caractere de controle que NUNCA aparece em texto de
 * roteiro/markdown — sem risco de colisão. Construído via String.fromCharCode
 * pra não carregar byte de controle cru no arquivo-fonte (frágil em
 * editores/diffs), igual aos markers de thinking em lib/stream-markers.ts.
 *
 * ⚠️ lib/claude.ts replica esta constante INLINE (não importa daqui — é
 * carregado pelo test via node puro, que não resolve `@/`). Se mudar o marcador
 * aqui, mude lá também.
 */
const STX = String.fromCharCode(2);
export const CACHE_PREFIX_BOUNDARY = `${STX}CACHE_BOUNDARY${STX}`;
