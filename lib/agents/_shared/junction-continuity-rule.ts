/**
 * REGRA DE CONTINUIDADE NAS JUNÇÕES — bloco compartilhado pelas 4 categorias
 * (milionario1p, milionario3p, mafia, alphaking).
 *
 * Por que existe (08/07/2026): a roteirista relatou uma enxurrada de graves/
 * gravíssimos após a geração, e a própria diagnosticou o PADRÃO GERAL — "os
 * erros não estão no meio das cenas, estão nas JUNÇÕES": (a) entre uma cena e
 * seu ECO/callback (o callback é reconstruído de memória e erra o detalhe
 * concreto), e (b) entre a PARTE 1 e a PARTE 2 (objeto-símbolo muda de cor/tipo,
 * dia da semana muda, escada/lugar do callback erra). Exemplos reais (história
 * de máfia da Mina/Dante): paletó preto vira casaco azul entre as Partes; almoço
 * na quarta-feira no Cap. 2 vira segunda-feira no Cap. 5; o epílogo diz que ela
 * desceu "a escada principal" e falou "dentro do escritório" quando desceu pela
 * escada de serviço e falou no corredor; a mesma frase-chave dita duas vezes com
 * uma palavra trocada; Dante acusa citando perguntas que ninguém lhe contou; o
 * antagonista (Lorenzo) é plantado como ameaça e some sem resolução.
 *
 * Esta regra é ADITIVA e ORTOGONAL às demais — não reescreve estilo, pessoa,
 * tempo verbal, POV nem cânone de NOMES. Foca só na FIDELIDADE DO DETALHE
 * CONCRETO quando o texto RETOMA algo já estabelecido (dentro da mesma Parte, e
 * — crucial — de uma Parte pra outra). É por isso que vale pras 4 categorias,
 * inclusive a milionario-3p (continuidade factual independe de quem narra).
 *
 * Complementa (não substitui):
 *  • CANONE_RULE — trava UMA identidade = UM nome; aqui o foco é objeto/lugar/
 *    dia/estado/fala-chave/fio-de-trama, não o nome do personagem.
 *  • NARRATOR_KNOWLEDGE_RULE — trava a onisciência do narrador; aqui a proibição
 *    de "conhecimento sem origem" mira um PERSONAGEM AGINDO sobre um dado que
 *    ninguém lhe passou (vale mesmo na 3ª onisciente, onde o narrador PODE saber
 *    tudo, mas o personagem ainda não pode agir sobre o que não recebeu).
 *  • cross-part-block — injeta os FATOS já escritos da outra Parte no user
 *    message; esta regra ENSINA o modelo a respeitá-los ao escrever callbacks.
 *
 * JUNCTION_CONTINUITY_RULE entra no system prompt da ESCRITA (após o
 * NARRATOR_KNOWLEDGE_RULE nas 3 de 1ª pessoa, e após o TENSE_RULE na
 * milionario-3p); JUNCTION_CONTINUITY_REVISOR_CHECKLIST entra no system prompt
 * do REVISOR das 4 categorias (após o último checklist compartilhado). Não entra
 * na Estrutura (é outline, não prosa).
 */

