/** THE PERFECT JURY tests (v3.0). Run: bun scripts/test-jury.ts
 *  Covers, without any LLM calls:
 *  - finalVerdictOf: majority logic + THE TIE RULE (a tie is a HUNG JURY,
 *    never a silent acquittal)
 *  - ballotContested: the deliberation gate (close splits argue; unanimous
 *    or decisive ballots stand; quick juries have their own margin)
 *  - parseStrictVote: THE SPOILED-BALLOT FIX (garbage is null, never "NOT
 *    GUILTY") + tolerant forms (case, underscores, "innocent", "acquit")
 *  - prompt contracts: the first ballot asks for confidence + [n] reasons;
 *    the deliberation shows every other juror's reason + the anti-herd rule;
 *    the foreman sees both ballots and the changed votes; the judge gets a
 *    dedicated hung-jury instruction when (and only when) the vote is tied
 *  - the verdict record: deliberated trials carry firstBallot/deliberated/
 *    foremanSummary; v2.x records (no deliberation fields) still satisfy the
 *    UI contract (regression) */
import {
  JURORS,
  finalVerdictOf,
  ballotContested,
  parseStrictVote,
  juryQuorate,
  jurorPrompt,
  deliberationPrompt,
  foremanPrompt,
  judgePrompt,
  type CourtVerdict,
  type JurorBallot,
} from "../src/lib/research/court";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) fails++;
};

console.log("— finalVerdictOf (the tie rule)");
ok(finalVerdictOf(7, 5) === "GUILTY", "7–5 → GUILTY");
ok(finalVerdictOf(5, 7) === "NOT GUILTY", "5–7 → NOT GUILTY");
ok(finalVerdictOf(12, 0) === "GUILTY", "12–0 → GUILTY");
ok(finalVerdictOf(0, 12) === "NOT GUILTY", "0–12 → NOT GUILTY");
ok(finalVerdictOf(6, 6) === "HUNG JURY", "6–6 → HUNG JURY (v2.x misread this as NOT GUILTY)");
ok(finalVerdictOf(1, 1) === "HUNG JURY", "1–1 (degraded jury) → HUNG JURY, not a fake acquittal");
ok(finalVerdictOf(5, 6) === "NOT GUILTY", "5–6 → NOT GUILTY (one-vote margin is still a verdict)");

console.log("— ballotContested (the deliberation gate)");
ok(ballotContested(6, 6, 12) === true, "6–6 tie always deliberates");
ok(ballotContested(7, 5, 12) === true, "7–5 argues (margin 2 ≤ 4)");
ok(ballotContested(8, 4, 12) === true, "8–4 argues (margin 4 ≤ 4 — two flips change the verdict)");
ok(ballotContested(9, 3, 12) === false, "9–3 stands (margin 6)");
ok(ballotContested(11, 1, 12) === false, "11–1 stands");
ok(ballotContested(12, 0, 12) === false, "unanimous stands — nothing to argue");
ok(ballotContested(4, 2, 6) === true, "quick jury 4–2 argues (margin 2 ≤ 2)");
ok(ballotContested(5, 1, 6) === false, "quick jury 5–1 stands (margin 4)");
ok(ballotContested(6, 0, 6) === false, "quick jury unanimous stands");
ok(ballotContested(0, 0, 12) === false, "no votes → no deliberation (nothing to argue about)");

console.log("— juryQuorate (a verdict is never read from a handful of votes)");
ok(juryQuorate(6, 12) === true, "6 of 12 — exactly half, quorate");
ok(juryQuorate(12, 12) === true, "12 of 12 — quorate");
ok(juryQuorate(7, 12) === true, "7 of 12 — quorate");
ok(juryQuorate(5, 12) === false, "5 of 12 — below quorum, verdict withheld");
ok(juryQuorate(1, 12) === false, "1 of 12 (the live throttle-wave case) — never read a verdict from one vote");
ok(juryQuorate(0, 12) === false, "0 of 12 — no jury at all");
ok(juryQuorate(3, 6) === true, "3 of 6 (quick jury) — half, quorate");
ok(juryQuorate(2, 6) === false, "2 of 6 (quick jury) — below quorum");
ok(juryQuorate(1, 2) === false, "absolute floor: 1 vote is never quorate, whatever the jury size");

