"use client";

import { ArrowLeftRight, Gavel, Scale, ShieldAlert, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { JobItem } from "@/components/research/types";
import { FadeIn } from "@/components/magic";

type Court = NonNullable<NonNullable<JobItem["stats"]>["court"]>;

/** The juror's vote chip — name, vote color, the one-line reason that decided
 *  them, their conviction level, and — when the jury deliberated — what they
 *  said in the room. Hovering shows the persona's full lens. */
function JurorCell({ j, i }: { j: Court["jurors"][number]; i: number }) {
  // v3.0.2: a malformed juror object renders an honest shell, never a crash
  if (!j || typeof j !== "object") {
    return (
      <div className="flex h-full min-h-[64px] flex-col justify-center rounded-[14px] border border-border/60 bg-card/40 p-3 text-[11.5px] text-muted-foreground">
        A juror&apos;s ballot could not be read from the record.
      </div>
    );
  }
  const guilty = j.vote === "GUILTY";
  const bar = guilty ? "bg-[#ff3b30]" : "bg-[#248a3d]";
  const name = typeof j.name === "string" && j.name ? j.name : `Juror ${i + 1}`;
  const lens = typeof j.lens === "string" ? j.lens : "";
  const reason = typeof j.reason === "string" ? j.reason : "";
  const confidence = typeof j.confidence === "number" && Number.isFinite(j.confidence) ? j.confidence : null;
  const deliberationReply = typeof j.deliberationReply === "string" ? j.deliberationReply : "";
  return (
    <FadeIn delay={Math.min(i * 40, 400)} className="h-full">
      <div
        className={`relative flex h-full flex-col gap-1.5 overflow-hidden rounded-[14px] border p-3 transition-colors ${
          guilty ? "border-[#ff3b30]/25 bg-[#ff3b30]/[0.04] hover:bg-[#ff3b30]/[0.07]" : "border-[#248a3d]/25 bg-[#248a3d]/[0.05] hover:bg-[#248a3d]/[0.09]"
        }`}
        title={`${name} — ${lens}${confidence != null ? ` · conviction ${confidence}%` : ""}${deliberationReply ? `\n\nIn deliberation: ${deliberationReply}` : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-bold uppercase tracking-wide ${
              guilty ? "bg-[#ff3b30]/12 text-[#c4261e] dark:text-[#ff6961]" : "bg-[#248a3d]/12 text-[#1e7a33] dark:text-[#4ade80]"
            }`}
          >
            {guilty ? "Guilty" : "Not guilty"}
          </span>
          <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">{name}</span>
          {j.changedVote && (
            <span
              className="ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-primary"
              title={`Changed their vote in deliberation${deliberationReply ? `: “${deliberationReply}”` : ""}`}
            >
              <ArrowLeftRight className="h-2.5 w-2.5" aria-hidden /> changed
            </span>
          )}
        </div>
        <p className="text-[11.5px] leading-snug text-muted-foreground">{reason}</p>
        {j.changedVote && deliberationReply && (
          <p className="border-l-2 border-primary/35 pl-2 text-[11px] italic leading-snug text-muted-foreground/85">
            {deliberationReply}
          </p>
        )}
        {/* conviction meter — how firmly this juror holds the vote */}
        {confidence != null && (
          <span
            className="absolute inset-x-0 bottom-0 h-[3px] bg-foreground/[0.05]"
            role="img"
            aria-label={`conviction ${confidence}%`}
          >
            <span className={`block h-full ${bar} opacity-70`} style={{ width: `${Math.max(4, Math.min(100, confidence))}%` }} />
          </span>
        )}
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
 *  split, the blind first ballot → deliberation → final ballot swing, the
 *  judge's plain-words summary, the foreman's summing-up, the 12-juror grid
 *  with each juror's deciding reason and conviction, and the judge's
 *  instructions. Rendered when stats.court exists; the full trial record
 *  lives in the report body below it.
 *  v3.0.2 HARDENING: the card renders stats blobs, not typed promises — a
 *  record that misses jurors/chargesStuck/defenseWins/conditions (older
 *  versions, partial writes, hand-edited or migrated data) must render
 *  honestly, never crash the thread. Every array access defaults, every
 *  number coerces, every string falls back. */
export function VerdictCard({ court }: { court: Court }) {
  // ── defensive normalization: the audit crash was court.chargesStuck.length
  //    on a record that simply lacked the field (undefined.length → white screen)
  const jurors = Array.isArray(court.jurors) ? court.jurors : [];
  const chargesStuck = Array.isArray(court.chargesStuck) ? court.chargesStuck : [];
  const defenseWins = Array.isArray(court.defenseWins) ? court.defenseWins : [];
  const conditions = Array.isArray(court.conditions) ? court.conditions : [];
  const guiltyVotes = Number(court.guilty) || 0;
  const notGuiltyVotes = Number(court.notGuilty) || 0;
  const verdictRaw = typeof court.verdict === "string" ? court.verdict : "";
  const hasJurors = jurors.length > 0;
  const hung = verdictRaw === "HUNG JURY";
  // a partial trial (jury never convened) must never read as an acquittal —
  // the record keeps a placeholder verdict for v2.x compatibility, the card
  // renders the truth: no verdict was rendered
  const verdictText = !hasJurors ? "VERDICT WITHHELD" : hung ? "HUNG JURY" : verdictRaw || "NOT GUILTY";
  const guilty = hasJurors && verdictRaw === "GUILTY";
  const amber = hung || !hasJurors; // neutral, honest tones for deadlock/no-verdict
  const banner = amber
    ? "border-[#ff9f0a]/35 bg-[#ff9f0a]/[0.06]"
    : guilty
      ? "border-[#ff3b30]/30 bg-[#ff3b30]/[0.06]"
      : "border-[#248a3d]/30 bg-[#248a3d]/[0.07]";
  const headline = amber
    ? "text-[#b25000] dark:text-[#ff9f0a]"
    : guilty
      ? "text-[#c4261e] dark:text-[#ff6961]"
      : "text-[#1e7a33] dark:text-[#4ade80]";
  const changedCount = jurors.filter((j) => j && j.changedVote).length;
  const swing = !!(court.deliberated && court.firstBallot && (court.firstBallot as { guilty?: number }).guilty != null);
  return (
    <div className="mb-7">
      {/* the banner */}
      <div className={`overflow-hidden rounded-[20px] border ${banner}`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-card/70 shadow-elev-1" aria-hidden>
            <Gavel className={`h-5 w-5 ${amber ? "text-[#b25000] dark:text-[#ff9f0a]" : guilty ? "text-[#c4261e] dark:text-[#ff6961]" : "text-[#1e7a33] dark:text-[#4ade80]"}`} />
          </span>
          <div className="min-w-0">
            <p className={`text-[19px] font-bold leading-tight tracking-[-0.01em] ${headline}`}>
              {verdictText}
              {hasJurors && (
                <span className="ml-2.5 align-middle text-[15px] font-semibold tabular-nums text-foreground/75">
                  {guiltyVotes} – {notGuiltyVotes}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {hasJurors
                ? hung
                  ? `${jurors.length} jurors split evenly — no verdict was reached on this proposition${court.quick ? " · quick trial" : ""}`
                  : `${jurors.length} jurors voted on the evidence${court.quick ? " · quick trial" : court.deliberated ? " · two ballots around a deliberation" : ""} · a jury of independent personas, not one model's opinion`
                : "the jury could not convene — briefs only, verdict withheld"}
            </p>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 rounded-full bg-card/60 px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground sm:flex">
            <Scale className="h-3 w-3" aria-hidden /> court-skill style trial
          </span>
        </div>
        {swing && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border/50 bg-card/30 px-5 py-2 text-[11.5px] font-medium text-muted-foreground">
            <ArrowLeftRight className="h-3 w-3 shrink-0 text-primary/70" aria-hidden />
            <span className="tabular-nums">First ballot {Number((court.firstBallot as { guilty?: number }).guilty) || 0}–{Number((court.firstBallot as { notGuilty?: number }).notGuilty) || 0}</span>
            <span aria-hidden>→</span>
            <span className="tabular-nums text-foreground/80">final {guiltyVotes}–{notGuiltyVotes}</span>
            <span className="text-muted-foreground">
              · {changedCount > 0 ? `${changedCount} juror${changedCount === 1 ? "" : "s"} changed their vote${changedCount === 1 ? "" : "s"} in deliberation` : "no vote moved in deliberation — the argument hardened positions"}
            </span>
          </p>
        )}
        {court.judgeSummary && (
          <p dir="auto" className="border-t border-border/50 bg-card/40 px-5 py-3.5 text-[14px] leading-relaxed text-foreground/90">
            {court.judgeSummary}
          </p>
        )}
      </div>

      {/* the jury */}
      {hasJurors && (
        <div className="mt-4">
          <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
            The jury — {guiltyVotes} guilty · {notGuiltyVotes} not guilty{court.deliberated ? " · voted twice, blind first" : ""}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {jurors.map((j, i) => (
              <JurorCell key={`${j?.name ?? "juror"}-${i}`} j={j} i={i} />
            ))}
          </div>
        </div>
      )}

      {/* the foreman's summing-up */}
      {court.foremanSummary && (
        <div className="mt-4 rounded-[16px] border border-primary/20 bg-primary/[0.04] p-4">
          <p className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10" aria-hidden>
              <Users className="h-3.5 w-3.5 text-primary" />
            </span>
            The foreman sums up the deliberation
          </p>
          <p dir="auto" className="text-[13px] leading-relaxed text-foreground/90">{court.foremanSummary}</p>
        </div>
      )}

      {/* the judge's instructions */}
      {(chargesStuck.length > 0 || defenseWins.length > 0 || conditions.length > 0) && (
        <div className="mt-4 grid gap-2.5 lg:grid-cols-3">
          <ListBlock title="Charges that stuck" items={chargesStuck} tone="bad" icon={<ShieldAlert className="h-4 w-4 text-[#c4261e] dark:text-[#ff6961]" />} />
          <ListBlock title="What the defense established" items={defenseWins} tone="good" icon={<ShieldCheck className="h-4 w-4 text-[#1e7a33] dark:text-[#4ade80]" />} />
          <ListBlock title={hung ? "What would break the deadlock" : "What to change before trying again"} items={conditions} tone="warn" icon={<Sparkles className="h-4 w-4 text-[#b25000] dark:text-[#ff9f0a]" />} />
        </div>
      )}
    </div>
  );
}
