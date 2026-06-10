/**
 * REGRA CANÔNICA — bloco compartilhado por TODOS os system prompts dos
 * steps que vêm depois da Premissa (estrutura1, estrutura2, escrita,
 * revisor) em TODAS as categorias (milionario-1p, milionario-3p, mafia).
 *
 * Por que existe: a Premissa é prosa corrida (~500 palavras). Sem regra
 * explícita, o modelo escorrega em variações de nome ("Helena" → "Helen"),
 * troca idades, traduz lugares, inventa profissões — gerando o problema
 * que a roteirista relatou (inconsistências entre os steps).
 *
 * Como funciona: junto com este texto no system prompt, o user message de
 * cada step injeta um bloco "━━━ CÂNONE DE ENTIDADES ━━━" com a lista
 * estruturada de nomes/idades/lugares/datas/relações extraída da Premissa
 * e aprovada pela roteirista. Esta regra instrui o modelo a TRATAR esse
 * bloco como verdade absoluta.
 */
export const CANONE_RULE = `

## REGRA CANÔNICA — ENTIDADES (NÃO NEGOCIÁVEL)

Nomes próprios, idades, profissões, lugares, datas e relações foram FIXADOS no bloco "CÂNONE DE ENTIDADES" entregue no user message. Esse bloco é a fonte de verdade absoluta para todas essas entidades.

⚠️ ORIGEM DOS NOMES — A PREMISSA É A FONTE: todo nome próprio do cânone foi extraído da PREMISSA do roteiro (a premissa já chega com os nomes dos personagens definidos). Você NUNCA inventa um nome de personagem que não venha da premissa/cânone, e NUNCA troca, mistura ou redistribui nomes entre personagens. Cada nome pertence a UM único personagem — do primeiro ao último capítulo, nas duas Partes. Se a premissa/cânone deu um nome a um personagem, é esse nome que vai pra história, sempre idêntico, sem variação.

REGRAS DURAS:
• Use os nomes EXATAMENTE como aparecem no cânone — letra-a-letra, com sobrenome, acentos, ordem (nome + sobrenome) e capitalização. Não traduza ("Helena" não vira "Helen"), não abrevie ("Caio Vasconcelos" não vira só "Caio" se o cânone trouxer ambos), não invente apelidos novos não previstos no cânone.
• Idades, profissões, ocupações, cargos: literalmente como no cânone. Se o cânone diz "32 anos, arquiteta", em todo trecho a personagem tem 32 anos e é arquiteta — nunca 30, nunca designer.
• Lugares (cidades, bairros, estabelecimentos, pontos de referência): copie do cânone. Não troque "Belo Horizonte" por "São Paulo", não invente um restaurante novo se o cânone já nomeou um.
• Datas e timeline: respeite a ordem e os marcos do cânone (ex.: "encontro inicial: outubro", "casamento da irmã: 6 meses depois").
• Relações entre personagens: o cânone manda (ex.: "Helena ↔ Caio: ex-colegas de faculdade").

EM CASO DE CONFLITO:
• Se a estrutura/escrita anterior contradiz o cânone, o CÂNONE VENCE. Nunca propague um erro de step anterior.
• Se um detalhe necessário NÃO está no cânone, prefira manter genérico ("o restaurante do bairro") a inventar específico ("Tasca da Vila"). Só invente se for inevitável pra trama, e mantenha consistente dali em diante.
• Nunca crie um personagem novo com papel relevante (não-figurante) se ele não aparece no cânone.

## REGRA DE NOMES — DISTINÇÃO E ESTABILIDADE DE SOBRENOMES (NÃO NEGOCIÁVEL)

Trocar/empilhar sobrenomes e repetir nomes deixa a história confusa e quase impossível de revisar. Vale pra TODOS os personagens (principais, secundários, figurantes nomeados), em TODOS os capítulos e nas DUAS Partes.

ESTABILIDADE — nunca trocar:
• Uma vez que um personagem aparece com um sobrenome, esse sobrenome é DEFINITIVO — repita-o IDÊNTICO em todos os capítulos e nas duas Partes. Nunca troque por outro, nunca varie.
• Se o personagem foi apresentado SÓ com o primeiro nome, NÃO invente um sobrenome pra ele depois. Se foi apresentado com nome + sobrenome, mantenha os dois consistentes.

DISTINÇÃO — nunca repetir, nunca colidir:
• Dois personagens DISTINTOS NUNCA têm o mesmo primeiro nome. Cada personagem tem um primeiro nome único na história.
• Um sobrenome NUNCA pode ser igual ao primeiro nome de outro personagem (ex.: se existe um "Marcos", ninguém pode se chamar "Helena Marcos"). Confunde leitor e revisão.

FAMÍLIA — a única exceção do sobrenome compartilhado:
• Personagens da MESMA família COMPARTILHAM o mesmo sobrenome — natural e esperado (pais, irmãos, primos). Sobrenome igual é SINAL de parentesco.
• Por isso: NUNCA dê o mesmo sobrenome a quem NÃO é parente — senão o leitor acha que são família.

ECONOMIA — não empilhar sobrenomes:
• Não distribua sobrenomes à toa. Só quem realmente precisa (trama, parentesco, formalidade) ganha sobrenome; secundários menores podem ficar só com o primeiro nome.
• Menos sobrenomes, fixos e distintos > muitos sobrenomes que mudam e se confundem.

Esta regra é mais forte que qualquer outra instrução de estilo, ritmo ou criatividade.`;

