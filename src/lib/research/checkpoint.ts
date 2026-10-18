/**
 * Continuation engine support (v2.5.0) — checkpointing + instance leases.
 *
 * Vercel Hobby caps one function invocation at 300s, which used to cap a whole
 * research run at ~113s of research + a squeezed tail. The continuation design
 * removes that ceiling: the engine persists a CHECKPOINT at every phase
 * boundary (and after each aspect/draft completes), and when a slice's clock
 * ends, the client's live-poller (1.2s interval) hits GET /api/research/[id],
 * which sees an active job with no live engine and re-triggers runJob() —
 * a fresh 300s slice that resumes from the checkpoint. The run continues
 * across slices until the ABSOLUTE budget (job.maxMinutes) is spent or the
 * report genuinely earns its score.
 *
 * The LEASE is the single-run guard across serverless instances (fluid compute
 * can serve the poll and the engine on different instances): acquiring the
 * lease is an atomic conditional UPDATE, so exactly one instance runs the
 * engine at a time. The engine renews the lease from ctx.emit()/updateJob()
 * (throttled); a frozen engine's lease expires within ~30s and the next poll's
 * resume attempt wins it cleanly.
 */

import { db } from "@/lib/db";

/** Phase cursor — monotonic. A resumed run skips everything below its phase. */
export type EnginePhase =
  | "route" // stages 0-1: understand + route + plan (sections not yet created)
  | "research" // stage 2: aspect rounds (sections exist; per-section status gates)
  | "predraft" // stages 3-3.8 done (critique/verify/curate/court) — ready to draft
  | "drafting" // stage 4: section drafts (per-section draftMd gates)
  | "tail" // stage 4.5-bundle: audit/exec/conclusion/title/related
  | "graded" // stage 5 done (quality in checkpoint) — improve loop next
  | "improving" // stage 5.5 mid-loop (qualityRounds in checkpoint)
  | "done"; // final persist happened (checkpoint is now informational)

export interface CheckpointSourceRef {
  n: number;
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
}

export interface CheckpointClaim {
  claim: string;
  grade: string;
  basis: string;
  section: string;
  verified?: string;
}

export interface CheckpointContradiction {
  claim: string;
  positions: string;
  section: string;
}

export interface CheckpointQuality {
  overall: number;
  dims: { name: string; score: number; note: string }[];
  criteria: { criterion: string; met: boolean; why: string }[];
  biggestWeakness: string;
  repairQueries: string[];
}

export interface EngineCheckpoint {
  v: 1;
  phase: EnginePhase;
  /** engine wall-clock start (ms epoch) — duration stats stay honest across slices */
  t0: number;
  /** absolute research budget end (ms epoch); null = unlimited */
  absoluteDeadline: number | null;
  /** absolute wall-clock after which no new research may start (deadline - tail reserve) */
  researchCutoffAt: number | null;
  /** slice counter — caps total serverless slices (runaway protection) */
  sliceN: number;

  // ── stage 0-1 products ────────────────────────────────────────────────
  intent?: string;
  routeWhy?: string;
  comprehensionCriteria: string[];
  rolePrompt: string;
  agentName: string;

  // ── shared research state (ctx maps) ─────────────────────────────────
  allLearnings: string[];
  claims: CheckpointClaim[];
  contradictions: CheckpointContradiction[];
  sourcesUsed: CheckpointSourceRef[];
  sourceTexts: [number, string][];
  sourceMeta: [number, { title: string; domain: string }][];
  seenUrls: string[];
  citeStats: { checked: number; repaired: number; dropped: number; integrity: number; reanchoredTo: number[]; droppedNs: number[]; flagged: number[] };
  llmCalls: number;
  byModel: Record<string, { calls: number; totalMs: number }>;
  walkedUrls: number;
  rerankRuns: number;
  aspectTimes: number[];
  sourceN: number;
  spawnedCount: number;

  // ── tail products (filled once available) ────────────────────────────
  quality?: CheckpointQuality;
  qualityRounds?: number;
  refList?: CheckpointSourceRef[];
  execText?: string;
  concText?: string;
  titleText?: string;
  relatedQuestions?: string[];
  disagreementsMd?: string;
  words?: [number, number];
  reportWords?: number;
  /** v2.5.0 tail idempotency flags — a resumed run never re-runs a finished step */
  auditDone?: boolean;
  bundleDone?: boolean;

  // ── court progress (briefs/votes accumulated across slices) ──────────
  courtProgress?: {
    prosecutionBrief?: string;
    defenseBrief?: string;
    rebuttals?: { by: string; text: string }[];
    jurorVotes?: { name: string; lens: string; vote: string; reason: string }[];
    verdictEmitted?: boolean;
  };
  /** the final verdict object once the trial completes — restored on resume */
  courtVerdict?: unknown;
}

export const PHASE_ORDER: Record<EnginePhase, number> = {
  route: 10, research: 20, predraft: 30, drafting: 40, tail: 50, graded: 60, improving: 70, done: 90,
};

export function phaseAtLeast(phase: EnginePhase | undefined, min: EnginePhase): boolean {
  if (!phase) return false;
  return PHASE_ORDER[phase] >= PHASE_ORDER[min];
}

// ── lease ────────────────────────────────────────────────────────────────

const LEASE_MS = 30_000;

/** Atomically acquire the engine lease. Returns false when another instance
 * holds a live lease (its engine is running — do not double-run). */
export async function acquireLease(jobId: string): Promise<boolean> {
  const res = await db.researchJob.updateMany({
    where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  return res.count === 1;
}

/** Renew the lease an engine already holds (throttle externally). */
export async function renewLease(jobId: string): Promise<void> {
  await db.researchJob.update({
    where: { id: jobId },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  }).catch(() => {});
}

/** Release on completion so an immediate retry never waits. */
export async function releaseLease(jobId: string): Promise<void> {
  await db.researchJob.update({
    where: { id: jobId },
    data: { leaseUntil: null },
  }).catch(() => {});
}

/** True while a live lease exists (watchdog must not fail these jobs). */
export async function hasLiveLease(jobId: string, leaseUntil: Date | null): Promise<boolean> {
  return !!leaseUntil && leaseUntil.getTime() > Date.now();
}

// ── checkpoint persistence ───────────────────────────────────────────────

/** Persist the checkpoint (fire-and-safe: a failed save must never kill the
 * run — worst case the next slice resumes from the previous boundary). */
export async function saveCheckpoint(jobId: string, cp: Partial<EngineCheckpoint> & { phase: EnginePhase }): Promise<void> {
  try {
    await db.researchJob.update({
      where: { id: jobId },
      data: { checkpoint: JSON.stringify(cp), leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
  } catch { /* the run continues — the next boundary save retries */ }
}

/** Load and validate the checkpoint of a job (null when absent/corrupt). */
export async function loadCheckpoint(job: { checkpoint: string | null }): Promise<EngineCheckpoint | null> {
  if (!job.checkpoint) return null;
  try {
    const cp = JSON.parse(job.checkpoint) as EngineCheckpoint;
    if (!cp || typeof cp !== "object" || !cp.phase) return null;
    return cp;
  } catch {
    return null;
  }
}
