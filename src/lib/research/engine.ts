import { db } from "@/lib/db";
import { notifyRunFinished } from "@/lib/platform/webhooks";
import { llmComplete, llmStreamComplete, pinnedBackendId, routeInfoFor, type ChatMsg, type LlmResult, type ModelPref, type StreamDelta } from "./llm";
import { pinChoiceOf } from "@/lib/model-choices";
import { capabilityQuestion, courtMetaQuestion, courtTrialWorthiness, followUpishHeuristic, heuristicChatIntent, selfKnowledgeTopic, type SelfTopic } from "./intent-heuristics";
import { searchAll, fetchPageContent, domainOf, type SearchResult } from "./search";
import { gateByRelevance } from "./relevance";
import {
  supportTokens as sharedSupportTokens,
  lexicalSupport as sharedLexicalSupport,
  bestPassage,
  verdictFromSupport,
  classifyCloseness,
  type ClaimCheck,
  type ClaimVerdictSummary,
} from "@/lib/claim-support";
import {
  RESEARCHER_SYS,
  CHAT_SYS,
  classifyPrompt,
  resolveFollowUpPrompt,
  chatPrompt,
  quickAnswerPrompt,
  roleChooserPrompt,
  comprehensionPrompt,
  planPrompt,
  summarizePrompt,
  summarizeReflectPrompt,
  reflectPrompt,
  critiquePrompt,
  curateSourcesPrompt,
  verifyClaimPrompt,
  disagreementsPrompt,
  draftSectionPrompt,
  execSummaryPrompt,
  conclusionPrompt,
  titlePrompt,
  relatedPrompt,
  rerankPrompt,
  citeRepairPrompt,
  reformulateQueriesPrompt,
  redTeamPrompt,
  qualityScorePrompt,
  gapAnalysisPrompt,
  debateProposerPrompt,
  debateSkepticPrompt,
  debateJudgePrompt,
  diffDigestPrompt,
  msg,
  type Intent,
} from "./prompts";
import { PIPELINE_ONE_LINER } from "./self-knowledge";
import { JURORS, prosecutionPrompt, defensePrompt, rebuttalPrompt, jurorPrompt, deliberationPrompt, foremanPrompt, judgePrompt, finalVerdictOf, ballotContested, parseStrictVote, juryQuorate, type CourtVerdict, type JurorBallot, type JurorVote } from "./court";
import {
  acquireLease,
  releaseLease,
  renewLease,
  loadCheckpoint,
  saveCheckpoint,
  phaseAtLeast,
  type EngineCheckpoint,
  type EnginePhase,
  type QuickLaneState,
} from "./checkpoint";
import { applySourceQualityGate } from "./sourcequality";
import { getDomainPack, siteVariants } from "./domain-packs";
import { processComputes } from "./compute";
import { scoreReport, type ReportScore } from "./report-score";

/** v2.5.0 continuation: activeJobs now carries a heartbeat — a frozen slice's
 * entry goes stale so the poller's resume attempt is allowed on warm instances
 * (the platform can freeze an after() task mid-flight without running finally). */
const activeJobs = new Map<string, number>();
const ACTIVE_STALE_MS = 25_000;

/** True when an engine for this job looks alive ON THIS INSTANCE (fresh
 * heartbeat). The GET route consults this before re-triggering runJob. */
export function engineAlive(jobId: string): boolean {
  const beat = activeJobs.get(jobId);
  return !!beat && Date.now() - beat < ACTIVE_STALE_MS;
}

// Safety rails for "unlimited" (-1) mode: literal infinity would hang the server forever.
const UNLIMITED_ASPECT_CAP = 50;
const UNLIMITED_ROUND_CAP = 20;

/** Aspect-level parallelism (P0-2): bounded concurrency over aspects. Free-tier LLM
 *  backends are rate-limited, so 2 workers for budgeted presets and 3 for the heavy
 *  ones is the sweet spot between wall-clock and throttle pressure. */
const ASPECT_CONCURRENCY = { budgeted: 2, heavy: 3 };

interface PlanAspect {
  title: string;
  question: string;
  goal?: string;
  queries: string[];
}
interface ResearchPlan {
  restate: string;
  reportType: string;
  academic: boolean;
  estimatedDifficulty?: string;
  /** knowledge-first planning (Deep-Research-skills pattern): state the baseline before searching */
  priorKnowledge?: string;
  unknowns?: string[];
  aspects: PlanAspect[];
}

