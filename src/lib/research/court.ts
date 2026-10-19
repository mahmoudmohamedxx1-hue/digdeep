import type { ChatMsg } from "./llm";
import { msg } from "./prompts";

/** ==================================================================
 *  THE COURT — adversarial evaluation of an idea, plan or claim.
 *  Adapted from alexyc9381/court-skill (MIT): instead of a simple answer,
 *  the proposition goes on trial — a prosecutor builds the strongest honest
 *  case that it fails, a defender the strongest honest case that it holds,
 *  each answers the other, a jury of 12 independent personas votes, and a
 *  judge reads the verdict with conditions. Everything is grounded in the
 *  evidence the research engine actually gathered — briefs must cite [n].
 *
 *  v3.0 THE PERFECT JURY: two ballots around a real deliberation. The first
 *  ballot is blind and independent (the honest spread). Then the jury sees
 *  the split and argues it — each juror answers the strongest OPPOSING
 *  juror's point before casting a final vote they may hold or change, never
 *  for free. A foreman sums up what moved the jury; a tie is a HUNG JURY,
 *  declared honestly instead of misread as acquittal.
 *  ================================================================== */

/** The 12 jurors — personas verbatim from court-skill's jurors.json.
 *  Each reads the same record but through an irreducibly different lens;
 *  the vote spread is the honest signal, not a single model's opinion. */
export const JURORS: { name: string; lens: string }[] = [
  { name: "The Accountant", lens: "You follow the money. You distrust any number that has no source, and you want to know who pays, how much, and when." },
  { name: "The First-Time Customer", lens: "You have never heard of this before today. Would you actually buy it, use it or believe it, this week, at this price, over what you already do?" },
  { name: "The Competitor", lens: "You run the business this case would compete with. If you saw this tomorrow, how would you beat it, copy it or ignore it?" },
  { name: "The Retired Judge", lens: "You care about the burden of proof. Is the evidence actually in the record, or is it hope dressed up as fact?" },
  { name: "The Teenager", lens: "You are blunt and easily bored. Would anyone care about this, talk about it, or come back to it next week?" },
  { name: "The Engineer", lens: "You build things. Can this actually be made, does it work in the real world, and what breaks first when it grows?" },
  { name: "The Small-Business Owner", lens: "You have run a shop for 20 years. Who does the work on Monday morning, where does the cash come from until it pays, and what happens in a slow month?" },
  { name: "The Statistician", lens: "You look for base rates, tiny samples and survivorship bias. How often does a plan like this actually work?" },
  { name: "The Parent", lens: "You protect your family's time, money and safety. Is it trustworthy, and is it worth the risk to the people involved?" },
  { name: "The Investor", lens: "You weigh upside against risk. Would you put your own money into this exactly as described, and why or why not?" },
  { name: "The Designer", lens: "You care about clarity. Would a stranger understand what this is and why it matters in five seconds?" },
  { name: "The Lawyer", lens: "You look for legal, regulatory and liability traps that the case does not mention." },
];

export type JurorVote = "GUILTY" | "NOT GUILTY";

export interface JurorBallot {
  name: string;
  lens: string;
  vote: JurorVote;
  reason: string;
  /** 0–100 — how firmly this juror holds the vote */
  confidence?: number;
  /** true when the final ballot differs from the first */
  changedVote?: boolean;
  /** what this juror said in deliberation (final ballot only) */
  deliberationReply?: string;
}

export interface CourtVerdict {
  charge: string;
  /** v3.0: a tied final ballot is a HUNG JURY — declared, not misread */
  verdict: "GUILTY" | "NOT GUILTY" | "HUNG JURY";
  guilty: number;
  notGuilty: number;
  jurors: JurorBallot[];
  /** the blind, independent first ballot (when the jury deliberated) */
  firstBallot?: { guilty: number; notGuilty: number };
  /** true when a deliberation round ran between the two ballots */
  deliberated?: boolean;
  /** the foreman's read of the deliberation (why the jury split the way it did) */
  foremanSummary?: string;
  prosecutionBrief: string;
  defenseBrief: string;
  rebuttals: { by: "prosecution" | "defense"; text: string }[];
  chargesStuck: string[];
  defenseWins: string[];
  conditions: string[];
  judgeSummary: string;
  quick: boolean;
}

/** The final-verdict arithmetic, one place: a tie is a HUNG JURY. */
export function finalVerdictOf(guilty: number, notGuilty: number): CourtVerdict["verdict"] {
  if (guilty === notGuilty) return "HUNG JURY";
  return guilty > notGuilty ? "GUILTY" : "NOT GUILTY";
}

/** A first ballot is "contested" — worth a deliberation round — when the
 *  margin is close enough that argument could plausibly move the outcome
 *  (a flip of two jurors changes or ties the verdict). Unanimous or
 *  near-unanimous first ballots don't need one; the court says so honestly. */
