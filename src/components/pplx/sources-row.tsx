"use client";

import { useState } from "react";
import { ArrowLeftRight, Ban, Globe } from "lucide-react";
import { CountUp, FadeIn } from "@/components/magic";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import type { SourceItem } from "@/components/research/types";

function FaviconInner({ domain, className = "h-4 w-4" }: { domain: string; className?: string }) {
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

/** Exported for reuse (Discover cards show the source site's mark). */
export const Favicon = FaviconInner;

/** Perplexity-style source chips — overlapping favicon circles that peek at the evidence.
 *
 * v3.2: the whole row is now a doorway to the FULL source list. The evidence
 * rail that used to hold it is xl-only — on every smaller screen there was no
 * way to see all sources, and the "+N" bubble was a dead-end span (the
 * "sources don't open" bug). Clicking the label/count (or +N) opens a bottom
 * sheet with every source, audit flags included. The favicon chips stay
 * direct links to the pages themselves. */
export function SourcesRow({ sources, audit }: { sources: SourceItem[]; audit?: { reanchoredTo?: number[]; dropped?: number[]; flagged?: number[] } }) {
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  const visible = sources.slice(0, 8);
  const overflow = sources.length - visible.length;
  return (
    <>
      <div className="fade-up flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="group/src flex min-w-0 items-center gap-2.5 rounded-full px-1 py-0.5 -mx-1 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="See all sources"
          aria-haspopup="dialog"
        >
          <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground group-hover/src:text-foreground">Sources</span>
          <span className="flex min-w-0 items-center -space-x-1.5" aria-hidden="true">
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
                <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className={cls} title={`[${i + 1}] ${s.title} — ${s.domain}`} aria-label={`Source ${i + 1}: ${s.domain}`} onClick={(e) => e.stopPropagation()}>
                  {chip}
                </a>
              ) : (
                <span key={s.id} className={`${cls} ring-border`} title={`[${i + 1}] ${s.title} — attached document`} aria-label={`Source ${i + 1}: attached document`}>
                  {chip}
                </span>
              );
            })}
            {overflow > 0 && (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground ring-2 ring-background transition-colors group-hover/src:bg-primary/10 group-hover/src:text-primary" aria-label={`${overflow} more sources`}>
                +{overflow}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground transition-colors group-hover/src:text-foreground">
            <CountUp to={sources.length} duration={0.8} />
          </span>
        </button>
      </div>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="max-h-[82dvh] rounded-t-[22px] px-0 pb-2">
          <div className="mx-auto mb-1 h-1 w-10 rounded-full bg-muted-foreground/25" aria-hidden />
          <DrawerTitle className="px-4 pb-2 text-[14px] font-semibold">
            All sources · <span className="tabular-nums text-muted-foreground">{sources.length}</span>
          </DrawerTitle>
          <DrawerDescription className="sr-only">Every source consulted by this research run, with audit flags.</DrawerDescription>
          <div className="max-h-[68dvh] overflow-y-auto px-3">
            <SourcesPanel sources={sources} audit={audit} />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export function SourcesPanel({ sources, audit }: { sources: SourceItem[]; audit?: { reanchoredTo?: number[]; dropped?: number[]; flagged?: number[] } }) {
  if (sources.length === 0) return null;
  return (
    <div className="space-y-1">
      {sources.map((s, i) => {
        const linkable = !s.url.startsWith("attachment://");
        const n = i + 1;
        const reanchored = audit?.reanchoredTo?.includes(n);
        const dropped = audit?.dropped?.includes(n);
        const inner = (
          <>
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">{n}</span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[13px] font-medium leading-snug">{s.title}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-foreground/60">
                <Favicon domain={s.domain} className="h-3.5 w-3.5" />
                {s.domain}
                {s.words > 0 && <span className="opacity-70">· {s.words.toLocaleString()} words read</span>}
                {reanchored && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#ff9f0a]/12 px-1.5 py-px text-[9.5px] font-semibold text-[#b25000] dark:text-[#ff9f0a]" title="A claim citing this source was re-anchored here by the citation audit">
                    <ArrowLeftRight className="h-2.5 w-2.5" /> re-anchored
                  </span>
                )}
                {dropped && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-px text-[9.5px] font-semibold text-destructive" title="A citation to this source was removed as unsupported">
                    <Ban className="h-2.5 w-2.5" /> dropped
                  </span>
                )}
              </span>
            </span>
          </>
        );
        const cls = "hover-lift group flex gap-2.5 rounded-[16px] border border-input bg-card p-3";
        const body = linkable ? (
          <a key={s.id} id={`ref-${n}`} href={s.url} target="_blank" rel="noreferrer" className={cls}>{inner}</a>
        ) : (
          <span key={s.id} id={`ref-${n}`} className={`${cls} opacity-80`}>{inner}</span>
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
