# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

Desktop app (Electron + Next.js 16) that drives a 5-step wizard for producing Brazilian Portuguese romance scripts ("Romance de Milionário"). Each step is a specialized Claude agent. **Auth is OAuth via the user's Claude Pro/Max subscription — there is no API key path in the runtime.**

## Commands

```bash
npm install
npm run electron:dev      # Next dev (port 3000) + Electron with hot-reload
npm run dev               # just Next.js, no Electron shell
npm run package           # next build + electron-builder NSIS installer (Windows)
npm run release           # same + publish to GitHub Releases (needs GH_TOKEN env)
npm run icon:build        # regenerates electron/icons/icon.ico from SVG (runs as `prepackage`)
```

There is no test suite, no linter script, and no typecheck script. Type errors surface only at `next build` time.

## Architecture

### Three runtime modes (electron/main.js)

The Electron main process boots in one of three modes, decided in `boot()`:

1. **`external-dev`** — `NEXT_DEV_URL` is set (used by `npm run electron:dev`). Loads from the external Next dev server.
2. **`live`** — `MYSTORIESLENA_SOURCE_DIR` env var points at a valid project dir with `node_modules/next` installed. Spawns `next dev` from that source directory on a free port. This is the **maintainer-only mode**: the installed `MyStoriesLena.exe` reads directly from the working tree, so editing code + closing/reopening the app shows changes instantly. Auto-updater is disabled in this mode.
3. **`packaged`** — default for end users. Spawns `node server.js` from the standalone bundle in `process.resourcesPath/app` (copied there by `extraResources` in package.json), waits for `/api/health`, then loads it in the BrowserWindow.

### Claude binary resolution

The Claude Agent SDK shells out to a native `claude` binary (per-platform subpackage like `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`). When packaged, those subpackages live outside `require.resolve` reach, so:

- `electron/main.js#getClaudeExecutablePath()` walks a list of candidate paths and picks the first that exists.
- The resolved path is passed to the Next server via `MYSTORIESLENA_CLAUDE_EXEC` env var.
- `lib/claude.ts` reads `process.env.MYSTORIESLENA_CLAUDE_EXEC` and passes it to `query()` as `pathToClaudeCodeExecutable`.

If you change anything about how the binary is bundled, the `extraResources` filter in `package.json` and the `subPaths` array in `getClaudeExecutablePath` must stay in sync. On Windows, the CLI also requires `bash.exe` from Git for Windows — `claude:setup` IPC autoinstalls it via winget.

### Env sanitization (critical)

