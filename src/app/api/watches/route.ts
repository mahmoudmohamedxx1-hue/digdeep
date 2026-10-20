import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob } from "@/lib/research/engine";
import { getSessionUser } from "@/lib/auth";
import { listWatches, createWatch, updateWatch, deleteWatch } from "@/lib/platform/manage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * v3.4 — session-authed twin of /api/v1/watches, backing the /account UI.
 * The UI's "Run now" action starts a refresh run immediately (after()), the
 * same way the cron endpoint does.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.json({ watches: await listWatches(user.id) });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");

  if (action === "create") {
    const r = await createWatch(user.id, {
      query: String(body.query ?? ""),
      preset: typeof body.preset === "string" ? body.preset : undefined,
      court: body.court === true,
      cadenceDays: body.cadenceDays != null ? Number(body.cadenceDays) : undefined,
    });
    return r.ok ? NextResponse.json(r.watch, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "update") {
    const r = await updateWatch(user.id, String(body.id ?? ""), {
      active: typeof body.active === "boolean" ? body.active : undefined,
      cadenceDays: body.cadenceDays != null ? Number(body.cadenceDays) : undefined,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "run-now") {
    const watch = await db.watch.findUnique({ where: { id: String(body.id ?? "") } });
    if (!watch || watch.userId !== user.id) return NextResponse.json({ error: "Watch not found." }, { status: 404 });
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
    await db.watch.update({ where: { id: watch.id }, data: { nextRunAt: new Date(Date.now() + Math.max(1, watch.cadenceDays) * 86_400_000) } });
    after(runJob(job.id).catch((e) => console.error("[watch-run-now]", job.id, e)));
    return NextResponse.json({ ok: true, runId: job.id });
  }
  if (action === "delete") {
    const r = await deleteWatch(user.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
