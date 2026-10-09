"use client";

import { useState } from "react";
import { ArrowLeftRight, BadgeCheck, Globe, Link2 } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SourceItem } from "@/components/research/types";
import type { ReportRef } from "@/lib/report-parse";

export interface CitationAudit {
  reanchoredTo?: number[];
  dropped?: number[];
  flagged?: number[];
}

export interface CitationContext {
  /** the run's sources, in citation order */
  sources?: SourceItem[];
  /** refs parsed from the report's References section (authoritative n → source) */
  refs?: ReportRef[];
  /** per-citation audit trail from the engine */
  audit?: CitationAudit;
}

function FallbackFavicon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Globe className={`${className} text-muted-foreground`} aria-hidden />;
}

/** The card body — shared by the hover card (pointer) and popover (touch). */
function CitationCardBody({ n, ctx }: { n: number; ctx?: CitationContext }) {
  const [imgErr, setImgErr] = useState(false);
  const ref = ctx?.refs?.find((r) => r.n === n);
  const src = ctx?.sources?.[n - 1];
  const title = ref?.title || src?.title || `Source ${n}`;
  const domain = ref?.domain || src?.domain || "";
  const url = ref?.url || src?.url || "";
  const excerpt = src?.snippet?.trim() || "";
  const attachment = !url || url.startsWith("attachment://");

  const reanchored = ctx?.audit?.reanchoredTo?.includes(n);
  const badge = reanchored
    ? { label: "Re-anchored", icon: ArrowLeftRight, cls: "bg-[#ff9f0a]/12 text-[#b25000] dark:text-[#ff9f0a]" }
    : { label: "Verified", icon: BadgeCheck, cls: "bg-[#34c759]/12 text-[#248a3d] dark:text-[#30d158]" };

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
          {n}
        </span>
        <p className="line-clamp-2 min-w-0 text-[13px] font-medium leading-snug">{title}</p>
      </div>
      {domain && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {!imgErr && domain && !attachment ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
              alt=""
              width={14}
              height={14}
              referrerPolicy="no-referrer"
              className="h-3.5 w-3.5 rounded-sm"
              onError={() => setImgErr(true)}
            />
          ) : (
            <FallbackFavicon />
          )}
          <span className="truncate">{domain}</span>
          {attachment && <span className="opacity-70">· your document</span>}
        </p>
      )}
      {excerpt && (
        <p className="line-clamp-4 rounded-lg bg-muted/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {excerpt}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[10.5px] font-semibold ${badge.cls}`}>
          <badge.icon className="h-3 w-3" />
          {badge.label}
          {reanchored && <span className="font-normal opacity-80">by citation audit</span>}
        </span>
        {!attachment && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <Link2 className="h-3 w-3" /> Open source
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Inline citation chip — the `[n]` in a report sentence. Pointer users get a
 * hover card (source, domain, the excerpt that supports the claim, the audit
 * badge); touch users get a tap-to-open popover instead. Clicking still jumps
 * to the reference list entry when one is on the page.
 */
export function CitationChip({ n, ctx }: { n: number; ctx?: CitationContext }) {
  const isMobile = useIsMobile();
  const reanchored = ctx?.audit?.reanchoredTo?.includes(n);
  const chip = (extra?: object) => (
    <a
      href={`#ref-${n}`}
      className="cite-chip no-underline"
      data-audit={reanchored ? "reanchored" : "verified"}
      aria-label={`Citation ${n}${reanchored ? " — re-anchored by the citation audit" : " — verified"}`}
      title={`Citation ${n} — ${ctx?.refs?.find((r) => r.n === n)?.title ?? ctx?.sources?.[n - 1]?.title ?? "source"}`}
      {...extra}
    >
      {n}
    </a>
  );

  if (isMobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>{chip({ href: undefined })}</PopoverTrigger>
        <PopoverContent align="center" side="top" className="glass w-[288px] rounded-[18px] p-3.5">
          <CitationCardBody n={n} ctx={ctx} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <HoverCard openDelay={140} closeDelay={90}>
      <HoverCardTrigger asChild>{chip()}</HoverCardTrigger>
      <HoverCardContent align="start" side="top" className="glass w-[320px] rounded-[18px] p-4">
        <CitationCardBody n={n} ctx={ctx} />
      </HoverCardContent>
    </HoverCard>
  );
}