`lib/claude.ts#streamClaudeText` deletes empty `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and any `ANTHROPIC_BASE_URL` from the env passed to the SDK. **Empty (not absent) values flip the SDK into API-key mode and cause 401s** even when the user is logged in via OAuth. Don't reintroduce these vars without similar guarding in `electron/main.js` (which does the same scrub before spawning the Next server).

### Streaming pipeline

`POST /api/agent/[step]` (`app/api/agent/[step]/route.ts`) is the single entrypoint:

1. Reads `category` from the body (default `"milionario-1p"` for legacy clients) and looks up the agent via `getAgent(category, step)` (`lib/agents/index.ts` → `lib/categories/index.ts`).
2. Calls `agent.buildUserMessage({ previousOutputs, userInput, referenceImage })` to assemble the prompt.
3. Uses `agent.model` directly. Models are passed as the SDK shorthand strings `"opus" | "sonnet" | "haiku"` (see `lib/anthropic.ts`), not full IDs — let the SDK resolve them.
4. If `agent.acceptsReferenceImage === true` and a `referenceImage` is present, decodes the data URL and sends a multimodal `[image, text]` user message; otherwise plain text.
5. Streams `content_block_delta.text_delta` chunks back as `text/plain`. The frontend (`components/wizard/StepShell.tsx`) reads with `ReadableStreamDefaultReader` and either updates the buffer live or, for the Escrita step, parses the structured output post-stream via `lib/parse-escrita-output.ts`.

If the SDK throws an auth-shaped error, the route injects a Portuguese-language `[LOGIN NECESSÁRIO NO CLAUDE]` block into the stream with recovery instructions.

### Categorias / sub-nichos

O app suporta múltiplos sub-nichos de romance, registrados em `lib/categories/index.ts`. Cada `Roteiro` tem um campo `category: RoteiroCategory` travado na criação (escolhido no `CategoryPicker` antes do roteiro existir):

- `milionario-1p` — Romance de Milionário em 1ª pessoa (default; default histórico para roteiros legados sem `category` — backfill em `lib/storage.ts`).
- `milionario-3p` — Romance de Milionário em 3ª pessoa pelo canal Rowan. Narração 3ª pessoa **limitada à FMC nas DUAS partes** (sem POV masculino, sem alternância — MMC observado pelos atos do início ao fim, inclusive na cena erótica da Parte 2), prompts próprios em `lib/agents/milionario3p/`. Premissa bifásica (resumos ≤500 palavras + obrigações de estrutura). Totais 10.500 (P1, faixa 9.500–10.500) / 13.500 (P2, faixa 13.000–14.000). Símbolos 🟢🟡🔴💀 no Revisor.
- `mafia` — Dark Romance de Máfia (prompts próprios, totais 12.500/13.500 em vez de 11.500/13.250, símbolos 🟢🟡🔴💀 no Revisor).
- `alpha-king` — Romance Alpha King / Werewolf pelo canal Alpha King (estilo Helô Stories™). Universo werewolf (alcateias, Moon Goddess, vínculo de mate, marcação, hierarquia Alpha/Luna/Beta/ômega). Narração 1ª pessoa: Parte 1 exclusiva da heroína (futura Luna); Parte 2 alterna heroína (principal) + 2–4 trechos do Alpha King marcados com `✦ NOME` — cena íntima/marcação completa sempre pela heroína (mesmo modelo de POV da máfia). Premissa bifásica (resumos ≤500 palavras + obrigações de estrutura). Totais 11.500 (P1, faixa 11.300–11.700, **6 capítulos fixos**) / 13.500 (P2, faixa 13.000–13.500, 5–6 caps). Símbolos 🟢🟡🔴💀 no Revisor. Prompts em `lib/agents/alphaking/`.

Cada categoria tem seu próprio diretório `lib/agents/<id>/` com 5 agentes + prompts. O dispatcher `getAgent(category, step)` em `lib/agents/index.ts` puxa do registry. `partTotalRange(part, category)` e `planBatches(..., category)` são category-aware. Os endpoints `/api/agent/[step]`, `/api/escrita-fix-wordcount` e `/api/revisor-extract-errors` recebem `category` no body — sem isso, caem no default `milionario-1p`.

Para adicionar um sub-nicho: crie `lib/agents/<id>/` (5 agentes + prompts), registre em `lib/categories/index.ts`, e estenda `RoteiroCategory` em `types/roteiro.ts`.

### Agent shape

Each step in `lib/agents/<categoria>/` exports an `Agent` (`lib/agents/types.ts`) with: `model`, `systemPrompt`, `buildUserMessage`, `thinking` (default `disabled` for speed), `effort` (default `low`), and `acceptsReferenceImage`. The Premissa step is intentionally manual in the UI — the user pastes text — but the agent definition exists for future use.

The Escrita agent runs in **2-em-2 mode**, driven by the headless engine `lib/generation/run-escrita.ts` (full-gen always enqueues — the `StepShell` loop is dead code for it). **Parte 1 e Parte 2 rodam EM PARALELO** (`Promise.all` de dois loops independentes: `[P1:1,2]→[P1:3,4]→…` ‖ `[P2:1,2]→[P2:3,4]→…`), cada Parte com seu próprio acumulador de sinopses pra continuidade **intra**-Parte. **Continuidade CRUZADA P1→P2 (costura na origem):** a P2 recebe a cada batch um snapshot **best-effort** das sinopses que a P1 **já escreveu** naquele instante (`crossSynopsesRef` no `runPartLoop` → `crossPartSynopses` no body → bloco "FATOS JÁ ESTABELECIDOS NA PARTE 1" via `lib/agents/_shared/cross-part-block.ts`, nas 4 categorias). Leitura **sem bloqueio** — como as duas Partes avançam no mesmo ritmo, a P2 normalmente já tem os fatos da P1 até o cap que está escrevendo, então o paralelismo continua ~cortando pela metade a fase de batches. Isso elimina **na origem** os GRAVES de continuidade cruzada ("personagem em dois lugares", "contradição de concepção P1↔P2") que a ponte só-pela-Estrutura deixava passar; a P1 é a fundação e não recebe contexto cruzado, e o Revisor (que também roda P1‖P2) ainda pega resíduos. Each batch returns the chapters plus a `═══ SINOPSES ═══` block with a 3-5 sentence summary per chapter — these synopses become context for subsequent batches **da mesma Parte**. **Assim que a geração de CADA Parte termina** (via `.then` no `Promise.all` — NÃO no fim das duas), aquela Parte dispara sua própria calibração de word-count **deferida e em PARALELO** (threshold/concorrência em `lib/escrita-calibration.ts` — hoje **±8%** e cap **5**, via `lib/concurrency.ts#createLimiter` — limitador **COMPARTILHADO** pelas duas Partes, então o teto **5** é o total mesmo com P1 e P2 alimentando o mesmo pool): cada cap fora da faixa vira uma reescrita **Sonnet** independente em `/api/escrita-fix-wordcount` (ajuste mecânico de tamanho — Sonnet alivia a fila Opus compartilhada da equipe) — **muta o capítulo in-place** no array da Parte e só lê sinopses **da própria Parte** (`s.part === ch.part`), então rodar concorrente dá o MESMO resultado que em série, só mais rápido. Como a P1 termina antes da P2, a **calibração (Sonnet) da P1 SOBREPÕE a cauda de geração (Opus) da P2** — aproveita a cota que ficava ociosa e tira a calibração do caminho crítico do "fim" (lossless: a vizinhança de sinopses já é por-Parte, então calibrar a P1 sem a P2 pronta não perde contexto). Antes a calibração era um passo único `mapWithConcurrency` **depois** das duas Partes — virou per-Parte sobreposta. O ±8% (afrouxado do ±5%) reduz o nº de reescritas (= mais rápido); o ajuste fino final a ±3% acontece no step Revisor. A constante de calibração (`lib/escrita-calibration.ts`) é compartilhada; o full-gen vive SÓ em `run-escrita.ts` — o branch do `StepShell` é caminho morto, **não o reanime**. Numa assinatura única (OAuth), chamadas Opus concorrentes podem enfileirar no servidor — se a calibração paralela não acelerar, reduza `CALIBRATION_CONCURRENCY`. O motor headless emite o texto cru do batch atual via hook `onLiveText` (throttled ~80ms); o `QueueRunner` reflete em `useWizard.queueLiveStream` (transient) **só quando o roteiro do job está aberto**, e o `StepShell` mostra esse preview ao vivo no banner do job em 2º plano. The legacy parser `lib/parse-escrita-output.ts` is kept for retro-compat with old all-at-once roteiros in localStorage.

