"use client";

import { useMemo, useState } from "react";
import {
  ArrowUpRight, BadgeCheck, Check, Copy, FileDown, FileText, RefreshCw,
  RotateCw, Share2, SquarePen, FastForward, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/research/markdown";
import { useTyper } from "@/hooks/use-typer";
import type { SourceItem, SectionItem, JobItem } from "@/components/research/types";
import { fmtElapsed } from "@/components/research/types";

/** Parse the final research report markdown into structured parts (Perplexity-style presentation). */
function parseReport(md: string) {
  const lines = md.split("\n");
  let mode: "title" | "exec" | "body" | "conclusion" | "diff" | "refs" | "meta" = "title";
  const bodyLines: string[] = [];
  const execLines: string[] = [];
  const concLines: string[] = [];
  const diffLines: string[] = [];
  const refs: { n: number; title: string; domain: string; url: string }[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## Executive Summary")) { mode = "exec"; continue; }
    if (line.startsWith("## Conclusion")) { mode = "conclusion"; continue; }
    if (line.startsWith("## What changed since the last run")) { mode = "diff"; continue; }
    if (line.startsWith("## References")) { mode = "refs"; continue; }
    if (line.trim() === "---") { mode = "meta"; continue; }
    if (mode === "meta") continue;
    if (mode === "title") continue;
    if (mode === "refs") {
      const m = line.trim().match(/^(\d+)\.\s(.+?)\s+—\s+\*(.+?)\*\s+—\s+(\S+)$/);
      if (m) refs.push({ n: Number(m[1]), title: m[2], domain: m[3], url: m[4] });
      continue;
    }
    if (/^##\s/.test(line)) { mode = "body"; bodyLines.push(line); continue; }
    if (mode === "exec") execLines.push(line);
    else if (mode === "conclusion") concLines.push(line);
    else if (mode === "diff") diffLines.push(line);
    else bodyLines.push(line);
  }
  return {
    exec: execLines.join("\n").trim(),
    body: bodyLines.join("\n").trim(),
    conclusion: concLines.join("\n").trim(),
    diff: diffLines.join("\n").trim(),
    refs,
  };
}

/** Mode-aware parse: chat = plain conversational reply; quick = answer + references; research = full report. */
function parseAnswer(md: string, mode?: string) {
  if (mode === "chat") return { exec: "", body: md, conclusion: "", diff: "", refs: [] };
  if (!md.includes("## Executive Summary")) {
    // quick-style answer: everything before "## References" is the body
    const idx = md.indexOf("## References");
    const body = (idx >= 0 ? md.slice(0, idx) : md).trim();
    const refs: { n: number; title: string; domain: string; url: string }[] = [];
    if (idx >= 0) {
      for (const line of md.slice(idx).split("\n")) {
        const m = line.trim().match(/^(\d+)\.\s(.+?)\s+—\s+\*(.+?)\*\s+—\s+(\S+)$/);
        if (m) refs.push({ n: Number(m[1]), title: m[2], domain: m[3], url: m[4] });
      }
    }
    return { exec: "", body, conclusion: "", diff: "", refs };
  }
  return parseReport(md);
}

function SkipTypingButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="press-scale ml-1 inline-flex h-6 items-center gap-1 rounded-lg border bg-card px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      title="Skip the typing animation and show the full text"
    >
      <FastForward className="h-3 w-3" /> Skip
    </button>
  );
}

/** P1-1 — the self-score card: digdeep grades its own report and shows the grade,
 *  honestly, including bad ones. Score color follows Apple system colors. */
