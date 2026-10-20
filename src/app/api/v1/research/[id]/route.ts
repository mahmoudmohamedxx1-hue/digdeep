import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob, engineAlive } from "@/lib/research/engine";
import { userFromApiKey } from "@/lib/auth";

export const dynamic = "force-dynamic";
// continuation polls extend this function past the response — same 300s
// ceiling as the POST that starts the run and the UI's internal endpoint.
export const maxDuration = 300;

// v3.3.1: statuses that an engine can still resume from a checkpoint.
const ACTIVE = ["queued", "planning", "researching", "critiquing", "synthesizing"];

/**
 * P2-3 PUBLIC API — GET /api/v1/research/<id>
 * The verified-report read model: full report markdown + the verification
 * ledger (claimChecks, citation audit, court verdict, pre-ship score) +
 * sources. 404s for runs the key does not own.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  const { id } = await params;
  const job = await db.researchJob.findUnique({
    where: { id },
    include: { sources: { orderBy: { createdAt: "asc" } } },
  });
  if (!job || job.userId !== caller.id) {
    return NextResponse.json({ error: "Research run not found for this key." }, { status: 404 });
  }
  // ── v3.3.1 CONTINUATION TRIGGER (P1 fix) ─────────────────────────────────
  // On serverless the run's `after()` slice dies at a checkpoint when the
  // function clock ends. The UI self-heals this because its internal status
  // endpoint re-triggers the engine; API-only users had NO such trigger —
  // their run stalled forever (observed live: a quick run pinned at 96% for
  // 20 min until the internal endpoint was hit). Same pattern as the internal
  // route: the owner's poll resumes the engine; the lease + heartbeat guards
  // in runJob make this a no-op while an engine is genuinely running.
  if (ACTIVE.includes(job.status) && !engineAlive(job.id)) {
    after(runJob(job.id).catch((e) => console.error("[api-v1-resume]", job.id, e)));
  }
  let stats: Record<string, unknown> = {};
  try { stats = job.stats ? JSON.parse(job.stats) : {}; } catch { stats = {}; }
  const court = stats.court as Record<string, unknown> | undefined;
  const reportScore = stats.reportScore as Record<string, unknown> | undefined;
  const claimVerdict = stats.claimVerdict as Record<string, unknown> | undefined;
  return NextResponse.json({
    id: job.id,
    query: job.query,
    status: job.status,
    progress: job.progress,
    mode: job.mode,
    domain: job.domain,
    preset: job.preset,
    language: job.language,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    report: job.status === "completed" ? job.reportMd : null,
    verification: {
      citationIntegrity: stats.citationIntegrity ?? null,
      citationsChecked: stats.citationsChecked ?? null,
      citationsRepaired: stats.citationsRepaired ?? null,
      citationsDropped: stats.citationsDropped ?? null,
      claimVerdict: claimVerdict ?? null,
      claimChecks: (stats.claimChecks as unknown[]) ?? [],
      court: court
        ? {
            verdict: court.verdict ?? null,
            guilty: court.guilty ?? null,
            notGuilty: court.notGuilty ?? null,
            judgeSummary: court.judgeSummary ?? null,
          }
        : null,
      reportScore: reportScore ?? null,
    },
    sources: job.sources.map((s) => ({
      url: s.url, domain: s.domain, title: s.title, words: s.words, used: s.used, section: s.sectionTitle,
    })),
    exportUrls:
      job.status === "completed"
        ? {
            pdf: `/api/research/${job.id}/export?format=pdf`,
            docx: `/api/research/${job.id}/export?format=docx`,
            xlsx: `/api/research/${job.id}/export?format=xlsx`,
            markdown: `/api/research/${job.id}/export?format=md`,
          }
        : null,
  });
}
