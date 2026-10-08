"use client";

import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepsCard, ChatThinking } from "@/components/pplx/steps-card";
import { SourcesRow } from "@/components/pplx/sources-row";
import { AnswerView } from "@/components/pplx/answer";
import type { Turn } from "@/components/research/types";
import { ACTIVE_STATUSES } from "@/components/research/types";

export function ThreadTurn({
  turn, showThinking, now, elapsedMs, onStop, onRetry, onFollowUp, onRerun, animate,
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
}) {
  const { job } = turn;
  if (!job) {
    return (
      <article className="space-y-4">
        <div className="skeleton-line h-6 w-2/3 rounded-lg" />
        <div className="skeleton-line h-24 rounded-[20px]" />
      </article>
    );
  }
  const active = ACTIVE_STATUSES.includes(job.status);
  const isChat = job.mode === "chat";

  return (
    <article className="space-y-5">
      {/* query as thread title */}
      <div className="flex items-start justify-between gap-3">
        <h2 className={`tracking-[-0.022em] ${isChat ? "text-[19px] font-semibold leading-snug sm:text-xl" : "text-[22px] font-semibold leading-snug sm:text-2xl"}`}>{job.query}</h2>
        {active && (
          <Button
            size="sm"
            variant="outline"
            className="press-scale h-9 shrink-0 gap-1.5 rounded-full text-xs"
            onClick={onStop}
          >
            <Square className="h-3 w-3 fill-current" /> Stop
          </Button>
        )}
      </div>

      {/* steps (visible thinking, honest check-ins, self-critique) — research turns;
          chat turns get a compact live-thinking strip instead */}
      {isChat ? (
        <ChatThinking events={turn.events} active={active} showThinking={showThinking} now={now} />
      ) : (
        <StepsCard
          events={turn.events}
          active={active}
          stage={job.stage}
          elapsedMs={elapsedMs}
          showThinking={showThinking}
          now={now}
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
      />
    </article>
  );
}
