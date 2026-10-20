"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronsDown, ChevronsUp, Compass, Eye, Loader2, Plus, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AskBox } from "@/components/pplx/ask-box";
import { ThreadTurn } from "@/components/pplx/turn";
import { ThreadErrorBoundary } from "@/components/pplx/thread-error-boundary";
import { SourcesPanel } from "@/components/pplx/sources-row";
import { Toc } from "@/components/research/toc";
import { EvidencePanel } from "@/components/research/evidence-panel";
import { useMainScroll } from "@/components/app/shell";
import { CountUp } from "@/components/magic";
import { useOnline } from "@/hooks/use-online";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import type { AttachedDoc, HistoryItem, Turn } from "@/components/research/types";
import { ACTIVE_STATUSES, fmtElapsed } from "@/components/research/types";
import type { ClaimSelection } from "@/components/research/citation-chip";
import { getThreadTurns, saveTurn } from "@/lib/idb-store";
import { registerJob, watchJob, resetJob } from "@/lib/live-poller";
import { startResearchRun } from "@/lib/research-client";
import { useSettings, refreshHistory } from "@/lib/store";
import { parseAnswer, extractHeadings } from "@/lib/report-parse";
import { toast } from "@/hooks/use-toast";

/** Day bucket for the chat-flow date separators (Today / Yesterday / weekday / date). */
function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.floor((startOf(now) - startOf(d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const mainRef = useMainScroll();
  const settings = useSettings();
  const online = useOnline();

  const [turns, setTurns] = useState<Turn[] | null>(null); // null = loading
  const [threadId, setThreadId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [followQuery, setFollowQuery] = useState("");
  const [followDocs, setFollowDocs] = useState<AttachedDoc[]>([]);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [showTop, setShowTop] = useState(false);

  // ---------- claim evidence (Phase 2) ----------
  const [sel, setSel] = useState<ClaimSelection | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const lastChipRef = useRef<HTMLElement | null>(null);
  /** Focus the claim's chip — looked up fresh by id: a held element ref can go
   *  stale across re-renders, and a detached node silently eats the focus. */
  const focusLastChip = useCallback(() => {
    const el = lastChipRef.current;
    const live = el && document.getElementById(`cite-${el.dataset?.citeN ?? ""}`);
    (live ?? el)?.focus({ preventScroll: true });
  }, []);
  const isDesktopRail = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches;

  /** The claim list to navigate through: the owner of the current selection,
   *  or the last completed report that has a ledger. */
  const claimNavList = useMemo(() => {
    if (sel?.allChecks?.length) return sel.allChecks;
    const withChecks = [...(turns ?? [])].reverse().find((t) => t.job?.stats?.claimChecks?.length);
    return withChecks?.job?.stats?.claimChecks ?? [];
  }, [sel, turns]);

  const focusChipOf = useCallback((checkId: string | undefined, n: number) => {
    if (!checkId) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`cite-${n}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      (el as HTMLElement | null)?.focus({ preventScroll: true });
    });
  }, []);

  const selectClaim = useCallback(
    (payload: ClaimSelection, chipEl: HTMLElement) => {
      chipEl.dataset.citeN = String(payload.check.n);
      lastChipRef.current = chipEl;
      setSel(payload);
      if (!isDesktopRail()) setSheetOpen(true);
    },
    []
  );

  /** The report that owns claim navigation (the selection's owner, or the last
   *  completed report that has a ledger) — used to rebuild the full payload. */
  const claimOwnerTurn = useMemo(() => {
    if (sel) {
      const owner = (turns ?? []).find((t) => t.job?.stats?.claimChecks?.some((c) => c.id === sel.check.id));
      if (owner) return owner;
    }
    return [...(turns ?? [])].reverse().find((t) => t.job?.stats?.claimChecks?.length);
  }, [sel, turns]);

  const moveClaim = useCallback(
    (dir: 1 | -1) => {
      const list = claimNavList;
      if (list.length === 0) return;
      const curIdx = sel ? list.findIndex((c) => c.id === sel.check.id) : -1;
      const nextIdx = curIdx < 0 && dir === -1 ? list.length - 1 : Math.min(list.length - 1, Math.max(0, curIdx + dir));
      const check = list[nextIdx];
      if (!check) return;
      setSel((prev) => {
        if (prev) return { ...prev, check };
        // first selection via keyboard — rebuild the payload from the owner report
        const owner = claimOwnerTurn;
        if (!owner?.job?.reportMd) return prev;
        try {
          const parsed = parseAnswer(owner.job.reportMd, owner.job.mode);
          return {
            check,
            refs: parsed.refs,
            sources: owner.sources,
            reportMd: owner.job.reportMd,
            allChecks: owner.job.stats?.claimChecks,
            summaryLine: owner.job.stats?.claimVerdict
              ? `${owner.job.stats.claimVerdict.fullySupported} of ${owner.job.stats.claimVerdict.citedSources} sources fully support their claims`
              : undefined,
          };
        } catch {
          return prev; // v3.0.3: a poison report can never crash the keyboard flow
        }
      });
      focusChipOf(check.id, check.n);
    },
    [claimNavList, sel, focusChipOf, claimOwnerTurn]
  );

  // J / K claim navigation + Esc closes the evidence panel (keyboard-only flow)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement || (t as HTMLElement | null)?.isContentEditable;
      if (typing) return;
      if (e.key === "Escape" && (sel || sheetOpen)) {
        setSel(null);
        setSheetOpen(false);
        setTimeout(focusLastChip, 120);
        setTimeout(focusLastChip, 650);
        return;
      }
      if (claimNavList.length === 0) return;
      const k = e.key.toLowerCase();
      if (k === "j") { e.preventDefault(); moveClaim(1); }
      else if (k === "k") { e.preventDefault(); moveClaim(-1); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [claimNavList, sel, sheetOpen, moveClaim]);

  const unwatches = useRef<Map<string, () => void>>(new Map());
  const watch = useCallback((jobId: string) => {
    if (unwatches.current.has(jobId)) return;
    const un = watchJob(jobId, (t) => {
      setTurns((prev) => {
        if (!prev) return [t];
        const i = prev.findIndex((x) => x.jobId === jobId);
        if (i >= 0) {
          if (prev[i] === t) return prev; // identical snapshot — nothing changed, no re-render
          const next = [...prev];
          next[i] = t;
          return next;
        }
        return [...prev, t];
      });
    });
    unwatches.current.set(jobId, un);
  }, []);

  // ---------- load the thread (IndexedDB first, server merge, legacy ids, shared snapshots) ----------
  useEffect(() => {
    let cancelled = false;
    unwatches.current.forEach((un) => un());
    unwatches.current.clear();
    setTurns(null);
    setNotFound(false);
    setLoadError(false);
    setThreadId(null);

    (async () => {
      const tid = Array.isArray(id) ? id[0] : id;
      let loaded = await getThreadTurns(tid);
      let resolvedThreadId: string | null = null;
      let sawServer: boolean | null = null; // null = not tried, false = unreachable

      // merge server-side turns this browser doesn't have (shared URLs, other browsers)
      if (!navigator.onLine) {
        sawServer = false;
      } else {
        try {
          const r = await fetch(`/api/research?threadId=${encodeURIComponent(tid)}`);
          const d = await r.json();
          sawServer = true;
          const jobs: HistoryItem[] = d.jobs ?? [];
          const localIds = new Set(loaded.map((t) => t.jobId));
          const missing = jobs.filter((j) => !localIds.has(j.id));
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
          if (jobs.length > 0) resolvedThreadId = tid;
        } catch {
          sawServer = false; // server unreachable while online — can't tell "unknown" from "down"
        }
      }

      // legacy single-run link (a bare jobId, no thread)
      if (loaded.length === 0 && resolvedThreadId == null && sawServer !== false) {
        try {
          const detail = await fetch(`/api/research/${encodeURIComponent(tid)}`).then((x) => (x.ok ? x.json() : null));
          if (detail?.job) {
            loaded = [{
              jobId: tid,
              job: detail.job,
              events: detail.events ?? [],
              sources: detail.sources ?? [],
              sections: detail.sections ?? [],
            }];
          }
        } catch { /* ignore */ }
      }

      // shared read-only snapshot (/r/s-<shareId>) — opens for anyone, any browser
      if (loaded.length === 0 && tid.startsWith("s-") && sawServer !== false) {
        try {
          const snap = await fetch(`/api/share/${encodeURIComponent(tid.slice(2))}`).then((x) => (x.ok ? x.json() : null));
          if (snap?.job) {
            loaded = [{ jobId: tid, job: snap.job, events: [], sources: snap.sources ?? [], sections: [] }];
            resolvedThreadId = tid;
          }
        } catch { /* offline — fall through to error state */ }
      }

      if (cancelled) return;
      if (loaded.length === 0) {
        // nothing anywhere — say which kind of nothing, with a recovery action
        if (sawServer === false) {
          setLoadError(true); // offline: the browser copy may exist after reconnect… but here it doesn't
        }
        setNotFound(true);
        setTurns([]);
        return;
      }

      // v3.2 — refresh COMPLETED turns from the server (the "sources never
      // open" fix). IndexedDB copies of finished runs are write-once: the
      // poller stops when a run completes, so a copy saved a moment BEFORE the
      // final sources landed (or adopted with partial data) keeps showing an
      // empty/stale sources row forever. The server is the source of truth
      // for finished runs — re-fetch each completed non-shared turn and take
      // the richer copy. Active turns are skipped (the poller owns them).
      if (navigator.onLine) {
        const refreshable = loaded.filter(
          (t) => t.job && !t.job.sharedSnapshot && !ACTIVE_STATUSES.includes(t.job.status)
        );
        if (refreshable.length > 0) {
          const fresh = await Promise.all(
            refreshable.map(async (t) => {
              try {
                const d = await fetch(`/api/research/${t.jobId}`).then((x) => (x.ok ? x.json() : null));
                if (!d?.job) return null;
                const serverTurn: Turn = {
                  jobId: t.jobId,
                  job: d.job,
                  events: (d.events ?? []) as Turn["events"],
                  sources: (d.sources ?? []) as Turn["sources"],
                  sections: (d.sections ?? []) as Turn["sections"],
                };
                // keep whichever copy knows more — server for a finished run
                // has the final report+sources, but a flaky response or an
                // older server snapshot should never LOSE local data
                const localBetter =
                  serverTurn.sources.length < (t.sources?.length ?? 0) ||
                  serverTurn.events.length < (t.events?.length ?? 0);
                return localBetter ? null : serverTurn;
              } catch {
                return null; // offline mid-load — the IDB copy stands
              }
            })
          );
          fresh.forEach((ft) => {
            if (!ft) return;
            const idx = loaded.findIndex((x) => x.jobId === ft.jobId);
            if (idx >= 0) loaded[idx] = ft;
          });
        }
      }

      const isShared = loaded.some((t) => t.job?.sharedSnapshot);
      for (const t of loaded) {
        if (isShared) {
          // shared snapshots are frozen — persist locally so a reopen works offline,
          // but never register with the poller (nothing to poll on a completed run)
          if (t.job) void saveTurn(t);
        } else {
          registerJob(t.jobId, t);
          watch(t.jobId);
          if (t.job) void saveTurn(t);
        }
      }
      setTurns(loaded);
      setThreadId(resolvedThreadId ?? (loaded[0]?.job?.threadId ?? null));
      // land on the latest turn
      requestAnimationFrame(() => {
        const el = mainRef?.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [id, reloadNonce]);

  useEffect(() => {
    return () => {
      unwatches.current.forEach((un) => un());
      unwatches.current.clear();
    };
  }, []);

  const anyActive = turns?.some((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status)) ?? false;
  const isShared = turns?.some((t) => t.job?.sharedSnapshot) ?? false;
  const sharedAt = turns?.find((t) => t.job?.sharedSnapshot)?.job?.sharedAt ?? null;
  useEffect(() => {
    if (!anyActive) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [anyActive]);

  // the tab title follows the open question — you can find the run in a
  // wall of tabs without reading URLs
  useEffect(() => {
    const q = turns?.[0]?.job?.query;
    if (!q) return;
    const prev = document.title;
    document.title = `${q.slice(0, 60)}${q.length > 60 ? "…" : ""}${anyActive ? " · digging" : ""} — DigDeep`;
    return () => {
      document.title = prev;
    };
  }, [turns?.[0]?.job?.query, anyActive]);

  const turnElapsed = (t: Turn): number => {
    const j = t.job;
    if (!j?.startedAt) return 0;
    const end = j.completedAt ? new Date(j.completedAt).getTime() : now;
    return end - new Date(j.startedAt).getTime();
  };

  const lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;

  // report sections → right-rail TOC
  // v3.0.3: this memo runs at PAGE level, outside the per-turn error boundary —
  // a throw here white-screens the whole thread. parseAnswer is hardened, and
  // this try/catch is the belt-and-braces so no future parser bug can kill the page.
  const tocHeadings = useMemo(() => {
    if (!lastTurn?.job || lastTurn.job.status !== "completed" || !lastTurn.job.reportMd) return [];
    try {
      const parsed = parseAnswer(lastTurn.job.reportMd, lastTurn.job.mode);
      // the verdict card renders the jury/foreman/judge sections — the body (and
      // therefore the TOC) drops them so the record is never shown twice
      const body = lastTurn.job.stats?.court ? parsed.body.replace(/## The Jury[\s\S]*?(?=## The Evidence Record)/, "") : parsed.body;
      return extractHeadings(body);
    } catch {
      return [];
    }
  }, [lastTurn?.job]);

  // ---------- scrolling: intent-aware follow + jump pill ----------
  // Follow is INTENT, not distance. The old distance hysteresis (unpin only
  // past 160px away) misread a small upward scroll as "still at the bottom",
  // so the DOM observer kept snapping the reader back down mid-scroll — the
  // page "fought" anyone who tried to scroll up while streaming. Now ANY
  // upward movement (delta < -3px, i.e. real intent, not sub-pixel jitter)
  // releases the pin instantly; touching the bottom re-pins. Programmatic
  // smooth scrolls are tracked in jumpingRef so their own animation frames
  // are never misread as reader intent, and never outlive ~1s (content grows
  // under a flight and moves the target — the observer must resume after).
  const pinnedRef = useRef(true);
  const lastTopRef = useRef(-1);
  const jumpingRef = useRef(false);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const el = mainRef?.current;
      if (!el) return;
      pinnedRef.current = true;
      if (smooth) {
        jumpingRef.current = true;
        setTimeout(() => {
          jumpingRef.current = false;
        }, 900);
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        jumpingRef.current = false;
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      }
    },
    [mainRef]
  );

  /** Jump to the FIRST message of the conversation — the mirror flight of
   *  scrollToBottom. Reading from the top means NOT pinned: the stream must
   * not yank the reader back down while they re-read the opening turn. */
  const scrollToTop = useCallback(
    (smooth = true) => {
      const el = mainRef?.current;
      if (!el) return;
      pinnedRef.current = false;
      if (smooth) {
        jumpingRef.current = true;
        setTimeout(() => {
          jumpingRef.current = false;
        }, 1200);
        el.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        jumpingRef.current = false;
        el.scrollTo({ top: 0, behavior: "auto" });
      }
    },
    [mainRef]
  );

  useEffect(() => {
    const el = mainRef?.current;
    if (!el || turns == null) return;
    pinnedRef.current = true;
    lastTopRef.current = -1;
    jumpingRef.current = false;
    const onScroll = () => {
      const away = el.scrollHeight - el.scrollTop - el.clientHeight;
      const delta = el.scrollTop - lastTopRef.current;
      lastTopRef.current = el.scrollTop;
      if (delta < -3) {
        // upward movement — the reader's intent beats everything, including
        // an in-flight programmatic scroll
        jumpingRef.current = false;
        pinnedRef.current = false;
      } else if (jumpingRef.current) {
        if (away <= 8) jumpingRef.current = false; // our smooth flight landed
      } else if (away <= 24) {
        pinnedRef.current = true; // touched bottom — follow again
      }
      // show the latest pill once meaningfully away from the bottom, hide only
      // clearly near it; the FIRST-message pill mirrors that at the top
      // (hysteresis keeps both from flickering at their thresholds)
      setShowJump((prev) => (prev ? !(pinnedRef.current || away <= 90) : !pinnedRef.current && away >= 140));
      setShowTop((prev) => (prev ? el.scrollTop > 300 : el.scrollTop > 700));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [turns == null, mainRef]);

  // A new turn or a completed-view swap grows the page by whole sections at
  // once — when the reader is pinned, land on the new bottom instantly. (A
  // smooth chase across thousands of fresh pixels is the rubber-band lag.)
  useEffect(() => {
    const el = mainRef?.current;
    if (!el || !turns) return;
    if (pinnedRef.current && !jumpingRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [turns?.length, lastTurn?.job?.status, lastTurn?.sections?.length]);

  // Content growth doesn't fire scroll events — the typing animation can pour
  // text past the fold with no follow and no jump pill. Watch the DOM: while
  // the reader is pinned (and no smooth flight is running), stay glued to the
  // newest line, instant like every chat app. The moment they scroll away,
  // stop following — no setState in here: the scrollTop write itself fires
  // the scroll handler above, which owns the pill.
  useEffect(() => {
    const el = mainRef?.current;
    if (!el || turns == null) return;
    const mo = new MutationObserver(() => {
      if (pinnedRef.current && !jumpingRef.current) {
        el.scrollTop = el.scrollHeight; // instant — a smooth queue would lag behind every frame
      }
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [turns == null, mainRef]);

  // ---------- follow-up draft: survives navigation away and back ----------
  const draftKey = threadId ? `digdeep:draft:${threadId}` : null;
  const followQueryRef = useRef(followQuery);
  followQueryRef.current = followQuery;
  useEffect(() => {
    if (!draftKey) return;
    const saved = sessionStorage.getItem(draftKey);
    if (saved && !followQueryRef.current) setFollowQuery(saved);
    // restore runs once per resolved thread — never clobbers what the user typed
     
  }, [draftKey]);
  useEffect(() => {
    if (!draftKey) return;
    if (followQuery) sessionStorage.setItem(draftKey, followQuery);
    else sessionStorage.removeItem(draftKey);
  }, [draftKey, followQuery]);

  // ---------- actions ----------
  const submitFollowUp = async () => {
    const question = followQuery.trim();
    if (question.length < 3 || !threadId) {
      if (!threadId) {
        // legacy single-run thread without an id — start a fresh thread
        router.push("/");
        return;
      }
      return;
    }
    setStarting(true);
    const res = await startResearchRun({ query: question, threadId, docs: followDocs });
    setStarting(false);
    if ("error" in res) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    const nt: Turn = { jobId: res.id, job: null, events: [], sources: [], sections: [] };
    // order matters: append FIRST, then subscribe — the watcher's synchronous
    // initial callback must find the turn in state (or it would append a phantom)
    setTurns((prev) => [...(prev ?? []), nt]);
    registerJob(res.id, nt);
    watch(res.id);
    setFollowQuery("");
    setFollowDocs([]);
    void refreshHistory();
    requestAnimationFrame(() => scrollToBottom(true));
  };

  const stopJob = async (jobId: string) => {
    try {
      await fetch(`/api/research/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      toast({ title: "Stopping — the agent halts at its next checkpoint" });
    } catch { /* ignore */ }
  };

  const stopAllActive = async () => {
    const ids = (turns ?? []).filter((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status)).map((t) => t.jobId);
    if (ids.length === 0) return;
    setStoppingAll(true);
    try {
      await Promise.all(ids.map((jid) => fetch(`/api/research/${jid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }).catch(() => null)));
      toast({ title: "Stopping — the agent halts at its next checkpoint" });
    } finally {
      setStoppingAll(false);
    }
  };

  const retryJob = async (jobId: string) => {
    try {
      const r = await fetch(`/api/research/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry" }) });
      if (r.ok) {
        resetJob(jobId);
        toast({ title: "Retrying research run" });
      }
    } catch { /* ignore */ }
  };

  // ---------- not found / offline ----------
  if (notFound) {
    return (
      <div className="flex min-h-[70vh] w-full flex-col items-center justify-center gap-4 px-4 text-center">
        <span
          className={`flex h-16 w-16 items-center justify-center rounded-[20px] ${loadError ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}
          aria-hidden
        >
          {loadError ? <WifiOff className="h-8 w-8" strokeWidth={1.8} /> : <Compass className="h-8 w-8" strokeWidth={1.8} />}
        </span>
        <div>
          <p className="text-[15px] font-semibold">
            {loadError ? "Can't reach the server right now" : "Report not found"}
          </p>
          <p className="mx-auto mt-1.5 max-w-[380px] text-[12.5px] leading-relaxed text-muted-foreground">
            {loadError ? (
              <>
                This link was not saved in this browser, so the report can only come from the server — and the
                server can't be reached. Check your connection, then try again. Anything you ran here is safe.
              </>
            ) : (
              <>
                Nothing matches this link — not in this browser and not on the server. Reports live in the browser
                that created them; from the report page, Share saves a read-only snapshot anyone can open.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {loadError && (
            <Button className="press-scale rounded-full" onClick={() => setReloadNonce((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          )}
          <Button variant={loadError ? "outline" : "default"} className="press-scale rounded-full" onClick={() => router.push("/")}>
            <ArrowLeft className="h-4 w-4" /> New research
          </Button>
        </div>
        {!loadError && !online && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <WifiOff className="h-3.5 w-3.5" aria-hidden /> You're offline — recovery actions work again once reconnected.
          </p>
        )}
      </div>
    );
  }

  // ---------- loading ----------
  if (turns == null) {
    return (
      /* v3.1: same 1140 + 88% axis as the live thread — the skeleton sits
         exactly where the conversation will land, no center-jump on swap. */
      <div className="mx-auto w-full max-w-[1180px] px-4 pb-20 pt-7" aria-label="Loading thread">
        <div className="mx-auto flex w-full justify-center gap-7">
          <div className="w-full max-w-[max(min(812px,88%),420px)] space-y-3.5">
            <div className="flex justify-end">
              <div className="skeleton-line h-10 w-2/3 rounded-[22px]" />
            </div>
            <div className="skeleton-line h-24 rounded-[20px]" />
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* desktop toolbar — glass over content, back + thread title */}
      <div className="glass-nav sticky top-0 z-30 hidden items-center gap-1 px-4 py-2 md:flex">
        <Button variant="ghost" size="icon" className="press-scale h-9 w-9 shrink-0 rounded-[12px]" onClick={() => router.push("/")} aria-label="Back to home" title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate px-2 text-center text-[13px] font-medium text-foreground/85">
          {turns[0]?.job?.query ?? "Research thread"}
        </p>
        {isShared ? (
          <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <Eye className="h-3.5 w-3.5" aria-hidden /> shared · read-only
          </span>
        ) : anyActive ? (
          <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            <span className="pplx-dot h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> live
          </span>
        ) : null}
      </div>

      {/* shared snapshot banner — the read-only state, said plainly */}
      {isShared && (
        /* v3.1: banner rides the conversation axis (1140 wrapper + rail-sized
           spacer at xl) — not viewport-center, so it opens flush above the
           widened column instead of offset beside the evidence rail. */
        <div className="mx-auto w-full max-w-[1180px] px-4 pt-5 sm:pt-6">
          <div className="mx-auto flex w-full justify-center gap-7">
            <div
              role="note"
              className="flex w-full max-w-[max(min(812px,88%),420px)] items-start gap-2.5 rounded-[16px] border border-border/70 bg-muted/40 px-4 py-3"
            >
              <Eye className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">Shared, read-only snapshot.</span> Saved
                {sharedAt ? ` ${new Date(sharedAt).toLocaleDateString()}` : ""} by whoever shared it — the report,
                sources and claim evidence travel with the link. Follow-ups start a new thread in your browser.
              </p>
            </div>
            <div aria-hidden className="hidden w-[300px] shrink-0 xl:block" />
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-[1180px] justify-center gap-7 px-4 pb-40 pt-5 sm:pt-6">
        {/* turns — one chat flow; date separators mark day boundaries.
            v3.1: widened to 812px / 88% (was 768/50% — the column read
            cramped at 570px on desktop). 812 = 1140 container minus the
            300px evidence rail and its gap, so at xl the conversation fills
            the space beside the rail exactly. 420px floor keeps phones full. */}
        <div className="mx-auto w-full max-w-[max(min(812px,88%),420px)] space-y-8">
          {turns.map((t, i) => {
            const day = t.job?.createdAt ? dayKey(t.job.createdAt) : null;
            const prevDay = i > 0 && turns[i - 1].job?.createdAt ? dayKey(turns[i - 1].job!.createdAt!) : null;
            const newDay = i > 0 && day != null && day !== prevDay;
            return (
              <ThreadErrorBoundary key={t.jobId}>
                <div>
                  {newDay && (
                    <div className="mb-7 flex items-center gap-3" aria-hidden="true">
                      <span className="h-px flex-1 bg-border/70" />
                      <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                        {dayLabel(t.job!.createdAt!)}
                      </span>
                      <span className="h-px flex-1 bg-border/70" />
                    </div>
                  )}
                  <ThreadTurn
                    turn={t}
                    showThinking={settings.showThinking}
                    now={now}
                    elapsedMs={turnElapsed(t)}
                    onStop={() => void stopJob(t.jobId)}
                    onRetry={() => void retryJob(t.jobId)}
                    onFollowUp={(q) => void startFollowUpFrom(q)}
                    onRerun={(q) => void startFollowUpFrom(q)}
                    animate={ACTIVE_STATUSES.includes(t.job?.status ?? "") || !t.job}
                    onSelectClaim={selectClaim}
                    selectedClaimId={sel?.check.id}
                  />
                </div>
              </ThreadErrorBoundary>
            );
          })}
        </div>

        {/* right rail (xl) — claim evidence FIRST, then sources, then TOC */}
        {lastTurn && (
          <ThreadErrorBoundary>
            <aside aria-label="Report tools — claim evidence, sources and outline" className="sticky top-16 hidden h-fit w-[300px] shrink-0 space-y-6 xl:block">
            {sel ? (
              <div id="evidence-panel">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">Claim evidence</p>
                <EvidencePanel
                  selection={sel}
                  index={claimNavList.findIndex((c) => c.id === sel.check.id)}
                  total={claimNavList.length}
                  onPrev={() => moveClaim(-1)}
                  onNext={() => moveClaim(1)}
                  onGoDeeper={(claimText) => void startFollowUpFrom(`Dig deeper: ${claimText.slice(0, 180)}`)}
                />
              </div>
            ) : lastTurn.job?.stats?.claimChecks?.length ? (
              <p className="rounded-[14px] border border-dashed px-3.5 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                Select any citation to see the passage it rests on — J/K move through claims, Esc closes.
              </p>
            ) : null}

            {lastTurn.sources.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                  {anyActive && (
                    <span className="mr-1.5 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-primary">
                      <span className="pplx-dot h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> live
                    </span>
                  )}
                  Sources · <CountUp to={lastTurn.sources.length} duration={0.8} />
                </p>
                <div className="slim-scroll max-h-[calc(100dvh-16rem)] space-y-2 overflow-y-auto pr-1">
                  <SourcesPanel sources={lastTurn.sources} audit={lastTurn.job?.stats?.citationAudit} />
                </div>
              </div>
            )}

            {tocHeadings.length > 0 && <Toc headings={tocHeadings} />}

            {anyActive && lastTurn.job?.startedAt && (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {fmtElapsed(turnElapsed(lastTurn))} elapsed · honest ETA in steps
              </p>
            )}
            </aside>
          </ThreadErrorBoundary>
        )}
      </div>

      {/* follow-up input (pinned bottom dock) — or the read-only CTA on shared
          snapshots. v3.1 AXIS MIRROR: the dock reproduces the chat area's
          exact geometry — 1140 container, center flex, 28px gap, 300px
          rail-sized spacer at xl — so the composer sits flush on the
          conversation column at EVERY breakpoint. (Before, the dock was
          viewport-centered while the column sat left of center beside the
          evidence rail — a 164px axis mismatch at xl.) The composer now also
          spans the column edge-to-edge: its sides align with the messages
          above it. Jump icons hang above the composer, icon-only by design:
          ↓ latest (live dot while a run is active), ↑ first message. */}
      <div className="glass-dock sticky bottom-0 z-20">
        <div className="mx-auto w-full max-w-[1180px] px-4">
          <div className="relative mx-auto flex w-full justify-center gap-7">
            <div className="relative w-full max-w-[max(min(812px,88%),420px)]">
          {(showJump || showTop) && (
            <div className="absolute -top-[58px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2">
              {showTop && (
                <button
                  onClick={() => scrollToTop(true)}
                  className="glass spring-pop press-scale flex h-9 w-9 items-center justify-center rounded-full text-foreground shadow-elev-2"
                  aria-label="Jump to the first message"
                  title="Jump to the first message"
                >
                  <ChevronsUp className="h-[18px] w-[18px]" />
                </button>
              )}
              {showJump && (
                <button
                  onClick={() => scrollToBottom(true)}
                  className={`glass spring-pop press-scale relative flex h-9 w-9 items-center justify-center rounded-full shadow-elev-2 ${
                    anyActive ? "text-primary" : "text-foreground"
                  }`}
                  aria-label="Jump to latest"
                  title="Jump to latest"
                >
                  {anyActive && <span className="pplx-dot absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" aria-hidden />}
                  <ChevronsDown className="h-[18px] w-[18px]" />
                </button>
              )}
            </div>
          )}
          {isShared ? (
            <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-3">
              <p className="mr-1 text-[12.5px] text-muted-foreground">This snapshot is read-only.</p>
              <Button
                size="sm"
                className="press-scale rounded-full"
                onClick={() => {
                  const q = turns[0]?.job?.query;
                  if (q) sessionStorage.setItem("digdeep:prefill", q);
                  router.push("/");
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Start a new research from this question
              </Button>
            </div>
          ) : (
            /* py only — the composer spans the conversation column edge-to-edge,
               its sides flush with the messages above (v3.1 alignment). */
            <div className="py-3">
              <AskBox
                value={followQuery}
                onChange={setFollowQuery}
                onSubmit={() => void submitFollowUp()}
                busy={starting}
                compact
                placeholder={anyActive ? "Working… you can stop it, or queue a follow-up" : "Ask a follow-up…"}
                mode={settings.mode}
                onMode={settings.applyMode}
                adv={settings.adv}
                advTouched={settings.advTouched}
                onAdv={settings.changeAdv}
                language={settings.language}
                onLanguage={settings.setLanguage}
                modelPref={settings.modelPref}
                onModelPref={settings.setModelPref}
                showThinking={settings.showThinking}
                onShowThinking={settings.setShowThinking}
                court={settings.court}
                onCourt={settings.setCourt}
                domain={settings.domain}
                onDomain={settings.setDomain}
                onManagePool={() => window.dispatchEvent(new CustomEvent("digdeep:open-settings"))}
                docs={followDocs}
                onDocs={setFollowDocs}
                stopMode={anyActive}
                onStop={() => void stopAllActive()}
                stopping={stoppingAll}
                inputId="follow-input"
              />
              <p className="kbd-hints mt-2 flex items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><kbd>/</kbd> focus</span>
                <span className="inline-flex items-center gap-1"><kbd>⌘K</kbd> commands</span>
                <span className="inline-flex items-center gap-1"><kbd>J</kbd>/<kbd>K</kbd> claim evidence</span>
                <span className="inline-flex items-center gap-1"><kbd>Esc</kbd> close</span>
              </p>
            </div>
          )}
            </div>
            {/* rail-sized ghost — keeps the composer on the conversation axis at xl */}
            <div aria-hidden className="hidden w-[300px] shrink-0 xl:block" />
          </div>
        </div>
      </div>
      {/* claim evidence bottom sheet — phones and tablets (below xl rail). Closing returns focus to the claim chip. */}
      <Drawer
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o); // the selection itself persists — J/K still work after close
          // Return focus to the claim chip. The sheet's unmount pass steals
          // focus back to body mid-way through the exit transition, so the
          // restore runs twice: just after close, and after the exit settles.
          if (!o) {
            setTimeout(focusLastChip, 120);
            setTimeout(focusLastChip, 650);
          }
        }}
      >
        <DrawerContent className="max-h-[82dvh] rounded-t-[22px] px-0 pb-2">
          <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
          <DrawerTitle className="sr-only">Claim evidence</DrawerTitle>
          <DrawerDescription className="sr-only">The passage, source and support ratio behind the selected claim.</DrawerDescription>
          <div className="max-h-[70dvh] overflow-y-auto px-2">
            {sel && (
              <EvidencePanel
                inSheet
                selection={sel}
                index={claimNavList.findIndex((c) => c.id === sel.check.id)}
                total={claimNavList.length}
                onPrev={() => moveClaim(-1)}
                onNext={() => moveClaim(1)}
                onGoDeeper={(claimText) => {
                  setSheetOpen(false);
                  void startFollowUpFrom(`Dig deeper: ${claimText.slice(0, 180)}`);
                }}
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
  async function startFollowUpFrom(q: string) {
    if (!threadId) {
      sessionStorage.setItem("digdeep:prefill", q);
      router.push("/");
      return;
    }
    setStarting(true);
    const res = await startResearchRun({ query: q, threadId });
    setStarting(false);
    if ("error" in res) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    const nt: Turn = { jobId: res.id, job: null, events: [], sources: [], sections: [] };
    // append before subscribing — same ordering rule as submitFollowUp
    setTurns((prev) => [...(prev ?? []), nt]);
    registerJob(res.id, nt);
    watch(res.id);
    void refreshHistory();
    requestAnimationFrame(() => scrollToBottom(true));
  }
}
