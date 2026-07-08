/**
 * REGRA DE MARCADOR DE POV ✦ — bloco compartilhado pelas 3 categorias de POV
 * ALTERNADO na Parte 2 (milionario-1p, mafia, alpha-king).
 *
 * ⚠️ NÃO entra na milionario-3p: ela é 3ª pessoa onisciente e PROÍBE o marcador
 * ✦ em qualquer trecho (foco fluido, sem blocos rotulados). Aplicar uma regra de
 * "o nome do marcador tem que bater com quem narra" numa categoria que não tem
 * marcador seria contraditório. Por isso este bloco vai só nas 3 categorias com
 * `✦ NOME`.
 *
 * Por que existe (13/06/2026): a roteirista testou a LENA (máfia) e a Selena
 * (alpha-king) e relatou "muita troca de POV ou colocação de POV errado na
 * Parte 2". O Revisor pegou (mas só DEPOIS de gerado) dois padrões que nenhum
 * prompt travava:
 *   • MARCADOR NO BLOCO ERRADO — `✦ OSRIC` (POV masculino) encabeçando um bloco
 *     que era claramente a heroína (Solveig) narrando; `✦ Ottavia` (POV
 *     feminino) encabeçando um bloco do Gennaro. O exporter destaca o POV pelo
 *     NOME do marcador, então um marcador trocado joga o destaque verde no
 *     trecho errado e faz parecer que quem narra é outra pessoa.
 *   • VOZ TROCA NO MEIO DO BLOCO SEM MARCADOR — a cena de consumação (que é POV
 *     contínuo da heroína) trocava de narrador 2× sem nenhum `✦`.
 *
 * Reforço (16/06/2026, revisão da Selena/alpha-king): o erro MAIS comum é o
 * RETORNO À HEROÍNA SEM MARCADOR — o modelo trata a heroína como narradora-
 * PADRÃO implícita e, depois de um bloco `✦` do parceiro, reinicia o trecho dela
 * SEM `✦ NOME` (ex.: transição Osric→Solveig na P2 Cap. 3 sem `✦ Solveig`); o
 * trecho dela fica órfão e parece continuação do POV dele. A REGRA agora trava
 * que TODA troca leva `✦` NOS DOIS SENTIDOS (a heroína não é padrão) + a 1ª
 * narração de cada cap da P2 também leva `✦`; o checklist do Revisor ganhou o
 * bullet de "troca na fronteira do bloco sem marcador nenhum". A alpha-king foi
 * trazida ao nível da máfia/1p (já reforçavam "mesmo voltando o POV, marca de
 * novo") no `escrita-prompt.ts`.
 *
 * Como nas outras travas (cânone, tempo verbal), fica nas DUAS camadas: a
 * Escrita previne na origem (POV_MARKER_RULE, concatenado no system prompt da
 * Escrita das 3 categorias depois do TENSE_RULE) e o Revisor detecta o resíduo
 * (POV_MARKER_REVISOR_CHECKLIST, depois do TENSE_REVISOR_CHECKLIST). É ortogonal
 * à regra de "1ª pessoa, zero deslize pra 3ª" (que é sobre PESSOA gramatical
 * dentro de UM narrador) — aqui o problema é QUEM narra o bloco e se a voz troca
 * sem aviso. Texto neutro nos nomes (heroína / protagonista masculino), porque
 * cada história tem nomes próprios diferentes (vêm da Estrutura/cânone).
 */

