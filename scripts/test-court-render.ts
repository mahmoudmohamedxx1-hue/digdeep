/** COURT RENDER REGRESSION SUITE (v3.0.2). Run: bun scripts/test-court-render.ts
 *
 *  THE WHITE-SCREEN CLASS IS DEAD — AND THIS KEEPS IT DEAD.
 *  Renders the REAL VerdictCard (react-dom/server renderToStaticMarkup, no
 *  mocks, no jsdom) against 11 record variants: the honest ones and the
 *  broken ones real threads have actually carried — v2.x legacy records,
 *  partial writes, juryless partial trials, hand-injected data, and THE
 *  AUDIT CRASHER itself (chargesStuck/defenseWins missing → undefined.length
 *  → white screen, persistent via the IndexedDB turn cache).
 *
 *  Every variant must (1) not throw and (2) render its honest content.
 *  A juryless record must never read as an acquittal; a garbage juror
 *  renders an honest shell; out-of-range conviction clamps to the meter.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VerdictCard } from "../src/components/pplx/verdict-card";
import { parseAnswer } from "../src/lib/report-parse";
import type { JobItem } from "../src/components/research/types";

type Court = NonNullable<NonNullable<JobItem["stats"]>["court"]>;
type Juror = Court["jurors"][number];

let fails = 0;
let passes = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (cond) passes++;
  else fails++;
};

/** render + never throw — a throw here IS the white screen we are testing for */
function render(court: unknown): { html: string; err: string | null } {
  try {
    const html = renderToStaticMarkup(createElement(VerdictCard as never, { court } as never));
    return { html, err: null };
  } catch (e) {
    return { html: "", err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

function juror(i: number, vote: Juror["vote"], over: Partial<Juror> = {}): Juror {
  return {
    name: `Juror ${i + 1}`,
    lens: `the ${["historian", "statistician", "practitioner", "skeptic", "economist", "engineer"][i % 6]} lens`,
    vote,
    reason: `Reason ${i + 1} citing [${i + 1}].`,
    ...over,
  } as Juror;
}

console.log("— court render regression (the white-screen class)\n");

// ── 1. FULL v3.0 HUNG JURY — 6–6 from a 7–5 first ballot, 3 changed votes,
//      foreman, deadlock conditions, charges, defense wins, judge summary
{
  const jurors: Juror[] = Array.from({ length: 12 }, (_, i) =>
    juror(i, i < 7 ? "GUILTY" : "NOT GUILTY", {
      confidence: 55 + ((i * 7) % 40),
      changedVote: i === 2 || i === 5 || i === 9,
      deliberationReply: i === 2 ? "I answered the statistician — the study is correlative." : undefined,
    })
  );
  const { html, err } = render({
    charge: "X is better than Y",
    verdict: "HUNG JURY",
    guilty: 6,
    notGuilty: 6,
    jurors,
    firstBallot: { guilty: 7, notGuilty: 5 },
    deliberated: true,
    foremanSummary: "The room split on whether the evidence survives the rebuttals.",
    judgeSummary: "No verdict was reached on this proposition.",
    chargesStuck: ["The strongest evidence for the claim [1]"],
    defenseWins: ["The rebuttal study the prosecution never answered [4]"],
    conditions: ["A longitudinal study spanning 5+ years would break the deadlock"],
  });
  ok(!err, "1. full hung jury renders without throwing" + (err ? ` — ${err}` : ""));
  ok(html.includes("HUNG JURY"), "1. banner reads HUNG JURY");
  ok(html.includes("split evenly"), "1. honest split-evenly note");
  ok(html.includes("First ballot 7–5"), "1. the ballot swing line renders");
  ok(html.includes("final 6–6"), "1. final count in the swing line");
  ok(html.includes("3 jurors changed their votes in deliberation"), "1. changed-vote count");
  ok(html.includes("The foreman sums up the deliberation"), "1. foreman block");
  ok(html.includes("What would break the deadlock"), "1. hung-jury condition title");
  ok(html.includes("Charges that stuck"), "1. charges block");
  ok(html.includes("What the defense established"), "1. defense block");
  ok((html.match(/aria-label="conviction /g) || []).length === 12, "1. all 12 conviction meters");
}

// ── 2. UNANIMOUS GUILTY — 12–0, no deliberation fields at all
{
  const jurors: Juror[] = Array.from({ length: 12 }, (_, i) =>
    juror(i, "GUILTY", { confidence: 70 + ((i * 3) % 30) })
  );
  const { html, err } = render({
    charge: "X causes Y",
    verdict: "GUILTY",
    guilty: 12,
    notGuilty: 0,
    jurors,
    judgeSummary: "The evidence supports the charge.",
    chargesStuck: ["Point A [1]"],
    defenseWins: [],
    conditions: [],
  });
  ok(!err, "2. unanimous guilty renders without throwing");
  ok(html.includes("GUILTY"), "2. banner reads GUILTY");
  ok(html.includes("12 – 0"), "2. the 12–0 vote split");
  ok(html.includes("12 jurors voted on the evidence"), "2. jury note");
  ok(!html.includes("First ballot"), "2. no swing line without deliberation");
}

// ── 3. v2.x LEGACY — the old single-ballot record: no firstBallot, no
//      deliberated, no foreman, jurors without confidence/changedVote
{
  const jurors: Juror[] = Array.from({ length: 6 }, (_, i) => juror(i, i < 4 ? "GUILTY" : "NOT GUILTY"));
  const { html, err } = render({
    charge: "legacy claim",
    verdict: "GUILTY",
    guilty: 4,
    notGuilty: 2,
    jurors,
    judgeSummary: "Legacy judge text.",
  });
  ok(!err, "3. v2.x legacy record renders without throwing");
  ok(html.includes("4 – 2"), "3. legacy vote split");
  ok(!html.includes("The foreman sums up"), "3. no foreman block on legacy records");
  ok(!html.includes("conviction "), "3. no conviction meters on legacy jurors");
  ok(html.includes("Legacy judge text."), "3. judge summary still renders");
}

// ── 4. JURYLESS PARTIAL TRIAL — jury never convened; the placeholder
//      verdict must NEVER read as an acquittal
{
  const { html, err } = render({
    charge: "the jury could not convene",
    verdict: "NOT GUILTY", // the v2.x placeholder — the card must not display it
    guilty: 0,
    notGuilty: 0,
    jurors: [],
    judgeSummary: null,
  });
  ok(!err, "4. juryless partial renders without throwing");
  ok(html.includes("VERDICT WITHHELD"), "4. reads VERDICT WITHHELD, not an acquittal");
  ok(html.includes("the jury could not convene"), "4. honest could-not-convene note");
  ok(!html.includes("0 – 0"), "4. no vote split without a jury");
}

// ── 5. THE AUDIT CRASHER — chargesStuck/defenseWins missing entirely.
//      Before v3.0.2 this was `undefined.length` → white screen, cached
//      forever in the thread's IndexedDB turns.
{
  const { html, err } = render({
    charge: "the audit crasher",
    verdict: "GUILTY",
    guilty: 12,
    notGuilty: 0,
    jurors: Array.from({ length: 12 }, (_, i) => juror(i, "GUILTY", { confidence: 80 })),
    // chargesStuck: ABSENT, defenseWins: ABSENT, conditions: ABSENT
  });
  ok(!err, "5. THE AUDIT CRASHER renders without throwing" + (err ? ` — ${err}` : ""));
  ok(html.includes("GUILTY"), "5. verdict renders");
  ok(html.includes("Charges that stuck") === false, "5. no charges block when the field is absent");
}

// ── 6. jurors UNDEFINED — the key itself missing
{
  const { html, err } = render({
    charge: "no jurors key",
    verdict: "NOT GUILTY",
    guilty: 0,
    notGuilty: 12,
  });
  ok(!err, "6. missing jurors key renders without throwing");
  ok(html.includes("VERDICT WITHHELD"), "6. no jury → withheld, not acquitted");
}

// ── 7. jurors AS A STRING — garbage type from a bad write
{
  const { html, err } = render({
    charge: "garbage jurors",
    verdict: "GUILTY",
    guilty: 12,
    notGuilty: 0,
    jurors: "twelve angry men",
  });
  ok(!err, "7. jurors-as-string renders without throwing");
  ok(html.includes("VERDICT WITHHELD"), "7. unreadable jury → withheld");
}

// ── 8. NULL / GARBAGE JUROR ENTRIES — honest shells, never a crash
{
  const { html, err } = render({
    charge: "mixed garbage jurors",
    verdict: "GUILTY",
    guilty: 2,
    notGuilty: 1,
    jurors: [juror(0, "GUILTY", { confidence: 90 }), null, "a string juror", juror(1, "NOT GUILTY", { confidence: 60 }), {}] as unknown as Juror[],
  });
  ok(!err, "8. null/garbage juror entries render without throwing");
  ok(html.includes("A juror&#x27;s ballot could not be read"), "8. honest unreadable-ballot shell");
  ok(html.includes("Juror 2"), "8. empty juror object falls back to a numbered name");
  ok((html.match(/aria-label="conviction /g) || []).length === 2, "8. only the two real jurors get meters");
}

// ── 9. EMPTY COURT OBJECT — nothing but braces
{
  const { html, err } = render({});
  ok(!err, "9. empty court object renders without throwing");
  ok(html.includes("VERDICT WITHHELD"), "9. empty record → withheld");
  ok(html.includes("court-skill style trial"), "9. the card chrome still renders");
}

// ── 10. MALFORMED firstBallot — string, and garbage numbers inside
{
  const asString = render({
    charge: "bad ballot",
    verdict: "GUILTY",
    guilty: 8,
    notGuilty: 4,
    jurors: Array.from({ length: 12 }, (_, i) => juror(i, i < 8 ? "GUILTY" : "NOT GUILTY")),
    deliberated: true,
    firstBallot: "7–5",
  });
  ok(!asString.err, "10a. firstBallot-as-string renders without throwing");
  ok(!asString.html.includes("First ballot"), "10a. unreadable ballot → no swing line");

  const garbageNumbers = render({
    charge: "bad ballot numbers",
    verdict: "GUILTY",
    guilty: 8,
    notGuilty: 4,
    jurors: Array.from({ length: 12 }, (_, i) => juror(i, i < 8 ? "GUILTY" : "NOT GUILTY")),
    deliberated: true,
    firstBallot: { guilty: "seven", notGuilty: null },
  });
  ok(!garbageNumbers.err, "10b. garbage ballot numbers render without throwing");
  ok(garbageNumbers.html.includes("First ballot 0–0"), "10b. numbers coerce honestly to 0–0");
}

// ── 11. OUT-OF-RANGE CONFIDENCE — the meter clamps to 4..100%
{
  const { html, err } = render({
    charge: "clamped conviction",
    verdict: "GUILTY",
    guilty: 2,
    notGuilty: 0,
    jurors: [
      juror(0, "GUILTY", { confidence: 250 }),
      juror(1, "GUILTY", { confidence: -30 }),
    ],
  });
  ok(!err, "11. out-of-range confidence renders without throwing");
  ok(html.includes("conviction 250%"), "11. the raw conviction is labeled honestly");
  ok(html.includes("width:100%"), "11. 250% clamps the meter to 100%");
  ok(html.includes("width:4%"), "11. -30% clamps the meter to 4%");
}

// ── 12. POISON reportMd — parseAnswer must render what's there, never throw.
//      Found live in v3.0.3 testing: the page-level TOC memo called parseAnswer
//      on reportMd guarded only by truthiness — reportMd: 12345 threw
//      md.includes is not a function OUTSIDE the per-turn error boundary and
//      white-screened the whole thread page.
{
  const cases: [unknown, string | undefined, string][] = [
    [12345, "research", "12345"],
    [null, "research", ""],
    [undefined, "chat", ""],
    [{ poison: true }, "chat", "[object Object]"],
    [12345, "chat", "12345"],
  ];
  let all = true;
  for (const [md, mode, wantBody] of cases) {
    try {
      const p = parseAnswer(md as string, mode);
      if (p.body !== wantBody) {
        all = false;
        console.log(`    ✗ ${JSON.stringify(md)} / ${mode} → body ${JSON.stringify(p.body)}, want ${JSON.stringify(wantBody)}`);
      }
    } catch (e) {
      all = false;
      console.log(`    ✗ ${JSON.stringify(md)} / ${mode} THREW: ${e}`);
    }
  }
  ok(all, "12. poison reportMd parses to honest text, never throws");
}

console.log(
  `\n${fails === 0 ? "ALL PASS" : "FAILURES"} — ${passes} passed, ${fails} failed, 12 variants`
);
process.exit(fails === 0 ? 0 : 1);
