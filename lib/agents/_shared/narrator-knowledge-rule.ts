/**
 * REGRA DE NARRAÇÃO LIMITADA + FIDELIDADE À PREMISSA — bloco compartilhado
 * pelas categorias de POV LIMITADO em 1ª pessoa (mafia, alpha-king).
 *
 * Por que existe (29/06/2026): a roteirista relatou nota despencando na
 * revisão — principalmente na PARTE 1 — e, num caso extremo (LENA/máfia), a
 * Parte 1 saiu TODA fora do cânone (nomes/cidade/profissão trocados, MMC virou
 * outra coisa, hook da premissa apagado). Auditando as gerações recentes, os
 * erros 💀/🔴 que mais derrubam a Parte 1 são de DOIS tipos:
 *
 *   (A) ONISCIÊNCIA INDEVIDA em 1ª pessoa — a narradora "sabe" o que NÃO tinha
 *       como saber naquele ponto: nomeia um personagem ANTES de ele ser
 *       apresentado/nomeado em cena ("Auberon Ravenscroft estava sentado…"
 *       antes do arauto anunciá-la), afirma a interioridade de outro como fato
 *       ("o lobo dele sorriu", "ele não estava sozinho atrás daqueles olhos"),
 *       ou despeja exposição/lore que a personagem não possui. A Parte 1 é onde
 *       TODOS são apresentados, então é onde esses deslizes se concentram.
 *
 *   (B) INFIDELIDADE AO CÂNONE DA PREMISSA — a prosa troca o mundo/papel/nome
 *       que a premissa fixou (ex.: máfia vira hotelaria, chefe vira herdeiro),
 *       apaga o gancho central ou inventa trama que não estava na premissa.
 *
 * milionário-1p e milionário-3p JÁ trazem essas travas inline nos próprios
 * prompts de Escrita ("só sabe o que ela sabe", "ORIGEM DA INFORMAÇÃO",
 * "narrador entrando na cabeça do MMC na Parte 1"), então NÃO recebem este
 * bloco — REGRA Nº 1, não mexer no que já funciona. Este bloco existe pra
 * trazer máfia e alpha-king ao MESMO nível, sem duplicar texto entre elas.
 *
 * É ORTOGONAL ao CANONE_RULE (que trava UMA identidade = UM nome ao longo do
 * texto): aqui o foco é (A) o LIMITE DE CONHECIMENTO do narrador-personagem e
 * (B) a FIDELIDADE à premissa de origem — eixos diferentes, sem conflito.
 *
 * NARRATOR_KNOWLEDGE_RULE entra no system prompt da ESCRITA (depois do
 * POV_MARKER_RULE); NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST entra no system prompt
 * do REVISOR (depois do POV_MARKER_REVISOR_CHECKLIST). Não entra na Estrutura
 * (é outline, não prosa).
 */