export const JUNCTION_CONTINUITY_RULE = `

## CONTINUIDADE NAS JUNÇÕES — CALLBACK FIEL AO QUE JÁ FOI ESCRITO (REGRA ABSOLUTA)

Os erros mais graves de um roteiro NÃO aparecem no meio de uma cena nova — aparecem nas JUNÇÕES: quando o texto RETOMA (ecoa, faz callback, repete) algo que já foi narrado antes, e quando a PARTE 2 continua fatos fixados na PARTE 1. O modelo tende a reconstruir esses detalhes DE MEMÓRIA e erra. Quando você retomar QUALQUER detalhe já estabelecido, reproduza-o EXATAMENTE como apareceu na 1ª vez (ou como está nos FATOS JÁ ESTABELECIDOS da outra Parte, quando houver esse bloco) — nunca "reinvente" o detalhe.

Mantenha idênticos ao longo do texto, do início ao fim das DUAS Partes:

• OBJETO-SÍMBOLO — o mesmo TIPO e a mesma COR do começo ao fim (um paletó PRETO não vira casaco AZUL; um anel não vira colar; um objeto descrito como quebrado continua quebrado). Se um objeto reaparece, é o MESMO objeto com as MESMAS características.
• LINHA DO TEMPO — dia da semana, hora e ordem dos eventos não mudam entre capítulos nem entre Partes (um almoço na QUARTA é sempre na quarta; um encontro na SEXTA é sempre na sexta; "quatro meses" é a mesma contagem toda vez). Antes de datar/situar um evento no tempo, confira como ele já foi datado antes.
• LUGAR E TRAJETO — onde uma cena acontece, e por onde alguém entra/sai, é fixo. Se a personagem desceu pela escada DE SERVIÇO e falou no CORREDOR, o callback dessa cena NÃO pode dizer "escada principal" nem "dentro do escritório". Dentro de UM mesmo parágrafo/cena o narrador não pode estar em dois lugares (se está no HALL, a voz do outro não o "alcança no quarto" na frase seguinte, a menos que ele tenha se movido em cena).
• ESTADO FÍSICO CONTÍNUO — um personagem não adormece/desmaia/acorda duas vezes sem transição, nem está de pé e consciente e, páginas depois, "acorda pela primeira vez" da MESMA cena. Se ele muda de lugar ou de estado (cai, é levado, dorme), MOSTRE a transição.
• FALA-CHAVE / FRASE DE EFEITO — uma virada de efeito é dita UMA vez. NÃO repita a mesma frase-chave literal (nem com uma palavra trocada, ex.: "humilhação disfarçada de tradição" e "vestida de tradição") em dois pontos do texto — a repetição mata a força das duas. Uma reza, um bordão, uma sentença de impacto: use uma vez só.

## CONHECIMENTO DO PERSONAGEM É RASTREÁVEL (REGRA ABSOLUTA)

Um personagem só pode CITAR, ACUSAR ou AGIR com base em uma informação que ele RECEBEU dentro da história — porque viu, ouviu, alguém lhe contou EM CENA, ou deduziu do observável. Não faça um personagem usar um fato que ninguém lhe passou e que ele não presenciou (ex.: acusar alguém citando perguntas feitas numa conversa em que ele não estava e que ninguém lhe relatou). Antes de um personagem "saber" algo que dispara uma ação, garanta que o texto MOSTROU como aquilo chegou até ele.

## FIOS DE TRAMA SE FECHAM (REGRA ABSOLUTA)

Uma ameaça, promessa ou pendência PLANTADA como ativa (um antagonista que "vai procurar a fresta", um prazo de "três semanas", uma carta prometida) precisa ser RESOLVIDA — ou ao menos retomada — antes do fim. Não deixe um fio plantado com peso simplesmente DESAPARECER. Se ele foi anunciado como ameaça real, dê o desfecho dele.

Antes de fechar cada capítulo — e com atenção REDOBRADA nos callbacks e no epílogo — releia caçando cada detalhe RETOMADO (objeto, cor, dia, hora, lugar, trajeto, estado, fala-chave) e confira contra a 1ª aparição e contra os fatos já escritos da outra Parte. Se não bater, corrija PARA a 1ª versão.`;

/**
 * Checklist do REVISOR — adicional ao JUNCTION_CONTINUITY_RULE. Severidade
 * NEUTRA (o topo da paleta varia por categoria: 🔴 no milionário-1p, 💀 nas
 * outras) — igual aos outros checklists compartilhados. Continuidade quebrada é
 * GRAVE/GRAVÍSSIMA porque o leitor tropeça e a nota cai.
 *
 * Mecânica de correção alinhada às travas existentes: o conserto é sempre PROSA
 * PURA (nunca citar esta regra nem deixar nota editorial entre colchetes),
 * padronizando o detalhe PELA 1ª APARIÇÃO / pelo fato já estabelecido. Quando o
 * conserto exigir decisão de enredo (qual das duas versões é a verdadeira; como
 * fechar um fio de trama abandonado), emita INFORMATIVO (trecho_corrigido vazio)
 * — não invente enredo num card.
 */
