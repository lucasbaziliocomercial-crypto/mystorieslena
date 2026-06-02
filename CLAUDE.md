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

The Escrita agent runs in **2-em-2 mode**: the frontend loop in `components/wizard/StepShell.tsx` dispatches sequential batches of 2 chapters each (`[P1:1,2] → [P1:3,4] → ... → [P2:1,2] → ...`), respecting the part boundary. Each batch returns the chapters plus a `═══ SINOPSES ═══` block with a 3-5 sentence summary per chapter — these synopses become context for subsequent batches and act as the bridge from Parte 1 to Parte 2. The Escrita step itself does no word-count calibration — capítulos saem com a contagem que sair. The legacy parser `lib/parse-escrita-output.ts` is kept for retro-compat with old all-at-once roteiros in localStorage.

The **Revisor step** runs three phases when the user clicks Gerar: (1) per-chapter extension via `/api/escrita-fix-wordcount` (Opus) for any chapter outside the per-cap target ±3%, updating `outputs.escrita` in place; (2) part-total balance via the same endpoint if the Parte total falls outside `partTotalRange(part, category)` (varia por categoria — milionário-1p 11.300-11.700/13.000-13.500, milionário-3p 9.500-10.500/13.000-14.000, máfia 12.300-12.700/13.300-13.700); (3) structured review via `/api/agent/revisor` that streams the markdown report plus an `<erros_detalhados>` XML block parsed into `metadata.errors` for one-click `find+replace` fixes. The escritaSnapshotHash is taken AFTER extension so the UI can detect post-revision edits to the calibrated text. Re-clicking Gerar re-runs all three phases — phase 1/2 are idempotent (chapters already within target are skipped).

### Escrita word counting — MANDATORY rule

**Always use `countWords` from `@/lib/word-count`.** This is the single source of truth — the same function the UI uses to display word counts in `WordCountBadge`. NEVER write a local `text.split(/\s+/)` counter — naive whitespace splits don't treat `—`, `–`, `-` as separators, which inflates counts by ~3% in romance text full of dialogue (`— Boa tarde.` is 2 words, not 3). Any divergence between backend counter and UI counter creates broken fix-wordcount/balance calls that ask for the wrong expansion.

The structure-prompt rule (which `partTotalRange` in `lib/parse-estrutura-targets.ts` encodes) varies por categoria:
- **milionário-1p — Parte 1: 11.300–11.700 palavras totais** (alvo 11.500) — see `lib/agents/milionario1p/estrutura1-prompt.ts`
- **milionário-1p — Parte 2: 13.000–13.500 palavras totais** (rigoroso, jamais fora) — see `lib/agents/milionario1p/estrutura2-prompt.ts`
- **milionário-3p — Parte 1: 9.500–10.500 palavras totais** (alvo 10.500) — see `lib/agents/milionario3p/estrutura1-prompt.ts`
- **milionário-3p — Parte 2: 13.000–14.000 palavras totais** (alvo 13.500) — see `lib/agents/milionario3p/estrutura2-prompt.ts`

The per-chapter target lives in the structure header itself: `## Capítulo N — [Título] (~X.XXX palavras — ritmo Y)`. The `extractChapterTargets` parser in `lib/parse-estrutura-targets.ts` reads these per-cap targets directly from the headers — that's why `splitChapterBlocks` includes the header line in each block (the `(~X.XXX palavras)` is on the header, not in the body).

Per-chapter target margin is **±3%** (with a 30-word minimum) — see `targetRange`. After the last batch of each Part, a part-total compensating fix fires if the total falls outside the range.

### State and persistence

- Wizard state lives in Zustand (`store/wizard.ts`) and is mirrored to `localStorage` under key `veludo:roteiros` via `lib/storage.ts` on every mutation.
- There is no server-side DB — the app is single-user, single-machine.
- Each step keeps a per-step history stack (max 20 snapshots) so regenerating preserves the previous version.

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
