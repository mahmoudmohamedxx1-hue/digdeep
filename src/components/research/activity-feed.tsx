"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain, Search, BookOpen, FileSearch, ShieldCheck, PenLine, Layers,
  AlertCircle, Info, CheckCircle2, ChevronDown, Sparkles, Globe, CircleDot,
} from "lucide-react";
import type { EventItem } from "./types";
import { Markdown } from "./markdown";

const ICONS: Record<string, { icon: React.ElementType; cls: string }> = {
  think: { icon: Brain, cls: "bg-primary/10 text-primary" },
  search: { icon: Search, cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  read: { icon: BookOpen, cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  summary: { icon: FileSearch, cls: "bg-teal-500/10 text-teal-600 dark:text-teal-300" },
  gap: { icon: CircleDot, cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  section: { icon: Layers, cls: "bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  draft: { icon: PenLine, cls: "bg-primary/10 text-primary" },
  critique: { icon: ShieldCheck, cls: "bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  error: { icon: AlertCircle, cls: "bg-destructive/10 text-destructive" },
  info: { icon: Info, cls: "bg-muted text-muted-foreground" },
  done: { icon: CheckCircle2, cls: "bg-primary/10 text-primary" },
};

function timeAgo(iso: string) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function ModelChip({ model }: { model: string }) {
  return (
    <span className="shrink-0 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 font-mono text-[10px] font-medium text-primary" title={`LLM backend: ${model}`}>
      {model}
    </span>
  );
}

function EventCard({ ev }: { ev: EventItem }) {
  const [open, setOpen] = useState(false);
  const conf = ICONS[ev.type] ?? ICONS.info;
  const Icon = conf.icon;
  const verbose = ev.level === "verbose";
  const hasDetail = !!ev.detail && ev.detail.length > 0;
  const isDone = ev.title.startsWith("✓");
  const long = (ev.detail?.length ?? 0) > 420;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex gap-3 rounded-xl border bg-card p-3 ${verbose ? "opacity-75" : ""} ${ev.type === "done" ? "border-primary/40" : ev.type === "error" ? "border-destructive/40" : "border-border/70"} ${isDone ? "border-primary/25" : ""}`}
    >
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${conf.cls}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm leading-snug ${verbose ? "text-muted-foreground" : "font-medium"} ${ev.type === "think" ? "italic" : ""}`}>{ev.title}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {ev.model && <ModelChip model={ev.model} />}
            <span className="text-[10px] tabular-nums text-muted-foreground/70">{timeAgo(ev.ts)}</span>
          </div>
        </div>
        {hasDetail && (
          <>
            <div className={`mt-1.5 overflow-hidden ${long && !open ? "max-h-32" : ""}`}>
              {ev.type === "summary" || ev.type === "think" || ev.type === "critique" ? (
                <div className="text-muted-foreground">
                  <Markdown text={ev.detail!} compact />
                </div>
              ) : (
                <p className="break-words text-xs leading-relaxed text-muted-foreground">{ev.detail}</p>
              )}
            </div>
            {long && (
              <button onClick={() => setOpen(!open)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                {open ? "Show less" : "Show more"}
                <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
              </button>
            )}
          </>
        )}
        {ev.meta && Array.isArray((ev.meta as { engines?: string[] }).engines) && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {((ev.meta as { engines: string[] }).engines).map((e) => (
              <span key={e} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{e}</span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function ActivityFeed({ events, active }: { events: EventItem[]; active: boolean }) {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  return (
    <div className="space-y-2">
      {active && (
        <div className="flex items-center gap-2.5 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
          <Sparkles className="h-4 w-4 animate-pulse text-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">Thinking &amp; researching…</p>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-primary/10">
              <div className="shimmer h-full w-full" />
            </div>
          </div>
        </div>
      )}
      <AnimatePresence initial={false}>
        {ordered.map((ev) => (
          <EventCard key={ev.id} ev={ev} />
        ))}
      </AnimatePresence>
      {ordered.length === 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" /> Warming up — the agent is about to start…
        </div>
      )}
    </div>
  );
}