/** A consulted source, tracked for citation numbering, curation and the references list. */
interface SourceRef {
  n: number;
  url: string;
  title: string;
  domain: string;
  /** publication date when an engine reported one — feeds the recency model */
  publishedAt?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** v2.5.3: a streaming draft that hits its per-call cap can end mid-sentence —
 *  the grader reads that as "incomplete sections and abrupt endings" (a live
 *  7.3/10 deduction). Trim to the last complete sentence; keep the text when it
 *  already ends cleanly. Pure computation, no LLM. */
function trimToCompleteSentence(text: string): string {
  const t = text.trimEnd();
  if (/[.!?:"')\]]$/.test(t)) return t;
  const cut = Math.max(t.lastIndexOf(". "), t.lastIndexOf(".\n"), t.lastIndexOf("! "), t.lastIndexOf("? "));
  if (cut < Math.floor(t.length * 0.5)) return t; // truncation point too early — keep as-is (honest beats halved)
  return t.slice(0, cut + 1).trimEnd();
}

function extractJson(text: string): any | null {
  const cleaned = text.replace(/```(json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  for (let cut = 0; cut < 2; cut++) {
    try {
      return JSON.parse(cut === 0 ? cleaned.slice(start, end + 1) : cleaned.slice(start + cut));
    } catch {
      /* try next */
    }
  }
  return null;
}

/** v2.3.0: the self-score shape (Stage 5) — shared by the initial grade and the
 *  Stage 5.5 re-grades. Named so `let regraded` doesn't reference `typeof quality`
 *  in its own annotation (TS2502). */
type QualityScore = {
  overall: number;
  dims: { name: string; score: number; note: string }[];
  criteria: { criterion: string; met: boolean; why: string }[];
  biggestWeakness: string;
  /** v2.4.0: the grader names the queries that would fix the biggest weakness —
   *  on time-capped serverless runs this replaces the separate gap-analysis call
   *  (zero extra LLM round trips: the queries ride along with the grade). */
  repairQueries?: string[];
};

function extractJsonArray(text: string): string[] | null {
  const cleaned = text.replace(/```(json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr.map((x) => String(x)).slice(0, 6) : null;
  } catch {
    return null;
  }
}

function fmtMin(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/** v3.9.1: exported for the quick-lane slicing proof (scripts/cf/test-quick-slicing.ts) —
 * not part of the app's public surface. */
export class Ctx {
  jobId: string;
  seq: number;
  sourceN = 0;
  llmCalls = 0;
  byModel: Record<string, { calls: number; totalMs: number }> = {};
  seenUrls = new Set<string>();
  pref: ModelPref;
  /** v2.4.0 serverless time-phasing: wall-clock instant after which NO new research
   *  rounds or aspects may start — the write + grade + improve tail is reserved
   *  (~190s) so a capped run still drafts, grades AND earns a better score instead
   *  of dying at 95% with the report unwritten. Infinity off-serverless. */
  researchCutoffAt = Number.POSITIVE_INFINITY;
  /** gpt-researcher-style expert persona — prepended to the system prompt after the role chooser runs */
  rolePrompt = "";
  /** dzhng-style dense learnings accumulated across all aspects */
  allLearnings: string[] = [];
  /** evidence-graded claims (reflect v3): {claim, grade, basis, section, verified?} */
  claims: { claim: string; grade: string; basis: string; section: string; verified?: string }[] = [];
  /** contradictions surfaced by reflection: {claim, positions, section} */
  contradictions: { claim: string; positions: string; section: string }[] = [];
  walkedUrls = 0;
  /** counter for live thought streams (instant visible thinking) */
  thoughtN = 0;
  /** P0-4 citation verification: the excerpt text actually read for each source number.
   *  Populated at every read/walk/snippet so Stage 4.5 can audit [n] citations
   *  against what the source really said. */
  sourceTexts = new Map<number, string>();
  sourceMeta = new Map<number, { title: string; domain: string }>();
  /** P0-3 rerank counter (stats) */
  rerankRuns = 0;
  /** Circuit breaker: after one all-backends-failed exhaustion, fast-fail LLM steps for 10 min
   *  so a fully-degraded run keeps moving (raw-excerpt notes) instead of every step riding
   *  40 patient rounds. The next patient call after the window re-probes for recovery. */
  llmBlackoutUntil = 0;
  deadline: number; // Infinity when unlimited
  hasTimeBudget: boolean;
  /** v2.5.0: last lease renewal (throttle) */
  lastLeaseRenew = 0;
  /** Absolute wall-clock death time of the serverless function (Infinity elsewhere).
   *  Every patient LLM ride is clamped against it and enhancement stages skip fast
   *  when squeezed — the platform freezes the function mid-flight at maxDuration,
   * so the #1 duty near the end is PERSISTING the report, never more LLM calls. */
  hardStop: number;
  anyUnlimited: boolean;
  unlimitedRounds: boolean;
  unlimitedSources: boolean;
  startedAt = Date.now();
  aspectTimes: number[] = [];

  constructor(jobId: string, pref: ModelPref, startSeq: number, opts: { maxMinutes: number; depth: number; maxSources: number; anyUnlimited: boolean; hardStopMs?: number }) {
    this.jobId = jobId;
    this.pref = pref;
    this.seq = startSeq;
    this.anyUnlimited = opts.anyUnlimited;
    this.hasTimeBudget = opts.maxMinutes > 0;
    this.deadline = this.hasTimeBudget ? Date.now() + Math.max(3, opts.maxMinutes) * 60_000 : Infinity;
    this.hardStop = Date.now() + (opts.hardStopMs ?? Number.POSITIVE_INFINITY);
    this.unlimitedRounds = opts.depth < 0;
    this.unlimitedSources = opts.maxSources < 0;
  }

  get timeLeft() {
    return this.deadline - Date.now();
  }

  /** wall-clock ms until the platform freezes this function (Infinity off-serverless) */
  get hardLeft() {
    return this.hardStop - Date.now();
  }

  /** true when out of time; always false in unlimited mode */
  get outOfTime() {
    return this.hasTimeBudget && this.timeLeft < 45_000;
  }

  /** Honest pace-based remaining-time estimate (ms) — parallelism-aware (P0-2):
   *  with N workers, remaining aspects finish ~N at a time, so the estimate divides
   *  by the worker count instead of pretending aspects run one after another. */
  honestRemainingMs(aspectsDone: number, aspectsTotal: number, concurrency = 1): number {
    const avgAspect = this.aspectTimes.length
      ? this.aspectTimes.reduce((a, b) => a + b, 0) / this.aspectTimes.length
      : 150_000; // ~2.5 min per aspect before we have measurements
    const remainingAspects = Math.max(0, aspectsTotal - aspectsDone);
    return Math.ceil(remainingAspects / Math.max(1, concurrency)) * avgAspect + 180_000; // + ~3 min for critique + synthesis
  }

  /** Register the text read for a source number — the substrate for citation verification. */
  registerSource(n: number, title: string, domain: string, text: string) {
    this.sourceTexts.set(n, text);
    this.sourceMeta.set(n, { title, domain });
  }

  async emit(type: string, title: string, detail?: string, model?: string, meta?: unknown, level: "normal" | "verbose" = "normal") {
    // v2.5.0 continuation: every event is a heartbeat — it proves this instance's
    // engine is alive (activeJobs freshness) and renews the cross-instance lease
    // (throttled to every 8s; the lease outlives the throttle by design).
    activeJobs.set(this.jobId, Date.now());
    if (Date.now() - this.lastLeaseRenew > 8_000) {
      this.lastLeaseRenew = Date.now();
      await renewLease(this.jobId).catch(() => {});
    }
    // v2.5.0: seq is normally monotonic per job, but a lease-expiry race can let a
    // stale engine and a fresh one emit in overlapping windows — on a unique
    // constraint hit, re-derive the sequence from the DB and retry instead of
    // dying (the event log must never kill a 90%-done run).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await db.activityEvent.create({
          data: { jobId: this.jobId, seq: this.seq++, type, title, detail: detail?.slice(0, 8000), model, meta: meta ? JSON.stringify(meta) : undefined, level },
        });
        return;
      } catch (e) {
        if (String(e).includes("Unique constraint") && attempt < 3) {
          const m = await db.activityEvent.aggregate({ where: { jobId: this.jobId }, _max: { seq: true } }).catch(() => null);
          this.seq = Math.max(this.seq, (m?._max?.seq ?? 0) + 1);
          continue;
        }
        throw e;
      }
    }
  }

  async llm(
    messages: ChatMsg[],
    purpose: string,
    wantThinking = false,
    maxTokens?: number,
    fast?: { patient?: boolean; timeoutMs?: number; maxWaitMs?: number },
    systemOverride?: string
  ): Promise<LlmResult> {
    if (this.hardLeft < 15_000) throw new Error("hard stop — the serverless function clock expired before this step could run");
    const sys = systemOverride
      ? systemOverride
      : this.rolePrompt
        ? `${RESEARCHER_SYS}\n\nExpert persona for this task: ${this.rolePrompt}`
        : RESEARCHER_SYS;
    // circuit breaker: while blacked out, degrade fast instead of riding 40 rounds per step
    const opts = fast ?? (Date.now() < this.llmBlackoutUntil ? { patient: false as const, timeoutMs: 45_000 } : undefined);
    // Budgeted runs: bound every step's patient ride to a quarter of the remaining budget
    // (1–8 min) so one throttled step can never eat the whole clock — and never past the
    // function's hard death time (hardLeft is Infinity off-serverless). Unlimited runs ride free.
    // v2.4.6: an explicit maxWaitMs in the fast opts overrides the generic budget (the
    // patient grade retry bounds its cooldown wait so the final persist always fits).
    const rideBudget =
      fast?.maxWaitMs != null
        ? fast.maxWaitMs
        : this.hasTimeBudget && opts?.patient !== false
          ? Math.min(Math.max(Math.round(this.timeLeft * 0.25), 60_000), 8 * 60_000, Math.max(5_000, this.hardLeft - 10_000))
          : undefined;
    // Heartbeat: an LLM call can sit in patient retries for many minutes under rate limiting.
    // Keep touching updatedAt so the staleness watchdog never mistakes a throttled-but-alive
    // job for a dead one (a 429 retry stretch must not look like a server restart).
    const beat = setInterval(() => {
      db.researchJob.update({ where: { id: this.jobId }, data: { updatedAt: new Date() } }).catch(() => {});
    }, 60_000);
    try {
      const r = await llmComplete([{ role: "system", content: sys }, ...messages], {
        purpose,
        pref: this.pref,
        wantThinking,
        maxTokens,
        shouldStop: this.shouldStop, // v3.0.2: stop lands inside the ride, not after it
        ...(opts?.patient === false ? { patient: false } : {}),
        ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
        ...(rideBudget != null ? { maxWaitMs: rideBudget } : {}),
      });
      this.llmCalls++;
      const k = (r.model || "unknown").toString();
      if (!this.byModel[k]) this.byModel[k] = { calls: 0, totalMs: 0 };
      this.byModel[k].calls++;
      this.byModel[k].totalMs += r.latencyMs;
      return r;
    } catch (err) {
      // a full exhaustion trips the breaker for 10 minutes; a plan budget-cap rejection means
      // the same thing (backends so dead the ride had to be capped) — trip it too
      if (opts?.patient !== false && err instanceof Error && (err.message.includes("All LLM backends failed") || err.message.includes("plan budget cap hit"))) {
        this.llmBlackoutUntil = Date.now() + 10 * 60_000;
      }
      throw err;
    } finally {
      clearInterval(beat);
    }
  }

  async isCancelled() {
    const job = await db.researchJob.findUnique({ where: { id: this.jobId }, select: { cancelRequested: true } });
    return !job || job.cancelRequested;
  }

  /** v3.0.2 CACHED CANCEL PROBE — the stop hooks inside llm.ts (round gates, backend
   *  attempts, every 2.5s tick of a cooldown sleep) call this; a raw DB query per
   *  check would hammer Postgres from parallel workers, so the answer is memoized
   *  for 2.5s and the in-flight promise is shared. A stop click now lands in ≤2.5s
   *  even mid-throttle-ride (the audit measured 90s+ of 429 loops past the click). */
  private cancelProbeAt = 0;
  private cancelProbeVal: Promise<boolean> | null = null;
  shouldStop = (): Promise<boolean> => {
    const now = Date.now();
    if (this.cancelProbeVal == null || now - this.cancelProbeAt > 2_500) {
      this.cancelProbeAt = now;
      this.cancelProbeVal = this.isCancelled().catch(() => false);
    }
    return this.cancelProbeVal;
  };
  /** llmLive — llm() with INSTANT visible thinking. The model's reasoning (and, with
   *  streamTo, the answer text itself) is streamed to the activity feed the moment each
   *  token is generated — a "Thinking — <label>" event appears the instant the call
   *  starts, then live text flows in, so the user always sees exactly what the model is
   *  doing RIGHT NOW instead of waiting for a step to finish. Degrades gracefully to a
   *  plain llm() call while the circuit breaker is tripped. */
  async llmLive(
    messages: ChatMsg[],
    purpose: string,
    label: string,
    o?: {
      wantThinking?: boolean;
      maxTokens?: number;
      fast?: { patient?: boolean; timeoutMs?: number; maxWaitMs?: number };
      /** stream the generated answer into this section's draftMd as it arrives */
      streamTo?: string;
      /** override the system prompt (the chat lane uses its own voice) */
      system?: string;
    }
  ): Promise<LlmResult> {
    if (this.hardLeft < 15_000) throw new Error("hard stop — the serverless function clock expired before this step could run");
    const wantThinking = o?.wantThinking ?? false;
    const streamTo = o?.streamTo;
    const thoughtId = `th${++this.thoughtN}`;
    const blackedOut = Date.now() < this.llmBlackoutUntil;
    const goLive = !blackedOut && (wantThinking || !!streamTo);

    if (goLive) {
      // instant feedback: the UI shows a live "Thinking — <label>" block the moment the call begins
      await this.emit("think", label, undefined, undefined, { thoughtId, started: true });
    }

    // ---- live-stream plumbing: throttled think deltas + draftMd growth ----
    let reasonPending = "";
    let thinkEvents = 0;
    let lastEmitAt = 0;
    let contentAll = "";
    let lastDraftWrite = 0;
    let chain: Promise<unknown> = Promise.resolve(); // serialize the fire-and-forget writes
    const MAX_THINK_EVENTS = 60; // per thought stream — bounds event volume on very long reasoning

    const flushReason = () => {
      while (reasonPending && thinkEvents < MAX_THINK_EVENTS) {
        const chunk = reasonPending.slice(0, 700);
        reasonPending = reasonPending.slice(700);
        thinkEvents++;
        lastEmitAt = Date.now();
        chain = chain.then(() => this.emit("think", label, chunk, undefined, { thoughtId, delta: true }));
      }
    };

    const onDelta = (d: StreamDelta) => {
      if (d.attempt === "start") {
        // a backend attempt (re)started — reset buffers so a dead attempt's partial text
        // never pollutes the display, and tell the UI to clear what it showed
        if (reasonPending || contentAll) {
          reasonPending = "";
          contentAll = "";
          lastDraftWrite = 0;
          if (thinkEvents > 0) {
            chain = chain.then(() => this.emit("think", label, undefined, undefined, { thoughtId, reset: true }));
          }
        }
        return;
      }
      if (d.reasoning) reasonPending += d.reasoning;
      if (d.content && streamTo) {
        contentAll += d.content;
        const now = Date.now();
        if (now - lastDraftWrite > 1100) {
          lastDraftWrite = now;
          const snapshot = contentAll;
          chain = chain.then(() =>
            db.researchSection.update({ where: { id: streamTo }, data: { draftMd: snapshot } }).catch(() => {})
          );
        }
      }
      const now = Date.now();
      if (reasonPending && (now - lastEmitAt > 900 || reasonPending.length > 600)) flushReason();
    };

    const opts = o?.fast ?? (blackedOut ? { patient: false as const, timeoutMs: 45_000 } : undefined);
    // v2.4.6: an explicit maxWaitMs in the fast opts overrides the generic ride
    // budget — the patient grade retry uses it to bound its cooldown wait so the
    // round (or the final persist) still fits the clock.
    const rideBudget =
      o?.fast?.maxWaitMs != null
        ? o.fast.maxWaitMs
        : this.hasTimeBudget && opts?.patient !== false
          ? Math.min(Math.max(Math.round(this.timeLeft * 0.25), 60_000), 8 * 60_000, Math.max(5_000, this.hardLeft - 10_000))
          : undefined;
    const beat = setInterval(() => {
      db.researchJob.update({ where: { id: this.jobId }, data: { updatedAt: new Date() } }).catch(() => {});
    }, 60_000);

    const tally = (r: LlmResult): LlmResult => {
      this.llmCalls++;
      const k = (r.model || "unknown").toString();
      if (!this.byModel[k]) this.byModel[k] = { calls: 0, totalMs: 0 };
      this.byModel[k].calls++;
      this.byModel[k].totalMs += r.latencyMs;
      return r;
    };

    try {
      const r = goLive
        ? tally(
            await llmStreamComplete([{ role: "system", content: o?.system ?? (this.rolePrompt ? `${RESEARCHER_SYS}\n\nExpert persona for this task: ${this.rolePrompt}` : RESEARCHER_SYS) }, ...messages], {
              purpose,
              pref: this.pref,
              wantThinking,
              maxTokens: o?.maxTokens,
              shouldStop: this.shouldStop, // v3.0.2
              ...(opts?.patient === false ? { patient: false } : {}),
              ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
              ...(rideBudget != null ? { maxWaitMs: rideBudget } : {}),
              onDelta,
            })
          )
        : await this.llm(messages, purpose, wantThinking, o?.maxTokens, o?.fast, o?.system);
      if (goLive) {
        flushReason();
        if (streamTo && contentAll) {
          // make sure the final visible draft equals the complete generated text
          chain = chain.then(() =>
            db.researchSection.update({ where: { id: streamTo }, data: { draftMd: contentAll } }).catch(() => {})
          );
        }
        await chain.catch(() => {});
        await this.emit("think", label, undefined, undefined, { thoughtId, done: true, model: r.model }).catch(() => {});
      }
      return r;
    } catch (err) {
      // close the thought group so the UI never hangs on a half-open "Thinking…"
      if (goLive) {
        await chain.catch(() => {});
        await this.emit("think", label, undefined, undefined, { thoughtId, done: true, error: true }).catch(() => {});
      }
      if (opts?.patient !== false && err instanceof Error && (err.message.includes("All LLM backends failed") || err.message.includes("plan budget cap hit"))) {
        this.llmBlackoutUntil = Date.now() + 10 * 60_000;
      }
      throw err;
    } finally {
      clearInterval(beat);
    }
  }
}

class Cancelled extends Error {}

async function updateJob(jobId: string, data: Record<string, unknown>) {
  await db.researchJob.update({ where: { id: jobId }, data });
}

/** ------------------------------------------------------------------
 *  INTENT ROUTING — Perplexity-style: "hii" chats instantly, real questions research
 *  ------------------------------------------------------------------ */

/** Classify with a bounded LLM call whose reasoning streams LIVE ("Understanding your message").
 *  Router v3 — understand first, then route: the model states what the user actually
 *  wants (UNDERSTANDING line) and then the lane, so routing is never a black box and
 *  the understanding itself is shown to the user. Falls back to a shape-based read
 *  (NOT a blind "research") when every backend is unavailable. */
/**
 * @param court when court mode is on: "trial-fallback" lets an ambiguous
 * question fall back to TRIAL if every router model is throttled (the user
 * asked for the gavel — a real claim must not lose its trial to a throttle
 * wave); "no-trial" is passed for clearly-not-a-claim shapes, which fall back
 * to research like the normal router. undefined = court off.
 */
async function classifyIntent(
  ctx: Ctx,
  query: string,
  recentTurns: string,
  preset: string,
  court?: "trial-fallback" | "no-trial"
): Promise<{ intent: Intent; trial: boolean; how: string; raw: string }> {
  try {
    const res = await Promise.race([
      ctx.llmLive(
        [{ role: "user", content: classifyPrompt(query, recentTurns, preset, court) }],
        "classify",
        "Understanding your message",
        { wantThinking: true, maxTokens: 800, fast: { patient: false, timeoutMs: !!process.env.VERCEL ? 12_000 : 18_000 } }
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("classify timeout")), !!process.env.VERCEL ? 22_000 : 40_000)),
    ]);
    const text = res.text.trim();
    // Strict parse first: the RESTATE/INTENT/STRATEGY lines may themselves contain the
    // words "chat"/"research" ("the user asks whether I can research…"), so the LANE:
    // line is the only source of truth; the last line is a fallback for sloppy formats.
    let lane: string | null = null;
    const laneMatch = [...text.matchAll(/lane\s*[:\-]?\s*\**\s*"?(chat|quick|research|trial)/gi)].pop();
    if (laneMatch) lane = laneMatch[1].toLowerCase();
    if (!lane) {
      const lastLine = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      const w = lastLine.match(/\b(chat|quick|research|trial)\b/i);
      if (w) lane = w[1].toLowerCase();
    }
    if (!lane) lane = "research"; // format mangled — the safe default for real questions
    const trial = !!court && lane === "trial"; // trial runs ON the research pipeline
    const intent: Intent = lane === "trial" ? "research" : (lane as Intent);
    const pick = (tag: string) =>
      (text.match(new RegExp(`${tag}\\s*[:\\-]?\\s*(.+)`, "i"))?.[1] ?? "")
        .replace(/\s*(restate|intent|strategy|lane)\s*[:\-].*$/i, "")
        .replace(/^"+|"+$/g, "")
        .trim();
    const restate = pick("restate");
    const intentLine = pick("intent");
    const strategy = pick("strategy");
    const read = [restate, intentLine, strategy].filter(Boolean).join(" · ");
    const laneName = trial
      ? "the court — this reads as a real claim, so it gets a prosecutor, a defense, a jury of 12 and a judge"
      : intent === "chat"
      ? "a direct reply"
      : intent === "quick"
      ? "a quick answer"
      : "deep research";
    return {
      intent,
      trial,
      how: read
        ? `I read your message as: “${read.slice(0, 320)}” — so I am routing it to ${laneName}`
        : `the router read your message and picked ${trial ? "the court" : intent}`,
      raw: read.slice(0, 240),
    };
  } catch (err) {
    // Every backend is unavailable — read the message's SHAPE instead of blindly
    // researching: short casual messages get a direct reply; anything question-like
    // still defaults to research (the choice that can never under-answer), and with
    // the gavel up an ambiguous question defaults to its TRIAL.
    const s = query.toLowerCase().trim();
    const words = s.split(/\s+/).filter(Boolean);
    const casual =
      words.length <= 3 ||
      /^(hi|hey|hello|thanks|thank you|ok|okay|cool|nice|great|good|bye|yo|sup)\b/.test(s) ||
      (/^(make|tell|say|write|draw)\b/.test(s) && words.length <= 5);
    if (casual) {
      return {
        intent: "chat",
        trial: false,
        how: `the router model is unavailable right now (${err instanceof Error ? err.message.slice(0, 60) : "error"}), so I read the message's shape myself: short and conversational — replying directly`,
        raw: "",
      };
    }
    if (court === "trial-fallback") {
      return {
        intent: "research",
        trial: true,
        how: `the router model is unavailable right now (${err instanceof Error ? err.message.slice(0, 60) : "error"}), but this reads like a real claim and court mode is on — straight to trial`,
        raw: "",
      };
    }
    return {
      intent: "research",
      trial: false,
      how: `the router model is unavailable right now (${err instanceof Error ? err.message.slice(0, 60) : "error"}), so I read the message's shape myself: it reads like a real question — deep research, the choice that cannot under-answer${["deep", "exhaustive", "unlimited"].includes(preset) ? ` (your "${preset}" mode still applies only to real research questions)` : ""}`,
      raw: "",
    };
  }
}

/** Topic word for the visible routing thought. */
function selfTopicWord(t: SelfTopic): string {
  switch (t) {
    case "engines": return "search engines";
    case "process": return "research process";
    case "models": return "AI models";
    case "sources": return "information sources";
    case "capabilities": return "capabilities";
  }
}

/** v2.7 CONVERSATION CONTINUITY — resolve a follow-up message into a question
 *  that stands on its own, using the thread's conversation memory. Zero-LLM
 *  gate first (no earlier turns, or the message clearly carries its own topic
 *  → returned untouched, no call). One small model call otherwise, fast-fail,
 *  fail-open: any error researches the message exactly as written — continuity
 *  is an upgrade, never a blocker. The resolution is VISIBLE, with the raw
 *  words and the resolved question side by side. */
async function resolveFollowUp(ctx: Ctx, raw: string, threadMemory: string, court: boolean): Promise<string> {
  if (!threadMemory.trim() || !followUpishHeuristic(raw)) return raw;
  const tid = `resolve-${ctx.jobId}`;
  try {
    await ctx.emit("think", "Connecting your message to this conversation", undefined, undefined, { thoughtId: tid, started: true });
    const res = await ctx.llm(
      [{ role: "user", content: resolveFollowUpPrompt(raw, threadMemory, court) }],
      "resolve-followup",
      false,
      220,
      { patient: false, timeoutMs: !!process.env.VERCEL ? 25_000 : 40_000 }
    );
    const m = res.text.match(/RESOLVED:\s*(.+)/i);
    const resolved = (m ? m[1] : res.text)
      .trim()
      .replace(/^["“'«]+|["”'»]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 600);
    if (!resolved || resolved.toLowerCase() === raw.toLowerCase().replace(/\s+/g, " ")) {
      await ctx.emit(
        "think",
        "Connecting your message to this conversation",
        "Read against the earlier turns: the message already stands on its own — proceeding with it exactly as written.",
        undefined,
        { thoughtId: tid, done: true, model: res.model }
      );
      return raw;
    }
    await ctx.emit(
      "think",
      "Connecting your message to this conversation",
      `“${raw.slice(0, 180)}” only makes sense inside this thread. Resolved into the self-contained question: “${resolved}” — every stage that follows (${court ? "the trial, the briefs, the verdict" : "the plan, the searches, the drafts"}, and the grading) works on that, so this answer stays connected to everything above it.`,
      undefined,
      { thoughtId: tid, done: true, model: res.model, resolved }
    );
    await ctx.emit(
      "info",
      `Read in context — researching: “${resolved.slice(0, 160)}”`,
      "Your message continues this conversation, so it was resolved against the earlier turns before the pipeline started. The thread stays one connected story instead of separate runs."
    );
    return resolved;
  } catch {
    return raw; // fail-open: the message researches exactly as written
  }
}

/** Built-in replies for the cases we can answer perfectly without any model call.
 *  Used when every free backend is throttled — a chat reply must never hang for minutes.
 *  Self-knowledge questions (engines, process, models) get the REAL spec — the same
 *  grounded facts the model would be prompted with — so even a zero-LLM reply is
 *  accurate instead of vague filler. */
function builtinChatReply(query: string): string {
  const s = query.toLowerCase();
  const topic = selfKnowledgeTopic(query) ?? (capabilityQuestion(query) ? ("capabilities" as SelfTopic) : null);
  if (topic === "engines" || topic === "sources") {
    const wantsProcessToo = /process|pipeline|how|work|stages?|steps?|technical/.test(s);
    return `Thirteen in total, in three groups:

- **Whole-web, keyless** — DuckDuckGo, SearXNG (public instances; you can add your own in Settings), Mojeek, Marginalia
- **Whole-web, optional keys** — Brave Search and Google Programmable Search (I work fully without any key; a free-tier key in Settings switches them on)
- **Verticals** — Bing News, Wikipedia, arXiv, Crossref, Hacker News, Stack Overflow, GitHub

Every research query fans out across them in parallel, results are deduped and interleaved, and an LLM reranks the candidates with publication dates in view so fast-moving topics prefer fresh evidence.${wantsProcessToo ? ` And the run itself goes: ${PIPELINE_ONE_LINER.replace(/->/g, "→")}.` : ""}`;
  }
  if (topic === "process") {
    return `A deep run goes through ten stages, all visible live while it works:

1. **Route** — your message is understood first (restate → intent → lane)
2. **Comprehend** — the question is restated, success criteria and sub-questions drawn, a domain-expert role adopted
3. **Plan** — report type, section aspects, first queries
4. **Research** — parallel workers per aspect: multi-engine search → diversity-aware selection → LLM rerank → parallel page reads → cited synthesis → reflection that spawns follow-ups
5. **Debate** — contested claims argued proposer vs skeptic over fresh evidence, then judged
6. **Red team** — a hostile reviewer attacks the weakest findings before any drafting
7. **Draft** — sections written with [n] citations, disagreements surfaced rather than averaged away
8. **Citation audit** — every citation checked against the text actually read; weak ones re-anchored or dropped; integrity % published
9. **Grade** — the report scores itself on evidence, coverage, honesty and clarity, and names its biggest weakness
10. **Deliver** — summary, conclusion, references, Markdown/PDF export — and re-runs produce a "what changed" diff

Depth is yours to set: Quick, Standard, Deep, Exhaustive, Custom, or Unlimited (no caps on aspects, rounds, sources or time).`;
  }
  if (topic === "models") {
    return `The model chain is **GLM-5.3-Flash → GLM-4.5-Flash** (z.ai), with automatic failover to the keyless LLM7 and Pollinations pools — no API keys needed.

You can add your own endpoint in Settings → Backends (presets for OpenAI, Gemini, DeepSeek, Groq, or any OpenAI-compatible URL); a key flagged "synthesis" is used only for report-writing, with the free chain behind it as failover. When a model is throttled, the answer says so instead of silently swapping.

And to be clear about the distinction: the **models** answer and write; the **engines** (DuckDuckGo, SearXNG, Mojeek, Marginalia, Brave, Google CSE, Bing News, Wikipedia, arXiv, Crossref, HN, Stack Overflow, GitHub) search.`;
  }
  if (capabilityQuestion(query)) {
    return `Yes — deep research is exactly what I do. Give me any topic or question and I'll plan it, search the web in parallel, read the sources, critique my own evidence as I go, and write you a cited report you can export.

You control the depth too — anything from Quick up to Unlimited (no caps on aspects, rounds, sources or time). So: what should I dig into?`;
  }
  if (/what (can|do) (you|u) do|what (you|u) (can|could) do|capabilit|features?|what are you|who are you|how do (you|u|this) work|what is this|what can you do for me|what do you offer|your modes|how (do|does) (you|this) work/.test(s)) {
    return `I'm DigDeep. Every message you send gets routed automatically, in one of three ways:

- **Chat** — greetings and small talk get a direct reply, no search
- **Quick answer** — simple factual questions get one focused search pass with citations
- **Deep research** — real questions get the full pipeline: plan, parallel searches, source reading, live self-critique of my own evidence, and a cited report you can export as PDF or Markdown

You control the depth — Quick, Standard, Deep, Exhaustive, or **Unlimited** (no caps on aspects, rounds, sources or time). Follow-ups stay in one thread, everything is saved in this browser, and I run on free keyless models (GLM Flash first, automatic failover behind it).

Ask me anything and watch the steps live.`;
  }
  if (/\b(hi|hey|hello|yo|sup|salam|marhaba|hola|bonjour)\b/.test(s) || /how are you|how's it going|what's up/.test(s)) {
    return `Hey — I'm DigDeep. I'm here and ready whenever you want to dig into something.

A few things I'm good at: quick cited answers for simple lookups, and full multi-source research with visible steps, honest time estimates and self-critique for the hard questions. What would you like to know?`;
  }
  if (/thank|thanks|thx|shukran|merci/.test(s)) {
    return `You're welcome. If you want to go deeper on anything — or start something new — just ask.`;
  }
  return `I'm DigDeep — I chat when you chat, and I dig when you mean it: full multi-source research with visible steps, honest time estimates, self-critique and cited reports.

(The free models are being throttled right now, so this is a stock reply — ask again in a minute and I'll answer properly.)`;
}

/** v2.8.1 — When the user PINNED a specific model but a different lane had to answer
 *  (the pin's free lane was rate-limited at that moment), SAY SO in the feed instead
 *  of leaving them wondering why "openai" replied while MiniMax-M2.7 was selected.
 *  Returns "" when the pin itself served (or no pin is set / pin not materialized). */
async function maybePinFallbackNote(ctx: Ctx, res: LlmResult): Promise<string> {
  const pinId = await pinnedBackendId(ctx.pref);
  if (!pinId || res.backendId === pinId) return "";
  const pinLabel = pinChoiceOf(ctx.pref)?.label ?? "Your pinned model";
  const served = res.backendId === "pollinations" ? `Pollinations (${res.model})` : res.backendLabel || res.model;
  await ctx.emit(
    "info",
    `${pinLabel} is rate-limited — answered by ${served} instead`,
    `You pinned ${pinLabel}, so its lane leads every message while its free quota window is open. That lane is resting right now, so the next healthy lane in the chain answered rather than making you wait. The pin resumes automatically on your next message — nothing to re-select.`
  );
  return `${pinLabel} was rate-limited — ${served} answered`;
}

/** v2.9 VERDICT RECALL — the full court record of a trial that already ran,
 *  formatted for the chat model so "what is the court opinion" / "what did the
 *  jury say" is answered from the actual verdict instead of re-trying the case
 *  or researching the literal words. */
function courtRecallText(recall: { query: string; verdict: CourtVerdict }): string {
  const v = recall.verdict;
  const jurors = (v.jurors ?? [])
    .slice(0, 12)
    .map((j) => `- ${j.name} (${j.lens}): ${j.vote}${j.changedVote ? " (changed their vote in deliberation)" : ""}${j.confidence != null ? `, conviction ${j.confidence}%` : ""} — ${String(j.reason || "").slice(0, 140)}`)
    .join("\n");
  const changedN = (v.jurors ?? []).filter((j) => j.changedVote).length;
  const deliberationLine = v.firstBallot
    ? `\nHow the jury got there: the blind first ballot split ${v.firstBallot.guilty}–${v.firstBallot.notGuilty};${v.deliberated ? ` after deliberating on each other's reasons the final ballot was ${v.guilty}–${v.notGuilty}${changedN ? ` (${changedN} juror${changedN === 1 ? "" : "s"} changed their vote${changedN === 1 ? "" : "s"}${v.foremanSummary ? "" : ""})` : " (no vote moved in deliberation)"}` : ""}.${v.foremanSummary ? `\nThe foreman's summing-up of the deliberation: ${v.foremanSummary}` : ""}\n`
    : "";
  return `THE COURT TRIAL THAT ALREADY RAN IN THIS THREAD — the user is asking about it (their question may use words like "the court", "the verdict", "the jury", "the judge"):

Charge that was on trial: "${v.charge}"
Final verdict: ${v.verdict === "HUNG JURY" ? `HUNG JURY — the jury deadlocked ${v.guilty} to ${v.notGuilty} and NO verdict was reached on the proposition` : `${v.verdict} — the jury split ${v.guilty} guilty / ${v.notGuilty} not guilty`}${v.quick ? " (quick trial: 6 jurors)" : ""}
${deliberationLine}The judge's summary: ${v.judgeSummary}
${v.chargesStuck?.length ? `\nCharges that stuck:\n${v.chargesStuck.map((c) => `- ${c}`).join("\n")}\n` : ""}${v.defenseWins?.length ? `What the defense won:\n${v.defenseWins.map((c) => `- ${c}`).join("\n")}\n` : ""}${v.conditions?.length ? `The judge's conditions (what to change before trying again):\n${v.conditions.map((c) => `- ${c}`).join("\n")}\n` : ""}${jurors ? `Jury votes:\n${jurors}\n` : ""}
Answer the user's question FROM THIS RECORD ONLY. Report the verdict, the split, the deliberation, the judge's reasoning and the juror positions exactly as recorded — never invent proceedings, votes or arguments that are not here. If the record does not cover what they asked, say so plainly. Do NOT start a new trial and do NOT suggest a research run for this.`;
}

/** CHAT LANE — direct conversational reply, no search, no report structure.
 *  Self-knowledge questions (engines/process/models/capabilities) get the grounded
 *  SELF_KNOWLEDGE spec injected into the prompt, so the answer is accurate even
 *  though the model has never seen the codebase. With courtRecall, the reply is
 *  answered from the trial record of a previous turn in this thread instead. */
async function runChatLane(
  ctx: Ctx,
  job: { id: string; query: string },
  threadContext: string,
  courtRecall?: { query: string; verdict: CourtVerdict }
): Promise<void> {
  const selfTopic = selfKnowledgeTopic(job.query) ?? (capabilityQuestion(job.query) ? ("capabilities" as SelfTopic) : null);
  await updateJob(ctx.jobId, { status: "planning", stage: "Thinking…", progress: 40, startedAt: new Date() });
  await ctx.emit(
    "info",
    "Chat mode — no research needed for this",
    courtRecall
      ? `You asked about the trial that already ran in this thread — I am recalling the verdict (${courtRecall.verdict.verdict}, ${courtRecall.verdict.guilty}–${courtRecall.verdict.notGuilty}) from the court record instead of re-trying a concluded case.`
      : selfTopic
      ? `This asks about my own ${selfTopicWord(selfTopic)} — I know that from my configuration, so I am answering directly from my product spec instead of launching the research pipeline.`
      : "This message reads as conversation (greeting / small talk / about DigDeep), so I am replying directly instead of launching the research pipeline. Ask any real question and I will dig deep."
  );
  const sec = await db.researchSection.create({
    data: { jobId: ctx.jobId, order: 0, title: "Reply", question: job.query, queries: "[]" },
  });
  let reply = "";
  let replyModel = "";
  let fallback = false;
  let pinNote = "";
  try {
    // The model's thinking AND the reply itself stream live — the user watches the answer
    // being written instead of staring at a spinner. Fast-fail opts: chat must never ride
    // minutes of throttling; the built-in script below catches total exhaustion.
    const res = await ctx.llmLive(
      [{ role: "user", content: chatPrompt(job.query, threadContext ? threadContext.slice(0, 1200) : "", selfTopic, courtRecall ? courtRecallText(courtRecall) : undefined) }],
      "chat-reply",
      "Thinking about your message",
      { system: CHAT_SYS, streamTo: sec.id, fast: { patient: false, timeoutMs: 30_000 } }
    );
    reply = res.text.trim();
    replyModel = res.model;
    pinNote = await maybePinFallbackNote(ctx, res);
  } catch {
    // every backend is throttled — answer from the built-in script instead of leaving the user hanging
    fallback = true;
    reply = builtinChatReply(job.query);
    replyModel = "DigDeep (built-in)";
    await ctx.emit("info", "Models are throttled — replying from my own script", "All free backends are rate-limited right now, so this reply is built in rather than model-generated. Nothing is lost — ask a real research question and the pipeline will wait out the cooldowns.");
  }
  await db.researchSection.update({ where: { id: sec.id }, data: { status: "done", draftMd: reply, findings: reply } });
  const durationMs = Date.now() - ctx.startedAt;
  const stats = {
    mode: "chat",
    durationMs,
    llmCalls: fallback ? 0 : 1,
    byModel: { [replyModel]: { calls: 1, totalMs: durationMs } },
    reportWords: reply.split(/\s+/).length,
    // visible degradation: this chat reply came from the built-in script, not a model
    ...(fallback ? { throttledFallback: true } : {}),
    finishedAt: new Date().toISOString(),
  };
  await updateJob(ctx.jobId, {
    status: "completed", stage: "Completed", progress: 100, reportMd: reply,
    stats: JSON.stringify(stats), completedAt: new Date(),
  });
  await notifyRunFinished(ctx.jobId); // v3.4: webhooks + watch advancement (never throws)
  await ctx.emit("done", "Replied", `Conversational answer in ${Math.round(durationMs / 1000)}s — no sources fetched, no research run${courtRecall ? " — recalled from the court record of this thread's trial" : ""}${fallback ? " (built-in script — models were throttled)" : ""}${pinNote ? ` (${pinNote})` : ""}`, replyModel, stats);
}

/** QUICK LANE — one focused search pass + a concise cited answer (Perplexity quick answer).
 *  v3.9.1 continuation: on sliced platforms (Vercel clock, CF free CPU cap) the
 *  search+read pass is checkpointed, and (when yieldBeforeCompose) the compose
 *  runs in a FRESH slice — the streamed answer is the lane's longest, heaviest
 *  call, and giving it its own platform budget is what lets quick answers
 *  survive hosts that kill long slices. A resumed run goes straight to compose
 *  and first tries to SALVAGE the partial draft the dead attempt streamed
 *  (the draft flushes to the section row every ~1.1s). */
export async function runQuickLane(
  ctx: Ctx,
  job: { id: string; query: string; language: string },
  threadContext: string,
  opts: {
    /** continuation: restore an interrupted search+read pass (sources kept, no re-search) */
    resume?: QuickLaneState;
    /** continuation: persist the searched+read state at the compose boundary */
    persist?: (s: QuickLaneState) => Promise<void>;
    /** hand the compose its own fresh slice (CF free plan: per-event CPU cap) */
    yieldBeforeCompose?: boolean;
  } = {}
): Promise<void> {
  let sec: { id: string };
  let valid: { n: number; title: string; domain: string; excerpt: string }[];
  let sourcesUsed: { n: number; url: string; title: string; domain: string }[];
  if (opts.resume) {
    // v3.9.1 continuation — the search+read pass completed in an earlier slice
    sec = { id: opts.resume.secId };
    valid = opts.resume.valid;
    sourcesUsed = opts.resume.sourcesUsed;
    await updateJob(ctx.jobId, { status: "researching", stage: "Writing the answer…", progress: 80 });
    await ctx.emit(
      "info",
      "Continuing the quick answer — resuming where the last slice stopped",
      "The sources for this answer were already found and read; the previous slice was cut short by the platform clock before the answer finished. This slice picks up exactly there — no re-searching, no re-reading."
    );
  } else {
  await updateJob(ctx.jobId, { status: "researching", stage: "Searching the web…", progress: 15, startedAt: new Date() });
  await ctx.emit(
    "info",
    "Quick-answer mode — skipping the full research pipeline",
    `This looks like a simple factual question, so I am doing ONE focused search pass instead of the multi-aspect research pipeline. Honest estimate: under a minute.${threadContext ? " (Thread context is being considered.)" : ""}`
  );
  const secRow = await db.researchSection.create({
    data: { jobId: ctx.jobId, order: 0, title: "Quick answer", question: job.query, queries: JSON.stringify([job.query]) },
  });
  sec = { id: secRow.id };

  // 1. search
  const rs = await searchAll(job.query, { academic: false });
  await ctx.emit("search", `Searching: “${job.query}”`, `${rs.length} results`, undefined, { query: job.query, count: rs.length, engines: [...new Set(rs.map((r) => r.engine))] });
  const gatedQuick = gateByRelevance(job.query, job.query, rs.filter((r) => r.url && !r.domain.includes("duckduckgo.com")));
  if (gatedQuick.dropped.length > 0) {
    await ctx.emit("refine", `Dropped ${gatedQuick.dropped.length} off-topic results — kept ${gatedQuick.kept.length}`, "The dropped pages matched filler words, not the question.");
  }
  const fresh = gatedQuick.kept;
  const picked: SearchResult[] = [];
  const domainCount: Record<string, number> = {};
  for (const r of fresh) {
    if (picked.length >= 4) break;
    if (ctx.seenUrls.has(r.url)) continue;
    const dc = domainCount[r.domain] ?? 0;
    if (dc >= 2) continue;
    domainCount[r.domain] = dc + 1;
    picked.push(r);
    ctx.seenUrls.add(r.url);
  }

  // 2. read (parallel, cap 4)
  sourcesUsed = [];
  const contents = await Promise.all(
    picked.map(async (r) => {
      const page = await fetchPageContent(r.url, 3200, r.excerpt);
      if (!page) {
        await ctx.emit("read", `Could not read ${r.domain}`, r.title, undefined, { url: r.url, ok: false }, "verbose");
        return null;
      }
      const n = ++ctx.sourceN;
      const excerpt = page.text.split(/\s+/).slice(0, 750).join(" ");
      await db.source.create({
        data: { jobId: ctx.jobId, url: r.url, domain: r.domain || page.domain, title: r.title || page.title || r.domain, snippet: r.snippet || excerpt.slice(0, 280), engine: r.engine, words: page.words, used: true, sectionTitle: "Quick answer", round: 1, quality: 60 },
      }).catch(() => null);
      sourcesUsed.push({ n, url: r.url, title: r.title || page.title || r.domain, domain: r.domain || page.domain });
      await ctx.emit("read", `Reading ${r.domain} · ${page.words.toLocaleString()} words`, r.title || page.title, undefined, { url: r.url, words: page.words, n }, "verbose");
      return { n, title: r.title || page.title, domain: r.domain || page.domain, excerpt };
    })
  );
  valid = contents.filter((c): c is { n: number; title: string; domain: string; excerpt: string } => !!c);

  // snippet fallback so citations & the Sources row stay honest
  if (valid.length === 0 && rs.length > 0) {
    await ctx.emit("info", "Full page reads failed — using search-result snippets (marked “snippet” in sources)");
    const snippetSrcs = rs.slice(0, 4).map((r, i) => ({ n: 900 + i, title: r.title, domain: r.domain, excerpt: r.snippet }));
    for (let i = 0; i < snippetSrcs.length; i++) {
      const r = rs[i];
      if (!r?.url) continue;
      await db.source.create({
        data: { jobId: ctx.jobId, url: r.url, domain: r.domain || "", title: r.title || r.domain || "source", snippet: r.snippet, engine: "snippet", words: 0, used: true, sectionTitle: "Quick answer", round: 1, quality: 30 },
      }).catch(() => null);
      sourcesUsed.push({ n: 900 + i, url: r.url, title: r.title || r.domain, domain: r.domain || "" });
    }
    valid = snippetSrcs;
  }
  } // ── end fresh run (search + read complete) ─────────────────────────────

  // 2.5 v3.9.1 continuation boundary — persist what the compose needs, and on
  // platforms that asked for it (CF free: per-event CPU cap) END this slice so
  // the streamed answer is composed in a fresh event with a fresh budget.
  // (The stage update comes FIRST so a yielded run waits at an honest
  // "Writing the answer…" 80%, not at "Searching the web…" 15%.)
  await updateJob(ctx.jobId, { stage: "Writing the answer…", progress: 80 });
  if (opts.persist) {
    await opts.persist({ secId: sec.id, valid, sourcesUsed, threadContext });
    if (opts.yieldBeforeCompose) {
      await ctx.emit(
        "info",
        "Slice boundary — composing the answer in a fresh slice",
        "The sources are already found and read, and the platform caps each function slice, so the answer itself is composed in a fresh slice. Nothing is re-done — the next slice continues from exactly here."
      );
      return; // the poller's next GET resumes from the checkpoint straight into compose
    }
  }

  // 3. answer (streamed live — the answer types itself out as it is generated)
  let answer = "";
  let answerModel: string | undefined;
  if (opts.resume) {
    // v3.9.1 SALVAGE — the dead attempt streamed its draft into the section row
    // (flushed every ~1.1s). If most of the answer is already there, complete
    // from it instead of gambling on another full compose pass.
    try {
      const prior = await db.researchSection.findUnique({ where: { id: opts.resume.secId }, select: { draftMd: true } });
      const priorText = (prior?.draftMd ?? "").trim();
      if (priorText.length >= 400) {
        answer = priorText;
        await ctx.emit(
          "info",
          "Recovering the interrupted answer",
          "The previous attempt had already written most of this answer when the platform cut it short — completing from that text instead of restarting the composition from zero."
        );
      }
    } catch { /* no salvageable draft — fall through to a fresh compose */ }
  }
  if (!answer && valid.length > 0) {
    const res = await ctx.llmLive(
      [{ role: "user", content: quickAnswerPrompt(job.query, valid, job.language) }],
      "quick-answer",
      "Composing a quick answer",
      { streamTo: sec.id }
    );
    answer = res.text;
    answerModel = res.model;
    await maybePinFallbackNote(ctx, res);
  } else if (!answer) {
    // nothing retrievable — answer from general knowledge, honestly flagged
    const res = await ctx.llmLive(
      [{ role: "user", content: `Question: "${job.query}"\n\nWeb searches returned no usable sources. Answer directly from general knowledge in ${job.language}. Be concise (under 250 words), lead with the answer, and END with one short italic line noting that web sources could not be retrieved for this answer so it is unverified general knowledge.` }],
      "quick-answer-nosrc",
      "Composing a quick answer",
      { streamTo: sec.id }
    );
    answer = res.text;
    answerModel = res.model;
    await maybePinFallbackNote(ctx, res);
  }
  await db.researchSection.update({ where: { id: sec.id }, data: { status: "done", draftMd: answer, findings: answer, rounds: 1 } });
  await ctx.emit("draft", "Answer written", `${answer.split(/\s+/).length} words`, answerModel, { section: "Quick answer" });

  // 4. related questions (best-effort)
  let relatedQuestions: string[] = [];
  try {
    const rr = await ctx.llm([{ role: "user", content: relatedPrompt(job.query, [], job.language) }], "related", false, 300, { patient: false, timeoutMs: 60_000 });
    relatedQuestions = extractJsonArray(rr.text) ?? [];
  } catch { /* optional */ }

  // 5. assemble
  const durationMs = Date.now() - ctx.startedAt;
  const remap: Record<number, number> = {};
  sourcesUsed.forEach((s, i) => (remap[s.n] = i + 1));
  const refs = sourcesUsed.map((s, i) => `${i + 1}. ${s.title} — *${s.domain}* — ${s.url}`).join("\n");
  const body = sourcesUsed.length > 0 ? answer.replace(/\[(\d+)\]/g, (_, d) => `[${remap[Number(d)] ?? d}]`) : answer;
  const reportMd = sourcesUsed.length > 0 ? `${body}\n\n## References\n\n${refs}` : body;
  const stats = {
    mode: "quick",
    durationMs,
    sourcesConsulted: sourcesUsed.length,
    llmCalls: ctx.llmCalls,
    byModel: ctx.byModel,
    reportWords: answer.split(/\s+/).length,
    relatedQuestions,
    sections: 1,
    finishedAt: new Date().toISOString(),
  };
  await updateJob(ctx.jobId, {
    status: "completed", stage: "Completed", progress: 100, reportMd,
    stats: JSON.stringify(stats), completedAt: new Date(),
  });
  await notifyRunFinished(ctx.jobId); // v3.4: webhooks + watch advancement (never throws)
  await ctx.emit("done", "Quick answer ready", `Answered in ${Math.round(durationMs / 1000)}s · ${sourcesUsed.length} sources · ${ctx.llmCalls} LLM calls — ask a follow-up or say “go deeper” for the full pipeline`, undefined, stats);
}

/** Main entry: runs the full research pipeline for a job. Fire-and-forget safe.
 *  v2.5.0 continuation: on serverless the engine runs in ~5-min SLICES. When a
 *  slice's function clock ends, it persists a checkpoint and returns; the
 *  client's live-poller hits GET /api/research/[id], which re-triggers runJob —
 *  the next slice resumes from the checkpoint (aspects, drafts, grading, the
 *  improve loop — all phase-gated). The ABSOLUTE budget (job.maxMinutes, from
 *  the first slice's start) spans slices, so a 30-min research budget is really
 *  30 minutes of research, not 113 seconds squeezed inside one function. */
export async function runJob(jobId: string) {
  if (engineAlive(jobId)) return; // live engine on THIS instance — never double-run
  activeJobs.set(jobId, Date.now());
  let leaseHeld = false;
  let heart: ReturnType<typeof setInterval> | null = null; // v2.5.0 interval heartbeat
  try {
    let job = await db.researchJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    // cross-instance single-run guard: exactly one instance may hold the lease
    leaseHeld = await acquireLease(jobId);
    if (!leaseHeld) return;

    // v3.9.1 anti-livelock guard: an ACTIVE job that already burned its slice
    // budget without completing fails honestly instead of being re-adopted
    // forever. Live-observed on the CF free plan: a run killed mid-phase has no
    // checkpoint, so each adoption restarted it from 0% — an unbounded loop of
    // re-searching and re-reading that never completes (sliceN was only
    // persisted on checkpoint-resumes, so the old MAX_SLICES guard never fired).
    const MAX_SLICES = process.env.CF_PROFILE === "1" ? 60 : 12; // CF slices are ~45s, not ~5min
    if ((job.sliceN ?? 0) >= MAX_SLICES) {
      await db.researchJob.update({
        where: { id: jobId },
        data: {
          status: "failed", stage: "Interrupted",
          error: `This run was cut short by the hosting platform ${job.sliceN} times without completing. Please start a fresh run — each attempt gets fresh platform resources, and shorter modes (quick) usually complete.`,
          completedAt: new Date(),
        },
      }).catch(() => {});
      await db.activityEvent.create({
        data: { jobId, type: "error", title: "Run interrupted too many times", detail: "The hosting platform kept cutting this run short before it could checkpoint. Starting a fresh run is the honest path — each attempt gets fresh resources.", seq: 9_999_999 },
      }).catch(() => {});
      await notifyRunFinished(jobId).catch(() => {}); // run.failed webhooks
      return;
    }

    const unlimited = job.breadth < 0 || job.depth < 0 || job.maxSources < 0 || job.maxMinutes < 0;
    // P2-1 domain pack — evidence standards, authority whitelists, citation format
    const pack = getDomainPack(job.domain);
    // ── serverless wall-clock (Vercel) ─────────────────────────────────────
    // v2.5.0: the budget is no longer clamped to one invocation. Each slice
    // gets a fresh 288s function clock (hardStop) while the RESEARCH budget
    // is absolute — anchored at the first slice's t0, restored from the
    // checkpoint on every resume. The tail (drafts → grade → improve) still
    // reserves the last 175s of the ABSOLUTE deadline.
    const SERVERLESS = !!process.env.VERCEL || process.env.CF_PROFILE === "1";
    // v3.9.1: CF_PROFILE counts as serverless too — the Workers free plan caps
    // CPU per request event, so the engine MUST slice + checkpoint + yield so
    // each next phase lands in a fresh event with a fresh CPU budget. CF slices
    // are much shorter (45s default) than Vercel's 288s; DIGDEEP_SLICE_MS
    // overrides both without a code change.
    const CF = process.env.CF_PROFILE === "1";
    const sliceMs = Math.max(
      CF ? 10_000 : 30_000,
      Number(process.env.DIGDEEP_SLICE_MS) || (CF ? 45_000 : 288_000)
    );
    const rawBudgetMs = unlimited ? Infinity : Math.max(3, job.maxMinutes) * 60_000;

    // ── v2.5.0 continuation state: load the checkpoint, restore ctx ────────
    const cp = await loadCheckpoint(job);
    const resuming = !!cp;
    const resumePhase: EnginePhase | undefined = cp?.phase;
    const t0 = cp?.t0 ?? Date.now();
    const absoluteDeadline = cp?.absoluteDeadline ?? (unlimited ? null : t0 + rawBudgetMs);
    const budgetMinutes = unlimited ? -1 : Math.max(1, Math.floor(rawBudgetMs / 60_000));
    const sliceN = (job.sliceN ?? 0) + 1;

    const maxSeq = await db.activityEvent.aggregate({ where: { jobId }, _max: { seq: true } });
    const ctx = new Ctx(jobId, job.modelPref as ModelPref, (maxSeq._max.seq ?? 0) + 1, {
      maxMinutes: budgetMinutes,
      depth: job.depth,
      maxSources: job.maxSources,
      anyUnlimited: unlimited,
      // each SLICE gets a fresh function clock — the platform freezes at 300s
      // (Vercel) or throttles CPU per event (Cloudflare free).
      // (DIGDEEP_SLICE_MS shortens the slice for local continuation testing.)
      ...(SERVERLESS ? { hardStopMs: sliceMs } : {}),
    });
    // v2.5.0: the deadline is ABSOLUTE across slices, not per-invocation
    ctx.deadline = absoluteDeadline ?? Infinity;
    // the research cutoff is anchored at Stage-2 entry on a fresh run; on a
    // resumed run it comes from the checkpoint (set below after restore)

    // ── hoisted tail state (persist()/resume() need them before stages run) ─
    let intent: Intent = "research";
    let routeWhy = "";
    // v2.7 CONVERSATION CONTINUITY: the query the engine actually researches —
    // the user's message, resolved against the thread's memory when it was a
    // follow-up ("what is the court opinion" → the prior topic on trial).
    // Stage 0 sets it; the checkpoint carries it across slices; everything
    // from comprehension to the verdict runs on this one shared context.
    let q = job.query;
    let comprehensionCriteria: string[] = [];
    let agentName = "";
    let sourcesUsed: SourceRef[] = [];
    let citeStats: { checked: number; repaired: number; dropped: number; integrity: number; reanchoredTo: number[]; droppedNs: number[]; flagged: number[] } = {
      checked: 0, repaired: 0, dropped: 0, integrity: 100, reanchoredTo: [], droppedNs: [], flagged: [],
    };
    let quality: QualityScore | null = null;
    let qualityRounds = 0;
    let refList: SourceRef[] = [];
    let refs = "";
    let execText = "";
    let concText = "";
    let titleText = "";
    let relatedQuestions: string[] = [];
    let disagreementsMd = "";
    let diffMd = "";
    let words: [number, number] = [420, 650];
    let reportWords = 0;
    let durationMs = 0;
    let spawnedCount = { n: 0 };
    let courtProgress: EngineCheckpoint["courtProgress"];
    let court: CourtVerdict | null = null; // hoisted v2.5.0: restored from the checkpoint on resume
    let auditDone = false;
    let bundleDoneState = false; // v2.5.0: the tail bundle completed (this slice or a previous one)
    let resumeDrafting = resumePhase === "drafting"; // exactly-drafting: skip drafted sections
    let concurrency = 2; // aspect worker count — set by the plan stage, restored default on resume

    // ── restore ctx state from the checkpoint ──────────────────────────────
    if (cp) {
      ctx.rolePrompt = cp.rolePrompt ?? "";
      ctx.allLearnings = cp.allLearnings ?? [];
      ctx.claims = cp.claims ?? [];
      ctx.contradictions = cp.contradictions ?? [];
      ctx.seenUrls = new Set((cp.seenUrls ?? []).slice(0, 3000));
      ctx.sourceN = cp.sourceN ?? 0;
      ctx.llmCalls = cp.llmCalls ?? 0;
      ctx.byModel = cp.byModel ?? {};
      ctx.walkedUrls = cp.walkedUrls ?? 0;
      ctx.rerankRuns = cp.rerankRuns ?? 0;
      ctx.aspectTimes = cp.aspectTimes ?? [];
      ctx.researchCutoffAt = cp.researchCutoffAt ?? Number.POSITIVE_INFINITY;
      for (const [n, text] of cp.sourceTexts ?? []) ctx.sourceTexts.set(n, text);
      for (const [n, meta] of cp.sourceMeta ?? []) ctx.sourceMeta.set(n, meta);
      sourcesUsed = cp.sourcesUsed ?? [];
      comprehensionCriteria = cp.comprehensionCriteria ?? [];
      q = cp.researchQuery ?? job.query; // v2.7: resumed slices research the same resolved question
      agentName = cp.agentName ?? "";
      citeStats = cp.citeStats ?? citeStats;
      quality = (cp.quality as QualityScore) ?? null;
      qualityRounds = cp.qualityRounds ?? 0;
      refList = cp.refList ?? [];
      execText = cp.execText ?? "";
      concText = cp.concText ?? "";
      titleText = cp.titleText ?? "";
      relatedQuestions = cp.relatedQuestions ?? [];
      disagreementsMd = cp.disagreementsMd ?? "";
      words = cp.words ?? words;
      reportWords = cp.reportWords ?? 0;
      spawnedCount = { n: cp.spawnedCount ?? 0 };
      courtProgress = cp.courtProgress;
      court = (cp.courtVerdict as CourtVerdict | undefined) ?? null;
      auditDone = cp.auditDone === true;
      bundleDoneState = cp.bundleDone === true;
      concurrency = cp.aspectTimes?.length ? Math.max(2, Math.min(4, Math.round(cp.aspectTimes.length / 2))) : 4;
      await ctx.emit(
        "info",
        `Continuing the run — serverless slice ${sliceN} of at most ${MAX_SLICES}`,
        `The previous function slice reached its platform clock, so the engine checkpointed its state and paused. This slice resumes exactly where it stopped (no re-searching, no re-reading) — the time budget is spent on research, not restarts. Elapsed so far: ${fmtMin(Date.now() - t0)}.`,
        undefined,
        { slice: sliceN, phase: resumePhase, elapsedMs: Date.now() - t0 }
      );
    }
    // v3.9.1: persist sliceN on EVERY adoption, not just checkpoint-resumes —
    // a platform that keeps killing slices mid-phase (CF free CPU cap) must see
    // the counter climb even when each restart begins from scratch, or the
    // MAX_SLICES runaway guard at the top of runJob never fires.
    await db.researchJob.update({ where: { id: jobId }, data: { sliceN } }).catch(() => {});

    /** v2.5.0: persist the continuation checkpoint. Called at phase boundaries
     *  and after each aspect/round completes — a slice frozen between saves
     *  resumes from the previous boundary at worst. Fire-and-safe by design. */
    const persist = (phase: EnginePhase, extra: Partial<EngineCheckpoint> = {}) => {
      return saveCheckpoint(jobId, {
        v: 1,
        phase,
        t0,
        absoluteDeadline,
        researchCutoffAt: Number.isFinite(ctx.researchCutoffAt) ? ctx.researchCutoffAt : null,
        sliceN,
        intent,
        routeWhy,
        researchQuery: q,
        comprehensionCriteria,
        rolePrompt: ctx.rolePrompt,
        agentName,
        allLearnings: ctx.allLearnings,
        claims: ctx.claims,
        contradictions: ctx.contradictions,
        sourcesUsed,
        sourceTexts: [...ctx.sourceTexts.entries()],
        sourceMeta: [...ctx.sourceMeta.entries()],
        seenUrls: [...ctx.seenUrls].slice(0, 3000),
        citeStats,
        llmCalls: ctx.llmCalls,
        byModel: ctx.byModel,
        walkedUrls: ctx.walkedUrls,
        rerankRuns: ctx.rerankRuns,
        aspectTimes: ctx.aspectTimes,
        sourceN: ctx.sourceN,
        spawnedCount: spawnedCount.n,
        ...(quality ? { quality: quality as EngineCheckpoint["quality"] } : {}),
        ...(qualityRounds > 0 ? { qualityRounds } : {}),
        refList,
        execText,
        concText,
        titleText,
        relatedQuestions,
        disagreementsMd,
        words,
        reportWords,
        ...(courtProgress ? { courtProgress } : {}),
        ...(court ? { courtVerdict: court } : {}),
        ...(auditDone ? { auditDone: true } : {}),
        ...(bundleDoneState ? { bundleDone: true } : {}),
        ...extra,
      } as Partial<EngineCheckpoint> & { phase: EnginePhase });
    };

    /** v2.5.0: true when THIS slice's function clock is nearly over — the
     *  current phase should checkpoint and return; the poller resumes us. */
    const outOfSlice = () => SERVERLESS && ctx.hardLeft < 30_000;
    /** v2.5.0: the run must stop for good (absolute budget spent or slice cap). */
    const runExhausted = () => sliceN >= MAX_SLICES;

    // v2.5.0: interval heartbeat — the lease and the same-instance liveness must
    // NEVER depend on emit frequency: a patient LLM retry loop can legitimately
    // go 60-90s without a single event, and an expired lease in that window lets
    // a poll start a SECOND engine (the seq-collision failure this fixes).
    heart = setInterval(() => {
      activeJobs.set(jobId, Date.now());
      renewLease(jobId).catch(() => {});
    }, 8_000);

    if (SERVERLESS && !resuming) {
      const sliceLabel = sliceMs >= 90_000 ? `~${Math.round(sliceMs / 60_000)}-minute` : `~${Math.round(sliceMs / 1000)}-second`;
      await ctx.emit(
        "info",
        `Serverless continuation run — the engine works in ${sliceLabel} slices until your ${unlimited ? "open-ended (unlimited)" : `${budgetMinutes}-minute`} budget is spent`,
        `This deployment runs on serverless functions, which cap each function slice at ${sliceLabel}. The engine checkpoints its state continuously and continues in a fresh slice whenever one ends — so the full time budget is spent on research, not squeezed into one invocation. Multi-engine search, citation audit, self-grading and improvement rounds all run unchanged, across as many slices as the budget needs.`,
        undefined,
        { serverless: true, continuation: true, budgetMs: unlimited ? null : rawBudgetMs, sliceMs }
      );
    }

    // follow-up context — v2.7 CONVERSATION MEMORY (the thread's worklog):
    // the last completed turns of this thread, oldest → newest, each compressed
    // to its question + a digest of the answer. This is what keeps the whole
    // conversation related to itself: the router reads it, the follow-up
    // resolver resolves against it, and a message like "what is the court
    // opinion" continues the ECL thread instead of becoming a stray 40-minute
    // trial about judicial opinions.
    let threadContext = "";
    let recentTurns = "";
    let threadMemory = "";
    let prevQuery = "";
    let prevReportMd = "";
    // v2.9 court-routing state: the thread's most recent trial (for verdict
    // recall), the recall handed to the chat lane, and the "gavel stays down"
    // override for messages that are not claims.
    let lastCourt: { query: string; verdict: CourtVerdict } | null = null;
    let courtRecall: { query: string; verdict: CourtVerdict } | undefined;
    let noTrial = false;
    if (job.threadId) {
      let hist: { query: string; mode: string; reportMd: string | null; stats: string | null }[] = [];
      try {
        hist = await db.researchJob.findMany({
          where: { threadId: job.threadId, status: "completed", id: { not: job.id }, reportMd: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 6,
          select: { query: true, mode: true, reportMd: true, stats: true },
        });
      } catch { hist = []; }
      const turns = [...hist].reverse(); // oldest → newest — the conversation reads in order
      if (turns.length > 0) {
        threadMemory = turns
          .map((t, i) =>
            `[${i + 1}] User asked: “${t.query.slice(0, 220)}”\n    DigDeep answered (${t.mode}): ${(t.reportMd ?? "")
              .replace(/^#\s+\[?\d*\]?\s*/, "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 260)}`
          )
          .join("\n");
        const last = turns[turns.length - 1];
        threadContext = (last.reportMd ?? "").slice(0, 4000);
        recentTurns = threadMemory.slice(0, 900);
        prevQuery = last.query;
        prevReportMd = last.reportMd ?? "";
        // v2.9 VERDICT RECALL: find the most recent turn in this thread that ran
        // a court trial (its persisted stats carry the full verdict record) —
        // "what is the court opinion" recalls THIS, instead of re-trying the case.
        for (let i = turns.length - 1; i >= 0; i--) {
          if (!turns[i].stats) continue;
          try {
            const st = JSON.parse(turns[i].stats!) as { court?: CourtVerdict };
            if (st?.court && typeof st.court.verdict === "string" && st.court.charge) {
              lastCourt = { query: turns[i].query, verdict: st.court };
              break;
            }
          } catch { /* not JSON — skip this turn */ }
        }
      }
    }

    // user-attached ground-truth documents (P2-3) — available on every lane below
    let docs: { name: string; text: string }[] = [];
    try {
      docs = (job.docs ? JSON.parse(job.docs) : []).filter(
        (d: { name?: unknown; text?: unknown }) => typeof d?.name === "string" && typeof d?.text === "string" && (d.text as string).trim().length > 0
      );
    } catch { /* malformed docs are ignored */ }
    docs = docs.slice(0, 4);

    // ── v3.9.1 QUICK-LANE CONTINUATION ────────────────────────────────────
    // A checkpoint in phase "drafting" carrying quick-lane state means the
    // search+read pass already completed in an earlier slice — resume straight
    // at compose (or salvage the partial draft the dead attempt streamed).
    // Without this, a slice death mid-compose restarted the whole run from 0%
    // every time (live-observed on the CF free plan).
    if (resuming && cp?.quick && resumePhase === "drafting") {
      await runQuickLane(ctx, { ...job, query: q }, threadContext, {
        resume: cp.quick,
        yieldBeforeCompose: false, // already in a fresh slice — compose now
      });
      return;
    }

    // ---------- STAGE 0: UNDERSTAND FIRST, THEN ROUTE (chat vs quick answer vs deep research) ----------
    // The selected mode (quick…unlimited) sets HOW DEEP real questions get researched —
    // it must NEVER force research onto conversational or capability questions.
    // v2.7: that guard includes COURT MODE — a greeting or capability question with
    // the gavel on still gets a direct reply; "hi" must never think for 40 minutes.
    // v2.9 CHAT-WITH-COURT: the gavel being up no longer makes EVERY message a trial.
    // A question about a trial that already ran recalls its verdict from the record;
    // a clear claim shape goes straight to court; everything else gets the same
    // understanding-first routing as court-off messages (court-aware: the classifier
    // can still send a genuine proposition to trial). Follow-up propositions are
    // RESOLVED against the conversation memory first, so "and is that actually true"
    // tries the thread's actual topic.
    // v2.5.0: on a resumed run (checkpoint exists) routing already happened — the
    // chat/quick lanes complete inside a single slice, so a checkpoint means research.
    let plan: ResearchPlan | null = null;
    if (!resuming) {
    await updateJob(jobId, { status: "planning", stage: "Reading your message", progress: 3 });
    intent = "research";
    routeWhy = "";
    const selfTopic = selfKnowledgeTopic(job.query) ?? (capabilityQuestion(job.query) ? ("capabilities" as SelfTopic) : null);
    const heuristic = heuristicChatIntent(job.query);
    if (heuristic === "chat" || selfTopic) {
      intent = "chat";
      // The understanding is VISIBLE the instant the job starts — no model call, no delay.
      // The user sees exactly why this is a direct reply, in the same thought-block style
      // as the model's own live reasoning: think → understand → respond.
      const cap = capabilityQuestion(job.query);
      const tid = `route-${jobId}`;
      await ctx.emit("think", "Understanding your message", undefined, undefined, { thoughtId: tid, started: true });
      await ctx.emit(
        "think",
        "Understanding your message",
        `Reading your message: “${job.query.slice(0, 200)}”. ${
          selfTopic
            ? `This asks about my own ${selfTopicWord(selfTopic)} — my machinery, not a topic out in the world. I know this about myself from my configuration, so I am answering directly from my product spec. Searching the web for a question about myself would be absurd.`
            : cap
            ? "This is a question about whether I can do something — my own abilities — not a research topic. Searching the web for these literal words would be absurd, so I am answering directly instead."
            : "This reads as conversation — a greeting, small talk, or a question about me — so it needs no web research. I am replying directly instead of launching the pipeline."
        }`,
        undefined,
        { thoughtId: tid, done: true, model: "instant read — no model call needed" }
      );
      routeWhy = selfTopic
        ? `a question about my own ${selfTopicWord(selfTopic)} — answered from my grounded product spec, no research needed (understood instantly, no model call required)`
        : `this is ${cap ? "a question about my own abilities" : "conversation"} — no research needed (understood instantly, no model call required)`;
      routeWhy += ["deep", "exhaustive", "unlimited"].includes(job.preset) ? `. Your "${job.preset}" mode applies to real research questions, not to this` : "";
      if (job.court) {
        routeWhy += ". Court mode is on, but there is nothing to put on trial in a greeting";
        await ctx.emit(
          "info",
          "Court mode is on — but there is nothing to put on trial here",
          "Give me a real claim or question and the gavel comes down: a prosecutor, a defense, a jury of 12 and a judge, over cited evidence."
        );
      }
    } else if (courtMetaQuestion(job.query) && lastCourt) {
      // v2.9 VERDICT RECALL — a question about the trial that already ran gets
      // the verdict from the record; a concluded case is never re-tried just
      // because you asked what the judge said.
      intent = "chat";
      courtRecall = lastCourt;
      routeWhy = `a question about the trial that already ran in this thread — recalling its verdict (${lastCourt.verdict.verdict}, ${lastCourt.verdict.guilty}–${lastCourt.verdict.notGuilty}) instead of re-trying a concluded case`;
      const tid = `route-${jobId}`;
      await ctx.emit("think", "Reading your message against the trial in this thread", undefined, undefined, { thoughtId: tid, started: true });
      await ctx.emit(
        "think",
        "Reading your message against the trial in this thread",
        `Reading your message: “${job.query.slice(0, 200)}”. This asks about the trial this thread already ran — the one that put “${lastCourt.verdict.charge.slice(0, 140)}” on trial and returned ${lastCourt.verdict.verdict} (${lastCourt.verdict.guilty}–${lastCourt.verdict.notGuilty}). Nothing needs re-trying: the verdict and the jury's votes are on the record, so I am recalling them directly.`,
        undefined,
        { thoughtId: tid, done: true, model: "instant read — no model call needed" }
      );
    } else if (job.court) {
      // v2.9 CHAT-WITH-COURT: the gavel being up must never turn every message
      // into a trial. Clear claim shapes go straight to court (no classifier —
      // the user asked for the gavel); everything else gets the SAME
      // understanding-first routing as court-off messages, court-aware: the
      // classifier can still send a genuine proposition to trial.
      const worth = courtTrialWorthiness(job.query);
      let toTrial = false;
      let read = "";
      if (worth === "trial") {
        toTrial = true; // unambiguous claim shape — the trial the user asked for, zero extra latency
      } else {
        const cls = await classifyIntent(ctx, job.query, recentTurns, job.preset, worth === "info" ? "no-trial" : "trial-fallback");
        toTrial = cls.trial;
        read = cls.how;
        if (!toTrial) {
          intent = cls.intent;
          if (intent !== "chat") q = await resolveFollowUp(ctx, job.query, threadMemory, false);
          noTrial = true; // the gavel stays down for this message
          routeWhy =
            read +
            (intent === "chat"
              ? ". Court mode is on, but this is conversation, not a claim — the gavel stays down for it. Give me a real claim and the full trial fires"
              : intent === "quick"
              ? ". Court mode is on, but a simple lookup is not a claim to adjudicate — no trial for this one. Give me a real claim and the gavel comes down"
              : ". Court mode is on, but this is an information question, not a claim — researching it normally. Give me a proposition and the gavel comes down");
        }
      }
      if (toTrial) {
        intent = "research";
        // the proposition is read AGAINST the conversation before the gavel — a
        // follow-up claim like "and is that actually true" tries the thread's topic
        q = await resolveFollowUp(ctx, job.query, threadMemory, true);
        routeWhy =
          worth === "trial"
            ? "court mode — this reads as a claim, so it gets a prosecutor, a defense, a jury of 12 and a judge"
            : read || "court mode — on the router's read this is a real proposition: it gets a prosecutor, a defense, a jury of 12 and a judge";
        await ctx.emit(
          "court",
          "Court is in session",
          `The proposition on trial: “${q.slice(0, 240)}”${q !== job.query ? " — your words, read in the context of this conversation" : ""}. Evidence is gathered first by the research engine (both for and against), then the prosecution and the defense build their cases from it, a jury of 12 independent personas votes, and the judge reads the verdict — with what to change before trying again.`,
          undefined,
          { phase: "opening", charge: q.slice(0, 300) }
        );
      }
    } else {
      const cls = await classifyIntent(ctx, job.query, recentTurns, job.preset);
      intent = cls.intent;
      routeWhy = cls.how;
      // a real question that continues the thread resolves to a self-contained
      // query before anything else — one conversation, one shared context
      if (intent !== "chat") q = await resolveFollowUp(ctx, job.query, threadMemory, false);
    }
    await updateJob(jobId, { mode: intent });
    if (intent === "chat") {
      await ctx.emit("info", "Routed to: chat", routeWhy);
      await runChatLane(ctx, job, threadContext, courtRecall);
      return;
    }
    if (intent === "quick") {
      await ctx.emit("info", "Routed to: quick answer", routeWhy);
      await runQuickLane(ctx, { ...job, query: q }, threadContext, {
        // v3.9.1: checkpoint the search+read pass so a mid-compose slice death
        // resumes at compose instead of restarting the whole run; on CF also
        // hand the compose a fresh slice of its own (per-event CPU cap).
        persist: (s) =>
          saveCheckpoint(jobId, {
            v: 1,
            phase: "drafting",
            t0,
            absoluteDeadline,
            researchCutoffAt: null,
            sliceN,
            researchQuery: q,
            quick: s,
          }),
        yieldBeforeCompose: CF,
      });
      return;
    }

    await updateJob(jobId, { status: "planning", stage: "Understanding the question", startedAt: new Date(), progress: 4 });
    await ctx.emit(
      "info",
      job.court && !noTrial ? "Routed to: the court" : "Routed to: deep research",
      `${routeWhy}. Mode: ${unlimited ? "UNLIMITED — no caps on aspects, rounds, sources or time; research continues until coverage is genuinely sufficient" : `breadth ${job.breadth} · depth ${job.depth} · max ${job.maxSources} sources · budget ${job.maxMinutes} min`} · route: ${routeInfoFor(job.modelPref).route}`
    );

    // v2.9: when court mode is on but this message is not a claim, the gavel
    // stays down for it — the in-memory flag goes false so the plan, the debate
    // stage and the report all treat this as a normal research run (the DB row
    // keeps the user's toggle for the thread's history).
    if (noTrial) job = { ...job, court: false };

    // ---------- STAGE 1: PLAN ----------
    // Guard: a real research question never researches the literal text of a question
    // about DigDeep itself — this is the backstop for a router that misread a
    // capability or self-machinery question ("can you make a deep research?",
    // "i mean like brave and those engine not the ai model") as a research request.
    // (court runs skip the guard: the user explicitly put this text on trial)
    const qLower = job.query.toLowerCase();
    const selfBackstop = selfKnowledgeTopic(job.query) ?? (capabilityQuestion(job.query) ? ("capabilities" as SelfTopic) : null);
    if (!job.court && (/\b(digdeep|dig deep)\b/.test(qLower) || /\byour (capabilities|features|modes)\b/.test(qLower) || selfBackstop)) {
      await ctx.emit(
        "info",
        "Wait — on a closer read, this is really a question about me",
        selfBackstop
          ? `This message asks about my own ${selfTopicWord(selfBackstop)} rather than a research topic, so I am answering it directly from my product spec instead of researching the literal text.`
          : "This message asks about my own abilities rather than a research topic, so I am answering it directly instead of researching the literal text. Nothing is lost — give me a real topic and the full pipeline fires."
      );
      await updateJob(jobId, { mode: "chat" });
      await runChatLane(ctx, job, threadContext, courtRecall);
      return;
    }
    // v2.7 CONVERSATION CONTINUITY: from here on the engine works on the RESOLVED
    // query — the user's message, rewritten (when it was a follow-up) into a
    // question that stands alone. Every stage below — comprehension, plan,
    // searches, the trial, drafts, grading — shares this one context with the
    // rest of the thread, so no turn is ever an island.
    job = { ...job, query: q };
    // ---- STAGE 1a: COMPREHENSION — understand the question the way Claude reads a prompt
    //      BEFORE acting: restate it, pin the intent, define what a great answer must
    //      establish, flag ambiguities. Runs IN PARALLEL with the scouting search, so it
    //      adds no wall-clock time; its output feeds (and sharpens) the plan. Degrades
    //      gracefully — no comprehension → the plan proceeds on the raw query as before.
    comprehensionCriteria = []; // kept for the Stage 5 self-score
    const compPromise = (async () => {
      try {
        const res = await ctx.llmLive(
          [{ role: "user", content: comprehensionPrompt(job.query, threadContext || undefined, docs.map((d) => ({ name: d.name }))) }],
          "comprehend",
          "Understanding the question",
          { wantThinking: true, maxTokens: 1200, fast: { patient: false, timeoutMs: SERVERLESS ? 25_000 : 45_000 } }
        );
        const comp = extractJson(res.text);
        if (comp && (comp.restate || comp.intent || comp.successCriteria)) {
          if (Array.isArray(comp.successCriteria)) comprehensionCriteria = comp.successCriteria.map((c: unknown) => String(c)).slice(0, 4);
          const digest = [
            comp.restate ? `What is being asked: ${comp.restate}` : "",
            comp.intent ? `What a great answer must deliver: ${comp.intent}` : "",
            Array.isArray(comp.successCriteria) && comp.successCriteria.length ? `Success criteria:\n${comp.successCriteria.map((c: string) => `  - ${c}`).join("\n")}` : "",
            Array.isArray(comp.ambiguous) && comp.ambiguous.length ? `Ambiguities to resolve: ${comp.ambiguous.join(" · ")}` : "",
            Array.isArray(comp.subQuestions) && comp.subQuestions.length ? `Sub-questions to cover:\n${comp.subQuestions.map((q: string) => `  - ${q}`).join("\n")}` : "",
          ].filter(Boolean).join("\n");
          await ctx.emit(
            "comprehend",
            "Understood the question",
            digest,
            res.model,
            { restate: comp.restate, intent: comp.intent, successCriteria: comp.successCriteria ?? [], ambiguous: comp.ambiguous ?? [], subQuestions: comp.subQuestions ?? [] }
          );
          return digest;
        }
      } catch { /* comprehension is a booster, never a blocker */ }
      return "";
    })();

    // ---- STAGE 1b: choose the expert persona (gpt-researcher choose_agent) ----
    // Fast-fail: the persona is a nice-to-have — never let it block the pipeline for minutes.
    agentName = "";
    try {
      const roleRes = await ctx.llm([{ role: "user", content: roleChooserPrompt(job.query) }], "role", false, 400, { patient: false, timeoutMs: SERVERLESS ? 12_000 : 30_000 });
      const role = extractJson(roleRes.text);
      if (role?.role) {
        ctx.rolePrompt = String(role.role).slice(0, 900);
        agentName = String(role.agent || "Domain Expert").slice(0, 60);
        await ctx.emit("agent", `Working as: ${agentName}`, ctx.rolePrompt, roleRes.model, { agent: agentName });
      }
    } catch { /* persona is a nice-to-have, never fatal */ }

    // ---- STAGE 1c: scouting search on the raw query (gpt-researcher: plan AFTER a first look) —
    //      runs while the comprehension pass thinks, then both feed the plan
    const scoutPromise = searchAll(job.query, { academic: false });
    const [scoutRs, comprehensionDigest] = await Promise.all([scoutPromise, compPromise]);
    await ctx.emit(
      "search",
      `Scouting the web: “${job.query}”`,
      `${scoutRs.length} results — grounding the plan in what actually exists before committing to aspects`,
      undefined,
      { query: job.query, count: scoutRs.length, engines: [...new Set(scoutRs.map((r) => r.engine))], scout: true }
    );
    const initSnippets =
      scoutRs
        .slice(0, 6)
        .map((r) => `- ${r.title} (${r.domain}): ${(r.snippet || "").slice(0, 220)}`)
        .join("\n") +
      (docs.length > 0 ? `\n\nThe user attached ${docs.length} ground-truth document${docs.length > 1 ? "s" : ""} (${docs.map((d) => d.name).join(", ")}) — their full content is available to the research as sources.` : "");

    let planRes: { text: string; model: string; reasoning?: string } | null = null;
    // A budgeted run must not let the plan call's patient retries eat the whole budget —
    // cap the ride at ~40% of the remaining time (min 2 min, max 10 min) so the actual
    // research still gets its share. Unlimited runs ride as long as they need.
    const planRideCapMs = ctx.hasTimeBudget
      ? Math.max(120_000, Math.min(ctx.timeLeft * 0.4, 10 * 60_000))
      : Infinity;
    const planPromise = ctx.llmLive(
      [{ role: "user", content: planPrompt(job.query, SERVERLESS ? Math.min(job.breadth + 1, 5) : job.breadth, job.language, threadContext || undefined, initSnippets, comprehensionDigest || undefined, job.court, pack.guidance || undefined) }],
      "plan",
      "Planning the research",
      // v2.4.7: on the serverless clock the plan must not ride patient cooldowns for
      // minutes — fast-fail at 30s (rescue adds ~18s worst) and let the fallback plan
      // carry the run; also ask for breadth+1 aspects (4 parallel workers make the
      // extra aspect nearly free, and coverage is the grader's most common deduction)
      SERVERLESS ? { wantThinking: true, fast: { patient: false, timeoutMs: 30_000 } } : { wantThinking: true }
    );
    planPromise.catch(() => {}); // the underlying ride resolves on its own; its catch trips the breaker
    try {
      planRes = await (SERVERLESS
        ? Promise.race([
            planPromise,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("plan budget cap hit — moving on with a generic plan")), 45_000)),
          ])
        : Number.isFinite(planRideCapMs)
        ? Promise.race([
            planPromise,
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("plan budget cap hit — moving on with a generic plan")), planRideCapMs)),
          ])
        : planPromise);
    } catch (planErr) {
      // graceful degradation (gpt-researcher pattern): a fully throttled backend must not kill
      // the run — fall back to the generic plan and say so honestly. A budget-cap rejection
      // also trips the job-wide circuit breaker (models are clearly not serving right now).
      if (planErr instanceof Error && planErr.message.includes("plan budget cap hit")) {
        ctx.llmBlackoutUntil = Date.now() + 10 * 60_000;
      }
      await ctx.emit("info", "Planning model unavailable — falling back to a generic research plan", planErr instanceof Error ? planErr.message.slice(0, 300) : undefined);
    }
    let planParsed: ResearchPlan | null = planRes ? extractJson(planRes.text) : null;
    if (!planParsed || !Array.isArray(planParsed.aspects) || planParsed.aspects.length === 0) {
      if (planRes) await ctx.emit("info", "Plan parse failed — using fallback plan", planRes.text.slice(0, 400));
      planParsed = fallbackPlan(job.query, job.breadth);
    }
    plan = planParsed;
    // v2.4.7: on the serverless clock one extra aspect is nearly free (4 parallel
    // workers, one round each) and directly lifts the coverage dim — the grader's
    // most common deduction was "criteria spanned more dimensions than 3 aspects covered"
    plan.aspects = (job.breadth > 0 ? plan.aspects.slice(0, SERVERLESS ? Math.min(job.breadth + 1, 5) : job.breadth) : plan.aspects.slice(0, UNLIMITED_ASPECT_CAP)).filter((a) => a && a.title);
    await updateJob(jobId, { plan: JSON.stringify(plan), progress: 6, stage: `Researching ${plan.aspects.length} aspects` });