export function ballotContested(guilty: number, notGuilty: number, jurySize: number): boolean {
  const margin = Math.abs(guilty - notGuilty);
  const voters = guilty + notGuilty;
  if (voters === 0) return false;
  if (margin === 0) return true; // a tie must argue before it hangs
  // small juries (quick trial, 6): deliberate on any split short of unanimous
  if (jurySize <= 6) return margin <= 2;
  // full jury of 12: 8–4 or closer argues; 9–3 and wider stands
  return margin <= 4;
}

/** A first ballot is QUORATE when at least half the impaneled jury returned
 *  a vote (and never fewer than two). Below quorum the trial does not read a
 *  verdict from a handful of votes — the verdict is withheld honestly, and a
 *  resumed slice re-polls the missing jurors (throttle waves pass). */
export function juryQuorate(returned: number, jurySize: number): boolean {
  return returned >= 2 && returned >= Math.ceil(jurySize / 2);
}

/** Strict vote parse — "GUILTY"/"NOT GUILTY" exactly (case/space tolerant),
 *  anything else is a spoiled ballot: never silently read as an acquittal. */
export function parseStrictVote(raw: unknown): JurorVote | null {
  const s = String(raw ?? "").trim().toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (s === "GUILTY") return "GUILTY";
  if (s === "NOT GUILTY" || s === "NOTGUILTY" || s === "INNOCENT" || s === "ACQUIT") return "NOT GUILTY";
  return null;
}

const CTX_CAP = 14_000;

/** C1 — the prosecution: the strongest honest case that the proposition fails. */
export function prosecutionPrompt(charge: string, record: string, language: string): ChatMsg[] {
  return [
    msg(
      "user",
      `You are the PROSECUTOR in a trial. The proposition on trial:

"""
${charge}
"""

You must build the strongest HONEST case that this proposition fails — that the idea will not work, the plan is wrong, or the claim is false. You are not a caricature: no strawmen, no exaggeration, no invented facts. Every attack must be either (a) grounded in the evidence below with [n] citations, or (b) clearly framed as a risk the record fails to address ("the record contains no evidence that…").

THE EVIDENCE RECORD (gathered by a deep-research engine from real web sources):
${record.slice(0, CTX_CAP)}

Rules:
- Open with THE CHARGE(S): the 2–4 most damaging specific charges, each in one sentence.
- Then build each charge with the evidence that supports it, citing [n].
- Attack the weakest links: missing base rates, unverified assumptions, competition, costs, timing, sample sizes, incentives.
- If the record genuinely supports the proposition on some point, do not pretend otherwise — a prosecutor who gets caught exaggerating loses the jury.
- Write in ${language}. Be surgical and calm — the strongest case is built from facts, not adjectives.

Return Markdown: "## The charges" (numbered, one sentence each), then "## The prosecution's case" (the argument, with [n] citations).`
    ),
  ];
}

/** C2 — the defense: the strongest honest case that the proposition holds. */
export function defensePrompt(charge: string, record: string, language: string): ChatMsg[] {
  return [
    msg(
      "user",
      `You are the DEFENSE in a trial. The proposition on trial:

"""
${charge}
"""

You must build the strongest HONEST case that this proposition holds — that the idea can work, the plan is sound, or the claim is true. No hype, no hand-waving, no invented facts. Every argument must be either (a) grounded in the evidence below with [n] citations, or (b) clearly framed as a reasoned judgment ("the record shows X, which supports Y because…").

THE EVIDENCE RECORD (gathered by a deep-research engine from real web sources):
${record.slice(0, CTX_CAP)}

Rules:
- Open with your plea: the 2–4 strongest pillars of the case, each one sentence.
- Then build each pillar with the evidence, citing [n].
- Answer the obvious objections preemptively — a defense that ignores the elephant in the room loses credibility with the jury.
- Where the record is thin, say what a reasonable person may still infer and why — clearly marked as inference, not evidence.
- Write in ${language}. Be measured and precise.

Return Markdown: "## The defense's case" (the argument, with [n] citations).`
    ),
  ];
}

/** C3 — rebuttals: each side answers the other's strongest points. */
export function rebuttalPrompt(
  charge: string,
  side: "prosecution" | "defense",
  ownBrief: string,
  otherBrief: string,
  record: string,
  language: string
): ChatMsg[] {
  const youAre = side === "prosecution" ? "the PROSECUTOR" : "the DEFENDER";
  const yourGoal = side === "prosecution" ? "rebut the defense's strongest points and reassert the charges that survived" : "rebut the prosecution's charges and reassert the pillars that survived";
  return [
    msg(
      "user",
      `You are ${youAre} in a trial. The proposition on trial:

"""
${charge}
"""

YOUR BRIEF:
${ownBrief.slice(0, 7000)}

THE OTHER SIDE'S BRIEF you must now answer:
${otherBrief.slice(0, 7000)}

EVIDENCE RECORD (cite [n] where you rely on it):
${record.slice(0, 8000)}

Your closing rebuttal: ${yourGoal}. Rules:
- Address their STRONGEST points directly, by quoting or naming them — dodging reads as conceding.
- Concede cleanly anything you cannot answer (juries respect honesty; they punish evasion).
- Maximum ~250 words, in ${language}. Plain text, no headings.`
    ),
  ];
}