function QualityCard({ quality }: { quality: NonNullable<NonNullable<JobItem["stats"]>["quality"]> }) {
  const scoreColor = (s: number) => (s >= 7.5 ? "#34c759" : s >= 5.5 ? "#ff9f0a" : undefined);
  const toneClass = (s: number) => (s >= 7.5 ? "text-[#248a3d] dark:text-[#30d158]" : s >= 5.5 ? "text-[#b25000] dark:text-[#ff9f0a]" : "text-destructive");
  const barTone = (s: number) => (s >= 7.5 ? "bg-[#34c759]" : s >= 5.5 ? "bg-[#ff9f0a]" : "bg-destructive");
  const r = 19;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, quality.overall / 10));
  return (
    <div className="mt-10 rounded-[20px] border border-input bg-card p-5 shadow-elev-1">
      <div className="flex items-center gap-4">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center" role="img" aria-label={`Overall quality ${quality.overall} out of 10`}>
          <svg viewBox="0 0 44 44" className="h-12 w-12 -rotate-90">
            <circle cx="22" cy="22" r={r} fill="none" strokeWidth="4" className="stroke-muted" />
            <circle
              cx="22" cy="22" r={r} fill="none" strokeWidth="4" strokeLinecap="round"
              stroke={scoreColor(quality.overall) ?? "currentColor"}
              className={scoreColor(quality.overall) ? "" : "stroke-destructive"}
              strokeDasharray={`${circ * pct} ${circ}`}
              style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.25,0.1,0.25,1)" }}
            />
          </svg>
          <span className={`absolute text-[15px] font-semibold tabular-nums ${toneClass(quality.overall)}`}>{quality.overall}</span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Report quality — self-scored</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">Graded against the success criteria defined before the research started. Honest when bad, on purpose.</p>
        </div>
        <span className={`shrink-0 text-[13px] font-medium tabular-nums text-muted-foreground`}>out of 10</span>
      </div>
      {quality.dims.length > 0 && (
        <div className="mt-5 space-y-3">
          {quality.dims.map((d, i) => (
            <div key={i}>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium capitalize">{d.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{d.score.toFixed(1)}</span>
              </div>
              <div className="h-[5px] overflow-hidden rounded-full bg-muted/70">
                <div className={`h-full rounded-full ${barTone(d.score)}`} style={{ width: `${Math.max(3, d.score * 10)}%`, transition: "width 700ms cubic-bezier(0.25,0.1,0.25,1)" }} />
              </div>
              {d.note && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{d.note}</p>}
            </div>
          ))}
        </div>
      )}
      {quality.criteria.length > 0 && (
        <div className="mt-5 space-y-2 border-t border-border/60 pt-4">
          {quality.criteria.map((c, i) => (
            <div key={i} className="flex items-start gap-2.5">
              {c.met ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#248a3d] dark:text-[#30d158]" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b25000] dark:text-[#ff9f0a]" />
              )}
              <div className="min-w-0">
                <p className="text-xs leading-snug">{c.criterion}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{c.why}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {quality.biggestWeakness && (
        <p className="mt-4 rounded-[12px] bg-muted/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Biggest weakness:</span> {quality.biggestWeakness}
        </p>
      )}
    </div>
  );
}

export function AnswerView({
  job, sources, sections, animate, onRetry, onFollowUp, onRerun,
}: {
  job: JobItem;
  sources: SourceItem[];
  sections: SectionItem[];
  animate: boolean; // true when this turn was observed live → keep streaming typography
  onRetry: () => void;
  onFollowUp: (q: string) => void;
  /** P2-2: re-run this exact question in the same thread (monitoring-lite) */
  onRerun?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const active = ["queued", "planning", "researching", "critiquing", "synthesizing"].includes(job.status);
  const isChat = job.mode === "chat";

  // live drafts → streaming text while the report is being written.
  // chat/quick answers stream as plain text (no section heading); research keeps
  // "## Section" headings so the report structure appears as it is written.
  const liveAnswerText = useMemo(() => {
    const withDraft = sections.filter((s) => s.draftMd);
    if (isChat || job.mode === "quick") return withDraft.map((s) => s.draftMd).join("\n\n");
    return withDraft.map((s) => `## ${s.title}\n\n${s.draftMd}`).join("\n\n");
  }, [sections, isChat, job.mode]);
  const { text: typedText, typing, skip: skipTyping } = useTyper(liveAnswerText, animate && active && !isChat);

  // chat replies: one continuous typing stream across live → completed (Perplexity chat feel)
  const chatFull = job.reportMd ?? liveAnswerText;
  const chatTarget = isChat && animate ? chatFull : "";
  const { text: typedChat, typing: chatTyping, skip: skipChat } = useTyper(chatTarget, isChat && animate);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(job.reportMd ?? liveAnswerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch { /* ignore */ }
  };

  // ---------- FAILED ----------
  if (job.status === "failed") {
    return (
      <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5">
        <p className="font-medium text-destructive">{isChat ? "Reply failed" : "Research failed"}</p>
        <p className="mt-1.5 break-words text-sm text-muted-foreground">{job.error ?? "Unknown error"}</p>
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  // ---------- CANCELLED ----------
  if (job.status === "cancelled") {
    return (
      <div className="rounded-2xl border bg-muted/40 p-5 text-sm text-muted-foreground">
        This run was stopped. {isChat ? "" : "The evidence gathered so far is preserved in the steps above."}
      </div>
    );
  }

  // ---------- COMPLETED: CHAT (conversational reply, no report structure) ----------
  if (isChat && job.status === "completed") {
    const byModel = Object.entries(job.stats?.byModel ?? {});
    return (
      <div className="fade-up">
        <div className={chatTyping ? "typing-caret" : ""}>
          <Markdown text={animate ? typedChat : chatFull} />
        </div>
        {chatTyping && <div className="mt-3"><SkipTypingButton onClick={skipChat} /></div>}

        <div className="mt-6 flex flex-wrap items-center gap-1 border-t border-border/60 pt-3.5">
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={copyReport} title="Copy reply">
            {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={share} title="Copy link">
            <Share2 className="h-4 w-4" />
            <span className="sr-only">Share</span>
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {byModel.length > 0 && (
            <span>
              Answered with {byModel.map(([m, v]) => (
                <span key={m} className="mr-1 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  {m}<span className="opacity-60">×{v.calls}</span>
                </span>
              ))}
            </span>
          )}
          {job.stats?.durationMs != null && <span>· {fmtElapsed(job.stats.durationMs)}</span>}
          <span>· chatted — no research run for this one</span>
        </div>
      </div>
    );
  }

  // ---------- COMPLETED: QUICK ANSWER / RESEARCH REPORT ----------
  if (job.status === "completed" && job.reportMd) {
    const { exec, body, conclusion, diff } = parseAnswer(job.reportMd, job.mode);
    const byModel = Object.entries(job.stats?.byModel ?? {});
    const related = job.stats?.relatedQuestions ?? [];
    const isQuick = job.mode === "quick";
    const quality = job.stats?.quality;
    const integrity = job.stats?.citationIntegrity;
    const diversity = job.stats?.sourceDiversity;
    return (
      <div className="fade-up">
        {exec && (
          <div className="mb-7">
            <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Executive summary</p>
            <Markdown text={exec} />
          </div>
        )}
        {body && <Markdown text={isQuick ? body.replace(/^##\s.*\n+/, "") : body} />}
        {conclusion && (
          <div className="mt-10">
            <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Conclusion</p>
            <Markdown text={conclusion} />
          </div>
        )}
        {diff && (
          <div className="mt-10">
            <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">What changed since the last run</p>
            <Markdown text={diff} />
          </div>
        )}

        {/* P1-1 — self-scored quality dashboard (honest when bad) */}
        {quality && !isQuick && <QualityCard quality={quality} />}

        {/* action bar — quiet icon row, the content is the star */}
        <div className="mt-9 flex flex-wrap items-center gap-0.5 border-t border-border/60 pt-3.5">
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={copyReport} title="Copy report">
            {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <a href={`/api/research/${job.id}/export?format=pdf`} target="_blank" rel="noreferrer" title="Export as PDF">
            <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground">
              <FileDown className="h-4 w-4" />
              <span className="sr-only">PDF</span>
            </Button>
          </a>
          <a href={`/api/research/${job.id}/export?format=md`} target="_blank" rel="noreferrer" title="Export as Markdown">
            <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground">
              <FileText className="h-4 w-4" />
              <span className="sr-only">Markdown</span>
            </Button>
          </a>
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={share} title="Copy link">
            <Share2 className="h-4 w-4" />
            <span className="sr-only">Share</span>
          </Button>
          {!isQuick && onRerun && (
            <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={onRerun} title="Research this question again — the new report includes a 'what changed' diff against this one">
              <RotateCw className="h-4 w-4" />
              <span className="sr-only">Re-run</span>
            </Button>
          )}
        </div>

        {/* model transparency + trust stats */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
          {byModel.length > 0 && (
            <span>
              Answered with {byModel.map(([m, v]) => (
                <span key={m} className="mr-1 inline-flex items-center gap-1 rounded-lg bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                  {m}<span className="opacity-60">×{v.calls}</span>
                </span>
              ))}
            </span>
          )}
          {job.stats?.durationMs != null && <span>· {fmtElapsed(job.stats.durationMs)}</span>}
          {job.stats?.sourcesConsulted != null && <span>· {job.stats.sourcesConsulted} sources</span>}
          {job.stats?.reportWords != null && <span>· ~{job.stats.reportWords.toLocaleString()} words</span>}
          {job.stats?.llmCalls != null && <span>· {job.stats.llmCalls} LLM calls</span>}
          {isQuick && <span>· quick answer — ask a follow-up to go deeper</span>}
        </div>

        {/* trust chips: citation integrity (P0-4), diversity & freshness (P1-3) */}
        {!isQuick && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {integrity != null && (
              <span className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium ${integrity >= 90 ? "bg-[#34c759]/10 text-[#248a3d] dark:text-[#30d158]" : integrity >= 70 ? "bg-[#ff9f0a]/10 text-[#b25000] dark:text-[#ff9f0a]" : "bg-destructive/10 text-destructive"}`}>
                <BadgeCheck className="h-3.5 w-3.5" />
                {integrity === 100 ? "Citations verified — 100% integrity" : `Citation integrity ${integrity}%${job.stats?.citationsDropped ? ` · ${job.stats.citationsDropped} removed` : ""}`}
              </span>
            )}
            {diversity?.domains != null && diversity.domains > 0 && (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
                {diversity.domains} domains{diversity.topDomain ? ` · top: ${diversity.topDomain} ${diversity.topShare}%` : ""}
              </span>
            )}
            {diversity?.medianAgeMonths != null && diversity.medianAgeMonths != null && (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
                median source age ~{diversity.medianAgeMonths}mo
              </span>
            )}
            {(job.stats?.redTeamAttacks ?? 0) > 0 && (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
                red-teamed ({job.stats?.redTeamAttacks} attacks)
              </span>
            )}
            {(job.stats?.debated ?? 0) > 0 && (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
                {job.stats?.debated} claim{(job.stats?.debated ?? 0) > 1 ? "s" : ""} debated
              </span>
            )}
          </div>
        )}

        {/* related questions */}
        {related.length > 0 && (
          <div className="mt-10">
            <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Related</p>
            <div className="divide-y divide-border/60 rounded-[16px] border border-input bg-card shadow-elev-1">
              {related.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onFollowUp(q)}
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                >
                  <SquarePen className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                  <span className="min-w-0 flex-1">{q}</span>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------- LIVE: CHAT (thinking → typing reply) ----------
  if (isChat) {
    return (
      <div aria-label="Replying">
        {typedChat ? (
          <div className="typing-caret">
            <Markdown text={typedChat} />
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <span className="typing-dots" aria-hidden>
              <span /><span /><span />
            </span>
            <span className="shimmer-text text-sm font-medium">{job.stage || "Thinking…"}</span>
          </div>
        )}
      </div>
    );
  }

  // ---------- LIVE: WRITING (drafts streaming) ----------
  if (typedText) {
    return (
      <div>
        <div className={typing ? "typing-caret" : ""}>
          <Markdown text={typedText} />
        </div>
        <p className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
          <span className="typing-dots" aria-hidden>
            <span /><span /><span />
          </span>
          <span className="shimmer-text">{job.stage || "Writing report…"}</span>
          {typing && <SkipTypingButton onClick={skipTyping} />}
        </p>
      </div>
    );
  }

  // ---------- LIVE: RESEARCHING (skeleton, Perplexity answer-loading style) ----------
  return (
    <div aria-label="Preparing answer">
      <p className="mb-4 flex items-center gap-2.5 text-sm">
        <span className="typing-dots" aria-hidden>
          <span /><span /><span />
        </span>
        <span className="shimmer-text font-medium">{job.stage || "Researching…"}</span>
      </p>
      <div className="space-y-3">
        {[92, 100, 96, 88, 100, 72].map((w, i) => (
          <div key={i} className="skeleton-line h-3.5 rounded-full" style={{ width: `${w}%` }} />
        ))}
      </div>
      <p className="mt-5 text-xs text-muted-foreground">
        Every search, source read, self-critique and honest time check-in is shown above while I work — nothing is hidden.
      </p>
    </div>
  );
}
