/**
 * Preload do Electron — expõe uma API mínima pro renderer (React) interagir
 * com o main process. Mantém contextIsolation ON (segurança) e usa
 * contextBridge.
 */

const { contextBridge, ipcRenderer } = require("electron");

const UPDATER_CHANNELS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
];

contextBridge.exposeInMainWorld("mystorieslena", {
  /** Pergunta o modo de runtime atual: "live" | "packaged" | "external-dev". */
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:info"),

  /**
   * Retorna { tail, elapsedMs, logPath } com as ultimas N (default 15) linhas
   * do log do servidor interno. Usado pela tela de loading pra mostrar
   * progresso real durante boots demorados (compilacao do Next em LIVE).
   */
  getBootLogTail: (n) => ipcRenderer.invoke("boot:get-log-tail", n),

  /** Dispara verificação de update no GitHub Releases. */
  checkForUpdates: () => ipcRenderer.invoke("updater:check"),

  /** Inicia download da versão disponível (se houver). */
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),

  /** Reinicia o app pra aplicar update já baixado. */
  quitAndInstall: () => ipcRenderer.invoke("updater:install"),

  /**
   * Abre o navegador padrão na página da release mais recente. Usado em
   * macOS sem cert Apple Developer, onde auto-install falha por mismatch
   * de assinatura ad-hoc — em vez de mostrar erro, oferecemos esse botão
   * pra o usuário baixar e substituir o .app manualmente.
   */
  openDownloadPage: () => ipcRenderer.invoke("updater:open-download-page"),

  /**
   * Exporta o roteiro completo como PDF. Retorna { ok, path } ou
   * { ok: false, canceled: true } se o usuário cancelar o dialog.
   */
  exportRoteiroPdf: (payload) => ipcRenderer.invoke("pdf:save-roteiro", payload),

  /**
   * Grava um snapshot da biblioteca em disco (userData/backups), rotacionando
   * os mais antigos. Chamado periodicamente pelo renderer — cópia fora do
   * localStorage que sobrevive a corrupção/quota. Retorna { ok, path }.
   */
  autoBackupRoteiros: (data) =>
    ipcRenderer.invoke("roteiros:auto-backup", { data }),

  /**
   * Abre dialog "Salvar como" e grava a biblioteca (string) onde o usuário
   * escolher. Retorna { ok, path } ou { ok:false, canceled:true }.
   */
  exportRoteiros: (data, filename) =>
    ipcRenderer.invoke("roteiros:export", { data, filename }),

  /**
   * Verifica se o usuário já fez login na conta Claude.
   * Retorna { loggedIn, hasBinary, binaryPath }.
   */
  getClaudeStatus: () => ipcRenderer.invoke("claude:status"),

  /**
   * Abre janela de terminal externa rodando o claude CLI bundleado, pra
   * usuário fazer login (digita /login dentro do REPL → OAuth no navegador).
   */
  setupClaude: () => ipcRenderer.invoke("claude:setup"),

  /**
   * Apaga as credenciais do Claude CLI (~/.claude/.credentials.json) pra
   * permitir trocar de conta. Depois disso, getClaudeStatus retorna
   * loggedIn: false e a usuária pode clicar em "Conectar" pra logar com
   * outra conta. Retorna { ok, removed?, reason? }.
   */
  logoutClaude: () => ipcRenderer.invoke("claude:logout"),

  /**
   * Abre a pasta de logs no explorer/finder (Windows: %APPDATA%\MyStoriesLena\logs;
   * Mac: ~/Library/Logs/MyStoriesLena). Útil pra usuária mandar log quando
   * reportar bug.
   */
  openLogsFolder: () => ipcRenderer.invoke("log:open-folder"),

  /**
   * Assina eventos do auto-updater. Retorna função pra remover assinatura.
   *   onUpdateEvent(({ type, payload }) => {})
   * type pode ser: "checking-for-update", "update-available",
   * "update-not-available", "download-progress", "update-downloaded", "error".
   */
  onUpdateEvent: (cb) => {
    const wrappers = UPDATER_CHANNELS.map((channel) => {
      const handler = (_event, payload) => cb({ type: channel, payload });
      const ipcChannel = `updater:${channel}`;
      ipcRenderer.on(ipcChannel, handler);
      return { ipcChannel, handler };
    });
    return () => {
      for (const { ipcChannel, handler } of wrappers) {
        ipcRenderer.removeListener(ipcChannel, handler);
      }
    };
  },
});
