/**
 * P1-2 Pre-ship report scoring — a deterministic, LLM-free gate that scores
 * every report BEFORE it reaches the user, on the three dimensions the
 * strategic plan named: evidence coverage, citation integrity, and verdict
 * consistency. Produces a `reportScore` block persisted into job stats.
 *
 * This is NOT the LLM self-grade (that stays in engine Stage 5); this is the
 * objective, replayable check that runs after the improve loop settles:
 *   - coverage:    share of report claims that carry citations + support
 *   - integrity:   the citation audit's surviving-citation ratio
 *   - consistency: court verdict vs claim ledger agreement (court runs)
 *   - evidence:    source diversity + authority share (domain packs boost)
 *   - compute:     every [[COMPUTE]] resolved (no unresolved/broken math)
 */
import type { ClaimCheck, ClaimVerdictSummary } from "@/lib/claim-support";

export interface ReportScore {
  version: 1;
  scoredAt: string;
  overall: number; // 0-100
  dims: {
    coverage: number; // 0-100 — claims carrying citations
    integrity: number; // 0-100 — citation audit survivors
    evidence: number; // 0-100 — diversity + authority
    consistency: number; // 0-100 — verdict vs ledger (court) or claim agreement
    compute: number; // 0-100 — resolved compute directives
  };
  flags: string[]; // human-readable warnings that gated delivery
  passed: boolean; // overall >= 60 and no hard-fail flag
}

export interface ScoreInputs {
  reportMd: string;
  claimChecks?: ClaimCheck[];
  claimVerdict?: ClaimVerdictSummary | null;
  citationIntegrity?: number; // 0-100 from the audit
  courtVerdict?: string | null; // "GUILTY" | "NOT GUILTY" | "HUNG JURY" | null
  sources?: { domain: string; quality?: number; used?: boolean }[];
  authorityDomains?: string[];
  unresolvedComputes?: number; // count of (compute error: …) left in the text
}

const IRRELEVANT_FLAGS = new Set<string>();

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** Sentence-ish split for claim counting (excludes headings/lists/refs). */
function claimishSentences(md: string): string[] {
  const body = md
    .replace(/^#{1,6} .*$/gm, "") // headings
    .replace(/^[-*] .*?\[sources?|references\].*$/gim, "")
    .replace(/^>.*$/gm, "") // quotes
    .split(/\n(?=## )/)[0] || md; // fall back to whole doc
  return (body.match(/[^.!?]+[.!?]/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 6);
}

export function scoreReport(input: ScoreInputs): ReportScore {
  const flags: string[] = [];

  // ── coverage: cited sentences among claim-ish sentences ──────────────────
  const sentences = claimishSentences(input.reportMd ?? "");
  const cited = sentences.filter((s) => /\[\d{1,3}\]/.test(s));
  let coverage = sentences.length ? (cited.length / sentences.length) * 100 : 0;
  // credit verified claims from the ledger (they are the gold standard)
  const cc = input.claimChecks ?? [];
  if (cc.length > 0) {
    const verifiedShare = cc.filter((c) => c.verdict !== "unverified").length / cc.length;
    coverage = coverage * 0.4 + verifiedShare * 100 * 0.6;
  }
  if (sentences.length > 0 && coverage < 50) {
    flags.push(`Coverage ${Math.round(coverage)}%: under half of report claims carry verified citations.`);
  }

  // ── integrity: the citation audit ratio ──────────────────────────────────
  const integrity = clamp(input.citationIntegrity ?? 100);
  if (integrity < 80) flags.push(`Citation integrity ${integrity}%: some citations were re-anchored or dropped.`);

  // ── evidence: diversity + authority share among used sources ────────────
  const used = (input.sources ?? []).filter((s) => s.used !== false);
  const domains = new Set(used.map((s) => s.domain));
  const auth = new Set((input.authorityDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean));
  const authShare = used.length
    ? used.filter((s) => auth.has(s.domain?.toLowerCase()) || [...auth].some((a) => s.domain?.toLowerCase().endsWith(`.${a}`) || s.domain?.toLowerCase() === a)).length / used.length
    : 0;
  const diversity = Math.min(1, domains.size / 8); // 8 distinct domains = full credit
  let evidence = (diversity * 0.6 + authShare * 0.4) * 100;
  if (auth.size === 0) evidence = diversity * 100; // general runs: diversity only
  if (used.length > 0 && used.length < 4) {
    flags.push(`Only ${used.length} sources used — thin evidence base.`);
  }

  // ── consistency: court verdict vs claim ledger (court runs) ──────────────
  let consistency = 100;
  if (cc.length > 0) {
    const verified = cc.filter((c) => c.verdict === "verified").length;
    const unverified = cc.filter((c) => c.verdict === "unverified").length;
    if (input.courtVerdict === "GUILTY" && unverified > verified) {
      consistency = 55;
      flags.push("Verdict-consistency: court found GUILTY while most checked claims are unverified — the report states this tension.");
    } else if (input.courtVerdict === "HUNG JURY") {
      consistency = 85; // honest withholding is expected to cost some claims
    } else {
      consistency = clamp(60 + (verified / Math.max(1, cc.length)) * 40);
    }
  }

  // ── compute: unresolved [[COMPUTE]] markers ──────────────────────────────
  const unresolved = (input.unresolvedComputes ?? 0) + (input.reportMd.match(/\(compute error:/g) ?? []).length;
  const compute = clamp(100 - unresolved * 25);
  if (unresolved > 0) flags.push(`${unresolved} compute expression(s) failed to evaluate — check the flagged math.`);

  const dims = {
    coverage: clamp(coverage),
    integrity,
    evidence: clamp(evidence),
    consistency: clamp(consistency),
    compute,
  };
  const overall = clamp(
    dims.coverage * 0.3 + dims.integrity * 0.25 + dims.evidence * 0.2 + dims.consistency * 0.15 + dims.compute * 0.1,
  );
  const passed = overall >= 60 && dims.integrity >= 50;
  if (!passed && overall < 60) flags.unshift(`Pre-ship score ${overall}/100 — below the 60 gate; the report ships with this warning surfaced.`);

  return {
    version: 1,
    scoredAt: new Date().toISOString(),
    overall,
    dims,
    flags: flags.slice(0, 6),
    passed,
  };
}

/** Tiny rollup for telemetry aggregation (P1-2 dataset). */
export function telemetryRow(jobId: string, score: ReportScore, court: boolean, preset: string) {
  return {
    jobId,
    overall: score.overall,
    coverage: score.dims.coverage,
    integrity: score.dims.integrity,
    evidence: score.dims.evidence,
    consistency: score.dims.consistency,
    compute: score.dims.compute,
    court,
    preset,
    scoredAt: score.scoredAt,
  };
}
