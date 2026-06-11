/**
 * MyStoriesLena — Main process do Electron.
 *
 * MODOS DE EXECUÇÃO (em ordem de prioridade):
 *
 *  1. NEXT_DEV_URL setado → conecta no dev server externo (npm run electron:dev)
 *  2. MYSTORIESLENA_SOURCE_DIR setado e válido → "modo LIVE": roda Next dev a
 *     partir da pasta-fonte do projeto. Útil pro autor: edita o código aqui no
 *     Claude e basta fechar/abrir o app pra ver as mudanças. Sem reinstalar,
 *     sem build manual.
 *  3. App empacotado → roda o standalone bundle do .next (modo padrão pros
 *     colegas que recebem o instalador).
 */

const electronApi = require("electron");
const { BrowserWindow, ipcMain, shell, dialog } = electronApi;
const app = electronApi.app;

// Se o shell pai tinha ELECTRON_RUN_AS_NODE setado, o binario Electron
// inicializou como Node puro (sem APIs de janela) antes do JS rodar — nao
// da pra recuperar disso aqui. Detectamos cedo e damos uma mensagem util
// em vez do TypeError opaco "Cannot read properties of undefined".
//
// Esse cenario aparece quando o ambiente do Claude Code (e alguns shells de
// CI) deixa essa env var herdada. O fix permanente eh limpar antes de
// invocar o Electron — ver script `electron:dev` no package.json (que ja
// forca `ELECTRON_RUN_AS_NODE=` na invocacao).
if (!app) {
  process.stderr.write(
    "\n[boot] ERRO FATAL: Electron iniciou em modo Node puro.\n" +
      "  Causa provavel: ELECTRON_RUN_AS_NODE setado no ambiente do shell pai.\n" +
      "  Limpe a env var antes de rodar o app:\n" +
      "    PowerShell:  Remove-Item Env:\\ELECTRON_RUN_AS_NODE\n" +
      "    CMD:         set ELECTRON_RUN_AS_NODE=\n" +
      "    Mac/Linux:   unset ELECTRON_RUN_AS_NODE\n\n",
  );
  process.exit(1);
}

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");

let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch {
  autoUpdater = null;
}

// Logger persistente. Escreve em:
//   Windows: %USERPROFILE%\AppData\Roaming\MyStoriesLena\logs\main.log
//   macOS:   ~/Library/Logs/MyStoriesLena/main.log
// Sem isso, tela branca em prod era impossivel de debugar — usuaria nao
// tinha nada pra mandar.
let log;
try {
  log = require("electron-log/main");
  log.initialize();
  log.transports.file.level = "info";
  log.transports.file.maxSize = 5 * 1024 * 1024;
  // Faz console.log/error/warn no main escrever no arquivo tambem.
  Object.assign(console, log.functions);
} catch (e) {
  // Fallback: se electron-log nao existe (dev sem npm install), usa console
  // padrao. App ainda funciona, so nao tem logs persistentes.
  log = { info: console.log, warn: console.warn, error: console.error };
  console.warn("[boot] electron-log indisponivel:", e?.message || e);
}

// Sem isso, qualquer throw assincrono no main process derrubava o app
// silenciosamente — usuaria so via a janela morrer sem nenhuma pista no log.
process.on("uncaughtException", (e) => {
  try { log.error("[uncaught]", e); } catch { /* log indisponivel */ }
});
process.on("unhandledRejection", (e) => {
  try { log.error("[unhandled-rejection]", e); } catch { /* log indisponivel */ }
});

// Logs verbosos so saem em dev ou se MYSTORIESLENA_DEBUG estiver setado. Em
// packaged build, prints no boot + cada chunk do server enchiam o pipe stderr
// e o main.log; em sistemas mais lentos isso bloqueava I/O e contribuia pra
// travamentos. Erros reais (console.error) seguem indo sempre.
const DEBUG_VERBOSE = !app.isPackaged || !!process.env.MYSTORIESLENA_DEBUG;
function verbose(...args) {
  if (DEBUG_VERBOSE) console.log(...args);
}

// Renderer com heap default ~1.5-2GB estoura em batches longos de Escrita
// (streaming acumula strings + history + imagem inline). 8GB é folga extra
// pra cenários de pior caso: vários roteiros no localStorage + imagem inline
// pesada + history de 20 snapshots/step. Precisa estar setado antes de
// app.whenReady().
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=8192");

const isDev = !!process.env.NEXT_DEV_URL;
const DEV_URL = process.env.NEXT_DEV_URL || "";

let mainWindow = null;
let serverProc = null;
let appUrl = null;
let runtimeMode = "packaged";
// Watchdog do server packaged: se o `node server.js` morrer durante uso normal
// (OOM, exception nao tratada), tentamos respawnar antes de mostrar erro.
let serverRestartCount = 0;
let serverIsRespawning = false;
const MAX_SERVER_RESTARTS = 3;
const SERVER_RESTART_BACKOFF_MS = [1000, 3000, 7000];

// === Buffer de logs do servidor interno ====================================
// Sem isso, stdout/stderr do `next dev` (LIVE) ou `node server.js` (PACKAGED)
// iam pra process.stdout.write direto e sumiam em app empacotado. Resultado:
// quando o boot dava timeout, o usuario via "reinstale o app" sem nenhuma
// pista do que aconteceu. Agora mantemos as ultimas N linhas em memoria (pra
// mostrar no loading screen e no dialogo de erro) e tambem escrevemos em
// arquivo dedicado pra post-mortem.
const SERVER_LOG_RING_MAX = 200;
const serverLogRing = [];
let serverLogFileStream = null;
let serverLogFilePath = null;

function getServerLogPath() {
  if (serverLogFilePath) return serverLogFilePath;
  try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    serverLogFilePath = path.join(dir, "next-server.log");
  } catch {
    serverLogFilePath = path.join(os.tmpdir(), "mystorieslena-next-server.log");
  }
  return serverLogFilePath;
}

function appendServerLog(prefix, chunk) {
  const text = String(chunk);
  // Quebra em linhas pra ring buffer (cada linha vira entry separada).
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const stamped = `${new Date().toISOString().slice(11, 19)} ${prefix} ${line}`;
    serverLogRing.push(stamped);
    if (serverLogRing.length > SERVER_LOG_RING_MAX) {
      serverLogRing.shift();
    }
  }
  // Escreve no arquivo (best-effort, sem await — se falhar, continua sem o arquivo).
  try {
    if (!serverLogFileStream) {
      serverLogFileStream = fs.createWriteStream(getServerLogPath(), { flags: "a" });
      serverLogFileStream.on("error", () => {
        serverLogFileStream = null;
      });
    }
    serverLogFileStream.write(text);
  } catch { /* ignore */ }
  // Tambem manda pro electron-log pra ficar no main.log — so em dev/debug.
  // Em packaged build, o arquivo dedicado (next-server.log) ja tem tudo;
  // duplicar no main.log a cada chunk de stream do servidor era hot-path
  // de I/O que contribuia pra lag em sistemas mais lentos.
  if (DEBUG_VERBOSE) {
    log.info(prefix, text.replace(/\n+$/, ""));
  }
}

function getServerLogTail(n = 30) {
  const start = Math.max(0, serverLogRing.length - n);
  return serverLogRing.slice(start).join("\n");
}

function findFreePort(start = 17310) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => tryPort(p + 1));
      srv.listen(p, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    };
    tryPort(start);
  });
}

/**
 * Detecta a pasta-fonte do projeto. Se MYSTORIESLENA_SOURCE_DIR estiver
 * definida e for uma pasta de projeto Next válida (com package.json + node_modules
 * + next instalado), retorna o caminho. Caso contrário, retorna null.
 */
function detectSourceDir() {
  const envPath = process.env.MYSTORIESLENA_SOURCE_DIR;
  if (!envPath) return null;
  if (!fs.existsSync(envPath)) {
    console.warn(
      `[live] MYSTORIESLENA_SOURCE_DIR aponta pra ${envPath} mas a pasta não existe.`,
    );
    return null;
  }
  const pkgPath = path.join(envPath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.warn(
      `[live] MYSTORIESLENA_SOURCE_DIR=${envPath} não tem package.json — modo LIVE desativado.`,
    );
    return null;
  }
  const nextBin = path.join(envPath, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) {
    console.warn(
      `[live] node_modules/next não encontrado em ${envPath}. Rode "npm install" — modo LIVE desativado.`,
    );
    return null;
  }
  return envPath;
}

function getResourcesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app");
  }
  return path.join(__dirname, "..", ".next", "standalone");
}