export const POV_MARKER_RULE = `

## MARCADOR DE POV ✦ — O NOME BATE COM QUEM NARRA (REGRA ABSOLUTA — só Parte 2)

Na Parte 2 a narração alterna entre a heroína (narradora principal) e o protagonista masculino, e cada troca de POV leva o marcador ✦ NOME. Esse marcador é o RÓTULO de quem narra o bloco que vem logo ABAIXO dele — o exporter usa esse nome pra dar o destaque visual do POV. Então o nome no marcador tem que ser EXATAMENTE quem narra o bloco seguinte. Pôr o marcador do homem num bloco que é da heroína (ou o da heroína num bloco que é dele) joga o destaque no trecho errado e faz parecer que quem narra é outra pessoa.

REGRAS DURAS:
• TODA troca de narrador na Parte 2 leva marcador ✦ NOME — NOS DOIS SENTIDOS. Heroína→parceiro E parceiro→heroína. Na Parte 2 a heroína NÃO é "narradora-padrão" implícita: quando a narração VOLTA pra ela depois de um bloco do parceiro, ESSE retorno também abre com o ✦ NOME dela (ex.: ✦ [heroína]). NUNCA reinicie a voz da heroína sem o marcador só porque ela é a principal — toda retomada dela é uma troca de POV e exige o ✦. Esquecer o marcador no retorno à heroína é o erro mais comum: o trecho dela fica órfão, sem cabeçalho, e parece continuação do POV do parceiro.
• A 1ª narração de CADA capítulo da Parte 2 também leva seu ✦ NOME logo abaixo do título — mesmo quando quem abre é a heroína.
• ANTES de escrever cada ✦ NOME, decida quem narra o próximo bloco e escreva o nome DESSA pessoa. O marcador descreve o texto abaixo dele — nunca é copiado nem "herdado" de outro bloco.
• UM bloco = UMA voz. O "eu/me/meu/minha" dentro de um bloco é sempre a pessoa nomeada no marcador, do começo ao fim daquele bloco. A voz que narra NUNCA muda no meio de um bloco.
• Pra passar a narração a outro personagem (em qualquer direção), FECHE o bloco atual e abra um NOVO ✦ [OUTRO NOME] antes do trecho dele. Nunca deixe um segundo "eu" (outra pessoa) surgir dentro do mesmo bloco sem um novo marcador, nem comece um novo parágrafo/cena de outro narrador sem o ✦. Pra mostrar o que o outro sente sem trocar de POV, mostre pelo que quem narra vê/ouve (gesto, fala, expressão observável) — não escorregue pra dentro da cabeça dele no meio do bloco.

CENA ÍNTIMA / MARCAÇÃO — UMA VOZ SÓ, SEMPRE A HEROÍNA:
A cena íntima (e a marcação, quando houver) é narrada do início ao fim pela HEROÍNA, num único POV contínuo. NENHUM ✦ de outro personagem dentro dela, e o "eu" do parceiro NUNCA assume a narração — nem por uma frase. O que ele sente aparece pelo que ela vê/ouve/sente. Trocar de voz no meio da cena íntima quebra a imersão no pior momento possível.

❌ ERRADO (retorno à heroína sem marcador): um bloco do parceiro (✦ [protagonista masculino]) termina e, no parágrafo/cena seguinte, a heroína volta a narrar SEM nenhum ✦ ("Eu desci pra biblioteca antes do sol nascer…") — o trecho dela fica órfão e parece continuação do POV dele.
❌ ERRADO (marcador no bloco errado): ✦ [protagonista masculino] seguido de um trecho que é claramente a heroína narrando ("Subi os degraus, o coração apertado…").
❌ ERRADO (voz troca no meio sem marcador): o bloco começa no "eu" dela e, sem novo ✦, passa pro "eu" dele ("…senti o ombro ferido latejar enquanto a puxava pra mim").
✅ CERTO: toda troca de voz — inclusive o retorno à heroína — abre com o seu próprio ✦ NOME; o nome do ✦ é de quem narra o bloco; a cena íntima fica inteira num POV só (a heroína).`;

/**
 * Checklist do REVISOR — adicional ao POV_MARKER_RULE. Concatenado APÓS o
 * TENSE_REVISOR_CHECKLIST nos system prompts dos 3 revisores com POV alternado.
 * Severidade NEUTRA ("GRAVÍSSIMO (💀 / 🔴 conforme a paleta)") porque
 * milionário-1p não tem 💀 (topo é 🔴), igual aos outros checklists compartilhados.
 *
 * Mecânica de correção alinhada às travas existentes (cânone/no-op): só auto-
 * conserta o caso INEQUÍVOCO (trocar o nome do marcador, já que a prosa é a
 * verdade); nos casos que exigem julgamento (qual voz era a intenção, reescrita
 * da cena íntima) prefere INFORMATIVO, pra o Revisor não "consertar errado" e
 * bagunçar a cena (mesma lição do bug "Revisor troca nomes errado").
 */
