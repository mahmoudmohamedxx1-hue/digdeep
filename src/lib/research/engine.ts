import { db } from "@/lib/db";
import { llmComplete, llmStreamComplete, type ChatMsg, type LlmResult, type ModelPref, type StreamDelta } from "./llm";
import { capabilityQuestion, heuristicChatIntent, selfKnowledgeTopic, type SelfTopic } from "./intent-heuristics";
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
  chatPrompt,
  quickAnswerPrompt,
  roleChooserPrompt,
  comprehensionPrompt,
  planPrompt,
  summarizePrompt,
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
  type Intent,
} from "./prompts";
import { PIPELINE_ONE_LINER } from "./self-knowledge";
import { JURORS, prosecutionPrompt, defensePrompt, rebuttalPrompt, jurorPrompt, judgePrompt, type CourtVerdict } from "./court";

const activeJobs = new Set<string>();

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

class Ctx {
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
    await db.activityEvent.create({
      data: { jobId: this.jobId, seq: this.seq++, type, title, detail: detail?.slice(0, 8000), model, meta: meta ? JSON.stringify(meta) : undefined, level },
    });
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
async function classifyIntent(
  ctx: Ctx,
  query: string,
  recentTurns: string,
  preset: string
): Promise<{ intent: Intent; how: string; raw: string }> {
  try {
    const res = await Promise.race([
      ctx.llmLive(
        [{ role: "user", content: classifyPrompt(query, recentTurns, preset) }],
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
    let intent: Intent | null = null;
    const laneMatch = [...text.matchAll(/lane\s*[:\-]?\s*\**\s*"?(chat|quick|research)/gi)].pop();
    if (laneMatch) intent = laneMatch[1].toLowerCase() as Intent;
    if (!intent) {
      const lastLine = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
      const w = lastLine.match(/\b(chat|quick|research)\b/i);
      if (w) intent = w[1].toLowerCase() as Intent;
    }
    if (!intent) intent = "research"; // format mangled — the safe default for real questions
    const pick = (tag: string) =>
      (text.match(new RegExp(`${tag}\\s*[:\\-]?\\s*(.+)`, "i"))?.[1] ?? "")
        .replace(/\s*(restate|intent|strategy|lane)\s*[:\-].*$/i, "")
        .replace(/^"+|"+$/g, "")
        .trim();
    const restate = pick("restate");
    const intentLine = pick("intent");
    const strategy = pick("strategy");
    const read = [restate, intentLine, strategy].filter(Boolean).join(" · ");
    return {
      intent,
      how: read
        ? `I read your message as: “${read.slice(0, 320)}” — so I am routing it to ${
            intent === "chat" ? "a direct reply" : intent === "quick" ? "a quick answer" : "deep research"
          }`
        : `the router read your message and picked ${intent}`,
      raw: read.slice(0, 240),
    };
  } catch (err) {
    // Every backend is unavailable — read the message's SHAPE instead of blindly
    // researching: short casual messages get a direct reply; anything question-like
    // still defaults to research (the choice that can never under-answer).
    const s = query.toLowerCase().trim();
    const words = s.split(/\s+/).filter(Boolean);
    const casual =
      words.length <= 3 ||
      /^(hi|hey|hello|thanks|thank you|ok|okay|cool|nice|great|good|bye|yo|sup)\b/.test(s) ||
      (/^(make|tell|say|write|draw)\b/.test(s) && words.length <= 5);
    return {
      intent: casual ? "chat" : "research",
      how: `the router model is unavailable right now (${err instanceof Error ? err.message.slice(0, 60) : "error"}), so I read the message's shape myself: ${
        casual ? "short and conversational — replying directly" : "it reads like a real question — deep research, the choice that cannot under-answer"
      }${["deep", "exhaustive", "unlimited"].includes(preset) ? ` (your "${preset}" mode still applies only to real research questions)` : ""}`,
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

/** CHAT LANE — direct conversational reply, no search, no report structure.
 *  Self-knowledge questions (engines/process/models/capabilities) get the grounded
 *  SELF_KNOWLEDGE spec injected into the prompt, so the answer is accurate even
 *  though the model has never seen the codebase. */
async function runChatLane(
  ctx: Ctx,
  job: { id: string; query: string },
  threadContext: string
): Promise<void> {
  const selfTopic = selfKnowledgeTopic(job.query) ?? (capabilityQuestion(job.query) ? ("capabilities" as SelfTopic) : null);
  await updateJob(ctx.jobId, { status: "planning", stage: "Thinking…", progress: 40, startedAt: new Date() });
  await ctx.emit(
    "info",
    "Chat mode — no research needed for this",
    selfTopic
      ? `This asks about my own ${selfTopicWord(selfTopic)} — I know that from my configuration, so I am answering directly from my product spec instead of launching the research pipeline.`
      : "This message reads as conversation (greeting / small talk / about DigDeep), so I am replying directly instead of launching the research pipeline. Ask any real question and I will dig deep."
  );
  const sec = await db.researchSection.create({
    data: { jobId: ctx.jobId, order: 0, title: "Reply", question: job.query, queries: "[]" },
  });
  let reply = "";
  let replyModel = "";
  let fallback = false;
  try {
    // The model's thinking AND the reply itself stream live — the user watches the answer
    // being written instead of staring at a spinner. Fast-fail opts: chat must never ride
    // minutes of throttling; the built-in script below catches total exhaustion.
    const res = await ctx.llmLive(
      [{ role: "user", content: chatPrompt(job.query, threadContext ? threadContext.slice(0, 1200) : "", selfTopic) }],
      "chat-reply",
      "Thinking about your message",
      { system: CHAT_SYS, streamTo: sec.id, fast: { patient: false, timeoutMs: 30_000 } }
    );
    reply = res.text.trim();
    replyModel = res.model;
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
  await ctx.emit("done", "Replied", `Conversational answer in ${Math.round(durationMs / 1000)}s — no sources fetched, no research run${fallback ? " (built-in script — models were throttled)" : ""}`, replyModel, stats);
}

/** QUICK LANE — one focused search pass + a concise cited answer (Perplexity quick answer). */
async function runQuickLane(
  ctx: Ctx,
  job: { id: string; query: string; language: string },
  threadContext: string
): Promise<void> {
  await updateJob(ctx.jobId, { status: "researching", stage: "Searching the web…", progress: 15, startedAt: new Date() });
  await ctx.emit(
    "info",
    "Quick-answer mode — skipping the full research pipeline",
    `This looks like a simple factual question, so I am doing ONE focused search pass instead of the multi-aspect research pipeline. Honest estimate: under a minute.${threadContext ? " (Thread context is being considered.)" : ""}`
  );
  const sec = await db.researchSection.create({
    data: { jobId: ctx.jobId, order: 0, title: "Quick answer", question: job.query, queries: JSON.stringify([job.query]) },
  });

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
  const sourcesUsed: { n: number; url: string; title: string; domain: string }[] = [];
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
  let valid = contents.filter((c): c is { n: number; title: string; domain: string; excerpt: string } => !!c);

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

  // 3. answer (streamed live — the answer types itself out as it is generated)
  await updateJob(ctx.jobId, { stage: "Writing the answer…", progress: 80 });
  let answer = "";
  let answerModel: string | undefined;
  if (valid.length > 0) {
    const res = await ctx.llmLive(
      [{ role: "user", content: quickAnswerPrompt(job.query, valid, job.language) }],
      "quick-answer",
      "Composing a quick answer",
      { streamTo: sec.id }
    );
    answer = res.text;
    answerModel = res.model;
  } else {
    // nothing retrievable — answer from general knowledge, honestly flagged
    const res = await ctx.llmLive(
      [{ role: "user", content: `Question: "${job.query}"\n\nWeb searches returned no usable sources. Answer directly from general knowledge in ${job.language}. Be concise (under 250 words), lead with the answer, and END with one short italic line noting that web sources could not be retrieved for this answer so it is unverified general knowledge.` }],
      "quick-answer-nosrc",
      "Composing a quick answer",
      { streamTo: sec.id }
    );
    answer = res.text;
    answerModel = res.model;
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
  await ctx.emit("done", "Quick answer ready", `Answered in ${Math.round(durationMs / 1000)}s · ${sourcesUsed.length} sources · ${ctx.llmCalls} LLM calls — ask a follow-up or say “go deeper” for the full pipeline`, undefined, stats);
}

/** Main entry: runs the full research pipeline for a job. Fire-and-forget safe. */
export async function runJob(jobId: string) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  const t0 = Date.now();
  try {
    const job = await db.researchJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    const unlimited = job.breadth < 0 || job.depth < 0 || job.maxSources < 0 || job.maxMinutes < 0;
    // ── serverless wall-clock (Vercel) ─────────────────────────────────────
    // On a long-lived server the engine trusts the preset's time budget. On a
    // serverless function the whole pipeline must finish inside ONE invocation
    // (the function is frozen when the request completes), so the budget is
    // clamped to what the platform allows and the run degrades gracefully:
    // research until the clock runs out, then write the best report the
    // gathered evidence supports — and say so honestly in the event stream.
    const SERVERLESS = !!process.env.VERCEL;
    // v2.4.0 serverless time-phasing: the function is frozen by the platform at
    // maxDuration (300s Hobby). The engine now RESERVES the tail explicitly:
    //   hardStop 288s  (12s final-write margin)
    //   research cutoff hardStop-195s  → parallel drafts (45s) + bundle (30s) +
    //   assembly (5s) + grade (30s) + ONE earn-the-score round (72s) fit in the reserve
    // so a capped run still drafts, grades AND improves instead of dying at 95%.
    const SERVERLESS_CAP_MS = Math.max(60_000, Number(process.env.DIGDEEP_SERVERLESS_BUDGET_MS) || 200_000);
    const rawBudgetMs = unlimited ? Infinity : Math.max(3, job.maxMinutes) * 60_000;
    const budgetMs = SERVERLESS ? Math.min(rawBudgetMs, SERVERLESS_CAP_MS) : rawBudgetMs;
    const budgetMinutes = budgetMs === Infinity ? -1 : Math.max(1, Math.floor(budgetMs / 60_000));

    const maxSeq = await db.activityEvent.aggregate({ where: { jobId }, _max: { seq: true } });
    const ctx = new Ctx(jobId, job.modelPref as ModelPref, (maxSeq._max.seq ?? 0) + 1, {
      maxMinutes: budgetMinutes,
      depth: job.depth,
      maxSources: job.maxSources,
      anyUnlimited: unlimited,
      // the platform freezes the function at maxDuration (300s Hobby) — leave a
      // safety margin so the final report write always makes it to the database
      ...(SERVERLESS ? { hardStopMs: 288_000 } : {}),
    });
    // (the research cutoff is anchored at Stage-2 entry below — after the plan lands,
    // with a 25s floor, so a slow plan ride can never consume the research window)

    if (SERVERLESS && rawBudgetMs > SERVERLESS_CAP_MS) {
      await ctx.emit(
        "info",
        `Serverless run — research capped at ~${Math.round((ctx.hardStop - ctx.researchCutoffAt) / 60_000)} min, then write + grade + improve`,
        "This deployment runs on serverless functions, which cap background compute at roughly five minutes per run. I sized the phases so the report is drafted, graded AND one improvement round still fits the clock — multi-engine search, citation audit and self-grading all run unchanged. For full-length runs (30 min and up), self-host digdeep with `bun run dev`; the engine is identical, only the clock differs.",
        undefined,
        { serverless: true, budgetMs: SERVERLESS_CAP_MS }
      );
    }

    // follow-up context: latest completed turn from the same thread
    let threadContext = "";
    let recentTurns = "";
    let prevQuery = "";
    let prevReportMd = "";
    if (job.threadId) {
      const prev = await db.researchJob.findFirst({
        where: { threadId: job.threadId, status: "completed", id: { not: job.id }, reportMd: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      if (prev?.reportMd) {
        threadContext = prev.reportMd.slice(0, 4000);
        recentTurns = `User asked: "${prev.query}"\nDigDeep answered (${prev.mode}): ${prev.reportMd.slice(0, 400)}`;
        prevQuery = prev.query;
        prevReportMd = prev.reportMd;
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

    // ---------- STAGE 0: UNDERSTAND FIRST, THEN ROUTE (chat vs quick answer vs deep research) ----------
    // The selected mode (quick…unlimited) sets HOW DEEP real questions get researched —
    // it must NEVER force research onto conversational or capability questions.
    // COURT MODE is different by design: the user explicitly asked for a trial, so the
    // query IS the proposition — no chat/quick classification, straight to evidence.
    await updateJob(jobId, { status: "planning", stage: "Reading your message", progress: 3 });
    let intent: Intent = "research";
    let routeWhy = "";
    if (job.court) {
      intent = "research";
      routeWhy = "court mode — you asked for a trial, so this proposition gets a prosecutor, a defense, a jury of 12 and a judge";
      await ctx.emit(
        "court",
        "Court is in session",
        `The proposition on trial: “${job.query.slice(0, 240)}”. Evidence is gathered first by the research engine (both for and against), then the prosecution and the defense build their cases from it, a jury of 12 independent personas votes, and the judge reads the verdict — with what to change before trying again.`,
        undefined,
        { phase: "opening", charge: job.query.slice(0, 300) }
      );
    } else {
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
    } else {
      const cls = await classifyIntent(ctx, job.query, recentTurns, job.preset);
      intent = cls.intent;
      routeWhy = cls.how;
    }
    } // end non-court routing
    await updateJob(jobId, { mode: intent });
    if (intent === "chat") {
      await ctx.emit("info", "Routed to: chat", routeWhy);
      await runChatLane(ctx, job, threadContext);
      return;
    }
    if (intent === "quick") {
      await ctx.emit("info", "Routed to: quick answer", routeWhy);
      await runQuickLane(ctx, job, threadContext);
      return;
    }

    await updateJob(jobId, { status: "planning", stage: "Understanding the question", startedAt: new Date(), progress: 4 });
    await ctx.emit(
      "info",
      job.court ? "Routed to: the court" : "Routed to: deep research",
      `${routeWhy}. Mode: ${unlimited ? "UNLIMITED — no caps on aspects, rounds, sources or time; research continues until coverage is genuinely sufficient" : `breadth ${job.breadth} · depth ${job.depth} · max ${job.maxSources} sources · budget ${job.maxMinutes} min`} · backend: ${job.modelPref === "auto" ? "auto (GLM SDK → LLM7 multi-model keyless pool → Pollinations failover)" : job.modelPref}`
    );

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
      await runChatLane(ctx, job, threadContext);
      return;
    }
    // ---- STAGE 1a: COMPREHENSION — understand the question the way Claude reads a prompt
    //      BEFORE acting: restate it, pin the intent, define what a great answer must
    //      establish, flag ambiguities. Runs IN PARALLEL with the scouting search, so it
    //      adds no wall-clock time; its output feeds (and sharpens) the plan. Degrades
    //      gracefully — no comprehension → the plan proceeds on the raw query as before.
    let comprehensionCriteria: string[] = []; // kept for the Stage 5 self-score
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
    let agentName = "";
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
      [{ role: "user", content: planPrompt(job.query, job.breadth, job.language, threadContext || undefined, initSnippets, comprehensionDigest || undefined, job.court) }],
      "plan",
      "Planning the research",
      // v2.4.0: on the serverless clock the plan must not ride patient cooldowns for
      // minutes — fast-fail at 40s and let the fallback plan carry the run (a generic
      // plan with real research beats a perfect plan that eats the research window)
      SERVERLESS ? { wantThinking: true, fast: { patient: false, timeoutMs: 40_000 } } : { wantThinking: true }
    );
    planPromise.catch(() => {}); // the underlying ride resolves on its own; its catch trips the breaker
    try {
      planRes = await (Number.isFinite(planRideCapMs)
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
    let plan: ResearchPlan | null = planRes ? extractJson(planRes.text) : null;
    if (!plan || !Array.isArray(plan.aspects) || plan.aspects.length === 0) {
      if (planRes) await ctx.emit("info", "Plan parse failed — using fallback plan", planRes.text.slice(0, 400));
      plan = fallbackPlan(job.query, job.breadth);
    }
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
    const concurrency = Math.min(aspectsTotal, SERVERLESS ? Math.max(ASPECT_CONCURRENCY.heavy, Math.min(aspectsTotal, 4)) : unlimited || job.preset === "exhaustive" ? ASPECT_CONCURRENCY.heavy : ASPECT_CONCURRENCY.budgeted);
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

    // ---------- STAGE 2: ITERATIVE RESEARCH (P0-2: aspects in parallel) ----------
    // v2.4.0: the research cutoff is anchored HERE (not at ctx creation) — a slow
    // plan ride on hot lanes must never consume the window before it opens. Floor:
    // research always gets at least 25s (one parallel round); reserve: the full tail
    // (drafts + bundle + grade + one improve round). Past a slow plan the tail
    // compresses by degrading gracefully — grade/round skip, the report persists.
    // v2.4.3: reserve 180s for the tail (drafts 40s + bundle 35s + assembly 5s +
    // grade 25s + one lean round 65s + final write 10s) — 15s more research than v2.4.2.
    if (SERVERLESS) ctx.researchCutoffAt = Math.max(Date.now() + 25_000, ctx.hardStop - 180_000);
    await updateJob(jobId, { status: "researching", progress: 8 });
    const sectionRows = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    const sourcesUsed: SourceRef[] = [];
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
    const spawnedCount = { n: 0 };
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
          queries: JSON.stringify([question.slice(0, 120), `${title} explained`]),
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
    let timeSkipAnnounced = false;
    const runNextAspect = async (): Promise<void> => {
      for (;;) {
        if (stopAll) return;
        // v2.4.0: the serverless research window closed — the write/grade/improve
        // tail is reserved; aspects not yet started are skipped (same honesty as
        // the outOfTime skip below, but driven by the phase plan, not the budget)
        if (Date.now() > ctx.researchCutoffAt) {
          if (!timeSkipAnnounced) {
            timeSkipAnnounced = true;
            await ctx.emit("info", "Research window closed — moving to writing, grading and improvement", "The serverless clock reserves the tail of the run for drafting, self-grading and one improvement round; aspects not yet started are skipped, and the report is written from the evidence already gathered.");
          }
          return;
        }
        if (await ctx.isCancelled()) {
          stopAll = true;
          return;
        }
        const si = nextSi++;
        if (si >= sectionRows.length) return;
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
      let notes = "";
      let roundsDone = 0;
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
        for (const q of queries.slice(0, 3)) {
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
            // are exactly how a garbage report stays "honest-looking"
            const g = gateByRelevance(sec.question, queries.join(" "), searchResults.slice(0, 12));
            return g.kept.slice(0, 6).map((r, i) => ({ n: 900 + i, title: r.title, domain: r.domain, excerpt: r.snippet }));
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
        let roundNotes = "";
        if (srcForSum.length > 0) {
          try {
            const sumRes = await ctx.llm([{ role: "user", content: summarizePrompt(sec.title, sec.question, srcForSum, round) }], "summarize", false, undefined, SERVERLESS ? { patient: false, timeoutMs: 25_000 } : undefined);
            roundNotes = sumRes.text;
            await ctx.emit("summary", `Synthesized findings on “${sec.title}”`, roundNotes.slice(0, 2400), sumRes.model, { section: sec.title, round, sources: srcForSum.length });
          } catch (sumErr) {
            // graceful degradation: keep the raw excerpts as notes rather than killing the run
            roundNotes = srcForSum.map((s) => `- From ${s.domain} (${s.title}): ${s.excerpt.slice(0, 600)}`).join("\n");
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
        } else {
          await ctx.emit("info", `Sources for “${sec.title}” came back off-topic this round — discarded, not folded into findings`, roundNotes.slice(0, 200));
        }

        // 2e. SELF-CRITIQUE v2 — dual critic: is it sufficient? what is now solidly known? where to go next (search or walk)?
        const roundsLeft = ctx.unlimitedRounds ? "unlimited" : Math.max(0, job.depth - round);
        const canReflect = (ctx.unlimitedRounds || (job.depth - round) > 0) && !!notes && !ctx.outOfTime;
        if (canReflect && notes && !ctx.outOfTime) {
          try {
          // WebWalker: offer harvested links as walk candidates
          const linkCandidates = roundLinks
            .filter((l) => !ctx.seenUrls.has(l.url))
            .filter((l, i, arr) => arr.findIndex((x) => x.url === l.url) === i)
            .slice(0, 10);
          const reflRes = await ctx.llmLive(
            [{ role: "user", content: reflectPrompt(sec.title, sec.question, notes, roundsLeft, linkCandidates, ctx.allLearnings, canSpawnThis) }],
            "reflect",
            `Self-reviewing: ${sec.title}`,
            SERVERLESS ? { wantThinking: true, fast: { patient: false, timeoutMs: 25_000 } } : { wantThinking: true }
          );
          const refl = extractJson(reflRes.text);
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
            await ctx.emit("learning", `Nailed down ${learnings.length} finding${learnings.length > 1 ? "s" : ""} — ${gradeNote}`, learnings.map((l: string) => `• ${l}`).join("\n"), reflRes.model, { learnings, section: sec.title, round, grades: { verified: verifiedN, likely: likelyN, weak: weakN } });
          }
          // reflect v3: contradictions between sources — surfaced, not averaged away
          const newContras = (Array.isArray(refl?.contradictions) ? refl.contradictions : [])
            .filter((c: any) => c && typeof c.claim === "string" && c.claim.trim())
            .map((c: any) => ({ claim: String(c.claim).trim().slice(0, 300), positions: String(c.positions || "").slice(0, 400), section: sec.title }));
          for (const c of newContras) {
            if (ctx.contradictions.some((x) => x.claim === c.claim)) continue;
            ctx.contradictions.push(c);
            await ctx.emit("contradiction", `Sources disagree: ${c.claim.slice(0, 80)}`, c.positions, reflRes.model, { ...c });
          }
          const followUps = (Array.isArray(refl?.followUps) ? refl.followUps : []) as { type?: string; value?: string; reason?: string }[];
          // dzhng recursion: an unexpected DISTINCT research thread becomes its own aspect
          if (canSpawnThis && Array.isArray(refl?.newDirections)) {
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
            reflRes.model,
            { sufficient: ok, followUps: chipList, section: sec.title, round, learnings: learnings.length }
          );
          if (ok) break;
          if (round >= maxRounds && ctx.unlimitedRounds) {
            await ctx.emit("info", `Safety stop after ${UNLIMITED_ROUND_CAP} rounds on “${sec.title}”`, "Unlimited mode uses a 20-round safety ceiling per aspect so a single aspect can never loop forever.");
            break;
          }
          if (searchFollowUps.length > 0) queries = searchFollowUps;
          if (searchFollowUps.length === 0 && pendingWalks.length === 0) break; // nothing actionable left
          } catch (reflErr) {
            // graceful degradation: without a reflection model there is no basis for more rounds —
            // keep the evidence gathered and move on instead of dying
            await ctx.emit("info", `Self-review model unavailable for “${sec.title}” — stopping this aspect after round ${round}`, reflErr instanceof Error ? reflErr.message.slice(0, 200) : undefined);
            break;
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
        if (err instanceof Cancelled) {
          stopAll = true;
          return;
        }
        await ctx.emit("info", "An aspect hit an error — the other aspects continue", err instanceof Error ? err.message.slice(0, 300) : String(err)).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => aspectWorker()));
    if (stopAll && (await ctx.isCancelled())) throw new Cancelled();

    // ---------- SOURCE DIVERSITY + FRESHNESS (P1-3) ----------
    // Echo chambers and stale evidence become visible instead of invisible defaults.
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
    if (webSources.length >= 8 && topShare > 0.4) {
      await ctx.emit(
        "diversity",
        `Echo-chamber risk: ${Math.round(topShare * 100)}% of sources come from ${topDomainEntry?.[0]}`,
        "One domain dominates the evidence base. The report will say so, and follow-up research should deliberately seek independent sources before trusting conclusions drawn mainly from it.",
        undefined,
        { topDomain: topDomainEntry?.[0], topShare: Math.round(topShare * 100), distinctDomains }
      );
    }
    await ctx.emit(
      "diversity",
      `Evidence base: ${webSources.length} sources across ${distinctDomains} domains${medianAgeMonths != null ? ` · median source age ~${medianAgeMonths} month${medianAgeMonths === 1 ? "" : "s"}` : ""}`,
      `Top domain: ${topDomainEntry ? `${topDomainEntry[0]} (${Math.round(topShare * 100)}%)` : "—"}${medianAgeMonths != null ? (medianAgeMonths <= 6 ? " — the evidence is fresh, good for a fast-moving topic." : " — some evidence predates the last year; treat fast-moving claims with care.") : ""}`,
      undefined,
      { distinctDomains, topDomain: topDomainEntry?.[0] ?? "", topShare: Math.round(topShare * 100), medianAgeMonths, sources: webSources.length }
    );

    // ---------- STAGE 3: SELF-CRITIQUE ----------
    if (await ctx.isCancelled()) throw new Cancelled();
    await updateJob(jobId, { status: "critiquing", stage: "Critically reviewing my own evidence", progress: 74 });
    const doneSections = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    let critRes: { text: string; model: string; reasoning?: string } | null = null;
    // v2.4.1: on the serverless clock the critique pass (a patient-ride LLM call that
    // regularly eats 60-90s) is folded into the post-grade improvement round — same
    // gap-repair function, time-boxed, AFTER the report exists. Self-hosted runs keep
    // the full pre-write critique + weak-section re-research.
    if (SERVERLESS) {
      await ctx.emit("info", "Serverless clock — critique runs as the post-grade improvement round", "The formal critique pass and its follow-up re-research run on self-hosted deployments; here the same gap-repair happens inside the time-boxed quality round after grading, so the report, score and improvement all fit the function budget.", undefined, undefined, "verbose");
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
    await ctx.emit("critique", `Self-critique verdict: ${critique?.verdict ?? "skipped (model unavailable)"}`, critique?.reasoning ?? critRes?.text.slice(0, 600) ?? "", critRes?.model, { weak: critique?.weakSections?.map((w: any) => w.title) ?? [] });

    // targeted follow-up for weak sections
    const weak: { title: string; reason: string; queries: string[] }[] = (critique?.weakSections ?? []).slice(0, unlimited ? 3 : 2);
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
    if (sourcesUsed.length > 3) {
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
    let court: CourtVerdict | null = null;
    if (job.court && !ctx.outOfTime) {
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
      let prosecutionBrief = "";
      let defenseBrief = "";
      try {
        const proRes = await ctx.llmLive(prosecutionPrompt(job.query, evidenceRecord, job.language), "court-prosecution", "The prosecution is building its case", { wantThinking: true, maxTokens: 1400 });
        prosecutionBrief = proRes.text.trim();
        await ctx.emit("court", "The prosecution rests", prosecutionBrief.slice(0, 1600), proRes.model, { phase: "prosecution" });
      } catch (proErr) {
        await ctx.emit("info", "The prosecution could not build its case (models unavailable) — the trial cannot proceed fairly", proErr instanceof Error ? proErr.message.slice(0, 200) : undefined);
      }
      if (prosecutionBrief) {
        try {
          const defRes = await ctx.llmLive(defensePrompt(job.query, evidenceRecord, job.language), "court-defense", "The defense is building its case", { wantThinking: true, maxTokens: 1400 });
          defenseBrief = defRes.text.trim();
          await ctx.emit("court", "The defense rests", defenseBrief.slice(0, 1600), defRes.model, { phase: "defense" });
        } catch (defErr) {
          await ctx.emit("info", "The defense could not build its case — a one-sided trial is no trial; the verdict will note this honestly", defErr instanceof Error ? defErr.message.slice(0, 200) : undefined);
        }
      }

      // C3 — rebuttals (each side answers the other's strongest points, parallel)
      let rebuttals: { by: "prosecution" | "defense"; text: string }[] = [];
      if (prosecutionBrief && defenseBrief && !ctx.outOfTime) {
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

      // C4 — the jury: 12 independent personas (6 on the quick preset, court-skill --quick)
      const quickCourt = job.preset === "quick";
      const jury = quickCourt ? JURORS.filter((_, i) => i % 2 === 0) : JURORS;
      const rebuttalText = rebuttals.map((r) => `${r.by === "prosecution" ? "PROSECUTION" : "DEFENSE"}: ${r.text}`).join("\n\n") || "(no rebuttals)";
      const jurorVotes: { name: string; lens: string; vote: "GUILTY" | "NOT GUILTY"; reason: string }[] = [];
      if (prosecutionBrief && defenseBrief) {
        await ctx.emit("court", `The jury is deliberating — ${jury.length} independent personas reading the record`, "Each juror sees the same evidence and briefs but votes through their own lens: the accountant, the first-time customer, the competitor, the retired judge, the statistician… The vote spread is the honest signal.", undefined, { phase: "jury", jurors: jury.length });
        // bounded concurrency: 4 jurors vote at a time — 12 simultaneous calls would
        // hammer the keyless chain into cooldown for every other step of the trial
        const JUROR_CONCURRENCY = 4;
        for (let i = 0; i < jury.length; i += JUROR_CONCURRENCY) {
          if (ctx.outOfTime) break;
          const batch = jury.slice(i, i + JUROR_CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map((j) => ctx.llm(jurorPrompt(job.query, j, evidenceRecord, prosecutionBrief, defenseBrief, rebuttalText, job.language), "court-juror", false, 120, { patient: false, timeoutMs: 45_000 }))
          );
          results.forEach((r, k) => {
            const juror = batch[k];
            if (r.status === "fulfilled") {
              const v = extractJson(r.value.text);
              const vote = String(v?.vote).toUpperCase() === "GUILTY" ? "GUILTY" : "NOT GUILTY";
              const reason = String(v?.reason || r.value.text).slice(0, 240).trim() || "(no reason given)";
              jurorVotes.push({ name: juror.name, lens: juror.lens, vote, reason });
              ctx.emit("court", `Juror voted ${vote} — ${juror.name}`, reason, r.value.model, { phase: "juror", juror: juror.name, vote, reason }).catch(() => {});
            } else {
              ctx.emit("info", `${juror.name} could not vote (model unavailable) — the verdict proceeds with ${jury.length - 1 - jurorVotes.length} juror(s)`, undefined, undefined, undefined, "verbose").catch(() => {});
            }
          });
        }
        const guilty = jurorVotes.filter((v) => v.vote === "GUILTY").length;
        const notGuilty = jurorVotes.length - guilty;
        if (jurorVotes.length > 0) {
          await ctx.emit("court", `The jury has voted: ${guilty} guilty · ${notGuilty} not guilty`, `${jurorVotes.length} of ${jury.length} jurors returned a verdict${jurorVotes.length < jury.length ? " — the missing votes are noted honestly, not invented" : ""}.`, undefined, { phase: "votes", guilty, notGuilty, returned: jurorVotes.length, expected: jury.length });
        }

        // C5 — the judge reads the verdict (charges that stuck, defense wins, conditions)
        if (jurorVotes.length > 0 && !ctx.outOfTime) {
          let judge: { chargesStuck?: string[]; defenseWins?: string[]; conditions?: string[]; summary?: string } | null = null;
          try {
            const judgeRes = await ctx.llm(judgePrompt(job.query, evidenceRecord, prosecutionBrief, defenseBrief, rebuttalText, jurorVotes, job.language), "court-judge", false, 800, { patient: false, timeoutMs: 60_000 });
            judge = extractJson(judgeRes.text);
            if (judge?.summary) {
              await ctx.emit("court", "The judge reads the verdict", String(judge.summary).slice(0, 1200), judgeRes.model, { phase: "judge", ...judge });
            }
          } catch (judgeErr) {
            await ctx.emit("info", "The judge could not read the verdict — the raw vote stands without commentary", judgeErr instanceof Error ? judgeErr.message.slice(0, 160) : undefined);
          }
          const verdict: CourtVerdict = {
            charge: job.query.slice(0, 600),
            verdict: guilty > notGuilty ? "GUILTY" : "NOT GUILTY",
            guilty,
            notGuilty,
            jurors: jurorVotes,
            prosecutionBrief,
            defenseBrief,
            rebuttals,
            chargesStuck: (judge?.chargesStuck ?? []).map((c) => String(c).slice(0, 300)).slice(0, 5),
            defenseWins: (judge?.defenseWins ?? []).map((c) => String(c).slice(0, 300)).slice(0, 5),
            conditions: (judge?.conditions ?? []).map((c) => String(c).slice(0, 300)).slice(0, 6),
            judgeSummary: String(judge?.summary ?? `The jury voted ${guilty} to ${notGuilty}.`).slice(0, 800),
            quick: quickCourt,
          };
          court = verdict;
          await ctx.emit(
            "court",
            `VERDICT: ${verdict.verdict} — ${guilty} to ${notGuilty}`,
            `${verdict.judgeSummary}${verdict.conditions.length ? `\n\nWhat to change before trying again:\n${verdict.conditions.map((c) => `• ${c}`).join("\n")}` : ""}`,
            undefined,
            { phase: "verdict", verdict: verdict.verdict, guilty, notGuilty }
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
      await ctx.emit("done", "Abstained honestly — no sources retrieved", `0 sources after ${fmtMin(Date.now() - t0)} — nothing verified, so nothing claimed. Try again shortly.`, undefined, statsAbstain);
      return;
    }

    await updateJob(jobId, { status: "synthesizing", stage: "Writing the report", progress: 80 });
    const finalSections = await db.researchSection.findMany({ where: { jobId }, orderBy: { order: "asc" } });
    // v2.4.3: standard reports were 300-500 words/section (~1200 total) and the
    // grader honestly flagged thin coverage — meatier sections (420-650) lift
    // coverage+clarity without new research; the 40s draft cap still fits (llm7
    // streams 30-60 tok/s ≈ a 650-word section in ~25s)
    const words: [number, number] = unlimited || job.preset === "exhaustive" ? [550, 900] : job.preset === "deep" ? [450, 700] : [420, 650];

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
    const draftsArr: string[] = new Array(finalSections.length).fill("");
    {
      const DRAFT_POOL = SERVERLESS ? Math.min(4, finalSections.length) : Math.min(3, finalSections.length);
      await updateJob(jobId, { stage: `Writing ${finalSections.length} sections in parallel`, progress: 80 });
      const draftOne = async (sec: (typeof finalSections)[number], i: number) => {
        if (await ctx.isCancelled()) throw new Cancelled();
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
            // A patient ride here eats the whole reserve in a sustained blackout and
            // the function freezes with NOTHING persisted — a findings-based report
            // that survives beats a perfect draft that dies at 95%. The GRADE is the
            // step that gets the patient recovery ride (it is small and it is last).
            const draftRes = await ctx.llmLive(
              [{ role: "user", content: draftSectionPrompt(job.query, sec.title, sec.question, sec.findings ?? "(no findings — rely on general knowledge and clearly mark it as background)", srcs, words, job.language, evidenceNotesFor(sec.title), adversarialNotesFor(sec.title), ctx.allLearnings) }],
              "draft",
              `Writing: ${sec.title}`,
              { streamTo: sec.id, ...(SERVERLESS ? { fast: { patient: false, timeoutMs: 35_000 } } : {}) }
            );
            draftText = draftRes.text;
            draftModel = draftRes.model;
          } catch (err) {
            await ctx.emit("info", `Draft step failed for “${sec.title}” — using verified research notes directly`, err instanceof Error ? err.message.slice(0, 300) : undefined);
            draftText = sec.findings || "_Insufficient evidence was gathered for this section._";
          }
        }
        draftsArr[i] = draftText;
        await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: draftText } });
        sec.draftMd = draftText; // keep the in-memory row in sync — report assembly reads this array
        await ctx.emit("draft", `Wrote: ${sec.title}`, `${draftText.split(/\s+/).length} words`, draftModel, { section: sec.title });
        await updateJob(jobId, { progress: Math.round(80 + ((i + 1) / finalSections.length) * 14) }).catch(() => {});
      };
      const queue = finalSections.map((sec, i) => ({ sec, i }));
      const workers = Array.from({ length: DRAFT_POOL }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          await draftOne(next.sec, next.i);
        }
      });
      await Promise.all(workers);
    }

    // ---------- STAGE 4.5: QUOTE-ANCHORED CITATION VERIFICATION (P0-4) ----------
    // The industry's worst failure mode (citation studies: >60% of AI citations
    // mis-anchor) becomes digdeep's headline feature: every [n] in the drafts is
    // checked against the text that was ACTUALLY read from that source. A lexical
    // overlap scan flags weak anchors; a batched judge repairs (re-anchor) or drops
    // them. The integrity percentage is published in the stats — honestly.
    const citeStats: { checked: number; repaired: number; dropped: number; integrity: number; reanchoredTo: number[]; droppedNs: number[]; flagged: number[] } = {
      checked: 0, repaired: 0, dropped: 0, integrity: 100 as number, reanchoredTo: [], droppedNs: [], flagged: [],
    };
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
            "cite-check", false, 900, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 35_000 : 90_000 }
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
    // v2.4.5: the bundle is POLISH — when the clock is short (blackout recovery spent
    // it on the drafts), skip straight to assembly + grade; a graded report with no
    // exec summary beats a polished zombie.
    if (ctx.hardLeft < 60_000 && !court) {
      await ctx.emit("info", "Clock is short — skipping the summary polish, going straight to grading", "The drafts and references are done; the executive summary and conclusion are skipped so the self-score still fits the function budget.");
    }
    // v2.4.5: hoisted extractors with honest fallbacks — set by the bundle when it
    // runs, kept as fallbacks when the clock was too short for the polish pass
    let execText = court ? courtExecMd : "*(Executive summary unavailable — the function clock ran out during the polish pass; see section content below.)*";
    let concText = court ? "" : "";
    let titleText = job.query.slice(0, 80);
    let relatedQuestions = fallbackRelated(job.query, finalSections.map((s) => s.question));
    if (ctx.hardLeft >= 60_000 || court) {
    const [auditR, execR, concR, titleR, relatedR] = await Promise.allSettled([
      // v2.4.0: the citation audit rides IN the bundle (it only needs the drafts)
      auditWork(),
      // bounded: on a capped serverless run the tail must not ride patient cooldown
      // waits — a missed summary degrades honestly, a frozen function loses the report.
      // Clamped to the hard clock so even a late-starting tail still persists.
      court
        ? Promise.resolve({ text: "", model: "", backendId: "court", latencyMs: 0 } as LlmResult)
        : ctx.llm([{ role: "user", content: execSummaryPrompt(job.query, draftsPre, job.language, job.preset, ctx.allLearnings) }], "exec-summary", false, undefined, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? Math.min(25_000, Math.max(12_000, ctx.hardLeft - 20_000)) : Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }),
      court
        ? Promise.resolve({ text: "", model: "", backendId: "court", latencyMs: 0 } as LlmResult)
        : ctx.llm([{ role: "user", content: conclusionPrompt(job.query, draftsPre, job.language) }], "conclusion", false, undefined, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? Math.min(25_000, Math.max(12_000, ctx.hardLeft - 20_000)) : Math.min(60_000, Math.max(15_000, ctx.hardLeft - 20_000)) }),
      ctx.llm([{ role: "user", content: titlePrompt(job.query, plan.restate, job.language) }], "title", false, 60, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 15_000 : Math.min(60_000, Math.max(10_000, ctx.hardLeft - 20_000)) }),
      ctx.llm([{ role: "user", content: relatedPrompt(job.query, finalSections.map((s) => s.title), job.language) }], "related", false, 300, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 15_000 : Math.min(60_000, Math.max(10_000, ctx.hardLeft - 20_000)) }),
    ]);
    if (auditR.status === "rejected") await ctx.emit("info", "Citation audit step failed — continuing with the drafts as written", String(auditR.reason ?? "").slice(0, 300));
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
    let disagreementsMd = "";
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
    let durationMs = Date.now() - t0;
    let reportWords = drafts.split(/\s+/).length;
    const modelsUsed = Object.entries(ctx.byModel).map(([m, v]) => `${m} (${v.calls} calls)`);

    // Dedupe by URL before numbering: parallel aspect workers can still read the same
    // page in overlapping windows (the ECL run printed the same arxiv URL as both #3
    // and #8). First occurrence keeps its slot; later duplicates remap onto it so every
    // citation of that URL resolves to ONE reference number.
    let refList: typeof sourcesUsed = [];
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
    let refs = refList
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
                `| Juror | Vote | What decided them |`,
                `| --- | --- | --- |`,
                ...court.jurors.map((j) => `| ${j.name} | **${j.vote}** | ${j.reason.replace(/\|/g, "/")} |`),
                ``,
                `*Each juror read the same record through a different lens — the vote spread, not any single opinion, is the signal (${court.guilty} guilty · ${court.notGuilty} not guilty). ${court.quick ? "Quick trial: 6 jurors." : "Full jury: 12 personas."}*`,
                ``,
              ]
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
    let diffMd = "";
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
    let quality: QualityScore | null = null;
    // v2.4.0: the gate is the platform clock, not the research budget — a report
    // written from partial evidence on an expired budget still DESERVES an honest
    // score (locally hardLeft is Infinity, so budget-exhausted runs now grade too).
    if (ctx.hardLeft >= (SERVERLESS ? 40_000 : 50_000) || !ctx.outOfTime) {
    // v2.4.5: two-attempt grade on the serverless clock — a fast first pass (25s),
    // then, if the lanes were throttled, ONE patient ride that waits out the cooldown
    // window (bounded by the hard stop via the ride budget). The score is the report's
    // headline number; it deserves the recovery wait more than any polish step.
    const gradeAttempts: Array<{ wantThinking: boolean; maxTokens: number; fast?: { patient?: boolean; timeoutMs: number; maxWaitMs?: number } }> = SERVERLESS
      ? [{ wantThinking: false, maxTokens: 2000, fast: { patient: false, timeoutMs: 25_000 } }, { wantThinking: false, maxTokens: 2000, fast: { timeoutMs: 45_000, maxWaitMs: 40_000 } }]
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
    // v2.4.0: serverless runs get ONE lean round (grader-provided queries, parallel
    // searches, parallel rewrites) — sized to fit the reserved tail. Local runs keep 3.
    const QUALITY_MAX_ROUNDS = SERVERLESS ? 1 : 3;
    /** v2.4.0: the improvement loop's clock gate — the platform hard stop on
     *  serverless (65s buys search + read + rewrite + re-grade), the budget
     *  locally (stop 2 min past a budgeted deadline; unlimited runs ride free). */
    const canImprove = () =>
      ctx.hardLeft >= (SERVERLESS ? 65_000 : 200_000) &&
      !(ctx.hasTimeBudget && ctx.timeLeft < -120_000);
    let qualityRounds = 0;
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
            { wantThinking: false, maxTokens: 800, fast: { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 25_000 : 45_000 } }
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
          const picked: SearchResult[] = [];
          const domainCount: Record<string, number> = {};
          const pickCap = SERVERLESS ? 2 : 4;
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
          ? [Math.min(650, Math.round(words[0] * scale + 40)), Math.min(800, Math.round(words[1] * scale + 60))]
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
              { streamTo: sec.id, wantThinking: false, maxTokens: 2500, fast: { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 25_000 : Math.min(90_000, Math.max(20_000, ctx.hardLeft - 30_000)) } }
            );
            if (rwRes.text && rwRes.text.split(/\s+/).length > 60) {
              sec.draftMd = rwRes.text;
              draftsArr[finalSections.indexOf(sec)] = rwRes.text;
              await db.researchSection.update({ where: { id: sec.id }, data: { draftMd: rwRes.text } }).catch(() => null);
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
                "cite-check", false, 900, { ...(SERVERLESS ? { patient: false as const } : {}), timeoutMs: SERVERLESS ? 25_000 : 90_000 }
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
                { wantThinking: false, maxTokens: 2000, fast: { patient: false, timeoutMs: 25_000 } }
              ),
              ctx.llm([{ role: "user", content: execSummaryPrompt(job.query, drafts2, job.language, job.preset, ctx.allLearnings) }], "exec-summary", false, undefined, { patient: false as const, timeoutMs: 20_000 }),
              ctx.llm([{ role: "user", content: conclusionPrompt(job.query, drafts2, job.language) }], "conclusion", false, undefined, { patient: false as const, timeoutMs: 20_000 }),
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
      finishedAt: new Date().toISOString(),
    };
    await updateJob(jobId, { status: "completed", stage: "Completed", progress: 100, reportMd, stats: JSON.stringify(stats), completedAt: new Date() });
    await ctx.emit(
      "done",
      court ? `The trial is over — ${court.verdict}, ${court.guilty} to ${court.notGuilty}` : "Research complete",
      court
        ? `Verdict delivered — ${sourcesUsed.length} sources, ${court.jurors.length} jurors voted, ${ctx.llmCalls} LLM calls, ${fmtMin(durationMs)} total${court.conditions.length ? `. What to change before trying again: ${court.conditions[0].slice(0, 140)}${court.conditions.length > 1 ? "…" : ""}` : ""}`
        : `Report ready — ${refList.length} sources, ~${reportWords.toLocaleString()} words, ${ctx.llmCalls} LLM calls, ${fmtMin(durationMs)} total${quality ? `, self-scored ${quality.overall.toFixed(1)}/10${qualityRounds > 0 ? ` after ${qualityRounds} quality round${qualityRounds > 1 ? "s" : ""} (target 9 — earned with new evidence, re-graded by the same rubric)` : ""}` : ""}${citeStats.integrity < 100 ? `, citation integrity ${citeStats.integrity}%` : " with verified citations"}${spawnedCount.n > 0 ? `, ${spawnedCount.n} aspect${spawnedCount.n > 1 ? "s" : ""} spawned mid-research (recursive deep-dive)` : ""}`,
      undefined,
      stats
    );
  } catch (err) {
    if (err instanceof Cancelled) {
      await updateJob(jobId, { status: "cancelled", stage: "Cancelled", completedAt: new Date() }).catch(() => {});
      await db.activityEvent.create({ data: { jobId, type: "info", title: "Research cancelled by user", seq: 9_999_999 } }).catch(() => {});
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      await updateJob(jobId, { status: "failed", stage: "Failed", error: msg, completedAt: new Date() }).catch(() => {});
      await db.activityEvent.create({ data: { jobId, type: "error", title: "Research failed", detail: msg, seq: 9_999_999 } }).catch(() => {});
    }
  } finally {
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
  const templates = [
    { title: "Core concepts & context", question: `What is "${query}" — key definitions, background and current context?`, goal: "Establish the baseline: definitions, key entities and how the topic fits together, so later aspects have solid ground.", queries: [`${query} overview explained`, `what is ${query}`] },
    { title: "Current state & evidence", question: `What is the current state of "${query}" — latest data, players and developments?`, goal: "Capture the present state with concrete numbers, dates and named players — the evidentiary core of the report.", queries: [`${query} latest developments 2025`, `${query} statistics data`] },
    { title: "Analysis & outlook", question: `What are trends, risks and the outlook for "${query}"?`, goal: "Look forward: what is changing, what could break, and what credible observers expect next.", queries: [`${query} trends forecast`, `${query} challenges criticism risks`] },
    { title: "Practical implications", question: `What are practical implications, applications and best practices around "${query}"?`, goal: "Make the research actionable — what this means in practice for someone using or deciding about it.", queries: [`${query} applications examples`, `${query} best practices`] },
    { title: "Comparisons & alternatives", question: `How does "${query}" compare to alternatives?`, goal: "Situate the topic against its alternatives so the reader can judge relative strengths honestly.", queries: [`${query} comparison alternatives`] },
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
 *  deploy cutover) as failed, so the UI can offer a retry instead of spinning. */
export async function markStaleJobs() {
  // 5-min threshold: LLM calls heartbeat updatedAt every 60s, and search/read
  // stretches are bounded by per-fetch timeouts — so a live engine never goes
  // 5 minutes without a touch. Anything older is dead (serverless deploy
  // cutover, restart, crash) and is failed fast so the UI's retry appears.
  const stale = await db.researchJob.findMany({
    where: { status: { in: ["queued", "planning", "researching", "critiquing", "synthesizing"] }, updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
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
      continue;
    }
    await db.researchJob.update({ where: { id: j.id }, data: { status: "failed", stage: "Interrupted", error: "Job stalled or was interrupted (e.g. a redeploy or server restart). Start a new research run or tap Retry.", completedAt: new Date() } });
    await db.activityEvent.create({ data: { jobId: j.id, type: "error", title: "Job interrupted", detail: "The research process was interrupted. Please start a new run or tap Retry.", seq: 9_999_998 } }).catch(() => {});
  }
}
