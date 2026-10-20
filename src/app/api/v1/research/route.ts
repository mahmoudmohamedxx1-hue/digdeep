import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { userFromApiKey, rateLimit, hasScope } from "@/lib/auth";
import { startResearchRun } from "@/lib/platform/start-run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * P2-3 PUBLIC API — POST /api/v1/research
 * Auth: Bearer <ddk_…> API key (create at /account).
 * Body: { query, preset?, court?, language?, domain?, modelPref?, breadth?, depth?, maxSources?, maxMinutes? }
 * Returns: { id, status, detail: "/api/v1/research/<id>" }
 *
 * v3.4: the key's scopes gate the call (research:write) and its monthly
 * quota is enforced here — runs are attributed to the key for usage meters.
 *
 * This is the SAME engine the app runs — the verified-report pipeline with
 * citation audit, claim ledger, optional court, and the pre-ship score.
 */
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
  const result = await startResearchRun(caller, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.retryAt ? { retryAt: result.retryAt } : {}) }, { status: result.status });
  }
  return NextResponse.json(
    { id: result.id, status: "queued", detail: `/api/v1/research/${result.id}` },
    { status: 202 },
  );
}

/** GET /api/v1/research — the caller's recent API runs (status polling list). */
export async function GET(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  if (!hasScope(caller, "research:read")) {
    return NextResponse.json({ error: "This API key lacks the 'research:read' scope." }, { status: 403 });
  }
  const jobs = await db.researchJob.findMany({
    where: { userId: caller.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, query: true, status: true, progress: true, createdAt: true, completedAt: true },
  });
  return NextResponse.json({ jobs });
}
