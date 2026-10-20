import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob } from "@/lib/research/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * v3.4 — the scheduled-research tick. Vercel Cron hits this daily (see
 * vercel.json); with CRON_SECRET set, Vercel sends it as a Bearer token.
 * Also callable manually: POST with the same auth (e.g. from the account UI
 * or curl) — idempotent per watch.
 *
 * For every ACTIVE watch whose nextRunAt has passed (and that has no run
 * already in flight): start a research run carrying watchId. The engine's
 * completion hook (notifyRunFinished) compares the verdict fingerprint,
 * fires watch.changed webhooks on a change, and schedules the next refresh.
 */
const ACTIVE = ["queued", "planning", "researching", "critiquing", "synthesizing"];
const BATCH_CAP = 10; // Hobby plan: keep one tick's fan-out modest

async function tick(): Promise<{ processed: number; started: string[]; skipped: number }> {
  const due = await db.watch.findMany({
    where: { active: true, nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: "asc" },
    take: BATCH_CAP,
  });
  const started: string[] = [];
  let skipped = 0;
  for (const watch of due) {
    // never double-fire: if a refresh run for this watch is still active, wait
    const inflight = await db.researchJob.count({ where: { watchId: watch.id, status: { in: ACTIVE } } });
    if (inflight > 0) {
      skipped++;
      // push next attempt a day out so it isn't retried every tick forever
      await db.watch.update({ where: { id: watch.id }, data: { nextRunAt: new Date(Date.now() + 86_400_000) } }).catch(() => {});
      continue;
    }
    const job = await db.researchJob.create({
      data: {
        query: watch.query,
        preset: watch.preset,
        court: watch.court,
        language: watch.language,
        domain: watch.domain,
        userId: watch.userId,
        watchId: watch.id,
        status: "queued",
        stage: "Queued (watch refresh)",
      },
    });
    // notifyRunFinished sets the next nextRunAt on completion; this interim
    // bump only guards against a failed tick re-starting it before completion.
    await db.watch.update({ where: { id: watch.id }, data: { nextRunAt: new Date(Date.now() + 6 * 3_600_000) } }).catch(() => {});
    after(runJob(job.id).catch((e) => console.error("[cron-watch]", job.id, e)));
    started.push(job.id);
  }
  return { processed: due.length, started, skipped };
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // unset → endpoint is closed, not open
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await tick());
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await tick());
}
