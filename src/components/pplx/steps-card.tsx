"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDownWideNarrow, BadgeCheck, Bot, Brain, CheckCircle2, ChevronDown,
  Clock, FileText, FlaskConical, Footprints, Gauge, GitCompare, Info, Lightbulb,
  ListChecks, Loader2, MessagesSquare, PenLine, PieChart, Scale, Search, ShieldCheck,
  ShieldQuestion, Swords, Target,
} from "lucide-react";
import type { EventItem } from "@/components/research/types";
import { BorderBeam, CountUp, FadeIn } from "@/components/magic";

const STEP_ICON: Record<string, React.ReactNode> = {
  think: <Brain className="h-3.5 w-3.5" />,
  agent: <Bot className="h-3.5 w-3.5" />,
  presearch: <Brain className="h-3.5 w-3.5" />,
  comprehend: <Brain className="h-3.5 w-3.5" />,
  search: <Search className="h-3.5 w-3.5" />,
  rerank: <ArrowDownWideNarrow className="h-3.5 w-3.5" />,
  read: <FileText className="h-3.5 w-3.5" />,
  walk: <Footprints className="h-3.5 w-3.5" />,
  learning: <Lightbulb className="h-3.5 w-3.5" />,
  contradiction: <Swords className="h-3.5 w-3.5" />,
  section: <ListChecks className="h-3.5 w-3.5" />,
  summary: <FileText className="h-3.5 w-3.5" />,
  curate: <Scale className="h-3.5 w-3.5" />,
  verify: <ShieldCheck className="h-3.5 w-3.5" />,
  citecheck: <BadgeCheck className="h-3.5 w-3.5" />,
  selfcheck: <ShieldQuestion className="h-3.5 w-3.5" />,
  eta: <Clock className="h-3.5 w-3.5" />,
  gap: <Target className="h-3.5 w-3.5" />,
  critique: <FlaskConical className="h-3.5 w-3.5" />,
  redteam: <Swords className="h-3.5 w-3.5" />,
  debate: <MessagesSquare className="h-3.5 w-3.5" />,
  diversity: <PieChart className="h-3.5 w-3.5" />,
  score: <Gauge className="h-3.5 w-3.5" />,
  diff: <GitCompare className="h-3.5 w-3.5" />,
  draft: <PenLine className="h-3.5 w-3.5" />,
  info: <Info className="h-3.5 w-3.5" />,
  error: <AlertTriangle className="h-3.5 w-3.5" />,
  done: <CheckCircle2 className="h-3.5 w-3.5" />,
};

