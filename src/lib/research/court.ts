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

export interface CourtVerdict {
  charge: string;
  verdict: "GUILTY" | "NOT GUILTY";
  guilty: number;
  notGuilty: number;
  jurors: { name: string; lens: string; vote: "GUILTY" | "NOT GUILTY"; reason: string }[];
  prosecutionBrief: string;
  defenseBrief: string;
  rebuttals: { by: "prosecution" | "defense"; text: string }[];
  chargesStuck: string[];
  defenseWins: string[];
  conditions: string[];
  judgeSummary: string;
  quick: boolean;
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

/** C4 — one juror's vote. Independent: sees the record + both briefs + rebuttals. */
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

Through YOUR lens and no one else's, weigh the record and vote. A juror is not asked to be balanced — you are asked to be yourself, honestly, on the evidence.

Return ONLY a JSON object (no markdown fence):
{"vote": "GUILTY" | "NOT GUILTY", "reason": "one sentence in ${language}, in your own voice, saying what decided you"}`
    ),
  ];
}

/** C5 — the judge: reads the verdict, what stuck, what the defense got right,
 *  and the conditions for acquittal (what to change before trying again). */
export function judgePrompt(
  charge: string,
  record: string,
  prosecutionBrief: string,
  defenseBrief: string,
  rebuttals: string,
  votes: { name: string; vote: string; reason: string }[],
  language: string
): ChatMsg[] {
  return [
    msg(
      "user",
      `You are the JUDGE. The proposition on trial:
"""
${charge}
"""

THE JURY'S VOTES (${votes.filter((v) => v.vote === "GUILTY").length} guilty · ${votes.filter((v) => v.vote === "NOT GUILTY").length} not guilty):
${votes.map((v) => `- ${v.name}: ${v.vote} — ${v.reason}`).join("\n")}

PROSECUTION'S CASE:
${prosecutionBrief.slice(0, 5000)}

DEFENSE'S CASE:
${defenseBrief.slice(0, 5000)}

REBUTTALS:
${rebuttals.slice(0, 3000)}

EVIDENCE RECORD:
${record.slice(0, 8000)}

Deliver the verdict as the jury voted it (you do not overrule juries), then read the trial honestly:
- the charges that STUCK (the defense never answered them),
- what the DEFENSE got right (the prosecution failed to break),
- the CONDITIONS — what concretely to change before trying again (empty only if the acquittal was clean).

Return ONLY a JSON object (no markdown fence), all strings in ${language}:
{"chargesStuck": ["...", "..."], "defenseWins": ["...", "..."], "conditions": ["...", "..."], "summary": "2–3 sentences: the verdict read plainly, as a judge would state it in court"}`
    ),
  ];
}
