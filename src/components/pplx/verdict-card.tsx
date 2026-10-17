"use client";

import { Gavel, Scale, ShieldAlert, ShieldCheck, Sparkles } from "lucide-react";
import type { JobItem } from "@/components/research/types";
import { FadeIn } from "@/components/magic";

type Court = NonNullable<NonNullable<JobItem["stats"]>["court"]>;

/** The juror's vote chip — name, vote color, and the one-line reason that
 *  decided them. Hovering shows the persona's full lens. */
function JurorCell({ j, i }: { j: Court["jurors"][number]; i: number }) {
  const guilty = j.vote === "GUILTY";
  return (
    <FadeIn delay={Math.min(i * 40, 400)} className="h-full">
      <div
        className={`flex h-full flex-col gap-1.5 rounded-[14px] border p-3 transition-colors ${
          guilty ? "border-[#ff3b30]/25 bg-[#ff3b30]/[0.04] hover:bg-[#ff3b30]/[0.07]" : "border-[#248a3d]/25 bg-[#248a3d]/[0.05] hover:bg-[#248a3d]/[0.09]"
        }`}
        title={`${j.name} — ${j.lens}`}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-bold uppercase tracking-wide ${
              guilty ? "bg-[#ff3b30]/12 text-[#c4261e] dark:text-[#ff6961]" : "bg-[#248a3d]/12 text-[#1e7a33] dark:text-[#4ade80]"
            }`}
          >
            {j.vote === "GUILTY" ? "Guilty" : "Not guilty"}
          </span>
          <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">{j.name}</span>
        </div>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{j.reason}</p>
      </div>
    </FadeIn>
  );
}

function ListBlock({
  title, items, icon, tone,
}: { title: string; items: string[]; icon: React.ReactNode; tone: "bad" | "good" | "warn" }) {
  if (items.length === 0) return null;
  const toneCls =
    tone === "bad" ? "border-[#ff3b30]/25 bg-[#ff3b30]/[0.04]" : tone === "good" ? "border-[#248a3d]/25 bg-[#248a3d]/[0.05]" : "border-[#ff9f0a]/30 bg-[#ff9f0a]/[0.05]";
  return (
    <div className={`rounded-[16px] border p-4 ${toneCls}`}>
      <p className="mb-2.5 flex items-center gap-2 text-[12.5px] font-semibold">
        <span className="shrink-0" aria-hidden>{icon}</span>
        {title}
      </p>
      <ul className="space-y-2">
        {items.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground/90">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
            <span dir="auto">{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** THE VERDICT CARD — the trial's front page: the banner verdict with the vote
 *  split, the judge's plain-words summary, the 12-juror grid with each juror's
 *  deciding reason, and the judge's instructions (charges that stuck, what the
 *  defense established, conditions for next time). Rendered when stats.court
 *  exists; the full trial record lives in the report body below it. */
export function VerdictCard({ court }: { court: Court }) {
  const guilty = court.verdict === "GUILTY";
  const banner = guilty
    ? "border-[#ff3b30]/30 bg-[#ff3b30]/[0.06]"
    : "border-[#248a3d]/30 bg-[#248a3d]/[0.07]";
  const hasJurors = court.jurors.length > 0;
  return (
    <div className="mb-7">
      {/* the banner */}
      <div className={`overflow-hidden rounded-[20px] border ${banner}`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-card/70 shadow-elev-1" aria-hidden>
            <Gavel className={`h-5 w-5 ${guilty ? "text-[#c4261e] dark:text-[#ff6961]" : "text-[#1e7a33] dark:text-[#4ade80]"}`} />
          </span>
          <div className="min-w-0">
            <p className={`text-[19px] font-bold leading-tight tracking-[-0.01em] ${guilty ? "text-[#c4261e] dark:text-[#ff6961]" : "text-[#1e7a33] dark:text-[#4ade80]"}`}>
              {court.verdict}
              {hasJurors && (
                <span className="ml-2.5 align-middle text-[15px] font-semibold tabular-nums text-foreground/75">
                  {court.guilty} – {court.notGuilty}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {hasJurors
                ? `${court.jurors.length} jurors voted on the evidence${court.quick ? " · quick trial" : ""} · a jury of independent personas, not one model's opinion`
                : "the jury could not convene — briefs only, verdict withheld"}
            </p>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 rounded-full bg-card/60 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground sm:flex">
            <Scale className="h-3 w-3" aria-hidden /> court-skill style trial
          </span>
        </div>
        {court.judgeSummary && (
          <p dir="auto" className="border-t border-border/50 bg-card/40 px-5 py-3.5 text-[14px] leading-relaxed text-foreground/90">
            {court.judgeSummary}
          </p>
        )}
      </div>

      {/* the jury */}
      {hasJurors && (
        <div className="mt-4">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">The jury — {court.guilty} guilty · {court.notGuilty} not guilty</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {court.jurors.map((j, i) => (
              <JurorCell key={`${j.name}-${i}`} j={j} i={i} />
            ))}
          </div>
        </div>
      )}

      {/* the judge's instructions */}
      {(court.chargesStuck.length > 0 || court.defenseWins.length > 0 || court.conditions.length > 0) && (
        <div className="mt-4 grid gap-2.5 lg:grid-cols-3">
          <ListBlock title="Charges that stuck" items={court.chargesStuck} tone="bad" icon={<ShieldAlert className="h-4 w-4 text-[#c4261e] dark:text-[#ff6961]" />} />
          <ListBlock title="What the defense established" items={court.defenseWins} tone="good" icon={<ShieldCheck className="h-4 w-4 text-[#1e7a33] dark:text-[#4ade80]" />} />
          <ListBlock title="What to change before trying again" items={court.conditions} tone="warn" icon={<Sparkles className="h-4 w-4 text-[#b25000] dark:text-[#ff9f0a]" />} />
        </div>
      )}
    </div>
  );
}
