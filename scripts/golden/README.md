# Golden set — regressão de qualidade do Revisor

Histórias **boas e fixas** que servem de referência. Sempre que você mexer nos
prompts do Revisor, rode o check pra ver se a NOTA caiu — antes de publicar pra
equipe.

É **manual e local** (não roda no CI): precisa de OAuth e gasta um pouco da cota
da equipe (≈1 chamada de Revisor por amostra). Roda só o Revisor sobre o texto já
pronto — **não regera história nenhuma**, então o custo é baixo.

## Como rodar

1. Deixe o app rodando e logado na conta Claude: `npm run dev` (ou `npm run electron:dev`).
2. Em outro terminal:
   ```bash
   npm run golden            # roda a Parte 1 (revisor1) de cada amostra
   npm run golden -- --p2    # também roda a Parte 2 (revisor2)
   ```
3. O resultado vai pra `scripts/golden/results/<timestamp>.json` e o script
   compara com a rodada anterior, mostrando o Δ da nota. Se a nota cair ≥ 0,5 ou
   o risco de hate piorar, ele **sai com erro** (pra segurar o release).

## Como adicionar amostras (3 a 5 recomendadas)

Cada amostra é um arquivo `scripts/golden/<nome>.json` com o snapshot dos outputs
de um roteiro **bom** já finalizado:

```json
{
  "category": "milionario-1p",
  "canone": "(opcional) texto do Cânone de Entidades",
  "outputs": {
    "premissa": { "content": "..." },
    "estrutura1": { "content": "## Capítulo 1 — ... (~1.900 palavras ...)\n..." },
    "estrutura2": { "content": "..." },
    "escrita": {
      "content": "história completa concatenada (opcional se houver metadata.chapters)",
      "metadata": {
        "chapters": [
          { "part": "Parte 1", "number": 1, "title": "...", "content": "..." }
        ]
      }
    }
  }
}
```

`category` deve ser uma das quatro: `milionario-1p`, `milionario-3p`, `mafia`,
`alpha-king`.

### De onde tirar o snapshot

A forma mais fácil: pegue um dos seus **melhores roteiros já prontos** do backup.
O backup automático fica em
`%APPDATA%\MyStoriesLena\backups\veludo-roteiros-*.json` (Windows) — é um array de
roteiros. Copie de um deles os campos `category`, `canone` e `outputs` (premissa,
estrutura1, estrutura2, escrita) para um arquivo aqui. Renomeie o arquivo com um
nome curto (ex.: `milionario-1p-ana.json`).

> Os arquivos de amostra e a pasta `results/` **não** entram na história gerada —
> são só insumo de teste.
