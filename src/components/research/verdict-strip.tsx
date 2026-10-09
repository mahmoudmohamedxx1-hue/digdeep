"use client";

import { useState } from "react";
import {
  BadgeCheck, Check, ChevronDown, Clock, Globe2, Scale, Swords,
  MessagesSquare, XCircle, ArrowLeftRight,
} from "lucide-react";
import type { JobItem } from "@/components/research/types";
import { fmtElapsed } from "@/components/research/types";
import { CountUp } from "@/components/magic";

type Stats = NonNullable<JobItem["stats"]>;
type Quality = NonNullable<Stats["quality"]>;

const toneText = (s: number) => (s >= 7.5 ? "text-[#248a3d] dark:text-[#30d158]" : s >= 5.5 ? "text-[#b25000] dark:text-[#ff9f0a]" : "text-destructive");
const integrityTone = (v: number) => (v >= 90 ? "text-[#248a3d] dark:text-[#30d158]" : v >= 70 ? "text-[#b25000] dark:text-[#ff9f0a]" : "text-destructive");

function Cell({ icon, label, value, toneCls }: { icon: React.ReactNode; label: string; value: React.ReactNode; toneCls?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground/70" aria-hidden>{icon}</span>
      <span className={`shrink-0 text-[12.5px] font-semibold tabular-nums ${toneCls ?? "text-foreground"}`}>{value}</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">{label}</span>
    </span>
  );
}

/** The expanded panel — the full self-scored quality card plus the citation
 *  audit trail, source diversity and adversarial checks, all in one place. */