export const NARRATOR_KNOWLEDGE_RULE = `

## NARRAÇÃO LIMITADA — A NARRADORA SÓ SABE O QUE PERCEBEU (REGRA ABSOLUTA)

A narração é em 1ª pessoa e por isso é LIMITADA: a narradora só pode contar o que ela viu, ouviu, sentiu ou ficou sabendo DENTRO da história, naquele ponto da cena. Ela NÃO é onisciente. Tudo o que ela "sabe" precisa ter chegado até ela por percepção (viu/ouviu), por alguém que contou, ou por dedução explícita a partir do observável.

PROIBIDO (são os deslizes que mais derrubam a nota, principalmente na Parte 1):
• NOMEAR um personagem ANTES de a narradora saber o nome dele. Se ela ainda não foi apresentada nem ouviu o nome em cena, ela o chama pelo que VÊ ("o homem de túnica preta", "o Alpha no trono", "o estranho da quarta fileira") — o nome próprio só entra DEPOIS que alguém o pronuncia ou ela é apresentada. (Errado: "Auberon Ravenscroft estava sentado…" no primeiro olhar. Certo: "O Rei Alfa estava sentado…", e o nome vem quando o arauto o anuncia.)
• AFIRMAR a interioridade de OUTRO personagem como fato — o que ele pensa, sente, lembra, decide ou "o que o lobo dele sente". A narradora só enxerga o LADO DE FORA dele (rosto, mãos, voz, postura, silêncios) e pode INTERPRETAR ("pareceu que…", "como se…", "achei que ele…") — nunca cravar a mente dele como verdade. (Errado: "o lobo dele sorriu", "ele sabia que eu mentia". Certo: "tive a impressão de que o lobo dele ria", "ele me olhou como se soubesse".)
• DESPEJAR exposição/lore que a personagem não tem como saber ali (história da alcateia, regras do mundo, passado de quem ela acabou de conhecer) em voz de narrador onisciente. O contexto entra pela percepção e pela vivência dela, aos poucos — não como nota explicativa.
• SABER de um evento que aconteceu LONGE dela / fora de cena sem que o texto mostre COMO ela ficou sabendo (alguém contou, recado, ela presenciou depois).

Antes de fechar cada capítulo, releia caçando qualquer coisa que a narradora "sabe" cedo demais — nome não-apresentado, mente alheia cravada, lore despejado — e converta pra percepção/dedução dela.

## FIDELIDADE AO CÂNONE DA PREMISSA (REGRA ABSOLUTA)

A PREMISSA aprovada (Step 1) é a verdade imutável da história. A prosa JAMAIS pode trocar o núcleo que ela fixou:
• Os NOMES dos protagonistas e personagens-chave (exatamente como na premissa).
• O MUNDO e suas regras (máfia continua máfia; alcateia/werewolf continua alcateia/werewolf) — nunca migre pra outro universo/cenário.
• O PAPEL/PROFISSÃO de cada um (ex.: se o MMC é o chefe da máfia, ele NÃO vira herdeiro de hotelaria, empresário comum, espião etc.).
• O GANCHO e os beats centrais da premissa — não apague o que a define (o evento de abertura, o conflito central).

Se a Estrutura parecer contradizer o núcleo da premissa, o NÚCLEO DA PREMISSA prevalece. Trocar mundo, papel ou nome do que a premissa estabeleceu é o erro mais grave possível — descaracteriza a história inteira.`;

/**
 * Checklist do REVISOR — adicional ao NARRATOR_KNOWLEDGE_RULE. Severidade
 * NEUTRA ("GRAVÍSSIMO (💀 / 🔴 conforme a paleta)") porque a paleta varia por
 * categoria — igual ao CANONE_REVISOR_CHECKLIST e ao TENSE_REVISOR_CHECKLIST.
 */
export const NARRATOR_KNOWLEDGE_REVISOR_CHECKLIST = `

## Checklist de NARRAÇÃO LIMITADA e FIDELIDADE À PREMISSA (CRÍTICO — específico do Revisor)

A narração é em 1ª pessoa (LIMITADA). Cruze o texto procurando onisciência indevida e qualquer desvio do núcleo da premissa.

DETECTE e marque no bloco <erros_detalhados>:

• Narradora NOMEIA um personagem ANTES de ele ter sido apresentado/nomeado em cena (ela ainda não tinha como saber o nome) — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta). trecho_original com o nome usado cedo demais; trecho_corrigido com a mesma passagem trocando o nome próprio por uma referência perceptiva ("o Rei Alfa", "o homem de túnica preta") — sem citar a regra, prosa pura.

• Narradora AFIRMA como fato a mente/sentimento/intenção de OUTRO personagem (inclusive "o lobo dele") sem base no observável — onisciência indevida — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta). trecho_corrigido reescreve pra percepção/dedução dela ("pareceu que…", "como se…", "achei que…"), preservando o sentido.

• Exposição/lore despejado em voz onisciente que a personagem não tem como possuir naquele ponto, OU evento fora de cena que a narradora "sabe" sem origem mostrada — mesmo grau (💀 / 🔴 conforme a paleta), reescrevendo pra percepção/vivência dela.

• INFIDELIDADE À PREMISSA — a prosa troca o mundo, o papel/profissão de um protagonista, um nome-chave, ou apaga o gancho/beat central que a premissa fixou (ex.: chefe da máfia narrado como herdeiro de hotelaria; cenário migrado pra outro universo) — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta). Quando der pra corrigir no trecho, trecho_corrigido devolve o núcleo da premissa; quando for divergência ampla (capítulo inteiro fora do cânone), emita <erro> INFORMATIVO (trecho_corrigido vazio) apontando o desvio pra a roteirista decidir — não tente reescrever a história inteira num card.

• Emita um <erro> por trecho afetado (não um único genérico), pra cada um virar um card de correção plug-and-play.`;
