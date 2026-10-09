"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, Compass, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AskBox } from "@/components/pplx/ask-box";
import { ThreadTurn } from "@/components/pplx/turn";
import { SourcesPanel } from "@/components/pplx/sources-row";
import { Toc } from "@/components/research/toc";
import { useMainScroll } from "@/components/app/shell";
import { CountUp } from "@/components/magic";
import type { AttachedDoc, HistoryItem, Turn } from "@/components/research/types";
import { ACTIVE_STATUSES, fmtElapsed } from "@/components/research/types";
import { getThreadTurns, saveTurn } from "@/lib/idb-store";
import { registerJob, watchJob, resetJob } from "@/lib/live-poller";
import { startResearchRun } from "@/lib/research-client";
import { useSettings, refreshHistory } from "@/lib/store";
import { parseAnswer, extractHeadings } from "@/lib/report-parse";
import { toast } from "@/hooks/use-toast";

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const mainRef = useMainScroll();
  const settings = useSettings();

  const [turns, setTurns] = useState<Turn[] | null>(null); // null = loading
  const [threadId, setThreadId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [followQuery, setFollowQuery] = useState("");
  const [followDocs, setFollowDocs] = useState<AttachedDoc[]>([]);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [showJump, setShowJump] = useState(false);

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

  // ---------- load the thread (IndexedDB first, server merge, legacy ids) ----------
  useEffect(() => {
    let cancelled = false;
    unwatches.current.forEach((un) => un());
    unwatches.current.clear();
    setTurns(null);
    setNotFound(false);
    setThreadId(null);

    (async () => {
      const tid = Array.isArray(id) ? id[0] : id;
      let loaded = await getThreadTurns(tid);
      let resolvedThreadId: string | null = null;

      // merge server-side turns this browser doesn't have (shared URLs, other browsers)
      try {
        const r = await fetch(`/api/research?threadId=${encodeURIComponent(tid)}`);
        const d = await r.json();
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
      } catch { /* offline — the browser copy is enough */ }

      // legacy single-run link (a bare jobId, no thread)
      if (loaded.length === 0 && resolvedThreadId == null) {
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

      if (cancelled) return;
      if (loaded.length === 0) {
        setNotFound(true);
        setTurns([]);
        return;
      }

      for (const t of loaded) {
        registerJob(t.jobId, t);
        watch(t.jobId);
        if (t.job) void saveTurn(t);
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
  }, [id]);

  useEffect(() => {
    return () => {
      unwatches.current.forEach((un) => un());
      unwatches.current.clear();
    };
  }, []);

  const anyActive = turns?.some((t) => !t.job || ACTIVE_STATUSES.includes(t.job.status)) ?? false;
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

  const lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;

  // report sections → right-rail TOC
  const tocHeadings = useMemo(() => {
    if (!lastTurn?.job || lastTurn.job.status !== "completed" || !lastTurn.job.reportMd) return [];
    const parsed = parseAnswer(lastTurn.job.reportMd, lastTurn.job.mode);
    return extractHeadings(parsed.body);
  }, [lastTurn?.job]);

  // ---------- scrolling: jump FAB + bottom-follow while streaming ----------
  const onMainScroll = useCallback(() => {
    const el = mainRef?.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 140);
  }, [mainRef]);

  useEffect(() => {
    const el = mainRef?.current;
    if (!el || !turns) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
    if (atBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [turns?.length, lastTurn?.job?.status, lastTurn?.sections?.length]);

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
    requestAnimationFrame(() => {
      const el = mainRef?.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
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

  // ---------- not found ----------
  if (notFound) {
    return (
      <div className="flex min-h-[70vh] w-full flex-col items-center justify-center gap-4 px-4 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-primary/10 text-primary">
          <Compass className="h-8 w-8" strokeWidth={1.8} />
        </span>
        <div>
          <p className="text-[15px] font-semibold">Thread not found in this browser</p>
          <p className="mx-auto mt-1.5 max-w-[340px] text-[12.5px] leading-relaxed text-muted-foreground">
            Deep links are private — reports live in the browser that created them (plus the server while it retains them). Start a new research, or open the link in the browser that ran it.
          </p>
        </div>
        <Button className="press-scale rounded-full" onClick={() => router.push("/")}>
          <ArrowLeft className="h-4 w-4" /> New research
        </Button>
      </div>
    );
  }

  // ---------- loading ----------
  if (turns == null) {
    return (
      <div className="mx-auto w-full max-w-[768px] space-y-4 px-4 pb-24 pt-8" aria-label="Loading thread">
        <div className="flex justify-end">
          <div className="skeleton-line h-10 w-2/3 rounded-[22px]" />
        </div>
        <div className="skeleton-line h-24 rounded-[20px]" />
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* jump to latest — appears when you scroll up mid-stream */}
      {showJump && (
        <button
          onClick={() => mainRef?.current?.scrollTo({ top: mainRef.current.scrollHeight, behavior: "smooth" })}
          className="glass spring-pop press-scale fixed bottom-[104px] left-1/2 z-30 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full text-foreground shadow-elev-2"
          aria-label="Jump to latest"
          title="Jump to latest"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      )}

      {/* desktop toolbar — glass over content, back + thread title */}
      <div className="glass-nav sticky top-0 z-30 hidden items-center gap-1 px-4 py-2 md:flex">
        <Button variant="ghost" size="icon" className="press-scale h-9 w-9 shrink-0 rounded-[12px]" onClick={() => router.push("/")} aria-label="Back to home" title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <p className="min-w-0 flex-1 truncate px-2 text-center text-[13px] font-medium text-foreground/85">
          {turns[0]?.job?.query ?? "Research thread"}
        </p>
        {anyActive && (
          <span className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            <span className="pplx-dot h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> live
          </span>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-[1140px] justify-center gap-8 px-4 pb-44 pt-6 sm:pt-8">
        {/* turns */}
        <div className="mx-auto w-full max-w-[768px] space-y-12">
          {turns.map((t) => (
            <ThreadTurn
              key={t.jobId}
              turn={t}
              showThinking={settings.showThinking}
              now={now}
              elapsedMs={turnElapsed(t)}
              onStop={() => void stopJob(t.jobId)}
              onRetry={() => void retryJob(t.jobId)}
              onFollowUp={(q) => void startFollowUpFrom(q)}
              onRerun={(q) => void startFollowUpFrom(q)}
              animate={ACTIVE_STATUSES.includes(t.job?.status ?? "") || !t.job}
            />
          ))}
        </div>

        {/* right rail (xl) — sources FIRST, then the table of contents */}
        {lastTurn && (
          <aside className="sticky top-16 hidden h-fit w-[300px] shrink-0 space-y-6 xl:block">
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
        )}
      </div>

      {/* follow-up input (pinned bottom dock) */}
      <div className="glass-dock sticky bottom-0 z-20">
        <div className="mx-auto w-full max-w-[768px] px-4 py-3">
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
            onManagePool={() => window.dispatchEvent(new CustomEvent("digdeep:open-backends"))}
            docs={followDocs}
            onDocs={setFollowDocs}
            stopMode={anyActive}
            onStop={() => void stopAllActive()}
            stopping={stoppingAll}
            inputId="follow-input"
          />
        </div>
      </div>
    </div>
  );

  /** Related-question pill / rerun: same thread, new turn. */
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
    requestAnimationFrame(() => {
      const el = mainRef?.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }
}
