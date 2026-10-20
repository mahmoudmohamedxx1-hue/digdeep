import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "digdeep_session";
const SESSION_DAYS = 30;

/** scrypt password hash — format: scrypt$N$r$p$salt_b64$hash_b64 (no native deps). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const hash = await scrypt(password, salt, expected.length);
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newApiKey(): { key: string; prefix: string } {
  const raw = randomBytes(24).toString("base64url");
  const key = `ddk_${raw}`;
  return { key, prefix: key.slice(0, 11) };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** Read the current session from the cookie. Returns null when signed out. */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await db.session.findUnique({
      where: { id: token },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      await db.session.delete({ where: { id: token } }).catch(() => {});
      return null;
    }
    return { id: session.user.id, email: session.user.email, name: session.user.name };
  } catch {
    return null;
  }
}

export async function createSession(userId: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.session.create({ data: { id, userId, expiresAt } });
  return id;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.session.delete({ where: { id: token } }).catch(() => {});
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  };
}

/** Resolve the API caller: session cookie OR Bearer API key (P2-3). */
export async function getApiCaller(): Promise<SessionUser | null> {
  const user = await getSessionUser();
  if (user) return user;
  return null;
}

export async function userFromApiKey(authHeader: string | null): Promise<SessionUser | null> {
  if (!authHeader?.startsWith("Bearer ddk_")) return null;
  const key = authHeader.slice("Bearer ".length).trim();
  if (key.length < 20) return null;
  const record = await db.apiKey.findFirst({
    where: { keyHash: hashApiKey(key), revoked: false },
    include: { user: true },
  });
  if (!record) return null;
  await db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { id: record.user.id, email: record.user.email, name: record.user.name };
}

// --- tiny in-memory rate limiter (abuse telemetry baseline, P0 hardening) ---
const buckets = new Map<string, { n: number; reset: number }>();

export function rateLimit(bucket: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(bucket);
  if (!b || b.reset < now) {
    buckets.set(bucket, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= max;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "local";
}
