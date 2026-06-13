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

## UMA IDENTIDADE = UM NOME — NUNCA FRAGMENTAR UM PERSONAGEM (NÃO NEGOCIÁVEL)

Cada personagem tem UM único nome canônico — o da PRIMEIRA aparição (ou do cânone, se houver) — e é chamado SEMPRE por ele, do primeiro ao último capítulo das DUAS Partes. A MESMA figura (mesma função, mesmas características, mesmo papel na cena) NUNCA pode ser referida por nomes diferentes — nem entre capítulos, nem dentro do mesmo capítulo, nem na mesma cena ou na mesma frase. Usar dois nomes pra uma só pessoa faz o leitor achar que são personagens distintos — é exatamente o erro que se quer impedir.

• NÃO "desdobre" uma identidade em variantes (apelido novo, segundo nome, sobrenome trocado, grafia diferente) que façam parecer pessoas diferentes. Se na Parte 1 o personagem foi nomeado X, ele continua X na Parte 2 — jamais vira Y ou Z.
• ANTES de nomear alguém numa cena, confirme: essa figura já apareceu antes? Se já, use o MESMO nome de antes. Só é um nome novo se for de verdade um personagem distinto previsto no cânone.
• Vale para TODOS os personagens (principais, secundários, figurantes nomeados). Dois nomes pra uma pessoa só é tão grave quanto um nome pra duas pessoas.

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

• Fragmentação de identidade — a MESMA figura (mesma função, mesmas características, mesmo papel na cena) é referida por NOMES DIFERENTES, usados de forma intercambiável entre capítulos, dentro do mesmo capítulo ou até na mesma cena/frase (como se fossem personagens distintos, quando não são) — **GRAVÍSSIMO** (💀 / 🔴 conforme a paleta). Escolha como canônico o nome da PRIMEIRA aparição do personagem (ou o do cânone, se houver) e padronize TODAS as ocorrências divergentes por ele: emita um <erro> POR cada ocorrência, trecho_original com o nome errado, trecho_corrigido com o nome canônico.
  ↳ EXCEÇÃO DE REPETIÇÃO (NÃO troque de personagem por conta própria): se padronizar uma ocorrência fizer o MESMO nome se repetir na frase (dois personagens com o mesmo nome na mesma frase), NÃO crie essa colisão — MAS também NÃO substitua automaticamente por outro personagem. Trocar quem está na cena por conta própria erra e bagunça a narrativa (é exatamente o que a roteirista relatou). Em vez disso, emita um <erro> INFORMATIVO com o trecho_corrigido VAZIO, descrevendo a colisão no por_que_alterado pra a roteirista decidir qual nome fica. Só proponha trecho_corrigido quando for a padronização DIRETA de uma variante de nome da MESMA pessoa, sem gerar colisão.

• Conferência final de nomes: antes de fechar a revisão, varra os nomes próprios das DUAS Partes — nenhuma variante incorreta pode permanecer no texto.

REGRAS DURAS PRO CHECKLIST:

• NÃO descarte o cânone do contexto. Mesmo que o roteiro seja longo, mantenha o cânone na cabeça enquanto revisa — esse é o ponto principal de queixa da roteirista (modelo "esquece" os nomes ao longo da revisão e propõe correções que pioram a inconsistência).

• Se a sua proposta de correção (em qualquer <erro>, mesmo erros de outro tipo) tocar em nome/idade/lugar/data, REVISE antes de emitir: o trecho_corrigido bate com o cânone? Se não bate, refaça antes de devolver. (Lembre: o trecho_corrigido é PROSA — o cânone ORIENTA a correção, mas NÃO entra escrito nela.)

• ALTA CONFIANÇA pra propor troca de nome: só trate dois nomes como a MESMA figura (e proponha trecho_corrigido trocando um pelo outro) quando tiver CERTEZA — o cânone define o nome, OU a 1ª aparição é inequívoca e o contexto não deixa dúvida de que é a mesma pessoa. Na MENOR dúvida, NÃO troque: emita erro INFORMATIVO (trecho_corrigido vazio) descrevendo a possível inconsistência pra a roteirista avaliar. Trocar por engano um nome que estava certo é PIOR do que deixar a roteirista decidir.

• Se o cânone NÃO foi entregue (roteiro legado), não pule o checklist clássico de "Continuidade de personagens"; aí vale só a coerência interna do roteiro. Mas mencione na seção "PRINCIPAIS ERROS" que o cânone está ausente, como aviso (gravidade 🟡 / atenção).

• PROSA PURA no trecho_corrigido — JAMAIS cânone dentro da correção (NÃO NEGOCIÁVEL): o <trecho_corrigido> contém EXCLUSIVAMENTE o texto da história como ele deve aparecer na narrativa final — a frase/parágrafo reescrito, pronto pra entrar LITERALMENTE no lugar do <trecho_original> via find/replace. É TERMINANTEMENTE PROIBIDO o trecho_corrigido conter: a palavra "cânone", qualquer citação/rótulo de cânone ("conforme o cânone", "alinhado com o CÂNONE", "(Helena Marques, 32 anos)"), a tarja "CÂNONE DE ENTIDADES", contagem de palavras, qualquer comentário/meta, OU qualquer INSTRUÇÃO/NOTA EDITORIAL entre colchetes ("[substitua X pelo nome do cânone]", "[NOME NÃO MENCIONE…]", "[adicione ao cânone…]", "[confirmar…]", "[antes de aplicar a correção automática]"). Qualquer meta colada ali vira lixo cravado na prosa que a roteirista lê — é exatamente a queixa dela. O "porquê" vai SÓ no <por_que_alterado>, em 1 linha curta e natural ("padronizei pelo nome da 1ª aparição") — sem colar o bloco de cânone nem listar idades/lugares lá dentro.

• NOME DESCONHECIDO ⇒ ERRO INFORMATIVO, NUNCA instrução na prosa (NÃO NEGOCIÁVEL): se você precisa corrigir um nome MAS não tem o nome canônico (o personagem não está no cânone, ou há dúvida real de qual é a grafia certa), NÃO escreva uma instrução no lugar do nome (nada de "[substitua Soren pelo nome do cânone]" cravado na frase). Em vez disso, emita o <erro> como INFORMATIVO: deixe o <trecho_corrigido> VAZIO e descreva no <por_que_alterado> qual nome está em dúvida e o que a roteirista precisa decidir. Trecho_corrigido só existe quando você tem a prosa final pronta — caso contrário, fica vazio.`;
