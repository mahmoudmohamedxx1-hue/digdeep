import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userFromApiKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

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
