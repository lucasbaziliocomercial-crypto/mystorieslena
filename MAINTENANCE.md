# Protocolo de Manutenção & Sanitização — veludo (MyStoriesLena)

> Adaptação veludo-específica do "Master System Protocol" / "System Maintenance".
> **Stack real:** TypeScript + Next.js 16 (App Router, `output: standalone`) + React 19 + Electron.
> **NÃO é** Python (`scripts.py`) nem extensão de navegador (Manifest V3) — ignore qualquer
> instrução genérica que assuma esses stacks.

**Papel:** Arquiteto do sistema + orquestrador de sanitização.
**Escopo:** prompts dos agentes (`lib/agents/**`), pipeline de geração (`lib/**`, `app/api/**`),
estado/persistência (`store/**`, `lib/storage.ts`), shell Electron (`electron/**`), UI (`components/**`).
**Objetivo:** core enxuto, modular e sem lixo — **sem quebrar runtime nem o produto em PT-BR**.

---

## ⛔ INVERSÃO CRÍTICA vs. o protocolo original

O protocolo do qual isto deriva tem um **"English-Only Mandate"**. **NÃO se aplica aqui e é proibido.**
O produto do veludo é geração de texto em **português brasileiro**, e o CLAUDE.md manda:
*"All user-facing strings are Brazilian Portuguese."*

- **PRESERVE** todo PT-BR: prompts dos agentes, copy da UI, símbolos do Revisor (🟢🟡🔴💀),
  mensagens de erro, comentários em PT-BR.
- A única "padronização de idioma" permitida é em **identificadores técnicos** já em inglês
  (nomes de função/variável, chaves de JSON, env vars) — e mesmo assim **nunca renomeie**
  identificadores que cruzam runtime boundary (ver NÃO-TOCAR).

---

## FASE 0 — Baseline de segurança (Git) — OBRIGATÓRIA antes de qualquer remoção

A árvore **hoje tem trabalho não-commitado** (features inteiras untracked + arquivos modificados).
Antes de qualquer mudança destrutiva:

1. **Não comece sanitização com a árvore suja.** Faça `git status`. Se houver feature pronta
   untracked (ex.: `components/queue/`, `store/queue.ts`), **commit ou stash primeiro** — senão a
   sanitização e a feature ficam emboladas no mesmo diff e o rollback fica impossível.
2. **Branch antes de destruir** (regra do CLAUDE.md: nunca commitar direto na `main`). Crie
   uma branch de sanitização (`chore/sanitizacao-YYYYMMDD`).
3. Defina o ponto de rollback (commit hash atual) e registre no Changelog final.

## FASE I — Aterramento de arquitetura (antes de processar arquivos)

Não confie em suposições; confirme contra o código:

1. **"Agentes" no veludo** = os 5 steps por categoria em `lib/agents/<categoria>/` (Premissa,
   Sugestões/Estrutura, Escrita, Revisor…), com shape em `lib/agents/types.ts`. O dispatcher é
   `getAgent(category, step)` (`lib/agents/index.ts`). **Não confunda** com "subagents" do SDK.
2. **"Skills" no veludo** = o binário `claude` que o SDK shella (`lib/claude.ts`), **não** uma
   camada de CLI tools do projeto.
3. **Estratégia de contexto** (como o estado flui, pra evitar "amnésia"): sinopses `═══ SINOPSES ═══`
   entre batches da Escrita (ponte P1→P2); history stacks por step (`HISTORY_CAP = 5`, `lib/storage.ts`);
   cache em memória dos roteiros (`lib/storage.ts`, `resetRoteirosCache()`).

## FASE II — Integridade & deprecação cuidadosa

Processe **arquivo a arquivo**, com disciplina:

1. **PT-BR preservado** (ver inversão crítica acima).
2. **Deprecação com rastreabilidade:** remova instruções/imports/dead code **mortos de verdade**,
   resolvendo contradições. **Mantenha log interno do que foi removido** (vai pro Changelog).
3. **Antes de remover qualquer coisa, cheque a lista NÃO-TOCAR.** Várias coisas no veludo são
   *stale-de-propósito* ou retro-compat e **devem** ficar.
4. **Coesão:** cada instrução flui logicamente pra próxima; sem regra órfã de teste antigo.

## FASE III — QA & gate de validação (adaptado: veludo NÃO tem lint/test/typecheck scripts)

