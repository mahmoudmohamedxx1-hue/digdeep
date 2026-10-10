"use client";

import { useMemo, useState } from "react";
import { ExternalLink, FileText, Cpu, BookMarked } from "lucide-react";
import type { SourceItem, EventItem } from "./types";

function Favicon({ domain }: { domain: string }) {
  const [err, setErr] = useState(false);
  if (err || !domain)
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
        {(domain || "?").charAt(0).toUpperCase()}
      </div>
    );
  return (
    <img
      src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
      alt={`${domain} favicon`}
      className="h-7 w-7 shrink-0 rounded-md bg-muted object-contain p-0.5"
      onError={() => setErr(true)}
      loading="lazy"
    />
  );
}

const ENGINE_COLORS: Record<string, string> = {
  "Bing News": "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  Wikipedia: "bg-neutral-500/10 text-neutral-600 dark:text-neutral-300",
  arXiv: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
  Crossref: "bg-lime-600/10 text-lime-700 dark:text-lime-300",
  HackerNews: "bg-orange-500/10 text-orange-600 dark:text-orange-300",
  StackOverflow: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  GitHub: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
};

export function SourcesPanel({ sources }: { sources: SourceItem[] }) {
  return (
    <div className="rounded-2xl border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <BookMarked className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Sources</h3>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">{sources.length}</span>
      </div>
      <div className="slim-scroll max-h-[520px] space-y-1.5 overflow-y-auto p-3">
        {sources.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">Sources will appear here as the agent searches &amp; reads.</p>}
        {sources.map((s, i) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="group flex gap-2.5 rounded-xl border border-transparent p-2 transition-colors hover:border-border hover:bg-muted/50"
            title={s.snippet || s.title}
          >
            <Favicon domain={s.domain} />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-xs font-medium leading-snug group-hover:text-primary">{s.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
                <span className="truncate">{s.domain}</span>
                {s.engine && <span className={`rounded px-1 py-px ${ENGINE_COLORS[s.engine] ?? "bg-muted"}`}>{s.engine}</span>}
                {s.words > 0 && <span className="tabular-nums">{s.words.toLocaleString()}w</span>}
                <span className="text-muted-foreground/50">#{i + 1}</span>
              </div>
            </div>
            <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function ModelUsagePanel({ events }: { events: EventItem[] }) {
  const usage = useMemo(() => {
    const m: Record<string, { calls: number; last: string }> = {};
    for (const e of events) {
      if (!e.model) continue;
      if (!m[e.model]) m[e.model] = { calls: 0, last: e.ts };
      m[e.model].calls++;
      m[e.model].last = e.ts;
    }
    return Object.entries(m).sort((a, b) => b[1].calls - a[1].calls);
  }, [events]);

  const searchCount = events.filter((e) => e.type === "search").length;
  const readCount = events.filter((e) => e.type === "read" && e.meta && (e.meta as { ok?: boolean }).ok !== false).length;
  const llmCalls = events.filter((e) => e.model).length;

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Cpu className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Models &amp; activity</h3>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 pulse-dot" /> keyless
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/60 py-2">
          <p className="text-base font-bold tabular-nums">{searchCount}</p>
          <p className="text-[10px] text-muted-foreground">searches</p>
        </div>
        <div className="rounded-lg bg-muted/60 py-2">
          <p className="text-base font-bold tabular-nums">{readCount}</p>
          <p className="text-[10px] text-muted-foreground">pages read</p>
        </div>
        <div className="rounded-lg bg-muted/60 py-2">
          <p className="text-base font-bold tabular-nums">{llmCalls}</p>
          <p className="text-[10px] text-muted-foreground">LLM steps</p>
        </div>
      </div>
      {usage.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {usage.map(([model, u]) => (
            <div key={model} className="flex items-center justify-between rounded-lg border border-primary/15 bg-primary/5 px-2.5 py-1.5">
              <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-primary">
                <FileText className="h-3 w-3" /> {model}
              </span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{u.calls} calls</span>
            </div>
          ))}
        </div>
      )}
      {usage.length === 0 && <p className="mt-2 text-center text-[11px] text-muted-foreground">LLM usage will appear here.</p>}
    </div>
  );
}