export const POV_MARKER_REVISOR_CHECKLIST = `

## Checklist de MARCADOR DE POV ✦ (CRÍTICO — específico do Revisor, Parte 2)

Na Parte 2 a narração alterna entre a heroína e o protagonista masculino, e cada troca leva o marcador ✦ NOME. O nome do marcador TEM que ser quem realmente narra o bloco logo abaixo dele — o exporter destaca o POV por esse nome, então um marcador errado joga o destaque no trecho errado. Leia o CONTEÚDO de cada bloco (de quem é o "eu", o que essa voz sabe, qual corpo está sendo sentido por dentro) e cruze com o nome do marcador.

DETECTE e marque no bloco <erros_detalhados> (cada um GRAVÍSSIMO — 💀 / 🔴 conforme a paleta da sua categoria):

• MARCADOR NO BLOCO ERRADO — o ✦ NOME não bate com quem narra o bloco (marcador do protagonista masculino sobre um bloco que é claramente a heroína narrando, ou o contrário). A prosa é a VERDADE; o marcador é o rótulo errado. Conserto: troque SÓ a linha do marcador pelo nome de quem de fato narra — trecho_original = a linha ✦ NOME errada, trecho_corrigido = a MESMA linha com o nome certo (só o nome muda; o corpo do bloco fica intacto). Se o mesmo ✦ NOME aparece em mais de um bloco, inclua também a 1ª linha do bloco logo após o marcador pra o trecho_original ficar único. Se houver dúvida real de quem narra, emita INFORMATIVO (trecho_corrigido vazio) descrevendo a inconsistência.

• TROCA DE POV NA FRONTEIRA DO BLOCO SEM MARCADOR NENHUM (o erro mais comum — em especial o RETORNO à heroína) — um bloco do parceiro (ou da heroína) termina e o próximo parágrafo/cena claramente passa pra OUTRO narrador, mas NÃO há ✦ NOME abrindo o novo trecho. O caso campeão: depois de um bloco ✦ do parceiro, a heroína volta a narrar e o trecho dela fica órfão, sem cabeçalho — parece continuação do POV dele e o exporter joga o destaque errado. Conserto: insira o ✦ [NOME DE QUEM PASSA A NARRAR — quase sempre a heroína] antes do trecho que retoma. trecho_original = a 1ª frase (única) do trecho órfão, trecho_corrigido = a linha ✦ NOME + quebra de parágrafo + essa MESMA frase (inserção; o corrigido fica mais longo, nunca é no-op). Se houver dúvida real de quem narra, emita INFORMATIVO.

• VOZ TROCA NO MEIO DO BLOCO SEM MARCADOR — dentro de um único bloco (entre dois ✦, ou num bloco de marcador único), o "eu" deixa de ser uma pessoa e vira outra sem um novo ✦. Aponte a frase exata da virada. Se a cena é normal (não é a íntima) e faltou só o marcador, o conserto é inserir o ✦ [NOME DE QUEM PASSA A NARRAR] antes do trecho que vira — trecho_original = a 1ª frase do novo narrador, trecho_corrigido = a linha ✦ NOME + quebra de parágrafo + essa MESMA frase (inserção, o corrigido fica mais longo). Se não der pra ter certeza de qual voz era a intenção, emita INFORMATIVO descrevendo o ponto da virada.

• CENA ÍNTIMA COM MAIS DE UMA VOZ — a cena íntima / marcação tem um ✦ de outro personagem dentro dela, ou a voz do parceiro assume a narração em algum ponto. Ela é SEMPRE um POV contínuo da heroína. AQUI o conserto NUNCA é inserir o marcador do parceiro (legitimar o POV dele na cena íntima é proibido) — é manter a voz da heroína: reescreva a(s) frase(s) que escorregaram pra voz dele de volta pro POV dela (trecho_corrigido em 1ª pessoa da heroína), ou emita INFORMATIVO se a reescrita exigir decisão da roteirista.

• MARCADOR ✦ NOME NA PARTE 1 (GRAVÍSSIMO) — a Parte 1 é narrada 100% pela heroína (FMC), do começo ao fim, inclusive o cliffhanger final: NENHUM marcador ✦ NOME pode aparecer nela (o formato ✦ é EXCLUSIVO da Parte 2). Um ✦ NOME na Parte 1 é sempre erro — em especial ✦ [protagonista masculino], que anuncia um bloco de POV do MMC onde só devia haver a voz da heroína (bug real: ✦ THIERRY narrando no meio da Parte 1 da máfia). Detecte e trate cada ocorrência: se logo abaixo do marcador a prosa está de fato na voz da heroína (é só o marcador sobrando), o conserto é REMOVER a linha do marcador — trecho_original = a linha ✦ NOME, trecho_corrigido = vazio (remoção). Se o bloco inteiro escorregou pro POV do MMC (a voz é dele), é INFORMATIVO descrevendo o trecho pra a roteirista decidir (reescrever pra 1ª pessoa da heroína é decisão editorial, não troca mecânica).

Antes de fechar a revisão, varra TODOS os marcadores ✦: na Parte 1 não sobrou NENHUM (ela é toda da heroína)? Na Parte 2, cada um bate com a voz do bloco que encabeça? CADA troca de narrador — inclusive todo retorno à heroína depois de um bloco do parceiro — tem o seu ✦ NOME (nenhum trecho órfão sem cabeçalho)? Nenhum bloco troca de narrador no meio sem marcador? A cena íntima ficou num POV só (a heroína)?`;