The **Revisor step** runs three phases when the user clicks Gerar: (1) per-chapter extension via `/api/escrita-fix-wordcount` (Sonnet — ajuste mecânico de tamanho) for any chapter outside the per-cap target ±3%, updating `outputs.escrita` in place; (2) part-total balance via the same endpoint if the Parte total falls outside `partTotalRange(part, category)` (varia por categoria — milionário-1p 11.300-11.700/13.000-13.500, milionário-3p 9.500-10.500/13.000-14.000, máfia 12.300-12.700/13.300-13.700); (3) structured review via `/api/agent/revisor` that streams the markdown report plus an `<erros_detalhados>` XML block parsed into `metadata.errors` for one-click `find+replace` fixes. The escritaSnapshotHash is taken AFTER extension so the UI can detect post-revision edits to the calibrated text. Re-clicking Gerar re-runs all three phases — phase 1/2 are idempotent (chapters already within target are skipped).

**Revisor — modo enxuto SEMPRE (1ª passada inclusive):** **toda** revisão roda em **modo enxuto** (`leanRevisorReport`) — entrega `PRINCIPAIS ERROS` + o bloco `<erros_detalhados>` (que move os cards de 1 clique) + **sempre** a `ANÁLISE DE HATER`, o `NÍVEL DE RISCO DE HATE` e a `NOTA FINAL` (travados — a roteirista considera nota+hate essenciais), e **pula** o resto do ensaio (Sugestões Práticas / Análise como Leitor / Melhorias). Como só `<erros_detalhados>` + `NOTA` + `PRINCIPAIS ERROS` são consumidos por código (`lib/parse-revisor-output.ts`) e output domina o wall-clock, a roteirista optou por enxugar **já na 1ª passada** (antes só ligava da 2ª em diante) — ~corta o tempo da revisão. A instrução de override é injetada uma vez na factory `lib/agents/_shared/build-revisor-agent.ts` (cobre as 4 categorias, framing pass-agnostic); `lib/generation/run-step.ts#runRevisorStep` (fila — caminho da 1ª revisão) e o branch "Continuar revisão" do `StepShell` mandam **ambos** `leanRevisorReport: true` incondicional — **mantenha os dois em sincronia**. O ensaio completo deixou de ser gerado por padrão (pra reativá-lo seria preciso mandar `leanRevisorReport: false`; não há UI pra isso hoje).