/** C4a — the FIRST ballot: blind and independent. Each juror sees the record,
 *  both briefs and the rebuttals, and votes through their own lens — with a
 *  confidence level and the evidence that decided them. */
export function jurorPrompt(
  charge: string,
  juror: { name: string; lens: string },
  record: string,
  prosecutionBrief: string,
  defenseBrief: string,
  rebuttals: string,
  language: string
): ChatMsg[] {
  return [
    msg(
      "user",
      `You are ${juror.name}, serving on a jury. Your lens — how you see every case:
${juror.lens}

The proposition on trial:
"""
${charge}
"""

EVIDENCE RECORD:
${record.slice(0, 9000)}

PROSECUTION'S CASE:
${prosecutionBrief.slice(0, 5000)}

DEFENSE'S CASE:
${defenseBrief.slice(0, 5000)}

REBUTTALS:
${rebuttals.slice(0, 3000)}

Through YOUR lens and no one else's, weigh the record and vote. A juror is not asked to be balanced — you are asked to be yourself, honestly, on the evidence. "Guilty" means the proposition fails as stated; "not guilty" means it holds.

Return ONLY a JSON object (no markdown fence):
{"vote": "GUILTY" | "NOT GUILTY", "confidence": 0-100, "reason": "1–2 sentences in ${language}, in your own voice, naming the evidence that decided you (cite [n] when the record decided it)"}
"confidence" is how firmly you hold this vote — not how right you think you are.`
    ),
  ];
}

/** C4b — DELIBERATION: the jury has voted once, blind. Now each juror sees
 *  the split and every other juror's reason, must answer the strongest
 *  OPPOSING point out loud, and cast a final vote — held or changed, never
 *  for free. Anti-herd rule: a juror who agrees with the majority just to
 *  end the argument is not deliberating. */
export function deliberationPrompt(
  charge: string,
  juror: { name: string; lens: string },
  ownBallot: { vote: JurorVote; reason: string; confidence?: number },
  firstBallot: { name: string; vote: JurorVote; reason: string; confidence?: number }[],
  language: string
): ChatMsg[] {
  const others = firstBallot
    .filter((b) => b.name !== juror.name)
    .map((b) => `- ${b.name} (${b.vote}${typeof b.confidence === "number" ? `, conviction ${b.confidence}` : ""}): ${b.reason}`)
    .join("\n");
  const ownSide = firstBallot.filter((b) => b.vote === ownBallot.vote).length;
  const otherSide = firstBallot.length - ownSide;
  return [
    msg(
      "user",
      `You are ${juror.name}, on the jury deliberating this proposition:

"""
${charge}
"""

Your lens — how you see every case:
${juror.lens}

THE FIRST BALLOT (blind and independent, including yours):
${firstBallot.map((b) => `- ${b.name} (${b.vote}${typeof b.confidence === "number" ? `, conviction ${b.confidence}` : ""}): ${b.reason}`).join("\n")}

YOU VOTED: ${ownBallot.vote} — ${ownBallot.reason}
The room split ${ownSide} your way, ${otherSide} the other way.

Your fellow jurors:
${others}

DELIBERATE. Speak to the STRONGEST juror who voted against you — name them, take their best point seriously, and answer it through your lens. Then cast your FINAL vote:
- You may HOLD or CHANGE. If you change, your reply must say exactly what moved you.
- Do NOT change your vote to agree with the majority or to end the argument — a juror who folds under pressure without being persuaded is not deliberating. Equally, do NOT dig in out of pride if an opposing juror genuinely answered your deciding evidence.
- Stay in your own lens. You are ${juror.name} to the end.

Return ONLY a JSON object (no markdown fence), all strings in ${language}:
{"reply": "2–3 sentences you actually say in the room, addressing the strongest opposing juror by name", "vote": "GUILTY" | "NOT GUILTY", "confidence": 0-100, "changed": true | false, "reason": "1–2 sentences: the evidence that decides your FINAL vote (cite [n] when the record decided it)"}
If "changed" is true, the reason must name what moved you. If it is false, the reason is your held ground, sharpened.`
    ),
  ];
}

/** C4c — the FOREMAN: one of the jury, elected to read the deliberation back.
 *  Not a vote — a synthesis: what the majority converged on, what the minority
 *  holds, and what actually moved the jurors who changed. */