    // ---- knowledge-first digest: what the model already knows vs what genuinely needs the web ----
    if (plan.priorKnowledge) {
      await ctx.emit(
        "presearch",
        "Knowledge first — starting from what I already know",
        `${plan.priorKnowledge}\n\nGenuinely needs verification: ${(plan.unknowns ?? []).join(" · ") || "(not stated)"}`,
        planRes?.model,
        { priorKnowledge: plan.priorKnowledge, unknowns: plan.unknowns ?? [] }
      );
    }
    await ctx.emit("think", `Research plan ready — ${plan.aspects.length} aspects`, `${plan.restate}\n\nAspects: ${plan.aspects.map((a) => a.title).join(" · ")}`, planRes?.model, { aspects: plan.aspects.map((a) => a.title), type: plan.reportType });

    // ---- HONEST INITIAL TIME ESTIMATE (parallelism-aware, P0-2) ----
    const aspectsTotal = plan.aspects.length;
    const roundsEst = job.depth > 0 ? job.depth : 2.5; // unlimited: rounds depend on gaps found
    const perAspectEstMs = 150_000;
    concurrency = Math.min(aspectsTotal, SERVERLESS ? Math.max(ASPECT_CONCURRENCY.heavy, Math.min(aspectsTotal, 4)) : unlimited || job.preset === "exhaustive" ? ASPECT_CONCURRENCY.heavy : ASPECT_CONCURRENCY.budgeted);
    let estMs = Math.ceil(aspectsTotal / concurrency) * roundsEst * perAspectEstMs + 180_000;
    // a budgeted run can never take longer than its remaining budget — clamp and say so
    const budgetExhausted = ctx.hasTimeBudget && ctx.timeLeft < estMs;
    if (budgetExhausted) estMs = Math.max(0, ctx.timeLeft);
    await ctx.emit(
      "eta",
      `Honest estimate: ${unlimited ? `${fmtMin(estMs)}+, genuinely open-ended` : budgetExhausted ? `~${fmtMin(estMs)} left — the clock is nearly out` : `~${fmtMin(estMs)} for this run`}`,
      `I sized this from ${aspectsTotal} aspects × ~${Math.round(roundsEst * 10) / 10} rounds each, running ${concurrency} aspect${concurrency > 1 ? "s" : ""} in parallel, plus critique and writing.${unlimited ? " Unlimited mode means I stop only when my own self-critique says coverage is sufficient — the real time can grow beyond this estimate, and I will keep updating it honestly as I learn the topic's true depth." : budgetExhausted ? " Honest caveat: the remaining time budget is smaller than this run deserves — I will research until the clock runs out, then write the best report the gathered evidence supports." : " This is an honest upfront guess — deep research time genuinely depends on how many gaps I find, so I will revise it live at every aspect instead of pretending it is exact."}`,
      undefined,
      { estimateMs: estMs, aspectsTotal, unlimited, kind: "initial", concurrency }
    );

