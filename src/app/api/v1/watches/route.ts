import { NextResponse } from "next/server";
import { userFromApiKey, hasScope, rateLimit } from "@/lib/auth";
import { listWatches, createWatch, updateWatch, deleteWatch } from "@/lib/platform/manage";

export const dynamic = "force-dynamic";

/**
 * v3.4 PUBLIC API — /api/v1/watches (scheduled/watched research)
 * Auth: Bearer <ddk_…> key with the 'watches' scope.
 *   GET                                            → { watches: [...] }
 *   POST { action: "create", query, preset?, court?, cadenceDays? } → { watch }
 *   POST { action: "update", id, active?, cadenceDays? }            → { ok }
 *   POST { action: "delete", id }                                   → { ok }
 *
 * A watch re-runs its query on the cadence; when the verdict fingerprint
 * (court verdict + claim verdict + source-domain set) changes, every
 * watch.changed webhook fires. Poll the detail endpoint of lastRunId for
 * full reports.
 */
export async function GET(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  if (!hasScope(caller, "watches")) return NextResponse.json({ error: "This API key lacks the 'watches' scope." }, { status: 403 });
  return NextResponse.json({ watches: await listWatches(caller.id) });
}

export async function POST(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  if (!hasScope(caller, "watches")) return NextResponse.json({ error: "This API key lacks the 'watches' scope." }, { status: 403 });
  if (!rateLimit(`api:${caller.id}`, 60, 60_000)) return NextResponse.json({ error: "Rate limit reached." }, { status: 429 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  if (action === "create") {
    const r = await createWatch(caller.id, {
      query: String(body.query ?? ""),
      preset: typeof body.preset === "string" ? body.preset : undefined,
      court: body.court === true,
      cadenceDays: body.cadenceDays != null ? Number(body.cadenceDays) : undefined,
    });
    return r.ok ? NextResponse.json(r.watch, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "update") {
    const r = await updateWatch(caller.id, String(body.id ?? ""), {
      active: typeof body.active === "boolean" ? body.active : undefined,
      cadenceDays: body.cadenceDays != null ? Number(body.cadenceDays) : undefined,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "delete") {
    const r = await deleteWatch(caller.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
