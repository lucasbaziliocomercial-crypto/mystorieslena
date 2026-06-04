/**
 * Helpers de backup/export da biblioteca. `downloadFile` salva uma string num
 * arquivo: usa o dialog nativo do Electron (`window.mystorieslena.exportRoteiros`)
 * quando disponível, e cai num download de navegador no `npm run dev` puro.
 */

export interface DownloadResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
}

export async function downloadFile(
  data: string,
  filename: string,
): Promise<DownloadResult> {
  if (typeof window === "undefined") return { ok: false };

  const bridge = window.mystorieslena;
  if (bridge?.exportRoteiros) {
    const res = await bridge.exportRoteiros(data, filename);
    return { ok: res.ok, canceled: res.canceled, path: res.path };
  }

  // Fallback navegador (sem Electron): dispara download via blob.
  try {
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