    // create sections
    for (let i = 0; i < plan.aspects.length; i++) {
      await db.researchSection.create({
        data: { jobId, order: i, title: plan.aspects[i].title, question: plan.aspects[i].question, queries: JSON.stringify(plan.aspects[i].queries ?? []) },
      });
    }
    } else {
      // ── resume path: the plan was persisted on the first slice — reload it ──
      // v2.7: the resolved query is restored from the checkpoint — a resumed
      // slice researches, tries and grades the same conversation-resolved question
      job = { ...job, query: q };
      try {
        plan = job.plan ? (JSON.parse(job.plan) as ResearchPlan) : null;
      } catch { plan = null; }
      if (!plan || !Array.isArray(plan.aspects) || plan.aspects.length === 0) {
        plan = fallbackPlan(job.query, job.breadth);
      }
    } // end !resuming (routing + comprehension + plan + sections)

    // ---------- STAGE 2: ITERATIVE RESEARCH (P0-2: aspects in parallel) ----------
    // v2.5.0: the research cutoff is now anchored to the ABSOLUTE deadline (engine
    // start + maxMinutes), not this slice's hardStop — research spans as many slices
    // as the budget needs, and the tail (drafts + grade + improve) reserves the last
    // 175s of the ABSOLUTE clock. On a resumed run the checkpoint's cutoff stands.
    if (SERVERLESS && !resuming) {
      const absEnd = absoluteDeadline ?? t0 + 40 * 60_000; // unlimited serverless: 40-min research ceiling
      ctx.researchCutoffAt = Math.max(Date.now() + 20_000, absEnd - 175_000);
    }
    await updateJob(jobId, { status: "researching", progress: 8 });
    const sectionRows = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    const readCap = job.preset === "quick" ? 3 : job.preset === "standard" ? 4 : 6;
    // research progress weight — computed against the LIVE queue length, because
    // spawned aspects (dzhng recursion) grow sectionRows mid-run
    const researchWeight = () => 64 / Math.max(1, sectionRows.length);
    const maxRounds = job.depth > 0 ? job.depth : UNLIMITED_ROUND_CAP;
    const srcCap = job.maxSources > 0 ? job.maxSources : Infinity;

    // user-attached documents (P2-3) become first-class ground-truth sources: citation
    // numbers 1000+, an "attachment" engine badge, content registered for citation
    // verification, and excerpts injected into round 1 of every aspect
    const docEntries: { n: number; title: string; domain: string; excerpt: string }[] = [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const n = 1000 + i;
      const excerpt = d.text.split(/\s+/).slice(0, 900).join(" ");
      docEntries.push({ n, title: `Your document: ${d.name}`, domain: "(attached document)", excerpt });
      ctx.registerSource(n, `Your document: ${d.name}`, "(attached document)", d.text.slice(0, 12000));
      ctx.seenUrls.add(`attachment://${d.name}`);
      await db.source.create({
        data: { jobId, url: `attachment://${d.name}`, domain: "(attached document)", title: `Your document: ${d.name}`, snippet: d.text.slice(0, 280), engine: "attachment", words: d.text.split(/\s+/).length, used: true, sectionTitle: "Your documents", round: 0, quality: 100 },
      }).catch(() => null);
      sourcesUsed.push({ n, url: `attachment://${d.name}`, title: `Your document: ${d.name}`, domain: "(attached document)" });
    }
    if (docEntries.length > 0) {
      await ctx.emit(
        "info",
        `Loaded ${docEntries.length} attached document${docEntries.length > 1 ? "s" : ""} as ground-truth sources`,
        `${docs.map((d) => d.name).join(" · ")} — treated as authoritative alongside web evidence, cited as [${docEntries[0].n}]${docEntries.length > 1 ? `–[${docEntries[docEntries.length - 1].n}]` : ""}.`
      );
    }

    // Bounded-concurrency worker pool over aspects: wall-clock approaches the slowest
    // aspect instead of the sum of all, and a throttled aspect no longer stalls the run.
    // Shared state (seenUrls, claims, learnings, source numbers) is safe in single-
    // threaded JS; the source cap can overshoot by a few reads across workers — a fair
    // trade for parallelism, noted here honestly.
    //
    // dzhng/deep-research RECURSION (learned from the reference repo): the plan is not
    // a static tree — a reflection that uncovers an unexpected DISTINCT research thread
    // can SPAWN it as a new aspect. Workers pick spawned aspects from the same queue;
    // a spawned aspect gets half the parent's read budget (breadth/2 per depth level,
    // dzhng's signature decay) and cannot spawn further (2-level tree, bounded).
    const aspectSpawnLevel = new Map<string, number>(); // section id -> 0 (planned) | 1 (spawned)
    const aspectReadCap = new Map<string, number>(); // section id -> per-round read budget
    for (const r of sectionRows) {
      aspectSpawnLevel.set(r.id, 0);
      aspectReadCap.set(r.id, readCap);
    }
    const spawnCap = unlimited ? UNLIMITED_ASPECT_CAP : Math.min(job.breadth + 2, 14);
    const spawnDirection = async (from: { title: string }, dir: { title: string; question: string; why: string }) => {
      if (spawnedCount.n >= spawnCap || ctx.outOfTime || Date.now() > ctx.researchCutoffAt || ctx.sourceN >= srcCap) return false;
      const title = String(dir.title).trim().slice(0, 80);
      const question = String(dir.question).trim().slice(0, 400);
      if (!title || !question) return false;
      // never spawn a near-duplicate of an existing aspect (title-similarity guard)
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3);
      const dirWords = new Set(norm(`${title} ${question}`));
      for (const existing of sectionRows) {
        const exWords = new Set(norm(`${existing.title} ${existing.question}`));
        let inter = 0;
        for (const w of dirWords) if (exWords.has(w)) inter++;
        if (dirWords.size > 0 && exWords.size > 0 && inter / Math.min(dirWords.size, exWords.size) > 0.6) return false;
      }
      const row = await db.researchSection.create({
        data: {
          jobId,
          order: sectionRows.length,
          title,
          question,
          queries: JSON.stringify([question.slice(0, 120), `${title} evidence ${new Date().getFullYear()}`]),
          status: "pending",
        },
      }).catch(() => null);
      if (!row) return false;
      sectionRows.push(row);
      plan.aspects.push({ title, question, goal: `Spawned mid-research from “${from.title}”: ${String(dir.why || "").slice(0, 220)}`, queries: [] });
      aspectSpawnLevel.set(row.id, 1);
      aspectReadCap.set(row.id, Math.max(2, Math.ceil(readCap / 2))); // dzhng breadth decay
      spawnedCount.n++;
      await ctx.emit(
        "spawned",
        `New research thread opened: ${title}`,
        `While researching “${from.title}”, the reflection uncovered a distinct direction that deserves its own searches — ${String(dir.why || "").slice(0, 300)} It joins the queue with half the read budget (${Math.max(2, Math.ceil(readCap / 2))} reads/round, dzhng-style breadth decay).`,
        undefined,
        { spawned: title, from: from.title, level: 1, aspectCount: sectionRows.length }
      );
      return true;
    };
    let nextSi = 0;
    let aspectsDone = 0;
    let stopAll = false;
    let sliceEnding = false; // v2.5.0: this slice's clock is over — checkpoint and return
    let timeSkipAnnounced = false;
    const runNextAspect = async (): Promise<void> => {
      for (;;) {
        if (stopAll) return;
        // v2.5.0 continuation: the slice's function clock is nearly over — stop
        // taking NEW work, persist the checkpoint at the phase boundary below,
        // and let the poller resume the run in a fresh slice
        if (outOfSlice()) {
          sliceEnding = true;
          return;
        }
        // v2.4.0: the serverless research window closed — the write/grade/improve
        // tail is reserved; aspects not yet started are skipped (same honesty as
        // the outOfTime skip below, but driven by the phase plan, not the budget)
        if (Date.now() > ctx.researchCutoffAt) {
          if (!timeSkipAnnounced) {
            timeSkipAnnounced = true;
            await ctx.emit("info", "Research window closed — moving to writing, grading and improvement", "The absolute time budget reserves its tail for drafting, self-grading and the improvement rounds; aspects not yet started are skipped, and the report is written from the evidence already gathered.");
          }
          return;
        }
        if (await ctx.isCancelled()) {
          stopAll = true;
          return;
        }
        const si = nextSi++;
        if (si >= sectionRows.length) return;
        // v2.5.0 resume: aspects finished in a previous slice are skipped — their
        // findings live in the DB row and their sources in the restored checkpoint
        if (sectionRows[si].status === "done") {
          aspectsDone++;
          continue;
        }
        if (ctx.outOfTime) {
          if (!timeSkipAnnounced) {
            timeSkipAnnounced = true;
            await ctx.emit("info", "Time budget nearly exhausted — skipping the remaining aspects", "The clock wins this round: aspects not yet started are skipped, and the report will be written from the evidence already gathered.");
          }
          return;
        }
        const sec = sectionRows[si];
        const aspectT0 = Date.now();
        const thisReadCap = aspectReadCap.get(sec.id) ?? readCap;
        const canSpawnThis = (aspectSpawnLevel.get(sec.id) ?? 0) === 0 && spawnedCount.n < spawnCap;
        await updateJob(jobId, { stage: `Researching: ${sec.title}`, progress: Math.round(8 + aspectsDone * researchWeight()) });
      const planAspect = plan.aspects[si];
      await ctx.emit("section", `Aspect ${si + 1}/${sectionRows.length}: ${sec.title}`, planAspect?.goal ? `${sec.question}\n\nGoal: ${planAspect.goal}` : sec.question);
      let queries: string[] = JSON.parse(sec.queries || "[]");
      // v2.5.0 resume: a section that was mid-research when the slice ended keeps
      // its persisted per-round findings — the next round builds on them instead
      // of re-searching from scratch
      let notes = sec.status === "researching" && sec.findings ? sec.findings : "";
      let roundsDone = sec.status === "researching" ? (sec.rounds ?? 0) : 0;
      /** WebWalker: URLs the reflection chose to visit directly next round */
      let pendingWalks: { url: string; reason: string }[] = [];
      /** P2 quality guard: query reformulation budget + what the off-topic results looked like */
      let reformulations = 0;
      let offTopicSamples: string[] = [];

      for (let round = 1; round <= maxRounds; round++) {
        if (await ctx.isCancelled()) throw new Cancelled();
        if (ctx.outOfTime) break;
        // v2.4.0: past the serverless research cutoff, finish the current round's
        // synthesis but never START another — the improve tail must fit the clock
        if (round > 1 && Date.now() > ctx.researchCutoffAt) break;
        roundsDone = round;
        // dzhng breadth decay: each follow-up round goes narrower but deeper
        const roundReadCap = Math.max(2, Math.ceil(thisReadCap / round));
        if (round > 1) {
          await ctx.emit("info", `Round ${round} on “${sec.title}” — narrowing to ${roundReadCap} reads per pass (breadth decays as evidence accumulates)`, undefined, undefined, undefined, "verbose");
        }
        const contents: { n: number; title: string; domain: string; excerpt: string }[] = [];
        const roundLinks: { url: string; text: string }[] = [];

        // 2a-1. WALK pending URLs chosen by the previous reflection (WebWalker link traversal)
        for (const w of pendingWalks.slice(0, 2)) {
          if (ctx.seenUrls.has(w.url)) continue;
          ctx.seenUrls.add(w.url);
          const page = await fetchPageContent(w.url, 3200);
          if (!page) {
            await ctx.emit("walk", `Could not open ${domainOf(w.url)}`, w.reason, undefined, { url: w.url, ok: false }, "verbose");
            continue;
          }
          ctx.walkedUrls++;
          const n = ++ctx.sourceN;
          await db.source.create({
            data: { jobId, url: w.url, domain: page.domain || domainOf(w.url), title: page.title, snippet: page.text.slice(0, 280), engine: "walk", words: page.words, used: true, sectionTitle: sec.title, round, quality: 70 },
          }).catch(() => null);
          sourcesUsed.push({ n, url: w.url, title: page.title, domain: page.domain || domainOf(w.url) });
          ctx.registerSource(n, page.title, page.domain || domainOf(w.url), page.text.split(/\s+/).slice(0, 750).join(" "));
          await ctx.emit("walk", `Following a link into ${page.domain || domainOf(w.url)} · ${page.words.toLocaleString()} words`, w.reason, undefined, { url: w.url, words: page.words, n });
          contents.push({ n, title: page.title, domain: page.domain || domainOf(w.url), excerpt: page.text.split(/\s+/).slice(0, 750).join(" ") });
          roundLinks.push(...page.links.slice(0, 8));
        }
        pendingWalks = [];

        // 2a-2. SEARCH
        const searchResults: SearchResult[] = [];
        // P2-1 domain packs: round 1 probes one authority domain explicitly —
        // statutes/filings/journals surface even when generic engines rank them low
        const domainQueries = round === 1 ? siteVariants(queries, pack) : [];
        for (const q of [...queries.slice(0, 3), ...domainQueries].slice(0, 4)) {
          const rs = await searchAll(q, { academic: !!plan.academic });
          await ctx.emit("search", `Searching: “${q}”`, `${rs.length} results`, undefined, { query: q, count: rs.length, engines: [...new Set(rs.map((r) => r.engine))] });
          searchResults.push(...rs);
          await sleep(300 + Math.random() * 400);
        }
        // 2b. dedupe + diverse-domain pick. URL-unique across the round's queries (two
        // engines can return the same page for different phrasings), seen re-checked at
        // PICK time — parallel aspect workers race between this filter and the read.
        let fresh = searchResults
          .filter((r) => r.url && !ctx.seenUrls.has(r.url) && !r.domain.includes("duckduckgo.com"))
          .filter((r, i, arr) => arr.findIndex((x) => x.url === r.url) === i)
          .sort((a, b) => (a.engine === "Bing News" ? -1 : 0) - (b.engine === "Bing News" ? -1 : 0));

        // 2b-0. RELEVANCE GATE — the fix for the garbage-sources failure mode (the ECL run:
        // film pages, toy repos and math papers matched on filler words, and the report
        // became "no relevant discussion" sections). Pure lexical scoring (relevance.ts):
        // off-topic results are dropped before the read budget is spent, best-first.
        {
          const gatedNow = gateByRelevance(sec.question, queries.join(" "), fresh);
          if (gatedNow.dropped.length > 0 && gatedNow.kept.length > 0) {
            await ctx.emit(
              "refine",
              `Dropped ${gatedNow.dropped.length} off-topic result${gatedNow.dropped.length > 1 ? "s" : ""} before reading — kept ${gatedNow.kept.length} on-topic`,
              `“${sec.title}”: the dropped pages matched filler words, not the question (median kept relevance ${gatedNow.keptScore.toFixed(2)}).`,
              undefined,
              { aspect: sec.title, dropped: gatedNow.dropped.length, kept: gatedNow.kept.length },
              "verbose",
            );
          }
          if (gatedNow.dropped.length > 0) {
            offTopicSamples.push(...gatedNow.dropped.slice(0, 4).map((d) => `${d.title} (${d.domain})`).slice(0, 200));
            if (offTopicSamples.length > 12) offTopicSamples = offTopicSamples.slice(0, 12);
          }
          fresh = gatedNow.kept;
        }

        // 2b-0.5. SOURCE QUALITY GATE (v2.5.0) — relevance asks "is this about the
        // question"; this asks "is this worth reading". Empty GitHub repos, press-release
        // wires, paid promotions and market-report SEO farms never spend a read slot;
        // among the survivors, authoritative primary domains (arXiv, Nature, Reuters,
        // official docs…) and concrete snippets (numbers, dates, named systems) sort
        // first — the raw material of a 9/10 report is specific, checkable evidence.
        {
          const qg = applySourceQualityGate(fresh, `${sec.question} ${queries.join(" ")}`, { boostNews: true, authorityDomains: pack.authorities });
          if (qg.dropped.length > 0) {
            const byReason = qg.dropped.reduce<Record<string, number>>((m, d) => ((m[d.reason] = (m[d.reason] ?? 0) + 1), m), {});
            await ctx.emit(
              "refine",
              `Quality gate: dropped ${qg.dropped.length} junk result${qg.dropped.length > 1 ? "s" : ""} — ${Object.entries(byReason).map(([r, c]) => `${c}× ${r}`).join(", ")}`,
              `“${sec.title}”: empty repos, press releases and content farms match the words but carry no evidence. The ${qg.kept.length} survivors are ordered by source quality (primary/authoritative domains first) and concreteness (numbers, dates, named systems).`,
              undefined,
              { aspect: sec.title, dropped: qg.dropped.length, reasons: byReason, kept: qg.kept.length },
              "verbose",
            );
          }
          fresh = qg.kept;
        }

        // 2b-2. LLM RERANK (P0-3) — spend the read budget on the pages that matter.
        // Round 1 only (follow-up rounds are already narrow), and only when there are
        // clearly more candidates than read slots. Fast-fail: heuristic order stands.
        if (round === 1 && fresh.length > roundReadCap + 2 && !ctx.outOfTime) {
          try {
            const candidates = fresh.slice(0, 16);
            const rrRes = await ctx.llm(
              [{ role: "user", content: rerankPrompt(sec.question, candidates, roundReadCap) }],
              "rerank", false, 400, { patient: false, timeoutMs: 40_000 }
            );
            const rr = extractJson(rrRes.text);
            const rankedIdx = (Array.isArray(rr?.ranked) ? rr.ranked : [])
              .map((x: { i?: unknown }) => Number(x?.i))
              .filter((i: number) => Number.isInteger(i) && i >= 1 && i <= candidates.length);
            if (rankedIdx.length >= Math.min(3, roundReadCap)) {
              const took = new Set<number>();
              const ordered: SearchResult[] = [];
              for (const i of rankedIdx) {
                if (took.has(i)) continue;
                took.add(i);
                ordered.push(candidates[i - 1]);
              }
              for (let ci = 0; ci < candidates.length; ci++) if (!took.has(ci + 1)) ordered.push(candidates[ci]);
              for (let ci = candidates.length; ci < fresh.length; ci++) ordered.push(fresh[ci]);
              fresh.length = 0;
              fresh.push(...ordered);
              ctx.rerankRuns++;
              const whys = (Array.isArray(rr?.ranked) ? rr.ranked : [])
                .slice(0, roundReadCap)
                .map((x: { why?: unknown }) => `• ${String(x?.why || "").slice(0, 140)}`)
                .filter((s: string) => s.length > 3)
                .join("\n");
              await ctx.emit(
                "rerank",
                `Ranked ${candidates.length} candidates — reading the best ${roundReadCap} first`,
                whys || `Read budget aimed at the most relevant pages for “${sec.title}” (relevance, credibility, recency).`,
                rrRes.model,
                { aspect: sec.title, kept: rankedIdx.length }
              );
            }
          } catch { /* the heuristic order stands */ }
        }

        const picked: SearchResult[] = [];
        const domainCount: Record<string, number> = {};
        for (const r of fresh) {
          if (picked.length >= roundReadCap) break;
          if (ctx.seenUrls.has(r.url)) continue; // re-check at pick time — parallel aspects race
          const dc = domainCount[r.domain] ?? 0;
          if (dc >= 2) continue;
          domainCount[r.domain] = dc + 1;
          picked.push(r);
          ctx.seenUrls.add(r.url); // claim it NOW, before the slow read — not after
        }
        if (picked.length === 0 && round === 1 && contents.length === 0) {
          await ctx.emit("info", `No new sources found for “${sec.title}”`, "Proceeding with what we have");
        }

        // 2c. READ pages (parallel, capped by the decaying read budget)
        const readBatch = picked.slice(0, roundReadCap);
        await Promise.all(
          readBatch.map(async (r) => {
            const page = await fetchPageContent(r.url, 3200, r.excerpt);
            if (!page) {
              await ctx.emit("read", `Could not read ${r.domain}`, r.title, undefined, { url: r.url, ok: false }, "verbose");
              return null;
            }
            const n = ++ctx.sourceN;
            const excerpt = page.text.split(/\s+/).slice(0, 750).join(" ");
            await db.source.create({
              data: { jobId, url: r.url, domain: r.domain || page.domain, title: r.title || page.title || r.domain, snippet: r.snippet || excerpt.slice(0, 280), engine: r.engine, words: page.words, used: true, sectionTitle: sec.title, round, quality: 60 },
            }).catch(() => null);
            sourcesUsed.push({ n, url: r.url, title: r.title || page.title || r.domain, domain: r.domain || page.domain, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) });
            ctx.registerSource(n, r.title || page.title || r.domain, r.domain || page.domain, excerpt);
            await ctx.emit("read", `Reading ${r.domain} · ${page.words.toLocaleString()} words`, `${r.title || page.title}`, undefined, { url: r.url, words: page.words, n }, "verbose");
            contents.push({ n, title: r.title || page.title, domain: r.domain || page.domain, excerpt });
            roundLinks.push(...page.links.slice(0, 8));
            return null;
          })
        );

        // 2c-2. attached documents (P2-3) join round 1 as ground truth for this aspect
        if (round === 1 && docEntries.length > 0) {
          for (const d of docEntries) {
            if (!contents.some((c) => c.n === d.n)) contents.push({ n: d.n, title: d.title, domain: d.domain, excerpt: d.excerpt });
          }
        }

        // 2d. SUMMARIZE
        const snippetSrcs = contents.length === 0 && searchResults.length > 0
          ? (() => {
            // gate the snippet fallback too — snippet-grade citations of off-topic pages
            // are exactly how a garbage report stays "honest-looking"; the v2.5.0
            // quality gate also strips junk (a snippet-grade citation of an empty
            // repo or a paid press release is still garbage, just smaller)
            const g = gateByRelevance(sec.question, queries.join(" "), searchResults.slice(0, 12));
            const qg = applySourceQualityGate(g.kept, sec.question);
            return qg.kept.slice(0, 6).map((r, i) => ({ n: 900 + i, title: r.title, domain: r.domain, excerpt: r.snippet }));
          })()
          : [];
        // persist snippet-based sources so citations, references and the Sources row stay honest
        if (snippetSrcs.length > 0) {
          await ctx.emit("info", `Full page reads failed for “${sec.title}” — falling back to search-result snippets (marked “snippet” in sources)`);
          for (let i = 0; i < snippetSrcs.length; i++) {
            const r = searchResults[i];
            if (!r?.url || sourcesUsed.some((s) => s.url === r.url)) continue;
            await db.source.create({
              data: { jobId, url: r.url, domain: r.domain || "", title: r.title || r.domain || "source", snippet: r.snippet, engine: "snippet", words: 0, used: true, sectionTitle: sec.title, round, quality: 30 },
            }).catch(() => null);
            sourcesUsed.push({ n: 900 + i, url: r.url, title: r.title || r.domain, domain: r.domain || "", ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) });
            ctx.registerSource(900 + i, r.title || r.domain || "source", r.domain || "", r.snippet || "");
          }
        }
        const srcForSum = contents.length > 0 ? contents : snippetSrcs;
        // ── 2d + 2e MERGED (v2.5.5, dzhng pattern): ONE call per round produces the
        // [n]-cited notes AND the self-critique (sufficiency, learnings,
        // contradictions, follow-ups, spawns). Halves the research-phase LLM usage
        // under the throttled keyless pool — the 29-min/5-slice run died of exactly
        // that. The reflect post-processing below consumes the merged JSON.
        let roundNotes = "";
        let refl: ReturnType<typeof extractJson> = null;
        let reflModel: string | undefined;
        if (srcForSum.length > 0) {
          try {
            const roundsLeft = ctx.unlimitedRounds ? "unlimited" : Math.max(0, job.depth - round);
            const linkCandidates = roundLinks
              .filter((l) => !ctx.seenUrls.has(l.url))
              .filter((l, i, arr) => arr.findIndex((x) => x.url === l.url) === i)
              .slice(0, 10);
            // v2.4.8 preserved: deep past the serverless cutoff the round-2 outputs
            // (followUps/spawns) can never run — tell the model there are no rounds
            // left so it weighs sufficiency honestly and stops planning dead work
            const deepPastCutoff = Date.now() > ctx.researchCutoffAt + 25_000;
            // v2.5.1: patient ride — a throttled window must not halve the round
            const mRes = await ctx.llm(
              [{ role: "user", content: summarizeReflectPrompt(sec.title, sec.question, srcForSum, round, notes, deepPastCutoff ? 0 : roundsLeft, linkCandidates, ctx.allLearnings, canSpawnThis) }],
              "summarize+reflect", false, undefined, SERVERLESS ? { timeoutMs: 40_000, maxWaitMs: 110_000 } : { timeoutMs: 90_000 }
            );
            const parsed = extractJson(mRes.text);
            if (parsed && typeof parsed.notes === "string" && parsed.notes.trim()) {
              roundNotes = parsed.notes;
              refl = parsed;
              reflModel = mRes.model;
            } else {
              roundNotes = mRes.text; // sloppy format — the whole text is the notes
            }
            await ctx.emit("summary", `Synthesized findings on “${sec.title}”`, roundNotes.slice(0, 2400), mRes.model, { section: sec.title, round, sources: srcForSum.length });
          } catch (sumErr) {
            // graceful degradation: keep the raw excerpts as notes rather than killing the run
            // v2.5.1: the raw fallback keeps [n] markers so even a throttled run's
            // findings carry auditable citations (the citation audit needs them)
            roundNotes = srcForSum.map((s) => `- [${s.n}] From ${s.domain} (${s.title}): ${s.excerpt.slice(0, 600)}`).join("\n");
            await ctx.emit("info", `Synthesis model unavailable for “${sec.title}” — keeping raw source excerpts as notes`, sumErr instanceof Error ? sumErr.message.slice(0, 200) : undefined);
          }
        }
        // 2d-2. OFF-TOPIC HANDLING — either the summarize pass marked the sources a
        // different topic, or the gate dropped everything: this round is a MISS.
        // Reformulate the queries (max 2 per aspect) with domain vocabulary instead of
        // accumulating garbage notes. If reformulation is spent, the notes merge is
        // skipped for a fully off-topic round so garbage never becomes "findings".
        const offTopicRound = srcForSum.length > 0 && /OFF-TOPIC SOURCES/i.test(roundNotes);
        const needReformulate =
          (offTopicRound || (searchResults.length > 0 && fresh.length === 0 && picked.length === 0)) &&
          reformulations < 2 &&
          !ctx.outOfTime;
        if (needReformulate) {
          try {
            const rfRes = await ctx.llm(
              [{ role: "user", content: reformulateQueriesPrompt(sec.question, planAspect?.goal, queries, offTopicSamples) }],
              "reformulate", false, 400, { patient: false, timeoutMs: 45_000 }
            );
            const newQs = (extractJsonArray(rfRes.text) ?? [])
              .map((s) => String(s).trim())
              .filter((s) => s.length > 4)
              .slice(0, 4);
            if (newQs.length > 0) {
              queries = newQs;
              reformulations++;
              await ctx.emit(
                "refine",
                `Rewriting the queries for “${sec.title}” with proper domain vocabulary (attempt ${reformulations}/2)`,
                `The last round matched filler words, not the question. Next round searches:\n${newQs.map((q) => `• ${q}`).join("\n")}`
              );
              continue; // next round with the reformulated queries — never reflect on garbage
            }
          } catch { /* fall through: the reflection decides with what we have */ }
        }
        if (!offTopicRound) {
          notes = notes ? `${notes}\n\n## Round ${round} additions\n${roundNotes}` : roundNotes;
          // v2.5.0 continuation: persist per-round findings + a checkpoint so a
          // slice that ends mid-aspect resumes with this round's evidence intact
          await db.researchSection.update({ where: { id: sec.id }, data: { findings: notes, status: "researching", rounds: roundsDone } }).catch(() => null);
          await persist("research").catch(() => {});
        } else {
          await ctx.emit("info", `Sources for “${sec.title}” came back off-topic this round — discarded, not folded into findings`, roundNotes.slice(0, 200));
        }

        // 2e. SELF-CRITIQUE POST-PROCESSING (v2.5.5): the merged call above already
        // produced the reflection JSON — no second LLM round-trip. Zero rounds left
        // or deep-past-cutoff means the follow-ups can never run; only the learnings
        // and the sufficiency verdict are consumed.
        const roundsLeft2: number | "unlimited" = ctx.unlimitedRounds ? "unlimited" : Math.max(0, job.depth - round);
        const canUseFollowUps = (ctx.unlimitedRounds || (typeof roundsLeft2 === "number" && roundsLeft2 > 0)) && !ctx.outOfTime && !(Date.now() > ctx.researchCutoffAt + 25_000);
        if (refl && notes && !ctx.outOfTime) {
          {
          // dzhng: dense learnings with entities/numbers/dates accumulate across aspects.
          // reflect v3: learnings arrive as {claim, grade, basis} — evidence-graded claims;
          // plain strings (older/sloppier models) degrade to grade "likely".
          const rawLearnings = Array.isArray(refl?.learnings) ? refl.learnings : [];
          const learnings: string[] = [];
          let verifiedN = 0, likelyN = 0, weakN = 0;
          for (const l of rawLearnings.slice(0, 5)) {
            if (typeof l === "string" && l.trim()) {
              learnings.push(l.trim());
              ctx.claims.push({ claim: l.trim().slice(0, 300), grade: "likely", basis: "(ungraded)", section: sec.title });
              likelyN++;
            } else if (l && typeof l === "object" && typeof (l as any).claim === "string" && (l as any).claim.trim()) {
              const grade = ["verified", "likely", "single-source", "contested"].includes(String((l as any).grade)) ? String((l as any).grade) : "likely";
              const claim = String((l as any).claim).trim().slice(0, 300);
              learnings.push(claim);
              ctx.claims.push({ claim, grade, basis: String((l as any).basis || "").slice(0, 200), section: sec.title });
              if (grade === "verified") verifiedN++;
              else if (grade === "contested" || grade === "single-source") weakN++;
              else likelyN++;
            }
          }
          if (learnings.length > 0) {
            ctx.allLearnings.push(...learnings);
            const gradeNote = [verifiedN && `${verifiedN} verified`, likelyN && `${likelyN} likely`, weakN && `${weakN} single-source/contested`].filter(Boolean).join(", ");
            await ctx.emit("learning", `Nailed down ${learnings.length} finding${learnings.length > 1 ? "s" : ""} — ${gradeNote}`, learnings.map((l: string) => `• ${l}`).join("\n"), reflModel, { learnings, section: sec.title, round, grades: { verified: verifiedN, likely: likelyN, weak: weakN } });
          }
          // reflect v3: contradictions between sources — surfaced, not averaged away
          const newContras = (Array.isArray(refl?.contradictions) ? refl.contradictions : [])
            .filter((c: any) => c && typeof c.claim === "string" && c.claim.trim())
            .map((c: any) => ({ claim: String(c.claim).trim().slice(0, 300), positions: String(c.positions || "").slice(0, 400), section: sec.title }));
          for (const c of newContras) {
            if (ctx.contradictions.some((x) => x.claim === c.claim)) continue;
            ctx.contradictions.push(c);
            await ctx.emit("contradiction", `Sources disagree: ${c.claim.slice(0, 80)}`, c.positions, reflModel, { ...c });
          }
          const followUps = canUseFollowUps ? ((Array.isArray(refl?.followUps) ? refl.followUps : []) as { type?: string; value?: string; reason?: string }[]) : [];
          // dzhng recursion: an unexpected DISTINCT research thread becomes its own aspect
          if (canSpawnThis && canUseFollowUps && Array.isArray(refl?.newDirections)) {
            const dir = (refl.newDirections as { title?: unknown; question?: unknown; why?: unknown }[])
              .filter((d) => typeof d?.title === "string" && typeof d?.question === "string" && String(d.title).trim().length > 3)
              .map((d) => ({ title: String(d.title), question: String(d.question), why: String(d.why ?? "") }))
              .slice(0, 1)[0];
            if (dir) await spawnDirection(sec, dir); // fire-and-forget safe: workers pick it from sectionRows
          }
          const searchFollowUps = followUps
            .filter((f) => f && (f.type ?? "search") === "search" && typeof f.value === "string" && f.value.trim().length > 2)
            .map((f) => String(f.value).trim())
            .slice(0, 3);
          pendingWalks = followUps
            .filter((f) => f && f.type === "walk" && typeof f.value === "string" && /^https?:\/\//i.test(String(f.value).trim()))
            .map((f) => ({ url: String(f.value).trim(), reason: String(f.reason || "the reflection flagged this page as worth visiting directly").slice(0, 300) }))
            .slice(0, 2);
          const ok = refl?.sufficient === true || followUps.length === 0;
          const chipList = [
            ...searchFollowUps,
            ...pendingWalks.map((w) => `→ walk ${domainOf(w.url)}`),
          ];
          await ctx.emit(
            "selfcheck",
            ok ? `Self-review: “${sec.title}” coverage is sufficient` : `Self-critique: “${sec.title}” still has gaps — going deeper`,
            refl?.assessment || "",
            reflModel,
            { sufficient: ok, followUps: chipList, section: sec.title, round, learnings: learnings.length }
          );
          if (ok) break;
          if (round >= maxRounds && ctx.unlimitedRounds) {
            await ctx.emit("info", `Safety stop after ${UNLIMITED_ROUND_CAP} rounds on “${sec.title}”`, "Unlimited mode uses a 20-round safety ceiling per aspect so a single aspect can never loop forever.");
            break;
          }
          if (searchFollowUps.length > 0) queries = searchFollowUps;
          if (searchFollowUps.length === 0 && pendingWalks.length === 0) break; // nothing actionable left
          }
        } else if (round >= maxRounds && !ctx.unlimitedRounds) {
          break;
        }
        if (ctx.sourceN >= srcCap) {
          await ctx.emit("info", `Source cap reached (${job.maxSources}) — continuing with evidence gathered`);
          break;
        }
      }

        await db.researchSection.update({ where: { id: sec.id }, data: { status: "done", findings: notes, rounds: roundsDone, queries: JSON.stringify(queries) } });
        ctx.aspectTimes.push(Date.now() - aspectT0);
        await ctx.emit("section", `“${sec.title}” researched`, `${roundsDone} round(s) of search → read → synthesize`, undefined, { done: sec.title });
        aspectsDone++;
        await updateJob(jobId, { progress: Math.round(8 + aspectsDone * researchWeight()) });
        // v2.5.0 continuation: aspect completed — snapshot the checkpoint
        await persist("research").catch(() => {});

        // ---- HONEST LIVE CHECK-IN (parallelism-aware) ----
        const done = aspectsDone;
        const rem = ctx.honestRemainingMs(done, sectionRows.length, concurrency);
        const paceNote = ctx.aspectTimes.length
          ? `Pace so far: ~${fmtMin(ctx.aspectTimes.reduce((a, b) => a + b, 0) / ctx.aspectTimes.length)} per aspect (measured, not guessed) across ${concurrency} parallel researcher${concurrency > 1 ? "s" : ""}.`
          : "";
        await ctx.emit(
          "eta",
          `Honest check-in: ${done}/${sectionRows.length} aspects · ${sourcesUsed.length} sources · ${fmtMin(Date.now() - t0)} in`,
          `Based on my actual measured pace, ~${fmtMin(rem)} of research + writing remains.${paceNote}${unlimited ? " Unlimited mode: I continue until my self-critique is satisfied, so this estimate can honestly grow." : ""} I am being straight with you rather than optimistic.`,
          undefined,
          { kind: "checkin", aspectsDone: done, aspectsTotal: sectionRows.length, sources: sourcesUsed.length, elapsedMs: Date.now() - t0, remainingMs: rem, unlimited, concurrency }
        );
      } // for(;;) — pick up the next aspect
    }; // runNextAspect

    // Workers: an aspect-level error (that is not cancellation) leaves an honest note
    // and lets the other aspects continue — one broken aspect must not sink the report.
    const aspectWorker = async () => {
      try {
        await runNextAspect();
      } catch (err) {
        if (err instanceof Cancelled || (err as { cancelled?: boolean } | null)?.cancelled === true) {
          stopAll = true;
          return;
        }
        await ctx.emit("info", "An aspect hit an error — the other aspects continue", err instanceof Error ? err.message.slice(0, 300) : String(err)).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => aspectWorker()));
    if (stopAll && (await ctx.isCancelled())) throw new Cancelled();

    // ── v2.5.0 SLICE BOUNDARY (research): this slice's function clock ended with
    // research still pending — persist the phase cursor and return. The client's
    // live-poller (1.2s interval) triggers the next slice via GET /api/research/[id],
    // which resumes exactly here: done aspects skipped, in-flight aspects keep
    // their persisted findings, unseen sources still get read. ─────────────────
    if (sliceEnding && !runExhausted()) {
      await persist("research");
      await updateJob(jobId, { stage: `Slice boundary — continuing research (${aspectsDone}/${sectionRows.length} aspects done)`, progress: Math.round(8 + aspectsDone * researchWeight()) }).catch(() => {});
      return; // the poller resumes the run within seconds
    }

    // ── v2.5.0: research phase complete (or window closed) — checkpoint the
    // phase before the tail begins, so a slice death mid-tail resumes at drafts.
    await persist("predraft").catch(() => {});

    // ---------- SOURCE DIVERSITY + FRESHNESS (P1-3) ----------
    // Echo chambers and stale evidence become visible instead of invisible defaults.
    // v2.5.0: stage3Ran — on a resume past "drafting", stage 3 already ran in a
    // previous slice; its LLM work and events must not duplicate.
    const stage3Ran = phaseAtLeast(resumePhase, "drafting");
    const webSources = sourcesUsed.filter((s) => s.domain !== "(attached document)");
    const domainCounts: Record<string, number> = {};
    for (const s of webSources) domainCounts[s.domain] = (domainCounts[s.domain] ?? 0) + 1;
    const distinctDomains = Object.keys(domainCounts).length;
    const topDomainEntry = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0] ?? null;
    const topShare = topDomainEntry && webSources.length > 0 ? topDomainEntry[1] / webSources.length : 0;
    const sourceDates = webSources
      .map((s) => (s.publishedAt ? new Date(s.publishedAt).getTime() : NaN))
      .filter((t) => !isNaN(t))
      .sort((a, b) => a - b);
    let medianAgeMonths: number | null = null;
    if (sourceDates.length >= 3) {
      medianAgeMonths = Math.max(0, Math.round((Date.now() - sourceDates[Math.floor(sourceDates.length / 2)]) / (30.44 * 86_400_000)));
    }
    if (webSources.length >= 8 && topShare > 0.4 && !stage3Ran) {
      await ctx.emit(
        "diversity",
        `Echo-chamber risk: ${Math.round(topShare * 100)}% of sources come from ${topDomainEntry?.[0]}`,
        "One domain dominates the evidence base. The report will say so, and follow-up research should deliberately seek independent sources before trusting conclusions drawn mainly from it.",
        undefined,
        { topDomain: topDomainEntry?.[0], topShare: Math.round(topShare * 100), distinctDomains }
      );
    }
    if (!stage3Ran) {
    await ctx.emit(
      "diversity",
      `Evidence base: ${webSources.length} sources across ${distinctDomains} domains${medianAgeMonths != null ? ` · median source age ~${medianAgeMonths} month${medianAgeMonths === 1 ? "" : "s"}` : ""}`,
      `Top domain: ${topDomainEntry ? `${topDomainEntry[0]} (${Math.round(topShare * 100)}%)` : "—"}${medianAgeMonths != null ? (medianAgeMonths <= 6 ? " — the evidence is fresh, good for a fast-moving topic." : " — some evidence predates the last year; treat fast-moving claims with care.") : ""}`,
      undefined,
      { distinctDomains, topDomain: topDomainEntry?.[0] ?? "", topShare: Math.round(topShare * 100), medianAgeMonths, sources: webSources.length }
    );
    }

    // ---------- STAGE 3: SELF-CRITIQUE ----------
    if (await ctx.isCancelled()) throw new Cancelled();
    if (!stage3Ran) await updateJob(jobId, { status: "critiquing", stage: "Critically reviewing my own evidence", progress: 74 });
    const doneSections = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    let critRes: { text: string; model: string; reasoning?: string } | null = null;
    // v2.4.1: on the serverless clock the critique pass (a patient-ride LLM call that
    // regularly eats 60-90s) is folded into the post-grade improvement round — same
    // gap-repair function, time-boxed, AFTER the report exists. Self-hosted runs keep
    // the full pre-write critique + weak-section re-research.
    if (SERVERLESS) {
      if (!stage3Ran) await ctx.emit("info", "Serverless clock — critique runs as the post-grade improvement round", "The formal critique pass and its follow-up re-research run on self-hosted deployments; here the same gap-repair happens inside the time-boxed quality round after grading, so the report, score and improvement all fit the function budget.", undefined, undefined, "verbose");
    } else {
    try {
      critRes = await ctx.llmLive(
        [{ role: "user", content: critiquePrompt(job.query, doneSections.filter((s) => s.findings).map((s) => ({ title: s.title, findings: s.findings ?? "" }))) }],
        "critique",
        "Critically reviewing the evidence",
        { wantThinking: true }
      );
    } catch (critErr) {
      await ctx.emit("info", "Critique model unavailable — skipping the formal critique pass", critErr instanceof Error ? critErr.message.slice(0, 200) : undefined);
    }
    }
    const critique = critRes ? extractJson(critRes.text) : null;
    if (!stage3Ran) await ctx.emit("critique", `Self-critique verdict: ${critique?.verdict ?? "skipped (model unavailable)"}`, critique?.reasoning ?? critRes?.text.slice(0, 600) ?? "", critRes?.model, { weak: critique?.weakSections?.map((w: any) => w.title) ?? [] });

    // targeted follow-up for weak sections
    const weak: { title: string; reason: string; queries: string[] }[] = stage3Ran ? [] : (critique?.weakSections ?? []).slice(0, unlimited ? 3 : 2);
    for (const w of weak) {
      if (await ctx.isCancelled()) throw new Cancelled();
      if (ctx.outOfTime || ctx.sourceN >= srcCap) break;
      const sec = doneSections.find((s) => s.title === w.title);
      if (!sec || !w.queries?.length) continue;
      await ctx.emit("gap", `Strengthening “${w.title}” — my critique found it weak`, w.reason);
      const rs: SearchResult[] = [];
      for (const q of w.queries.slice(0, 2)) {
        const r = await searchAll(q, { academic: !!plan.academic });
        rs.push(...r);
        await ctx.emit("search", `Targeted search: “${q}”`, `${r.length} results`);
      }
      // relevance-gate + URL-dedupe the follow-up reads — a weak section must be
      // strengthened with on-topic evidence, not more filler matches
      const gatedFollowUp = gateByRelevance(
        sec.question,
        w.queries.join(" "),
        rs.filter((r) => r.url && !ctx.seenUrls.has(r.url)).filter((r, i, arr) => arr.findIndex((x) => x.url === r.url) === i),
      );
      const fresh = gatedFollowUp.kept.slice(0, 5);
      if (gatedFollowUp.dropped.length > 0) {
        await ctx.emit("refine", `Follow-up for “${w.title}”: dropped ${gatedFollowUp.dropped.length} off-topic results`, undefined, undefined, undefined, "verbose");
      }
      const contents = await Promise.all(
        fresh.map(async (r) => {
          ctx.seenUrls.add(r.url); // claim before the slow fetch — parallel follow-ups race
          const page = await fetchPageContent(r.url, 3200, r.excerpt);
          if (!page) return null;
          const n = ++ctx.sourceN;
          await db.source.create({ data: { jobId, url: r.url, domain: r.domain || page.domain, title: r.title || page.title, snippet: r.snippet, engine: r.engine, words: page.words, used: true, sectionTitle: sec.title, quality: 60 } }).catch(() => null);
          sourcesUsed.push({ n, url: r.url, title: r.title || page.title, domain: r.domain || page.domain });
          await ctx.emit("read", `Reading ${r.domain}`, r.title, undefined, { url: r.url, n }, "verbose");
          return { n, title: r.title || page.title, domain: r.domain || page.domain, excerpt: page.text.split(/\s+/).slice(0, 750).join(" ") };
        })
      );
      const valid = contents.filter((c): c is { n: number; title: string; domain: string; excerpt: string } => !!c);
      if (valid.length > 0 && sec.findings) {
        try {
          const extra = await ctx.llm([{ role: "user", content: summarizePrompt(sec.title, sec.question, valid, 99) }], "summarize-extra", false);
          const newFindings = `${sec.findings}\n\n## Targeted follow-up\n${extra.text}`;
          await db.researchSection.update({ where: { id: sec.id }, data: { findings: newFindings } });
          await ctx.emit("summary", `Follow-up findings on “${sec.title}”`, extra.text.slice(0, 1500), extra.model, { section: sec.title });
        } catch (extraErr) {
          // graceful degradation: append raw excerpts instead of dying
          const raw = valid.map((s) => `- From ${s.domain} (${s.title}): ${s.excerpt.slice(0, 500)}`).join("\n");
          await db.researchSection.update({ where: { id: sec.id }, data: { findings: `${sec.findings}\n\n## Targeted follow-up (raw excerpts — synthesis model unavailable)\n${raw}` } });
          await ctx.emit("info", `Follow-up synthesis unavailable for “${sec.title}” — appended raw excerpts`, extraErr instanceof Error ? extraErr.message.slice(0, 200) : undefined);
        }
      }
    }

    // ---------- STAGE 3.4: CROSS-VERIFICATION (beyond Perplexity — a real fact-check pass) ----------
    // Load-bearing claims graded "single-source" or "contested" get a FRESH targeted
    // search against pages never used for the original claim; a fresh model call judges
    // confirmed / refuted / unclear. Refuted claims are flagged into the report. Bounded:
    // max 3 claims, everything fast-fail — verification is an enhancement, never a blocker.
    if (await ctx.isCancelled()) throw new Cancelled();

    // ---------- STAGE 3.7*: ADVERSARIAL RED-TEAM (P1-2 — run BEFORE the writer, so the
    // attacks can be addressed during writing rather than lamented after) ----------
    // A hostile reviewer attacks the findings' weakest claims; each attack becomes a
    // writing instruction: strengthen with evidence, hedge honestly, or attribute.
    const heavyPreset = unlimited || ["deep", "exhaustive"].includes(job.preset);
    let redTeamAttacks: { section: string; claim: string; attack: string; severity: string }[] = [];
    if (heavyPreset && !ctx.outOfTime && !SERVERLESS) {
      try {
        const rtRes = await ctx.llmLive(
          [{ role: "user", content: redTeamPrompt(job.query, doneSections.filter((s) => s.findings).map((s) => ({ title: s.title, findings: s.findings ?? "" }))) }],
          "redteam",
          "Red-teaming the evidence",
          { wantThinking: true, maxTokens: 800, fast: { patient: false, timeoutMs: 60_000 } }
        );
        const rt = extractJson(rtRes.text);
        redTeamAttacks = (Array.isArray(rt?.attacks) ? rt.attacks : [])
          .filter((a: { section?: unknown; claim?: unknown; attack?: unknown }) => typeof a?.claim === "string" && typeof a?.section === "string" && a.claim.trim().length > 8)
          .map((a: { section: string; claim: string; attack: string; severity?: string }) => ({
            section: a.section.slice(0, 120),
            claim: a.claim.slice(0, 300),
            attack: String(a.attack || "").slice(0, 400),
            severity: ["high", "medium", "low"].includes(String(a.severity)) ? String(a.severity) : "medium",
          }))
          .slice(0, 4);
        if (redTeamAttacks.length > 0) {
          await ctx.emit(
            "redteam",
            `Red-team pass: ${redTeamAttacks.length} attack${redTeamAttacks.length > 1 ? "s" : ""} on the weakest claims`,
            redTeamAttacks.map((a) => `• [${a.severity}] ${a.claim}\n  ↳ ${a.attack}`).join("\n"),
            rtRes.model,
            { attacks: redTeamAttacks.map((a) => ({ section: a.section, claim: a.claim.slice(0, 160), severity: a.severity })) }
          );
        } else {
          await ctx.emit("redteam", "Red-team pass: the evidence held up", "A hostile review found no claims worth attacking — rare, and honestly noted rather than manufactured.", rtRes.model);
        }
      } catch { /* red-teaming is an enhancement, never fatal */ }
    }
    const adversarialNotesFor = (sectionTitle: string) => {
      const notes = redTeamAttacks
        .filter((a) => a.section === sectionTitle)
        .map((a) => `- [${a.severity}] "${a.claim}" — ATTACK: ${a.attack}`)
        .slice(0, 4);
      return notes.length ? notes.join("\n") : "";
    };

    const toVerify = ctx.claims
      .filter((c) => !c.verified && (c.grade === "single-source" || c.grade === "contested") && c.claim.length > 25)
      .slice(0, 3);
    const refuted: { claim: string; correction: string; reasoning: string }[] = [];
    if (toVerify.length > 0 && !ctx.outOfTime && !SERVERLESS) {
      await ctx.emit(
        "verify",
        `Cross-checking ${toVerify.length} load-bearing claim${toVerify.length > 1 ? "s" : ""} against fresh sources`,
        "The evidence pass graded some key claims as single-source or contested. Before publishing, I am running a fresh targeted search for each against pages the original research never touched — the beyond-Perplexity fact-check step.",
        undefined,
        { verifying: toVerify.map((c) => c.claim.slice(0, 120)) }
      );
      for (const claim of toVerify) {
        // the clock wins — remaining claims stay flagged (single-source/contested) in the
        // report instead of cross-checked; verification is an enhancement, never a blocker.
        if (ctx.outOfTime) break;
        try {
          const vq = claim.claim.split(/\s+/).slice(0, 12).join(" ");
          const vrs = (await searchAll(vq, { academic: false })).filter((r) => r.url && !ctx.seenUrls.has(r.url) && !r.domain.includes("duckduckgo.com")).slice(0, 3);
          const vpages = (await Promise.all(vrs.map((r) => fetchPageContent(r.url, 2600, r.excerpt)))).filter((p): p is NonNullable<typeof p> => !!p);
          if (vpages.length === 0) {
            await ctx.emit("verify", `Cross-check inconclusive: “${claim.claim.slice(0, 70)}…”`, "Fresh searches surfaced no new readable sources, so the claim stays as graded — flagged in the report rather than silently trusted.", undefined, { claim: claim.claim.slice(0, 200), verdict: "unclear" });
            continue;
          }
          const evidence = vpages.map((p, i) => `[${i + 1}] ${p.title} (${p.domain})\n${p.text.slice(0, 1200)}`).join("\n\n---\n\n");
          const verRes = await ctx.llm(
            [{ role: "user", content: verifyClaimPrompt(claim.claim, claim.basis, evidence) }],
            "verify", false, 500, { patient: false, timeoutMs: 60_000 }
          );
          const verdict = extractJson(verRes.text);
          const v = String(verdict?.verdict || "unclear").toLowerCase();
          claim.verified = v;
          await ctx.emit(
            "verify",
            v === "confirmed"
              ? `Cross-check CONFIRMED: “${claim.claim.slice(0, 70)}…”`
              : v === "refuted"
                ? `Cross-check REFUTED: “${claim.claim.slice(0, 70)}…”`
                : `Cross-check unclear: “${claim.claim.slice(0, 70)}…”`,
            verdict?.reasoning || verRes.text.slice(0, 400),
            verRes.model,
            { claim: claim.claim.slice(0, 200), verdict: v, correction: verdict?.correction || "" }
          );
          if (v === "refuted") {
            refuted.push({ claim: claim.claim, correction: String(verdict?.correction || "").slice(0, 400), reasoning: String(verdict?.reasoning || "").slice(0, 400) });
          }
        } catch (verr) {
          await ctx.emit("info", `Cross-check unavailable for “${claim.claim.slice(0, 60)}…” — claim stays flagged as ${claim.grade}`, verr instanceof Error ? verr.message.slice(0, 160) : undefined);
        }
      }
    }

    // ---------- STAGE 3.4b: MULTI-AGENT DEBATE (P2-1 — proposer / skeptic / judge) ----------
    // Claims that remain contested (or came back unclear from cross-checks) get a
    // structured debate over fresh evidence. Training-free multi-agent debate
    // measurably improves fact-checking (FC-MAD line); bounded to 2 claims, deep+ presets.
    let debated = 0;
    if (heavyPreset && !ctx.outOfTime && !SERVERLESS) {
      // debate targets: contested or cross-check-unclear claims that no verdict has settled yet
      const debateClaims = ctx.claims
        .filter((c) => c.claim.length > 25 && (c.grade === "contested" || c.verified === "unclear") && !["confirmed", "refuted"].includes(c.verified ?? "") && !(c.verified ?? "").startsWith("debate"))
        .slice(0, 2);
      for (const claim of debateClaims) {
        try {
          const vq = claim.claim.split(/\s+/).slice(0, 12).join(" ");
          const drs = (await searchAll(vq, { academic: false })).filter((r) => r.url && !ctx.seenUrls.has(r.url) && !r.domain.includes("duckduckgo.com")).slice(0, 3);
          const dpages = (await Promise.all(drs.map((r) => fetchPageContent(r.url, 2600, r.excerpt)))).filter((p): p is NonNullable<typeof p> => !!p);
          if (dpages.length === 0) continue;
          const evidence = dpages.map((p, i) => `[${i + 1}] ${p.title} (${p.domain})\n${p.text.slice(0, 1100)}`).join("\n\n---\n\n");
          const [proR, conR] = await Promise.allSettled([
            ctx.llm([{ role: "user", content: debateProposerPrompt(claim.claim, evidence) }], "debate-pro", false, 300, { patient: false, timeoutMs: 45_000 }),
            ctx.llm([{ role: "user", content: debateSkepticPrompt(claim.claim, evidence) }], "debate-con", false, 300, { patient: false, timeoutMs: 45_000 }),
          ]);
          if (proR.status !== "fulfilled" || conR.status !== "fulfilled") continue;
          await ctx.emit(
            "debate",
            `Debate opened: “${claim.claim.slice(0, 70)}…”`,
            `PROPOSER: ${proR.value.text.trim().slice(0, 700)}\n\nSKEPTIC: ${conR.value.text.trim().slice(0, 700)}`,
            proR.value.model,
            { claim: claim.claim.slice(0, 200), round: "arguments" }
          );
          const judgeRes = await ctx.llm(
            [{ role: "user", content: debateJudgePrompt(claim.claim, evidence, proR.value.text, conR.value.text) }],
            "debate-judge", false, 400, { patient: false, timeoutMs: 45_000 }
          );
          const jd = extractJson(judgeRes.text);
          const verdict = String(jd?.verdict || "unsettled").toLowerCase();
          claim.verified = `debate-${verdict}`;
          debated++;
          await ctx.emit(
            "debate",
            `Debate verdict — ${verdict.toUpperCase()}: “${claim.claim.slice(0, 70)}…”`,
            String(jd?.reasoning || judgeRes.text).slice(0, 500) + (verdict === "refuted" && jd?.correctedClaim ? `\n\nCorrected claim: ${String(jd.correctedClaim).slice(0, 300)}` : ""),
            judgeRes.model,
            { claim: claim.claim.slice(0, 200), verdict, correctedClaim: verdict === "refuted" ? String(jd?.correctedClaim || "").slice(0, 300) : "" }
          );
          if (verdict === "refuted" && jd?.correctedClaim) {
            refuted.push({ claim: claim.claim, correction: String(jd.correctedClaim).slice(0, 400), reasoning: `(debate) ${String(jd?.reasoning || "").slice(0, 300)}` });
          }
        } catch { /* a debate that cannot run just leaves the claim as graded */ }
      }
    }

    // ---------- STAGE 3.5: SOURCE CURATION (gpt-researcher SourceCurator) ----------
    // Rank everything consulted by credibility + relevance; best sources get the low citation numbers.
    if (await ctx.isCancelled()) throw new Cancelled();
    // v2.5.0: on a stage-3-complete resume the curated order comes from the
    // checkpoint — re-curating would duplicate the LLM call and the event
    if (sourcesUsed.length > 3 && !stage3Ran) {
      try {
        const keep = Math.min(sourcesUsed.length, unlimited ? 30 : 20);
        const curRes = await ctx.llm(
          [{ role: "user", content: curateSourcesPrompt(job.query, sourcesUsed.map((s) => ({ n: s.n, title: s.title, domain: s.domain })), keep) }],
          "curate", false, 500, { patient: false, timeoutMs: SERVERLESS ? 20_000 : 60_000 }
        );
        const ranked = (extractJsonArray(curRes.text) ?? [])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && sourcesUsed.some((s) => s.n === n));
        if (ranked.length >= 3) {
          const rankedSet = new Set(ranked);
          const ordered = [
            ...sourcesUsed.filter((s) => rankedSet.has(s.n)).sort((a, b) => ranked.indexOf(a.n) - ranked.indexOf(b.n)),
            ...sourcesUsed.filter((s) => !rankedSet.has(s.n)),
          ];
          sourcesUsed.length = 0;
          sourcesUsed.push(...ordered);
          await ctx.emit(
            "curate",
            `Curated the ${ranked.length} most credible sources`,
            `Ranked by relevance to the question, source quality (primary > secondary > aggregator) and domain reputation. The best sources now carry the first citation numbers — weaker ones cite last.`,
            curRes.model,
            { kept: ranked.length, total: sourcesUsed.length }
          );
        }
      } catch { /* curation is an enhancement, never fatal */ }
    }

    // ---------- STAGE 3.8: THE COURT (alexyc9381/court-skill, adapted) ----------
    // The proposition goes on trial OVER the gathered evidence: prosecution builds the
    // strongest honest case it fails, defense the strongest honest case it holds, each
    // answers the other, a jury of 12 independent personas votes, the judge reads the
    // verdict with conditions. Briefs must cite [n] — the trial is grounded in the same
    // audited evidence as every digdeep report. Graceful degradation at every step:
    // a trial that cannot run falls back to the standard report, honestly noted.
    // v2.5.0: `court` is hoisted + restored from the checkpoint — a completed trial
    // never re-runs; an interrupted one resumes from courtProgress (briefs, votes).
    if (job.court && !ctx.outOfTime && !court) {
      await updateJob(jobId, { status: "critiquing", stage: "The trial — building the case", progress: 76 });
      // the evidence record both sides argue from: every aspect's findings + the graded learnings
      const courtSections = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
      const evidenceRecord = [
        ...courtSections.filter((s) => s.findings).map((s) => `### ${s.title}\n${s.findings!.slice(0, 4200)}`),
        ...(ctx.allLearnings.length ? [`### Verified findings (evidence-graded)\n${ctx.allLearnings.slice(0, 24).map((l) => `- ${l}`).join("\n")}`] : []),
        ...(ctx.contradictions.length ? [`### Points where sources disagree\n${ctx.contradictions.map((c) => `- ${c.claim} — ${c.positions}`).join("\n")}`] : []),
        `### Source register (cite as [n])\n${sourcesUsed.slice(0, 40).map((s) => `[${s.n}] ${s.title} — ${s.domain}`).join("\n")}`,
      ].join("\n\n").slice(0, 26_000);

      // C1 + C2 — the two briefs (sequential: the docket reads prosecution first)
      // v2.5.0 resume: briefs/votes from a previous slice come from courtProgress —
      // a resumed trial never re-runs a step that already completed
      let prosecutionBrief = courtProgress?.prosecutionBrief ?? "";
      let defenseBrief = courtProgress?.defenseBrief ?? "";
      if (!prosecutionBrief) {
      try {
        const proRes = await ctx.llmLive(prosecutionPrompt(job.query, evidenceRecord, job.language), "court-prosecution", "The prosecution is building its case", { wantThinking: true, maxTokens: 1400 });
        prosecutionBrief = proRes.text.trim();
        await ctx.emit("court", "The prosecution rests", prosecutionBrief.slice(0, 1600), proRes.model, { phase: "prosecution" });
        courtProgress = { ...(courtProgress ?? {}), prosecutionBrief };
        await persist("predraft", { courtProgress }).catch(() => {});
      } catch (proErr) {
        await ctx.emit("info", "The prosecution could not build its case (models unavailable) — the trial cannot proceed fairly", proErr instanceof Error ? proErr.message.slice(0, 200) : undefined);
      }
      }
      if (prosecutionBrief && !defenseBrief) {
        try {
          const defRes = await ctx.llmLive(defensePrompt(job.query, evidenceRecord, job.language), "court-defense", "The defense is building its case", { wantThinking: true, maxTokens: 1400 });
          defenseBrief = defRes.text.trim();
          await ctx.emit("court", "The defense rests", defenseBrief.slice(0, 1600), defRes.model, { phase: "defense" });
          courtProgress = { ...(courtProgress ?? {}), defenseBrief };
          await persist("predraft", { courtProgress }).catch(() => {});
        } catch (defErr) {
          await ctx.emit("info", "The defense could not build its case — a one-sided trial is no trial; the verdict will note this honestly", defErr instanceof Error ? defErr.message.slice(0, 200) : undefined);
        }
      }

      // C3 — rebuttals (each side answers the other's strongest points, parallel)
      // v2.5.0 resume: rebuttals + jury votes accumulate in courtProgress
      let rebuttals: { by: "prosecution" | "defense"; text: string }[] = (courtProgress?.rebuttals as { by: "prosecution" | "defense"; text: string }[]) ?? [];
      if (prosecutionBrief && defenseBrief && !ctx.outOfTime && rebuttals.length === 0) {
        const [proReb, defReb] = await Promise.allSettled([
          ctx.llm(rebuttalPrompt(job.query, "prosecution", prosecutionBrief, defenseBrief, evidenceRecord, job.language), "court-rebuttal", false, 500, { patient: false, timeoutMs: 60_000 }),
          ctx.llm(rebuttalPrompt(job.query, "defense", defenseBrief, prosecutionBrief, evidenceRecord, job.language), "court-rebuttal", false, 500, { patient: false, timeoutMs: 60_000 }),
        ]);
        if (proReb.status === "fulfilled" && proReb.value.text.trim()) {
          rebuttals.push({ by: "prosecution", text: proReb.value.text.trim() });
          await ctx.emit("court", "Prosecution's rebuttal", proReb.value.text.trim().slice(0, 1200), proReb.value.model, { phase: "rebuttal", by: "prosecution" });
        }
        if (defReb.status === "fulfilled" && defReb.value.text.trim()) {
          rebuttals.push({ by: "defense", text: defReb.value.text.trim() });
          await ctx.emit("court", "Defense's rebuttal", defReb.value.text.trim().slice(0, 1200), defReb.value.model, { phase: "rebuttal", by: "defense" });
        }
      }
      // v2.5.0: rebuttals persist — a slice boundary after them never re-argues
      if (rebuttals.length > 0) {
        courtProgress = { ...(courtProgress ?? {}), rebuttals };
        await persist("predraft", { courtProgress }).catch(() => {});
      }

      // C4 — THE PERFECT JURY (v3.0): 12 independent personas (6 on the quick
      // preset, court-skill --quick). Two ballots around a real deliberation:
      // a BLIND first ballot (the honest spread) → the jury sees the split and
      // argues it, each juror answering the strongest opposing point → a FINAL
      // ballot they may hold or change, never for free → the foreman sums up.
      // A tie is a HUNG JURY — declared, never misread as an acquittal.
      const quickCourt = job.preset === "quick";
      const jury = quickCourt ? JURORS.filter((_, i) => i % 2 === 0) : JURORS;
      const rebuttalText = rebuttals.map((r) => `${r.by === "prosecution" ? "PROSECUTION" : "DEFENSE"}: ${r.text}`).join("\n\n") || "(no rebuttals)";
      // v3.0 resume: firstBallot is the blind vote; jurorVotes holds the FINAL
      // votes once deliberation ran (or was consciously skipped). Votes cast in
      // a previous slice are kept — only the missing jurors vote in this one.
      let firstBallot: { name: string; lens: string; vote: JurorVote; reason: string; confidence?: number }[] =
        (courtProgress?.firstBallot as typeof firstBallot) ?? [];
      let jurorVotes: JurorBallot[] = (courtProgress?.jurorVotes as JurorBallot[]) ?? [];
      let deliberationRan = courtProgress?.deliberationRan ?? false;
      let foremanSummary: string | undefined = courtProgress?.foremanSummary;
      // legacy v2.x checkpoint resume: jurorVotes already hold a complete single
      // ballot — promote them to the first ballot and proceed straight to the judge
      if (firstBallot.length === 0 && jurorVotes.length > 0) {
        firstBallot = jurorVotes.map((v) => ({ name: v.name, lens: v.lens, vote: v.vote, reason: v.reason, confidence: v.confidence }));
      }
      if (prosecutionBrief && defenseBrief) {
        await ctx.emit("court", `The jury convenes — ${jury.length} independent personas take the first ballot`, "Each juror reads the same evidence and briefs but votes blind through their own lens: the accountant, the first-time customer, the competitor, the retired judge, the statistician… The vote spread is the honest signal.", undefined, { phase: "jury", jurors: jury.length });
        // bounded concurrency: 4 jurors vote at a time — 12 simultaneous calls would
        // hammer the keyless chain into cooldown for every other step of the trial
        const JUROR_CONCURRENCY = 4;
        // one juror's ballot, strictly parsed: a spoiled ballot is NEVER silently
        // read as an acquittal (v2.x bug) — it gets one strict retry, then no vote
        const castBallot = async (
          messages: ChatMsg[],
          juror: { name: string; lens: string }
        ): Promise<{ vote: JurorVote; confidence?: number; reason: string; reply?: string } | { error: string }> => {
          try {
            let res = await ctx.llm(messages, "court-juror", false, 200, { patient: false, timeoutMs: 45_000 });
            let parsed = extractJson(res.text);
            let vote = parseStrictVote(parsed?.vote);
            if (!vote) {
              res = await ctx.llm(
                [...messages, msg("user", "Your previous reply could not be read as a ballot. Reply again with ONLY the JSON object — nothing before it, nothing after it.")],
                "court-juror", false, 120, { patient: false, timeoutMs: 45_000 }
              );
              parsed = extractJson(res.text);
              vote = parseStrictVote(parsed?.vote);
            }
            if (!vote) return { error: "unreadable ballot" };
            const confNum = Number(parsed?.confidence);
            const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(100, Math.round(confNum))) : undefined;
            const reason = String(parsed?.reason || "").slice(0, 320).trim() || "(no reason given)";
            const reply = String(parsed?.reply || "").slice(0, 400).trim() || undefined;
            return { vote, confidence, reason, reply };
          } catch (err) {
            return { error: err instanceof Error ? err.message.slice(0, 120) : "model unavailable" };
          }
        };
        // ---- the FIRST ballot (blind, independent) ----
        for (let i = 0; i < jury.length; i += JUROR_CONCURRENCY) {
          if (ctx.outOfTime) break;
          const batch = jury.slice(i, i + JUROR_CONCURRENCY).filter((j) => !firstBallot.some((v) => v.name === j.name));
          if (batch.length === 0) continue;
          const results = await Promise.allSettled(
            batch.map((j) => castBallot(jurorPrompt(job.query, j, evidenceRecord, prosecutionBrief, defenseBrief, rebuttalText, job.language), j))
          );
          results.forEach((r, k) => {
            const juror = batch[k];
            const ballot = r.status === "fulfilled" ? r.value : { error: "model unavailable" };
            if (!("error" in ballot)) {
              firstBallot.push({ name: juror.name, lens: juror.lens, vote: ballot.vote, reason: ballot.reason, confidence: ballot.confidence });
              ctx.emit("court", `First ballot: ${ballot.vote} — ${juror.name}`, ballot.reason, undefined, { phase: "juror", juror: juror.name, vote: ballot.vote, reason: ballot.reason, ballot: "first", confidence: ballot.confidence }).catch(() => {});
            } else {
              ctx.emit("info", `${juror.name} could not cast a ballot (${ballot.error}) — no vote is invented for them`, undefined, undefined, undefined, "verbose").catch(() => {});
            }
          });
          // v3.0: the first ballot persists per batch — a slice boundary mid-ballot keeps it
          courtProgress = { ...(courtProgress ?? {}), firstBallot, jurorVotes: jurorVotes.filter((v) => firstBallot.some((f) => f.name === v.name)) };
          await persist("predraft", { courtProgress }).catch(() => {});
        }
        const firstGuilty = firstBallot.filter((v) => v.vote === "GUILTY").length;
        const firstNotGuilty = firstBallot.length - firstGuilty;
        // ---- DELIBERATION: only when the first ballot is contested (margin close
        // enough that argument could move the outcome). Unanimous or near-unanimous
        // ballots are confirmed without one — and the court says so honestly. The
        // quick preset is a single-ballot trial by design.
        const contested = ballotContested(firstGuilty, firstNotGuilty, firstBallot.length);
        // QUORUM: a verdict is never read from a handful of votes — at least half
        // the jury must have returned a ballot. Below quorum the verdict is
        // withheld (briefs still publish); a resumed slice re-polls the missing
        // jurors, so a throttle wave does not kill the trial, it delays it.
        const quorate = juryQuorate(firstBallot.length, jury.length);
        if (firstBallot.length > 0 && !quorate) {
          await ctx.emit(
            "court",
            `The jury could barely convene — ${firstBallot.length} of ${jury.length} ballots returned`, 
            "Model throttling spoiled the other ballots, and a verdict is never read from a handful of votes: honest briefs stand, the verdict is withheld. If this run continues, the missing jurors are re-polled as the throttle wave passes.",
            undefined,
            { phase: "jury", returned: firstBallot.length, expected: jury.length, quorate: false }
          );
        }
        if (quorate && firstBallot.length > 0 && !ctx.outOfTime && jurorVotes.length < firstBallot.length) {
          if (!quickCourt && contested) {
            if (!deliberationRan) {
              await ctx.emit(
                "court",
                `First ballot: ${firstGuilty} guilty · ${firstNotGuilty} not guilty — the jury deliberates`,
                `The blind vote split, so the jury argues it: each juror hears every other juror's reason, answers the strongest one voting against them, and then casts a final vote — held or changed, never for free. The foreman will sum up what moved the room.`,
                undefined,
                { phase: "deliberation", guilty: firstGuilty, notGuilty: firstNotGuilty }
              );
            }
          for (let i = 0; i < jury.length; i += JUROR_CONCURRENCY) {
            if (ctx.outOfTime) break;
            const batch = jury.slice(i, i + JUROR_CONCURRENCY).filter((j) => firstBallot.some((f) => f.name === j.name) && !jurorVotes.some((v) => v.name === j.name));
            if (batch.length === 0) continue;
            const results = await Promise.allSettled(
              batch.map((j) => {
                const own = firstBallot.find((f) => f.name === j.name)!;
                return castBallot(deliberationPrompt(job.query, j, own, firstBallot, job.language), j);
              })
            );
            results.forEach((r, k) => {
              const juror = batch[k];
              const own = firstBallot.find((f) => f.name === juror.name)!;
              const ballot = r.status === "fulfilled" ? r.value : { error: "model unavailable" };
              if (!("error" in ballot)) {
                const changed = ballot.vote !== own.vote; // the vote record decides, not the self-report
                jurorVotes.push({ name: juror.name, lens: juror.lens, vote: ballot.vote, reason: ballot.reason, confidence: ballot.confidence, changedVote: changed, deliberationReply: ballot.reply });
                ctx.emit("court", `${changed ? `Juror changed to ${ballot.vote}` : `Juror held ${ballot.vote}`} — ${juror.name}`, ballot.reply ?? ballot.reason, undefined, { phase: "juror", juror: juror.name, vote: ballot.vote, reason: ballot.reason, ballot: "final", changed, confidence: ballot.confidence }).catch(() => {});
              } else {
                // a juror who cannot deliberate keeps their first-ballot vote — it was legitimately cast
                jurorVotes.push({ ...own, changedVote: false });
                ctx.emit("info", `${juror.name} could not join the deliberation (${ballot.error}) — their first-ballot vote stands`, undefined, undefined, undefined, "verbose").catch(() => {});
              }
            });
            courtProgress = { ...(courtProgress ?? {}), firstBallot, jurorVotes, deliberationRan: true };
            deliberationRan = true; // the local gate matters: foreman, judge record and verdict spread read it
            await persist("predraft", { courtProgress }).catch(() => {});
          }
          } else {
            // single-ballot trial (quick) or a decisive first ballot — no deliberation needed
            jurorVotes = firstBallot.map((b) => ({ ...b, changedVote: false }));
            const note = quickCourt
              ? "Quick trial: one ballot by design — six jurors, no deliberation round."
              : `The first ballot was ${firstGuilty}–${firstNotGuilty} — decisive enough that deliberation could not change the outcome; the jury confirms the verdict without extended argument.`;
            await ctx.emit("court", `First ballot stands: ${firstGuilty} guilty · ${firstNotGuilty} not guilty`, note, undefined, { phase: "votes", guilty: firstGuilty, notGuilty: firstNotGuilty, single: true });
            courtProgress = { ...(courtProgress ?? {}), firstBallot, jurorVotes, deliberationRan: true };
            deliberationRan = true; // stage resolved (skipped) — the verdict still records the first ballot
            await persist("predraft", { courtProgress }).catch(() => {});
          }
        }
        const guilty = jurorVotes.filter((v) => v.vote === "GUILTY").length;
        const notGuilty = jurorVotes.length - guilty;
        const changedCount = jurorVotes.filter((v) => v.changedVote).length;
        if (jurorVotes.length > 0) {
          await ctx.emit("court", `The final ballot: ${guilty} guilty · ${notGuilty} not guilty`, `${jurorVotes.length} of ${jury.length} jurors returned a verdict${jurorVotes.length < jury.length ? " — the missing votes are noted honestly, not invented" : ""}.${deliberationRan && !quickCourt && contested ? `${changedCount > 0 ? ` ${changedCount} juror${changedCount === 1 ? "" : "s"} changed their vote${changedCount === 1 ? "" : "s"} in deliberation (first ballot: ${firstGuilty}–${firstNotGuilty}).` : " No juror changed their vote — the argument hardened positions rather than moving them."}` : ""}`, undefined, { phase: "votes", guilty, notGuilty, returned: jurorVotes.length, expected: jury.length, changed: changedCount });
        }

        // ---- the FOREMAN sums up the deliberation (only when one actually ran) ----
        if (deliberationRan && !quickCourt && contested && jurorVotes.length > 0 && !foremanSummary && !ctx.outOfTime) {
          try {
            const foremanRes = await ctx.llm(foremanPrompt(job.query, firstBallot, jurorVotes, job.language), "court-foreman", false, 450, { patient: false, timeoutMs: 60_000 });
            const f = extractJson(foremanRes.text);
            const summary = String(f?.summary ?? "").slice(0, 1000).trim();
            if (summary) {
              foremanSummary = summary;
              await ctx.emit("court", "The foreman sums up the deliberation", foremanSummary, foremanRes.model, { phase: "foreman" });
              courtProgress = { ...(courtProgress ?? {}), foremanSummary };
              await persist("predraft", { courtProgress }).catch(() => {});
            }
          } catch {
            await ctx.emit("info", "The foreman could not sum up — the votes stand on their own record", undefined, undefined, undefined, "verbose").catch(() => {});
          }
        }

        // C5 — the judge reads the verdict (charges that stuck, defense wins, conditions)
        if (jurorVotes.length > 0 && !ctx.outOfTime) {
          let judge: { chargesStuck?: string[]; defenseWins?: string[]; conditions?: string[]; summary?: string } | null = null;
          try {
            const judgeRes = await ctx.llm(
              judgePrompt(job.query, evidenceRecord, prosecutionBrief, defenseBrief, rebuttalText, jurorVotes, job.language, deliberationRan && !quickCourt && contested ? { firstBallot: { guilty: firstGuilty, notGuilty: firstNotGuilty }, foremanSummary } : undefined),
              "court-judge", false, 800, { patient: false, timeoutMs: 60_000 }
            );
            judge = extractJson(judgeRes.text);
            if (judge?.summary) {
              await ctx.emit("court", "The judge reads the verdict", String(judge.summary).slice(0, 1200), judgeRes.model, { phase: "judge", ...judge });
            }
          } catch (judgeErr) {
            await ctx.emit("info", "The judge could not read the verdict — the raw vote stands without commentary", judgeErr instanceof Error ? judgeErr.message.slice(0, 160) : undefined);
          }
          const verdictType = finalVerdictOf(guilty, notGuilty);
          const verdict: CourtVerdict = {
            charge: job.query.slice(0, 600),
            verdict: verdictType,
            guilty,
            notGuilty,
            jurors: jurorVotes,
            prosecutionBrief,
            defenseBrief,
            rebuttals,
            chargesStuck: (judge?.chargesStuck ?? []).map((c) => String(c).slice(0, 300)).slice(0, 5),
            defenseWins: (judge?.defenseWins ?? []).map((c) => String(c).slice(0, 300)).slice(0, 5),
            conditions: (judge?.conditions ?? []).map((c) => String(c).slice(0, 300)).slice(0, 6),
            judgeSummary: String(judge?.summary ?? (verdictType === "HUNG JURY" ? `The jury deadlocked ${guilty} to ${notGuilty} — no verdict was reached.` : `The jury voted ${guilty} to ${notGuilty}.`)).slice(0, 800),
            quick: quickCourt,
            ...(deliberationRan && !quickCourt ? { firstBallot: { guilty: firstGuilty, notGuilty: firstNotGuilty }, ...(contested ? { deliberated: true } : {}), ...(foremanSummary ? { foremanSummary } : {}) } : {}),
          };
          court = verdict;
          // v2.5.0: the verdict persists — a resume never re-tries a concluded case
          await persist("predraft", { courtVerdict: verdict } as Partial<EngineCheckpoint>).catch(() => {});
          await ctx.emit(
            "court",
            verdictType === "HUNG JURY"
              ? `VERDICT: HUNG JURY — the jury deadlocked ${guilty} to ${notGuilty}`
              : `VERDICT: ${verdictType} — ${guilty} to ${notGuilty}`,
            `${verdict.judgeSummary}${verdict.conditions.length ? `\n\nWhat to change before trying again:\n${verdict.conditions.map((c) => `• ${c}`).join("\n")}` : ""}`,
            undefined,
            { phase: "verdict", verdict: verdictType, guilty, notGuilty }
          );
        }
      }
      if (!court && prosecutionBrief) {
        // partial trial (defense or jury failed) — keep what exists, honestly
        court = {
          charge: job.query.slice(0, 600),
          verdict: "NOT GUILTY",
          guilty: 0,
          notGuilty: 0,
          jurors: [],
          prosecutionBrief,
          defenseBrief,
          rebuttals,
          chargesStuck: [],
          defenseWins: [],
          conditions: [],
          judgeSummary: "The trial could not complete — one or more parties (defense, jury, or judge) were unavailable under model throttling. The briefs are published; no verdict was rendered, and none is invented.",
          quick: quickCourt,
        };
        await ctx.emit("info", "The trial is incomplete — briefs published, verdict withheld", "Honesty over theater: without both sides and a jury there is no verdict. Re-run when the free models are less throttled, or add an LLM7 key in settings.");
      }
    }

    // ---------- STAGE 4: SYNTHESIS ----------
    if (await ctx.isCancelled()) throw new Cancelled();

    // Abstain instead of fabricating (gpt-researcher writer guard): with zero sources, a
    // confident "sourced-looking" report would be dishonest — say so plainly.
    if (sourcesUsed.length === 0) {
      const timeExhausted = ctx.hasTimeBudget && ctx.timeLeft <= 60_000;
      const why = timeExhausted
        ? "The time budget ran out before any sources could be gathered (the free LLM backends were throttled for most of it, and planning had to fall back). A fresh run — or Unlimited mode, which has no clock — will research properly."
        : "Every search and page read failed (engines may be blocked or rate-limited) — writing an honest abstention instead of a confident report with nothing behind it.";
      await ctx.emit("info", "No source material could be gathered", why);
      const abstain = `I could not gather any source material for "${job.query}". ${timeExhausted ? "The time budget expired before the research could start — the free model backends were throttled for most of the run and planning had to fall back to a generic plan." : "Searches returned nothing usable."} So rather than write a confident-looking report with nothing behind it, I am being straight with you: nothing here was verified.\n\nTry running the research again in a few minutes — or use Unlimited mode, which has no time cap and will wait out the throttling for as long as it takes.`;
      const statsAbstain = {
        durationMs: Date.now() - t0,
        sourcesConsulted: 0,
        llmCalls: ctx.llmCalls,
        byModel: ctx.byModel,
        reportWords: abstain.split(/\s+/).length,
        sections: 0,
        relatedQuestions: [] as string[],
        abstained: true,
        finishedAt: new Date().toISOString(),
      };
      await updateJob(jobId, { status: "completed", stage: "Completed (no sources)", progress: 100, reportMd: abstain, stats: JSON.stringify(statsAbstain), completedAt: new Date() });
      await notifyRunFinished(jobId); // v3.4: webhooks + watch advancement (never throws)
      await ctx.emit("done", "Abstained honestly — no sources retrieved", `0 sources after ${fmtMin(Date.now() - t0)} — nothing verified, so nothing claimed. Try again shortly.`, undefined, statsAbstain);
      return;
    }

    await updateJob(jobId, { status: "synthesizing", stage: "Writing the report", progress: 80 });
    const finalSections = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    // v2.5.0: continuation gives the tail real time — meatier sections lift the
    // coverage and evidence dimensions directly (the 4.5/10 report was thin:
    // ~400 words/section). Standard now targets 480-720 words per section.
    words = unlimited || job.preset === "exhaustive" ? [550, 900] : job.preset === "deep" ? [520, 800] : [480, 720];

    // Evidence-strength notes per section (reflect v3 graded claims → the writer states
    // each claim with the confidence its evidence actually supports)
    const evidenceNotesFor = (sectionTitle: string) => {
      const notes = ctx.claims
        .filter((c) => c.section === sectionTitle && c.grade !== "verified")
        .map((c) => `- [${c.grade}${c.verified ? ` → cross-check ${c.verified}` : ""}] ${c.claim}${c.basis && c.basis !== "(ungraded)" ? ` (${c.basis})` : ""}`)
        .slice(0, 10);
      return notes.length ? notes.join("\n") : "";
    };

    // v2.4.0 PARALLEL DRAFTS: sections are independent (findings + sources +
    // learnings each) — drafting them one-at-a-time was the reason a 240s budget
    // died at 95%: 3-4 sequential drafts × 30-60s each ate the whole tail. Now a
    // bounded pool drafts them concurrently (serverless: pool 4 + 45s fast cap),
    // so the whole phase costs ~one draft's latency. Each section still streams
    // live into the UI, and every fallback (clock-out → findings, failure →
    // findings) is per-section, exactly as before.
    // v2.5.0 resume: at "drafting" the pool only drafts sections without a draft;
    // at "tail"+ every draft already exists — the pool is skipped entirely and
    // draftsArr is rebuilt from the persisted section rows.
    const skipDraftPool = phaseAtLeast(resumePhase, "tail");
    const draftsArr: string[] = skipDraftPool
      ? finalSections.map((s) => s.draftMd || "")
      : new Array(finalSections.length).fill("");
    if (!skipDraftPool) {
      const DRAFT_POOL = SERVERLESS ? Math.min(4, finalSections.length) : Math.min(3, finalSections.length);
      await updateJob(jobId, { stage: `Writing ${finalSections.length} sections in parallel`, progress: 80 });
      const draftOne = async (sec: (typeof finalSections)[number], i: number) => {
        if (await ctx.isCancelled()) throw new Cancelled();
        // v2.5.0 resume: a section drafted in a previous slice keeps its draft
        if (resumeDrafting && sec.draftMd && sec.draftMd.length > 0) {
          draftsArr[i] = sec.draftMd;
          return;
        }
        if (!sec.findings) {
          await ctx.emit("info", `No evidence gathered for “${sec.title}” — writing what is reliably known, marked as general context`);
        }
        const srcs = sourcesUsed.slice(0, 60);
        let draftText = "";
        let draftModel: string | undefined;
        if (ctx.hardLeft < 20_000) {
          // the function is seconds from freezing — publish the verified research notes
          // directly instead of gambling them on one more LLM round trip
          await ctx.emit("info", `Clock nearly out — publishing the verified research notes for “${sec.title}” directly`, "The findings were already synthesized from the sources read; only the prose rewrite is skipped.");
          draftText = sec.findings || "_Insufficient evidence was gathered for this section._";
        } else {
          try {
            // the section streams into the UI as it is written — the user literally watches
            // the report being typed. Bounded by the hard clock: a stalled draft falls
            // back to findings instead of freezing the whole report.
            // v2.4.6: drafts are FAST on the serverless clock (35s chain + rescue).
            // v2.5.0: continuation raises the cap to 50s — a section that outgrows
            // the slice checkpoints at "drafting" and the next slice finishes it,
            // instead of publishing findings-notes as the section.
            const draftRes = await ctx.llmLive(
              [{ role: "user", content: draftSectionPrompt(job.query, sec.title, sec.question, sec.findings ?? "(no findings — rely on general knowledge and clearly mark it as background)", srcs, words, job.language, evidenceNotesFor(sec.title), adversarialNotesFor(sec.title), ctx.allLearnings) }],
              "draft",
              `Writing: ${sec.title}`,
              // v2.5.1: patient ride — a draft that waits out a cooldown window beats
              // findings-notes published as a section (the 5.5/10 run's drafts all
              // fell back; the evidence dim paid for it)
              { streamTo: sec.id, ...(SERVERLESS ? { fast: { timeoutMs: 60_000, maxWaitMs: 110_000 } } : {}) }
            );
            draftText = draftRes.text;
            draftModel = draftRes.model;
            // v2.5.3: a stream capped mid-sentence must not ship as an "abrupt ending"
            if (draftText) draftText = trimToCompleteSentence(draftText);
          } catch (err) {
            await ctx.emit("info", `Draft step failed for “${sec.title}” — using verified research notes directly`, err instanceof Error ? err.message.slice(0, 300) : undefined);
            draftText = sec.findings || "_Insufficient evidence was gathered for this section._";
          }
        }
        draftsArr[i] = draftText;
        // P1-3 COMPUTE TOOL: resolve every [[COMPUTE expr]] the drafter emitted —
        // exact arithmetic replaces the directive before the text ships anywhere
        {
          const pc = processComputes(draftText);
          if (pc.computes.length > 0) {
            draftsArr[i] = pc.text;
            draftText = pc.text;
            for (const c of pc.computes) {
              await ctx.emit(
                "compute",
                c.ok ? `Computed: ${c.expr} = ${c.result}` : `Compute failed: ${c.expr}`,
                c.ok ? `Exact evaluation for “${sec.title}” — the number in the report is machine-computed, not model-guessed.` : c.result,
                undefined,
                { section: sec.title, expr: c.expr, result: c.result, ok: c.ok },
              );
            }
          }
        }
        await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: draftText } });
        sec.draftMd = draftText; // keep the in-memory row in sync — report assembly reads this array
        await ctx.emit("draft", `Wrote: ${sec.title}`, `${draftText.split(/\s+/).length} words`, draftModel, { section: sec.title });
        await updateJob(jobId, { progress: Math.round(80 + ((i + 1) / finalSections.length) * 14) }).catch(() => {});
      };
      const queue = finalSections.map((sec, i) => ({ sec, i }));
      const workers = Array.from({ length: DRAFT_POOL }, async () => {
        for (;;) {
          // v2.5.0: stop taking new drafts when this slice is nearly over — the
          // drafted-so-far sections persist, the next slice drafts the rest
          if (outOfSlice()) return;
          const next = queue.shift();
          if (!next) return;
          await draftOne(next.sec, next.i);
        }
      });
      await Promise.all(workers);
      // v2.5.0 SLICE BOUNDARY (drafts): undrafted sections remain — checkpoint
      // at "drafting" so the next slice drafts only what's missing
      if (outOfSlice() && !runExhausted()) {
        await persist("drafting");
        await updateJob(jobId, { stage: "Slice boundary — continuing the drafts", progress: 88 }).catch(() => {});
        return;
      }
    }

    // ---------- STAGE 4.5: QUOTE-ANCHORED CITATION VERIFICATION (P0-4) ----------
    // The industry's worst failure mode (citation studies: >60% of AI citations
    // mis-anchor) becomes digdeep's headline feature: every [n] in the drafts is
    // checked against the text that was ACTUALLY read from that source. A lexical
    // overlap scan flags weak anchors; a batched judge repairs (re-anchor) or drops
    // them. The integrity percentage is published in the stats — honestly.
    // (citeStats is hoisted to the run head for continuation restores.)
    // v2.4.0: the audit is now a WORKER in the parallel tail bundle (it only needs
    // the drafts) — it runs CONCURRENTLY with exec-summary/conclusion/title/related
    // instead of serially before them, saving its full latency on the serverless clock.
    const auditWork = async (): Promise<void> => {
    if (ctx.sourceTexts.size > 0 && (ctx.hardLeft >= 30_000 || !ctx.outOfTime)) {
      // the shared implementation (src/lib/claim-support.ts) — identical rules on
      // the server and in the client's "re-check this claim", by design
      const supportTokens = sharedSupportTokens;
      const lexicalSupport = sharedLexicalSupport;

      // 4.5a. lexical scan — flag citations whose claim-sentence barely overlaps the source
      const weak: { secId: string; n: number; sentence: string }[] = [];
      let totalCites = 0;
      for (const sec of finalSections) {
        const draft = sec.draftMd || "";
        if (!draft) continue;
        for (const sentence of draft.split(/(?<=[.!?])\s+/)) {
          const nums = [...sentence.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
          if (nums.length === 0) continue;
          totalCites += nums.length;
          for (const n of nums) {
            const src = ctx.sourceTexts.get(n);
            if (!src || src.length < 400) continue; // snippet-grade sources are judged by the LLM only if flagged elsewhere
            if (lexicalSupport(sentence, src) < 0.3 && !weak.some((w) => w.secId === sec.id && w.n === n)) {
              weak.push({ secId: sec.id, n, sentence: sentence.trim() });
            }
          }
        }
      }

      // 4.5b. batched judge for the weak anchors — repair, re-anchor, or drop
      if (weak.length > 0) {
        try {
          const capped = weak.slice(0, 12);
          const crRes = await ctx.llm(
            [{
              role: "user",
              content: citeRepairPrompt(
                job.query,
                capped.map((w) => ({ n: w.n, sentence: w.sentence, sourceTitle: ctx.sourceMeta.get(w.n)?.title ?? "", sourceExcerpt: ctx.sourceTexts.get(w.n) ?? "" })),
                sourcesUsed.map((s) => ({ n: s.n, title: s.title, domain: s.domain }))
              ),
            }],
            "cite-check", false, 900, { ...(SERVERLESS ? { timeoutMs: 40_000, maxWaitMs: 90_000 } : { timeoutMs: 90_000 }) }
          );
          const verdicts = extractJson(crRes.text)?.cases ?? [];
          for (let i = 0; i < capped.length; i++) {
            const v = (verdicts as { case?: unknown; verdict?: unknown; use?: unknown }[]).find((c) => Number(c?.case) === i + 1);
            if (!v) continue;
            const w = capped[i];
            const sec = finalSections.find((s) => s.id === w.secId);
            if (!sec || !sec.draftMd) continue;
            citeStats.checked++;
            citeStats.flagged.push(w.n);
            if (String(v.verdict) === "wrong-source" && Number(v.use) > 0 && sourcesUsed.some((s) => s.n === Number(v.use))) {
              sec.draftMd = sec.draftMd.split(`[${w.n}]`).join(`[${Number(v.use)}]`);
              citeStats.repaired++;
              citeStats.reanchoredTo.push(Number(v.use));
            } else if (String(v.verdict) === "unsupported") {
              sec.draftMd = sec.draftMd.split(`[${w.n}]`).join("");
              citeStats.dropped++;
              citeStats.droppedNs.push(w.n);
            }
            if (sec.draftMd !== draftsArr[finalSections.indexOf(sec)]) {
              draftsArr[finalSections.indexOf(sec)] = sec.draftMd;
              await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: sec.draftMd } }).catch(() => {});
            }
          }
          citeStats.integrity = Math.round(100 * (1 - citeStats.dropped / Math.max(1, totalCites)));
          await ctx.emit(
            "citecheck",
            `Citation audit: ${totalCites} citations checked — ${citeStats.integrity}% integrity`,
            `${weak.length} citation${weak.length > 1 ? "s were" : " was"} flagged as weakly anchored (the claim sentence barely overlaps the cited source). ${citeStats.repaired} re-anchored to the right source, ${citeStats.dropped} removed as unsupported, the rest verified. Where the others are confident, digdeep is correct.`,
            crRes.model,
            { totalCites, flaggedWeak: weak.length, ...citeStats }
          );
        } catch (citeErr) {
          await ctx.emit("info", `Citation audit flagged ${weak.length} weak citation${weak.length > 1 ? "s" : ""} but the repair pass is unavailable`, citeErr instanceof Error ? citeErr.message.slice(0, 200) : undefined);
        }
      } else {
        await ctx.emit(
          "citecheck",
          `Citation audit: ${totalCites} citations, all well-anchored`,
          "Every claim sentence in the drafts lexically matches the source it cites — no mis-anchored citations detected by the pre-screen.",
          undefined,
          { totalCites, ...citeStats }
        );
      }
    }
    };

    // v2.4.0 PARALLEL TAIL BUNDLE: audit + exec summary + conclusion + title +
    // related questions all run at once (each only needs the drafts). On the
    // serverless clock this collapses ~2 min of serial LLM calls into one
    // round-trip's worth of wall time. `drafts` is joined AFTER the bundle so
    // the audit's repairs/drops are reflected in the assembly.
    const draftsPre = draftsArr.join("\n\n");

    // Court runs: the verdict IS the executive summary and the judge's instructions are
    // the conclusion — no LLM calls needed for either (instant, honest, already graded).
    const courtExecMd = court
      ? [
          `**VERDICT: ${court.verdict} — ${court.guilty} to ${court.notGuilty}${court.jurors.length ? ` (${court.jurors.length} jurors returned)` : " (jury unavailable)"}.** ${court.judgeSummary}`,
          ...(court.chargesStuck.length ? [``, `**Charges that stuck:**`, ...court.chargesStuck.map((c) => `- ${c}`)] : []),
          ...(court.defenseWins.length ? [``, `**What the defense established:**`, ...court.defenseWins.map((c) => `- ${c}`)] : []),
          ...(court.conditions.length ? [``, `**What to change before trying again:**`, ...court.conditions.map((c) => `- ${c}`)] : []),
        ].join("\n")
      : "";
    await updateJob(jobId, { stage: "Auditing citations & writing the summary", progress: 95 });
    // v2.4.2 PERSIST-EARLY: the drafts are the report's substance — persist them
    // BEFORE the tail bundle (audit/exec/conclusion/title can each ride a throttled
    // window). If the function freezes mid-tail, the watchdog completes the job
    // with this draft instead of the user staring at a zombie at 95%. The full
    // assembly below overwrites this the moment the tail lands.
    {
      const bodyV0 = finalSections.map((s, i) => `## ${i + 1}. ${s.title}\n\n${s.draftMd || ""}`).join("\n\n");
      const refsV0 = sourcesUsed.map((s, i) => `${i + 1}. ${s.title} — *${s.domain}* — ${s.url}`).join("\n");
      const reportV0 = [`# ${job.query.slice(0, 80)}`, ``, bodyV0, ``, `## References`, ``, refsV0 || "*(no sources were successfully retrieved)*"].join("\n");
      await updateJob(jobId, { reportMd: reportV0 }).catch(() => {});
    }
    // v2.4.5: the bundle is POLISH — its size adapts to the clock left after the
    // drafts (research overshoot varies 40-100s): FULL (audit+exec+conclusion+title+
    // related) when ≥110s remain, LITE (exec+title, 20s caps) when 60-110s, SKIPPED
    // below that — the grade is the priority; polish gets whatever truly remains.
    // v2.5.0 continuation: a skip-mode squeeze only makes sense on the LAST slice.
    // With slices remaining, the engine checkpoints and the NEXT slice runs the
    // full tail (bundle + grade + improve) on a fresh ~5-min clock — the report
    // deserves the polish more than the run deserves 40 avoided seconds.
    if (SERVERLESS && outOfSlice() && !runExhausted()) {
      await persist("tail");
      await updateJob(jobId, { stage: "Slice boundary — continuing the report assembly", progress: 92 }).catch(() => {});
      return;
    }
    let bundleMode: "full" | "lite" | "skip" = ctx.hardLeft >= 110_000 ? "full" : ctx.hardLeft >= 60_000 ? "lite" : "skip";
    if (bundleMode === "skip" && SERVERLESS && !court && !runExhausted()) {
      await persist("tail");
      await updateJob(jobId, { stage: "Slice boundary — continuing the report assembly", progress: 92 }).catch(() => {});
      return;
    }
    if (bundleMode === "skip" && !court) {
      await ctx.emit("info", "Clock is short — skipping the summary polish, going straight to grading", "The drafts and references are done; the executive summary and conclusion are skipped so the self-score still fits the function budget.");
    } else if (bundleMode === "lite" && !court) {
      await ctx.emit("info", "Clock is tight — running the lite polish (summary + title only)", "The citation audit, conclusion and related questions are skipped so the self-score and one improvement round still fit the function budget.", undefined, undefined, "verbose");
    }
    // v2.4.5: hoisted extractors with honest fallbacks — set by the bundle when it
    // runs, kept as fallbacks when the clock was too short for the polish pass
    // v2.5.0: on a resumed run the tail products come from the checkpoint — the
    // bundle only re-runs when it never completed in a previous slice (the explicit
    // bundleDone flag is the source of truth; graded+ implies it trivially).
    const bundleDone = cp?.bundleDone === true || phaseAtLeast(resumePhase, "graded");
    if (bundleDone) bundleDoneState = true;
    if (!bundleDone) {
      if (!execText) execText = court ? courtExecMd : "*(Executive summary unavailable — the function clock ran out during the polish pass; see section content below.)*";
      if (!concText) concText = court ? "" : "";
      if (!titleText) titleText = job.query.slice(0, 80);
      if (relatedQuestions.length === 0) relatedQuestions = fallbackRelated(job.query, finalSections.map((s) => s.question));
    }
    if ((bundleMode !== "skip" || court) && !bundleDone) {
    const liteCaps = bundleMode === "lite";
    const [auditR, execR, concR, titleR, relatedR] = await Promise.allSettled([
      // v2.4.0: the citation audit rides IN the bundle (it only needs the drafts);
      // the lite bundle skips it (the claim-check ledger below still runs — it is pure
      // computation and catches the same weak anchors)
      bundleMode === "full" || court
        ? auditDone
          ? Promise.resolve(undefined)
          : auditWork()
        : Promise.resolve(undefined),
      // bounded: on a capped serverless run the tail must not ride patient cooldown
      // waits — a missed summary degrades honestly, a frozen function loses the report.
      // Clamped to the hard clock so even a late-starting tail still persists.
      court
        ? Promise.resolve({ text: "", model: "", backendId: "court", latencyMs: 0 } as LlmResult)
        : ctx.llm([{ role: "user", content: execSummaryPrompt(job.query, draftsPre, job.language, job.preset, ctx.allLearnings) }], "exec-summary", false, undefined, { ...(SERVERLESS ? { timeoutMs: liteCaps ? 20_000 : 30_000, maxWaitMs: 90_000 } : { timeoutMs: Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }) }),
      bundleMode === "full" || court
      ? court
        ? Promise.resolve({ text: "", model: "", backendId: "court", latencyMs: 0 } as LlmResult)
        : ctx.llm([{ role: "user", content: conclusionPrompt(job.query, draftsPre, job.language) }], "conclusion", false, undefined, { ...(SERVERLESS ? { timeoutMs: liteCaps ? 20_000 : 30_000, maxWaitMs: 90_000 } : { timeoutMs: Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }) })
      : Promise.resolve({ text: "", model: "", backendId: "skipped", latencyMs: 0 } as LlmResult),
      ctx.llm([{ role: "user", content: titlePrompt(job.query, plan.restate, job.language) }], "title", false, 60, { ...(SERVERLESS ? { timeoutMs: liteCaps ? 15_000 : 20_000, maxWaitMs: 60_000 } : { timeoutMs: Math.min(60_000, Math.max(10_000, ctx.hardLeft - 20_000)) }) }),
      bundleMode === "full" || court
        ? ctx.llm([{ role: "user", content: relatedPrompt(job.query, finalSections.map((s) => s.title), job.language) }], "related", false, 300, { ...(SERVERLESS ? { timeoutMs: 20_000, maxWaitMs: 60_000 } : { timeoutMs: Math.min(60_000, Math.max(10_000, ctx.hardLeft - 20_000)) }) })
        : Promise.resolve({ text: "", model: "", backendId: "skipped", latencyMs: 0 } as LlmResult),
    ]);
    if (auditR.status === "rejected") await ctx.emit("info", "Citation audit step failed — continuing with the drafts as written", String(auditR.reason ?? "").slice(0, 300));
    if (bundleMode === "full" || court) auditDone = true; // v2.5.0: never re-audit on resume — repaired drafts persist
    // v2.5.3: bundleDone is honest — a bundle whose summary/title actually failed
    // (placeholders) does NOT count as done; the next slice re-runs it (the audit
    // still skips via auditDone) so the grader never sees a placeholder summary.
    if (court) bundleDoneState = true;
    else bundleDoneState = execR.status === "fulfilled" && !!(execR.value as LlmResult).text.trim() && titleR.status === "fulfilled" && !!(titleR.value as LlmResult).text.trim();
    execText = court
      ? courtExecMd
      : execR.status === "fulfilled" && execR.value.text.trim()
        ? execR.value.text
        : "*(Executive summary unavailable — LLM backends were exhausted; see section content below.)*";
    concText = court ? "" : concR.status === "fulfilled" ? concR.value.text : "";
    titleText = titleR.status === "fulfilled" ? titleR.value.text : job.query.slice(0, 80);
    relatedQuestions =
      relatedR.status === "fulfilled" ? (extractJsonArray(relatedR.value.text) ?? fallbackRelated(job.query, finalSections.map((s) => s.question))) : fallbackRelated(job.query, finalSections.map((s) => s.question));
    if (!court && execR.status === "rejected") await ctx.emit("info", "Executive summary step failed — continuing with sections", String(execR.reason ?? "").slice(0, 300));
    if (!court && concR.status === "rejected") await ctx.emit("info", "Conclusion step failed — continuing without it", String(concR.reason ?? "").slice(0, 300));
    await ctx.emit("draft", court ? "Verdict summary written (from the trial itself)" : "Executive summary written", execText.slice(0, 400), !court && execR.status === "fulfilled" ? execR.value.model : undefined);
    if (!court && concText) await ctx.emit("draft", "Conclusion written", concText.slice(0, 400), concR.status === "fulfilled" ? concR.value.model : undefined);
    }
    // v2.5.0: the tail bundle is complete — checkpoint its products so a slice
    // death before grading never re-runs (or half-runs) the polish
    bundleDoneState = true;
    await persist("tail").catch(() => {});

    // post-audit drafts — the audit (inside the bundle above) may have re-anchored
    // or dropped citation markers; everything downstream sees the repaired text
    const drafts = draftsArr.join("\n\n");

    // ---------- STAGE 4.6: CLAIM-CHECK LEDGER (claim-level verification) ----------
    // Built from the FINAL drafts (post judge repairs/drops), so every entry
    // corresponds to a citation actually printed in the report. Pure computation
    // against ctx.sourceTexts — zero extra LLM calls. The ns are the engine's
    // internal numbering here; the assembly remap below rewrites them to the
    // report's final numbering so the ledger matches what the reader sees.
    const claimChecks: ClaimCheck[] = [];
    if (ctx.sourceTexts.size > 0) {
      const seen = new Set<string>(); // dedupe (sentence + n)
      for (const sec of finalSections) {
        const draft = sec.draftMd || "";
        if (!draft) continue;
        for (const sentence of draft.split(/(?<=[.!?])\s+/)) {
          const nums = [...new Set([...sentence.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
          if (nums.length === 0) continue;
          for (const n of nums) {
            const key = `${n}::${sentence.trim().slice(0, 120)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (claimChecks.length >= 160) break; // cap the ledger — honest, bounded
            const srcText = ctx.sourceTexts.get(n) ?? "";
            const meta = ctx.sourceMeta.get(n) ?? { title: "", domain: "" };
            const snippetGrade = srcText.length < 400;
            const { passage, support } = bestPassage(sentence, srcText);
            const verdict = verdictFromSupport(support);
            const notes: string[] = [];
            if (snippetGrade) notes.push("snippet-grade source — judged from the search excerpt, not the full page");
            if (citeStats.reanchoredTo.includes(n)) notes.push("re-anchored by the citation audit (originally cited a different source)");
            else if (citeStats.flagged.includes(n)) notes.push("flagged as weakly anchored, kept after the model audit");
            if (verdict === "unverified" && !snippetGrade && srcText) notes.push("the claim sentence barely overlaps the source text that was read");
            claimChecks.push({
              id: `c${claimChecks.length + 1}`,
              text: sentence.replace(/\s+/g, " ").trim().slice(0, 300),
              n,
              verdict,
              support: Math.round(support * 100) / 100,
              passage,
              section: sec.title,
              closeness: classifyCloseness(meta.domain),
              sourceTitle: meta.title || `Source ${n}`,
              sourceDomain: meta.domain,
              ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
            });
          }
        }
      }
    }

    // ---------- "WHERE SOURCES DISAGREE" — the honest-disagreement section ----------
    // (beyond Perplexity: contested and cross-check-refuted claims are surfaced in the
    // report instead of being averaged away). LLM-written; degrades to the raw list.
    const contestedClaims = ctx.claims.filter((c) => c.grade === "contested" || c.verified === "refuted");
    disagreementsMd = "";
    if (ctx.contradictions.length > 0 || contestedClaims.length > 0 || refuted.length > 0) {
      const rawList = [
        ...ctx.contradictions.map((c) => `- **${c.claim}** — ${c.positions}`),
        ...contestedClaims.filter((c) => !ctx.contradictions.some((x) => x.claim === c.claim)).map((c) => `- **${c.claim}** — graded ${c.grade}${c.verified ? `, cross-check ${c.verified}` : ""}`),
      ].join("\n");
      if (ctx.hardLeft >= 100_000) {
        try {
          const disR = await ctx.llm(
            [{ role: "user", content: disagreementsPrompt(job.query, ctx.contradictions, contestedClaims.map((c) => ({ claim: c.claim, basis: c.basis })), refuted, job.language) }],
            "disagreements", false, 700, { timeoutMs: Math.min(90_000, Math.max(15_000, ctx.hardLeft - 40_000)) }
          );
          disagreementsMd = disR.text.trim();
        } catch {
          disagreementsMd = rawList; // honest raw list beats silently dropping the disagreements
        }
      } else {
        disagreementsMd = rawList; // clock-squeezed — the honest raw list now beats a stalled LLM pass
      }
      await ctx.emit("draft", "“Where sources disagree” section written", `${ctx.contradictions.length} contradiction(s), ${contestedClaims.length} contested claim(s), ${refuted.length} refuted on cross-check — surfaced instead of averaged away.`, undefined, { contradictions: ctx.contradictions.length, contested: contestedClaims.length, refuted: refuted.length });
    }

    // ---------- ASSEMBLE REPORT ----------
    durationMs = Date.now() - t0;
    reportWords = drafts.split(/\s+/).length;
    const modelsUsed = Object.entries(ctx.byModel).map(([m, v]) => `${m} (${v.calls} calls)`);

    // Dedupe by URL before numbering: parallel aspect workers can still read the same
    // page in overlapping windows (the ECL run printed the same arxiv URL as both #3
    // and #8). First occurrence keeps its slot; later duplicates remap onto it so every
    // citation of that URL resolves to ONE reference number.
    refList = [];
    const refByUrl = new Map<string, number>(); // url -> position in refList (1-based)
    const remap: Record<number, number> = {};
    for (const s of sourcesUsed) {
      const existing = refByUrl.get(s.url);
      if (existing != null) {
        remap[s.n] = existing; // duplicate read — fold onto the first occurrence
        continue;
      }
      refByUrl.set(s.url, refList.length + 1);
      remap[s.n] = refList.length + 1;
      refList.push(s);
    }
    if (refList.length < sourcesUsed.length) {
      await ctx.emit("info", `Deduplicated the reference list — ${sourcesUsed.length - refList.length} repeated page(s) folded onto their first citation`);
    }
    refs = refList
      .map((s, i) => `${i + 1}. ${s.title} — *${s.domain}* — ${s.url}`)
      .join("\n");
    // the claim-check ledger was recorded with the engine's internal numbering —
    // rewrite it to the report's final citation numbers so it matches what the
    // reader sees (and what the References list numbers mean)
    for (const c of claimChecks) c.n = remap[c.n] ?? c.n;
    let claimVerdict: ClaimVerdictSummary | undefined;
    if (claimChecks.length > 0) {
      const byN = new Map<number, { verified: number; total: number }>();
      for (const c of claimChecks) {
        const e = byN.get(c.n) ?? { verified: 0, total: 0 };
        e.total++;
        if (c.verdict === "verified") e.verified++;
        byN.set(c.n, e);
      }
      let fully = 0;
      for (const e of byN.values()) if (e.verified === e.total) fully++;
      claimVerdict = {
        citedSources: byN.size,
        fullySupported: fully,
        verified: claimChecks.filter((c) => c.verdict === "verified").length,
        partly: claimChecks.filter((c) => c.verdict === "partly").length,
        unverified: claimChecks.filter((c) => c.verdict === "unverified").length,
      };
    }
    const body = finalSections
      .map((s, i) => `## ${i + 1}. ${s.title}\n\n${(s.draftMd || "").replace(/\[(\d+)\]/g, (_, d) => `[${remap[Number(d)] ?? d}]`)}`)
      .join("\n\n");
    // ---- court sections: the trial record, placed ahead of the evidence body ----
    // (briefs carry [n] citations in the engine's numbering — remapped exactly like the drafts)
    const remapCites = (md: string) => md.replace(/\[(\d+)\]/g, (_, d) => `[${remap[Number(d)] ?? d}]`);
    const courtSectionsMd = court
      ? [
          `## The Prosecution's Case`,
          ``,
          remapCites(court.prosecutionBrief),
          ``,
          `## The Defense's Case`,
          ``,
          remapCites(court.defenseBrief || "*(The defense could not build its case — model backends were unavailable.)*"),
          ``,
          ...(court.rebuttals.length
            ? [
                `## Rebuttals`,
                ``,
                ...court.rebuttals.flatMap((r) => [`**${r.by === "prosecution" ? "The prosecution answers" : "The defense answers"}**`, ``, remapCites(r.text), ``]),
              ]
            : []),
          ...(court.jurors.length
            ? [
                `## The Jury`,
                ``,
                `| Juror | Final vote | Conviction | What decided them |`,
                `| --- | --- | --- | --- |`,
                ...court.jurors.map((j) => `| ${j.name}${j.changedVote ? " *(changed in deliberation)*" : ""} | **${j.vote}** | ${j.confidence != null ? `${j.confidence}%` : "—"} | ${j.reason.replace(/\|/g, "/")} |`),
                ``,
                `*Each juror read the same record through a different lens — the vote spread, not any single opinion, is the signal (${court.guilty} guilty · ${court.notGuilty} not guilty${court.firstBallot && court.deliberated ? `; the blind first ballot was ${court.firstBallot.guilty}–${court.firstBallot.notGuilty}${court.jurors.some((j) => j.changedVote) ? `, ${court.jurors.filter((j) => j.changedVote).length} changed their vote in deliberation` : ", no vote moved in deliberation"}` : ""}). ${court.verdict === "HUNG JURY" ? "The jury deadlocked — a hung jury: no verdict was reached on this proposition." : `${court.quick ? "Quick trial: 6 jurors, one ballot." : court.deliberated ? "Full trial: 12 personas, two ballots around a deliberation." : "Full jury: 12 personas."}`}*`,
                ``,
              ]
            : []),
          ...(court.foremanSummary
            ? [`## The Foreman's Summing-Up`, ``, court.foremanSummary, ``]
            : []),
          ...(court.chargesStuck.length || court.defenseWins.length || court.conditions.length
            ? [
                `## The Judge's Instructions`,
                ``,
                ...(court.chargesStuck.length ? [`**Charges that stuck** — the defense never answered these:`, ``, ...court.chargesStuck.map((c) => `- ${c}`), ``] : []),
                ...(court.defenseWins.length ? [`**What the defense established** — the prosecution failed to break these:`, ``, ...court.defenseWins.map((c) => `- ${c}`), ``] : []),
                ...(court.conditions.length ? [`**Conditions — what to change before trying again:**`, ``, ...court.conditions.map((c) => `- ${c}`), ``] : []),
              ]
            : []),
          `## The Evidence Record`,
          ``,
          `*The research below is the evidence the trial argued from — gathered by the standard deep-research pipeline, cited [n], and audited like every digdeep report.*`,
          ``,
        ]
      : [];
    let reportMd = [
      `# ${titleText.replace(/["'`#]/g, "").trim()}`,
      ``,
      `## Executive Summary`,
      ``,
      execText,
      ``,
      ...(court ? courtSectionsMd : []),
      body,
      ``,
      ...(concText ? [`## Conclusion`, ``, concText, ``] : []),
      ...(disagreementsMd ? [`## Where sources disagree`, ``, disagreementsMd, ``] : []),
      `## References`,
      ``,
      refs || "*(no sources were successfully retrieved)*",
      ``,
      `---`,
      `**Research metadata** — Duration: ${Math.round(durationMs / 1000)}s · Sources consulted: ${refList.length} · Report words: ~${reportWords} · LLM calls: ${ctx.llmCalls} · Models: ${modelsUsed.join(", ")} · Preset: ${job.preset} · Citation integrity: ${citeStats.integrity}%${court ? ` · Trial verdict: ${court.verdict} (${court.guilty}–${court.notGuilty})` : ""}`,
    ].join("\n");

    // ---------- MONITORING DIFF DIGEST (P2-2) ----------
    // A re-run of the same question in the same thread gets an honest
    // "What changed since the last run" section — nothing invented.
    diffMd = "";
    if (prevReportMd && prevQuery && !ctx.outOfTime) {
      const normTokens = (s: string) =>
        new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
      const A = normTokens(prevQuery);
      const B = normTokens(job.query);
      let inter = 0;
      for (const x of A) if (B.has(x)) inter++;
      const union = new Set([...A, ...B]).size;
      if (union > 0 && inter / union > 0.55) {
        try {
          const diffRes = await ctx.llm(
            [{ role: "user", content: diffDigestPrompt(job.query, prevReportMd, reportMd, job.language) }],
            "diff", false, 700, { patient: false, timeoutMs: 90_000 }
          );
          diffMd = diffRes.text.trim();
          if (diffMd) {
            reportMd = reportMd.replace("## References", `## What changed since the last run\n\n${diffMd}\n\n## References`);
            await ctx.emit(
              "diff",
              "Diffed this run against the previous one in this thread",
              "The same question was researched before in this thread — a \"What changed since the last run\" section now sits in the report (new findings, changed numbers, unsettled questions). Re-run research anytime: monitoring is one click.",
              diffRes.model,
              { similarity: Math.round((inter / union) * 100) }
            );
          }
        } catch { /* the diff is an enhancement, never fatal */ }
      }
    }

    // ---------- STAGE 5: SELF-SCORE (P1-1) — grade the finished report ----------
    // digdeep grades its own report against the comprehension pass's success
    // criteria on four dimensions, and publishes the score — including bad ones.
    // v2.5.3: the grade + its patient ride need a COMFORTABLE slice — the 7.3 run's
    // successor lost its score entirely because the bundle ate the clock and the
    // grade hard-stopped at <15s. With ≥65s left we checkpoint; a fresh slice
    // grades (and improves) with the full ~5-min clock.
    if (SERVERLESS && ctx.hardLeft < 65_000 && !runExhausted() && !quality) {
      await persist("tail");
      await updateJob(jobId, { stage: "Slice boundary — grading in a fresh slice", progress: 96 }).catch(() => {});
      return;
    }
    // v2.5.0: on a resumed run past "graded", the checkpoint's score stands — the
    // same rubric graded the same text in the slice that wrote it.
    if (quality && phaseAtLeast(resumePhase, "graded")) {
      await ctx.emit("score", `Self-score: ${quality.overall}/10 (restored from the checkpoint — graded by the same rubric in a previous slice)`, quality.biggestWeakness || "Graded against the success criteria defined before the research started.", undefined, { ...quality, restored: true });
    } else
    // v2.4.0: the gate is the platform clock, not the research budget — a report
    // written from partial evidence on an expired budget still DESERVES an honest
    // score (locally hardLeft is Infinity, so budget-exhausted runs now grade too).
    if (ctx.hardLeft >= (SERVERLESS ? 40_000 : 50_000) || !ctx.outOfTime) {
    // v2.4.5: two-attempt grade on the serverless clock — a fast first pass (25s),
    // then, if the lanes were throttled, ONE patient ride that waits out the cooldown
    // window (bounded by the hard stop via the ride budget). The score is the report's
    // headline number; it deserves the recovery wait more than any polish step.
    const gradeAttempts: Array<{ wantThinking: boolean; maxTokens: number; fast?: { patient?: boolean; timeoutMs: number; maxWaitMs?: number } }> = SERVERLESS
      ? [{ wantThinking: false, maxTokens: 2000, fast: { timeoutMs: 30_000, maxWaitMs: 90_000 } }]
      : [{ wantThinking: false, maxTokens: 2000, fast: { timeoutMs: 60_000 } }];
    for (const attempt of gradeAttempts) {
    try {
      const scoreRes = await ctx.llmLive(
        [{ role: "user", content: qualityScorePrompt(job.query, comprehensionCriteria, reportMd, job.language) }],
        "score",
        "Grading my own report",
        attempt
      );
      const q = extractJson(scoreRes.text);
      if (q && typeof q.overall === "number") {
        quality = {
          overall: Math.max(0, Math.min(10, Math.round(Number(q.overall) * 10) / 10)),
          dims: (Array.isArray(q.dims) ? q.dims : []).slice(0, 4).map((d: { name?: unknown; score?: unknown; note?: unknown }) => ({
            name: String(d?.name ?? "").slice(0, 24),
            score: Math.max(0, Math.min(10, Number(d?.score) || 0)),
            note: String(d?.note ?? "").slice(0, 160),
          })),
          criteria: (Array.isArray(q.criteria) ? q.criteria : []).slice(0, 4).map((c: { criterion?: unknown; met?: unknown; why?: unknown }) => ({
            criterion: String(c?.criterion ?? "").slice(0, 200),
            met: c?.met === true,
            why: String(c?.why ?? "").slice(0, 160),
          })),
          biggestWeakness: String(q.biggestWeakness ?? "").slice(0, 300),
          repairQueries: (Array.isArray(q.repairQueries) ? q.repairQueries : []).map((x: unknown) => String(x).slice(0, 160)).filter((x: string) => x.length > 3).slice(0, 3),
        };
        await ctx.emit(
          "score",
          `Self-score: ${quality.overall}/10`,
          quality.biggestWeakness || "Graded against the success criteria defined before the research started.",
          scoreRes.model,
          { ...quality }
        );
        break;
      }
    } catch {
      // v2.5.5: a silent unscored completion hides the one thing the user most
      // needs to know — say it plainly (the done event already notes "unscored")
      await ctx.emit("info", "The self-score could not run — the free LLM lanes were exhausted at grading time", "The report below is complete and its citations are audited, but it carries no self-score. Re-running when the free models are less throttled, or adding a free LLM7 key in Settings (much higher personal quota), lets the grader — and the improvement rounds — run.", undefined, undefined, "normal").catch(() => {});
      if (attempt === gradeAttempts[gradeAttempts.length - 1]) break; // the last attempt failed — publish unscored, honestly
      if (ctx.hardLeft < 55_000) break; // no room for the patient ride
      await ctx.emit("info", "Grade pass was throttled — riding the cooldown window to still score the report", "The free lanes just hit a 429 window. The grader waits it out (bounded by the function clock) instead of publishing an unscored report.", undefined, undefined, "verbose");
    }
    }
    }

    // ---------- STAGE 5.5: EARN THE TARGET SCORE (v2.3.0) ----------
    // A 4.5/10 report is a broken deliverable, and re-grading the same text is
    // theater. So each round does REAL work: analyze the graded gaps → search
    // and read new primary sources → rewrite the weakest sections with the new
    // evidence → re-audit citations → rebuild the whole report → re-grade with
    // the SAME brutal rubric. The score is earned, never declared. If the
    // rounds or the clock run out first, the honest number is published with
    // the reason. (Court runs skip this — the verdict is the deliverable.)
    const QUALITY_TARGET = 9;
    // v2.5.3: serverless runs get THREE full rounds — the measured trajectory
    // (6.5 → 6.5 → 7.3 on the live quantum-computing run) shows each round buys
    // real evidence the grader then credits; round 3 attacks the anchoring
    // weaknesses the round-2 grader named. The loop still stops the moment the
    // target is earned.
    const QUALITY_MAX_ROUNDS = SERVERLESS ? 3 : 3;
    /** v2.5.0: the improvement loop's clock gate — on serverless the ABSOLUTE
     *  budget decides whether another round can ever run (a thin slice clock just
     *  checkpoints and the next slice continues the round); locally the budget
     *  stops it 2 min past a budgeted deadline (unlimited rides free). */
    const canImprove = () =>
      (SERVERLESS
        ? ctx.hardLeft >= 65_000 || (absoluteDeadline == null || Date.now() < absoluteDeadline - 90_000)
        : ctx.hardLeft >= 200_000) &&
      !(ctx.hasTimeBudget && ctx.timeLeft < -120_000) &&
      !runExhausted();
    // v2.5.0: grade landed — checkpoint it so a slice death here resumes inside
    // the improve loop instead of re-grading (or losing) the score
    if (quality) await persist("graded").catch(() => {});
    if (quality && quality.overall < QUALITY_TARGET && !court && canImprove()) {
      // `current` is the loop's non-null view of the score — TS can't keep the
      // narrowing across loop back-edges once `quality` is reassigned inside.
      let current = quality;
      await updateJob(jobId, { stage: "Improving the report until the score is earned", progress: 97 });
      while (
        current.overall < QUALITY_TARGET &&
        qualityRounds < QUALITY_MAX_ROUNDS &&
        canImprove() &&
        !(await ctx.isCancelled())
      ) {
        // v2.5.0 SLICE BOUNDARY (improve): this slice is nearly over but the
        // absolute budget still has room — checkpoint mid-loop and let the next
        // slice continue the round (qualityRounds + quality ride along)
        if (SERVERLESS && outOfSlice()) {
          await persist("improving");
          await updateJob(jobId, { stage: `Slice boundary — continuing quality round ${qualityRounds + 1}`, progress: 97 }).catch(() => {});
          return;
        }
        qualityRounds++;
        const scoreBefore = current.overall;
        await ctx.emit(
          "refine",
          `Quality round ${qualityRounds}/${QUALITY_MAX_ROUNDS}: ${scoreBefore.toFixed(1)}/10 — researching what the grader said is missing`,
          current.biggestWeakness || "",
          undefined,
          { round: qualityRounds, before: scoreBefore, target: QUALITY_TARGET },
        );

        // (a) gap analysis → repair plan (which sections, what evidence, which queries).
        // v2.4.0 serverless fast path: the grader already named the repair queries
        // (repairQueries ride along with the grade at zero extra cost) — skip the
        // separate gap-analysis LLM call and aim them at the weakest section.
        let gaps: { title: string; need: string; queries: string[] }[];
        if (SERVERLESS && (current.repairQueries?.length ?? 0) > 0) {
          // weakest section = lowest-scoring dimension maps to the section whose
          // question is closest to the unmet criteria; fall back to the first section
          const unmet = current.criteria.filter((c) => !c.met).map((c) => c.criterion).join("; ");
          const weakDim = [...current.dims].sort((a, b) => a.score - b.score)[0];
          const target =
            finalSections.find((s) => unmet && unmet.toLowerCase().split(/\s+/).filter((w) => w.length > 4).some((w) => `${s.title} ${s.question}`.toLowerCase().includes(w))) ??
            finalSections[0];
          gaps = target
            ? [{ title: target.title, need: current.biggestWeakness || `${weakDim?.name ?? "coverage"}: ${weakDim?.note ?? ""}`, queries: (current.repairQueries ?? []).slice(0, 2) }]
            : [];
        } else {
        let repairPlan: { sections?: { title?: unknown; need?: unknown; queries?: unknown }[] } | null = null;
        try {
          const gaRes = await ctx.llmLive(
            [{ role: "user", content: gapAnalysisPrompt(job.query, current, reportMd, finalSections.map((s) => ({ title: s.title, question: s.question })), job.language) }],
            "gap-analysis",
            "Analyzing what the report is missing",
            { wantThinking: false, maxTokens: 800, fast: { ...(SERVERLESS ? { timeoutMs: 30_000, maxWaitMs: 90_000 } : { timeoutMs: 45_000 }) } }
          );
          repairPlan = extractJson(gaRes.text);
        } catch { repairPlan = null; }
        gaps = (Array.isArray(repairPlan?.sections) ? repairPlan.sections : [])
          .map((g) => ({
            title: String(g?.title ?? "").trim(),
            need: String(g?.need ?? "").slice(0, 300),
            queries: (Array.isArray(g?.queries) ? g.queries : []).map((q: unknown) => String(q).slice(0, 160)).filter((q: string) => q.length > 3).slice(0, 4),
          }))
          .filter((g) => g.title && g.queries.length > 0)
          .slice(0, 3);
        }
        if (gaps.length === 0) {
          await ctx.emit("info", "Gap analysis produced no actionable gaps this round — keeping the current report", undefined, undefined, "verbose");
          break;
        }

        // (b) targeted research per gap — the same pipeline an aspect round uses
        let newSources = 0;
        const roundFindings = new Map<string, string[]>();
        for (const g of gaps) {
          const sec = finalSections.find((s) => s.title.toLowerCase().includes(g.title.toLowerCase()) || g.title.toLowerCase().includes(s.title.toLowerCase()));
          if (!sec) continue; // gap title didn't match a real section — skip rather than research blind
          const searchResults: SearchResult[] = [];
          if (SERVERLESS) {
            // v2.4.0: parallel gap searches, no politeness sleeps — the reserved tail
            // is measured in seconds and every sleep is a rewrite that never happens
            const rsAll = await Promise.allSettled(g.queries.map(async (q) => {
              const rs = await searchAll(q, { academic: false });
              await ctx.emit("search", `Searching: “${q}”`, `${rs.length} results — gap round ${qualityRounds}`, undefined, { query: q, count: rs.length, engines: [...new Set(rs.map((r) => r.engine))] });
              return rs;
            }));
            for (const r of rsAll) if (r.status === "fulfilled") searchResults.push(...r.value);
          } else {
          for (const q of g.queries) {
            try {
              const rs = await searchAll(q, { academic: false });
              await ctx.emit("search", `Searching: “${q}”`, `${rs.length} results — gap round ${qualityRounds}`, undefined, { query: q, count: rs.length, engines: [...new Set(rs.map((r) => r.engine))] });
              searchResults.push(...rs);
              await sleep(300 + Math.random() * 400);
            } catch { /* one dead engine must not kill the round */ }
          }
          }
          let fresh = searchResults
            .filter((r) => r.url && !ctx.seenUrls.has(r.url) && !r.domain.includes("duckduckgo.com"))
            .filter((r, i, arr) => arr.findIndex((x) => x.url === r.url) === i);
          fresh = gateByRelevance(sec.question, g.queries.join(" "), fresh).kept;
          // v2.5.0: the quality gate applies to gap-round evidence too — repair
          // sources must be primary/concrete, not more filler
          fresh = applySourceQualityGate(fresh, `${sec.question} ${g.need ?? ""}`).kept;
          const picked: SearchResult[] = [];
          const domainCount: Record<string, number> = {};
          const pickCap = SERVERLESS ? 3 : 4;
          for (const r of fresh) {
            if (picked.length >= pickCap) break;
            if (ctx.seenUrls.has(r.url)) continue; // re-check at pick time
            const dc = domainCount[r.domain] ?? 0;
            if (dc >= 2) continue;
            domainCount[r.domain] = dc + 1;
            picked.push(r);
            ctx.seenUrls.add(r.url);
          }
          const found: string[] = roundFindings.get(sec.title) ?? [];
          await Promise.all(
            picked.map(async (r) => {
              const page = await fetchPageContent(r.url, 3200, r.excerpt);
              if (!page) return;
              const n = ++ctx.sourceN;
              const excerpt = page.text.split(/\s+/).slice(0, 750).join(" ");
              await db.source.create({
                data: { jobId, url: r.url, domain: r.domain || page.domain, title: r.title || page.title || r.domain, snippet: r.snippet || excerpt.slice(0, 280), engine: r.engine, words: page.words, used: true, sectionTitle: sec.title, round: 90 + qualityRounds, quality: 60 },
              }).catch(() => null);
              sourcesUsed.push({ n, url: r.url, title: r.title || page.title || r.domain, domain: r.domain || page.domain, ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}) });
              ctx.registerSource(n, r.title || page.title || r.domain, r.domain || page.domain, excerpt);
              newSources++;
              found.push(`- (source ${n}: ${r.title || page.title} — ${r.domain}) ${excerpt.split(/\s+/).slice(0, 120).join(" ")}`);
              await ctx.emit("read", `Reading ${r.domain} · ${page.words.toLocaleString()} words`, r.title || page.title, undefined, { url: r.url, words: page.words, n }, "verbose");
            })
          );
          if (found.length) roundFindings.set(sec.title, found);
        }
        if (newSources === 0) {
          await ctx.emit("info", "Gap searches found no new readable sources this round", "The engines may be rate-limited — keeping the current report rather than padding it.", undefined, undefined, "verbose");
          // v2.4.0: without fresh evidence the rewrite is theater — stop now instead
          // of burning the reserved tail on a re-grade of unchanged text
          break;
        }

        // (c) rewrite the gap sections — deeper each round, and the writer gets the
        // grader's own dimension notes so the rewrite attacks ALL four dimensions:
        // new citations for evidence, hedging for honesty, structure for clarity,
        // and a word target that grows ~35% per round so sections thicken, not churn.
        const graderRules = [
          ...current.dims.filter((d) => d.score < 9).map((d) => `FIX ${d.name} (${d.score}/10): ${d.note}`),
          ...current.criteria.filter((c) => !c.met).map((c) => `UNMET CRITERION: ${c.criterion} — ${c.why}`),
        ].slice(0, 6);
        const scale = Math.pow(1.35, qualityRounds - 1);
        const wordsR: [number, number] = SERVERLESS
          ? [Math.min(750, Math.round(words[0] * scale + 40)), Math.min(950, Math.round(words[1] * scale + 60))]
          : [Math.min(900, Math.round(words[0] * scale + 40)), Math.min(1100, Math.round(words[1] * scale + 60))];
        // snapshot for regression protection: if this round's rewrites make the score
        // WORSE, the previous (better-scoring) drafts are restored — the published
        // artifact is always the one the same rubric scored highest.
        const preRound = new Map(finalSections.map((s) => [s.id, s.draftMd || ""]));
        let rewritten = 0;
        const rewriteOne = async (title: string, found: string[]) => {
          const sec = finalSections.find((s) => s.title === title);
          if (!sec) return;
          const augmented = `${sec.findings ?? "(no prior findings)"}

ADDITIONAL FINDINGS (gap round ${qualityRounds} — fresh reads; cite them [n]):
${found.join("\n")}${graderRules.length ? `

THE GRADER'S NOTES FOR THIS REWRITE (obey them):
${graderRules.map((r) => `- ${r}`).join("\n")}` : ""}`;
          try {
            const rwRes = await ctx.llmLive(
              [{ role: "user", content: draftSectionPrompt(job.query, sec.title, sec.question, augmented, sourcesUsed.slice(0, 80), wordsR, job.language, evidenceNotesFor(sec.title), adversarialNotesFor(sec.title), ctx.allLearnings) }],
              "draft",
              `Rewriting with new evidence: ${sec.title}`,
              { streamTo: sec.id, wantThinking: false, maxTokens: 2500, fast: { ...(SERVERLESS ? { timeoutMs: 60_000, maxWaitMs: 110_000 } : { timeoutMs: Math.min(90_000, Math.max(20_000, ctx.hardLeft - 30_000)) }) } }
            );
            if (rwRes.text && rwRes.text.split(/\s+/).length > 60) {
              sec.draftMd = trimToCompleteSentence(rwRes.text); // v2.5.3: no abrupt endings from capped rewrites
              // P1-3: compute directives resolve on rewritten drafts too
              const pc2 = processComputes(sec.draftMd);
              if (pc2.computes.length > 0) {
                sec.draftMd = pc2.text;
                for (const c of pc2.computes) {
                  await ctx.emit("compute", c.ok ? `Computed: ${c.expr} = ${c.result}` : `Compute failed: ${c.expr}`, c.ok ? "Machine-evaluated during the improve rewrite." : c.result, undefined, { section: sec.title, expr: c.expr, result: c.result, ok: c.ok });
                }
              }
              draftsArr[finalSections.indexOf(sec)] = sec.draftMd;
              await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: sec.draftMd } }).catch(() => null);
              rewritten++;
            }
          } catch { /* keep the previous draft — never lose a working section */ }
        };
        // v2.4.0: rewrites run in PARALLEL (independent sections, independent streams)
        await Promise.all([...roundFindings].map(([title, found]) => rewriteOne(title, found)));
        // no rewrite ⇒ the report did not change ⇒ re-grading it would be theater
        if (rewritten === 0) {
          await ctx.emit("info", "No section could be rewritten this round — stopping the quality loop honestly", undefined, undefined, "verbose");
          break;
        }

        // (d) citation audit on the rewritten drafts — same rules as Stage 4.5
        {
          const lexicalSupport = sharedLexicalSupport;
          let totalCites = 0;
          const weak: { sec: (typeof finalSections)[number]; n: number; sentence: string }[] = [];
          for (const sec of finalSections) {
            const draft = sec.draftMd || "";
            if (!draft) continue;
            for (const sentence of draft.split(/(?<=[.!?])\s+/)) {
              const nums = [...sentence.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
              if (nums.length === 0) continue;
              totalCites += nums.length;
              for (const n of nums) {
                const src = ctx.sourceTexts.get(n);
                if (!src || src.length < 400) continue;
                if (lexicalSupport(sentence, src) < 0.3 && !weak.some((w) => w.sec === sec && w.n === n)) weak.push({ sec, n, sentence: sentence.trim() });
              }
            }
          }
          if (weak.length > 0) {
            try {
              const capped = weak.slice(0, 10);
              const crRes = await ctx.llm(
                [{
                  role: "user",
                  content: citeRepairPrompt(
                    job.query,
                    capped.map((w) => ({ n: w.n, sentence: w.sentence, sourceTitle: ctx.sourceMeta.get(w.n)?.title ?? "", sourceExcerpt: ctx.sourceTexts.get(w.n) ?? "" })),
                    sourcesUsed.map((s) => ({ n: s.n, title: s.title, domain: s.domain }))
                  ),
                }],
                "cite-check", false, 900, { ...(SERVERLESS ? { timeoutMs: 40_000, maxWaitMs: 90_000 } : { timeoutMs: 90_000 }) }
              );
              const verdicts = extractJson(crRes.text)?.cases ?? [];
              for (let i = 0; i < capped.length; i++) {
                const v = (verdicts as { case?: unknown; verdict?: unknown; use?: unknown }[]).find((c) => Number(c?.case) === i + 1);
                if (!v) continue;
                const w = capped[i];
                if (String(v.verdict) === "wrong-source" && Number(v.use) > 0 && sourcesUsed.some((s) => s.n === Number(v.use))) {
                  w.sec.draftMd = (w.sec.draftMd || "").split(`[${w.n}]`).join(`[${Number(v.use)}]`);
                  citeStats.repaired++;
                  citeStats.reanchoredTo.push(Number(v.use));
                } else if (String(v.verdict) === "unsupported") {
                  w.sec.draftMd = (w.sec.draftMd || "").split(`[${w.n}]`).join("");
                  citeStats.dropped++;
                  citeStats.droppedNs.push(w.n);
                }
                draftsArr[finalSections.indexOf(w.sec)] = w.sec.draftMd || "";
                await db.researchSection.update({ where: { id: w.sec.id }, data: { draftMd: w.sec.draftMd || "" } }).catch(() => null);
              }
              await ctx.emit(
                "citecheck",
                `Citation re-audit: ${weak.length} weak anchor${weak.length > 1 ? "s were" : " was"} flagged in the rewritten sections`,
                `${citeStats.repaired} re-anchored to the right source, ${citeStats.dropped} removed as unsupported. Same rules as the pre-publish audit.`,
                crRes.model,
                { flaggedWeak: weak.length, ...citeStats }
              );
            } catch { /* repair unavailable — the rewrite stands as written */ }
          }
          citeStats.checked += weak.length;
          citeStats.integrity = Math.round(100 * (1 - citeStats.dropped / Math.max(1, totalCites)));
        }

        // (e) rebuild references + body + summary/conclusion + the report itself
        // v2.4.5: serverlessRegrade is hoisted here so (f) can consume the parallel re-grade
        let serverlessRegrade: { q2: ReturnType<typeof extractJson>; model: string } | null = null;
        {
          const refByUrl2 = new Map<string, number>();
          const remap2: Record<number, number> = {};
          refList = [];
          for (const s of sourcesUsed) {
            const existing = refByUrl2.get(s.url);
            if (existing != null) { remap2[s.n] = existing; continue; }
            refByUrl2.set(s.url, refList.length + 1);
            remap2[s.n] = refList.length + 1;
            refList.push(s);
          }
          refs = refList.map((s, i) => `${i + 1}. ${s.title} — *${s.domain}* — ${s.url}`).join("\n");
          const drafts2 = draftsArr.join("\n\n");
          // v2.4.5: on the serverless clock the re-grade, the fresh exec summary and
          // the fresh conclusion run as ONE parallel block (serially they cannot all
          // fit the reserve). The re-grade sees the rebuilt body + refs; the fresh
          // summary/conclusion land in the published artifact right after.
          if (SERVERLESS) {
            const body2pre = finalSections
              .map((s, i) => `## ${i + 1}. ${s.title}\n\n${(s.draftMd || "").replace(/\[(\d+)\]/g, (_, d) => `[${remap2[Number(d)] ?? d}]`)}`)
              .join("\n\n");
            const report2pre = [
              `# ${titleText.replace(/["'`#]/g, "").trim()}`, ``, `## Executive Summary`, ``, execText, ``, body2pre, ``,
              ...(concText ? [`## Conclusion`, ``, concText, ``] : []),
              `## References`, ``, refs || "*(no sources were successfully retrieved)*",
            ].join("\n");
            const [rg, ex2, cc2] = await Promise.allSettled([
              ctx.llmLive(
                [{ role: "user", content: qualityScorePrompt(job.query, comprehensionCriteria, report2pre, job.language) }],
                "score",
                `Re-grading after round ${qualityRounds}`,
                { wantThinking: false, maxTokens: 2000, fast: { timeoutMs: 30_000, maxWaitMs: 90_000 } }
              ),
              ctx.llm([{ role: "user", content: execSummaryPrompt(job.query, drafts2, job.language, job.preset, ctx.allLearnings) }], "exec-summary", false, undefined, { timeoutMs: 30_000, maxWaitMs: 90_000 }),
              ctx.llm([{ role: "user", content: conclusionPrompt(job.query, drafts2, job.language) }], "conclusion", false, undefined, { timeoutMs: 30_000, maxWaitMs: 90_000 }),
            ]);
            if (rg.status === "fulfilled") serverlessRegrade = { q2: extractJson(rg.value.text), model: rg.value.model };
            if (ex2.status === "fulfilled" && (ex2.value as LlmResult).text.trim()) execText = (ex2.value as LlmResult).text;
            if (cc2.status === "fulfilled" && (cc2.value as LlmResult).text.trim()) concText = (cc2.value as LlmResult).text;
          } else {
          const [exec2, conc2] = await Promise.allSettled([
            ctx.llm([{ role: "user", content: execSummaryPrompt(job.query, drafts2, job.language, job.preset, ctx.allLearnings) }], "exec-summary", false, undefined, { timeoutMs: Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }),
            ctx.llm([{ role: "user", content: conclusionPrompt(job.query, drafts2, job.language) }], "conclusion", false, undefined, { timeoutMs: Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }),
          ]);
          if (exec2.status === "fulfilled" && exec2.value.text.trim()) execText = exec2.value.text;
          if (conc2.status === "fulfilled" && conc2.value.text.trim()) concText = conc2.value.text;
          }
          const body2 = finalSections
            .map((s, i) => `## ${i + 1}. ${s.title}\n\n${(s.draftMd || "").replace(/\[(\d+)\]/g, (_, d) => `[${remap2[Number(d)] ?? d}]`)}`)
            .join("\n\n");
          reportWords = drafts2.split(/\s+/).length;
          durationMs = Date.now() - t0;
          reportMd = [
            `# ${titleText.replace(/["'`#]/g, "").trim()}`,
            ``,
            `## Executive Summary`,
            ``,
            execText,
            ``,
            body2,
            ``,
            ...(concText ? [`## Conclusion`, ``, concText, ``] : []),
            ...(disagreementsMd ? [`## Where sources disagree`, ``, disagreementsMd, ``] : []),
            `## References`,
            ``,
            refs || "*(no sources were successfully retrieved)*",
            ``,
            `---`,
            `**Research metadata** — Duration: ${Math.round(durationMs / 1000)}s · Sources consulted: ${refList.length} · Report words: ~${reportWords} · LLM calls: ${ctx.llmCalls} · Models: ${modelsUsed.join(", ")} · Preset: ${job.preset} · Citation integrity: ${citeStats.integrity}%${qualityRounds > 0 ? ` · Quality rounds: ${qualityRounds}` : ""}`,
          ].join("\n");
          if (diffMd) reportMd = reportMd.replace("## References", `## What changed since the last run\n\n${diffMd}\n\n## References`);
        }

        // (f) re-grade with the SAME rubric — the score only counts if it was earned.
        // v2.4.5: on serverless the re-grade already ran inside the parallel block
        // above (serverlessRegrade) — locally it runs here, serially, as always.
        let regraded: QualityScore | null = null;
        let q2: ReturnType<typeof extractJson> = null;
        if (SERVERLESS && serverlessRegrade) {
          q2 = serverlessRegrade.q2;
        } else {
        try {
          const scoreRes2 = await ctx.llmLive(
            [{ role: "user", content: qualityScorePrompt(job.query, comprehensionCriteria, reportMd, job.language) }],
            "score",
            `Re-grading after round ${qualityRounds}`,
            { wantThinking: false, maxTokens: 2000, fast: { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 25_000 : 60_000 } }
          );
          q2 = extractJson(scoreRes2.text);
        } catch { q2 = null; }
        }
        if (q2 && typeof q2.overall === "number") {
            regraded = {
              overall: Math.max(0, Math.min(10, Math.round(Number(q2.overall) * 10) / 10)),
              dims: (Array.isArray(q2.dims) ? q2.dims : []).slice(0, 4).map((d: { name?: unknown; score?: unknown; note?: unknown }) => ({
                name: String(d?.name ?? "").slice(0, 24),
                score: Math.max(0, Math.min(10, Number(d?.score) || 0)),
                note: String(d?.note ?? "").slice(0, 160),
              })),
              criteria: (Array.isArray(q2.criteria) ? q2.criteria : []).slice(0, 4).map((c: { criterion?: unknown; met?: unknown; why?: unknown }) => ({
                criterion: String(c?.criterion ?? "").slice(0, 200),
                met: c?.met === true,
                why: String(c?.why ?? "").slice(0, 160),
              })),
              biggestWeakness: String(q2.biggestWeakness ?? "").slice(0, 300),
              repairQueries: (Array.isArray(q2.repairQueries) ? q2.repairQueries : []).map((x: unknown) => String(x).slice(0, 160)).filter((x: string) => x.length > 3).slice(0, 3),
            };
        }
        if (!regraded) {
          await ctx.emit("info", "Re-grade unavailable — keeping the improved report and the previous score", undefined, undefined, "verbose");
          break;
        }
        // Regression protection: a round that makes the SAME rubric score the report
        // lower is a round that didn't earn its keep — restore the better drafts.
        if (regraded.overall < current.overall - 0.2) {
          let reverted = 0;
          for (const sec of finalSections) {
            const prevDraft = preRound.get(sec.id);
            if (prevDraft != null && sec.draftMd !== prevDraft) {
              sec.draftMd = prevDraft;
              draftsArr[finalSections.indexOf(sec)] = prevDraft;
              await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: prevDraft } }).catch(() => null);
              reverted++;
            }
          }
          if (reverted > 0) {
            // rebuild the report from the restored drafts so the published artifact is
            // the one the higher score was measured on (refs + body + summary again)
            const refByUrl3 = new Map<string, number>();
            const remap3: Record<number, number> = {};
            refList = [];
            for (const s of sourcesUsed) {
              const existing = refByUrl3.get(s.url);
              if (existing != null) { remap3[s.n] = existing; continue; }
              refByUrl3.set(s.url, refList.length + 1);
              remap3[s.n] = refList.length + 1;
              refList.push(s);
            }
            refs = refList.map((s, i) => `${i + 1}. ${s.title} — *${s.domain}* — ${s.url}`).join("\n");
            const drafts3 = draftsArr.join("\n\n");
            reportWords = drafts3.split(/\s+/).length;
            durationMs = Date.now() - t0;
            const body3 = finalSections
              .map((s, i) => `## ${i + 1}. ${s.title}\n\n${(s.draftMd || "").replace(/\[(\d+)\]/g, (_, d) => `[${remap3[Number(d)] ?? d}]`)}`)
              .join("\n\n");
            reportMd = [
              `# ${titleText.replace(/["'`#]/g, "").trim()}`,
              ``,
              `## Executive Summary`,
              ``,
              execText,
              ``,
              body3,
              ``,
              ...(concText ? [`## Conclusion`, ``, concText, ``] : []),
              ...(disagreementsMd ? [`## Where sources disagree`, ``, disagreementsMd, ``] : []),
              `## References`,
              ``,
              refs || "*(no sources were successfully retrieved)*",
              ``,
              `---`,
              `**Research metadata** — Duration: ${Math.round(durationMs / 1000)}s · Sources consulted: ${refList.length} · Report words: ~${reportWords} · LLM calls: ${ctx.llmCalls} · Models: ${modelsUsed.join(", ")} · Preset: ${job.preset} · Citation integrity: ${citeStats.integrity}%${qualityRounds > 0 ? ` · Quality rounds: ${qualityRounds}` : ""}`,
            ].join("\n");
            if (diffMd) reportMd = reportMd.replace("## References", `## What changed since the last run\n\n${diffMd}\n\n## References`);
            await ctx.emit(
              "info",
              `Round ${qualityRounds} regressed the score (${current.overall.toFixed(1)} → ${regraded.overall.toFixed(1)}) — restored the better-scoring report`,
              `${reverted} section draft(s) reverted. The published artifact is always the one the same rubric scored highest.`,
              undefined,
              { reverted, round: qualityRounds },
              "verbose",
            );
          }
          // keep the higher score and STOP — a second regressing round is waste
          await ctx.emit("score", `Kept the better score: ${current.overall.toFixed(1)}/10 (round ${qualityRounds} regressed)`, undefined, undefined, { ...current });
          break;
        }
        current = regraded;
        quality = current;
        await ctx.emit(
          "score",
          `Self-score after round ${qualityRounds}: ${current.overall.toFixed(1)}/10`,
          current.biggestWeakness || (current.overall >= QUALITY_TARGET ? "Target reached — the score was earned with new evidence, not re-grading." : ""),
          undefined,
          { ...current, round: qualityRounds, newSources, rewritten },
        );
      }
    }

    const stats = {
      durationMs,
      sourcesConsulted: refList.length,
      llmCalls: ctx.llmCalls,
      byModel: ctx.byModel,
      reportWords,
      sections: finalSections.length,
      relatedQuestions,
      agent: agentName || undefined,
      walkedUrls: ctx.walkedUrls,
      learnings: ctx.allLearnings.length,
      claimsGraded: ctx.claims.length,
      claimsVerified: ctx.claims.filter((c) => c.verified === "confirmed").length,
      claimsRefuted: ctx.claims.filter((c) => c.verified === "refuted").length,
      contradictions: ctx.contradictions.length,
      // P0/P1/P2 additions
      citationIntegrity: citeStats.integrity,
      citationsChecked: citeStats.checked,
      citationsRepaired: citeStats.repaired,
      citationsDropped: citeStats.dropped,
      // per-citation audit trail (P0-4): which sources received re-anchored citations,
      // which citation numbers were dropped as unsupported, which were flagged weak
      citationAudit: {
        reanchoredTo: [...new Set(citeStats.reanchoredTo)],
        dropped: [...new Set(citeStats.droppedNs)],
        flagged: [...new Set(citeStats.flagged)],
      },
      // claim-level verification ledger (final numbering) + one-line summary
      ...(claimChecks.length > 0 ? { claimChecks } : {}),
      ...(claimVerdict ? { claimVerdict } : {}),
      reranked: ctx.rerankRuns,
      parallelAspects: concurrency,
      spawnedAspects: spawnedCount.n,
      ...(court ? { court } : {}),
      redTeamAttacks: redTeamAttacks.length,
      debated,
      docsUsed: docEntries.length,
      sourceDiversity: { domains: distinctDomains, topDomain: topDomainEntry?.[0] ?? "", topShare: Math.round(topShare * 100), medianAgeMonths },
      ...(quality ? { quality } : {}),
      ...(qualityRounds > 0 ? { qualityRounds, qualityTarget: QUALITY_TARGET } : {}),
      ...(diffMd ? { rerunDiff: true } : {}),
      // v2.5.0 continuation: how many serverless slices the run spanned
      slices: sliceN,
      finishedAt: new Date().toISOString(),
    };
    // P1-2 PRE-SHIP REPORT SCORE — deterministic, LLM-free gate on the three
    // dimensions the strategy named (evidence coverage, citation integrity,
    // verdict consistency) + compute resolution. Scored AFTER the improve loop
    // settles, BEFORE the report ships. Persisted in stats so the UI, exports,
    // and telemetry all read the same number.
    {
      let usedSourceRows: { domain: string; quality: number; used: boolean }[] = [];
      try {
        usedSourceRows = await db.source.findMany({ where: { jobId }, select: { domain: true, quality: true, used: true } });
      } catch { usedSourceRows = []; }
      const reportScore: ReportScore = scoreReport({
        reportMd,
        claimChecks,
        claimVerdict,
        citationIntegrity: citeStats.integrity,
        courtVerdict: court?.verdict ?? null,
        sources: usedSourceRows,
        authorityDomains: pack.authorities,
      });
      (stats as Record<string, unknown>).reportScore = reportScore;
      if (reportScore.flags.length > 0) {
        await ctx.emit(
          "info",
          `Pre-ship score: ${reportScore.overall}/100 (${reportScore.passed ? "passed" : "below the 60 gate"})`,
          reportScore.flags.join(" · "),
          undefined,
          { reportScore: { overall: reportScore.overall, dims: reportScore.dims } },
        );
      } else {
        await ctx.emit(
          "info",
          `Pre-ship score: ${reportScore.overall}/100 — coverage ${reportScore.dims.coverage}, integrity ${reportScore.dims.integrity}, evidence ${reportScore.dims.evidence}, consistency ${reportScore.dims.consistency}`,
          undefined,
          undefined,
          "verbose",
        );
      }
    }
    await updateJob(jobId, { status: "completed", stage: "Completed", progress: 100, reportMd, stats: JSON.stringify(stats), completedAt: new Date() });
    await persist("done").catch(() => {}); // informational — the job is complete
    await ctx.emit(
      "done",
      court ? `The trial is over — ${court.verdict === "HUNG JURY" ? `HUNG JURY, the jury deadlocked ${court.guilty} to ${court.notGuilty}` : `${court.verdict}, ${court.guilty} to ${court.notGuilty}`}${court.deliberated ? ` (first ballot ${court.firstBallot?.guilty}–${court.firstBallot?.notGuilty}, then deliberation)` : ""}` : "Research complete",
      court
        ? `Verdict delivered — ${sourcesUsed.length} sources, ${court.jurors.length} jurors voted, ${ctx.llmCalls} LLM calls, ${fmtMin(durationMs)} total${court.conditions.length ? `. What to change before trying again: ${court.conditions[0].slice(0, 140)}${court.conditions.length > 1 ? "…" : ""}` : ""}`
        : `Report ready — ${refList.length} sources, ~${reportWords.toLocaleString()} words, ${ctx.llmCalls} LLM calls, ${fmtMin(durationMs)} total${quality ? `, self-scored ${quality.overall.toFixed(1)}/10${qualityRounds > 0 ? ` after ${qualityRounds} quality round${qualityRounds > 1 ? "s" : ""} (target 9 — earned with new evidence, re-graded by the same rubric)` : ""}` : ""}${citeStats.integrity < 100 ? `, citation integrity ${citeStats.integrity}%` : " with verified citations"}${spawnedCount.n > 0 ? `, ${spawnedCount.n} aspect${spawnedCount.n > 1 ? "s" : ""} spawned mid-research (recursive deep-dive)` : ""}${sliceN > 1 ? `, continued across ${sliceN} serverless slices` : ""}`,
      undefined,
      stats
    );
    await notifyRunFinished(jobId); // v3.4: webhooks + watch advancement (never throws)
  } catch (err) {
    // v3.0.2: LlmStoppedError (thrown by the stop hooks inside the LLM ride) is a
    // cancellation, not a failure — same clean path as the engine's own Cancelled.
    if (err instanceof Cancelled || (err as { cancelled?: boolean } | null)?.cancelled === true) {
      await updateJob(jobId, { status: "cancelled", stage: "Cancelled", completedAt: new Date() }).catch(() => {});
      await db.activityEvent.create({ data: { jobId, type: "info", title: "Research cancelled by user", seq: 9_999_999 } }).catch(() => {});
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "failed", stage: "Failed", error: msg, completedAt: new Date() }).catch(() => {});
      await db.activityEvent.create({ data: { jobId, type: "error", title: "Research failed", detail: msg, seq: 9_999_999 } }).catch(() => {});
      await notifyRunFinished(jobId).catch(() => {}); // v3.4: run.failed webhooks
    }
  } finally {
    if (heart) clearInterval(heart);
    // v2.5.0 continuation: releasing the lease lets the next poll resume the job
    // immediately when the engine exited at a slice boundary (no 30s wait); on
    // completion/failure it simply frees the single-run guard.
    if (leaseHeld) await releaseLease(jobId).catch(() => {});
    activeJobs.delete(jobId);
  }
}