export const JUNCTION_CONTINUITY_REVISOR_CHECKLIST = `

## Checklist de CONTINUIDADE NAS JUNÇÕES (CRÍTICO — específico do Revisor)

Os erros mais graves se concentram nas JUNÇÕES: entre uma cena e seu eco/callback, e entre a Parte 1 e a Parte 2. Cruze cada detalhe RETOMADO com a 1ª aparição dele (e com as Estruturas/fatos da outra Parte) e detecte:

DETECTE e marque no bloco <erros_detalhados> (grau conforme a paleta da sua categoria — contradição factual é GRAVE 🔴 / GRAVÍSSIMA 💀 quando quebra a lógica central da trama):

• OBJETO-SÍMBOLO INCONSISTENTE — um mesmo objeto reaparece com TIPO ou COR diferente (paletó preto → casaco azul; anel → colar). Conserto: trecho_corrigido devolve o objeto à forma da 1ª aparição (prosa pura). Se não der pra saber qual é a versão canônica, INFORMATIVO.

• LINHA DO TEMPO CONTRADITÓRIA — dia da semana, hora ou contagem de tempo de um mesmo evento muda entre capítulos ou entre Partes (almoço quarta → segunda; encontro sexta → sábado; "quatro meses" que não fecha). Aponte os DOIS trechos; corrija o divergente PARA o primeiro estabelecido.

• LUGAR / TRAJETO ERRADO NO CALLBACK — o callback situa a cena num lugar ou trajeto diferente do que foi narrado (desceu pela escada de serviço e falou no corredor, mas o epílogo diz "escada principal"/"no escritório"). Conserto: alinhar o callback ao que a cena original mostrou. Contradição de lugar DENTRO do mesmo parágrafo (no hall, mas a voz "o alcança no quarto") também entra aqui.

• ESTADO FÍSICO DESCONTÍNUO — o personagem acorda/desmaia/adormece duas vezes sem transição, ou está de pé e consciente e depois "acorda pela primeira vez" da mesma cena. Aponte o ponto da descontinuidade; conserto = costurar a transição ou remover a segunda "primeira vez".

• FALA-CHAVE / FRASE DE EFEITO REPETIDA — a mesma virada de efeito aparece duas vezes, literal ou com uma palavra trocada ("humilhação disfarçada de tradição" / "vestida de tradição"; uma reza repetida verbatim). Conserto: manter UMA ocorrência (a mais forte no contexto) e reescrever ou cortar a outra — trecho_corrigido é a versão que fica ou o trecho sem a repetição.

• PERSONAGEM SABE O QUE NINGUÉM LHE CONTOU — um personagem cita/acusa/age sobre uma informação sem origem mostrada em cena (não viu, não ouviu, ninguém lhe contou). Aponte o trecho e o dado sem origem. Conserto: reescrever pra ele NÃO ter esse dado, ou (se o dado é necessário) INFORMATIVO pra a roteirista plantar a origem — não invente a cena de origem num card.

• FIO DE TRAMA ABANDONADO — uma ameaça/promessa/pendência plantada como ativa (antagonista que "vai procurar a fresta", prazo de "três semanas") desaparece sem resolução. Quase sempre é INFORMATIVO (fechar o fio é decisão de enredo, não conserto de trecho): aponte o que foi plantado e onde, e sinalize que ficou em aberto.

Emita um <erro> por trecho afetado (não um genérico), cada um vira um card plug-and-play. O conserto é sempre PROSA PURA — nunca cite esta regra, nunca deixe nota entre colchetes.`;
