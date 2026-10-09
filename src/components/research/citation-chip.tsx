"use client";

import { useState } from "react";
import { ArrowLeftRight, BadgeCheck, Globe, Link2, Scale } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SourceItem } from "@/components/research/types";
import type { ReportRef } from "@/lib/report-parse";
import type { ClaimCheck, ClaimVerdict } from "@/lib/claim-support";

export interface CitationAudit {
  reanchoredTo?: number[];
  dropped?: number[];
  flagged?: number[];
}

/** Payload the evidence panel needs for one selected claim. */
export interface ClaimSelection {
  check: ClaimCheck;
  refs: ReportRef[];
  sources: SourceItem[];
  reportMd: string | null;
  /** the whole ledger of the selected report — powers the copy-with-appendix action */
  allChecks?: ClaimCheck[];
  /** one-line verdict summary, e.g. "3 of 5 sources fully support their claims" */
  summaryLine?: string;
}

export interface CitationContext {
  /** the run's sources, in citation order */
  sources?: SourceItem[];
  /** refs parsed from the report's References section (authoritative n → source) */
  refs?: ReportRef[];
  /** per-citation audit trail from the engine */
  audit?: CitationAudit;
  /** Phase 2 — claim ledger; chips with a matching check carry its verdict */
  checks?: ClaimCheck[];
  /** selecting a claim (chip click) opens the evidence panel */
  onSelectClaim?: (sel: ClaimSelection, chipEl: HTMLElement) => void;
  /** currently selected check id (for active styling + focus return) */
  selectedCheckId?: string;
}

function FallbackFavicon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Globe className={`${className} text-muted-foreground`} aria-hidden />;
}

const VERDICT_COPY: Record<ClaimVerdict, { label: string; icon: typeof BadgeCheck }> = {
  verified: { label: "Verified", icon: BadgeCheck },
  partly: { label: "Partly supported", icon: Scale },
  unverified: { label: "Unverified", icon: Scale },
};

/** The card body — shared by the hover card (pointer) and the evidence panel. */
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
    ? { label: "Re-anchored", icon: ArrowLeftRight, cls: "bg-amber-500/12 text-amber-700 dark:text-amber-400" }
    : { label: "Verified", icon: BadgeCheck, cls: "bg-emerald-600/12 text-emerald-700 dark:text-emerald-400" };

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
 * Inline citation chip — the `[n]` in a report sentence. When the report
 * carries a claim ledger, the chip shows its verdict three ways (color,
 * underline pattern solid/dashed/wavy, icon+label in hover/aria) so colour is
 * never the only signal. Clicking selects the claim and opens the evidence
 * panel; hovering (pointer) still peeks at the source.
 */
export function CitationChip({ n, ctx }: { n: number; ctx?: CitationContext }) {
  const isMobile = useIsMobile();
  const check = ctx?.checks?.find((c) => c.n === n && c.verdict);
  const reanchored = ctx?.audit?.reanchoredTo?.includes(n);
  const verdict = check?.verdict;
  const selected = check && ctx?.selectedCheckId === check.id;
  const vCopy = verdict ? VERDICT_COPY[verdict] : null;

  const chip = (extra?: object) => (
    <a
      href={`#cite-${n}`}
      id={`cite-${n}`}
      className={`cite-chip no-underline ${verdict ? `cite-v-${verdict}` : ""} ${selected ? "cite-v-selected" : ""}`}
      data-audit={reanchored ? "reanchored" : verdict ? verdict : "verified"}
      aria-label={`Citation ${n}${verdict ? ` — ${vCopy?.label.toLowerCase()}, ${Math.round(check!.support * 100)}% support` : reanchored ? " — re-anchored by the citation audit" : " — verified"}. Select to see the evidence.`}
      title={`Citation ${n} — ${ctx?.refs?.find((r) => r.n === n)?.title ?? ctx?.sources?.[n - 1]?.title ?? "source"}${verdict ? ` (${vCopy?.label.toLowerCase()})` : ""}`}
      onClick={(e) => {
        if (check && ctx?.onSelectClaim) {
          e.preventDefault();
          ctx.onSelectClaim(
            { check, refs: ctx.refs ?? [], sources: ctx.sources ?? [], reportMd: null },
            e.currentTarget as HTMLElement
          );
        }
      }}
      {...extra}
    >
      {n}
    </a>
  );

  // touch users: no hover affordance — the tap goes straight to the evidence
  // panel (richer than the old popover), so no popover branch is needed
  if (isMobile) return chip();

  return (
    <HoverCard openDelay={200} closeDelay={120}>
      <HoverCardTrigger asChild>{chip()}</HoverCardTrigger>
      <HoverCardContent align="start" side="top" className="glass w-[320px] rounded-[18px] p-4">
        <CitationCardBody n={n} ctx={ctx} />
      </HoverCardContent>
    </HoverCard>
  );
}
