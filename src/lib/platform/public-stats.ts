import { unstable_cache } from "next/cache";
import { db } from "@/lib/db";

/**
 * v3.4 — PUBLIC TRACK RECORD: live production stats, computed from real runs.
 * The /benchmark harness numbers answer "how good is the method on a fixed
 * question set"; these numbers answer "what has the system actually done".
 *
 * Aggregations over the RECENT window (default 500 completed runs) parse
 * stats JSON per row — bounded and honest ("recent 500"), never presented as
 * all-time. Cached 60s so the benchmark page and /api/stats stay cheap.
 */

export interface PublicStats {
  generatedAt: string;
  window: { recentRuns: number; label: string };
  totals: {
    completedRuns: number;
    failedRuns: number;
    sourcesConsulted: number;
    sharedReports: number;
    accounts: number;
    activeWatches: number;
  };
  last7d: { completedRuns: number; startedRuns: number };
  quality: {
    avgCitationIntegrity: number | null;
    claimChecks: number;
    courtRuns: number;
    guilty: number;
    notGuilty: number;
    hung: number;
    avgSelfScore: number | null;
  };
  duration: { p50Sec: number | null; p90Sec: number | null };
}

const RECENT = 500;

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function compute(): Promise<PublicStats> {
  const [completed, failed, sources, shares, accounts, watches, weekCompleted, weekStarted, recentJobs] = await Promise.all([
    db.researchJob.count({ where: { status: "completed" } }),
    db.researchJob.count({ where: { status: "failed" } }),
    db.source.count(),
    db.sharedReport.count(),
    db.user.count(),
    db.watch.count({ where: { active: true } }),
    db.researchJob.count({ where: { status: "completed", completedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    db.researchJob.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    db.researchJob.findMany({
      where: { status: "completed" },
      orderBy: { completedAt: "desc" },
      take: RECENT,
      select: { stats: true, court: true, startedAt: true, completedAt: true },
    }),
  ]);

  let integritySum = 0, integrityN = 0, claimChecks = 0, courtRuns = 0, guilty = 0, notGuilty = 0, hung = 0, scoreSum = 0, scoreN = 0;
  const durations: number[] = [];
  for (const j of recentJobs) {
    let s: Record<string, unknown> = {};
    try { s = j.stats ? JSON.parse(j.stats) : {}; } catch { s = {}; }
    if (typeof s.citationIntegrity === "number") { integritySum += s.citationIntegrity; integrityN++; }
    if (Array.isArray(s.claimChecks)) claimChecks += s.claimChecks.length;
    const court = s.court as Record<string, unknown> | undefined;
    if (j.court || court?.verdict) {
      courtRuns++;
      const v = court?.verdict;
      if (v === "GUILTY") guilty++;
      else if (v === "NOT GUILTY") notGuilty++;
      else if (v === "HUNG JURY") hung++;
    }
    const rs = s.reportScore as Record<string, unknown> | undefined;
    if (rs && typeof rs.overall === "number") { scoreSum += rs.overall; scoreN++; }
    if (j.startedAt && j.completedAt) {
      const d = (j.completedAt.getTime() - j.startedAt.getTime()) / 1000;
      if (d > 0 && d < 86_400) durations.push(d);
    }
  }
  durations.sort((a, b) => a - b);

  return {
    generatedAt: new Date().toISOString(),
    window: { recentRuns: recentJobs.length, label: `recent ${recentJobs.length} completed runs` },
    totals: {
      completedRuns: completed,
      failedRuns: failed,
      sourcesConsulted: sources,
      sharedReports: shares,
      accounts,
      activeWatches: watches,
    },
    last7d: { completedRuns: weekCompleted, startedRuns: weekStarted },
    quality: {
      avgCitationIntegrity: integrityN ? Math.round((integritySum / integrityN) * 10) / 10 : null,
      claimChecks,
      courtRuns,
      guilty,
      notGuilty,
      hung,
      avgSelfScore: scoreN ? Math.round((scoreSum / scoreN) * 10) / 10 : null,
    },
    duration: {
      p50Sec: percentile(durations, 50),
      p90Sec: percentile(durations, 90),
    },
  };
}

export const getPublicStats = unstable_cache(compute, ["public-stats"], { revalidate: 60 });
