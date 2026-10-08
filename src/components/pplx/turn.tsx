"use client";

import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StepsCard, ChatThinking } from "@/components/pplx/steps-card";
import { SourcesRow } from "@/components/pplx/sources-row";
import { AnswerView } from "@/components/pplx/answer";
import { LogoMark } from "@/components/pplx/logo";
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
        <div className="flex justify-end">
          <div className="skeleton-line h-10 w-2/3 rounded-[22px]" />
        </div>
        <div className="skeleton-line h-24 rounded-[20px]" />
      </article>
    );
  }
  const active = ACTIVE_STATUSES.includes(job.status);
  const isChat = job.mode === "chat";

  return (
    <article className="space-y-4">
      {/* user question — right-aligned gradient bubble; the one place color pops */}
      <div className="flex justify-end">
        <p className="bubble-in chat-bubble-user max-w-[75%] whitespace-pre-wrap px-4 py-2.5 text-[15px] leading-[1.55]">
          {job.query}
        </p>
      </div>

      {/* assistant — avatar gutter on the left, content owns the rest */}
      <div className="message-in flex gap-3">
        <LogoMark className="mt-0.5 h-7 w-7 shrink-0 rounded-[7.5px] shadow-elev-1" />
        <div className="min-w-0 flex-1 space-y-5">
          {active && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                className="press-scale h-7 shrink-0 gap-1.5 rounded-full border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={onStop}
              >
                <Square className="h-2.5 w-2.5 fill-current" /> Stop
              </Button>
            </div>
          )}

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
        </div>
      </div>
    </article>
  );
}
