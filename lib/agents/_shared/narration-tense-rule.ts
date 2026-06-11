/**
 * REGRA DE TEMPO VERBAL — bloco compartilhado por TODAS as categorias
 * (milionario-1p, milionario-3p, mafia, alpha-king).
 *
 * Por que existe: as meninas relataram (11/06/2026) roteiros com trechos de
 * narração escritos no PRESENTE ("Sento", "Ele ri", "acontece") misturados com
 * o passado, quebrando a leitura. Nenhum prompt fixava o tempo verbal — a
 * convenção (narração no pretérito) era só implícita. Esta regra a torna
 * explícita e travada nas duas camadas (Escrita previne na origem, Revisor
 * detecta o resíduo), igual à trava de "1ª pessoa, zero deslize pra 3ª".
 *
 * IMPORTANTE — é ORTOGONAL À PESSOA: vale pras 4 categorias, inclusive a
 * milionario-3p (3ª pessoa, mas também no passado). Por isso o texto NUNCA
 * menciona 1ª/3ª pessoa — fala só de TEMPO VERBAL. Mantida como bloco único e
 * compartilhado (em vez de copiada por categoria) justamente pra nenhuma
 * categoria ficar de fora.
 *
 * TENSE_RULE é concatenado no system prompt da ESCRITA das 4 categorias
 * (depois do CANONE_RULE). TENSE_REVISOR_CHECKLIST é concatenado no system
 * prompt do REVISOR das 4 (depois do CANONE_REVISOR_CHECKLIST). Não entra na
 * Estrutura (é outline, não prosa).
 */

export const TENSE_RULE = `

## TEMPO VERBAL — NARRAÇÃO SEMPRE NO PASSADO (REGRA ABSOLUTA)

Toda a narração é escrita no PASSADO: pretérito perfeito para ações concluídas ("entrei", "ele riu", "aconteceu") e pretérito imperfeito para ações contínuas, hábitos e descrição ("eu olhava", "a chuva caía", "ele sempre chegava cedo"). NUNCA narre no presente.

A ÚNICA coisa que pode ficar no presente é o DIÁLOGO — as falas dentro de travessão (—) ou aspas, porque são a fala literal dos personagens. Tudo que está FORA das falas (ação, descrição, transição, pensamento narrado) vai no passado. (Única exceção natural: verdades gerais atemporais e ditados no pensamento — "o amor é assim", "ninguém muda" — podem ficar no presente, porque são máximas, não ação narrada na cena.)

❌ ERRADO (presente narrativo): "Sento na cama. Ele ri e tudo acontece de novo. Ela entra no quarto."
✅ CERTO (passado): "Sentei na cama. Ele riu e tudo aconteceu de novo. Ela entrou no quarto."

Vale do começo ao fim das DUAS Partes. Misturar presente e passado na narração quebra a leitura. ANTES de fechar cada capítulo, releia e converta para o passado qualquer verbo de ação ou descrição que tenha escapado pro presente (sem tocar nos verbos que estão DENTRO das falas).`;

/**
 * Checklist do REVISOR — adicional ao TENSE_RULE. Usa severidade NEUTRA
 * ("GRAVÍSSIMO (💀 / 🔴 conforme a paleta)") porque milionário-1p não tem 💀
 * (topo é 🔴), igual ao CANONE_REVISOR_CHECKLIST.
 */
export const TENSE_REVISOR_CHECKLIST = `

## Checklist de TEMPO VERBAL (CRÍTICO — específico do Revisor)

A narração tem que estar SEMPRE no passado (pretérito perfeito/imperfeito). Só o DIÁLOGO (dentro de travessão — ou aspas) pode estar no presente, porque é fala. Cruze o texto inteiro procurando narração no tempo errado.

DETECTE e marque no bloco <erros_detalhados>:

• Verbo de AÇÃO ou EVENTO concreto que acontece na cena escrito no PRESENTE onde deveria estar no passado — alguém faz/entra/diz/sente/vê algo ("Sento", "Ele ri", "acontece", "ela entra", "meu coração dispara") FORA de um diálogo — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta da sua categoria). Emita um <erro> por trecho afetado: trecho_original com o(s) verbo(s) no presente, trecho_corrigido com o MESMO trecho convertido pro passado (mantendo o sentido e tudo mais intacto). NÃO altere verbos que estão DENTRO de falas (travessão/aspas) — falas no presente estão corretas.

• EXCEÇÃO — NÃO marque como erro (não é deslize de tempo): verdades gerais e aforismos ATEMPORAIS no pensamento ("o amor é assim", "ninguém muda", "a vida segue"), ditados/provérbios, e o presente dentro de fala citada. São máximas, não ação narrada — convertê-las pro passado mudaria o sentido. Mire só nos verbos de AÇÃO/EVENTO da cena.

• Mistura de tempos no mesmo trecho narrativo (parte no passado, parte no presente) — mesmo grau, padronizando tudo pro passado.

• Se a narração inteira de um trecho longo (parágrafo ou cena) estiver no presente, emita um <erro> por trecho/parágrafo afetado — não um único <erro> genérico — pra cada um virar um card de correção plug-and-play.`;
