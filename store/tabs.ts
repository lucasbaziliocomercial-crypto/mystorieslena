/**
 * Guias (abas) de projetos abertos — a "memória" dos projetos simultâneos que
 * a roteirista está usando. Persistida em `veludo:tabs` (chave própria), então
 * ao reabrir o app as mesmas guias voltam. É só navegação rápida: trocar de
 * guia navega pra `/roteiro/<id>` (o store carrega aquele roteiro). A geração
 * simultânea em si é a fila em 2º plano (`store/queue.ts`).
 *
 * Guarda só `{ id, title }` por aba — leve. O título é mantido em sincronia
 * com edições via `openTab` (upsert).
 */
import { create } from "zustand";

export interface ProjectTab {
  id: string;
  title: string;
}

/** Máximo de guias simultâneas — passou disso, a mais antiga sai (FIFO). */
const MAX_TABS = 10;

interface TabsState {
  tabs: ProjectTab[];
  /** Cria a guia se não existir, ou atualiza o título se já existir (upsert). */
  openTab: (id: string, title: string) => void;
  closeTab: (id: string) => void;
}

const TABS_KEY = "veludo:tabs";

function isBrowser() {
  return typeof window !== "undefined";
}

function loadTabs(): ProjectTab[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(TABS_KEY);
    if (!raw) return [];
    const tabs = JSON.parse(raw) as ProjectTab[];
    return Array.isArray(tabs)
      ? tabs.filter((t) => t && typeof t.id === "string")
      : [];
  } catch {
    return [];
  }
}

function saveTabs(tabs: ProjectTab[]) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    // best-effort — não é crítico.
  }
}

export const useTabs = create<TabsState>((set) => ({
  tabs: loadTabs(),

  openTab: (id, title) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      let tabs: ProjectTab[];
      if (idx >= 0) {
        // Já aberta — só atualiza o título (sem mudar a ordem).
        if (s.tabs[idx]!.title === title) return s;
        tabs = s.tabs.map((t) => (t.id === id ? { ...t, title } : t));
      } else {
        tabs = [...s.tabs, { id, title }];
        if (tabs.length > MAX_TABS) tabs = tabs.slice(tabs.length - MAX_TABS);
      }
      saveTabs(tabs);
      return { tabs };
    }),

  closeTab: (id) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      saveTabs(tabs);
      return { tabs };
    }),
}));