**Revisor — Parte 1 e Parte 2 em paralelo:** o lock de concorrência do `QueueRunner` é por `${roteiroId}:${step}` (não por roteiro), então revisor1 e revisor2 do mesmo roteiro rodam ao mesmo tempo na fila (ainda limitado por `MAX_CONCURRENT`; cada job grava uma chave de step distinta e `applyStepOutput` re-lê o roteiro fresco e síncrono antes de gravar, sem race). O gate duro do revisor2 virou **aviso suave** — botão "Revisar as duas em paralelo" (a P2 roda sem o relatório da P1 como contexto; re-rodar a P2 enxuta depois de consolidar a P1 pega inconsistências cruzadas) + o caminho sequencial preservado.

### Evals de qualidade — nota objetiva versionada (context engineering / Karpathy)

Conceito do Karpathy "não dá pra otimizar o que não se mede" aplicado ao roteiro: a cada geração de revisão (revisor1/revisor2) o app deriva um **[EvalSnapshot]** (`types/roteiro.ts`) do relatório que o Revisor JÁ produz — **custo zero de cota, nenhuma chamada extra ao modelo**. Campos: `nota` (0–10, via `parseRevisorNota`), `hateRisk` (🟢/🟡/🔴, via `parseRevisorHateRisk` — heurística: nível seguido de travessão, fallback por emoji), `counts` por gravidade, `errorTotal`, `canFinish` (mesma regra do banner: Nota ≥ 8 e zero gravíssimos) e `escritaHash`. `computeRevisorEval` (`lib/parse-revisor-output.ts`) monta o snapshot; retorna null pra step não-revisor ou relatório sentinela (`[ERRO]`/`[LOGIN…]`).

