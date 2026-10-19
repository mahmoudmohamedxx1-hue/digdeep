/** Inject a completed court-trial record straight into the database, so the
 *  thread page can be E2E-tested against real record shapes without burning
 *  LLM quota. Recreated v3.0.2 (the original was lost uncommitted in a
 *  sandbox reset; see worklog Task 27).
 *
 *  Usage: bun scripts/inject-trial.ts <threadId> [variant]
 *    variant ∈ crasher | hung | partial | legacy   (default: hung)
 *
 *  Prints the job id. The record is a completed court run: mode=research,
 *  court=true, stats.court per variant, honest reportMd, a few events.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const threadId = process.argv[2];
const variant = process.argv[3] ?? "hung";

if (!threadId) {
  console.error("usage: bun scripts/inject-trial.ts <threadId> [crasher|hung|partial|legacy]");
  process.exit(1);
}

const J = (i: number, vote: "GUILTY" | "NOT GUILTY", over: Record<string, unknown> = {}) => ({
  name: `Juror ${i + 1}`,
  lens: ["the historian", "the statistician", "the practitioner", "the skeptic", "the economist", "the engineer"][i % 6] + " lens",
  vote,
  reason: `Voted on the strength of citation [${i + 1}] and the rebuttals around it.`,
  ...over,
});

const twelve = (split: number, over: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: 12 }, (_, i) => J(i, i < split ? "GUILTY" : "NOT GUILTY", over(i)));

const SHAPES: Record<string, Record<string, unknown>> = {
  // THE AUDIT CRASHER — stats.court without chargesStuck/defenseWins/conditions:
  // pre-v3.0.2 this white-screened the whole thread page (undefined.length)
  crasher: {
    charge: "electric cars are better for the environment than gasoline cars",
    verdict: "GUILTY", guilty: 12, notGuilty: 0,
    jurors: twelve(12, (i) => ({ confidence: 65 + ((i * 7) % 30) })),
    judgeSummary: "The evidence before the court supports the charge on lifecycle emissions.",
  },
  // full v3.0 hung jury: 6–6 from a 7–5 first ballot, 3 changed votes, foreman
  hung: {
    charge: "remote work makes software teams more productive than office work",
    verdict: "HUNG JURY", guilty: 6, notGuilty: 6,
    jurors: twelve(7, (i) => ({
      confidence: 52 + ((i * 11) % 40),
      changedVote: i === 2 || i === 5 || i === 9,
      deliberationReply: i === 2 ? "I answered the statistician directly — the flagship study is correlative, not causal." : i === 5 ? "The practitioner's outage story is one team, not a trend." : undefined,
    })),
    firstBallot: { guilty: 7, notGuilty: 5 },
    deliberated: true,
    foremanSummary: "Seven went in convinced; three moved on the rebuttals; the room ended evenly split between the correlational evidence and the counter-studies.",
    judgeSummary: "No verdict was reached on this proposition — the jury deadlocked after two ballots and a full deliberation.",
    chargesStuck: ["Lifecycle productivity studies consistently show a modest remote advantage [1]"],
    defenseWins: ["The strongest counter-studies measure output, not shipped value [4]"],
    conditions: ["A randomized or naturally-experimental study spanning several years would break the deadlock"],
  },
  // juryless partial trial — jury never convened (throttle wave + quorum rule)
  partial: {
    charge: "AI coding tools already make teams more productive than hiring senior engineers",
    verdict: "NOT GUILTY", // v2.x placeholder — the card must render VERDICT WITHHELD
    guilty: 0, notGuilty: 0, jurors: [],
    judgeSummary: null,
  },
  // v2.x legacy record — single blind ballot, no deliberation machinery
  legacy: {
    charge: "static typing prevents more production bugs than dynamic typing",
    verdict: "GUILTY", guilty: 9, notGuilty: 3,
    jurors: twelve(9),
    judgeSummary: "On the evidence presented, the jury found for the prosecution.",
  },
};

const court = SHAPES[variant] ?? SHAPES.hung;
const stats = {
  durationMs: 512000,
  sourcesConsulted: 14,
  llmCalls: 41,
  reportWords: 2410,
  sections: 4,
  citationIntegrity: 100,
  citationsChecked: 23,
  court,
};

const reportMd = `# ${court.charge}\n\n## Executive summary\n\nThe court examined the proposition and delivered its verdict.\n\n## The prosecution's case\n\nEvidence cited from the gathered sources [1] [3].\n\n## The defense\n\nThe defense established reasonable doubt on methodology [4].\n\n## Verdict\n\nSee the verdict card above.\n`;

const now = new Date();
const job = await prisma.researchJob.create({
  data: {
    query: String(court.charge),
    threadId,
    status: "completed",
    stage: "Done",
    progress: 100,
    preset: "standard",
    mode: "research",
    court: true,
    language: "English",
    modelPref: "auto",
    breadth: 3,
    depth: 5,
    maxSources: 18,
    maxMinutes: 30,
    reportMd,
    stats: JSON.stringify(stats),
    startedAt: new Date(now.getTime() - 512000),
    completedAt: now,
    events: {
      create: [
        { seq: 1, type: "info", title: "Court is in session", detail: "The proposition is read: " + String(court.charge) },
        { seq: 2, type: "summary", title: "The prosecution opens", detail: "3 sources in evidence [1] [2] [3]" },
        { seq: 3, type: "summary", title: "The defense responds", detail: "3 counter-sources in evidence [4] [5] [6]" },
        ...(variant === "partial"
          ? [{ seq: 4, type: "info", title: "The jury could barely convene", detail: "the verdict is withheld — no ballot is invented" }]
          : [
              { seq: 4, type: "info", title: "First ballot", detail: "blind votes cast" },
              { seq: 5, type: "done", title: "The judge charges the jury", detail: "verdict delivered" },
            ]),
      ],
    },
  },
});

console.log(`injected [${variant}] job ${job.id} on thread ${threadId}`);
await prisma.$disconnect();
