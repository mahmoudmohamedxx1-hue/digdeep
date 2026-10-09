import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Public share ids — 10 chars of base62. Stored bare; URLs and the API
 *  response carry the `s-` prefix so `/r/s-<id>` routes here cleanly. */
function newShareId(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * POST /api/research/[id]/share — save a read-only snapshot of a completed
 * report so the link opens for anyone, in any browser, even after the server
 * forgets the run. Keyless: the snapshot lives in the same Postgres the engine
 * already uses; nothing new is required of the user.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await db.sharedReport.findFirst({ where: { jobId: id }, select: { id: true } });
    if (existing) return NextResponse.json({ shareId: existing.id }); // idempotent — never duplicate

    const job = await db.researchJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "That research run is not on this server." }, { status: 404 });
    if (job.status !== "completed" || !job.reportMd) {
      return NextResponse.json({ error: "Only finished reports can be shared — wait for the run to complete." }, { status: 409 });
    }

    // sources travel with the snapshot so the evidence panel works for viewers
    const sources = await db.source.findMany({
      where: { jobId: id },
      orderBy: { createdAt: "asc" },
      select: { url: true, domain: true, title: true, snippet: true, sectionTitle: true },
    });

    const shareId = newShareId();
    await db.sharedReport.create({
      data: {
        id: shareId,
        jobId: id,
        threadId: job.threadId,
        query: job.query,
        mode: job.mode,
        language: job.language,
        preset: job.preset,
        reportMd: job.reportMd,
        stats: job.stats,
        sources: JSON.stringify(sources),
      },
    });
    return NextResponse.json({ shareId: `s-${shareId}` });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the snapshot — try again." },
      { status: 500 }
    );
  }
}

/** GET — cheap existence probe (which share id belongs to this job). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const snap = await db.sharedReport.findUnique({ where: { jobId: id }, select: { id: true } });
  if (!snap) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ shareId: snap.id });
}