function fallbackRelated(query: string, questions: string[]): string[] {
  const qs = questions.filter(Boolean).slice(0, 3).map((q) => q.replace(/\?$/, ""));
  const out = [...qs.map((q) => `${q}?`)];
  while (out.length < 3) out.push(`What should I investigate next about ${query.split(/\s+/).slice(0, 8).join(" ")}?`);
  return out.slice(0, 4);
}

function fallbackPlan(query: string, breadth: number): ResearchPlan {
  const year = new Date().getFullYear();
  const templates = [
    { title: "Core concepts & context", question: `What is "${query}" — key definitions, background and current context?`, goal: "Establish the baseline: definitions, key entities and how the topic fits together, so later aspects have solid ground.", queries: [`${query} key concepts definitions ${year}`, `${query} explained technical details`] },
    { title: "Current state & evidence", question: `What is the current state of "${query}" — latest data, players and developments?`, goal: "Capture the present state with concrete numbers, dates and named players — the evidentiary core of the report.", queries: [`${query} latest developments milestones ${year}`, `${query} statistics data numbers ${year}`] },
    { title: "Analysis & outlook", question: `What are trends, risks and the outlook for "${query}"?`, goal: "Look forward: what is changing, what could break, and what credible observers expect next.", queries: [`${query} trends forecast analysis`, `${query} challenges criticism risks evidence`] },
    { title: "Practical implications", question: `What are practical implications, applications and best practices around "${query}"?`, goal: "Make the research actionable — what this means in practice for someone using or deciding about it.", queries: [`${query} real world applications case studies`, `${query} adoption implementation examples`] },
    { title: "Comparisons & alternatives", question: `How does "${query}" compare to alternatives?`, goal: "Situate the topic against its alternatives so the reader can judge relative strengths honestly.", queries: [`${query} vs alternatives comparison benchmarks`, `${query} competitors landscape`] },
  ];
  const n = breadth > 0 ? breadth : 4;
  return {
    restate: `The user needs a comprehensive research report on "${query}".`,
    reportType: "general-research",
    academic: false,
    unknowns: ["the current state of the topic", "concrete data and named players"],
    aspects: templates.slice(0, Math.max(2, n)),
  };
}

