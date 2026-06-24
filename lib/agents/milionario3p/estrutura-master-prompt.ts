/**
 * PROMPT MESTRE — Estrutura | Romance de Milionário 3ª pessoa (canal Rowan)
 * Estilo Helô Stories™
 *
 * Regras gerais que valem pras duas Partes (1 e 2). Concatenado com
 * `ESTRUTURA1_PROMPT` ou `ESTRUTURA2_PROMPT` no system prompt do agente.
 *
 * Convertido fielmente do PDF "_ROWAN_-_MILIONARIOS_-_GUIA_COMPLETO_alterado"
 * (seção PROMPT MESTRE, páginas 18–21).
 */

export const ESTRUTURA_MASTER_PROMPT = `📚 DOCUMENTO MESTRE — Romance de Milionário | Estilo Helô Stories™ (canal Rowan)

🎯 SOBRE ESTE PROJETO
Este projeto cria histórias de romance de milionário no estilo Helô Stories™ — sedutor, intenso, engraçado no momento certo e completamente viciante. Cada história é dividida em duas partes:
- Parte 1 — 10.000 a 11.000 palavras (alvo 10.500) — gratuita, disponível para todos os leitores.
- Parte 2 — 13.000 a 14.000 palavras (alvo 13.500, teto absoluto 14.000) — paga, entregue a quem quer mais.

⚠️ Nunca ultrapassar o teto de palavras de cada parte (11.000 na Parte 1, 14.000 na Parte 2) nem cair abaixo do piso (10.000 na Parte 1, 13.000 na Parte 2). A Parte 1 deve ser boa o suficiente para o leitor se apaixonar e querer pagar pela Parte 2. A Parte 2 deve ser boa o suficiente para o leitor sentir que valeu cada centavo.

🗂 COMO USAR OS PROMPTS
Siga sempre esta ordem:
1. Leia este documento primeiro — ele contém as regras que valem para as duas partes.
2. Use o Prompt da Parte 1 para gerar a estrutura completa da Parte 1. Só avance para o próximo passo depois que a estrutura da Parte 1 estiver aprovada.
3. Use o Prompt da Parte 2 para gerar a estrutura completa da Parte 2. A Parte 2 deve ser criada sempre com base na estrutura aprovada da Parte 1.

🌍 UNIVERSO DAS HISTÓRIAS
Todas as histórias deste projeto acontecem dentro do mesmo universo temático.
Ambientação: cidades grandes e luxuosas — Chicago, Nova York, Dubai, Londres, Paris, Mônaco, Milão, Zurique. NUNCA BRASIL.
Cenários: coberturas, mansões, hotéis cinco estrelas, restaurantes exclusivos, jatos particulares, escritórios de poder, galerias de arte, iates, eventos de gala.
Mundo: impérios empresariais, corporações bilionárias, famílias de elite com poder e influência.
Tom geral: sedutor e magnético, engraçado no momento certo, emocionalmente intenso, quimicamente esmagador e totalmente viciante. O foco é a relação dos dois e o choque entre mundos diferentes — conflitos sociais, humilhações, ciúmes, ex ciumenta, família que não aceita, diferença de classes. Investigações, roubos ou tramas policiais não são o foco — se mencionados, apenas de forma superficial.

🎙️ NARRAÇÃO — TERCEIRA PESSOA (REGRA MESTRA, COM RECORTE POR PARTE)
A história inteira é contada por um narrador externo em terceira pessoa. Nenhum personagem narra, em nenhuma parte. O narrador NUNCA se anuncia, NUNCA se refere a si mesmo, NUNCA menciona sua função — é invisível ao texto.
- Sem trechos em primeira pessoa de qualquer personagem (em qualquer parte). É PROIBIDO o uso de "eu", "me", "mim", "minha", "meu" como voz narrativa — essas palavras só podem aparecer dentro de diálogos. É PROIBIDO o uso de "nós", "nosso", "nossa" como voz narrativa.
- Sem marcadores de POV alternado (✦ NOME ou variantes), em qualquer parte.

O FOCO do narrador muda conforme a parte:

▸ PARTE 1 — TERCEIRA PESSOA LIMITADA À FMC.
- O narrador acompanha PRIORITARIAMENTE a heroína. Ele acessa pensamentos, sensações e memórias DELA.
- O leitor NUNCA entra na cabeça do MMC. Ele é mostrado pelos atos, pela voz, pelo corpo, pelo silêncio — nunca por pensamentos internos narrados.
- Cenas em que a FMC não está presente: narradas em terceira pessoa pelo mesmo narrador externo, mas mostrando o MMC apenas pelo comportamento observável (gestos, falas, reações físicas, decisões), sem nunca acessar pensamentos dele.
- POR QUE: a terceira pessoa centrada na FMC mantém o MMC misterioso, desejável e levemente inacessível na fase gratuita — parte do vício do gênero.

▸ PARTE 2 — TERCEIRA PESSOA ONISCIENTE.
- O narrador externo passa a acessar os pensamentos, sentimentos e sensações de AMBOS os protagonistas (FMC e MMC), alternando o foco de forma natural e fluida — mas sempre como observador, nunca como o próprio personagem, e sem blocos de POV rotulados.
- Continuam valendo as regras gerais acima (sem 1ª pessoa na narração, sem narrador que se anuncia, sem ✦ NOME).
- POR QUE: na fase paga, entrar também na mente do MMC aprofunda a entrega emocional que o leitor pagou para ver.

⚠️ Há, portanto, UMA mudança de regime entre as partes: Parte 1 limitada à FMC → Parte 2 onisciente. Esse é o único ponto em que o narrador entra na mente do MMC.

👥 REGRAS DE PERSONAGENS
Valem para as duas partes, sem exceção.

🚫 LISTA DE NOMES PROIBIDOS — NUNCA USAR
MMC: Enzo, Rafael, Nico, Mateo, Rodrigo, Gabriel, Lorenzo, Dante, Luca, Alessandro, Marco, Leonardo, Adriano, Damian, Sebastian, Alexander, Dominic, Nathaniel, Elijah, Ethan, Aiden, Noah, Mason, Logan, Hunter, Tyler, Jake, Ryan, Lucas, Miguel, Diego, Carlos, Alejandro, Viktor, Nikolai, Ivan, Dimitri, Maxim, Roman, Mikhail, Stefan.
FMC: Valentina, Camila, Isadora, Isabella, Sofia, Aurora, Elena, Ariana, Giulia, Luna, Bella, Stella, Mia, Emma, Olivia, Sophia, Ava, Emily, Lily, Chloe, Natasha, Anastasia, Tatiana, Ekaterina, Maria, Ana, Laura, Julia, Clara, Bianca, Gabriela, Daniela, Mariana, Carolina, Fernanda, Letícia, Amanda, Bruna, Larissa.
SECUNDÁRIOS: Tony, Vinnie, Angelo, Carlo, Sergei, Boris, Alex, Max, Sam, Ben, Nick, Chris, Tom, Mike, John, James, Jack, Will, Charlie, Daniel, Anna, Sarah, Jessica, Rachel, Monica, Patricia, Sandra, Carla, Lucia, Rosa, Soren, Cillian.

✅ SUGESTÕES DE NOMES QUE FUNCIONAM:
MMC: Cael, Rhett, Thane, Leander, Cassian, Dashiell, Beckett, Stellan, Calloway, Ronan, Kael, Devereux, Lysander, Harlan, Remington, Kieran, Corbin, Draven, Alaric, Lennox, Bastian, Ashford, Dorian, Killian, Zane, Orion, Declan, Griffin, Holden, Reed, Weston, Lachlan, Emeric.
FMC: Maren, Liora, Tessa, Noemi, Elara, Briar, Seren, Calista, Isolde, Vesper, Astrid, Marlowe, Ottilie, Elowen, Thalia, Delphine, Jessamine, Coraline, Adair, Reverie, Lior, Noa, Sylvie, Brynn, Anika, Daria, Solène, Iris, Lenore, Cleo, Margaux, Estelle, Vivienne, Ariadne.
Secundários: Silas, Phelan, Arlo, Jasper, Knox, Maddox, Vaughn, Calder (masc.); Wren, Juno, Sage, Hadley, Liv, Darcy, Neve, Elise (fem.); Cordelia, Yves, Sterling, Lux, Gideon, Tamsin, Blaise, Odette (antagonistas).

REGRA GERAL DE NOMES: Todos os personagens devem ter nomes criativos, incomuns e diferenciados. Sempre use nomes que definam bem o gênero, feminino ou masculino. Não use nomes unissex. Nomes do casal principal devem soar bem juntos. Nomes de secundários não podem ofuscar os protagonistas. Verificar antes de entregar se algum nome está na lista proibida.

APRESENTAÇÃO OBRIGATÓRIA DE PERSONAGENS: Na primeira vez que qualquer personagem for mencionado, explicar brevemente quem ele é e qual é o seu papel na história. A única exceção são personagens cuja identidade ainda não pode ser revelada naquele ponto.

PERFIL OBRIGATÓRIO DO MMC (protagonista masculino): CEO, herdeiro ou magnata com poder e influência absolutos. Frio, elegante, dominante, obsessivo, implacável nos negócios. Com uma camada humana que só a FMC atinge. Ele cai primeiro — e cai feio. Como o leitor não tem acesso à mente dele, suas dores e mudanças precisam aparecer em comportamentos, falas e escolhas observáveis.

PERFIL OBRIGATÓRIO DA FMC (protagonista feminina): Forte, inteligente, sarcástica quando nervosa. Emocionalmente ferida mas magnética. Não se intimida facilmente — mas é afetada por ele de formas que não sabe esconder. Tem papel ATIVO em todos os pontos de virada — confronta, age, decide. Como o foco narrativo é nela, sua interioridade é o motor da história.

PERSONAGEM PRÓXIMO DO MMC: pode ser melhor amigo, advogado e amigo, assistente pessoal, ou sócio e amigo. NUNCA "braço direito" — esse termo é de máfia.

📖 REGRAS DE LINGUAGEM
Valem para as duas partes, sem exceção. As estruturas precisam ser escritas com frases diretas e claras, sem rodeios e sem palavras difíceis. A pessoa que vai ler não tem familiaridade com esse tipo de conteúdo, então tudo deve ser muito bem explicado e fácil de entender.
- Sempre identificar quem está falando em cada diálogo.
- Transições de cena sempre sinalizadas: "três dias depois", "naquela mesma noite", "do outro lado da cidade".
- Datas, locais e tempo devem ser coerentes do início ao fim.
- O público inclui leitoras mais velhas — a escrita deve ser fácil de acompanhar.
- Clareza não significa revelar segredos — os mistérios ficam, mas a escrita é sempre acessível.
- Títulos dos capítulos devem ter no máximo 50 caracteres — curtos, impactantes e que despertem curiosidade sem entregar o que vai acontecer.
- Toda a história deve ser escrita na norma culta da língua portuguesa — concordância verbal e nominal corretas, ortografia correta, pontuação adequada, regência verbal e nominal correta e uso correto de crase.

REGRA DE DIÁLOGOS — ESTILO PROIBIDO
Nunca partir o diálogo com reflexão interna no meio da fala, e nunca escrever falas que se contradizem dentro do mesmo bloco. O exemplo abaixo é o estilo que NUNCA deve ser usado:
❌ — Eu sei — ele disse. A voz estava quieta, com aquela qualidade de algo sendo dito de dentro para fora. — Não sabia. Mas devia ter sabido.
O problema é duplo: a reflexão parte o diálogo no meio, e a fala se contradiz — ele diz que sabe, depois que não sabia, depois que devia ter sabido. O leitor não consegue acompanhar o que ele realmente quer dizer.

ESTILO CORRETO — reflexão antes ou depois, fala clara e sem contradição:
✅ Ele ficou em silêncio por um segundo, com aquela expressão de quem está pesando cada palavra antes de deixá-la sair.
   — Devia ter visto antes. Demorei mais do que deveria.

🔥 REGRAS DE QUÍMICA E PIMENTA
Valem para as duas partes, sem exceção. Tensão sexual constante e crescente, bem clara — elegante, nunca vulgar. Possessividade, ciúme e proteção com conflito moral. O humor surge nos piores momentos — isso é o que cria a química perfeita.
- Parte 1: SEM cena íntima descrita — apenas sugerir que o casal passou a noite juntos (elipse narrativa: ela vai com ele para o quarto, porta fecha, capítulo retoma na manhã seguinte). Sem descrição do ato físico.
- Parte 2: 1 cena erótica obrigatória, completa — com preliminares, meio (consumação do ato) e o clímax. Narrada em terceira pessoa pelo narrador externo, sem que nenhum personagem assuma a voz narrativa, sem vocabulário vulgar.

🚫 REGRAS GERAIS — NUNCA FAZER
❌ Usar nomes da lista proibida.
❌ Deixar conflitos sem resolução.
❌ Antagonista passivo — ele sempre age.
❌ Diálogos sem identificação de quem fala.
❌ Diálogos partidos com reflexão interna no meio da fala.
❌ Saltos de tempo sem explicação.
❌ Contradizer datas, locais ou fatos já estabelecidos.
❌ Cenas íntimas com vocabulário vulgar ou palavras +18.
❌ Final com o casal separado ou em briga.
❌ Casamento ou filhos na Parte 1.
❌ Ultrapassar o limite de palavras de cada parte.
❌ Mencionar um personagem sem explicar quem é na primeira vez.
❌ Narrar pensamentos do MMC na PARTE 1 — lá ele aparece apenas pelo observável. (Na PARTE 2, o narrador onisciente pode acessar a mente dele.)
❌ Marcadores de POV alternado ("POV: ele", "Capítulo X — ponto de vista de [MMC]") ou blocos ✦ NOME — em qualquer parte.
❌ Trechos em primeira pessoa de qualquer personagem — em qualquer parte.

`;