/**
 * Resolve o caminho do binário claude (nativo usado pelo Claude Agent SDK).
 * O nome do pacote e a extensão variam por plataforma:
 *   win32-x64    → claude-agent-sdk-win32-x64/claude.exe
 *   darwin-arm64 → claude-agent-sdk-darwin-arm64/claude
 *   darwin-x64   → claude-agent-sdk-darwin-x64/claude
 *   linux-x64    → claude-agent-sdk-linux-x64/claude
 */
function getClaudeExecutablePath(sourceDir) {
  const platform = process.platform; // "win32" | "darwin" | "linux"
  const arch = process.arch; // "x64" | "arm64"
  const platArch = `${platform}-${arch}`;
  const exe = platform === "win32" ? "claude.exe" : "claude";

  const subPaths = [
    `node_modules/@anthropic-ai/claude-agent-sdk-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-${platArch}/${exe}`,
    `node_modules/@anthropic-ai/claude-code/bin/${exe}`,
  ];

  const roots = [];
  if (sourceDir) roots.push(sourceDir);
  if (app.isPackaged) {
    // Onde electron-builder pode auto-unpack binarios nativos (raro com nosso
    // files config, mas inofensivo).
    roots.push(path.join(process.resourcesPath, "app.asar.unpacked"));
    // Onde extraResources copia .next/standalone + node_modules tracado.
    // Os subPaths comecam com "node_modules/", entao a raiz NAO inclui isso
    // (bug fixed: antes tinha "app/node_modules", duplicando o segmento).
    roots.push(path.join(process.resourcesPath, "app"));
  } else {
    roots.push(path.join(__dirname, ".."));
  }

  // NOTA: a lista de subPaths está duplicada em lib/claude.ts (fallback
  // runtime). Se mexer aqui, mexa lá também. main.js é CommonJS, lib/ é
  // TS/ESM — bridge custaria mais que duplicar 5 linhas.
  const candidates = [];
  let found = null;
  for (const root of roots) {
    for (const sub of subPaths) {
      const full = path.join(root, sub);
      const exists = fs.existsSync(full);
      candidates.push({ full, exists });
      if (exists && !found) found = full;
    }
  }

  verbose(`[claude] testando ${candidates.length} candidatos do binário native:`);
  for (const c of candidates) {
    verbose(`  ${c.exists ? "✓" : "✗"} ${c.full}`);
  }
  return found;
}

/**
 * Restaura permissao de execucao + remove quarentena do binario claude no Mac/Linux.
 *
 * Por que: arquivos copiados via extraResources pra .app/Contents/Resources/ no
 * Mac as vezes saem sem flag de execucao apos extract do .dmg, ou ficam com
 * atributo com.apple.quarantine herdado do download. O resultado e EACCES ao
 * spawnar — afeta tanto o fluxo de "Conectar conta Claude" quanto a geracao de
 * roteiro (que tambem spawna o binario). Antes, esse reparo so rodava DENTRO do
 * shell script de setup; agora roda no boot, garantindo que qualquer caminho
 * que tente executar o binario funcione.
 *
 * No Windows nao precisa — claude.exe roda sem flag especial.
 */
function prepareNativeBinary(claudeExe) {
  if (!claudeExe || process.platform === "win32") return;
  try {
    fs.chmodSync(claudeExe, 0o755);
    console.log(`[claude] chmod +x aplicado em ${claudeExe}`);
  } catch (e) {
    console.warn(`[claude] chmod falhou (best-effort): ${e?.message || e}`);
  }
  if (process.platform === "darwin") {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("xattr", ["-d", "com.apple.quarantine", claudeExe], {
        stdio: "ignore",
      });
      console.log(`[claude] xattr quarantine removido de ${claudeExe}`);
    } catch {
      // E esperado falhar quando o atributo nao existe — silencioso.
    }
  }
}

/**
 * Mata processos `next dev` orfaos cujo cwd bate com sourceDir.
 *
 * Por que: em modo LIVE, o spawn eh detached:true (pra Turbopack workers nao
 * abrirem console no Windows). Se o app crasha sem rodar before-quit (OOM
 * do main, force-kill via Task Manager, etc), o `next dev` fica orfao
 * segurando a porta + .next/cache locks. No proximo boot, findFreePort acha
 * outra porta, mas o orfao continua compilando em background, comendo RAM e
 * travando file-watcher do Turbopack do novo processo.
 *
 * Best-effort: roda com timeout curto, log warning se falhar, NUNCA bloqueia
 * o boot. Em Windows usa CIM (PowerShell). Em Mac/Linux usa pgrep + cwd check.
 */
