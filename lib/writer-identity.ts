/**
 * Identidade da roteirista desta máquina — pro log de consumo de tokens
 * atribuir o gasto a quem gerou. O app é single-user por máquina, então o nome
 * mora no localStorage e é espelhado UMA vez no server (module-level) via
 * `/api/usage-identity` (no boot e quando muda no painel de Métricas). Daí todo
 * evento de uso herda esse nome sem precisar viajar em cada request.
 *
 * Só observabilidade. Fora do browser vira no-op.
 */

const KEY = "veludo:writer-name";

export function getWriterName(): string {
  try {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function setWriterName(name: string): void {
  try {
    if (typeof window === "undefined") return;
    const v = (name || "").trim().slice(0, 120);
    localStorage.setItem(KEY, v);
    void syncWriterIdentity(v);
  } catch {
    /* ignore */
  }
}

/** Espelha o nome no server (best-effort). Chamado no boot e ao salvar. */
export function syncWriterIdentity(name?: string): Promise<void> {
  try {
    const v = name ?? getWriterName();
    return fetch("/api/usage-identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writer: v }),
    })
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}
