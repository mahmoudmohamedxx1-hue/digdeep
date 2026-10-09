import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runJob } from "@/lib/research/engine";

export const dynamic = "force-dynamic";

const PRESETS: Record<string, { breadth: number; depth: number; maxSources: number; maxMinutes: number }> = {
  quick: { breadth: 2, depth: 1, maxSources: 8, maxMinutes: 10 },
  standard: { breadth: 3, depth: 2, maxSources: 18, maxMinutes: 30 },
  deep: { breadth: 4, depth: 3, maxSources: 45, maxMinutes: 180 },
  exhaustive: { breadth: 5, depth: 3, maxSources: 120, maxMinutes: 720 },
  unlimited: { breadth: -1, depth: -1, maxSources: -1, maxMinutes: -1 },
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const query = String(body.query ?? "").trim();
    if (!query) {
      return NextResponse.json({ error: "Please type a message first." }, { status: 400 });
    }
    const preset = PRESETS[body.preset] ? body.preset : "standard";
    const p = PRESETS[preset];
    // -1 = unlimited (no cap); otherwise clamp to sane range
    const clamp = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      if (n === -1) return -1;
      return Math.min(max, Math.max(min, Math.round(n)));
    };
    // user-attached ground-truth documents (P2-3): up to 4, each capped at 120k chars
    const rawDocs = Array.isArray(body.docs) ? body.docs : [];
    const docs = rawDocs
      .filter((d: { name?: unknown; text?: unknown }) => typeof d?.name === "string" && typeof d?.text === "string" && (d.text as string).trim().length > 0)
      .slice(0, 4)
      .map((d: { name: string; text: string }) => ({ name: d.name.slice(0, 120), text: d.text.slice(0, 120_000) }));
    const job = await db.researchJob.create({
      data: {
        query: query.slice(0, 600),
        threadId: typeof body.threadId === "string" && body.threadId.length > 0 ? body.threadId : null,
        preset,
        language: ["English", "Arabic", "Chinese", "Spanish", "French", "German", "Auto-match topic"].includes(body.language) ? body.language : "English",
        modelPref: ["auto", "glm", "pool"].includes(body.modelPref) ? body.modelPref : "auto",
        breadth: body.breadth != null ? clamp(body.breadth, 1, 50, p.breadth) : p.breadth,
        depth: body.depth != null ? clamp(body.depth, 1, 20, p.depth) : p.depth,
        maxSources: body.maxSources != null ? clamp(body.maxSources, 4, 1000, p.maxSources) : p.maxSources,
        maxMinutes: body.maxMinutes != null ? clamp(body.maxMinutes, 5, 2880, p.maxMinutes) : p.maxMinutes,
        ...(docs.length > 0 ? { docs: JSON.stringify(docs) } : {}),
        status: "queued",
        stage: "Queued",
      },
    });
    // fire-and-forget background run (survives page reloads; state persisted in PostgreSQL)
    void runJob(job.id).catch((e) => console.error("[engine]", job.id, e));
    return NextResponse.json({ id: job.id, threadId: job.threadId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to start research" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const threadId = req.nextUrl.searchParams.get("threadId");
    if (threadId) {
      const jobs = await db.researchJob.findMany({
        where: { threadId },
        orderBy: { createdAt: "asc" },
        select: { id: true, query: true, status: true, stage: true, progress: true, preset: true, mode: true, createdAt: true, completedAt: true, modelPref: true, language: true },
      });
      return NextResponse.json({ jobs, threadId });
    }
    const jobs = await db.researchJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, query: true, status: true, stage: true, progress: true, preset: true, mode: true, threadId: true, createdAt: true, completedAt: true, modelPref: true },
    });
    return NextResponse.json({ jobs });
  } catch {
    return NextResponse.json({ jobs: [] });
  }
}
