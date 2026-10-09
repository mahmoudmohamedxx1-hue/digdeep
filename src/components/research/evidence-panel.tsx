"use client";

import { useMemo, useState } from "react";
import {
  BadgeCheck, ChevronLeft, ChevronRight, Copy, ExternalLink, MapPin, Quote,
  RefreshCw, Search, Scale, Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { CLOSENESS_LABEL, lexicalSupport, type ClaimCheck, type ClaimVerdict } from "@/lib/claim-support";
import type { ClaimSelection } from "@/components/research/citation-chip";

const VERDICT_META: Record<ClaimVerdict, { label: string; icon: typeof BadgeCheck; chip: string; iconCls: string }> = {
  verified: { label: "Verified", icon: BadgeCheck, chip: "bg-[var(--verify)]/12 text-[var(--verify-text)]", iconCls: "text-[var(--verify-text)]" },
  partly: { label: "Partly supported", icon: Scale, chip: "bg-[var(--warn)]/12 text-[var(--warn-text)]", iconCls: "text-[var(--warn-text)]" },
  unverified: { label: "Unverified", icon: Scale, chip: "bg-[var(--bad)]/12 text-[var(--bad-text)]", iconCls: "text-[var(--bad-text)]" },
};

export interface EvidencePanelProps {
  selection: ClaimSelection;
  index: number; // 0-based position in the document order
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onGoDeeper?: (claimText: string) => void;
  /** hide chrome that only makes sense in the sheet variant */
  inSheet?: boolean;
}

/** One action row item. */
function ActBtn({ icon: Icon, label, onClick, title }: { icon: typeof Copy; label: string; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="press-scale flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border border-border/70 bg-card px-2 py-2 text-[10.5px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

/**
 * The evidence panel — the claim's day in court. Shows the passage the claim
 * rests on, the source, how close it is to the original, where to look, and
 * the honest support ratio. Every "re-check" is the SAME deterministic
 * algorithm the engine ran (src/lib/claim-support.ts) — labeled as such,
 * never as a fresh model judgement.
 */
export function EvidencePanel({ selection, index, total, onPrev, onNext, onGoDeeper, inSheet }: EvidencePanelProps) {
  const { check } = selection;
  const meta = VERDICT_META[check.verdict];
  const supportPct = Math.round(check.support * 100);
  const ref = selection.refs.find((r) => r.n === check.n);
  const url = ref?.url ?? selection.sources.find((s, i) => i === check.n - 1)?.url ?? "";
  const [recheck, setRecheck] = useState<{ support: number; at: number } | null>(null);

  const citeText = useMemo(
    () =>
      [
        `"${check.passage || "(no passage recorded)"}"`,
        `— ${check.sourceTitle}${check.sourceDomain ? `, ${check.sourceDomain}` : ""}${url ? ` ${url}` : ""}`,
        `Cited as [${check.n}] in "${check.section}" · ${meta.label.toLowerCase()} (lexical support ${supportPct}%)`,
      ].join("\n"),
    [check, url, meta.label, supportPct]
  );

  const copyAnnotatedReport = () => {
    const md = selection.reportMd ?? "";
    const lines = md.split("\n");
    const cut = lines.findIndex((l) => l.startsWith("## References"));
    const head = cut > 0 ? lines.slice(0, cut).join("\n") : md;
    const all = selection.allChecks ?? [];
    const appendix = [
      "",
      "---",
      "## Claim verification appendix",
      "",
      ...(selection.summaryLine ? [selection.summaryLine, ""] : []),
      ...all.map(
        (c) =>
          `- [${c.n}] ${VERDICT_META[c.verdict].label.toLowerCase()} · ${Math.round(c.support * 100)}% support · ${c.sourceTitle}${c.sourceDomain ? ` (${c.sourceDomain})` : ""}${c.passage ? ` — "${c.passage.slice(0, 160)}${c.passage.length > 160 ? "…" : ""}"` : ""}`
      ),
    ].join("\n");
    const out = `${head}\n${appendix}`;
    navigator.clipboard
      .writeText(out)
      .then(() => toast({ title: "Copied — report with claim appendix" }))
      .catch(() => toast({ title: "Copy failed", description: "Your browser blocked clipboard access — select the text manually.", variant: "destructive" }));
  };

  return (
    <div
      className={inSheet ? "px-1" : "surface-quiet rounded-[18px]"}
      role="complementary"
      aria-label={`Evidence for claim ${index + 1} of ${total}`}
    >
      <div aria-live="polite" className="space-y-4 p-4 sm:p-5">
        {/* header: verdict + position + prev/next */}
        <div className="flex items-start gap-2">
          <span className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold ${meta.chip}`}>
            <meta.icon className={`h-4 w-4 ${meta.iconCls}`} aria-hidden />
            {meta.label}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {!inSheet && (
              <span className="mr-1 text-[11px] tabular-nums text-muted-foreground" aria-hidden>
                {index + 1}/{total}
              </span>
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-[12px]"
              disabled={index <= 0}
              onClick={onPrev}
              aria-label="Previous claim (K)"
              title="Previous claim — K"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-[12px]"
              disabled={index >= total - 1}
              onClick={onNext}
              aria-label="Next claim (J)"
              title="Next claim — J"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </span>
        </div>

        {/* the claim */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">The claim</p>
          <p dir="auto" className="rounded-[14px] bg-muted/50 px-3.5 py-2.5 text-[13.5px] leading-relaxed">
            {check.text}{" "}
            <span className={`cite-chip cite-v-${check.verdict} no-underline`}>[{check.n}]</span>
          </p>
        </div>

        {/* the passage */}
        {check.passage ? (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
              <Quote className="h-3.5 w-3.5" aria-hidden /> The passage it rests on
            </p>
            <blockquote dir="auto" className="report-prose !max-none border-l-2 border-[var(--verify)]/50 pl-3.5 pr-1 !text-[13px] leading-relaxed text-foreground/90">
              {check.passage}
            </blockquote>
          </div>
        ) : (
          <p className="rounded-[14px] border border-dashed px-3.5 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            No passage was recorded for this claim — the source text was too short to quote from.
          </p>
        )}

        {/* source + closeness + where */}
        <div className="space-y-2 text-[12.5px] leading-relaxed">
          <p className="flex items-start gap-2">
            <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80" style={{ minWidth: 84 }}>
              Source
            </span>
            <span className="min-w-0 flex-1">
              {check.sourceTitle}
              {check.sourceDomain && <span className="text-muted-foreground"> · {check.sourceDomain}</span>}
              {url && (
                <>
                  {" "}
                  <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11.5px] font-medium text-primary hover:underline">
                    <ExternalLink className="h-3 w-3" /> open
                  </a>
                </>
              )}
            </span>
          </p>
          <p className="flex items-start gap-2">
            <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80" style={{ minWidth: 84 }}>
              Closeness
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium capitalize">{check.closeness === "peer" ? "peer-reviewed" : check.closeness}</span>
              <span className="text-muted-foreground"> — {CLOSENESS_LABEL[check.closeness]}</span>
            </span>
          </p>
          <p className="flex items-start gap-2">
            <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80" style={{ minWidth: 84 }}>
              Where to look
            </span>
            <span className="min-w-0 flex-1">
              Section “{check.section}” · reference [{check.n}] in the report footer
            </span>
          </p>
          <p className="flex items-start gap-2">
            <span className="mt-[3px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80" style={{ minWidth: 84 }}>
              Support
            </span>
            <span className="min-w-0 flex-1">
              {supportPct}% lexical overlap
              {recheck && (
                <span className="text-muted-foreground">
                  {" "}· re-checked locally just now: {Math.round(recheck.support * 100)}% ({recheck.support >= 0.3 ? "verified" : recheck.support >= 0.15 ? "partly" : "unverified"})
                </span>
              )}
            </span>
          </p>
        </div>

        {/* honest note, when there is one */}
        {check.note && (
          <p className="flex items-start gap-2 rounded-[12px] bg-muted/50 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {check.note}
          </p>
        )}

        {/* re-check explanation — what a re-check IS, said plainly */}
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          Re-checks rerun the same deterministic overlap algorithm the engine used at report time —
          no model call, no new information. The original verdict stands unless you doubt the source text itself.
        </p>

        {/* actions */}
        <div className="flex flex-wrap gap-1.5">
          <ActBtn
            icon={Copy}
            label="Copy citation"
            title="Copy the passage + source as a citation"
            onClick={() => {
              navigator.clipboard
                .writeText(citeText)
                .then(() => toast({ title: "Citation copied" }))
                .catch(() => toast({ title: "Copy failed", description: "Your browser blocked clipboard access.", variant: "destructive" }));
            }}
          />
          <ActBtn
            icon={RefreshCw}
            label="Re-check"
            title="Rerun the deterministic support check locally"
            onClick={() => setRecheck({ support: lexicalSupport(check.text, check.passage || ""), at: Date.now() })}
          />
          {onGoDeeper && (
            <ActBtn
              icon={Search}
              label="Go deeper"
              title="Start a focused research run on this claim"
              onClick={() => onGoDeeper(check.text)}
            />
          )}
          <ActBtn
            icon={Layers}
            label="Copy + appendix"
            title="Copy the report with the claim verification appendix"
            onClick={copyAnnotatedReport}
          />
        </div>
      </div>
    </div>
  );
}
