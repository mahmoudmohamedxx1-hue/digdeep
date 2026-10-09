"use client";

import { useMemo, useState } from "react";
import {
  BadgeCheck, Check, ChevronDown, Copy, Cpu, FileDown, FileText, RefreshCw,
  RotateCw, Share2, SquarePen, FastForward, TriangleAlert, WifiOff, Gauge, Brain,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/research/markdown";
import { useTyper } from "@/hooks/use-typer";
import { toast } from "@/hooks/use-toast";
import type { SourceItem, SectionItem, JobItem } from "@/components/research/types";
import { fmtElapsed, ACTIVE_STATUSES } from "@/components/research/types";
import { VerdictStrip } from "@/components/research/verdict-strip";
import { parseAnswer, parseExec, type ReportRef } from "@/lib/report-parse";
import type { CitationContext, ClaimSelection } from "@/components/research/citation-chip";

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

/** Classify a failure so the error state can speak plainly. */
function classifyError(err?: string | null): "throttled" | "network" | "generic" {
  const e = (err ?? "").toLowerCase();
  if (/throttl|rate.?limit|429|quota|too many requests/.test(e)) return "throttled";
  if (/network|fetch failed|econnrefused|timeout|enotfound|dns/.test(e)) return "network";
  return "generic";
}

/** The designed failure / degraded states — degradation is always visible. */
function FailureCard({ job, onRetry, isChat }: { job: JobItem; onRetry: () => void; isChat: boolean }) {
  const kind = classifyError(job.error);
  const conf = {
    throttled: {
      icon: Gauge,
      title: "Every free model is throttled right now",
      body: "All keyless backends hit their rate limits mid-run. Nothing you asked for was wrong — the run stopped where it did and everything gathered so far is preserved above. Try again in a minute, or add your own key under Backends for uninterrupted runs.",
      tone: "border-[#ff9f0a]/40 bg-[#ff9f0a]/[0.06]",
      text: "text-[#b25000] dark:text-[#ff9f0a]",
    },
    network: {
      icon: WifiOff,
      title: "Connection interrupted",
      body: "The research engine lost contact with the network mid-run. The evidence gathered so far is kept in this browser. Check your connection and retry — the run picks up from scratch with fresh searches.",
      tone: "border-destructive/40 bg-destructive/5",
      text: "text-destructive",
    },
    generic: {
      icon: TriangleAlert,
      title: isChat ? "Reply failed" : "Research failed",
      body: job.error ?? "Unknown error",
      tone: "border-destructive/40 bg-destructive/5",
      text: "text-destructive",
    },
  }[kind];
  const Icon = conf.icon;
  return (
    <div role="alert" className={`rounded-[18px] border p-5 ${conf.tone}`}>
      <p className={`flex items-center gap-2 font-medium ${conf.text}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden /> {conf.title}
      </p>
      <p className="mt-1.5 break-words text-[13px] leading-relaxed text-muted-foreground">{conf.body}</p>
      <Button size="sm" variant="outline" className="press-scale mt-3 gap-1.5 rounded-full" onClick={onRetry}>
        <RefreshCw className="h-3.5 w-3.5" /> {kind === "throttled" ? "Retry now" : "Retry"}
      </Button>
    </div>
  );
}

/** "How this was made" — the model + process disclosure at the report footer. */
function ProvenanceDisclosure({ job }: { job: JobItem }) {
  const [open, setOpen] = useState(false);
  const byModel = Object.entries(job.stats?.byModel ?? {});
  const stats = job.stats;
  const modeLabel = job.mode === "chat" ? "chat" : job.mode === "quick" ? "quick answer" : job.preset;
  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[14px] border border-border/70 bg-card px-4 py-2.5 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
        How this was made
        {byModel.length > 0 && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/80">
            — {byModel.map(([m]) => m).join(" · ")}
          </span>
        )}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-300 ease-apple ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-apple"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        aria-hidden={!open}
        {...(open ? {} : { inert: true })}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 border-x border-b border-border/70 bg-card px-4 py-3.5 text-[11.5px] leading-relaxed text-muted-foreground">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-lg bg-muted px-2.5 py-1 font-medium capitalize">{modeLabel}</span>
              <span className="rounded-lg bg-muted px-2.5 py-1">{job.language}</span>
              <span className="rounded-lg bg-muted px-2.5 py-1">{job.breadth < 0 ? "∞" : job.breadth} aspects × {job.depth < 0 ? "∞" : job.depth} rounds</span>
              <span className="rounded-lg bg-muted px-2.5 py-1">max {job.maxSources < 0 ? "∞" : job.maxSources} sources</span>
              {stats?.parallelAspects ? <span className="rounded-lg bg-muted px-2.5 py-1">{stats.parallelAspects} in parallel</span> : null}
            </div>
            {byModel.length > 0 && (
              <p>
                Answered with{" "}
                {byModel.map(([m, v]) => (
                  <span key={m} className="mr-1 inline-flex items-center gap-1 rounded-lg bg-muted px-1.5 py-0.5 font-mono text-[10.5px]">
                    {m}<span className="opacity-60">×{v.calls}</span>
                  </span>
                ))}
                {" "}— a keyless chain with automatic failover; you never need an API key.
              </p>
            )}
            <p className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
              {stats?.durationMs != null && <span>{fmtElapsed(stats.durationMs)} total</span>}
              {stats?.llmCalls != null && <span>· {stats.llmCalls} LLM calls</span>}
              {stats?.reportWords != null && <span>· ~{stats.reportWords.toLocaleString()} words</span>}
              {stats?.walkedUrls != null && stats.walkedUrls > 0 && <span>· {stats.walkedUrls} links followed</span>}
              {stats?.learnings != null && stats.learnings > 0 && <span>· {stats.learnings} findings captured</span>}
              {stats?.reranked != null && stats.reranked > 0 && <span>· {stats.reranked} rerank passes</span>}
            </p>
            <p className="text-[10.5px] text-muted-foreground/80">
              The full step-by-step trail — every search, source read, self-critique and honest time check-in — is preserved above in the research process.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Share — saves a read-only snapshot on the server and copies a link that
 *  opens for anyone, in any browser. Falls back to copying the current URL
 *  when already on a shared snapshot. Never pretends: failures say what happened. */
async function saveShareLink(job: JobItem): Promise<string | { error: string }> {
  if (job.sharedSnapshot) return window.location.href; // already a share link
  try {
    const r = await fetch(`/api/research/${job.id}/share`, { method: "POST" });
    const d = await r.json();
    if (r.ok && d.shareId) return `${window.location.origin}/r/${d.shareId}`;
    return { error: d.error ?? "Could not save the snapshot." };
  } catch {
    return { error: navigator.onLine ? "The server didn't respond — try again in a moment." : "You're offline — sharing needs a connection. Reconnect and try again." };
  }
}

function ShareButton({ job, compact }: { job: JobItem; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  return (
    <Button
      size="sm"
      variant="ghost"
      className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground"
      disabled={state === "saving"}
      title={job.sharedSnapshot ? "Copy this snapshot's link" : "Save a read-only snapshot and copy the link — anyone can open it"}
      onClick={async () => {
        if (state === "saving") return;
        setState("saving");
        const res = await saveShareLink(job);
        if (typeof res === "string") {
          try {
            await navigator.clipboard.writeText(res);
          } catch { /* clipboard blocked — still report success with the link shown */ }
          setState("done");
          toast({
            title: "Share link copied",
            description: typeof res === "string" ? res : undefined,
          });
          setTimeout(() => setState("idle"), 2400);
        } else {
          setState("idle");
          toast({ title: "Could not share", description: res.error, variant: "destructive" });
        }
      }}
    >
      {state === "done" ? (
        <Check className={compact ? "h-4 w-4 text-primary" : "h-4 w-4 text-primary"} />
      ) : state === "saving" ? (
        <RefreshCw className="h-4 w-4 animate-spin" />
      ) : (
        <Share2 className="h-4 w-4" />
      )}
      <span className="sr-only">{state === "saving" ? "Saving snapshot" : "Share report"}</span>
    </Button>
  );
}

export function AnswerView({
  job, sources, sections, animate, onRetry, onFollowUp, onRerun,
  onSelectClaim, selectedClaimId,
}: {
  job: JobItem;
  sources: SourceItem[];
  sections: SectionItem[];
  animate: boolean;
  onRetry: () => void;
  onFollowUp: (q: string) => void;
  onRerun?: () => void;
  onSelectClaim?: CitationContext["onSelectClaim"];
  selectedClaimId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const active = ACTIVE_STATUSES.includes(job.status);
  const isChat = job.mode === "chat";

  // live drafts → streaming text while the report is being written.
  const liveAnswerText = useMemo(() => {
    const withDraft = sections.filter((s) => s.draftMd);
    if (isChat || job.mode === "quick") return withDraft.map((s) => s.draftMd).join("\n\n");
    return withDraft.map((s) => `## ${s.title}\n\n${s.draftMd}`).join("\n\n");
  }, [sections, isChat, job.mode]);
  const { text: typedText, typing, skip: skipTyping } = useTyper(liveAnswerText, animate && active && !isChat);

  // chat replies: one continuous typing stream across live → completed
  const chatFull = job.reportMd ?? liveAnswerText;
  const chatTarget = isChat && animate ? chatFull : "";
  const { text: typedChat, typing: chatTyping, skip: skipChat } = useTyper(chatTarget, isChat && animate);

  // parse the completed report once — stable identities keep the memoized
  // markdown blocks (and their hover cards) from ever re-mounting
  const parsed = useMemo(
    () => (job.status === "completed" && job.reportMd ? parseAnswer(job.reportMd, job.mode) : null),
    [job.status, job.reportMd, job.mode]
  );

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(job.reportMd ?? liveAnswerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  // ---------- FAILED ----------
  if (job.status === "failed") {
    return <FailureCard job={job} onRetry={onRetry} isChat={isChat} />;
  }

  // ---------- CANCELLED ----------
  if (job.status === "cancelled") {
    return (
      <div className="rounded-[18px] border bg-muted/40 p-5 text-sm text-muted-foreground">
        This run was stopped. {isChat ? "" : "The evidence gathered so far is preserved in the steps above."}
      </div>
    );
  }

  // ---------- COMPLETED: CHAT ----------
  if (isChat && job.status === "completed") {
    const throttled = job.stats?.throttledFallback === true;
    return (
      <div className="fade-up">
        {throttled && (
          <div role="status" className="mb-4 flex items-start gap-2.5 rounded-[14px] border border-[#ff9f0a]/40 bg-[#ff9f0a]/[0.06] px-3.5 py-2.5">
            <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-[#b25000] dark:text-[#ff9f0a]" aria-hidden />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-[#b25000] dark:text-[#ff9f0a]">Answered from the built-in script — every model was throttled.</span>{" "}
              This reply is not model-generated. Ask a real research question and the pipeline will wait out the cooldowns.
            </p>
          </div>
        )}
        <div className={chatTyping ? "typing-caret" : ""}>
          <Markdown text={animate ? typedChat : chatFull} />
        </div>
        {chatTyping && <div className="mt-3"><SkipTypingButton onClick={skipChat} /></div>}

        <div className="mt-6 flex flex-wrap items-center gap-1 border-t border-border/60 pt-3.5">
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={copyReport} title="Copy reply">
            {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <ShareButton job={job} compact />
        </div>
        <ProvenanceDisclosure job={job} />
      </div>
    );
  }

  // ---------- COMPLETED: QUICK ANSWER / RESEARCH REPORT ----------
  if (job.status === "completed" && job.reportMd && parsed) {
    const { exec, body, conclusion, diff, refs } = parsed;
    const audit = job.stats?.citationAudit;
    const related = job.stats?.relatedQuestions ?? [];
    const isQuick = job.mode === "quick";
    const execShape = exec ? parseExec(exec) : null;
    const showFindings = execShape && (execShape.findings.length > 0 || execShape.lead);
    const claimChecks = job.stats?.claimChecks ?? undefined;
    const cv = job.stats?.claimVerdict;
    const claimSummaryLine = cv ? `${cv.fullySupported} of ${cv.citedSources} sources fully support their claims` : undefined;

    return (
      <div className="fade-up">
        {/* verdict strip — the honest scoreboard, first thing under the question */}
        <div className="mb-6">
          <VerdictStrip job={job} />
        </div>

        {/* executive summary — a short lead plus 3–5 key findings */}
        {showFindings && execShape && (
          <div className="mb-7">
            <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">Executive summary</p>
            {execShape.lead && (
              <p dir="auto" className="report-prose !max-w-none text-[17.5px] font-medium leading-[1.55] text-foreground">
                {execShape.lead}
              </p>
            )}
            {execShape.findings.length > 0 && (
              <ul className="mt-4 space-y-2.5">
                {execShape.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 leading-[1.65]">
                    <BadgeCheck className="mt-[3px] h-4 w-4 shrink-0 text-primary/80" aria-hidden />
                    <span dir="auto" className="report-prose !max-w-none !text-[14.25px]">{f}</span>
                  </li>
                ))}
              </ul>
            )}
            {execShape.tail && (
              <p dir="auto" className="report-prose !max-w-none mt-3.5 !text-[14.25px] text-muted-foreground">
                {execShape.tail}
              </p>
            )}
          </div>
        )}

        {/* report body — serif at a 68-character measure */}
        {body && <Markdown serif text={isQuick ? body.replace(/^##\s.*\n+/, "") : body} sources={sources} refs={refs} audit={audit} checks={claimChecks} onSelectClaim={onSelectClaim ? (sel, el) => onSelectClaim({ ...sel, reportMd: job.reportMd ?? null, allChecks: claimChecks, summaryLine: claimSummaryLine }, el) : undefined} selectedClaimId={selectedClaimId} />}
        {conclusion && (
          <div className="mt-8">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">Conclusion</p>
            <Markdown serif text={conclusion} sources={sources} refs={refs} audit={audit} checks={claimChecks} onSelectClaim={onSelectClaim ? (sel, el) => onSelectClaim({ ...sel, reportMd: job.reportMd ?? null, allChecks: claimChecks, summaryLine: claimSummaryLine }, el) : undefined} selectedClaimId={selectedClaimId} />
          </div>
        )}
        {diff && (
          <div className="mt-8">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">What changed since the last run</p>
            <Markdown serif text={diff} sources={sources} refs={refs} audit={audit} checks={claimChecks} onSelectClaim={onSelectClaim ? (sel, el) => onSelectClaim({ ...sel, reportMd: job.reportMd ?? null, allChecks: claimChecks, summaryLine: claimSummaryLine }, el) : undefined} selectedClaimId={selectedClaimId} />
          </div>
        )}

        {/* action bar — quiet icon row, the content is the star */}
        <div className="mt-7 flex flex-wrap items-center gap-0.5 border-t border-border/60 pt-3">
          <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={copyReport} title="Copy report">
            {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
          </Button>
          {!job.sharedSnapshot && (
            <>
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
            </>
          )}
          <ShareButton job={job} />
          {!isQuick && onRerun && !job.sharedSnapshot && (
            <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground" onClick={onRerun} title="Research this question again — the new report includes a 'what changed' diff against this one">
              <RotateCw className="h-4 w-4" />
              <span className="sr-only">Re-run</span>
            </Button>
          )}
        </div>

        {/* how this was made — model & process disclosure */}
        <ProvenanceDisclosure job={job} />

        {/* related questions — quiet pills, not a form */}
        {related.length > 0 && (
          <div className="mt-8">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">Related</p>
            <div className="flex flex-wrap gap-2">
              {related.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onFollowUp(q)}
                  className="press-scale group inline-flex h-9 max-w-full items-center gap-2 rounded-full border border-border/90 bg-card px-3.5 text-[12px] font-medium text-foreground/80 shadow-elev-1 transition-all duration-200 hover:border-primary/35 hover:bg-accent/40 hover:text-foreground"
                >
                  <SquarePen className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                  <span className="truncate">{q}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---------- LIVE: CHAT ----------
  if (isChat) {
    return (
      <div aria-label="Replying">
        {typedChat ? (
          <div className="typing-caret">
            <Markdown text={typedChat} />
          </div>
        ) : (
          <div className="flex items-center gap-2.5" role="status" aria-live="polite">
            <span className="typing-dots" aria-hidden>
              <span /><span /><span />
            </span>
            <span className="shimmer-text text-sm font-medium">{job.stage || "Thinking…"}</span>
          </div>
        )}
      </div>
    );
  }

  // ---------- LIVE: WRITING ----------
  if (typedText) {
    return (
      <div>
        <div className={typing ? "typing-caret" : ""} dir="auto">
          <Markdown text={typedText} sources={sources} />
        </div>
        <p className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground" role="status" aria-live="polite">
          <span className="typing-dots" aria-hidden>
            <span /><span /><span />
          </span>
          <span className="shimmer-text">{job.stage || "Writing report…"}</span>
          {typing && <SkipTypingButton onClick={skipTyping} />}
        </p>
      </div>
    );
  }

  // ---------- LIVE: RESEARCHING ----------
  return (
    <div aria-label="Preparing answer">
      <p className="mb-4 flex items-center gap-2.5 text-sm" role="status" aria-live="polite">
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
      <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" aria-hidden />
        Every search, source read, self-critique and honest time check-in is shown above while I work — nothing is hidden.
      </p>
    </div>
  );
}
