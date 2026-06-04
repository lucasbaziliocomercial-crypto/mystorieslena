/**
 * API exposta pelo preload do Electron via contextBridge.
 * Disponível em window.mystorieslena (apenas dentro do Electron).
 */

export interface RuntimeInfo {
  mode: "live" | "packaged" | "external-dev" | string;
  version: string;
  isPackaged: boolean;
  /** true quando o app pode atualizar via GitHub Releases */
  updaterAvailable: boolean;
  /**
   * true em macOS sem certificado Apple Developer pago. Nessa configuração,
   * o auto-install falha com erro de assinatura ad-hoc (cada build tem
   * identidade nova). A UI mostra "Baixar" em vez de tentar instalar
   * automaticamente — o clique abre a página da release no navegador,
   * o usuário substitui o .app manualmente.
   * No Windows o NSIS não tem essa restrição → updateMode === "auto".
   */
  updateMode: "auto" | "external-download";
}

export interface UpdaterCheckResult {
  ok: boolean;
  reason?: string;
  info?: { version?: string } | null;
}

export interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export type UpdateEvent =
  | { type: "checking-for-update"; payload?: undefined }
  | { type: "update-available"; payload: { version?: string } }
  | { type: "update-not-available"; payload: { version?: string } }
  | { type: "download-progress"; payload: DownloadProgress }
  | { type: "update-downloaded"; payload: { version?: string } }
  | { type: "error"; payload: { message: string } };

export interface ExportPdfPayload {
  html: string;
  filename: string;
  title: string;
}

export interface ExportPdfResult {
  ok: boolean;
  path?: string;
  title?: string;
  canceled?: boolean;
  reason?: string;
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

export interface ExportRoteirosResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  reason?: string;
}

export interface RoteiroBackupEntry {
  name: string;
  mtimeMs: number;
  size: number;
}

export interface ListBackupsResult {
  ok: boolean;
  backups: RoteiroBackupEntry[];
  reason?: string;
}

export interface ReadBackupResult {
  ok: boolean;
  data?: string;
  reason?: string;
}

export interface ClaudeStatus {
  loggedIn: boolean;
  hasBinary: boolean;
  binaryPath: string | null;
  /** Caminho do bash.exe do Git for Windows (apenas Windows). null se não achou. */
  gitBashPath: string | null;
  /** true quando estamos no Windows e git-bash não foi encontrado. */
  needsGitBash: boolean;
}

export interface ClaudeSetupResult {
  ok: boolean;
  reason?: string;
}

export interface ClaudeLogoutResult {
  ok: boolean;
  removed?: string[];
  reason?: string;
}

export interface MyStoriesLenaBridge {
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  checkForUpdates: () => Promise<UpdaterCheckResult>;
  downloadUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  quitAndInstall: () => Promise<{ ok: boolean }>;
  /**
   * Abre o navegador na página da release mais recente. Usado em macOS
   * sem certificado Apple, onde auto-install falha por mismatch de
   * assinatura ad-hoc.
   */
  openDownloadPage: () => Promise<{ ok: boolean; reason?: string }>;
  onUpdateEvent: (cb: (event: UpdateEvent) => void) => () => void;
  exportRoteiroPdf: (payload: ExportPdfPayload) => Promise<ExportPdfResult>;
  /** Grava um snapshot rotativo da biblioteca em userData/backups (Electron). */
  autoBackupRoteiros: (data: string) => Promise<BackupResult>;
  /** Abre dialog "Salvar como" e grava a biblioteca onde o usuário escolher. */
  exportRoteiros: (
    data: string,
    filename?: string,
  ) => Promise<ExportRoteirosResult>;
  /** Lista os backups automáticos gravados em userData/backups. */
  listRoteiroBackups: () => Promise<ListBackupsResult>;
  /** Lê o conteúdo de um backup automático pelo nome do arquivo. */
  readRoteiroBackup: (name: string) => Promise<ReadBackupResult>;
  getClaudeStatus: () => Promise<ClaudeStatus>;
  setupClaude: () => Promise<ClaudeSetupResult>;
  logoutClaude: () => Promise<ClaudeLogoutResult>;
}

declare global {
  interface Window {
    mystorieslena?: MyStoriesLenaBridge;
  }
}

export {};