- **Versionado, append-only:** gravado em `Roteiro.evals` (sobrevive ao round-trip do storage porque os sanitizers usam spread `{...r}`). `appendEvalSnapshot` (`lib/eval-log.ts`) anexa com **dedup** (re-commit idêntico — mesmo step+nota+hate+errorTotal+hash — não polui o log) e soft-cap `EVAL_LOG_CAP=200` só pra proteger o localStorage. Cresce além do cap de 5 do histórico de step, então dá pra ver a curva de qualidade ao longo de TODAS as re-rodadas.
- **Dois seams de gravação (mantenha em sincronia):** (1) foreground — `store/wizard.ts#recordEval`, chamado no `StepShell` SÓ nos dois pontos de conclusão de revisão (branch dedicado per-part + branch padrão de re-geração), **nunca** em refine/aplicar correção (o log é trilha de gerações, não de toda mutação); (2) fila — `QueueRunner#applyStepOutput` anexa no storage quando o roteiro NÃO está ativo (se ativo, o store grava via `recordEval` e seu persist venceria — evita corrida/duplicata). `lib/eval-log.ts` importa SÓ tipos de `@/types/roteiro` pra `appendEvalSnapshot` seguir testável via node (`--experimental-strip-types` não resolve `@/` em import de valor); a montagem que precisa de `computeRevisorEval` (import de valor) fica nos call sites.
- **UI:** `RevisorVerdictBanner` (`StepShell`) mostra Nota + **Δ vs a rodada anterior desta Parte** (▲/▼) + chip de risco de hate + um `<details>` "📈 Histórico de qualidade" com as últimas rodadas (nota, hate, nº de erros, ✅ pode-finalizar, tempo relativo). É advisory — nunca bloqueia.

### Escrita word counting — MANDATORY rule

**Always use `countWords` from `@/lib/word-count`.** This is the single source of truth — the same function the UI uses to display word counts in `WordCountBadge`. NEVER write a local `text.split(/\s+/)` counter — naive whitespace splits don't treat `—`, `–`, `-` as separators, which inflates counts by ~3% in romance text full of dialogue (`— Boa tarde.` is 2 words, not 3). Any divergence between backend counter and UI counter creates broken fix-wordcount/balance calls that ask for the wrong expansion.

The structure-prompt rule (which `partTotalRange` in `lib/parse-estrutura-targets.ts` encodes) varies por categoria:
- **milionário-1p — Parte 1: 11.300–11.700 palavras totais** (alvo 11.500) — see `lib/agents/milionario1p/estrutura1-prompt.ts`
- **milionário-1p — Parte 2: 13.000–13.500 palavras totais** (rigoroso, jamais fora) — see `lib/agents/milionario1p/estrutura2-prompt.ts`
- **milionário-3p — Parte 1: 9.500–10.500 palavras totais** (alvo 10.500) — see `lib/agents/milionario3p/estrutura1-prompt.ts`
- **milionário-3p — Parte 2: 13.000–14.000 palavras totais** (alvo 13.500) — see `lib/agents/milionario3p/estrutura2-prompt.ts`

The per-chapter target lives in the structure header itself: `## Capítulo N — [Título] (~X.XXX palavras — ritmo Y)`. The `extractChapterTargets` parser in `lib/parse-estrutura-targets.ts` reads these per-cap targets directly from the headers — that's why `splitChapterBlocks` includes the header line in each block (the `(~X.XXX palavras)` is on the header, not in the body).

Per-chapter target margin is **±3%** (with a 30-word minimum) — see `targetRange`. After the last batch of each Part, a part-total compensating fix fires if the total falls outside the range.

**Trava de soma da Estrutura (determinística):** só a milionário-1p Parte 1 tem números fixos no prompt que somam o total exato; a Parte 2 e as outras categorias deixam o modelo distribuir as palavras (placeholders `~X.XXX palavras` / `Contagem aproximada: [N palavras]`) e costumavam **estourar** o total — a Escrita escrevia longo e a calibração/balanço tinham que encolher tudo (mais lento). Agora, após cada geração de Estrutura, `lib/normalize-estrutura-targets.ts#normalizeEstruturaTargets` soma os alvos por capítulo e, se a soma cair fora de `partTotalRange`, reescala proporcionalmente pro total alvo (resíduo de arredondamento no maior cap → soma EXATA), reescrevendo **só** o token de alvo de cada bloco de capítulo (não toca total/hook/prosa). Plugado em `run-step.ts#runEstruturaStep` (fila) e nos caminhos foreground de Estrutura no `StepShell` (continue/refine). Silencioso (`console.info`). Isso impede o estouro de chegar na Escrita → menos reescritas de calibração.

