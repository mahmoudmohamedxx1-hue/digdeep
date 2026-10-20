import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob } from "@/lib/research/engine";
import { isValidModelPref } from "@/lib/model-choices";
import { isValidDomain } from "@/lib/research/domain-packs";
import { userFromApiKey, rateLimit } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * P2-3 PUBLIC API — POST /api/v1/research
 * Auth: Bearer <ddk_…> API key (create at /account).
 * Body: { query, preset?, court?, language?, domain?, modelPref?, breadth?, depth?, maxSources?, maxMinutes? }
 * Returns: { id, status, detail: "/api/v1/research/<id>" }
 *
 * This is the SAME engine the app runs — the verified-report pipeline with
 * citation audit, claim ledger, optional court, and the pre-ship score.
 */
const PRESETS: Record<string, { breadth: number; depth: number; maxSources: number; maxMinutes: number }> = {
  quick: { breadth: 2, depth: 1, maxSources: 8, maxMinutes: 10 },
  standard: { breadth: 3, depth: 2, maxSources: 18, maxMinutes: 30 },
  deep: { breadth: 4, depth: 3, maxSources: 45, maxMinutes: 180 },
  exhaustive: { breadth: 5, depth: 3, maxSources: 120, maxMinutes: 720 },
};

export async function POST(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) {
    return NextResponse.json(
      { error: "Missing or invalid API key. Pass 'Authorization: Bearer ddk_…' (create one at /account)." },
      { status: 401 },
    );
  }
  if (!rateLimit(`api:${caller.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "API rate limit reached (60 starts/minute)." }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const query = String(body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });
  const presetKey = typeof body.preset === "string" && body.preset in PRESETS ? body.preset : "standard";
  const preset = presetKey;
  const p = PRESETS[presetKey];
  const clamp = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  try {
    const job = await db.researchJob.create({
      data: {
        query: query.slice(0, 600),
        preset: presetKey,
        court: body.court === true,
        language: ["English", "Arabic", "Chinese", "Spanish", "French", "German", "Auto-match topic"].includes(body.language as string)
          ? (body.language as string) : "English",
        modelPref: isValidModelPref(body.modelPref) ? (body.modelPref as string) : "auto",
        domain: isValidDomain(body.domain) ? (body.domain as string) : "general",
        userId: caller.id,
        breadth: body.breadth != null ? clamp(body.breadth, 1, 50, p.breadth) : p.breadth,
        depth: body.depth != null ? clamp(body.depth, 1, 20, p.depth) : p.depth,
        maxSources: body.maxSources != null ? clamp(body.maxSources, 4, 1000, p.maxSources) : p.maxSources,
        maxMinutes: body.maxMinutes != null ? clamp(body.maxMinutes, 5, 2880, p.maxMinutes) : p.maxMinutes,
        status: "queued",
        stage: "Queued",
      },
    });
    after(runJob(job.id).catch((e) => console.error("[api-v1]", job.id, e)));
    return NextResponse.json({ id: job.id, status: "queued", detail: `/api/v1/research/${job.id}` }, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to start research" }, { status: 500 });
  }
}

/** GET /api/v1/research — the caller's recent API runs (status polling list). */
export async function GET(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  const jobs = await db.researchJob.findMany({
    where: { userId: caller.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, query: true, status: true, progress: true, createdAt: true, completedAt: true },
  });
  return NextResponse.json({ jobs });
}
