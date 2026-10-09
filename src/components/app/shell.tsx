"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { MotionConfig } from "framer-motion";
import { useTheme } from "next-themes";
import {
  ArrowLeft, Compass, Gauge, House, LibraryBig, Loader2, Menu, Moon, PanelLeftClose,
  Plus, Settings, Settings2, Sun, Trash2, Wifi, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { toast } from "@/hooks/use-toast";
import { LogoLockup, LogoMark } from "@/components/pplx/logo";
import { MODES } from "@/components/pplx/ask-box";
import { StaggerIn } from "@/components/magic";
import { JobSignals } from "@/components/app/job-signals";
import type { HistoryItem, PoolEndpointUi, SearchSettingsUi, Turn } from "@/components/research/types";
import { useSettings, useHistory, refreshHistory } from "@/lib/store";
import { getThreadTurns, getTurn, deleteThread, deleteTurn, saveTurn } from "@/lib/idb-store";
import { ToastAction } from "@/components/ui/toast";
import { groupHistory } from "@/lib/history-group";

/** The scroll container ref — pages (thread view) need it for jump-to-latest. */
const MainScrollContext = createContext<React.RefObject<HTMLElement | null> | null>(null);
export function useMainScroll() {
  return useContext(MainScrollContext);
}

const STATUS_DOT: Record<string, string> = {
  completed: "bg-primary",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
};

function SidebarItem({
  icon, label, active, onClick, collapsed, href, compact,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  collapsed?: boolean;
  href?: string;
  /** compact — the dense 36px desktop-sidebar rows (the mobile sheet keeps the 44px touch size) */
  compact?: boolean;
}) {
  const cls = `press-scale ${collapsed ? "mx-auto flex h-10 w-10 justify-center" : `flex w-full items-center gap-2.5 px-3 ${compact ? "h-9 text-[13px]" : "h-11 text-sm"} font-medium`} items-center rounded-[10px] transition-colors ${
    active ? "bg-accent text-foreground" : "text-foreground/70 hover:bg-accent/70 hover:text-foreground"
  }`;
  const inner = (
    <>
      {icon}
      {!collapsed && label}
    </>
  );
  if (href) {
    return (
      <Link href={href} onClick={onClick} className={cls} title={label} aria-label={label} aria-current={active ? "page" : undefined}>
        {inner}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls} title={label} aria-label={label} aria-current={active ? "page" : undefined}>
      {inner}
    </button>
  );
}

/** Recents list — shared by the desktop rail and the mobile nav sheet.
 *  Rows are Today/Earlier groups, active row highlighted, delete with undo. */
function Recents({ onNavigate, dense = false, touch = false }: { onNavigate: (h: HistoryItem) => void; dense?: boolean; touch?: boolean }) {
  const { history } = useHistory();
  const grouped = useMemo(() => groupHistory(history), [history]);
  const pathname = usePathname();

  /** Delete with undo — the turns are captured first, so Undo re-saves them
   *  and the thread metadata rebuilds itself (saveTurn upserts it). */
  const remove = async (h: HistoryItem) => {
    // capture BEFORE deleting: whole threads via getThreadTurns, single turns
    // via getTurn — so Undo can put the exact records back
    const captured: Turn[] = h.threadId
      ? await getThreadTurns(h.threadId)
      : [(await getTurn(h.id))].filter((t): t is Turn => t != null);
    if (h.threadId) await deleteThread(h.threadId);
    else await deleteTurn(h.id);
    await refreshHistory();
    toast({
      title: "Deleted from this browser",
      description: h.threadId ? "The server copy (if any) is not affected." : undefined,
      action: captured.length
        ? (
            <ToastAction
              altText="Undo the delete"
              onClick={async () => {
                for (const t of captured) if (t.job) await saveTurn(t);
                await refreshHistory();
              }}
            >
              Undo
            </ToastAction>
          )
        : undefined,
    });
  };

  if (grouped.length === 0) {
    return (
      <p className="px-3 py-3 text-[12px] leading-relaxed text-muted-foreground">
        No threads yet — everything you ask is saved here, in this browser.
      </p>
    );
  }
  return (
    <>
      {grouped.map((g) => (
        <div key={g.label} className="mb-0.5">
          <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground/70">{g.label}</p>
          {g.items.map((h) => {
            const active = pathname.startsWith("/r/") && h.threadId != null && pathname === `/r/${h.threadId}`;
            return (
              <StaggerIn key={h.id} index={0} y={4} className="px-0">
                <div className="group/row relative">
                  <button
                    onClick={() => onNavigate(h)}
                    title={h.query}
                    className={`flex w-full items-center ${dense ? "h-7 gap-2 text-[12.5px]" : "h-8 gap-2.5 text-[13px]"} rounded-[10px] pl-3 pr-9 text-left transition-colors ${
                      active ? "bg-accent font-medium text-foreground" : "text-foreground/75 hover:bg-accent/70 hover:text-foreground"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[h.status] ?? "bg-amber-500 pulse-dot"}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{h.query}</span>
                  </button>
                  <button
                    onClick={() => void remove(h)}
                    aria-label={`Delete "${h.query.slice(0, 40)}" from this browser (undoable)`}
                    title="Delete from this browser — undo available"
                    className={`absolute right-1 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors hover:bg-destructive/10 hover:text-destructive ${
                      touch ? "text-muted-foreground/60" : "text-muted-foreground/0 group-hover/row:text-muted-foreground/70"
                    } focus-visible:text-destructive`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </StaggerIn>
            );
          })}
        </div>
      ))}
    </>
  );
}

const BYOK_PRESETS: { label: string; baseUrl: string; model: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
  { label: "Gemini (OpenAI-compat)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.0-flash" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  { label: "Groq", baseUrl: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
];

function SettingsDialog({
  open, onOpenChange, endpoints, setEndpoints, searchSettings, setSearchSettings, onSave, savingPool, savingSearch, testEndpoint, testing, saveSearch, theme, setTheme, mounted,
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
  theme: string | undefined;
  setTheme: (t: string) => void;
  mounted: boolean;
}) {
  const [newInstance, setNewInstance] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass max-h-[85vh] overflow-y-auto rounded-[20px] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-primary" /> Settings</DialogTitle>
          <DialogDescription>
            Appearance, and the research backends — the keyless LLM failover chain,
            optional frontier keys, and the general-web search layer. Everything
            defaults to free and keyless — keys are optional upgrades.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {/* ---------- Appearance ---------- */}
          <div className="rounded-[16px] border p-4">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Appearance</p>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80">
                  {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </span>
                <div>
                  <p className="text-xs font-medium">Dark mode</p>
                  <p className="text-[11px] text-muted-foreground">Low-light theme across the app</p>
                </div>
              </div>
              <Switch
                checked={mounted ? theme === "dark" : false}
                onCheckedChange={(v) => setTheme(v ? "dark" : "light")}
                aria-label="Dark mode"
              />
            </div>
          </div>

          <div className="rounded-[16px] border p-4">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">Always-on keyless chain (auto mode order)</p>
            <div className="space-y-1.5 text-xs">
              <div className="flex items-center gap-2"><span className="font-mono text-primary">1 · GLM-5.3-Flash</span><span className="text-muted-foreground">z.ai SDK — primary</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">2 · GLM-4.5-Flash</span><span className="text-muted-foreground">z.ai SDK — default model</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">3 · LLM7 / GLM-5.3-Flash</span><span className="text-muted-foreground">api.llm7.io — keyless</span></div>
              <div className="flex items-center gap-2"><span className="font-mono text-primary">4 · Pollinations / gpt-oss-20b</span><span className="text-muted-foreground">text.pollinations.ai — keyless</span></div>
            </div>
          </div>

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

/**
 * The app shell — sidebar (desktop), menu button + sheet nav (mobile),
 * ⌘K palette, settings dialog and the global job signals. Wraps every page.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { sidebarOpen, toggleSidebar, mode, applyMode } = useSettings();

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customEndpoints, setCustomEndpoints] = useState<PoolEndpointUi[]>([]);
  const [searchSettings, setSearchSettings] = useState<SearchSettingsUi | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [savingPool, setSavingPool] = useState(false);
  const [savingSearch, setSavingSearch] = useState(false);

  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    void refreshHistory();
  }, []);

  // reset scroll on navigation (the thread page scrolls to its own position)
  useEffect(() => {
    if (!pathname.startsWith("/r/")) mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

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
  const openSettings = useCallback(() => {
    loadPool();
    setSettingsOpen(true);
  }, [loadPool]);

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

  // ⌘K palette + "/" focus shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        (document.getElementById("follow-input") ?? document.getElementById("ask-input"))?.focus();
      } else if (e.key.toLowerCase() === "n" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        router.push("/");
        setTimeout(() => document.getElementById("ask-input")?.focus(), 150);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // pages open the shared settings dialog through this event (composer's
  // "backends & web search" button and friends)
  useEffect(() => {
    const h = () => openSettings();
    window.addEventListener("digdeep:open-settings", h);
    return () => window.removeEventListener("digdeep:open-settings", h);
  }, [openSettings]);

  const openFromHistory = (h: HistoryItem) => {
    setMobileNavOpen(false);
    setPaletteOpen(false);
    if (h.threadId) router.push(`/r/${h.threadId}`);
    else router.push(`/r/${h.id}`);
  };

  const isThread = pathname.startsWith("/r/");
  const { history } = useHistory();

  return (
    <MotionConfig reducedMotion="user">
      {/* the floating window (>= 1180px): the app sits as a rounded panel, max
          ~1280x840, on a darker backdrop; smaller screens fill the viewport */}
      <div className="app-stage">
      <div className="app-window app-bg flex h-dvh overflow-hidden text-foreground">
        {/* ---------- DESKTOP SIDEBAR ---------- */}
        <aside
          className={`hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar backdrop-blur-xl transition-[width] duration-300 ease-apple md:flex ${
            sidebarOpen ? "w-[240px]" : "w-[64px]"
          }`}
        >
          <div className={`flex items-center py-2.5 ${sidebarOpen ? "px-3" : "justify-center px-2"}`}>
            {sidebarOpen ? (
              <>
                <LogoLockup markClass="h-7 w-7" textClass="text-[15px]" />
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
              <button
                onClick={toggleSidebar}
                className="press-scale mx-auto flex h-10 w-10 items-center justify-center rounded-[10px] text-foreground transition-colors hover:bg-accent/70"
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <LogoMark className="h-7 w-7" />
              </button>
            )}
          </div>
          <div className={sidebarOpen ? "px-3" : "px-1"}>
            <Link
              href="/"
              className={`press-scale flex items-center gap-2 rounded-[10px] text-[13px] font-semibold transition-colors ${
                sidebarOpen
                  ? "h-9 w-full justify-center bg-foreground text-background shadow-elev-2 hover:bg-foreground/85"
                  : "mx-auto h-10 w-10 justify-center px-0 text-foreground/70 hover:bg-accent/70 hover:text-foreground"
              }`}
              aria-label="New research"
              title="New research"
            >
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              {sidebarOpen && <span>New research</span>}
            </Link>
          </div>
          <nav className={`space-y-0.5 pt-1.5 ${sidebarOpen ? "px-3" : "px-1"}`} aria-label="Main">
            <SidebarItem compact collapsed={!sidebarOpen} icon={<House className="h-4 w-4" />} label="Home" active={pathname === "/"} href="/" onClick={() => {}} />
            <SidebarItem compact collapsed={!sidebarOpen} icon={<Compass className="h-4 w-4" />} label="Discover" active={pathname === "/discover"} href="/discover" onClick={() => {}} />
            <SidebarItem compact collapsed={!sidebarOpen} icon={<LibraryBig className="h-4 w-4" />} label="Library" active={pathname === "/library"} href="/library" onClick={() => {}} />
          </nav>

          {sidebarOpen && (
            <>
              <div aria-hidden className="mt-1.5 shrink-0 border-t border-sidebar-border" />
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-1 pt-0.5">
                <p className="px-3 pb-0.5 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">Recents</p>
                <Recents onNavigate={openFromHistory} dense />
                {history.length > 14 && (
                  <Link href="/library" className="mt-1 block px-3 py-1 text-xs text-primary hover:underline">
                    View all in Library →
                  </Link>
                )}
              </div>
            </>
          )}
          <div className={`mt-auto space-y-1 border-t border-sidebar-border pb-2.5 pt-1.5 ${sidebarOpen ? "px-3" : "px-1"}`}>
            <SidebarItem compact collapsed={!sidebarOpen} icon={<Settings className="h-4 w-4" />} label="Settings" onClick={openSettings} />
          </div>
        </aside>

        {/* ---------- MAIN ---------- */}
        <main ref={mainRef} className="slim-scroll relative flex-1 overflow-y-auto">
          <MainScrollContext.Provider value={mainRef}>
            {/* mobile top bar — glass nav with a menu button (the sidebar is a sheet on phones) */}
            <div className="glass-nav sticky top-0 z-30 flex items-center gap-1 px-3 py-3 md:hidden">
              <Button variant="ghost" size="icon" className="press-scale h-9 w-9 shrink-0 rounded-[12px]" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
                <Menu className="h-[18px] w-[18px]" />
              </Button>
              {isThread ? (
                <button onClick={() => router.push("/")} className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] hover:bg-accent" aria-label="Back to home">
                  <ArrowLeft className="h-4 w-4" />
                </button>
              ) : (
                <Link href="/" className="px-0" aria-label="DigDeep home">
                  <LogoLockup markClass="h-6 w-6" textClass="text-sm" />
                </Link>
              )}
              {isThread && <p className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium">Research thread</p>}
              {!isThread && <span className="flex-1" />}
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="icon" className="press-scale h-9 w-9 rounded-[12px]" onClick={() => router.push("/library")} aria-label="Library">
                  <LibraryBig className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {children}
          </MainScrollContext.Provider>
        </main>

        {/* ---------- MOBILE NAV SHEET ---------- */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="glass w-[300px] overflow-y-auto rounded-r-[20px] p-0 sm:rounded-none">
            <SheetHeader className="border-b border-border/60 px-3 pb-3">
              <SheetTitle>
                <LogoLockup markClass="h-6 w-6" textClass="text-[15px]" />
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-1 p-3">
              <Link
                href="/"
                onClick={() => setMobileNavOpen(false)}
                className="press-scale flex h-10 w-full items-center justify-center gap-2 rounded-[10px] bg-foreground text-[13px] font-semibold text-background shadow-elev-2"
              >
                <Plus className="h-4 w-4" strokeWidth={2.5} /> New research
              </Link>
            </div>
            <nav className="space-y-1 px-3 pt-1" aria-label="Mobile">
              <SidebarItem icon={<House className="h-[18px] w-[18px]" />} label="Home" active={pathname === "/"} href="/" onClick={() => setMobileNavOpen(false)} />
              <SidebarItem icon={<Compass className="h-[18px] w-[18px]" />} label="Discover" active={pathname === "/discover"} href="/discover" onClick={() => setMobileNavOpen(false)} />
              <SidebarItem icon={<LibraryBig className="h-[18px] w-[18px]" />} label="Library" active={pathname === "/library"} href="/library" onClick={() => setMobileNavOpen(false)} />
            </nav>
            <div className="mt-3 px-3">
              <p className="px-3 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">Recents</p>
              <Recents onNavigate={openFromHistory} touch />
            </div>
            <div className="mt-4 space-y-1 border-t border-border/60 p-3">
              <SidebarItem icon={<Settings className="h-[18px] w-[18px]" />} label="Settings" onClick={() => { setMobileNavOpen(false); openSettings(); }} />
            </div>
          </SheetContent>
        </Sheet>

        {/* ---------- ⌘K COMMAND PALETTE ---------- */}
        <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
          <CommandInput placeholder="Type a command or search…" />
          <CommandList>
            <CommandEmpty>Nothing found.</CommandEmpty>
            <CommandGroup heading="Actions">
              <CommandItem onSelect={() => { setPaletteOpen(false); router.push("/"); setTimeout(() => document.getElementById("ask-input")?.focus(), 120); }}>
                <Plus className="h-4 w-4" /> New research <CommandShortcut>⌘K then ↵</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => { setPaletteOpen(false); router.push("/discover"); }}>
                <Compass className="h-4 w-4" /> Discover — trending on the web
              </CommandItem>
              <CommandItem onSelect={() => { setPaletteOpen(false); router.push("/library"); }}>
                <LibraryBig className="h-4 w-4" /> Library — saved threads
              </CommandItem>
              <CommandItem onSelect={() => { setPaletteOpen(false); setTheme(theme === "dark" ? "light" : "dark"); }}>
                {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {mounted && theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              </CommandItem>
              <CommandItem onSelect={() => { setPaletteOpen(false); openSettings(); }}>
                <Settings2 className="h-4 w-4" /> Settings — backends, search &amp; theme
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Research depth">
              {MODES.map((m) => (
                <CommandItem key={m.id} onSelect={() => { setPaletteOpen(false); applyMode(m.id); }}>
                  <Gauge className="h-4 w-4" />
                  {m.label} <span className="text-muted-foreground">· {m.hint}</span>
                  {mode === m.id && <CommandShortcut>current</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
            {history.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Recent threads">
                  {history.slice(0, 6).map((h) => (
                    <CommandItem key={h.id} onSelect={() => openFromHistory(h)}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[h.status] ?? "bg-amber-500"}`} />
                      <span className="truncate">{h.query}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </CommandDialog>

        {/* ---------- SETTINGS DIALOG (appearance + backends + search) ---------- */}
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
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
          theme={theme}
          setTheme={setTheme}
          mounted={mounted}
        />

        {/* favicon states + browser notifications — mounted once, route-proof */}
        <JobSignals />
      </div>
      </div>
    </MotionConfig>
  );
}