### State and persistence

- Wizard state lives in Zustand (`store/wizard.ts`) and is mirrored to `localStorage` under key `veludo:roteiros` via `lib/storage.ts` on every mutation.
- There is no server-side DB — the app is single-user, single-machine.
- Each step keeps a per-step history stack (max **2** snapshots, `HISTORY_CAP` exportado de `lib/storage.ts` — `store/wizard.ts` importa a MESMA constante, não repete o literal) so regenerating preserves the previous version. Baixado de 5 → 2 pra aliviar máquinas fracas (cada snapshot da Escrita ~200KB).
- **In-memory cache do storage:** `lib/storage.ts` mantém um cache (módulo-level) do array de roteiros já descomprimido + sanitizado. Sem ele, todo save (debounce 600ms + checkpoints a cada 2.5s no streaming) re-descomprimia e re-sanitizava a biblioteca inteira — O(biblioteca) por save. Agora o pipeline pesado roda só na 1ª leitura; os writers mutam o cache e só pagam o `serialize` (compress). Se algo escrever `veludo:roteiros` por fora dos helpers do módulo, chame `resetRoteirosCache()`.
- **Imagem de referência fora do blob quente:** o `dataUrl` (base64, ~0,3-0,5 MB) de `referenceImage` mora numa chave lateral `veludo:refimg:<id>`, NÃO no blob `veludo:roteiros` — senão entrava em TODA compressão de save (custo cresce com o nº de roteiros). Invariante: o cache em memória SEMPRE tem o `dataUrl` reidratado (`hydrateRefImage` no read); só o blob persistido grava `dataUrl: ""` (`stripRefImage` no write, via `serializeForBlob` em todos os writers; `serialize`/backup mantêm inline). `stripRefImage` só reescreve a chave quando a string muda (identidade `===` em `lastWrittenRefImg`), e cai pra inline se a quota estourar (nunca perde a imagem). Nenhum consumidor de `referenceImage` muda — todos leem do cache reidratado. Migração legada (imagem inline) é lazy: o 1º save move pra chave lateral.
- **Fila grava coalescido (anti-travamento):** o `QueueRunner` grava por id pelo caminho COALESCIDO/idle (`scheduleSave` + `flushPendingSave` ao concluir o job), NÃO o `saveRoteiro` direto. O save direto comprimia a biblioteca toda de forma síncrona a cada batch — com 2 jobs em paralelo isso empilhava e travava a janela (dialog "MyStoriesLena travou"). `scheduleSave` junta tudo num Map por id e comprime 1× por janela de 600ms em `requestIdleCallback`. `serialize` loga `[perf] serialize: <ms>ms, <N> roteiros, <chars> chars` — deve aparecer coalescido, não por batch×job.
- **Limpar cache + limpeza automática:** botão "Limpar cache" (`components/ClearCacheButton.tsx`, no header da `RoteiroList`) + agente automático (`components/AutoCleanup.tsx` no layout, semanal via `veludo:lastCleanup`; + `runAutoCleanup` no main ~20s após o boot). Renderer: `pruneCacheLikeData()` poda `history`→2 / `evals`→30 e recompacta o blob enxuto — NUNCA toca em `outputs`/roteiros. Main (IPC `cache:clear`/`cache:get-size` em `electron/main.js`): `session.clearCache()` + `clearStorageData({ storages })` com **allowlist explícita SEM "localstorage"** (os roteiros moram lá — é o único ponto perigoso) + poda backups além de 5 + trunca `next-server.log`. Degradação graciosa sem Electron (só a poda do localStorage).