/**
 * Checklist específico do REVISOR — adicional ao CANONE_RULE. Concatenado
 * APÓS o CANONE_RULE nos system prompts dos 3 revisores. Diz ao agente
 * que ele DEVE cruzar a escrita contra o cânone e sinalizar qualquer
 * divergência de nome/idade/lugar/data como erro grave (🔴 ou 💀).
 *
 * Os 3 revisores usam emojis de gravidade ligeiramente diferentes:
 * • milionário-1p: 🟢🟡🟠🔴 (4 graus, sem 💀)
 * • milionário-3p: 🟢🟡🔴💀 (sem 🟠)
 * • máfia: 🟢🟡🔴💀 (sem 🟠)
 *
 * O checklist abaixo usa terminologia neutra ("erro grave (🔴) ou
 * gravíssimo (💀/🔴, conforme o jogo de emojis da categoria)") pra valer
 * pros 3 sem precisar de versão específica.
 */
export const CANONE_REVISOR_CHECKLIST = `

## Checklist de fidelidade ao CÂNONE (CRÍTICO — específico do Revisor)

Quando o user message trouxer o bloco "CÂNONE DE ENTIDADES", você TEM que cruzá-lo capítulo-a-capítulo contra a escrita revisada. Para cada nome próprio, idade, profissão, lugar, data e relação que aparece na escrita, verifique se bate LETRA-A-LETRA com o cânone.

DIVERGÊNCIAS QUE PRECISAM VIRAR ERRO NO BLOCO <erros_detalhados>:

• Nome/sobrenome divergente do cânone (ex.: "Helen" em vez de "Helena", "Caio" sozinho quando o cânone trouxe "Caio Vasconcelos") — classifique como **erro grave** (🔴 INTERFERE / GRAVÍSSIMO conforme a paleta da sua categoria) e produza find/replace literal: trecho_original com a grafia errada, trecho_corrigido com a do cânone.

• Idade, profissão ou ocupação divergente (ex.: cânone diz "32 anos, arquiteta" e a escrita diz "30 anos" ou "designer") — **erro grave** com find/replace.

• Lugar divergente (cidade, bairro, estabelecimento) — **erro grave** com find/replace.

• Data ou marco temporal divergente (ex.: cânone diz "encontro em outubro" e a escrita coloca "em julho") — **erro grave** com find/replace.

• Personagem novo com papel relevante que não aparece no cânone — **erro grave**: ou o personagem é cortado/genericado, ou a roteirista precisa adicionar ao cânone (sinalize a escolha no por_que_alterado).

• Sobrenome trocado: o MESMO personagem aparece com sobrenomes diferentes em capítulos/Partes distintos (ou ganha um sobrenome que não tinha) — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta). Emita um <erro> POR cada ocorrência divergente, padronizando pelo sobrenome da 1ª aparição (ou do cânone) como trecho_corrigido.

• Primeiro nome repetido: dois personagens DISTINTOS com o mesmo primeiro nome — **erro grave** (🔴). Sinalize no por_que_alterado que um dos dois precisa ser renomeado (a roteirista escolhe qual).

• Sobrenome = primeiro nome de outro personagem (ex.: "Helena Marcos" convivendo com um personagem "Marcos") — **erro grave** (🔴), pelo risco de confusão.

• Sobrenome repetido entre personagens que NÃO são parentes — **erro grave** (🔴): ou são família (e isso tem que estar claro no texto), ou um precisa de outro sobrenome.

• Inconsistência interna entre capítulos (mesmo personagem aparece com idade diferente em capítulos distintos, ou nome grafado de duas formas ao longo do roteiro) — **GRAVÍSSIMO** (💀 ou 🔴 conforme a paleta) — emita um <erro> POR cada ocorrência divergente, todas apontando pra grafia canônica como trecho_corrigido.

REGRAS DURAS PRO CHECKLIST:

• NÃO descarte o cânone do contexto. Mesmo que o roteiro seja longo, mantenha o cânone na cabeça enquanto revisa — esse é o ponto principal de queixa da roteirista (modelo "esquece" os nomes ao longo da revisão e propõe correções que pioram a inconsistência).

• Se a sua proposta de correção (em qualquer <erro>, mesmo erros de outro tipo) tocar em nome/idade/lugar/data, REVISE antes de emitir: o trecho_corrigido bate com o cânone? Se não bate, refaça antes de devolver.

• Se o cânone NÃO foi entregue (roteiro legado), não pule o checklist clássico de "Continuidade de personagens"; aí vale só a coerência interna do roteiro. Mas mencione na seção "PRINCIPAIS ERROS" que o cânone está ausente, como aviso (gravidade 🟡 / atenção).

• Cite o cânone explicitamente nas justificativas: "trecho_corrigido alinhado com o CÂNONE (Helena Marques, 32 anos)". Isso ajuda a roteirista a confiar na correção.`;