console.log("— parseStrictVote (the spoiled-ballot fix)");
ok(parseStrictVote("GUILTY") === "GUILTY", "plain GUILTY");
ok(parseStrictVote("guilty") === "GUILTY", "case-insensitive");
ok(parseStrictVote(" NOT GUILTY ") === "NOT GUILTY", "whitespace tolerated");
ok(parseStrictVote("NOT_GUILTY") === "NOT GUILTY", "underscore form tolerated");
ok(parseStrictVote("not-guilty") === "NOT GUILTY", "hyphen form tolerated");
ok(parseStrictVote("innocent") === "NOT GUILTY", "synonym: innocent");
ok(parseStrictVote("acquit") === "NOT GUILTY", "synonym: acquit");
ok(parseStrictVote("NOTGUILTY") === "NOT GUILTY", "glued form tolerated");
// THE v2.x BUG: everything unreadable used to become "NOT GUILTY" silently
ok(parseStrictVote(undefined) === null, "undefined → null (was: silent NOT GUILTY)");
ok(parseStrictVote(null) === null, "null → null");
ok(parseStrictVote("") === null, "empty → null");
ok(parseStrictVote("I think maybe guilty?") === null, "prose → null, no guess");
ok(parseStrictVote("GUILTY-ish") === null, "hedge → null, no guess");
ok(parseStrictVote(42) === null, "number → null");
ok(parseStrictVote({ vote: "GUILTY" }) === null, "object (json not extracted) → null");

console.log("— jurorPrompt (first ballot contract)");
const jp = jurorPrompt("X is true", JURORS[0], "record [1]", "pro brief", "def brief", "rebuttals", "English");
const jpText = jp.map((m) => m.content).join(" ");
ok(jpText.includes('"confidence"'), "asks for a confidence level");
ok(jpText.includes("[n]"), "asks the reason to cite [n] evidence");
ok(jpText.includes(JURORS[0].lens), "the persona lens is in the prompt");
ok(jpText.includes('"vote"'), "the JSON vote contract is stated");
ok(!jpText.includes("first ballot"), "the first ballot is blind — no other votes leak");

console.log("— deliberationPrompt (the room)");
const ballot = [
  { name: "The Accountant", vote: "GUILTY" as const, reason: "the numbers do not add up [3]", confidence: 80 },
  { name: "The Teenager", vote: "NOT GUILTY" as const, reason: "nobody cares but it works", confidence: 40 },
  { name: "The Engineer", vote: "GUILTY" as const, reason: "it breaks at scale [7]", confidence: 65 },
];
const dp = deliberationPrompt("X is true", { name: "The Teenager", lens: "bored" }, { vote: "NOT GUILTY", reason: "nobody cares but it works", confidence: 40 }, ballot, "English");
const dpText = dp.map((m) => m.content).join(" ");
ok(dpText.includes("The Accountant (GUILTY, conviction 80): the numbers do not add up [3]"), "every juror's vote + reason + conviction is on the table");
ok(dpText.includes("YOU VOTED: NOT GUILTY"), "the juror's own first vote is restated");
ok(dpText.includes("The room split"), "the split is stated");
ok(dpText.includes("Do NOT change your vote to agree with the majority"), "the anti-herd rule is explicit");
ok(dpText.includes('"changed"'), "the final ballot contract asks for changed true/false");
ok(dpText.includes('"reply"'), "the juror must speak in the room");
ok(dpText.includes("stay in your own lens") || dpText.includes("Stay in your own lens"), "jurors keep their lens");
// the juror must be able to find the opposing arguments
ok(dpText.includes("GUILTY") && dpText.includes("NOT GUILTY"), "both sides of the room are visible");

console.log("— foremanPrompt (the summing-up)");
const finalBallot: JurorBallot[] = [
  { name: "The Accountant", lens: "money", vote: "GUILTY", reason: "numbers [3]", confidence: 85, changedVote: false },
  { name: "The Teenager", lens: "bored", vote: "GUILTY", reason: "ok they convinced me [3]", confidence: 55, changedVote: true, deliberationReply: "Fine, the Accountant is right about [3]" },
  { name: "The Engineer", lens: "builds", vote: "NOT GUILTY", reason: "it holds at small scale [7]", confidence: 70, changedVote: false },
];
const fp = foremanPrompt("X is true", ballot, finalBallot, "English");
const fpText = fp.map((m) => m.content).join(" ");
ok(fpText.includes("THE FIRST BALLOT") && fpText.includes("THE FINAL BALLOT"), "the foreman sees both ballots");
ok(fpText.includes("JURORS WHO CHANGED THEIR VOTE"), "changed votes are flagged");
ok(fpText.includes("Fine, the Accountant is right about [3]"), "the changed juror's deliberation words are in the record");
ok(fpText.includes("Never invent a position a juror did not take"), "the foreman may not fabricate");
ok(fpText.includes('"summary"'), "the JSON contract is a summary");

