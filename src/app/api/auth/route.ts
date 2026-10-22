import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  createSession,
  destroyAllSessions,
  destroySession,
  getSessionUser,
  hashPassword,
  isCommonPassword,
  rateLimit,
  clearAttempts,
  clientIp,
  countActiveSessions,
  recentAttempts,
  recordAttempt,
  sessionCookieOptions,
  verifyDummyPassword,
  verifyPassword,
} from "@/lib/auth";
import { isAdminEmail } from "@/lib/platform/admin";
import { otpEnabled, sendEmailOtp, verifyEmailOtp } from "@/lib/platform/supabase";

export const maxDuration = 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// v3.7 lockout windows — DB-backed per-EMAIL (the in-memory IP limiter is
// per serverless instance and resets on cold start; these do not).
const LOGIN_FAIL_LOCK = 5; // failed passwords / 15 min → account locked
const LOGIN_FAIL_WINDOW = 15 * 60_000;
const OTP_FAIL_LOCK = 10; // wrong codes / 15 min → code entry locked
const OTP_FAIL_WINDOW = 15 * 60_000;

/** Attach the deployment's admin flag so the UI can badge operator accounts.
 *  Purely informational — every actual gate re-checks server-side. */
function withAdminFlag<T extends { email: string }>(user: T): T & { isAdmin: boolean } {
  return { ...user, isAdmin: isAdminEmail(user.email) };
}

/** GET /api/auth — current session user (null when signed out), plus whether
 *  this deployment can do email-code auth (the UI renders the email-code tab
 *  only when otpEnabled is true — unconfigured deployments never show a
 *  broken feature). v3.7: signed-in callers also learn their account's
 *  security posture (has a password? how many live sessions?). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null, otpEnabled: otpEnabled() });
  }
  const [row, activeSessions] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }),
    countActiveSessions(user.id),
  ]);
  return NextResponse.json({
    user: withAdminFlag(user),
    otpEnabled: otpEnabled(),
    hasPassword: !!row?.passwordHash,
    activeSessions,
  });
}

/**
 * POST /api/auth — one endpoint, action-based:
 *  { action: "register", email, password, name?, claimThreadIds?: string[] }
 *  { action: "login", email, password, claimThreadIds?: string[] }
 *  { action: "otp-send", email }                        — v3.5: email a one-time code (6–8 digits)
 *  { action: "otp-verify", email, code, claimThreadIds? } — verify it, sign in
 *  { action: "change-password", currentPassword?, newPassword } — v3.7 (session)
 *  { action: "signout-all" }                             — v3.7 (session)
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

  // ── v3.7 account security management (session-based; must run BEFORE the
  // email/password validation below — these actions carry neither field) ──
  if (action === "change-password") {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ code: "auth_required", error: "Sign in first." }, { status: 401 });
    }
    const row = await db.user.findUnique({ where: { id: sessionUser.id } });
    if (!row) {
      return NextResponse.json({ error: "Account not found." }, { status: 401 });
    }
    // An existing password must be presented to replace itself. OTP-only
    // accounts (no hash yet) may set one from a fresh session — the session
    // already proves control of the inbox.
    if (row.passwordHash) {
      const current = String(body.currentPassword || "");
      if (!(await verifyPassword(current, row.passwordHash))) {
        return NextResponse.json({ error: "Your current password is wrong." }, { status: 401 });
      }
    }
    const next = String(body.newPassword || "");
    if (next.length < 8 || next.length > 200) {
      return NextResponse.json({ error: "Password must be 8–200 characters." }, { status: 400 });
    }
    if (isCommonPassword(next)) {
      return NextResponse.json(
        { error: "That password is too common or predictable — choose something stronger." },
        { status: 400 }
      );
    }
    await db.user.update({
      where: { id: sessionUser.id },
      data: { passwordHash: await hashPassword(next) },
    });
    // Theft containment: every OTHER session dies the moment the password
    // changes — a stolen cookie stops working even though it was "valid".
    const keep = jar.get(SESSION_COOKIE)?.value;
    const revoked = await db.session
      .deleteMany({ where: { userId: sessionUser.id, ...(keep ? { id: { not: keep } } : {}) } })
      .catch(() => null);
    return NextResponse.json({ ok: true, revoked: revoked?.count ?? 0 });
  }

  if (action === "signout-all") {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ code: "auth_required", error: "Sign in first." }, { status: 401 });
    }
    const signedOut = await destroyAllSessions(sessionUser.id);
    jar.delete(SESSION_COOKIE);
    return NextResponse.json({ ok: true, signedOut });
  }

  // ── v3.5 email-code auth (Supabase OTP) ────────────────────────────────
  if (action === "otp-send") {
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (!otpEnabled()) {
      return NextResponse.json({ error: "Email codes are not configured on this deployment." }, { status: 503 });
    }
    // v3.7: the 60s resend cooldown moved to the DB — on serverless the old
    // in-memory bucket lived per-instance, so a resend landing on a fresh
    // instance skipped it entirely.
    if ((await recentAttempts("otpsend", email, 60_000)) >= 1) {
      return NextResponse.json(
        { error: "A code was just sent — check your inbox, or wait a minute to resend." },
        { status: 429 }
      );
    }
    const sent = await sendEmailOtp(email);
    if (sent.ok) {
      await recordAttempt("otpsend", email); // start the DB-backed cooldown
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
    // Upstream rejected the send (signup toggle, domain allowlist, provider
    // policy, …). Our own validation already passed, so blaming the email
    // address would mislead the user — report it as a temporary outage.
    return NextResponse.json(
      { error: "Email codes are temporarily unavailable — try again shortly." },
      { status: 502 }
    );
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
    // v3.7: durable per-email lockout — 10 wrong codes in 15 min freezes
    // code entry for that address (a 6-digit code has 1M combinations;
    // without this, distributed guessing was unthrottled across IPs).
    if ((await recentAttempts("otp", email, OTP_FAIL_WINDOW)) >= OTP_FAIL_LOCK) {
      return NextResponse.json(
        { error: "Too many incorrect codes for this address — wait a few minutes, then request a fresh code." },
        { status: 429 }
      );
    }
    const verified = await verifyEmailOtp(email, code);
    if (!verified.ok && verified.kind === "invalid_code") {
      await recordAttempt("otp", email);
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
    await clearAttempts("otp", email); // success resets the fail counter
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
    // v3.7: reject breach-list staples and structural patterns before the
    // account exists (length alone let "password123" through for years).
    if (isCommonPassword(password)) {
      return NextResponse.json(
        { error: "That password is too common or predictable — choose something stronger." },
        { status: 400 }
      );
    }
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
    // v3.7: durable per-account lockout — 5 wrong passwords in 15 min
    // freezes the account (the per-IP limiter never saw rotating sources).
    if ((await recentAttempts("login", email, LOGIN_FAIL_WINDOW)) >= LOGIN_FAIL_LOCK) {
      return NextResponse.json(
        { error: "Too many failed sign-ins for this account — try again in a few minutes, or sign in with an email code." },
        { status: 429 }
      );
    }
    const user = await db.user.findUnique({ where: { email } });
    // OTP-only accounts have no password — same response as an unknown user
    // (keeps login non-enumerating; code sign-in always remains available)
    if (!user || !user.passwordHash) {
      // v3.7: burn the same scrypt work a real verify would — the missing
      // account used to answer ~100ms faster, a timing oracle for
      // enumerating registered addresses.
      await verifyDummyPassword(password);
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      await recordAttempt("login", email);
      return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
    }
    await clearAttempts("login", email); // success resets the lockout counter
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
