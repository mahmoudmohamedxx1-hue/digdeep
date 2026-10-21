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
import { otpEnabled, sendEmailOtp, verifyEmailOtp } from "@/lib/platform/supabase";

export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Attach the deployment's admin flag so the UI can badge operator accounts.
 *  Purely informational — every actual gate re-checks server-side. */
function withAdminFlag<T extends { email: string }>(user: T): T & { isAdmin: boolean } {
  return { ...user, isAdmin: isAdminEmail(user.email) };
}

/** GET /api/auth — current session user (null when signed out), plus whether
 *  this deployment can do email-code auth (the UI renders the email-code tab
 *  only when otpEnabled is true — unconfigured deployments never show a
 *  broken feature). */
export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({ user: user ? withAdminFlag(user) : null, otpEnabled: otpEnabled() });
}

/**
 * POST /api/auth — one endpoint, action-based:
 *  { action: "register", email, password, name?, claimThreadIds?: string[] }
 *  { action: "login", email, password, claimThreadIds?: string[] }
 *  { action: "otp-send", email }                        — v3.5: email a one-time code (6–8 digits)
 *  { action: "otp-verify", email, code, claimThreadIds? } — verify it, sign in
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

  // ── v3.5 email-code auth (Supabase OTP) ────────────────────────────────
  if (action === "otp-send") {
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!otpEnabled()) {
      return NextResponse.json({ error: "Email codes are not configured on this deployment." }, { status: 503 });
    }
    if (!rateLimit(`otp-cd:${email}`, 1, 60_000)) {
      return NextResponse.json(
        { error: "A code was just sent — check your inbox, or wait a minute to resend." },
        { status: 429 }
      );
    }
    const sent = await sendEmailOtp(email);
    if (sent.ok) {
      // uniform response — never reveals whether the address has an account
      return NextResponse.json({
        ok: true,
        message: "If that address can receive mail, a one-time code is on its way.",
      });
    }
    if (sent.kind === "rate_limited") {
      return NextResponse.json({ error: "Too many codes requested — wait a minute and try again." }, { status: 429 });
    }
    if (sent.kind === "unreachable") {
      return NextResponse.json({ error: "Email provider unreachable — try again shortly." }, { status: 502 });
    }
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  if (action === "otp-verify") {
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    const code = String(body.code || "").trim();
    // 6–8 digits: the code length is a per-project Supabase setting
    // (mailer_otp_length — this project issues 8); stay config-agnostic.
    if (!/^\d{6,8}$/.test(code)) {
      return NextResponse.json({ error: "Enter the code from your email (6–8 digits)." }, { status: 400 });
    }
    if (!otpEnabled()) {
      return NextResponse.json({ error: "Email codes are not configured on this deployment." }, { status: 503 });
    }
    if (!rateLimit(`otp-verify:${ip}`, 10, 60_000)) {
      return NextResponse.json({ error: "Too many attempts — try again in a minute." }, { status: 429 });
    }
    const verified = await verifyEmailOtp(email, code);
    if (!verified.ok && verified.kind === "invalid_code") {
      return NextResponse.json(
        { error: "That code is invalid or has expired — request a new one." },
        { status: 401 }
      );
    }
    if (!verified.ok && verified.kind === "rate_limited") {
      return NextResponse.json({ error: "Too many attempts — try again in a minute." }, { status: 429 });
    }
    if (!verified.ok && verified.kind === "unreachable") {
      return NextResponse.json({ error: "Email provider unreachable — try again shortly." }, { status: 502 });
    }
    if (!verified.ok) {
      return NextResponse.json({ error: "Email codes are not configured on this deployment." }, { status: 503 });
    }
    // Supabase confirmed the code → the requester controls this inbox. Find
    // the account (password accounts keep working; brand-new addresses get
    // an OTP-only row with no password — they sign in with codes).
    let user = await db.user.findUnique({ where: { email } });
    if (!user) {
      const localPart = email.split("@")[0]?.slice(0, 80) || null;
      user = await db.user
        .create({ data: { email, name: localPart, passwordHash: null } })
        .catch(async () => {
          // two concurrent verifies for a brand-new email — the unique
          // constraint already picked a winner; adopt that row
          return await db.user.findUniqueOrThrow({ where: { email } });
        });
    }
    const token = await createSession(user.id);
    const claimed = await claimThreads(user.id, body.claimThreadIds);
    jar.set(SESSION_COOKIE, token, sessionCookieOptions());
    return NextResponse.json({ user: withAdminFlag({ id: user.id, email: user.email, name: user.name }), claimed });
  }

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
    // OTP-only accounts have no password — same response as an unknown user
    // (keeps login non-enumerating; code sign-in always remains available)
    if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
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
