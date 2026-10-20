import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, newApiKey, hashApiKey } from "@/lib/auth";

export const maxDuration = 60;

/** GET /api/keys — my API keys (never the key itself — prefix + metadata only). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const keys = await db.apiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, revoked: true, lastUsedAt: true, createdAt: true },
  });
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: `${k.prefix}…`,
      revoked: k.revoked,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
}

/**
 * POST /api/keys — action-based:
 *  { action: "create", name? }  → creates a key; the FULL key is returned ONCE here
 *  { action: "revoke", id }     → soft-revoke
 */
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
    const count = await db.apiKey.count({ where: { userId: user.id, revoked: false } });
    if (count >= 10) return NextResponse.json({ error: "Key limit reached (10 active). Revoke one first." }, { status: 409 });
    const name = String(body.name || "").trim().slice(0, 60) || "default";
    const { key, prefix } = newApiKey();
    const rec = await db.apiKey.create({
      data: { userId: user.id, name, prefix, keyHash: hashApiKey(key) },
    });
    // the full key crosses the wire exactly once — the server keeps only its hash
    return NextResponse.json({ id: rec.id, name, prefix: `${prefix}…`, key });
  }

  if (action === "revoke") {
    const id = String(body.id || "");
    const rec = await db.apiKey.findUnique({ where: { id } });
    if (!rec || rec.userId !== user.id) return NextResponse.json({ error: "Key not found." }, { status: 404 });
    await db.apiKey.update({ where: { id }, data: { revoked: true } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
