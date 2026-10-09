import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export interface SharedSnapshotJob {
  id: string;
  query: string;
  threadId: string | null;
  status: string;
  stage: string;
  progress: number;
  preset: string;
  mode: string;
  language: string;
  modelPref: string;
  reportMd: string | null;
  stats: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
  sharedSnapshot: true;
  sharedAt: string;
}

/**
 * GET /api/share/[id] — the read-only snapshot for a shared link (`/r/s-…`).
 * Anyone can open it: no cookies, no account, no key. Returns the report job
 * shape (with `sharedSnapshot: true` so the UI can mark it read-only) plus the
 * sources that were captured with it.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const snap = await db.sharedReport.findUnique({ where: { id } });
    if (!snap) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      job: {
        id: `shared:${snap.id}`,
        query: snap.query,
        threadId: snap.threadId,
        status: "completed",
        stage: "Shared snapshot",
        progress: 100,
        preset: snap.preset,
        mode: snap.mode,
        language: snap.language,
        modelPref: "auto",
        reportMd: snap.reportMd,
        stats: snap.stats ? JSON.parse(snap.stats) : null,
        createdAt: snap.createdAt.toISOString(),
        completedAt: snap.createdAt.toISOString(),
        sharedSnapshot: true as const,
        sharedAt: snap.createdAt.toISOString(),
      } satisfies SharedSnapshotJob,
      sources: JSON.parse(snap.sources) as { url: string; domain: string; title: string; snippet: string | null; sectionTitle: string | null }[],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load the shared report." },
      { status: 500 }
    );
  }
}
