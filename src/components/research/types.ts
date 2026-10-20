import type { ClaimCheck, ClaimVerdictSummary } from "@/lib/claim-support";

export interface EventItem {
  id: string;
  seq: number;
  ts: string;
  type: string;
  title: string;
  detail?: string | null;
  model?: string | null;
  meta?: Record<string, unknown> | null;
  level?: string;
}

export interface SourceItem {
  id: string;
  url: string;
  domain: string;
  title: string;
  snippet?: string | null;
  engine: string;
  words: number;
  sectionTitle?: string | null;
  createdAt: string;
}

export interface SectionItem {
  id: string;
  order: number;
  title: string;
  question: string;
  status: string;
  rounds: number;
  findings: string;
  draftMd: string;
}

export interface JobItem {
  id: string;
  query: string;
  threadId?: string | null;
  status: string;
  stage: string;
  progress: number;
  preset: string;
  mode?: string; // chat | quick | research — how this turn was answered
  court?: boolean; // this turn was a trial: prosecutor + defense + jury + judge
  language: string;
  modelPref: string;
  breadth: number;
  depth: number;
  maxSources: number;
  maxMinutes: number;
  reportMd?: string | null;
  docs?: { name: string }[] | null; // attached ground-truth documents (P2-3)
  plan?: {
    restate?: string;
    reportType?: string;
    academic?: boolean;
    priorKnowledge?: string;
    unknowns?: string[];
    aspects?: { title: string; question: string; goal?: string }[];
  } | null;
  stats?: {
    durationMs?: number;
    sourcesConsulted?: number;
    llmCalls?: number;
    reportWords?: number;
    sections?: number;
    relatedQuestions?: string[];
    agent?: string;
    walkedUrls?: number;
    learnings?: number;
    byModel?: Record<string, { calls: number; totalMs: number }>;
    // P0-4 citation verification
    citationIntegrity?: number;
    citationsChecked?: number;
    citationsRepaired?: number;
    citationsDropped?: number;
    /** aspects spawned mid-research by the reflection (dzhng recursive deep-dive) */
    spawnedAspects?: number;
    /** the trial verdict, when this run was a court run */
    court?: {
      charge: string;
      /** v3.0: a tied final ballot is a HUNG JURY — declared, not misread */
      verdict: "GUILTY" | "NOT GUILTY" | "HUNG JURY";
      guilty: number;
      notGuilty: number;
      jurors: { name: string; lens: string; vote: "GUILTY" | "NOT GUILTY"; reason: string; confidence?: number; changedVote?: boolean; deliberationReply?: string }[];
      /** the blind first ballot, when the jury deliberated */
      firstBallot?: { guilty: number; notGuilty: number };
      /** true when a deliberation round ran between the two ballots */
      deliberated?: boolean;
      /** the foreman's summing-up of the deliberation */
      foremanSummary?: string;
      chargesStuck: string[];
      defenseWins: string[];
      conditions: string[];
      judgeSummary: string;
      quick: boolean;
    };
    /** per-citation audit trail — which sources received re-anchored citations,
     *  which citation numbers were dropped as unsupported, which were flagged weak */
    citationAudit?: { reanchoredTo?: number[]; dropped?: number[]; flagged?: number[] };
    /** Phase 2 — the claim-level verification ledger (final citation numbering) */
    claimChecks?: ClaimCheck[];
    claimVerdict?: ClaimVerdictSummary;
    /** chat lane: reply came from the built-in script because every model was throttled */
    throttledFallback?: boolean;
    // P0-2 / P0-3
    parallelAspects?: number;
    reranked?: number;
    // P1-2 / P2-1
    redTeamAttacks?: number;
    debated?: number;
    // P1-3
    sourceDiversity?: { domains?: number; topDomain?: string; topShare?: number; medianAgeMonths?: number | null };
    // P1-1 self-score
    quality?: {
      overall: number;
      dims: { name: string; score: number; note: string }[];
      criteria: { criterion: string; met: boolean; why: string }[];
      biggestWeakness: string;
    };
    // P1-2 pre-ship score — deterministic gate, scored before delivery
    reportScore?: {
      overall: number;
      dims: { coverage: number; integrity: number; evidence: number; consistency: number; compute: number };
      flags: string[];
      passed: boolean;
    };
    rerunDiff?: boolean;
  } | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** true when this turn was opened from a shared read-only snapshot, not a run in this browser */
  sharedSnapshot?: boolean;
  sharedAt?: string | null;
}

export interface HistoryItem {
  id: string;
  query: string;
  threadId?: string | null;
  status: string;
  stage: string;
  progress: number;
  preset: string;
  mode?: string;
  createdAt: string;
  completedAt?: string | null;
  modelPref: string;
  /** Phase 2 — one-line verdict summary for Library rows */
  verdict?: { fully: number; of: number; integrity?: number } | null;
}

export interface PoolEndpointUi {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** BYOK (P2-4): undefined = keep stored key (masked in GET); "" = clear; string = set */
  key?: string;
  /** "synthesis" = prefer for report writing (frontier synthesis) */
  role?: "general" | "synthesis";
  /** server response only — whether a key is stored */
  hasKey?: boolean;
}

export interface SearchSettingsUi {
  ddg: boolean;
  searxngInstances: string[];
  mojeek: boolean;
  marginalia: boolean;
  braveKey?: string;
  googleCseKey?: string;
  googleCseCx?: string;
  hasBraveKey?: boolean;
  hasGoogleKey?: boolean;
}

export interface Turn {
  jobId: string;
  job: JobItem | null;
  events: EventItem[];
  sources: SourceItem[];
  sections: SectionItem[];
}

export interface AttachedDoc {
  name: string;
  text: string;
}

export interface AdvParams {
  breadth: number; // -1 = unlimited
  depth: number; // -1 = unlimited
  maxSources: number; // -1 = unlimited
  maxMinutes: number; // -1 = unlimited
}

export const ACTIVE_STATUSES = ["queued", "planning", "researching", "critiquing", "synthesizing"];

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}
