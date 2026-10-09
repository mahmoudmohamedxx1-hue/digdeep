"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AdvParams, HistoryItem } from "@/components/research/types";
import { MODE_PARAMS } from "@/components/pplx/ask-box";
import { listHistory } from "@/lib/idb-store";

/**
 * Composer + UI settings shared across every route. Persisted per browser
 * (localStorage) so a reload — or a route change — never loses your depth
 * preset, language or backend preference.
 */
interface SettingsState {
  mode: string;
  language: string;
  modelPref: "auto" | "glm" | "pool";
  adv: AdvParams;
  advTouched: boolean;
  showThinking: boolean;
  sidebarOpen: boolean;

  applyMode: (m: string) => void;
  changeAdv: (a: AdvParams) => void;
  resetAdv: () => void;
  setLanguage: (l: string) => void;
  setModelPref: (m: "auto" | "glm" | "pool") => void;
  setShowThinking: (b: boolean) => void;
  setSidebarOpen: (b: boolean) => void;
  toggleSidebar: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      mode: "standard",
      language: "English",
      modelPref: "auto",
      adv: { ...MODE_PARAMS.standard },
      advTouched: false,
      showThinking: true,
      sidebarOpen: true,

      applyMode: (m) =>
        set((s) => ({ mode: m, ...(s.advTouched ? {} : { adv: { ...MODE_PARAMS[m] } }) })),
      changeAdv: (a) => set({ advTouched: true, adv: a, ...(get().mode !== "custom" ? { mode: "custom" } : {}) }),
      resetAdv: () => set((s) => ({ adv: { ...MODE_PARAMS[s.mode] }, advTouched: false })),
      setLanguage: (l) => set({ language: l }),
      setModelPref: (m) => set({ modelPref: m }),
      setShowThinking: (b) => set({ showThinking: b }),
      setSidebarOpen: (b) => set({ sidebarOpen: b }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    }),
    {
      name: "digdeep-settings",
      version: 2,
      /** v0/v1 (unversioned) → v2: backfill any missing adv keys so older
       *  localStorage never breaks a newer UI. Nothing is discarded. */
      migrate: (persisted, _version) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        const adv = { ...MODE_PARAMS[p.mode ?? "standard"], ...(p.adv ?? {}) };
        return {
          mode: p.mode ?? "standard",
          language: p.language ?? "English",
          modelPref: p.modelPref ?? "auto",
          adv,
          advTouched: p.advTouched ?? false,
          showThinking: p.showThinking ?? true,
          sidebarOpen: p.sidebarOpen ?? true,
        } as SettingsState;
      },
      partialize: (s) => ({
        mode: s.mode,
        language: s.language,
        modelPref: s.modelPref,
        adv: s.adv,
        advTouched: s.advTouched,
        showThinking: s.showThinking,
      }),
    }
  )
);

/**
 * Sidebar recents — one shared copy so the shell, the palette and the pages
 * all see the same history without prop-drilling or refetch storms.
 */
interface HistoryState {
  history: HistoryItem[];
  setHistory: (h: HistoryItem[]) => void;
}

export const useHistory = create<HistoryState>()((set) => ({
  history: [],
  setHistory: (h) => set({ history: h }),
}));

/** Reload the browser's thread history into the shared store. */
export async function refreshHistory() {
  try {
    useHistory.getState().setHistory(await listHistory());
  } catch { /* ignore */ }
}

/** Ask the browser for notification permission (called from a user gesture). */
export function requestNotificationPermission() {
  try {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch { /* ignore */ }
}