O protocolo original manda "rodar linters/unit tests/type checkers". **No veludo isso não existe
como script.** O gate determinístico real é:

1. **`next build`** — é onde erros de tipo aparecem (não há `tsc --noEmit` script). É o type-checker de fato.
2. **Scripts ad-hoc em `scripts/test-*.mjs|ts`** — a suíte de teste de-facto (dedup invariant,
   parse de erros markdown, build-prompt-input, escrita batch, export-html). Rode os relevantes
   ao que você tocou.
3. **Invariantes de sincronia (checagem manual obrigatória)** — pares que o CLAUDE.md manda manter
   em sincronia; quebrar um e não o outro é bug silencioso:
   - `lib/generation/run-escrita.ts` ↔ branch Escrita do `components/wizard/StepShell.tsx` (loop 2-em-2).
   - Constante de calibração (`lib/escrita-calibration.ts`) usada por foreground **e** headless.
   - `getClaudeExecutablePath` `subPaths` (`electron/main.js`) ↔ filtro `extraResources` (`package.json`).
   - Scrub de env (`ANTHROPIC_*` vazias) em `lib/claude.ts` **e** `electron/main.js`.
4. **Circuit breaker:** loop interno `[Rascunho]→[Revisor/Build]→[Correção]` no **máx. 3 iterações**.
   Se ainda falhar, **pare e peça intervenção humana** com resumo do erro.

## FASE IV — Automação de baixa fricção

1. **Run-until-done:** um pedido dispara a cadeia (auditar → corrigir → `next build` → finalizar).
2. **Estados de parada explícitos** — só pause por: (1) ambiguidade crítica, (2) circuit breaker
   (3 tentativas), ou (3) Revisor interno aprovou e falta só a aprovação final do usuário.

## FASE V — Validação final (double-check)

Não finalize sem isto:

1. **Checklist:**
   - [ ] PT-BR 100% preservado (nenhum prompt/UI/erro traduzido)?
   - [ ] Nada da lista NÃO-TOCAR foi removido/renomeado?
   - [ ] `next build` passou? Scripts de teste relevantes rodados?
   - [ ] Invariantes de sincronia verificados (run-escrita↔StepShell, calibração, claude exec, env scrub)?
   - [ ] Features untracked tratadas como **código vivo**, não como lixo?
   - [ ] Deprecações reais removidas, com log?
2. **Output:** **Changelog** conciso (arquivos modificados + legado deprecado + hash de rollback)
   e certificação: *"Integridade verificada. PT-BR preservado. Pipeline validado via next build."*

---

## 🔒 NÃO-TOCAR (blindagem específica do veludo)

Remover/renomear qualquer item abaixo é **regressão**, não sanitização:

- **Features untracked que são código vivo** (descritas no CLAUDE.md, só não commitadas):
  `components/queue/`, `components/tabs/`, `lib/generation/`, `lib/concurrency.ts`,
  `lib/escrita-calibration.ts`, `store/queue.ts`, `store/tabs.ts`.
- **Retro-compat proposital:** `lib/parse-escrita-output.ts` (parser legado p/ roteiros antigos no localStorage).
- **Docs stale-de-propósito:** notas de `milionario-3p` Parte 2 (onisciente) no CLAUDE.md / `premissa-prompt.ts`.
- **Chave de storage:** a string `veludo:roteiros` (e `veludo:queue`, `veludo:tabs`) — **nunca** renomear
  (quebra a biblioteca do usuário).
- **Scrub de env `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL` vazias** — remover reintroduz 401 no OAuth.
- **Boundary de cache** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` em `lib/claude.ts`.
- **Identificadores cross-runtime:** env vars `MYSTORIESLENA_*`, rota `/api/health`, nomes em
  `window.mystorieslena` (preload ↔ renderer).
- **Regras do clone-lab** (MEMORY): nunca promover branch lab pra produção; só chore/sanitização.
- **Faixas de word-count por categoria** (`lib/parse-estrutura-targets.ts` e prompts de estrutura) —
  são regra de negócio, não número mágico solto.

## ⚠️ DISTINÇÃO lixo-vs-feature (a parte mais perigosa)

"Untracked" **não** quer dizer "descartável". Antes de deletar um arquivo só por estar untracked:
cruze com o CLAUDE.md e com `grep` de imports. Se algo importa o arquivo, é feature. Lixo de teste
real (e2e PNGs, `tmp-*`, `tmp-export/`, scratch `.txt`) não é importado por ninguém.
