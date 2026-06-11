# Coletor central de consumo de tokens (Google Sheets)

Recebe os eventos de uso enviados pelos apps das roteiristas e junta tudo numa
planilha — a **visão da equipe** do gasto de tokens da assinatura compartilhada.

Só trafegam **números de tokens + metadados** (nome da roteirista, roteiro,
categoria, passo, modelo, data). **Nenhum texto de história sai da máquina.**

## O que você precisa fazer (uma vez)

### 1. Criar a planilha + colar o script

1. Crie uma planilha nova no Google Sheets (ex.: "MyStoriesLena — Tokens").
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo do `Code.gs` e cole o conteúdo de [`Code.gs`](./Code.gs)
   desta pasta.
4. Na linha do `TOKEN`, troque `"TROQUE_ESTE_TOKEN"` por uma senha qualquer
   (ex.: `"veludo-2026-xYz"`). **Guarde esse valor** — ele vai no app também.
5. Salve (💾).

### 2. Publicar como Web App

1. Botão **Implantar → Nova implantação**.
2. Em "Tipo", escolha **App da Web**.
3. Configure:
   - **Executar como:** Eu (seu e-mail).
   - **Quem pode acessar:** **Qualquer pessoa**.
4. Clique em **Implantar** e autorize o acesso quando o Google pedir.
5. Copie a **URL do app da Web** (termina em `/exec`).

### 3. Me passar URL + token

Me mande aqui no chat a **URL** (`…/exec`) e o **TOKEN** que você escolheu. Eu
ligo os dois no app (constantes `USAGE_SHEET_URL` / `USAGE_SHEET_TOKEN` em
`lib/usage-log.ts`) e publico a versão pra equipe.

> Pra testar antes: abra a URL `/exec` no navegador — deve responder
> `{"ok":true,"service":"mystorieslena-usage"}`.

## Como funciona

- Cada app envia os eventos em lote (a cada ~10s ou 25 eventos), com retry se a
  rede falhar. O script **deduplica por `id`**, então reenvio não duplica linha.
- A aba **`eventos`** é criada sozinha, com cabeçalho:
  `id · ts · writer · roteiroId · category · step · model · input · output · cacheRead · cacheWrite`.

## Resumo por roteirista / dia (opcional)

Crie uma aba **`resumo`** e cole numa célula (ex.: A1):

```
=QUERY(eventos!A:K; "select C, sum(H), sum(I), count(A) where A is not null group by C label sum(H) 'Input', sum(I) 'Output', count(A) 'Chamadas'"; 1)
```

Troque `C` (writer) por `F` (step) ou `E` (category) pra ver por passo/categoria.
Pra por dia, dá pra usar uma coluna auxiliar com `=LEFT(B2;10)` (a data) e
agrupar por ela.
