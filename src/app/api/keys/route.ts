import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, newApiKey, hashApiKey, KEY_SCOPES, type KeyScope } from "@/lib/auth";
import { monthlyKeyUsage } from "@/lib/platform/start-run";
import { encodeStringArray, parseStringArray } from "@/lib/platform/dbjson";

export const maxDuration = 60;

/** GET /api/keys — my API keys (never the key itself — prefix + metadata only). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const keys = await db.apiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, revoked: true, lastUsedAt: true, createdAt: true, scopes: true, monthlyLimit: true },
  });
  return NextResponse.json({
    keys: await Promise.all(
      keys.map(async (k) => ({
        id: k.id,
        name: k.name,
        prefix: `${k.prefix}…`,
        revoked: k.revoked,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
        scopes: parseStringArray(k.scopes),
        monthlyLimit: k.monthlyLimit,
        usage: k.monthlyLimit != null && !k.revoked ? await monthlyKeyUsage(k.id) : null,
      })),
    ),
  });
}

/**
 * POST /api/keys — action-based:
 *  { action: "create", name?, scopes?, monthlyLimit? }  → creates a key; the FULL key is returned ONCE here
 *  { action: "revoke", id }                             → soft-revoke
 *
 * v3.4: keys carry scopes (default: all four) and an optional monthly run
 * quota (null = unlimited, max 5000).
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
    const scopes = Array.isArray(body.scopes)
      ? [...new Set(body.scopes.map(String).filter((s): s is KeyScope => (KEY_SCOPES as readonly string[]).includes(s)))]
      : [...KEY_SCOPES];
    if (!scopes.length) return NextResponse.json({ error: "Select at least one scope." }, { status: 400 });
    const rawLimit = body.monthlyLimit;
    const monthlyLimit = rawLimit == null || rawLimit === "" ? null : Math.min(5000, Math.max(1, Math.round(Number(rawLimit))));
    if (rawLimit != null && rawLimit !== "" && !Number.isFinite(monthlyLimit)) {
      return NextResponse.json({ error: "monthlyLimit must be a number." }, { status: 400 });
    }
    const { key, prefix } = newApiKey();
    const rec = await db.apiKey.create({
      data: { userId: user.id, name, prefix, keyHash: hashApiKey(key), scopes: encodeStringArray(scopes), monthlyLimit },
    });
    // the full key crosses the wire exactly once — the server keeps only its hash
    return NextResponse.json({ id: rec.id, name, prefix: `${prefix}…`, key, scopes, monthlyLimit });
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
