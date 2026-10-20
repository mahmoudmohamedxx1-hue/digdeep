import { NextResponse } from "next/server";
import { userFromApiKey, hasScope, rateLimit } from "@/lib/auth";
import { listWebhooks, createWebhook, updateWebhook, rotateWebhookSecret, deleteWebhook } from "@/lib/platform/manage";

export const dynamic = "force-dynamic";

/**
 * v3.4 PUBLIC API — /api/v1/webhooks
 * Auth: Bearer <ddk_…> key with the 'webhooks' scope.
 *   GET                              → { webhooks: [...] } (with recent deliveries)
 *   POST { action: "create", url, events }            → { webhook }
 *   POST { action: "update", id, active?, events?, url? } → { ok }
 *   POST { action: "rotate-secret", id }              → { secret }
 *   POST { action: "delete", id }                     → { ok }
 *
 * Deliveries are HMAC-SHA256 signed: X-DigDeep-Signature: sha256=HMAC(secret,
 * `${X-DigDeep-Timestamp}.${body}`) — verify and reject stale timestamps.
 */
export async function GET(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  if (!hasScope(caller, "webhooks")) return NextResponse.json({ error: "This API key lacks the 'webhooks' scope." }, { status: 403 });
  return NextResponse.json({ webhooks: await listWebhooks(caller.id) });
}

export async function POST(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) return NextResponse.json({ error: "Missing or invalid API key." }, { status: 401 });
  if (!hasScope(caller, "webhooks")) return NextResponse.json({ error: "This API key lacks the 'webhooks' scope." }, { status: 403 });
  if (!rateLimit(`api:${caller.id}`, 60, 60_000)) return NextResponse.json({ error: "Rate limit reached." }, { status: 429 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  if (action === "create") {
    const r = await createWebhook(caller.id, String(body.url ?? ""), Array.isArray(body.events) ? body.events.map(String) : []);
    return r.ok ? NextResponse.json(r.webhook, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "update") {
    const r = await updateWebhook(caller.id, String(body.id ?? ""), {
      active: typeof body.active === "boolean" ? body.active : undefined,
      events: Array.isArray(body.events) ? body.events.map(String) : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "rotate-secret") {
    const r = await rotateWebhookSecret(caller.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ secret: r.secret }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "delete") {
    const r = await deleteWebhook(caller.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
