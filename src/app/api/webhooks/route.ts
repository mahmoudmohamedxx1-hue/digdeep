import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listWebhooks, createWebhook, updateWebhook, rotateWebhookSecret, deleteWebhook } from "@/lib/platform/manage";

export const dynamic = "force-dynamic";

/** v3.4 — session-authed twin of /api/v1/webhooks, backing the /account UI. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  return NextResponse.json({ webhooks: await listWebhooks(user.id) });
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
    const r = await createWebhook(user.id, String(body.url ?? ""), Array.isArray(body.events) ? body.events.map(String) : []);
    return r.ok ? NextResponse.json(r.webhook, { status: 201 }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "update") {
    const r = await updateWebhook(user.id, String(body.id ?? ""), {
      active: typeof body.active === "boolean" ? body.active : undefined,
      events: Array.isArray(body.events) ? body.events.map(String) : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
    });
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "rotate-secret") {
    const r = await rotateWebhookSecret(user.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ secret: r.secret }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  if (action === "delete") {
    const r = await deleteWebhook(user.id, String(body.id ?? ""));
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: r.status });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
