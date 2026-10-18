import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob, markStaleJobs, engineAlive } from "@/lib/research/engine";

export const dynamic = "force-dynamic";
// v2.5.0: every poll can carry a continuation slice — same 300s ceiling as the
// initial POST. The engine checkpoints at slice boundaries and resumes here.
export const maxDuration = 300;

const ACTIVE = ["queued", "planning", "researching", "critiquing", "synthesizing"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sinceSeq = Number(req.nextUrl.searchParams.get("sinceSeq") ?? 0) || 0;
    // stale-job watchdog: `after()` so it also completes on serverless
    after(markStaleJobs().catch(() => {}));
    const job = await db.researchJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // ── v2.5.0 CONTINUATION TRIGGER ────────────────────────────────────────
    // An active job with no live engine on THIS instance gets re-triggered in
    // `after()`: either it was never started (queued), or a previous slice's
    // function clock ended at a checkpoint boundary. runJob internally guards
    // with the cross-instance lease + this-instance heartbeat, so a poll while
    // an engine is genuinely running anywhere is a cheap no-op.
    if (ACTIVE.includes(job.status) && !engineAlive(id)) {
      after(runJob(id).catch((e) => console.error("[engine-resume]", id, e)));
    }

    const [events, sources, sections] = await Promise.all([
      db.activityEvent.findMany({ where: { jobId: id, seq: { gt: sinceSeq } }, orderBy: { seq: "desc" }, take: 250 }),
      db.source.findMany({ where: { jobId: id }, orderBy: { createdAt: "asc" } }),
      db.researchSection.findMany({ where: { jobId: id }, orderBy: { order: "asc" } }),
    ]);
    events.reverse(); // chronological order for the client
    const counts = {
      events: await db.activityEvent.count({ where: { jobId: id } }),
      sources: sources.length,
    };
    return NextResponse.json({
      job: {
        id: job.id, query: job.query, threadId: job.threadId, status: job.status, stage: job.stage, progress: job.progress,
        preset: job.preset, mode: job.mode, language: job.language, modelPref: job.modelPref,
        breadth: job.breadth, depth: job.depth, maxSources: job.maxSources, maxMinutes: job.maxMinutes,
        reportMd: job.status === "completed" ? job.reportMd : null,
        plan: job.plan ? JSON.parse(job.plan) : null,
        stats: job.stats ? JSON.parse(job.stats) : null,
        error: job.error, createdAt: job.createdAt, completedAt: job.completedAt, startedAt: job.startedAt,
      },
      events: events.map((e) => ({
        id: e.id, seq: e.seq, ts: e.ts, type: e.type, title: e.title, detail: e.detail,
        model: e.model, meta: e.meta ? JSON.parse(e.meta) : null, level: e.level,
      })),
      sources: sources.map((s) => ({
        id: s.id, url: s.url, domain: s.domain, title: s.title, snippet: s.snippet,
        engine: s.engine, words: s.words, sectionTitle: s.sectionTitle, createdAt: s.createdAt,
      })),
      // full section rows incl. live drafts — powers the Perplexity-style streaming answer
      sections: sections.map((s) => ({
        id: s.id, order: s.order, title: s.title, question: s.question, status: s.status,
        rounds: s.rounds, findings: s.findings ?? "", draftMd: s.draftMd ?? "",
      })),
      counts,
      active: ACTIVE.includes(job.status),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Load failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const job = await db.researchJob.findUnique({ where: { id } });
    if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (body.action === "cancel") {
      if (!ACTIVE.includes(job.status)) return NextResponse.json({ error: "Job already finished" }, { status: 400 });
      await db.researchJob.update({ where: { id }, data: { cancelRequested: true, stage: "Stopping…" } });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "retry") {
      if (ACTIVE.includes(job.status)) return NextResponse.json({ error: "Job still active" }, { status: 400 });
      // wipe previous run artifacts so the engine starts clean
      // (v2.5.0: the continuation checkpoint, lease and slice counter too)
      await db.activityEvent.deleteMany({ where: { jobId: id } });
      await db.source.deleteMany({ where: { jobId: id } });
      await db.researchSection.deleteMany({ where: { jobId: id } });
      await db.researchJob.update({
        where: { id },
        data: { status: "queued", stage: "Queued", cancelRequested: false, error: null, progress: 0, reportMd: null, stats: null, plan: null, startedAt: null, completedAt: null, checkpoint: null, leaseUntil: null, sliceN: 0 },
      });
      // restart the run past the response — same contract as the initial POST
      after(runJob(id).catch(() => {}));
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Action failed" }, { status: 500 });
  }
}