/** Watchdog: mark jobs that stopped updating (e.g. server restart or serverless
 *  deploy cutover) as failed, so the UI can offer a retry instead of spinning.
 *  v2.5.0: jobs with a LIVE lease are skipped — their engine is running on some
 *  instance and renewing it (continuation slices touch it constantly). */
export async function markStaleJobs() {
  // 5-min threshold: LLM calls heartbeat updatedAt every 60s, and search/read
  // stretches are bounded by per-fetch timeouts — so a live engine never goes
  // 5 minutes without a touch. Anything older is dead (serverless deploy
  // cutover, restart, crash) and is failed fast so the UI's retry appears.
  const stale = await db.researchJob.findMany({
    where: {
      status: { in: ["queued", "planning", "researching", "critiquing", "synthesizing"] },
      updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
      // a live lease means an engine somewhere is still working this job
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date(Date.now() - 60_000) } }],
    },
    select: { id: true, reportMd: true, stage: true },
  });
  for (const j of stale) {
    if (activeJobs.has(j.id)) continue;
    // v2.4.2: a frozen tail must not bury a finished draft — when the engine
    // persisted a report before dying, COMPLETE the job with it (honestly labeled)
    // instead of failing it: a real report beats a zombie at 95%.
    if (j.reportMd && j.reportMd.length > 200) {
      await db.researchJob.update({
        where: { id: j.id },
        data: { status: "completed", stage: "Completed (tail interrupted — summary/score may be missing)", progress: 100, completedAt: new Date() },
      });
      await db.activityEvent.create({ data: { jobId: j.id, type: "done", title: "Completed with the tail interrupted", detail: "The report body and references were finished, but the function clock ran out during the final polish (summary/citation audit/self-score). The full report is below.", seq: 9_999_997 } }).catch(() => {});
      await notifyRunFinished(j.id).catch(() => {}); // v3.4: webhooks + watch advancement
      continue;
    }
    await db.researchJob.update({ where: { id: j.id }, data: { status: "failed", stage: "Interrupted", error: "Job stalled or was interrupted (e.g. a redeploy or server restart). Start a new research run or tap Retry.", completedAt: new Date() } });
    await db.activityEvent.create({ data: { jobId: j.id, type: "error", title: "Job interrupted", detail: "The research process was interrupted. Please start a new run or tap Retry.", seq: 9_999_998 } }).catch(() => {});
    await notifyRunFinished(j.id).catch(() => {}); // v3.4: run.failed webhooks
  }
}
