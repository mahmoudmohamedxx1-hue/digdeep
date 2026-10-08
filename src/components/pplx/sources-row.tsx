"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import { CountUp, FadeIn } from "@/components/magic";
import type { SourceItem } from "@/components/research/types";

function Favicon({ domain, className = "h-4 w-4" }: { domain: string; className?: string }) {
  const [err, setErr] = useState(false);
  if (err || !domain) return <Globe className={`${className} text-muted-foreground`} />;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className={`${className} rounded-sm`}
      onError={() => setErr(true)}
    />
  );
}

/** Perplexity-style source chips — overlapping favicon circles that peek at the evidence. */
export function SourcesRow({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) return null;
  const visible = sources.slice(0, 8);
  const overflow = sources.length - visible.length;
  return (
    <div className="fade-up flex min-w-0 items-center gap-2.5">
      <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">Sources</span>
      <div className="flex min-w-0 items-center -space-x-1.5">
        {visible.map((s, i) => {
          const linkable = !s.url.startsWith("attachment://");
          const chip = (
            <>
              <Favicon domain={s.domain} className="h-[15px] w-[15px]" />
            </>
          );
          const cls =
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-card ring-2 ring-background transition-transform hover:z-10 hover:scale-110";
          return linkable ? (
            <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className={cls} title={`[${i + 1}] ${s.title} — ${s.domain}`} aria-label={`Source ${i + 1}: ${s.domain}`}>
              {chip}
            </a>
          ) : (
            <span key={s.id} className={`${cls} ring-border`} title={`[${i + 1}] ${s.title} — attached document`} aria-label={`Source ${i + 1}: attached document`}>
              {chip}
            </span>
          );
        })}
        {overflow > 0 && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground ring-2 ring-background" aria-label={`${overflow} more sources`}>
            +{overflow}
          </span>
        )}
      </div>
      <CountUp to={sources.length} duration={0.8} className="shrink-0 text-[11px] tabular-nums text-muted-foreground" />
    </div>
  );
}

export function SourcesPanel({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="space-y-1">
      {sources.map((s, i) => {
        const linkable = !s.url.startsWith("attachment://");
        const inner = (
          <>
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[13px] font-medium leading-snug">{s.title}</span>
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-foreground/60">
                <Favicon domain={s.domain} className="h-3.5 w-3.5" />
                {s.domain}
                {s.words > 0 && <span className="opacity-70">· {s.words.toLocaleString()} words read</span>}
              </span>
            </span>
          </>
        );
        const cls = "hover-lift group flex gap-2.5 rounded-[16px] border border-input bg-card p-3";
        const body = linkable ? (
          <a key={s.id} id={`ref-${i + 1}`} href={s.url} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
        ) : (
          <span key={s.id} id={`ref-${i + 1}`} className={`${cls} opacity-80`}>{inner}</span>
        );
        return (
          <FadeIn key={s.id} y={4}>
            {body}
          </FadeIn>
        );
      })}
    </div>
  );
}