### Prompt caching (velocidade)

`lib/claude.ts#streamClaudeText` passa `systemPrompt` como `[systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY]` (constante do SDK). Tudo antes do marcador vira prefixo estático cacheável cross-call — como nosso system prompt é 100% estático por categoria/step, ele inteiro é reaproveitado nos 6+ lotes da Escrita, calibrações e fases do Revisor, **sem mudar o que o modelo lê**. O `cache_control: ephemeral` no user message (`buildPromptInput`) cobre re-runs idênticos em < 5 min. Confirme via `cache_read>0` nos logs `[claude.ts] usage:`. **Output domina o wall-clock** (ver `MEMORY.md`), então caching corta TTFT/cold mas não muda o tempo de geração em si.

**Prefixo cacheável na mensagem do usuário (context engineering / Karpathy):** além do system prompt, a mensagem do usuário da **Escrita** também tem um breakpoint de cache. O `buildUserMessage` dos 4 `escrita.ts` monta a mensagem como **prefixo estável** (cânone + premissa + estrutura1 + estrutura2, ~20k tokens — idêntico em todos os batches de uma geração) + o sentinela `CACHE_PREFIX_BOUNDARY` (`lib/agents/_shared/prompt-cache.ts`, U+0002; replicado inline em `lib/claude.ts`) + **sufixo variável** (intro do batch + sinopses + alvos + AÇÃO). O `buildPromptInput` quebra nesse sentinela em **dois text blocks** com `cache_control` cada — o prefixo passa a ser lido do cache (`cache_read`) nos 6+ batches da Parte e cruzado entre os loops P1‖P2, em vez de reprocessado a cada chamada. **A intro do batch desceu pro sufixo** (era o topo) pra o prefixo estável liderar a mensagem (cache trabalha por prefixo de tokens) — por isso ela diz "estruturas ACIMA". Sem o sentinela (Revisor, Estrutura, calibração, refine), `buildPromptInput` mantém o bloco único. Isso ataca o consumo de tokens na **cota compartilhada da equipe** (gargalo dominante) e o TTFT, **sem mudar o texto gerado**. O acumulador module-level em `lib/claude.ts` loga `[claude.ts] cumulative: … hit=NN%` — o hit% deve subir batch a batch; se um reorder quebrar o prefixo, `cache_read` despenca (regressão visível).

### Geração da Escrita — concorrente + persistente (gerenciador)

A **Escrita** roda num gerenciador FORA do componente: a geração **sobrevive a trocar/fechar a guia** e roda **concorrente** com outras abas (até `MAX_CONCURRENT = 2` — reduzido de 3 porque cada job de Escrita agora usa **2 streams Opus em paralelo** (Parte 1 ‖ Parte 2), pra não estourar a cota da assinatura compartilhada da equipe; é um knob, afine pelos logs `[perf]`). Isso atende ao "deixar várias histórias gerando ao mesmo tempo".

