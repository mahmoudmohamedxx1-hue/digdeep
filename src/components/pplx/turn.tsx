"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/utils";
import { StepsCard, ChatThinking } from "@/components/pplx/steps-card";
import { SourcesRow } from "@/components/pplx/sources-row";
import { AnswerView } from "@/components/pplx/answer";
import { LogoMark } from "@/components/pplx/logo";
import type { Turn } from "@/components/research/types";
import { ACTIVE_STATUSES } from "@/components/research/types";
import type { CitationContext } from "@/components/research/citation-chip";

/** Quiet copy affordance for the user's own question (hover on desktop, always on touch). */
function CopyQuestion({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
      aria-label="Copy question"
      title="Copy question"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function ThreadTurn({
  turn, showThinking, now, elapsedMs, onStop, onRetry, onFollowUp, onRerun, animate,
  onSelectClaim, selectedClaimId,
}: {
  turn: Turn;
  showThinking: boolean;
  now: number;
  elapsedMs: number;
  onStop: () => void;
  onRetry: () => void;
  onFollowUp: (q: string) => void;
  /** P2-2: re-run this exact question in the same thread */
  onRerun?: (q: string) => void;
  animate: boolean;
  onSelectClaim?: CitationContext["onSelectClaim"];
  selectedClaimId?: string;
}) {
  const { job } = turn;
  if (!job) {
    return (
      <article className="space-y-4">
        <div className="flex justify-end">
          <div className="skeleton-line h-10 w-2/3 rounded-[22px]" />
        </div>
        <div className="skeleton-line h-24 rounded-[20px]" />
      </article>
    );
  }
  const active = ACTIVE_STATUSES.includes(job.status);
  const isChat = job.mode === "chat";
  const askedAt = job.createdAt
    ? new Date(job.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <article className="space-y-4">
      {/* user question — right-aligned gradient bubble; the one place color pops.
          A quiet meta row under it (time + copy) fades in on hover, always on touch. */}
      <div className="group/msg flex flex-col items-end">
        <p className="bubble-in chat-bubble-user max-w-[75%] whitespace-pre-wrap px-3.5 py-2 text-[14px] leading-[1.5]">
          {job.query}
        </p>
        <div className="mt-0.5 flex h-4 items-center gap-1 pr-0.5 opacity-0 transition-opacity duration-200 group-hover/msg:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          {askedAt && <span className="text-[10.5px] tabular-nums text-muted-foreground/70">{askedAt}</span>}
          <CopyQuestion text={job.query} />
        </div>
      </div>

      {/* assistant — avatar gutter on the left, content owns the rest */}
      <div className="message-in flex gap-3">
        <LogoMark className="mt-0.5 h-7 w-7 shrink-0" />
        <div className="min-w-0 flex-1 space-y-5">
          {/* steps (visible thinking, honest check-ins, self-critique) — research turns;
              chat turns get a compact live-thinking strip instead. The stop control
              lives inline with the live status, not as a floating row above. */}
          {isChat ? (
            <ChatThinking events={turn.events} active={active} showThinking={showThinking} now={now} onStop={onStop} />
          ) : (
            <StepsCard
              events={turn.events}
              active={active}
              stage={job.stage}
              progress={job.progress}
              elapsedMs={elapsedMs}
              showThinking={showThinking}
              now={now}
              onStop={onStop}
            />
          )}

          {/* sources row */}
          <SourcesRow sources={turn.sources} />

          {/* streaming answer */}
          <AnswerView
            job={job}
            sources={turn.sources}
            sections={turn.sections}
            animate={animate}
            onRetry={onRetry}
            onFollowUp={onFollowUp}
            onRerun={onRerun ? () => onRerun(job.query) : undefined}
            onSelectClaim={onSelectClaim}
            selectedClaimId={selectedClaimId}
          />
        </div>
      </div>
    </article>
  );
}