console.log("— judgePrompt (hung-jury aware)");
const votesFor = (n: number, split: number): { name: string; vote: string; reason: string }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Juror ${i + 1}`, vote: i < split ? "GUILTY" : "NOT GUILTY", reason: "r" }));
const judgeHung = judgePrompt("X is true", "record", "pro", "def", "rebs", votesFor(12, 6), "English", { firstBallot: { guilty: 7, notGuilty: 5 }, foremanSummary: "the room hardened" });
const jhText = judgeHung.map((m) => m.content).join(" ");
ok(jhText.includes("HUNG JURY"), "a tied jury is read as HUNG JURY");
ok(jhText.includes("could not agree"), "the judge's summary must say the jury could not agree");
ok(jhText.includes("break the deadlock"), "hung instructions ask what would break the deadlock");
ok(jhText.includes("first ballot split 7 guilty · 5 not guilty"), "the judge sees the ballot swing");
ok(jhText.includes("the room hardened"), "the judge sees the foreman's summing-up");
const judgeClear = judgePrompt("X is true", "record", "pro", "def", "rebs", votesFor(12, 8), "English", { firstBallot: { guilty: 7, notGuilty: 5 } });
const jcText = judgeClear.map((m) => m.content).join(" ");
ok(!jcText.includes("HUNG JURY"), "a clear verdict is not read as hung");
ok(jcText.includes("Deliver the verdict as the jury voted it"), "the judge still does not overrule juries");
const judgeV2 = judgePrompt("X is true", "record", "pro", "def", "rebs", votesFor(12, 7), "English");
const jv2Text = judgeV2.map((m) => m.content).join(" ");
ok(!jv2Text.includes("THE DELIBERATION"), "no deliberation record → the v2.x-style judge prompt (regression)");

console.log("— the verdict record (UI data contract)");
const verdict: CourtVerdict = {
  charge: "X is true",
  verdict: "HUNG JURY",
  guilty: 6,
  notGuilty: 6,
  jurors: finalBallot,
  firstBallot: { guilty: 7, notGuilty: 5 },
  deliberated: true,
  foremanSummary: "The room hardened around the missing base rate.",
  prosecutionBrief: "pro",
  defenseBrief: "def",
  rebuttals: [],
  chargesStuck: ["no base rate in the record"],
  defenseWins: ["works at small scale [7]"],
  conditions: ["add a base-rate study"],
  judgeSummary: "The jury could not agree.",
  quick: false,
};
ok(verdict.verdict === "HUNG JURY" && verdict.firstBallot?.guilty === 7, "deliberated record carries both ballots");
ok(verdict.jurors.some((j) => j.changedVote && j.deliberationReply), "changed votes carry their deliberation words");
// v2.x record (no deliberation fields) must still satisfy the type + render path
const legacy: CourtVerdict = {
  charge: "X is true",
  verdict: "GUILTY",
  guilty: 6,
  notGuilty: 0,
  jurors: [{ name: "The Accountant", lens: "money", vote: "GUILTY", reason: "numbers" }],
  prosecutionBrief: "pro",
  defenseBrief: "def",
  rebuttals: [],
  chargesStuck: [],
  defenseWins: [],
  conditions: [],
  judgeSummary: "s",
  quick: true,
};
ok(legacy.firstBallot === undefined && legacy.deliberated === undefined, "legacy v2.x records pass through unchanged");
ok(legacy.jurors.every((j) => j.confidence === undefined && j.changedVote === undefined), "legacy jurors have no confidence/changed fields — all optional");

console.log("— JURORS catalog");
ok(JURORS.length === 12, "12 jurors for the full trial");
ok(new Set(JURORS.map((j) => j.name)).size === 12, "every juror persona is unique");
ok(JURORS.every((j) => j.lens.length > 20), "every persona has a real lens");

console.log(fails === 0 ? `\nALL JURY TESTS PASS` : `\n${fails} TEST(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