- `store/queue.ts` — fila persistida em `veludo:queue` (só metadados leves; inclui um snapshot do `userInput` do job). Jobs `{ roteiroId, step: "escrita", status, progress, userInput? }`. Jobs `running` no fechamento voltam pra `queued` no load.
- `components/queue/QueueRunner.tsx` — montado 1× no layout. Drena até `MAX_CONCURRENT` jobs **em paralelo** (sem ceder ao foreground, sem 1-por-vez). Pra cada job: roda `runEscrita`, grava por id pelo caminho coalescido (`scheduleSave`, + `flushPendingSave` ao concluir — ver "Fila grava coalescido" em State and persistence) e, **se o roteiro do job for o aberto no momento, também reflete no store ativo** (`useWizard.setOutput`) pra a aba mostrar os capítulos surgindo. Notifica via `Notification` ao concluir.
- **Gatilho:** o botão "Gerar roteiro completo" da Escrita (`StepShell`) **enfileira no gerenciador** (não roda mais o loop no componente). Refine (correção pontual) continua no componente. O `RoteiroList` também tem botão "2º plano". `escritaJob` no `StepShell` mostra o progresso ao vivo + "Cancelar".
- `lib/generation/job-control.ts` — registro de `AbortController` por jobId (fica fora do store porque não é serializável); `abortJob`/`abortAllJobs` pra cancelar.
- **`lib/generation/run-escrita.ts` é o motor headless e a FONTE ÚNICA do full-gen** — roda **Parte 1 ‖ Parte 2 em paralelo** (`Promise.all` de dois `runPartLoop`), com retries, dedup, calibração ±8% paralela (Sonnet) via `mapWithConcurrency` de `lib/concurrency.ts`, e logs `[perf]` por batch (TTFT/total/palavras) + contador de 429/backoff. O foreground in-componente do `StepShell` é caminho morto pra full-gen (interceptado antes — enfileira e dá `return`) e **não** tem a paralelização P1‖P2. **⚠️ Se mexer no loop da Escrita, mexa só no `run-escrita.ts`; não reanime o branch morto do `StepShell`.**
- **Trade-offs:** (a) compartilha a cota da assinatura — N gerações ao mesmo tempo dividem o limite (cada uma pode ficar mais lenta); (b) a aba ativa mostra os capítulos **por par (batch)**, não streaming por token. **Estrutura/Revisor ainda rodam no componente** (param ao trocar de guia) — backgrounding deles é o próximo passo.

### Guias de projetos (multi-projeto)

Barra de abas pra alternar rápido entre projetos abertos, sem voltar à lista.

- `store/tabs.ts` — abas abertas `{ id, title }`, **persistidas em `veludo:tabs`** (a "memória" dos projetos simultâneos — voltam ao reabrir o app). `openTab` é upsert (cria ou atualiza título), cap `MAX_TABS=10` (FIFO).
- `components/tabs/ProjectTabs.tsx` — barra renderizada no topo do `Wizard` (some com ≤1 aba). Cada aba navega pra `/roteiro/<id>`, mostra spinner/ponto âmbar quando o roteiro está gerando/na fila (lê `useQueue`), e tem "×" pra fechar (se fechar a ativa, vai pra outra aba ou home). `+` abre/cria outro projeto.
- Guias são **só navegação** — trocar de aba navega (o store carrega aquele roteiro); não mantém N roteiros vivos em memória. A geração simultânea de fato é a **fila em 2º plano**. `Wizard.tsx` faz `openTab(id, title)` ao abrir; `RoteiroList` faz `closeTab` ao excluir.

### Electron ↔ renderer bridge

`electron/preload.js` exposes `window.mystorieslena` with: `getRuntimeInfo`, `checkForUpdates` / `downloadUpdate` / `quitAndInstall` (electron-updater), `exportRoteiroPdf` (uses Chromium `printToPDF` in a hidden BrowserWindow), `getClaudeStatus` / `setupClaude` (checks `~/.claude/.credentials.json` and opens a terminal running the bundled CLI for `/login`).

## Conventions and gotchas

- **Next.js 16 + React 19** with App Router, `output: "standalone"`. The bundled `node_modules/next/dist/docs/` is the source of truth for any framework API — see `AGENTS.md`.
- **Path alias `@/*`** maps to project root (see `tsconfig.json`).
- shadcn/ui components live in `components/ui/`; do not edit by hand if you can regenerate.
- All user-facing strings are **Brazilian Portuguese**. Match the existing tone when adding UI copy.
- The reference-image data URL is stored inline in the Roteiro (and thus in localStorage) — keep image size limits in mind when changing `ReferenceImageUpload`.
- Auto-updater is wired only when `app.isPackaged && runtimeMode === "packaged"`. Don't expect it to fire in dev or LIVE mode.
- When publishing (`npm run release`) the GitHub repo is hardcoded in `package.json#build.publish` (`lucasbaziliocomercial-crypto/mystorieslena`).