function ExpandedCard({ stats, quality }: { stats: Stats; quality?: Quality }) {
  const integrity = stats.citationIntegrity;
  const audit = stats.citationAudit;
  const diversity = stats.sourceDiversity;
  const r = 21;
  const circ = 2 * Math.PI * r;
  const pct = quality ? Math.max(0, Math.min(1, quality.overall / 10)) : 0;

  return (
    <div className="space-y-6 border-t border-border/60 px-4 py-4 sm:px-5">
      {/* quality ring + dims */}
      {quality && (
        <div>
          <div className="flex items-center gap-4">
            <span className="relative flex h-12 w-12 shrink-0 items-center justify-center" role="img" aria-label={`Overall quality ${quality.overall} out of 10`}>
              <svg viewBox="0 0 46 46" className="h-12 w-12 -rotate-90">
                <circle cx="23" cy="23" r={r} fill="none" strokeWidth="4" className="stroke-muted" />
                <circle
                  cx="23" cy="23" r={r} fill="none" strokeWidth="4" strokeLinecap="round"
                  className={quality.overall >= 7.5 ? "stroke-[#34c759]" : quality.overall >= 5.5 ? "stroke-[#ff9f0a]" : "stroke-destructive"}
                  strokeDasharray={`${circ * pct} ${circ}`}
                  style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.25,0.1,0.25,1)" }}
                />
              </svg>
              <CountUp
                to={quality.overall}
                decimals={1}
                duration={0.9}
                className={`absolute text-[15px] font-semibold tabular-nums ${toneText(quality.overall)}`}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Report quality — self-scored</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                Graded against the success criteria defined before the research started. Honest when bad, on purpose.
              </p>
            </div>
          </div>
          {quality.dims.length > 0 && (
            <div className="mt-5 space-y-3">
              {quality.dims.map((d, i) => (
                <div key={i}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium capitalize">{d.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{d.score.toFixed(1)}</span>
                  </div>
                  <div className="h-[5px] overflow-hidden rounded-full bg-muted/70">
                    <div
                      className={`h-full rounded-full ${d.score >= 7.5 ? "bg-[#34c759]" : d.score >= 5.5 ? "bg-[#ff9f0a]" : "bg-destructive"}`}
                      style={{ width: `${Math.max(3, d.score * 10)}%`, transition: "width 700ms cubic-bezier(0.25,0.1,0.25,1)" }}
                    />
                  </div>
                  {d.note && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{d.note}</p>}
                </div>
              ))}
            </div>
          )}
          {quality.criteria.length > 0 && (
            <div className="mt-5 space-y-2 border-t border-border/60 pt-4">
              {quality.criteria.map((c, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  {c.met ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#248a3d] dark:text-[#30d158]" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b25000] dark:text-[#ff9f0a]" />}
                  <div className="min-w-0">
                    <p className="text-xs leading-snug">{c.criterion}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{c.why}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {quality.biggestWeakness && (
            <p className="mt-4 rounded-[12px] bg-muted/50 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Biggest weakness:</span> {quality.biggestWeakness}
            </p>
          )}
        </div>
      )}

      {/* citation audit trail */}
      {integrity != null && (
        <div className="rounded-[14px] border border-border/60 bg-muted/30 p-3.5">
          <p className="flex items-center gap-2 text-xs font-semibold">
            <BadgeCheck className="h-4 w-4 text-primary" />
            Citation audit
            <span className={`ml-auto text-[13px] font-semibold tabular-nums ${integrityTone(integrity)}`}>{integrity}%</span>
          </p>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Every citation was checked against the text actually read from its source.
            {(stats.citationsChecked ?? 0) > 0 ? (
              <>
                {" "}{stats.citationsChecked} flagged as weakly anchored were judged individually:{" "}
                <span className="font-medium text-foreground">{stats.citationsRepaired ?? 0} re-anchored</span> to the right source,{" "}
                <span className="font-medium text-foreground">{stats.citationsDropped ?? 0} removed</span> as unsupported.
              </>
            ) : (
              " All were well-anchored — nothing needed repair."
            )}
          </p>
          {audit && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {audit.reanchoredTo && audit.reanchoredTo.length > 0 && (
                <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[#ff9f0a]/12 px-2 text-[10.5px] font-medium text-[#b25000] dark:text-[#ff9f0a]">
                  <ArrowLeftRight className="h-3 w-3" /> re-anchored: [{audit.reanchoredTo.join("], [")}]
                </span>
              )}
              {audit.dropped && audit.dropped.length > 0 && (
                <span className="inline-flex h-6 items-center gap-1 rounded-full bg-destructive/10 px-2 text-[10.5px] font-medium text-destructive">
                  dropped: [{audit.dropped.join("], [")}]
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* diversity + adversarial checks */}
      <div className="flex flex-wrap gap-1.5">
        {diversity?.domains != null && diversity.domains > 0 && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
            <Globe2 className="h-3.5 w-3.5" />
            {diversity.domains} domains{diversity.topDomain ? ` · top: ${diversity.topDomain} ${diversity.topShare}%` : ""}
          </span>
        )}
        {diversity?.medianAgeMonths != null && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> median source age ~{diversity.medianAgeMonths}mo
          </span>
        )}
        {(stats.redTeamAttacks ?? 0) > 0 && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
            <Swords className="h-3.5 w-3.5" /> red-teamed ({stats.redTeamAttacks} attacks)
          </span>
        )}
        {(stats.debated ?? 0) > 0 && (
          <span className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-[11px] font-medium text-muted-foreground">
            <MessagesSquare className="h-3.5 w-3.5" /> {stats.debated} claim{stats.debated === 1 ? "" : "s"} debated
          </span>
        )}
      </div>
    </div>
  );
}

/** The claim-verdict bar — “X of Y sources fully support their claims”, one
 *  segmented bar with three textures (solid / stripes / dots) so pattern, not
 *  just colour, carries the meaning. Counts as text for good measure. */
function ClaimVerdictBar({ v }: { v: NonNullable<Stats["claimVerdict"]> }) {
  const total = v.verified + v.partly + v.unverified;
  if (total === 0) return null;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
        <span className="font-semibold tabular-nums text-[var(--verify-text)]">
          {v.fullySupported} of {v.citedSources}
        </span>
        <span className="text-muted-foreground">sources fully support their claims</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-[3px] bg-[var(--verify)]" aria-hidden /> {v.verified} verified
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="claim-v-partly-dot h-2 w-2 rounded-[3px] bg-[var(--warn)]" aria-hidden /> {v.partly} partly
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="claim-v-unverified-dot h-2 w-2 rounded-[3px] bg-[var(--bad)]" aria-hidden /> {v.unverified} unverified
          </span>
        </span>
      </p>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Claim support: ${v.verified} verified, ${v.partly} partly supported, ${v.unverified} unverified out of ${total} checks; ${v.fullySupported} of ${v.citedSources} sources fully support their claims`}
      >
        {v.verified > 0 && <span className="h-full bg-[var(--verify)]" style={{ width: pct(v.verified) }} />}
        {v.partly > 0 && <span className="claim-v-partly-seg h-full" style={{ width: pct(v.partly) }} />}
        {v.unverified > 0 && <span className="claim-v-unverified-seg h-full" style={{ width: pct(v.unverified) }} />}
      </div>
    </div>
  );
}

/**
 * The verdict strip — one honest row directly under the question:
 * integrity %, quality score, source & domain counts, elapsed time, plus the
 * claim-verdict bar. Click to expand the full quality card in place.
 */
export function VerdictStrip({ job }: { job: JobItem }) {
  const [open, setOpen] = useState(false);
  const stats = job.stats;
  if (!stats) return null;

  const integrity = stats.citationIntegrity;
  const quality = stats.quality;
  const sources = stats.sourcesConsulted;
  const domains = stats.sourceDiversity?.domains;
  const duration = stats.durationMs;
  const hasAny = integrity != null || quality != null || sources != null || duration != null;
  if (!hasAny) return null;

  return (
    <div className="surface-quiet overflow-hidden rounded-[18px]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="verdict-detail"
        className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-accent/60 sm:px-5"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
          <Scale className="h-3.5 w-3.5 text-primary/80" aria-hidden />
          Verdict
        </span>
        {integrity != null && (
          <Cell
            icon={<BadgeCheck className="h-3.5 w-3.5" aria-hidden />}
            label="integrity"
            value={<>{integrity}%</>}
            toneCls={integrityTone(integrity)}
          />
        )}
        {quality && (
          <Cell icon={<Scale className="h-3.5 w-3.5" aria-hidden />} label="quality" value={<>{quality.overall.toFixed(1)}<span className="text-muted-foreground/70">/10</span></>} toneCls={toneText(quality.overall)} />
        )}
        {sources != null && (
          <Cell
            icon={<Globe2 className="h-3.5 w-3.5" aria-hidden />}
            label={domains ? `${domains} domains` : "sources"}
            value={<>{sources} sources</>}
          />
        )}
        {duration != null && (
          <Cell icon={<Clock className="h-3.5 w-3.5" aria-hidden />} label="elapsed" value={fmtElapsed(duration)} />
        )}
        <ChevronDown
          className={`ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-apple ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {stats.claimVerdict && <ClaimVerdictBar v={stats.claimVerdict} />}
      <div
        id="verdict-detail"
        className="grid transition-[grid-template-rows] duration-300 ease-apple"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        aria-hidden={!open}
        {...(open ? {} : { inert: true })}
      >
        <div className="overflow-hidden">
          <ExpandedCard stats={stats} quality={quality} />
        </div>
      </div>
    </div>
  );
}
