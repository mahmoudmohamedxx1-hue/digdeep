"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  ArrowLeft, ArrowUpRight, Compass, Globe, House, LibraryBig, Loader2,
  Moon, PanelLeftClose, PanelLeftOpen, Plus, Search as SearchIcon, Sun, Trash2, TrendingUp, Wifi, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/hooks/use-toast";
import { LogoMark, LogoWord } from "@/components/pplx/logo";
import { AskBox, MODE_PARAMS } from "@/components/pplx/ask-box";
import { ThreadTurn } from "@/components/pplx/turn";
import { SourcesPanel } from "@/components/pplx/sources-row";
import type { AdvParams, AttachedDoc, HistoryItem, PoolEndpointUi, SearchSettingsUi, Turn } from "@/components/research/types";
import { ACTIVE_STATUSES, fmtElapsed } from "@/components/research/types";
import { saveTurn, getTurn, getThreadTurns, listHistory, deleteTurn, deleteThread, clearAll, orphanTurn } from "@/lib/idb-store";

interface TrendingItem { title: string; url: string; domain: string; points: number; comments: number }

const STATUS_DOT: Record<string, string> = {
  completed: "bg-primary",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
};

function SidebarItem({
  icon, label, active, onClick, collapsed,
}: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void; collapsed?: boolean }) {
  if (collapsed) {
    return (
      <button
        onClick={onClick}
        title={label}
        aria-label={label}
        className={`press-scale mx-auto flex h-11 w-11 items-center justify-center rounded-[12px] transition-colors ${
          active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        }`}
      >
        {icon}
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`press-scale flex h-11 w-full items-center gap-3 rounded-[12px] px-3 text-sm font-medium transition-colors ${
        active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

const BYOK_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
  { label: "Gemini (OpenAI-compat)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.0-flash" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
];

/** ---- P0-1 / P2-4: backends & search settings dialog ---- */
function BackendsDialog({
  open, onOpenChange, endpoints, setEndpoints, searchSettings, setSearchSettings, onSave, savingPool, savingSearch, testEndpoint, testing, saveSearch,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  endpoints: PoolEndpointUi[];
  setEndpoints: (e: PoolEndpointUi[]) => void;
  searchSettings: SearchSettingsUi | null;
  setSearchSettings: (s: SearchSettingsUi) => void;
  onSave: () => void;
  savingPool: boolean;
  savingSearch: boolean;
  testEndpoint: (ep: PoolEndpointUi) => void;
  testing: string | null;
  saveSearch: () => void;
}) {
  const [newInstance, setNewInstance] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass max-h-[85vh] overflow-y-auto rounded-[20px] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe className="h-4 w-4 text-primary" /> Backends &amp; web search</DialogTitle>
          <DialogDescription>
            Keyless LLM failover chain, optional frontier keys, and the general-web search layer (P0). Everything
            defaults to free and keyless — keys are optional upgrades.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {/* keyless chain */}
          <div className="rounded-[16px] border p-4">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Always-on keyless chain (auto mode order)</p>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2"><span className="font-mono text-primary">1 · GLM-5.3-Flash</span><span className="text-muted-foreground">z.ai SDK — primary</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">2 · GLM-4.5-Flash</span><span className="text-muted-foreground">z.ai SDK — default model</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">3 · LLM7 / GLM-5.3-Flash</span><span className="text-muted-foreground">api.llm7.io — keyless</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">4 · Pollinations / gpt-oss-20b</span><span className="text-muted-foreground">text.pollinations.ai — keyless</span></div>
            </div>
          </div>

          {/* BYOK endpoints */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold">Custom endpoints · keys optional (BYOK)</p>
              <div className="flex items-center gap-1.5">
                {BYOK_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className="press-scale rounded-lg border px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setEndpoints([...endpoints, { id: `new-${Date.now()}`, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: true, key: "", role: "general" }])}
                  >
                    + {p.label}
                  </button>
                ))}
                <Button variant="outline" size="sm" className="press-scale h-7 gap-1 rounded-lg text-xs" onClick={() => setEndpoints([...endpoints, { id: `new-${Date.now()}`, label: "", baseUrl: "http://127.0.0.1:8000/v1/chat/completions", model: "", enabled: true }])}>
                  <Plus className="h-3 w-3" /> Custom
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {endpoints.length === 0 && (
                <p className="rounded-[12px] border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                  No custom endpoints. Add a keyless proxy, or paste a frontier API key for better report writing —
                  the free chain stays as failover either way.
                </p>
              )}
              {endpoints.map((ep, i) => (
                <div key={ep.id} className="space-y-1.5 rounded-[16px] border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Label (e.g. My OpenAI key)"
                      value={ep.label}
                      onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                      className="h-8 flex-1 rounded-lg text-xs"
                      aria-label="Endpoint label"
                    />
                    <Switch checked={ep.enabled} onCheckedChange={(v) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} aria-label="Enable endpoint" />
                    <Button variant="ghost" size="icon" className="press-scale h-8 w-8 text-muted-foreground" onClick={() => setEndpoints(endpoints.filter((_, j) => j !== i))} aria-label="Remove endpoint">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Input
                    placeholder="OpenAI-compatible URL (…/v1/chat/completions)"
                    value={ep.baseUrl}
                    onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)))}
                    className="h-8 rounded-lg font-mono text-[11px]"
                    aria-label="Endpoint URL"
                  />
                  <div className="flex gap-2">
                    <Input
                      placeholder="model id"
                      value={ep.model}
                      onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))}
                      className="h-8 flex-1 rounded-lg font-mono text-[11px]"
                      aria-label="Model id"
                    />
                    <Button variant="outline" size="sm" className="press-scale h-8 gap-1 rounded-lg text-xs" disabled={testing === ep.baseUrl} onClick={() => testEndpoint(ep)}>
                      {testing === ep.baseUrl ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wifi className="h-3 w-3" />}
                      Test
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder={ep.hasKey ? "API key saved — type to replace" : "API key (optional — sent as Bearer)"}
                      value={ep.key ?? ""}
                      onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                      className="h-8 flex-1 rounded-lg font-mono text-[11px]"
                      aria-label="API key"
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={ep.role === "synthesis"}
                      onChange={(e) => setEndpoints(endpoints.map((x, j) => (j === i ? { ...x, role: e.target.checked ? "synthesis" : "general" } : x)))}
                      className="h-3.5 w-3.5 accent-[var(--primary)]"
                    />
                    Frontier synthesis — use this endpoint for report writing; everything else stays keyless
                  </label>
                </div>
              ))}
              {endpoints.length > 0 && (
                <div className="flex justify-end">
                  <Button onClick={onSave} disabled={savingPool} className="press-scale gap-1.5 rounded-[12px]">
                    {savingPool && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save endpoints
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* search engines */}
          {searchSettings && (
            <div className="rounded-[16px] border p-4">
              <p className="mb-1 text-xs font-semibold">Web search layer</p>
              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                General-web engines run on every query alongside the verticals (news, Wikipedia, arXiv…). DuckDuckGo
                is paced automatically; public SearXNG instances are best-effort; keyed engines are the reliable
                whole-web option (Brave 2,000/month free · Google CSE 100/day free).
              </p>
              <div className="space-y-3">
                {([
                  ["ddg", "DuckDuckGo (keyless, paced)", "General web results via the HTML endpoint"],
                  ["mojeek", "Mojeek (keyless)", "Independent index — great for source diversity"],
                  ["marginalia", "Marginalia (keyless)", "Indie/non-commercial web — finds what big engines miss"],
                ] as const).map(([key, label, desc]) => (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium">{label}</p>
                      <p className="text-[11px] text-muted-foreground">{desc}</p>
                    </div>
                    <Switch
                      checked={searchSettings[key] === true}
                      onCheckedChange={(v) => setSearchSettings({ ...searchSettings, [key]: v })}
                      aria-label={label}
                    />
                  </div>
                ))}
                <div>
                  <p className="mb-1.5 text-xs font-medium">SearXNG instances (JSON API)</p>
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {searchSettings.searxngInstances.map((u, i) => (
                      <span key={i} className="flex h-7 items-center gap-1 rounded-lg bg-muted px-2 font-mono text-[10px]">
                        {u.replace(/^https?:\/\//, "").slice(0, 30)}
                        <button className="text-muted-foreground hover:text-foreground" onClick={() => setSearchSettings({ ...searchSettings, searxngInstances: searchSettings.searxngInstances.filter((_, j) => j !== i) })} aria-label="Remove instance">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {searchSettings.searxngInstances.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">Default public instances are tried automatically; add your own for reliability.</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://searx.example.org"
                      value={newInstance}
                      onChange={(e) => setNewInstance(e.target.value)}
                      className="h-8 flex-1 rounded-lg font-mono text-[11px]"
                      aria-label="SearXNG instance URL"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="press-scale h-8 rounded-lg text-xs"
                      onClick={() => {
                        const u = newInstance.trim();
                        if (/^https?:\/\//.test(u)) {
                          setSearchSettings({ ...searchSettings, searxngInstances: [...searchSettings.searxngInstances, u].slice(0, 5) });
                          setNewInstance("");
                        }
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-medium">Brave Search API key {searchSettings.hasBraveKey && <span className="text-[10px] font-normal text-primary">saved</span>}</p>
                    <Input
                      type="password"
                      placeholder={searchSettings.hasBraveKey ? "•••••• — type to replace" : "optional · 2k/month free"}
                      value={searchSettings.braveKey ?? ""}
                      onChange={(e) => setSearchSettings({ ...searchSettings, braveKey: e.target.value })}
                      className="h-8 rounded-lg font-mono text-[11px]"
                      aria-label="Brave API key"
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium">Google CSE key {searchSettings.hasGoogleKey && <span className="text-[10px] font-normal text-primary">saved</span>}</p>
                    <Input
                      type="password"
                      placeholder={searchSettings.hasGoogleKey ? "•••••• — type to replace" : "optional · 100/day free"}
                      value={searchSettings.googleCseKey ?? ""}
                      onChange={(e) => setSearchSettings({ ...searchSettings, googleCseKey: e.target.value })}
                      className="h-8 rounded-lg font-mono text-[11px]"
                      aria-label="Google CSE key"
                    />
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium">Google CSE cx (search engine id)</p>
                  <Input
                    placeholder="e.g. 017576662512468239146:omuauf_lfve"
                    value={searchSettings.googleCseCx ?? ""}
                    onChange={(e) => setSearchSettings({ ...searchSettings, googleCseCx: e.target.value })}
                    className="h-8 rounded-lg font-mono text-[11px]"
                    aria-label="Google CSE cx"
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={saveSearch} disabled={savingSearch} className="press-scale gap-1.5 rounded-[12px]">
                    {savingSearch && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save search settings
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<"home" | "thread">("home");

  // ---------- form ----------
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("standard");
  const [language, setLanguage] = useState("English");
  const [modelPref, setModelPref] = useState<"auto" | "glm" | "pool">("auto");
  const [adv, setAdv] = useState<AdvParams>({ ...MODE_PARAMS.standard });
  const [advTouched, setAdvTouched] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [docs, setDocs] = useState<AttachedDoc[]>([]); // P2-3: attached ground-truth documents

  // ---------- thread ----------
  const [threadId, setThreadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [followQuery, setFollowQuery] = useState("");
  const [followDocs, setFollowDocs] = useState<AttachedDoc[]>([]);
  const [now, setNow] = useState(Date.now());
  const [liveIds, setLiveIds] = useState<Set<string>>(new Set());
  const sinceSeqRef = useRef<Record<string, number>>({});
  // mirror of turns for async contexts (polling) — read fresh turn data without
  // relying on side effects inside setState updaters (which React may defer)
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // ---------- home ----------
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ---------- sidebar ----------
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ---------- stop-all ----------
  const [stoppingAll, setStoppingAll] = useState(false);

  // ---------- backends & search (P0-1 / P2-4) ----------
  const [poolOpen, setPoolOpen] = useState(false);
  const [customEndpoints, setCustomEndpoints] = useState<PoolEndpointUi[]>([]);
  const [searchSettings, setSearchSettings] = useState<SearchSettingsUi | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [savingPool, setSavingPool] = useState(false);
  const [savingSearch, setSavingSearch] = useState(false);

  useEffect(() => setMounted(true), []);

  // sidebar collapse persisted per browser
  useEffect(() => {
    try {
      if (localStorage.getItem("digdeep-sidebar") === "0") setSidebarOpen(false);
    } catch { /* ignore */ }
  }, []);
  const toggleSidebar = () =>
    setSidebarOpen((v) => {
      try {
        localStorage.setItem("digdeep-sidebar", v ? "0" : "1");
      } catch { /* ignore */ }
      return !v;
    });

  // history lives in THIS browser (IndexedDB) — per user, survives server restarts
  const refreshHistory = useCallback(async () => {
    setHistory(await listHistory());
  }, []);

  const loadTrending = useCallback(async () => {
    try {
      const r = await fetch("/api/trending");
      if (r.ok) setTrending((await r.json()).items ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadPool = useCallback(async () => {
    try {
      const r = await fetch("/api/settings");
      if (r.ok) {
        const d = await r.json();
        setCustomEndpoints((d.endpoints ?? []).filter((e: PoolEndpointUi) => e.id.startsWith("custom-")));
        if (d.searchSettings) setSearchSettings(d.searchSettings);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshHistory();
    loadTrending();
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) openThread(t);
  }, []);

  // ---------- mode → params ----------
  const applyMode = (m: string) => {
    setMode(m);
    if (!advTouched) setAdv({ ...MODE_PARAMS[m] });
  };
  const changeAdv = (a: AdvParams) => {
    setAdvTouched(true);
    setAdv(a);
    if (mode !== "custom") setMode("custom");
  };

  const setUrlThread = (tid: string | null) => {
    try {
      window.history.replaceState(null, "", tid ? `?t=${encodeURIComponent(tid)}` : window.location.pathname);
    } catch { /* ignore */ }
  };

  // ---------- actions ----------
  const startResearch = async (q?: string, tid?: string | null, withDocs?: AttachedDoc[]) => {
    const question = (q ?? query).trim();
    if (question.length < 3) {
      toast({ title: "Please enter a research question first", variant: "destructive" });
      return;
    }
    setStarting(true);
    try {
      // no explicit tid = asked from the HOME box → always a fresh thread (Perplexity behavior);
      // follow-ups and related-question clicks pass the thread id explicitly.
      const fresh = tid == null;
      const useTid = fresh
        ? typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `t-${Date.now()}`
        : (tid as string);
      const useDocs = (withDocs ?? docs).filter((d) => d.text.trim().length > 0);
      const r = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, preset: mode === "custom" ? "standard" : mode, language, modelPref, threadId: useTid, ...(useDocs.length > 0 ? { docs: useDocs } : {}), ...adv }),
      });
      const d = await r.json();
      if (d.id) {
        sinceSeqRef.current[d.id] = 0;
        const newTurn: Turn = { jobId: d.id, job: null, events: [], sources: [], sections: [] };
        setTurns((prev) => (fresh ? [newTurn] : [...prev, newTurn]));
        setLiveIds((s) => new Set(s).add(d.id));
        setThreadId(useTid);
        setView("thread");
        setUrlThread(useTid);
        setQuery("");
        setFollowQuery("");
        setDocs([]);
        setFollowDocs([]);
        refreshHistory();
      } else {
        toast({ title: "Could not start research", description: d.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setStarting(false);
    }
  };

  const openThread = useCallback(async (tid: string) => {
    // 1) browser-first: this user's own copy (instant, offline, survives server restarts)
    let loaded = await getThreadTurns(tid);
    // 2) merge server-side turns this browser doesn't have (shared ?t= URLs, another
    //    browser, or runs started outside the UI) so the thread is always complete
    try {
      const r = await fetch(`/api/research?threadId=${encodeURIComponent(tid)}`);
      const d = await r.json();
      const jobs: HistoryItem[] = d.jobs ?? [];
      const localIds = new Set(loaded.map((t) => t.jobId));
      const missing = jobs.filter((j) => !localIds.has(j.id));
      if (loaded.length === 0 && jobs.length === 0) {
        toast({ title: "Thread not found in this browser" });
        return;
      }
      if (missing.length > 0) {
        const adopted = await Promise.all(
          missing.map(async (j) => {
            const detail = await fetch(`/api/research/${j.id}`).then((x) => x.json()).catch(() => null);
            return {
              jobId: j.id,
              job: detail?.job ?? null,
              events: detail?.events ?? [],
              sources: detail?.sources ?? [],
              sections: detail?.sections ?? [],
            } as Turn;
          })
        );
        loaded = [...loaded, ...adopted].sort(
          (a, b) => new Date(a.job?.createdAt ?? 0).getTime() - new Date(b.job?.createdAt ?? 0).getTime()
        );
      }
    } catch {
      if (loaded.length === 0) {
        toast({ title: "Could not open thread", variant: "destructive" });
        return;
      }
    }
    for (const t of loaded) {
      sinceSeqRef.current[t.jobId] = t.events.length ? Math.max(...t.events.map((e) => e.seq)) : 0;
      if (t.job) void saveTurn(t);
    }
    setTurns(loaded);
    setThreadId(tid);
    setView("thread");
    setUrlThread(tid);
    const last = loaded[loaded.length - 1];
    if (last.job && ACTIVE_STATUSES.includes(last.job.status)) {
      setLiveIds((s) => new Set(s).add(last.jobId));
    }
  }, []);

  const openFromHistory = (h: HistoryItem) => {
    setHistoryOpen(false);
    if (h.threadId) openThread(h.threadId);
    else {
      // legacy single run without a thread — load it as a one-turn thread
      (async () => {
        const local = await getTurn(h.id);
        const detail = local?.job
          ? { job: local.job, events: local.events, sources: local.sources, sections: local.sections }
          : await fetch(`/api/research/${h.id}`).then((x) => x.json()).catch(() => null);
        if (!detail?.job) return;
        sinceSeqRef.current[h.id] = detail.events?.length ? Math.max(...detail.events.map((e: { seq: number }) => e.seq)) : 0;
        const t: Turn = { jobId: h.id, job: detail.job, events: detail.events ?? [], sources: detail.sources ?? [], sections: detail.sections ?? [] };
        void saveTurn(t);
        setTurns([t]);
        setThreadId(null);
        setView("thread");
        setUrlThread(null);
      })();
    }
  };

  const goHome = () => {
    setView("home");
    setUrlThread(null);
    refreshHistory();
  };

  const stopJob = async (jobId: string) => {
    try {
      const r = await fetch(`/api/research/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      if (r.ok) toast({ title: "Stopping — the agent halts at its next checkpoint" });
    } catch { /* ignore */ }
  };

  /** Stop every active turn in this thread at once (the round button in the follow-up box). */
  const stopAllActive = async () => {
    const ids = turns.filter((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status)).map((t) => t.jobId);
    if (ids.length === 0) return;
    setStoppingAll(true);
    try {
      await Promise.all(
        ids.map((jid) =>
          fetch(`/api/research/${jid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }).catch(() => null)
        )
      );
      toast({ title: "Stopping — the agent halts at its next checkpoint" });
    } finally {
      setStoppingAll(false);
    }
  };

  /** Delete one history entry (whole thread when grouped) from THIS browser's storage. */
  const deleteHistoryItem = async (h: HistoryItem) => {
    if (h.threadId) await deleteThread(h.threadId);
    else await deleteTurn(h.id);
    refreshHistory();
    toast({ title: "Deleted from this browser", description: "Server copies (if any) are not affected for other users." });
  };

  const clearBrowserData = async () => {
    if (!window.confirm("Clear ALL digdeep history saved in this browser? This cannot be undone.")) return;
    await clearAll();
    refreshHistory();
    toast({ title: "Browser storage cleared" });
  };

  const retryJob = async (jobId: string) => {
    try {
      const r = await fetch(`/api/research/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry" }) });
      if (r.ok) {
        sinceSeqRef.current[jobId] = 0;
        setTurns((prev) => prev.map((t) => (t.jobId === jobId ? { jobId, job: null, events: [], sources: [], sections: [] } : t)));
        setLiveIds((s) => new Set(s).add(jobId));
        toast({ title: "Retrying research run" });
      }
    } catch { /* ignore */ }
  };

  const testEndpoint = async (ep: PoolEndpointUi) => {
    setTesting(ep.baseUrl);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", ...ep }) });
      const d = await r.json();
      toast({ title: d.ok ? `Endpoint works — replied “${d.reply}”` : `Endpoint test failed (HTTP ${d.status})`, variant: d.ok ? "default" : "destructive" });
    } catch {
      toast({ title: "Test request failed", variant: "destructive" });
    } finally {
      setTesting(null);
    }
  };

  const savePool = async () => {
    setSavingPool(true);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", endpoints: customEndpoints }) });
      if (r.ok) {
        const d = await r.json();
        if (d.endpoints) setCustomEndpoints(d.endpoints);
        toast({ title: "Endpoints saved" });
      }
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSavingPool(false);
    }
  };

  const saveSearch = async () => {
    if (!searchSettings) return;
    setSavingSearch(true);
    try {
      const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save-search", searchSettings }) });
      if (r.ok) toast({ title: "Search settings saved" });
      else toast({ title: "Save failed", variant: "destructive" });
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    } finally {
      setSavingSearch(false);
    }
  };

  // ---------- polling ALL active turns ----------
  const activeJobIds = useMemo(
    () => turns.filter((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status)).map((t) => t.jobId),
    [turns]
  );
  const activeKey = activeJobIds.join(",");

  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split(",");
    let stopped = false;
    const poll = async () => {
      for (const jid of ids) {
        if (stopped) return;
        try {
          const since = sinceSeqRef.current[jid] ?? 0;
          const r = await fetch(`/api/research/${jid}?sinceSeq=${since}`);
          if (stopped) return;
          if (r.status === 404) {
            // server lost this run (restart) — keep the browser copy, mark interrupted
            const upd = await orphanTurn(jid, "The server restarted — this run was interrupted. Everything gathered so far is kept in this browser.");
            if (upd) setTurns((prev) => prev.map((t) => (t.jobId === jid ? upd : t)));
            continue;
          }
          if (!r.ok) continue;
          const d = await r.json();
          const cur = turnsRef.current.find((t) => t.jobId === jid);
          if (cur) {
            const seen = new Set(cur.events.map((e) => e.seq));
            const add = (d.events ?? []).filter((e: { seq: number }) => !seen.has(e.seq));
            const u: Turn = {
              ...cur,
              job: d.job,
              sources: d.sources ?? [],
              sections: d.sections ?? [],
              events: [...cur.events, ...add].sort((a, b) => a.seq - b.seq),
            };
            setTurns((prev) => prev.map((t) => (t.jobId === jid ? u : t)));
            if (u.job) await saveTurn(u); // persist to THIS browser (awaited so history reads stay fresh)
          } else {
            setTurns((prev) =>
              prev.map((t) =>
                t.jobId === jid
                  ? { ...t, job: d.job, sources: d.sources ?? [], sections: d.sections ?? [], events: (d.events ?? []) as typeof t.events }
                  : t
              )
            );
          }
          if (d.events?.length) {
            sinceSeqRef.current[jid] = Math.max(since, ...d.events.map((e: { seq: number }) => e.seq));
          }
          if (!d.active) refreshHistory();
        } catch { /* transient */ }
      }
    };
    poll();
    // 1.2s cadence: live thinking deltas land in the UI within ~1-2s of generation
    const iv = setInterval(poll, 1200);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [activeKey, refreshHistory]);

  // ticking clock while anything is active
  const anyActive = turns.some((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status));
  useEffect(() => {
    if (!anyActive) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [anyActive]);

  const turnElapsed = (t: Turn): number => {
    const j = t.job;
    if (!j?.startedAt) return 0;
    const end = j.completedAt ? new Date(j.completedAt).getTime() : now;
    return end - new Date(j.startedAt).getTime();
  };

  const lastTurn = turns[turns.length - 1];
  const allModels = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of turns) for (const e of t.events) if (e.model) m[e.model] = (m[e.model] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [turns]);

  const submitFollowUp = () => startResearch(followQuery, threadId, followDocs);

  // ================= RENDER =================
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* ---------- SIDEBAR (Apple translucent rail) ---------- */}
      <aside
        className={`hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar backdrop-blur-xl transition-[width] duration-300 ease-apple md:flex ${
          sidebarOpen ? "w-[240px]" : "w-[64px]"
        }`}
      >
        <div className={`flex items-center gap-2.5 py-4 ${sidebarOpen ? "px-4" : "justify-center px-2"}`}>
          {sidebarOpen ? (
            <>
              <LogoMark className="h-7 w-7 shrink-0" />
              <LogoWord className="text-[15px]" />
              <Button
                variant="ghost"
                size="icon"
                className="press-scale ml-auto h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                onClick={toggleSidebar}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="press-scale h-11 w-11 shrink-0 rounded-[12px] text-muted-foreground hover:text-foreground"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen className="h-4.5 w-4.5" />
            </Button>
          )}
        </div>
        <nav className={`space-y-1 pt-1 ${sidebarOpen ? "px-3" : "px-1"}`}>
          <SidebarItem collapsed={!sidebarOpen} icon={<House className="h-4.5 w-4.5" />} label="Home" active={view === "home"} onClick={goHome} />
          <SidebarItem
            collapsed={!sidebarOpen}
            icon={<Compass className="h-4.5 w-4.5" />}
            label="Discover"
            onClick={() => { goHome(); setTimeout(() => document.getElementById("discover")?.scrollIntoView({ behavior: "smooth" }), 80); }}
          />
          <SidebarItem collapsed={!sidebarOpen} icon={<LibraryBig className="h-4.5 w-4.5" />} label="Library" onClick={() => { refreshHistory(); setHistoryOpen(true); }} />
        </nav>
        <div className={`mt-auto space-y-1 pb-4 ${sidebarOpen ? "px-3" : "px-1"}`}>
          <SidebarItem collapsed={!sidebarOpen} icon={<SearchIcon className="h-4.5 w-4.5" />} label="Backends & search" onClick={() => { loadPool(); setPoolOpen(true); }} />
          <SidebarItem
            collapsed={!sidebarOpen}
            icon={mounted && theme === "dark" ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
            label={mounted && theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
          {sidebarOpen && (
            <p className="px-3 pt-3 text-[10px] leading-relaxed text-muted-foreground">
              DigDeep · 100% free · no API keys<br />
              whole-web search · citation-verified<br />
              History saved in this browser
            </p>
          )}
        </div>
      </aside>

      {/* ---------- MAIN ---------- */}
      <main className="slim-scroll relative flex-1 overflow-y-auto">
        {/* mobile top bar — Apple glass nav */}
        <div className="glass-nav sticky top-0 z-30 flex items-center gap-2 px-4 py-3 md:hidden">
          {view === "thread" ? (
            <Button variant="ghost" size="icon" className="press-scale h-9 w-9 rounded-[12px]" onClick={goHome} aria-label="Back to home">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <LogoMark className="h-6 w-6" />
          <LogoWord className="text-sm" />
          <div className="ml-auto flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="press-scale h-9 w-9 rounded-[12px]" onClick={() => { refreshHistory(); setHistoryOpen(true); }} aria-label="Library">
              <LibraryBig className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="press-scale h-9 w-9 rounded-[12px]" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
              {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {view === "home" ? (
          /* ================= HOME (Apple hero, staggered entrance) ================= */
          <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-[12vh]">
            <div className="rise-in stagger-1 text-center">
              <h1 className="text-[30px] font-semibold leading-[1.2] tracking-[-0.022em] sm:text-[38px]">
                Where knowledge begins
              </h1>
              <p className="mx-auto mt-3 max-w-lg text-center text-[14px] leading-relaxed text-muted-foreground">
                DigDeep searches the whole web, reads the sources, cross-checks every claim and citation — and shows
                you its thinking the whole way down.
              </p>
            </div>

            <div className="rise-in stagger-2 mt-8">
              <AskBox
                value={query}
                onChange={setQuery}
                onSubmit={() => startResearch()}
                busy={starting}
                autoFocus
                placeholder="Ask anything…"
                mode={mode}
                onMode={applyMode}
                adv={adv}
                advTouched={advTouched}
                onAdv={changeAdv}
                language={language}
                onLanguage={setLanguage}
                modelPref={modelPref}
                onModelPref={setModelPref}
                showThinking={showThinking}
                onShowThinking={setShowThinking}
                onManagePool={() => { loadPool(); setPoolOpen(true); }}
                docs={docs}
                onDocs={setDocs}
              />
            </div>

            <p className="rise-in stagger-3 mt-3.5 text-center text-[11.5px] leading-relaxed text-muted-foreground">
              Smart routing: “hii” gets an instant chat, simple questions get a quick cited answer, real questions get
              full deep research · citation integrity audited · unlimited mode available
            </p>

            {/* recent threads — iOS inset grouped list */}
            {history.length > 0 && (
              <section className="rise-in stagger-4 mt-12">
                <div className="mb-2.5 flex items-center justify-between px-1">
                  <h2 className="text-[15px] font-semibold">Recent</h2>
                  <button className="flex items-center gap-1 text-xs text-primary hover:underline" onClick={() => { refreshHistory(); setHistoryOpen(true); }}>
                    Library <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
                <div className="glass divide-y rounded-[20px]">
                  {history.slice(0, 5).map((h) => (
                    <button key={h.id} onClick={() => openFromHistory(h)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[h.status] ?? "bg-amber-500 pulse-dot"}`} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{h.query}</span>
                      <span className="shrink-0 text-[11px] capitalize text-muted-foreground">{h.mode === "chat" ? "chat" : h.mode === "quick" ? "quick" : (h.preset === "custom" ? "custom" : h.preset)}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{new Date(h.createdAt).toLocaleDateString()}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* discover / trending — Apple cards */}
            <section className="rise-in stagger-5 mt-12" id="discover">
              <div className="mb-2.5 flex items-center gap-1.5 px-1">
                <TrendingUp className="h-4 w-4 text-primary" />
                <h2 className="text-[15px] font-semibold">Trending now</h2>
              </div>
              {trending.length === 0 ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[...Array(6)].map((_, i) => <div key={i} className="skeleton-line h-[96px] rounded-[16px]" />)}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  {trending.map((t) => (
                    <button
                      key={t.url}
                      onClick={() => { setQuery(t.title); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                      className="hover-lift flex h-[96px] flex-col justify-between rounded-[16px] border border-input bg-card p-3.5 text-left"
                      title={`Research: ${t.title}`}
                    >
                      <p className="line-clamp-2 text-[13px] font-medium leading-snug">{t.title}</p>
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="truncate">{t.domain}</span>
                        <span className="opacity-50">· ▲ {t.points}</span>
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          /* ================= THREAD ================= */
          <div>
            <div className="mx-auto flex w-full max-w-[1140px] justify-center gap-8 px-4 pb-44 pt-6 sm:pt-10">
              <div className="mx-auto w-full max-w-[768px] space-y-14">
                {turns.map((t) => (
                  <ThreadTurn
                    key={t.jobId}
                    turn={t}
                    showThinking={showThinking}
                    now={now}
                    elapsedMs={turnElapsed(t)}
                    onStop={() => stopJob(t.jobId)}
                    onRetry={() => retryJob(t.jobId)}
                    onFollowUp={(q) => startResearch(q, threadId)}
                    onRerun={(q) => startResearch(q, threadId)}
                    animate={liveIds.has(t.jobId)}
                  />
                ))}
              </div>

              {/* right rail (xl) — Apple glass */}
              {lastTurn && (
                <aside className="sticky top-6 hidden h-fit w-[300px] shrink-0 space-y-6 xl:block">
                  <div>
                    <p className="mb-2 text-[13px] font-semibold">Thread</p>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium capitalize text-muted-foreground">
                        {lastTurn.job?.mode === "chat" ? "chat" : lastTurn.job?.mode === "quick" ? "quick answer" : (lastTurn.job?.preset ?? mode)}
                      </span>
                      {(lastTurn.job?.mode ?? "research") !== "chat" && (
                        <>
                      {(lastTurn.job?.breadth ?? adv.breadth) < 0 && <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">∞ aspects</span>}
                      {(lastTurn.job?.depth ?? adv.depth) < 0 && <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">∞ rounds</span>}
                      {(lastTurn.job?.maxSources ?? adv.maxSources) < 0 && <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">∞ sources</span>}
                      {(lastTurn.job?.maxMinutes ?? adv.maxMinutes) < 0 && <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">∞ time</span>}
                        </>
                      )}
                      <span className="rounded-lg bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{lastTurn.job?.language ?? language}</span>
                    </div>
                    {anyActive && lastTurn.job?.startedAt && (
                      <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">{fmtElapsed(turnElapsed(lastTurn))} elapsed · honest ETA in steps</p>
                    )}
                  </div>

                  {allModels.length > 0 && (
                    <div>
                      <p className="mb-2 text-[13px] font-semibold">Models used</p>
                      <div className="space-y-1.5">
                        {allModels.map(([m, c]) => (
                          <div key={m} className="glass flex items-center justify-between rounded-[12px] px-3 py-2">
                            <span className="font-mono text-[11px]">{m}</span>
                            <span className="text-[11px] text-muted-foreground">{c} steps</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {lastTurn.sources.length > 0 && (
                    <div className="max-h-[520px] overflow-hidden">
                      <p className="mb-2 text-[13px] font-semibold">Sources · {lastTurn.sources.length}</p>
                      <div className="slim-scroll max-h-[460px] space-y-2 overflow-y-auto pr-1">
                        <SourcesPanel sources={lastTurn.sources} />
                      </div>
                    </div>
                  )}
                </aside>
              )}
            </div>

            {/* follow-up input (pinned bottom — Apple glass) */}
            <div className="glass-nav sticky bottom-0 z-20">
              <div className="mx-auto w-full max-w-[768px] px-4 py-3">
                <AskBox
                  value={followQuery}
                  onChange={setFollowQuery}
                  onSubmit={submitFollowUp}
                  busy={starting}
                  compact
                  placeholder={anyActive ? "Working… you can stop it, or queue a follow-up" : "Ask a follow-up…"}
                  mode={mode}
                  onMode={applyMode}
                  adv={adv}
                  advTouched={advTouched}
                  onAdv={changeAdv}
                  language={language}
                  onLanguage={setLanguage}
                  modelPref={modelPref}
                  onModelPref={setModelPref}
                  showThinking={showThinking}
                  onShowThinking={setShowThinking}
                  onManagePool={() => { loadPool(); setPoolOpen(true); }}
                  docs={followDocs}
                  onDocs={setFollowDocs}
                  stopMode={anyActive}
                  onStop={stopAllActive}
                  stopping={stoppingAll}
                />
                <p className="mt-2 text-center text-[10.5px] text-muted-foreground">
                  Follow-ups stay in this thread — DigDeep routes each message automatically: chat, quick answer, or deep research · history is saved in this browser
                </p>
              </div>
            </div>
          </div>
        )}

        {/* desktop floating new-thread button */}
        {view === "thread" && (
          <Button
            size="icon"
            className="press-scale fixed bottom-24 right-6 z-20 hidden h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-[0_8px_24px_rgba(0,122,255,0.4)] hover:bg-primary/90 md:flex"
            onClick={goHome}
            aria-label="New research"
            title="New research"
          >
            <Plus className="h-5 w-5" />
          </Button>
        )}
      </main>

      {/* ---------- LIBRARY SHEET (this browser's IndexedDB) ---------- */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent className="glass w-full rounded-l-[20px] sm:max-w-md sm:rounded-none">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><LibraryBig className="h-4 w-4 text-primary" /> Library</SheetTitle>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Saved in this browser (IndexedDB) — every thread, report and source. Private to you; survives server restarts.
            </p>
          </SheetHeader>
          <div className="slim-scroll mt-2 max-h-[calc(100vh-130px)] space-y-2 overflow-y-auto px-4 pb-6">
            {history.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nothing here yet — ask something and it will be saved locally.</p>}
            {history.map((h) => (
              <div key={h.id} className="group relative flex items-start gap-2 rounded-[16px] border border-input bg-card p-3.5">
                <button onClick={() => openFromHistory(h)} className="min-w-0 flex-1 text-left">
                  <p className="line-clamp-2 text-sm font-medium">{h.query}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className={`rounded-md px-2 py-0.5 font-medium capitalize ${h.status === "completed" ? "bg-primary/10 text-primary" : h.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>{h.status}</span>
                    <span className="capitalize">{h.mode === "chat" ? "chat" : h.mode === "quick" ? "quick answer" : h.preset}</span>
                    <span>{new Date(h.createdAt).toLocaleString()}</span>
                  </div>
                </button>
                <button
                  onClick={() => deleteHistoryItem(h)}
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground/50 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={h.threadId ? "Delete this thread from this browser" : "Delete from this browser"}
                  title={h.threadId ? "Delete this thread from this browser" : "Delete from this browser"}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {history.length > 0 && (
              <Button variant="outline" className="press-scale mt-2 w-full gap-2 rounded-[12px] text-destructive hover:text-destructive" onClick={clearBrowserData}>
                <Trash2 className="h-4 w-4" /> Clear all browser data
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ---------- BACKENDS & SEARCH DIALOG (P0-1 / P2-4) ---------- */}
      <BackendsDialog
        open={poolOpen}
        onOpenChange={setPoolOpen}
        endpoints={customEndpoints}
        setEndpoints={setCustomEndpoints}
        searchSettings={searchSettings}
        setSearchSettings={setSearchSettings}
        onSave={savePool}
        savingPool={savingPool}
        savingSearch={savingSearch}
        testEndpoint={testEndpoint}
        testing={testing}
        saveSearch={saveSearch}
      />
    </div>
  );
}