export function foremanPrompt(
  charge: string,
  firstBallot: { name: string; vote: JurorVote; reason: string; confidence?: number }[],
  finalBallot: JurorBallot[],
  language: string
): ChatMsg[] {
  const changed = finalBallot.filter((j) => j.changedVote);
  const lines = (ballot: { name: string; vote: JurorVote }[]) =>
    ballot.map((b) => `- ${b.name}: ${b.vote}`).join("\n");
  return [
    msg(
      "user",
      `You are the FOREMAN of this jury — you led the deliberation, you cast no deciding vote of your own, and now you read the room back to the court. The proposition that was on trial:

"""
${charge}
"""

THE FIRST BALLOT (before deliberation):
${lines(firstBallot)}

THE FINAL BALLOT (after deliberation):
${lines(finalBallot)}

${changed.length > 0 ? `JURORS WHO CHANGED THEIR VOTE IN DELIBERATION:\n${changed.map((c) => `- ${c.name}: ${c.deliberationReply ?? c.reason}`).join("\n")}` : "No juror changed their vote in deliberation — the argument hardened positions rather than moving them."}

THE FINAL REASONS ON THE RECORD:
${finalBallot.map((j) => `- ${j.name} (${j.vote}): ${j.reason}`).join("\n")}

Sum up the deliberation for the court, honestly and in plain words:
- what the majority converged on, and on what evidence;
- what the minority still holds, and why it is not mere stubbornness;
- if votes changed, what actually moved them — name the argument, not just the juror.
Never invent a position a juror did not take. Never take sides beyond reporting the room.

Return ONLY a JSON object (no markdown fence), in ${language}:
{"summary": "3–4 sentences: the deliberation read back as the foreman would state it in court"}`
    ),
  ];
}

/** C5 — the judge: reads the verdict, what stuck, what the defense got right,
 *  and the conditions for acquittal (what to change before trying again).
 *  v3.0: sees the deliberation, and a HUNG JURY is read as what it is — no
 *  verdict was reached; the judge says what each side would need next time. */
export function judgePrompt(
  charge: string,
  record: string,
  prosecutionBrief: string,
  defenseBrief: string,
  rebuttals: string,
  votes: { name: string; vote: string; reason: string }[],
  language: string,
  deliberation?: {
    firstBallot: { guilty: number; notGuilty: number };
    foremanSummary?: string;
  }
): ChatMsg[] {
  const guilty = votes.filter((v) => v.vote === "GUILTY").length;
  const notGuilty = votes.filter((v) => v.vote === "NOT GUILTY").length;
  const hung = guilty === notGuilty;
  const deliberationBlock = deliberation
    ? `\nTHE DELIBERATION: the first ballot split ${deliberation.firstBallot.guilty} guilty · ${deliberation.firstBallot.notGuilty} not guilty; after deliberating on each other's reasons the final ballot is ${guilty} · ${notGuilty}.${deliberation.foremanSummary ? `\nThe foreman's summing-up: ${deliberation.foremanSummary}` : ""}\n`
    : "\n";
  return [
    msg(
      "user",
      `You are the JUDGE. The proposition on trial:

"""
${charge}
"""
${deliberationBlock}
THE JURY'S FINAL VOTES (${guilty} guilty · ${notGuilty} not guilty):
${votes.map((v) => `- ${v.name}: ${v.vote} — ${v.reason}`).join("\n")}

PROSECUTION'S CASE:
${prosecutionBrief.slice(0, 5000)}

DEFENSE'S CASE:
${defenseBrief.slice(0, 5000)}

REBUTTALS:
${rebuttals.slice(0, 3000)}

EVIDENCE RECORD:
${record.slice(0, 8000)}

${hung
        ? `The jury is DEADLOCKED — ${guilty} to ${notGuilty}. This is a HUNG JURY: no verdict was reached, and you will say so plainly. Deliver the hung verdict honestly:
- the charges the majority for conviction could not settle,
- the points the minority for acquittal would not give up,
- the CONDITIONS — what evidence, changed or added, would most likely break the deadlock at a re-trial.`
        : `Deliver the verdict as the jury voted it (you do not overrule juries), then read the trial honestly:
- the charges that STUCK (the defense never answered them),
- what the DEFENSE got right (the prosecution failed to break),
- the CONDITIONS — what concretely to change before trying again (empty only if the acquittal was clean).`}

Return ONLY a JSON object (no markdown fence), all strings in ${language}:
{"chargesStuck": ["...", "..."], "defenseWins": ["...", "..."], "conditions": ["...", "..."], "summary": "2–3 sentences: the verdict read plainly, as a judge would state it in court${hung ? " — open by stating the jury could not agree" : ""}"}`
    ),
  ];
}