function timeAgo(ts: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** ------------------------------------------------------------------
 *  THOUGHT STREAMS — instant visible thinking.
 *  One LLM step = one thought group (meta.thoughtId); its events are
 *  [started] → delta* → [reset]? → delta* → [done]. The group renders
 *  as a single block that types itself out live with a caret.
 *  ------------------------------------------------------------------ */
export interface ThoughtGroup {
  thoughtId: string;
  label: string;
  model?: string;
  text: string;
  done: boolean;
  firstSeq: number;
  lastSeq: number;
  ts: string;
  lastTs: string;
}

type Row = { kind: "event"; e: EventItem } | { kind: "thought"; g: ThoughtGroup };

export function buildThoughtRows(events: EventItem[]): Row[] {
  const rows: Row[] = [];
  const groups = new Map<string, ThoughtGroup>();
  for (const e of events) {
    if (e.type !== "think") {
      rows.push({ kind: "event", e });
      continue;
    }
    const tid = typeof e.meta?.thoughtId === "string" ? (e.meta.thoughtId as string) : `solo-${e.seq}`;
    let g = groups.get(tid);
    if (!g) {
      g = { thoughtId: tid, label: e.title, model: undefined, text: "", done: false, firstSeq: e.seq, lastSeq: e.seq, ts: e.ts, lastTs: e.ts };
      groups.set(tid, g);
      rows.push({ kind: "thought", g });
    }
    g.lastSeq = e.seq;
    g.lastTs = e.ts;
    if (e.model) g.model = e.model;
    if (e.meta?.reset) g.text = ""; // a backend attempt restarted — clear the dead attempt's partial text
    if (e.detail) g.text += e.detail;
    if (e.meta?.done) g.done = true;
  }
  return rows;
}

/** Seconds a completed thought streamed for (label → "Thought for 8s"). */
function thoughtSeconds(g: ThoughtGroup): number {
  return Math.max(1, Math.round((new Date(g.lastTs).getTime() - new Date(g.ts).getTime()) / 1000));
}

/** The live text tail (terminal-style: newest visible, capped for layout). */
function thoughtDisplay(text: string, cap = 4000): string {
  return text.length > cap ? `…${text.slice(-cap)}` : text;
}

/** Live streaming text block with caret + auto-scroll (shared by steps + chat). */
function LiveThoughtText({ text, maxHeight = "max-h-44" }: { text: string; maxHeight?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <div
      ref={ref}
      className={`slim-scroll ${maxHeight} overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/40 bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground typing-caret`}
    >
      {thoughtDisplay(text)}
    </div>
  );
}

function activeLabel(lastType: string, stage: string, liveLabel?: string): string {
  if (lastType === "think") return liveLabel ? `${liveLabel}…` : "Thinking…";
  if (lastType === "search") return "Searching…";
  if (lastType === "rerank") return "Ranking sources…";
  if (lastType === "read") return "Reading sources…";
  if (lastType === "walk") return "Following links…";
  if (lastType === "learning") return "Capturing key findings…";
  if (lastType === "summary") return "Analyzing sources…";
  if (lastType === "selfcheck") return "Self-reviewing…";
  if (lastType === "eta") return "Updating honest estimate…";
  if (lastType === "curate") return "Curating sources…";
  if (lastType === "verify") return "Cross-checking claims…";
  if (lastType === "citecheck") return "Auditing citations…";
  if (lastType === "contradiction") return "Tracking disagreements…";
  if (lastType === "critique" || lastType === "gap") return "Critiquing evidence…";
  if (lastType === "redteam") return "Red-teaming the evidence…";
  if (lastType === "debate") return "Debating contested claims…";
  if (lastType === "diversity") return "Reviewing source diversity…";
  if (lastType === "score") return "Grading the report…";
  if (lastType === "diff") return "Diffing against the last run…";
  if (lastType === "draft") return "Writing report…";
  if (lastType === "agent" || lastType === "presearch" || lastType === "comprehend") return "Thinking…";
  if (lastType === "section") return "Researching aspects…";
  if (lastType === "plan") return "Planning research…";
  return stage || "Working…";
}

/** Honest-label detection: events that describe degradation get the amber
 *  treatment so “degradation is always visible” is a visual promise too. */
const DEGRADE_RE = /throttl|rate.?limit|fall(?:ing)?\s*back|unavailable|degrad|script|exhausted|cooldown/i;
function isDegrade(e: EventItem): boolean {
  return e.type === "error" ? false : DEGRADE_RE.test(`${e.title} ${e.detail ?? ""}`);
}

export function StepsCard({
  events, active, stage, progress, elapsedMs, showThinking, now,
}: {
  events: EventItem[];
  active: boolean;
  stage: string;
  /** engine progress 0-100 — the honest step bar while it works */
  progress?: number;
  elapsedMs: number;
  showThinking: boolean;
  now: number;
}) {
  // derived: open while running, collapsed when done — unless the user overrides
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  const [expandedThoughts, setExpandedThoughts] = useState<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => events.filter((e) => e.level !== "verbose" || e.type === "think"),
    [events]
  );
  const rows = useMemo(() => buildThoughtRows(visible), [visible]);
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastType = lastRow ? (lastRow.kind === "thought" ? "think" : lastRow.e.type) : "";
  const liveThought =
    active && lastRow && lastRow.kind === "thought" && !lastRow.g.done ? lastRow.g : null;

  // keep latest steps in view while running
  useEffect(() => {
    if (open && active && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [rows.length, liveThought?.text, open, active]);

  const toggleThought = (id: string) => {
    setExpandedThoughts((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <div className="surface-quiet relative overflow-hidden rounded-[20px]">
      {/* while the agent works, a comet of light orbits the card —
          the interface quietly saying "alive" the whole run */}
      {active && <BorderBeam duration={9} />}
      <button
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
      >
        {active ? (
          <span className="pplx-dot h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
        ) : (
          <CheckCircle2 className="check-pop h-4 w-4 shrink-0 text-primary" />
        )}
        <span
          className={active ? "shimmer-text min-w-0 truncate text-sm font-medium" : "min-w-0 truncate text-sm font-medium text-foreground"}
          role={active ? "status" : undefined}
          aria-live={active ? "polite" : undefined}
        >
          {active
            ? activeLabel(lastType, stage, liveThought?.label)
            : (
              <>Research process · <CountUp to={rows.length} duration={0.5} /> steps</>
            )}
        </span>
        {active && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {Math.floor(elapsedMs / 60000)}:{String(Math.floor((elapsedMs % 60000) / 1000)).padStart(2, "0")}
          </span>
        )}
        <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-apple ${open ? "rotate-180" : ""}`} />
      </button>

      {/* the honest step bar — engine-reported progress, never a fake spinner */}
      {active && (
        <div
          className="h-[3px] w-full overflow-hidden bg-muted/60"
          role="progressbar"
          aria-label="Research progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, progress ?? 0))}
        >
          <div
            className="h-full rounded-r-full bg-primary transition-[width] duration-700 ease-apple"
            style={{ width: `${Math.max(2, Math.min(100, progress ?? 2))}%` }}
          />
        </div>
      )}

      {open && (
        <div ref={bodyRef} className="slim-scroll max-h-[340px] overflow-y-auto px-4 py-3">
          {rows.length === 0 && (
            <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting research…
            </p>
          )}
          {/* activity timeline — a single rail threads every step */}
          <div className="relative">
            <div className="absolute bottom-2 left-[11.5px] top-2 w-px bg-border" aria-hidden />
            <div className="space-y-1.5">
              {rows.map((row, i) => {
            if (row.kind === "thought") {
              const g = row.g;
              const isLast = i === rows.length - 1;
              const live = !g.done && isLast && active;
              const userExpanded = expandedThoughts.has(g.thoughtId);
              const showLiveText = live && (showThinking || userExpanded);
              const showDoneText = !live && userExpanded;
              return (
                <FadeIn key={g.thoughtId} className="relative flex gap-3">
                  <span
                    className={`z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 transition-colors ${
                      live ? "bg-primary/10 text-primary ring-primary/20" : "bg-card text-primary/80 ring-border"
                    }`}
                  >
                    <Brain className={`h-3.5 w-3.5 ${live ? "pulse-dot" : ""}`} />
                  </span>
                  <div className="min-w-0 flex-1 pb-0.5">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className={`text-[13px] leading-snug ${live ? "shimmer-text font-medium" : g.text ? "text-foreground/90" : "text-muted-foreground"}`}>
                          {live ? `${g.label}…` : g.label}
                        </span>
                        {g.model && !live && (
                          <span className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">{g.model}</span>
                        )}
                        {live && g.text.length > 0 && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-primary">{g.text.length.toLocaleString()} chars</span>
                        )}
                        {!live && g.text && (
                          <span className="text-[10px] tabular-nums text-muted-foreground">thought for {thoughtSeconds(g)}s</span>
                        )}
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{timeAgo(g.ts, now)}</span>
                      </div>
                      {(live || g.text) && (
                        <button
                          className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => toggleThought(g.thoughtId)}
                        >
                          {showLiveText || showDoneText ? "hide thinking ▲" : "show thinking ▼"}
                        </button>
                      )}
                      {showLiveText && g.text && <div className="mt-1.5"><LiveThoughtText text={g.text} /></div>}
                      {showDoneText && g.text && (
                        <div className="slim-scroll mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/40 bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
                          {thoughtDisplay(g.text, 8000)}
                        </div>
                      )}
                  </div>
                </FadeIn>
              );
            }
            const e = row.e;
            const highlight = e.type === "eta" || e.type === "selfcheck" || e.type === "critique" || e.type === "agent" || e.type === "presearch" || e.type === "learning" || e.type === "walk" || e.type === "curate" || e.type === "verify" || e.type === "contradiction" || e.type === "comprehend" || e.type === "rerank" || e.type === "citecheck" || e.type === "redteam" || e.type === "debate" || e.type === "diversity" || e.type === "score" || e.type === "diff";
            const isError = e.type === "error";
            const degraded = !isError && isDegrade(e);
            return (
              <FadeIn key={e.seq} className="relative flex gap-3">
                <span
                  className={`z-[1] mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ${
                    isError
                      ? "bg-destructive/10 text-destructive ring-destructive/20"
                      : degraded
                        ? "bg-[#ff9f0a]/12 text-[#b25000] ring-[#ff9f0a]/25 dark:text-[#ff9f0a]"
                        : highlight
                          ? "bg-primary/10 text-primary ring-primary/20"
                          : "bg-card text-muted-foreground/80 ring-border"
                  }`}
                >
                  {STEP_ICON[e.type] ?? <Info className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1 pb-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13px] leading-snug text-foreground/90">{e.title}</span>
                      {degraded && (
                        <span className="rounded-full bg-[#ff9f0a]/12 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-[#b25000] dark:text-[#ff9f0a]">degraded</span>
                      )}
                      {e.model && (
                        <span className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">{e.model}</span>
                      )}
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{timeAgo(e.ts, now)}</span>
                    </div>
                    {e.detail ? (
                      <p className={`mt-0.5 line-clamp-3 whitespace-pre-line text-[12px] leading-relaxed ${degraded ? "text-[#b25000]/85 dark:text-[#ff9f0a]/85" : "text-muted-foreground"}`}>{e.detail}</p>
                    ) : null}
                    {e.type === "selfcheck" && Array.isArray(e.meta?.followUps) && (e.meta.followUps as string[]).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {((e.meta?.followUps ?? []) as string[]).map((q, i) => (
                          <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">↳ {String(q)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </FadeIn>
            );
          })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** ------------------------------------------------------------------
 *  CHAT THINKING — Claude-style strip for conversational turns:
 *  live "Thinking…" while the model reasons, then a compact
 *  "Thought for Xs" disclosure. Renders nothing when the turn had
 *  no thinking events.
 *  ------------------------------------------------------------------ */
export function ChatThinking({
  events, active, showThinking, now,
}: {
  events: EventItem[];
  active: boolean;
  showThinking: boolean;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(
    () =>
      buildThoughtRows(events.filter((e) => e.type === "think"))
        .map((r) => (r.kind === "thought" ? r.g : null))
        .filter((g): g is ThoughtGroup => !!g),
    [events]
  );
  if (groups.length === 0) return null;
  const last = groups[groups.length - 1];
  const live = active && !last.done;
  const showText = live ? (showThinking || expanded) && !!last.text : expanded && !!last.text;

  if (live) {
    return (
      <div className="surface-quiet fade-up rounded-[18px] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`shrink-0 text-primary ${last.text ? "" : "pulse-dot"}`}>
            <Brain className="h-4 w-4" />
          </span>
          <span className="shimmer-text text-[13px] font-medium">{last.label}…</span>
          {last.text.length > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-primary">
              {last.text.length.toLocaleString()} chars
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{timeAgo(last.ts, now)}</span>
        </div>
        {showText && <div className="mt-2"><LiveThoughtText text={last.text} maxHeight="max-h-40" /></div>}
        {!showText && last.text.length > 0 && (
          <button className="mt-1.5 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setExpanded(true)}>
            show thinking ▼
          </button>
        )}
      </div>
    );
  }
  // completed thoughts → compact disclosure
  return (
    <div>
      <button
        className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        <Brain className="h-3.5 w-3.5 text-primary/70" />
        Thought for {thoughtSeconds(last)}s
        <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && last.text && (
        <div className="slim-scroll mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/40 bg-muted/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          {thoughtDisplay(last.text, 8000)}
        </div>
      )}
    </div>
  );
}