function killOrphanNextDev(sourceDir) {
  if (!sourceDir) return;
  try {
    if (process.platform === "win32") {
      const { execFileSync } = require("child_process");
      // Escapa aspas simples no path pra Where-Object — sourceDir vem do
      // env, mas nunca confiamos cegamente em path do usuario num shell.
      const safeDir = sourceDir.replace(/'/g, "''");
      // NOTA: nao filtramos por Name='node.exe' porque em LIVE/packaged o
      // child spawnado com ELECTRON_RUN_AS_NODE herda o nome do executavel
      // Electron (MyStoriesLena.exe). O match por command line ja eh
      // restritivo o suficiente — exige "next", "dev" E o sourceDir todos
      // presentes na linha de comando.
      const cmd =
        "$ErrorActionPreference='SilentlyContinue';" +
        "$killed=0;" +
        "Get-CimInstance Win32_Process | " +
        `Where-Object { $_.CommandLine -like '*next*' -and $_.CommandLine -like '*dev*' -and $_.CommandLine -like '*${safeDir.replace(/\\/g, "\\\\")}*' -and $_.ProcessId -ne ${process.pid} } | ` +
        `ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; $killed++ } catch {} };` +
        "Write-Host \"killed=$killed\"";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], {
        windowsHide: true,
        timeout: 8000,
        encoding: "utf-8",
      });
      const m = /killed=(\d+)/.exec(String(out));
      const n = m ? parseInt(m[1], 10) : 0;
      if (n > 0) {
        console.log(`[boot] killed ${n} orphan next dev process(es)`);
      }
    } else {
      // Mac/Linux: pgrep -af "next dev" lista candidatos; depois pra cada
      // PID lemos o cwd via /proc (Linux) ou lsof (Mac) e comparamos.
      const { execSync } = require("child_process");
      const isLinux = process.platform === "linux";
      const cwdCmd = isLinux
        ? "readlink /proc/$pid/cwd 2>/dev/null"
        : "lsof -p $pid -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0,2); exit }'";
      const safeDir = sourceDir.replace(/"/g, '\\"');
      const script =
        `pgrep -af "next.*dev" 2>/dev/null | awk '{print $1}' | while read pid; do ` +
        `cwd="$(${cwdCmd})"; ` +
        `if [ "$cwd" = "${safeDir}" ]; then kill -9 "$pid" 2>/dev/null; echo "killed:$pid"; fi; ` +
        `done`;
      const out = execSync(script, {
        shell: "/bin/bash",
        timeout: 8000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const n = (String(out).match(/killed:/g) || []).length;
      if (n > 0) {
        console.log(`[boot] killed ${n} orphan next dev process(es)`);
      }
    }
  } catch (e) {
    console.warn("[boot] killOrphanNextDev falhou (best-effort):", e?.message || e);
  }
}

/**
 * Modo LIVE: spawn `next dev` a partir da pasta-fonte. Mudanças no código
 * aparecem na próxima abertura do app — basta fechar e abrir.
 */
async function startServerFromSource(sourceDir) {
  killOrphanNextDev(sourceDir);
  const port = await findFreePort();
  const nextBin = path.join(
    sourceDir,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );

  const env = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "development",
    ELECTRON_RUN_AS_NODE: "1",
    // Desativa banner de telemetria do Next.
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (env.ANTHROPIC_API_KEY === "") delete env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_AUTH_TOKEN === "") delete env.ANTHROPIC_AUTH_TOKEN;
  if (env.ANTHROPIC_BASE_URL === "") delete env.ANTHROPIC_BASE_URL;
  // Diz ao server Next onde gravar o usage.jsonl (log de consumo de tokens) —
  // mesma pasta do perf.jsonl (userData/metrics). Sem isso o lib/usage-log cai
  // num fallback em tmp. Só observabilidade.
  env.MYSTORIESLENA_METRICS_DIR = path.join(
    app.getPath("userData"),
    "metrics",
  );

  const claudeExe = getClaudeExecutablePath(sourceDir);
  if (claudeExe) {
    prepareNativeBinary(claudeExe);
    env.MYSTORIESLENA_CLAUDE_EXEC = claudeExe;
    console.log(`[claude] usando binário em: ${claudeExe}`);
  }

  console.log(`[live] iniciando Next dev a partir de ${sourceDir} na porta ${port}`);

  // detached:true + windowsHide:true juntos garantem que NEM os workers
  // do Turbopack (que rodam em sub-processos) abram console no Windows.
  // Sem detached, o grandchild herda a falta de console do parent mas
  // pode forçar um novo — que é o que estava acontecendo.
  serverProc = spawn(
    process.execPath,
    [nextBin, "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: sourceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    },
  );
  serverProc.lastActivityMs = Date.now();

  serverProc.stdout.on("data", (d) => {
    serverProc.lastActivityMs = Date.now();
    appendServerLog("[next]", d);
  });
  serverProc.stderr.on("data", (d) => {
    serverProc.lastActivityMs = Date.now();
    appendServerLog("[next:err]", d);
  });
  serverProc.on("exit", (code) => {
    console.log(`[next] exited code=${code}`);
    appendServerLog("[next]", `\nProcess exited with code=${code}\n`);
    serverProc = null;
  });

  return `http://127.0.0.1:${port}`;
}

/**
 * Modo padrão: roda o standalone bundle empacotado.
 */
async function startServerPackaged() {
  const port = await findFreePort();
  const resourcesPath = getResourcesPath();
  const serverEntry = path.join(resourcesPath, "server.js");

  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `server.js não encontrado em ${serverEntry}. Rode "npm run build" antes.`,
    );
  }

  const env = {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (env.ANTHROPIC_API_KEY === "") delete env.ANTHROPIC_API_KEY;
  if (env.ANTHROPIC_AUTH_TOKEN === "") delete env.ANTHROPIC_AUTH_TOKEN;
  if (env.ANTHROPIC_BASE_URL === "") delete env.ANTHROPIC_BASE_URL;
  // Diz ao server Next onde gravar o usage.jsonl (log de consumo de tokens) —
  // mesma pasta do perf.jsonl (userData/metrics). Sem isso o lib/usage-log cai
  // num fallback em tmp. Só observabilidade.
  env.MYSTORIESLENA_METRICS_DIR = path.join(
    app.getPath("userData"),
    "metrics",
  );

  const claudeExe = getClaudeExecutablePath(null);
  if (claudeExe) {
    prepareNativeBinary(claudeExe);
    env.MYSTORIESLENA_CLAUDE_EXEC = claudeExe;
    console.log(`[claude] usando binário em: ${claudeExe}`);
  } else {
    console.warn(
      "[claude] binário claude.exe não encontrado nos caminhos esperados.",
    );
  }

  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: resourcesPath,
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  serverProc.lastActivityMs = Date.now();

  serverProc.stdout.on("data", (d) => {
    serverProc.lastActivityMs = Date.now();
    appendServerLog("[server]", d);
  });
  serverProc.stderr.on("data", (d) => {
    serverProc.lastActivityMs = Date.now();
    appendServerLog("[server:err]", d);
  });
  serverProc.on("exit", (code) => {
    console.log(`[next] exited code=${code}`);
    appendServerLog("[server]", `\nProcess exited with code=${code}\n`);
    serverProc = null;
    // Watchdog: se a janela ainda esta aberta e o exit foi anormal, tenta
    // respawnar. Sem isso, qualquer crash do server (OOM, exception nao
    // tratada) deixa a UI em tela branca permanente porque http://localhost:port
    // para de responder.
    if (
      code !== 0 &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !app.isQuitting &&
      !serverIsRespawning
    ) {
      void respawnServer();
    }
  });

  return `http://127.0.0.1:${port}`;
}

/**
 * Restart do server packaged apos crash. Tenta ate MAX_SERVER_RESTARTS vezes
 * com backoff exponencial. Quando consegue subir, recarrega a janela.
 * Se esgotar tentativas, mostra dialog pedindo pra reabrir o app.
 */
async function respawnServer() {
  if (serverIsRespawning) return;
  serverIsRespawning = true;
  try {
    while (serverRestartCount < MAX_SERVER_RESTARTS) {
      const attempt = serverRestartCount + 1;
      const backoff = SERVER_RESTART_BACKOFF_MS[serverRestartCount] ?? 7000;
      console.warn(`[watchdog] tentativa ${attempt}/${MAX_SERVER_RESTARTS} de respawn em ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      serverRestartCount += 1;
      try {
        appUrl = await startServerPackaged();
        await waitForHealth(appUrl, 30000, makeLivenessProbe(serverProc));
        console.log(`[watchdog] server respondeu em ${appUrl}, recarregando janela`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(appUrl);
        }
        // Sucesso — reseta contador pra que um proximo crash tenha 3 chances de novo.
        serverRestartCount = 0;
        return;
      } catch (e) {
        console.error(`[watchdog] tentativa ${attempt} falhou:`, e?.message || e);
      }
    }
    // Esgotou as tentativas.
    if (mainWindow && !mainWindow.isDestroyed()) {
      const r = await dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "MyStoriesLena travou",
        message: "Não consegui recuperar o servidor interno após várias tentativas.",
        detail:
          "Reabra o aplicativo. Se o problema persistir, abra a pasta de logs (menu Ajuda) e mande pra gente.",
        buttons: ["Sair"],
      });
      if (r.response === 0) app.quit();
    }
  } finally {
    serverIsRespawning = false;
  }
}

/**
 * Polling em /api/health ate o servidor subir ou estourar o deadline.
 *
 * @param {string} baseUrl
 * @param {number} timeoutMs deadline inicial — pode ser estendido se o
 *   livenessProbe indicar que o servidor esta vivo e ativamente fazendo coisa
 *   (compilando, p.ex.). Cap absoluto eh 2x o timeoutMs.
 * @param {() => { exitCode: number | null, lastActivityMs: number } | null} livenessProbe
 *   opcional — se retornar exitCode != null, falha imediatamente (servidor
 *   morreu, nao adianta esperar). Se atividade recente (<5s), estende deadline.
 */
function waitForHealth(baseUrl, timeoutMs = 60000, livenessProbe = null) {
  let deadline = Date.now() + timeoutMs;
  const maxDeadline = Date.now() + timeoutMs * 2;
  return new Promise((resolve, reject) => {
    const tick = () => {
      // Liveness check: se o processo morreu, falha agora em vez de esperar
      // o deadline inteiro retornando ECONNREFUSED.
      if (livenessProbe) {
        const probe = livenessProbe();
        if (probe && probe.exitCode != null) {
          reject(new Error(`Servidor morreu durante boot (exit=${probe.exitCode})`));
          return;
        }
        // Estende deadline se prestes a estourar mas o servidor logou algo
        // recente (provavelmente Turbopack ainda compilando). Cap em 2x o
        // timeout original — sem cap, um servidor preso em loop de log iria
        // travar a janela infinitamente.
        if (
          probe &&
          Date.now() > deadline - 5000 &&
          Date.now() - probe.lastActivityMs < 5000 &&
          deadline < maxDeadline
        ) {
          deadline = Math.min(Date.now() + 30000, maxDeadline);
        }
      }
      const req = http.get(`${baseUrl}/api/health`, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
        } else {
          res.resume();
          if (Date.now() > deadline) {
            reject(new Error(`/api/health respondeu ${res.statusCode}`));
          } else {
            setTimeout(tick, 400);
          }
        }
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Timeout aguardando o servidor subir"));
        } else {
          setTimeout(tick, 400);
        }
      });
      req.setTimeout(3000, () => req.destroy());
    };
    tick();
  });
}

function makeLivenessProbe(proc) {
  return () => ({
    exitCode: proc?.exitCode ?? null,
    lastActivityMs: proc?.lastActivityMs ?? Date.now(),
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0c0a0a",
    show: true,
    icon: path.join(
      __dirname,
      "icons",
      process.platform === "win32"
        ? "icon.ico"
        : process.platform === "darwin"
          ? "icon.icns"
          : "icon.png",
    ),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.js"),
      // Spellcheck do Chromium é o gargalo dominante de digitação em
      // textareas grandes (resumo da Premissa, edição de capítulo). A cada
      // keystroke ele reanalisa a palavra atual + redesenha os sublinhados
      // ondulados — no Windows isso é especialmente pesado (DirectWrite +
      // possível interferência do Defender escaneando o dicionário). Romance
      // tem nomes próprios, gírias e palavras inventadas — os sublinhados
      // vermelhos eram mais ruído que ajuda. Desabilitar é o fix definitivo
      // pra "lentidão ao digitar".
      spellcheck: false,
    },
  });

  // Mostra a tela de loading IMEDIATAMENTE — uma só janela.
  // Em modo LIVE adiciona um query param pra UI mostrar mensagem específica.
  const loadingPath = path.join(__dirname, "loading.html");
  const fileUrl = `file:///${loadingPath.replace(/\\/g, "/")}`;
  mainWindow.loadURL(`${fileUrl}?mode=${runtimeMode}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // No app empacotado, bloqueia TODOS os atalhos que abrem DevTools (F12,
  // Ctrl+Shift+I/J/C, Cmd+Opt+I/J/C). A roteirista não é desenvolvedora —
  // DevTools aparecendo (seja por crash anterior, atalho acidental ou menu
  // View → Toggle Developer Tools) só causa confusão. Em dev/live mode
  // mantém liberado pra debug do autor.
  if (app.isPackaged && runtimeMode === "packaged") {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const k = (input.key || "").toLowerCase();
      const isF12 = k === "f12";
      const isCtrlShiftDevKey =
        input.control && input.shift && (k === "i" || k === "j" || k === "c");
      const isMacDevKey =
        input.meta && input.alt && (k === "i" || k === "j" || k === "c");
      if (isF12 || isCtrlShiftDevKey || isMacDevKey) {
        event.preventDefault();
      }
    });
    // Belt-and-suspenders: se algum caminho ainda chamar openDevTools (ex:
    // hook de extensão, código futuro), fechamos imediatamente. Nunca deixa
    // DevTools visível pra roteirista no app empacotado.
    mainWindow.webContents.on("devtools-opened", () => {
      try {
        mainWindow.webContents.closeDevTools();
      } catch {
        // ignore
      }
    });
  }

  // Crash handlers: sem isso, quando o renderer morre (OOM, exception fatal)
  // ou o load falha (server caiu), a janela fica branca silenciosamente.
  //
  // Política: SEMPRE silent-reload, NUNCA abrir DevTools. A roteirista não
  // é desenvolvedora — DevTools aparecendo é confusão pura. Damos até 5
  // tentativas silenciosas em 60s; só depois disso mostramos um diálogo
  // amigável Recarregar/Sair (sem DevTools junto).
  const MAX_SILENT_RELOADS = 5;
  let crashCount = 0;
  let lastCrashAt = 0;
  let crashResetTimer = null;

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[crash] render-process-gone:", JSON.stringify(details));
    const now = Date.now();
    if (now - lastCrashAt > 60_000) crashCount = 0;
    lastCrashAt = now;
    crashCount++;

    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (crashCount <= MAX_SILENT_RELOADS && appUrl) {
      console.warn(
        `[crash] auto-reload silencioso (queda ${crashCount}/${MAX_SILENT_RELOADS} em 60s)`,
      );
      // Backoff modesto: 1ª queda 500ms; depois cresce ligeiramente pra dar
      // tempo do que estava em flight terminar de liberar memória.
      const delay = Math.min(500 + (crashCount - 1) * 700, 3000);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(appUrl);
      }, delay);
      return;
    }

    // Estourou o limite de reloads silenciosos — algo está sistematicamente
    // quebrando. Aí sim mostramos diálogo amigável (sem DevTools). NUNCA
    // chamar openDevTools aqui: a roteirista não usa DevTools e a janela
    // dele assustando ela já causou ruído suficiente.
    dialog
      .showMessageBox(mainWindow, {
        type: "error",
        title: "MyStoriesLena travou",
        message: "Ocorreu um erro interno na interface.",
        detail: `Tentei recarregar ${MAX_SILENT_RELOADS} vezes mas continua quebrando. Posso tentar mais uma, ou você pode fechar e abrir o app de novo (seus roteiros estão salvos).`,
        buttons: ["Recarregar", "Fechar app"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((r) => {
        if (r.response === 0 && appUrl && mainWindow && !mainWindow.isDestroyed()) {
          // Reset do contador — ela escolheu tentar de novo, dá folga total.
          crashCount = 0;
          mainWindow.loadURL(appUrl);
        } else {
          app.quit();
        }
      })
      .catch(() => {
        // Dialog falhou — best effort: tenta reload mesmo assim.
        if (mainWindow && !mainWindow.isDestroyed() && appUrl) {
          mainWindow.loadURL(appUrl);
        }
      });
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (crashResetTimer) clearTimeout(crashResetTimer);
    crashResetTimer = setTimeout(() => {
      crashCount = 0;
    }, 30_000);
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    // Ignora canceled (usuario navegou pra outra coisa antes da load terminar)
    // e o load inicial do loading.html (file:// pode falhar em alguns cenarios).
    if (code === -3) return; // ABORTED
    console.warn(`[load] did-fail-load code=${code} desc=${desc} url=${url}`);
    // -102 = CONNECTION_REFUSED — server pode estar reinicializando. Tenta de novo.
    if (code === -102 && appUrl && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(appUrl);
      }, 1500);
    }
  });

  // Sem prompt, GC longo / freeze ficavam invisíveis pra usuária — ela só via
  // a janela "morta" e tentava forçar o fechamento. Damos a opção de reload
  // depois do renderer ficar bloqueado por uma janela bem larga.
  //
  // Por que 30s aqui (somados aos ~30s que o Chromium já espera antes de
  // emitir `unresponsive`): durante geração streaming, GC longos ou jobs
  // pesados podem freezear o renderer por mais de 10s sem que ele esteja
  // realmente travado — e mostrar o dialog no meio de uma geração faz a
  // roteirista apertar "Recarregar" e perder o que estava sendo gerado.
  // Com 30s o `responsive` quase sempre tem chance de cancelar antes.
  let unresponsiveTimer = null;
  let unresponsiveAt = 0;
  mainWindow.on("unresponsive", () => {
    unresponsiveAt = Date.now();
    console.warn("[window] janela unresponsive");
    if (unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        unresponsiveTimer = null;
        return;
      }
      const blockedSec = Math.floor((Date.now() - unresponsiveAt) / 1000);
      console.warn(`[window] mostrando dialog de unresponsive (~${blockedSec}s sem resposta)`);
      dialog
        .showMessageBox(mainWindow, {
          type: "warning",
          title: "MyStoriesLena travou",
          message: "A janela parou de responder.",
          detail:
            "Posso forçar um reload? Você pode perder o que estava sendo gerado agora, mas os roteiros já salvos ficam intactos.",
          buttons: ["Recarregar", "Esperar mais"],
          defaultId: 1,
          cancelId: 1,
        })
        .then((r) => {
          unresponsiveTimer = null;
          if (
            r.response === 0 &&
            appUrl &&
            mainWindow &&
            !mainWindow.isDestroyed()
          ) {
            mainWindow.loadURL(appUrl);
          }
        })
        .catch(() => {
          unresponsiveTimer = null;
        });
    }, 30_000);
  });

  mainWindow.on("responsive", () => {
    if (unresponsiveTimer) {
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Mata o serverProc atual (best-effort), incluindo a arvore de filhos.
 * Usado em retries de boot e tambem em before-quit. Nao zera serverProc —
 * o handler "exit" do spawn faz isso.
 */
function killServerTree() {
  if (!serverProc || serverProc.killed) return;
  try {
    if (process.platform === "win32") {
      const { execSync } = require("child_process");
      execSync(`taskkill /pid ${serverProc.pid} /T /F`, { windowsHide: true });
    } else {
      try {
        process.kill(-serverProc.pid, "SIGTERM");
      } catch {
        serverProc.kill();
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Dialogo de erro mode-aware com botoes de acao reais.
 *
 * LIVE: mensagem tecnica + tail dos logs + botao que limpa .next/cache.
 * PACKAGED: mensagem amigavel + botao "Tentar de novo" (sem mexer em arquivos).
 *
 * O botao "Abrir log" abre o arquivo no editor padrao e re-mostra o dialogo
 * (usuario continua precisando escolher entre tentar/sair).
 */
async function showBootFailureDialog(err, mode, sourceDir) {
  const logPath = getServerLogPath();
  const tail = getServerLogTail(30);

  let title;
  let message;
  let detail;
  let buttons;
  if (mode === "live") {
    title = "Modo LIVE — falha do dev server";
    message = `O Next dev nao respondeu a tempo:\n\n${err?.message || err}`;
    detail =
      (tail ? `Ultimas linhas do servidor:\n${tail}\n\n` : "") +
      `Log completo: ${logPath}\n\n` +
      "Causas comuns: cache do Turbopack corrompido, processo orfao segurando recursos, erro de compilacao no codigo fonte.";
    buttons = ["Tentar de novo (limpa .next/cache)", "Abrir log", "Sair"];
  } else {
    title = "Falha ao iniciar o MyStoriesLena";
    message = `O servidor interno nao respondeu:\n\n${err?.message || err}`;
    detail =
      `Log: ${logPath}\n\n` +
      "Tente novamente. Se persistir, reinstale o aplicativo ou entre em contato com o suporte.";
    buttons = ["Tentar de novo", "Abrir log", "Sair"];
  }

  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = {
    type: "error",
    title,
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = target
    ? await dialog.showMessageBox(target, opts)
    : await dialog.showMessageBox(opts);

  const choice = result.response;
  if (choice === 0) {
    // Tentar de novo — em LIVE limpa .next/cache (cirurgico, preserva
    // outras coisas em .next que sejam baratas de regenerar).
    if (mode === "live" && sourceDir) {
      try {
        const cacheDir = path.join(sourceDir, ".next", "cache");
        if (fs.existsSync(cacheDir)) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          console.log(`[boot] limpou ${cacheDir}`);
        }
      } catch (e) {
        console.warn("[boot] falha ao limpar .next/cache:", e?.message || e);
      }
    }
    serverRestartCount = 0;
    void boot();
    return;
  }
  if (choice === 1) {
    // Abrir log e re-mostrar o dialogo — usuario ainda precisa decidir
    // entre tentar/sair, e shell.openPath nao bloqueia.
    try {
      await shell.openPath(logPath);
    } catch { /* ignore */ }
    return showBootFailureDialog(err, mode, sourceDir);
  }
  // Sair
  app.quit();
}

async function boot() {
  // Reentrante: se estamos retentando apos falha, pode haver serverProc
  // morto-vivo (spawn ok mas health check falhou). Limpa antes.
  killServerTree();
  appUrl = null;

  // Decide qual modo usar antes de criar a janela (afeta a tela de loading).
  const sourceDir = detectSourceDir();
  if (isDev) {
    runtimeMode = "external-dev";
  } else if (sourceDir) {
    runtimeMode = "live";
  } else {
    runtimeMode = "packaged";
  }

  // Primeira chamada: cria a janela. Retry: reaproveita a janela existente
  // recarregando o loading.html (preserva position/size/devtools state).
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    const loadingPath = path.join(__dirname, "loading.html");
    const fileUrl = `file:///${loadingPath.replace(/\\/g, "/")}`;
    mainWindow.loadURL(`${fileUrl}?mode=${runtimeMode}`);
  }

  try {
    if (isDev) {
      appUrl = DEV_URL;
      await waitForHealth(appUrl, 15000).catch(() => null);
    } else if (sourceDir) {
      // MODO LIVE: Next dev compila on-demand. Timeout generoso (180s default,
      // overridable via MYSTORIESLENA_BOOT_TIMEOUT_MS) porque o first-build
      // apos crash pode levar minutos com .next/cache parcialmente corrompido.
      // O livenessProbe estende o deadline se Next ainda esta logando — entao
      // 180s eh um piso, nao um teto, ate o cap absoluto de 2x.
      appUrl = await startServerFromSource(sourceDir);
      const liveTimeout =
        Number(process.env.MYSTORIESLENA_BOOT_TIMEOUT_MS) || 180_000;
      await waitForHealth(appUrl, liveTimeout, makeLivenessProbe(serverProc));
    } else {
      // Modo padrão (empacotado).
      appUrl = await startServerPackaged();
      await waitForHealth(appUrl, 60000, makeLivenessProbe(serverProc));
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(appUrl);
    }
  } catch (err) {
    console.error("Falha no boot:", err);
    return showBootFailureDialog(err, runtimeMode, sourceDir);
  }

  if (autoUpdater && app.isPackaged && runtimeMode === "packaged") {
    try {
      const updateConfigPath = path.join(
        process.resourcesPath,
        "app-update.yml",
      );
      let isPlaceholder = false;
      if (fs.existsSync(updateConfigPath)) {
        const cfg = fs.readFileSync(updateConfigPath, "utf-8");
        if (/SEU_USUARIO_GITHUB/i.test(cfg)) isPlaceholder = true;
      }

      if (isPlaceholder) {
        console.log(
          "[updater] desativado — repo GitHub ainda é placeholder no package.json",
        );
      } else {
        // No macOS sem cert Apple Developer pago, o auto-install falha com
        // erro de mismatch de assinatura (cada build ad-hoc tem identidade
        // nova). Em vez de tentar baixar/instalar e dar erro, só verifica
        // disponibilidade — o renderer mostra um botão "Baixar" que abre
        // a página da release no navegador, e o usuário substitui o .app
        // manualmente uma vez. No Windows o NSIS não tem essa restrição
        // e o flow auto continua perfeito.
        const isMacAdhoc =
          process.platform === "darwin" && !process.env.CSC_LINK;
        autoUpdater.autoDownload = !isMacAdhoc;
        autoUpdater.autoInstallOnAppQuit = !isMacAdhoc;
        wireUpdaterEvents();
        // checkForUpdates (sem AndNotify) só verifica — não dispara download
        // automático, então evita o erro feio no Mac.
        autoUpdater.checkForUpdates().catch(() => {});
      }
    } catch (e) {
      console.log("[updater] skipped:", e?.message || e);
    }
  } else if (autoUpdater) {
    // Mesmo em dev/live, preparamos os listeners pra que checagem manual via UI funcione no app empacotado.
    wireUpdaterEvents();
  }

  // Agente de limpeza automática (disco): poda backups antigos + trunca log do
  // servidor ~20s após abrir, fora do caminho crítico de boot.
  scheduleAutoCleanup();
}

/**
 * Registra forwarding de eventos do auto-updater pro renderer process.
 * Chamado uma vez por janela após o webContents estar pronto.
 */
function wireUpdaterEvents() {
  if (!autoUpdater) return;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`updater:${channel}`, payload);
    }
  };

  autoUpdater.removeAllListeners("checking-for-update");
  autoUpdater.removeAllListeners("update-available");
  autoUpdater.removeAllListeners("update-not-available");
  autoUpdater.removeAllListeners("download-progress");
  autoUpdater.removeAllListeners("update-downloaded");
  autoUpdater.removeAllListeners("error");

  autoUpdater.on("checking-for-update", () => send("checking-for-update"));
  autoUpdater.on("update-available", (info) =>
    send("update-available", { version: info?.version }),
  );
  autoUpdater.on("update-not-available", (info) =>
    send("update-not-available", { version: info?.version }),
  );
  autoUpdater.on("download-progress", (p) =>
    send("download-progress", {
      percent: p?.percent ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    send("update-downloaded", { version: info?.version }),
  );
  autoUpdater.on("error", (err) => send("error", { message: String(err?.message || err) }));
}

// IPC handlers — endpoints que o renderer chama via preload.js (window.mystorieslena).

/**
 * Retorna as ultimas N linhas do log do servidor interno + ms decorridos
 * desde o spawn (pra o loading screen mostrar timer real). Se o servidor
 * ainda nao spawnou, retorna tail vazio e elapsedMs=0.
 */
ipcMain.handle("boot:get-log-tail", (_event, n) => {
  const linesRequested = Math.max(1, Math.min(50, Number(n) || 15));
  const tail = getServerLogTail(linesRequested);
  const spawnedAt = serverProc?.lastActivityMs ?? null;
  return {
    tail,
    elapsedMs: spawnedAt ? Date.now() - spawnedAt : 0,
    logPath: getServerLogPath(),
  };
});

ipcMain.handle("runtime:info", () => {
  const isMacAdhoc =
    process.platform === "darwin" && !process.env.CSC_LINK;
  return {
    mode: runtimeMode, // "live" | "packaged" | "external-dev"
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    updaterAvailable: !!autoUpdater && app.isPackaged && runtimeMode === "packaged",
    // No Mac sem cert: "external-download" (renderer mostra botão que abre
    // navegador). Windows/Mac com cert: "auto" (download + install in-app).
    updateMode: isMacAdhoc ? "external-download" : "auto",
  };
});

ipcMain.handle("updater:check", async () => {
  if (!autoUpdater) {
    return { ok: false, reason: "autoUpdater não disponível neste build." };
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      reason: "Atualizações só funcionam no app instalado (não em modo dev/LIVE).",
    };
  }
  if (runtimeMode === "live") {
    return {
      ok: false,
      reason:
        "Modo LIVE ativo — você está lendo direto da pasta de código. Atualizações só funcionam no .exe instalado sem MYSTORIESLENA_SOURCE_DIR.",
    };
  }
  try {
    autoUpdater.autoDownload = false;
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, info: result?.updateInfo ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("updater:download", async () => {
  if (!autoUpdater || !app.isPackaged) {
    return { ok: false, reason: "Updater indisponível." };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("updater:install", () => {
  if (!autoUpdater || !app.isPackaged) return { ok: false };
  // isSilent=false (mostra wizard NSIS), isForceRunAfter=true (reabre depois).
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

/**
 * Abre o navegador padrão na página da release mais recente do repo.
 * Usado em macOS sem cert Apple, onde o auto-install falha por
 * mismatch de assinatura ad-hoc — em vez de quebrar, mostramos um
 * botão "Baixar" que leva o usuário pra GitHub Releases pra ele
 * substituir o .app manualmente uma vez.
 *
 * Lê owner/repo do package.json#build.publish[0] embarcado no app.
 */
ipcMain.handle("updater:open-download-page", () => {
  try {
    // Procura o package.json do app empacotado pra ler publish.owner.
    const candidates = [
      // packaged: process.resourcesPath/app/package.json (extraResources copia).
      path.join(process.resourcesPath, "app", "package.json"),
      // dev: raiz do projeto.
      path.join(__dirname, "..", "package.json"),
    ];
    let owner = null;
    let repo = null;
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
        const pub = Array.isArray(pkg?.build?.publish)
          ? pkg.build.publish[0]
          : pkg?.build?.publish;
        if (pub?.owner && pub?.repo) {
          owner = pub.owner;
          repo = pub.repo;
          break;
        }
      } catch {
        // ignore — tenta próximo
      }
    }
    if (!owner || !repo) {
      return {
        ok: false,
        reason: "Não consegui determinar o repositório de releases.",
      };
    }
    const url = `https://github.com/${owner}/${repo}/releases/latest`;
    shell.openExternal(url);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

/**
 * Abre a pasta de logs no explorer/finder. Usado pelo botao "Abrir pasta de
 * logs" no app, pra usuaria conseguir mandar o log quando reportar bug.
 */
ipcMain.handle("log:open-folder", () => {
  try {
    const logFile = log?.transports?.file?.getFile?.()?.path;
    if (logFile) {
      shell.showItemInFolder(logFile);
      return { ok: true, path: logFile };
    }
    // Fallback: abre o diretorio userData direto.
    const userData = app.getPath("logs");
    shell.openPath(userData);
    return { ok: true, path: userData };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

/**
 * Gera PDF do roteiro a partir de HTML usando printToPDF nativo do Chromium.
 * Mostra dialog pro usuário escolher onde salvar e grava o arquivo.
 */
ipcMain.handle("pdf:save-roteiro", async (_event, payload) => {
  const html = String(payload?.html ?? "");
  const suggestedName = String(payload?.filename ?? "roteiro.pdf");
  const title = String(payload?.title ?? "Roteiro");

  if (!html.trim()) {
    return { ok: false, reason: "HTML vazio." };
  }

  // Janela invisível dedicada à renderização do PDF.
  const pdfWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await pdfWindow.loadURL(dataUrl);
    // Pequena espera pra fontes/CSS aplicarem antes do print.
    await new Promise((r) => setTimeout(r, 300));

    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: {
        marginType: "custom",
        top: 0.6,
        bottom: 0.6,
        left: 0.7,
        right: 0.7,
      },
      preferCSSPageSize: false,
    });

    pdfWindow.destroy();

    const result = await dialog.showSaveDialog({
      title: "Salvar roteiro em PDF",
      defaultPath: suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    fs.writeFileSync(result.filePath, pdfBuffer);
    return { ok: true, path: result.filePath, title };
  } catch (e) {
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
    return { ok: false, reason: String(e?.message || e) };
  }
});

/**
 * Backup/export da biblioteca de roteiros (durabilidade — cópia FORA do
 * localStorage). `roteiros:auto-backup` grava um snapshot rotativo em
 * userData/backups; `roteiros:export` abre dialog "Salvar como".
 */
const BACKUP_KEEP = 5;

function getBackupDir() {
  const dir = path.join(app.getPath("userData"), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Config de backup externo (cópia FORA da máquina). Pequeno JSON em userData,
 * lido/escrito com o mesmo fs síncrono já usado aqui. `externalDir` aponta pra
 * uma pasta sincronizada (OneDrive/Google Drive) — o auto-backup grava lá um
 * arquivo ROLANTE `veludo-roteiros-latest.json` (overwrite), protegendo contra
 * perda da máquina, não só corrupção do localStorage.
 */
function backupConfigFile() {
  return path.join(app.getPath("userData"), "backup-config.json");
}

function readBackupConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(backupConfigFile(), "utf8"));
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function writeBackupConfig(cfg) {
  try {
    fs.writeFileSync(backupConfigFile(), JSON.stringify(cfg), "utf8");
    return true;
  } catch {
    return false;
  }
}

function getExternalBackupDir() {
  const dir = readBackupConfig().externalDir;
  return typeof dir === "string" && dir ? dir : null;
}

ipcMain.handle("roteiros:auto-backup", (_event, payload) => {
  try {
    const data = String(payload?.data ?? "");
    if (!data || data === "[]") return { ok: false, reason: "vazio" };
    const dir = getBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `veludo-roteiros-${stamp}.json`);
    fs.writeFileSync(file, data, "utf8");
    // Poda: mantém só os BACKUP_KEEP mais recentes (nome ISO ordena no tempo).
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("veludo-roteiros-") && f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // best-effort
      }
    }
    // Cópia FORA da máquina: se houver pasta sincronizada configurada, grava um
    // arquivo ROLANTE (overwrite) — mantém o Drive enxuto e sempre atual.
    // Best-effort: se a pasta sumiu (drive desconectado), ignora sem falhar.
    let external = null;
    const extDir = getExternalBackupDir();
    if (extDir) {
      try {
        if (fs.existsSync(extDir)) {
          const extFile = path.join(extDir, "veludo-roteiros-latest.json");
          fs.writeFileSync(extFile, data, "utf8");
          external = extFile;
        }
      } catch {
        // best-effort; não derruba o backup local por causa do externo
      }
    }
    return { ok: true, path: file, external };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("backup:pick-external-dir", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "Escolher pasta de backup externo (OneDrive, Google Drive…)",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { ok: false, canceled: true };
    }
    const dir = result.filePaths[0];
    const cfg = readBackupConfig();
    cfg.externalDir = dir;
    if (!writeBackupConfig(cfg)) {
      return { ok: false, reason: "não foi possível salvar a configuração" };
    }
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("backup:get-external-dir", () => {
  try {
    return { ok: true, dir: getExternalBackupDir() };
  } catch (e) {
    return { ok: false, dir: null, reason: String(e?.message || e) };
  }
});

ipcMain.handle("backup:clear-external-dir", () => {
  try {
    const cfg = readBackupConfig();
    delete cfg.externalDir;
    writeBackupConfig(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("roteiros:list-backups", () => {
  try {
    const dir = getBackupDir();
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("veludo-roteiros-") && f.endsWith(".json"))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, mtimeMs: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, backups };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), backups: [] };
  }
});

ipcMain.handle("roteiros:read-backup", (_event, payload) => {
  try {
    const name = String(payload?.name ?? "");
    // Anti path-traversal: só aceita o basename no padrão esperado.
    if (!/^veludo-roteiros-[\w.-]+\.json$/.test(name)) {
      return { ok: false, reason: "nome inválido" };
    }
    const file = path.join(getBackupDir(), name);
    if (!fs.existsSync(file)) return { ok: false, reason: "não encontrado" };
    return { ok: true, data: fs.readFileSync(file, "utf8") };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("roteiros:export", async (_event, payload) => {
  try {
    const data = String(payload?.data ?? "");
    const suggestedName = String(
      payload?.filename ?? "biblioteca-mystorieslena.json",
    );
    if (!data) return { ok: false, reason: "vazio" };
    const result = await dialog.showSaveDialog({
      title: "Exportar biblioteca",
      defaultPath: suggestedName,
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "Todos", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    fs.writeFileSync(result.filePath, data, "utf8");
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

/**
 * Métricas de throughput da Escrita (perf.jsonl) — observabilidade de
 * velocidade/cota (complementa os evals de qualidade). `metrics:append` anexa
 * uma linha JSON; `metrics:read` devolve as últimas N (mais recente primeiro).
 * Arquivo enxuto: poda pras últimas METRICS_KEEP linhas a cada gravação.
 */
const METRICS_KEEP = 500;

function getMetricsFile() {
  const dir = path.join(app.getPath("userData"), "metrics");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "perf.jsonl");
}

ipcMain.handle("metrics:append", (_event, payload) => {
  try {
    const line = String(payload?.line ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!line) return { ok: false, reason: "vazio" };
    const file = getMetricsFile();
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      // arquivo ainda não existe
    }
    lines.push(line);
    if (lines.length > METRICS_KEEP) {
      lines = lines.slice(lines.length - METRICS_KEEP);
    }
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("metrics:read", (_event, payload) => {
  try {
    const limit = Math.max(1, Math.min(2000, Number(payload?.limit) || 50));
    const file = getMetricsFile();
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
      return { ok: true, records: [] };
    }
    const records = [];
    for (const l of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(l));
      } catch {
        // pula linha corrompida
      }
    }
    records.reverse(); // mais recente primeiro
    return { ok: true, records };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), records: [] };
  }
});

/**
 * Limpeza de cache / arquivos temporários (botão "Limpar cache" + agente
 * automático). Libera espaço e mantém o app leve em máquinas fracas SEM tocar
 * nos roteiros salvos (que moram no localStorage / `Local Storage/leveldb`).
 *
 * ⚠️ SEGURANÇA: o único ponto que poderia apagar roteiros é `clearStorageData`.
 * A allowlist de `storages` é EXPLÍCITA e NUNCA inclui "localstorage"/"indexdb";
 * `clearStorageData` jamais roda sem `storages` (o default apaga tudo).
 */
// Subpastas de cache do Chromium sob userData (regeneram sozinhas). Só MEDIDAS
// aqui — o esvaziamento de fato é via session.clearCache/clearStorageData na
// sessão viva (seguro; não há fs.rm em pasta com lock no Windows). NUNCA inclui
// "Local Storage".
const CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnCache"];

function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // pasta não existe / sem acesso
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) total += dirSizeBytes(full);
      else total += fs.statSync(full).size;
    } catch {
      /* entry sumiu/locked — ignora */
    }
  }
  return total;
}

function getServerLogSizeBytes() {
  try {
    return fs.statSync(getServerLogPath()).size;
  } catch {
    return 0;
  }
}

function measureCacheTargets() {
  const userData = app.getPath("userData");
  let cacheBytes = 0;
  for (const name of CACHE_DIRS) cacheBytes += dirSizeBytes(path.join(userData, name));
  let backupsBytes = 0;
  try {
    const dir = getBackupDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("veludo-roteiros-") && f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      try {
        backupsBytes += fs.statSync(path.join(dir, f)).size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const logsBytes = getServerLogSizeBytes();
  return { cacheBytes, backupsBytes, logsBytes, totalBytes: cacheBytes + backupsBytes + logsBytes };
}

function pruneBackupsBeyond(keep) {
  try {
    const dir = getBackupDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("veludo-roteiros-") && f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* ignore */
  }
}

function truncateServerLog() {
  // Fecha o stream aberto e zera o arquivo; o próximo appendServerLog reabre em
  // append. next-server.log não tem rotação própria, então pode crescer sozinho.
  try {
    serverLogFileStream?.end();
  } catch {
    /* ignore */
  }
  serverLogFileStream = null;
  try {
    const p = getServerLogPath();
    if (fs.existsSync(p)) fs.truncateSync(p, 0);
  } catch {
    /* ignore */
  }
}

ipcMain.handle("cache:get-size", () => {
  try {
    return { ok: true, ...measureCacheTargets() };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), totalBytes: 0 };
  }
});

// Electron pode PENDURAR clearCache/clearStorageData indefinidamente (sem CPU,
// I/O preso) em algumas sessões/máquinas — sem teto, o botão "Limpar cache"
// ficava eterno em "Limpando…". Cada chamada de sessão corre contra um timeout;
// se estourar, seguimos best-effort (as podas de fs SEMPRE rodam) e o botão volta.
const CLEAR_STEP_TIMEOUT_MS = 8000;
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

ipcMain.handle("cache:clear", async () => {
  try {
    const before = measureCacheTargets();
    const ses = mainWindow?.webContents?.session;
    if (ses) {
      // HTTP + Code cache. Best-effort com teto — nunca pendura o botão.
      try {
        await withTimeout(ses.clearCache(), CLEAR_STEP_TIMEOUT_MS, "clearCache");
      } catch (e) {
        console.warn("[cache:clear] clearCache pulado:", e?.message || e);
      }
      // ALLOWLIST EXPLÍCITA — JAMAIS "localstorage"/"indexdb" (roteiros moram lá).
      try {
        await withTimeout(
          ses.clearStorageData({
            storages: ["cachestorage", "serviceworkers", "shadercache"],
          }),
          CLEAR_STEP_TIMEOUT_MS,
          "clearStorageData",
        );
      } catch (e) {
        console.warn("[cache:clear] clearStorageData pulado:", e?.message || e);
      }
    }
    pruneBackupsBeyond(BACKUP_KEEP);
    truncateServerLog();
    const after = measureCacheTargets();
    return {
      ok: true,
      freedBytes: Math.max(0, before.totalBytes - after.totalBytes),
      before: before.totalBytes,
      after: after.totalBytes,
    };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e), freedBytes: 0 };
  }
});

// Agente de limpeza automática (disco) — roda ~20s após o boot, fora do caminho
// crítico de abertura. Silencioso e best-effort. NÃO chama clearCache no boot
// (a página acabou de carregar; limpar HTTP cache aí é desperdício) — isso fica
// pro botão manual. O renderer cuida da poda semanal do localStorage (AutoCleanup).
function runAutoCleanup() {
  try {
    pruneBackupsBeyond(BACKUP_KEEP);
    if (getServerLogSizeBytes() > 5 * 1024 * 1024) truncateServerLog();
    console.log("[cleanup] auto: backups podados + log verificado");
  } catch (e) {
    console.warn("[cleanup] auto falhou:", e?.message || e);
  }
}

let autoCleanupTimer = null;
function scheduleAutoCleanup() {
  if (autoCleanupTimer) return; // não empilha em retries de boot
  autoCleanupTimer = setTimeout(() => {
    autoCleanupTimer = null;
    runAutoCleanup();
  }, 20_000);
}

/**
 * Verifica se o usuário já fez login na conta Claude (Pro/Max).
 *
 * - **Windows / Linux**: o Claude Code CLI guarda o token OAuth em
 *   `~/.claude/.credentials.json` (versões antigas: sem ponto).
 * - **macOS**: a partir do Claude Code CLI 2.x, o token é armazenado no
 *   **Keychain** do sistema, sob o serviço `Claude Code-credentials`. Não
 *   existe arquivo em disco. Para validar, chamamos
 *   `security find-generic-password -s "Claude Code-credentials" -a <user>`.
 *   Esse comando retorna exit code 0 se a entrada existe, sem expor o
 *   conteúdo (precisaria de `-w` pra extrair, que pediria autorização).
 */
function getClaudeAuthStatus() {
  const home = os.homedir();

  if (process.platform === "darwin") {
    try {
      const username = os.userInfo().username;
      // -s = service, -a = account. Sem -w não pede autorização do Keychain
      // — só verifica existência. stdio:"ignore" suprime o output.
      require("child_process").execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-a", username],
        { stdio: "ignore" },
      );
      return { loggedIn: true, credentialsPath: "Keychain: Claude Code-credentials" };
    } catch {
      // exit != 0 = entrada não existe no keychain. Continua pra checar arquivo
      // (caso muito antigo ou Claude CLI configurado de forma não-padrão).
    }
  }

  const candidates = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const stat = fs.statSync(p);
        if (stat.size > 0) {
          return { loggedIn: true, credentialsPath: p };
        }
      } catch {
        // ignore — vai tentar o próximo
      }
    }
  }
  return { loggedIn: false, credentialsPath: null };
}

/**
 * No Windows, o Claude Code CLI exige bash.exe do Git for Windows.
 * Procuramos nos locais conhecidos de instalação. Retorna null se não achar
 * (vai precisar instalar Git for Windows).
 */
function findGitBashPath() {
  if (process.platform !== "win32") return null;
  const home = os.homedir();
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.join(home, "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    path.join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Tenta encontrar via where bash no PATH.
  try {
    const out = require("child_process")
      .execSync("where bash", { encoding: "utf-8", windowsHide: true })
      .toString();
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const l of lines) {
      if (l.toLowerCase().endsWith("bash.exe") && fs.existsSync(l)) return l;
    }
  } catch {
    // not in PATH
  }
  return null;
}

ipcMain.handle("claude:status", () => {
  const auth = getClaudeAuthStatus();
  const sourceDir = detectSourceDir();
  const claudeExe = getClaudeExecutablePath(sourceDir);
  const gitBashPath = findGitBashPath();
  return {
    loggedIn: auth.loggedIn,
    hasBinary: !!claudeExe,
    binaryPath: claudeExe,
    gitBashPath,
    needsGitBash: process.platform === "win32" && !gitBashPath,
  };
});

/**
 * Abre uma janela de terminal externa rodando o `claude` CLI bundleado.
 * O usuário digita /login dentro do REPL → o Claude abre o navegador pra
 * fazer OAuth → token vai pra ~/.claude/.credentials.json. Quando ela
 * fechar o terminal e voltar pro app, o status é atualizado.
 */
ipcMain.handle("claude:setup", () => {
  const sourceDir = detectSourceDir();
  const claudeExe = getClaudeExecutablePath(sourceDir);
  if (!claudeExe) {
    return {
      ok: false,
      reason:
        "Não encontrei o binário claude bundleado. Reinstale o app e tente de novo.",
    };
  }

  try {
    if (process.platform === "win32") {
      // Escreve um .bat temporário que faz tudo num clique:
      //  1. Procura git-bash em paths conhecidos
      //  2. Se nao achar, instala via winget (Windows 10+/11 tem built-in)
      //  3. Re-verifica e roda claude com CLAUDE_CODE_GIT_BASH_PATH setado
      // Tudo no mesmo .bat pra usuaria so apertar 1 botao.
      const batPath = path.join(os.tmpdir(), "mystorieslena-claude-setup.bat");
      const batContent = `@echo off
title MyStoriesLena - Configurar conta Claude
echo.
echo ===== Conectar conta Claude =====
echo.

REM Procura git-bash nos paths conhecidos.
set "GITBASH="
if exist "C:\\Program Files\\Git\\bin\\bash.exe" set "GITBASH=C:\\Program Files\\Git\\bin\\bash.exe"
if not defined GITBASH if exist "C:\\Program Files (x86)\\Git\\bin\\bash.exe" set "GITBASH=C:\\Program Files (x86)\\Git\\bin\\bash.exe"
if not defined GITBASH if exist "%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe" set "GITBASH=%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe"

if not defined GITBASH (
    echo [1/3] Git for Windows nao encontrado. Vou instalar agora via winget.
    echo       Pode pedir confirmacao do Windows - aceite pra continuar.
    echo.
    where winget >nul 2>nul
    if errorlevel 1 (
        echo Winget nao disponivel neste Windows. Abrindo pagina de download manual...
        start https://git-scm.com/download/win
        echo.
        echo Apos instalar Git for Windows, FECHE esta janela e clique
        echo novamente em 'Conectar conta Claude'.
        pause
        exit /b 1
    )
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo Falha no winget. Abrindo pagina de download manual...
        start https://git-scm.com/download/win
        pause
        exit /b 1
    )
    echo.
    echo [1/3] OK - Git for Windows instalado.
    echo.
    REM Re-verifica.
    if exist "C:\\Program Files\\Git\\bin\\bash.exe" set "GITBASH=C:\\Program Files\\Git\\bin\\bash.exe"
    if not defined GITBASH if exist "%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe" set "GITBASH=%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe"
    if not defined GITBASH (
        echo Git instalado mas bash.exe nao foi encontrado nos lugares esperados.
        echo Reinicie o MyStoriesLena e tente de novo.
        pause
        exit /b 1
    )
)

set "CLAUDE_CODE_GIT_BASH_PATH=%GITBASH%"

echo [2/3] Pronto pra logar.
echo.
echo ----------------------------------
echo  AGORA:
echo    1. Digite /login e aperte Enter
echo    2. Faca login no navegador que vai abrir
echo    3. Quando o Claude confirmar o login, digite /quit
echo    4. Volte pro MyStoriesLena e clique em 'Ja loguei'
echo ----------------------------------
echo.

"${claudeExe}"

echo.
echo [3/3] Sessao do Claude encerrada.
echo Volte ao MyStoriesLena e clique em 'Ja loguei - verificar'.
echo Pode fechar esta janela.
pause
`;
      fs.writeFileSync(batPath, batContent, "utf-8");
      spawn("cmd.exe", ["/c", "start", "", batPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
    } else if (process.platform === "darwin") {
      // Mesma estratégia no Mac: shell script temporário.
      const shPath = path.join(os.tmpdir(), "mystorieslena-claude-setup.sh");
      const shContent = [
        "#!/bin/bash",
        "set -u",
        `CLAUDE_BIN="${claudeExe}"`,
        "echo",
        "echo '===== Conectar conta Claude ====='",
        "echo",
        // Defensivo: garante que o binario tem flag de execucao e nao esta
        // em quarentena (pode ter herdado do .dmg mesmo apos xattr -cr na
        // .app, ou se o usuario nao rodou xattr antes de abrir).
        'chmod +x "$CLAUDE_BIN" 2>/dev/null || true',
        'xattr -d com.apple.quarantine "$CLAUDE_BIN" 2>/dev/null || true',
        // Falha ruidosa se o binario nao ficou executavel — sem isso, o claude
        // dava erro EACCES enigmatico e a usuaria nao sabia o que fazer.
        'if [ ! -x "$CLAUDE_BIN" ]; then',
        '  echo "ERRO: binario claude sem permissao de execucao em $CLAUDE_BIN"',
        '  echo "Tente reinstalar o MyStoriesLena."',
        "  read -p 'Pressione Enter pra fechar...'",
        "  exit 1",
        "fi",
        "echo 'AGORA:'",
        "echo '  1. Digite /login e aperte Enter'",
        "echo '  2. Faca login no navegador que vai abrir'",
        "echo '  3. Quando o Claude confirmar o login, digite /quit'",
        "echo '  4. Volte pro MyStoriesLena e clique em Ja loguei'",
        "echo",
        "echo '=================================='",
        "echo",
        '"$CLAUDE_BIN"',
        "echo",
        "echo 'Sessao do Claude encerrada. Volte ao MyStoriesLena e clique em Ja loguei.'",
        "echo 'Pode fechar esta janela.'",
        "",
      ].join("\n");
      fs.writeFileSync(shPath, shContent, { mode: 0o755 });
      // `open -a Terminal <script>` abre Terminal.app executando o script.
      // Trocado de osascript pra evitar prompt de permissao de Automation
      // (que algumas usuarias negam, deixando o setup silenciosamente quebrado).
      const child = spawn("open", ["-a", "Terminal", shPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        console.error("[claude:setup] open -a Terminal falhou:", err);
      });
      child.unref();
    } else {
      // Linux best-effort.
      spawn("x-terminal-emulator", ["-e", claudeExe], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

/**
 * Apaga as credenciais do Claude CLI pra trocar de conta. O CLI não tem
 * comando de logout — a forma oficial é remover ~/.claude/.credentials.json
 * (e o legado sem ponto). Depois disso, o próximo /login no terminal vai
 * pedir OAuth de novo e gravar credenciais da nova conta.
 */
ipcMain.handle("claude:logout", () => {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
  ];
  const removed = [];
  try {
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed.push(p);
      }
    }
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

app.whenReady().then(() => {
  // No macOS, em modo dev (`electron .`), o ícone do Dock por padrão é o do
  // framework Electron (não o do app). O `BrowserWindow.icon` afeta só a
  // janela. Pra ver o ícone customizado também no Dock durante dev, setamos
  // explicitamente via app.dock.setIcon. No `.app` empacotado isso não é
  // necessário — o macOS lê o `.icns` do bundle automaticamente.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const dockIconPath = path.join(__dirname, "icons", "icon.icns");
    if (fs.existsSync(dockIconPath)) {
      try {
        app.dock.setIcon(dockIconPath);
      } catch (err) {
        console.warn("[dock] setIcon falhou (best-effort):", err?.message || err);
      }
    }
  }
  return boot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

app.on("before-quit", () => {
  // Sinaliza pro watchdog NAO tentar respawnar quando o server morrer durante
  // shutdown (kill abaixo dispara `exit` com code != 0). Tambem fecha o
  // arquivo de log do servidor pra flush final do buffer.
  app.isQuitting = true;
  killServerTree();
  try {
    serverLogFileStream?.end();
  } catch { /* ignore */ }
});
