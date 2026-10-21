import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSessionUser,
  hashPassword,
  rateLimit,
  clientIp,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";
import { isAdminEmail } from "@/lib/platform/admin";

export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Attach the deployment's admin flag so the UI can badge operator accounts.
 *  Purely informational — every actual gate re-checks server-side. */
function withAdminFlag<T extends { email: string }>(user: T): T & { isAdmin: boolean } {
  return { ...user, isAdmin: isAdminEmail(user.email) };
}

/** GET /api/auth — current session user (null when signed out). */
export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({ user: user ? withAdminFlag(user) : null });
}

/**
 * POST /api/auth — one endpoint, action-based:
 *  { action: "register", email, password, name?, claimThreadIds?: string[] }
 *  { action: "login", email, password, claimThreadIds?: string[] }
 *  { action: "logout" }
 * claimThreadIds = the anonymous browser's local thread ids — migrated to the
 * account on first sign-in so no early user loses their history (P1-1).
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  const jar = await cookies();

  if (action === "logout") {
    await destroySession(jar.get(SESSION_COOKIE)?.value);
    jar.delete(SESSION_COOKIE);
    return NextResponse.json({ ok: true });
  }

  const ip = clientIp(req);
  if (!rateLimit(`auth:${ip}`, 20, 60_000)) {
    return NextResponse.json({ error: "Too many attempts — try again in a minute." }, { status: 429 });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!EMAIL_RE.test(email) || email.length > 200) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8 || password.length > 200) {
    return NextResponse.json({ error: "Password must be 8–200 characters." }, { status: 400 });
  }

  if (action === "register") {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    const name = String(body.name || "").trim().slice(0, 80) || null;
    const user = await db.user.create({
      data: { email, name, passwordHash: await hashPassword(password) },
    });
    const token = await createSession(user.id);
    const claimed = await claimThreads(user.id, body.claimThreadIds);
    jar.set(SESSION_COOKIE, token, sessionCookieOptions());
    return NextResponse.json({ user: withAdminFlag({ id: user.id, email: user.email, name: user.name }), claimed });
  }

  if (action === "login") {
    const user = await db.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    const token = await createSession(user.id);
    const claimed = await claimThreads(user.id, body.claimThreadIds);
    jar.set(SESSION_COOKIE, token, sessionCookieOptions());
    return NextResponse.json({ user: withAdminFlag({ id: user.id, email: user.email, name: user.name }), claimed });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

/** Adopt anonymous threads into the account — only threads nobody owns yet. */
async function claimThreads(userId: string, raw: unknown): Promise<number> {
  if (!Array.isArray(raw)) return 0;
  const ids = raw.map(String).filter((s) => s.length > 0 && s.length < 80).slice(0, 200);
  if (!ids.length) return 0;
  const res = await db.researchJob.updateMany({
    where: { threadId: { in: ids }, userId: null },
    data: { userId },
  });
  return res.count;
}
