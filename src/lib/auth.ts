import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

// v3.7: scrypt parameters are carried IN the stored string and honored on
// verify (previously verify silently relied on Node's defaults matching the
// format string — a latent bomb: any param bump would have broken every
// existing login). New hashes cost 2× memory (OWASP direction); old ones
// keep verifying forever.
// v3.8: N is environment-tunable (AUTH_SCRYPT_N). Default 32768 everywhere;
// the Cloudflare Workers free plan runs at 16384 — its per-invocation CPU
// budget empirically kills scrypt at N=32768 (verified live: 16384 passes,
// 32768 hard-fails). Stored hashes carry their own N, so accounts hashed on
// one platform verify on any platform.
const SCRYPT_N = (() => {
  const raw = Number.parseInt(process.env.AUTH_SCRYPT_N ?? "", 10);
  // powers of two within [16384, 1048576] only — anything else is a config
  // mistake and falls back to the safe default rather than weakening auth
  if (Number.isFinite(raw) && raw >= 16384 && raw <= 1048576 && (raw & (raw - 1)) === 0) {
    return raw;
  }
  return 32768;
})();
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // ≥ 128·N·r for every N we ever issue
const scrypt = promisify(_scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export const SESSION_COOKIE = "digdeep_session";
const SESSION_DAYS = 30;

/** scrypt password hash — format: scrypt$N$r$p$salt_b64$hash_b64 (no native deps). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    // v3.7: honor the params the hash was written with (legacy 16384 hashes
    // from pre-v3.7 accounts verify exactly like new 32768 ones)
    const N = Number.parseInt(parts[1] ?? "", 10);
    const r = Number.parseInt(parts[2] ?? "", 10);
    const p = Number.parseInt(parts[3] ?? "", 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N < 2 || r < 1 || p < 1) {
      return false;
    }
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!salt.length || !expected.length) return false;
    const hash = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

// Fixed scrypt hashes of UNGUESSABLE random values. Verifying against one
// when the email has no account keeps login latency uniform (known-address
// runs scrypt, unknown-address does too) — kills the timing oracle that
// let anyone enumerate registered emails by response time. One dummy per
// cost level: the dummy's N must match the profile's SCRYPT_N, or the
// equalization itself becomes the oracle.
const DUMMY_VERIFY_HASHES: Record<number, string> = {
  16384: "scrypt$16384$8$1$gtj6yGPvgq1JC5QiSxFP5Q==$DXjVidmwwVn7YlA+m0AHvy/joD7J4YWlmrydxCqww8P7Qicrct4A3cxCZ6ACDkm4ILScf4lqAy+CD9VYaOXZMA==",
  32768: "scrypt$32768$8$1$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==",
};

/** Timing-equalizing verify for the "account doesn't exist" login path. */
export async function verifyDummyPassword(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_VERIFY_HASHES[SCRYPT_N] ?? DUMMY_VERIFY_HASHES[32768]);
}

// v3.7 — common-password screen. Exact-match list (normalized lowercase) of
// the passwords that dominate breach corpora, plus structural patterns that
// make a secret trivially guessable regardless of the list (all digits,
// single repeated character, keyboard/alpha runs in either direction).
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345678910",
  "qwerty", "qwerty123", "qwertyuiop", "qwertyui", "1q2w3e4r", "1qaz2wsx", "qazwsx",
  "abc123", "abcd1234", "abcdefgh", "abcdefghijklmnopqrstuvwxyz", "aaaaaa",
  "letmein", "letmein123", "welcome", "welcome1", "welcome123", "admin", "admin123",
  "admin1234", "administrator", "root", "root123", "toor", "superuser", "login",
  "iloveyou", "sunshine", "princess", "dragon", "monkey", "master", "master123",
  "football", "baseball", "basketball", "soccer", "hockey", "jordan23", "liverpool",
  "chelsea", "arsenal", "barcelona", "realmadrid", "manchester", "yankees", "cowboys",
  "ninja", "shadow", "michael", "jennifer", "jessica", "charlie", "freedom",
  "whatever", "secret", "secrets", "passcode", "passwort", "motdepasse", "contrasena",
  "hello123", "hi123456", "test123", "test1234", "guest", "user", "guest123",
  "changeme", "change_me", "temporary", "default", "google", "facebook", "youtube",
  "starwars", "pokemon", "minecraft", "computer", "internet", "samsung", "android",
  "apple123", "iphone", "nokia", "blackberry", "summer1", "winter1", "spring1",
  "holiday", "vacation", "birthday", "christmas", "halloween", "valentine",
  "trustno1", "zaq12wsx", "1q2w3e", "qwe123", "asd123", "zxc123", "123qwe", "123abc",
  "matrix", "neo123", "trinity", "access", "mustang", "corvette", "ferrari",
  "harley", "banana", "chocolate", "cookie", "flower", "prettywoman",
  "rockyou", "myspace1", "linkedin", "twitter", "instagram", "tiktok", "snapchat",
]);
const KEYBOARD_RUNS = [
  "qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz",
];

/** True when the password is trivially guessable (breach-list staple or a
 *  structural pattern: digits-only, single-char repeat, keyboard/alpha run). */
export function isCommonPassword(password: string): boolean {
  const n = password.toLowerCase();
  if (COMMON_PASSWORDS.has(n)) return true;
  if (/^\d+$/.test(n)) return true; // any digits-only password is guessable
  if (/^(.)\1+$/.test(n)) return true; // aaaaaaaa / 11111111 / …
  for (const run of KEYBOARD_RUNS) {
    if (n.length >= 6 && run.includes(n)) return true; // forward run (qwerty…)
    if (n.length >= 6 && run.split("").reverse().join("").includes(n)) return true; // reversed
  }
  return false;
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

// v3.4: API callers carry their key's authorization + quota metadata.
export type ApiCaller = SessionUser & { key: { id: string; scopes: string[]; monthlyLimit: number | null } };

export const KEY_SCOPES = ["research:read", "research:write", "webhooks", "watches"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

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
  // v3.7: expired sessions were only deleted lazily (when their exact token
  // was re-presented) — everything else piled up forever. Opportunistic
  // sweep: 2% of sign-ins clear the backlog (cheap deleteMany on the index).
  if (Math.random() < 0.02) {
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  }
  return id;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await db.session.delete({ where: { id: token } }).catch(() => {});
}

/** v3.7: destroy EVERY session of a user ("sign out everywhere"). */
export async function destroyAllSessions(userId: string): Promise<number> {
  const res = await db.session.deleteMany({ where: { userId } }).catch(() => null);
  return res?.count ?? 0;
}

/** v3.7: how many live sessions the account has (account page shows this). */
export async function countActiveSessions(userId: string): Promise<number> {
  return db.session
    .count({ where: { userId, expiresAt: { gt: new Date() } } })
    .catch(() => 0);
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

/** Resolve the API caller: session cookie OR Bearer API key (P2-3).
 *  v3.4.1: previously session-only despite the docstring — now the Bearer
 *  path actually resolves (keys without research:read still identify the
 *  caller; scope enforcement stays at each route). */
export async function getApiCaller(authHeader: string | null): Promise<SessionUser | null> {
  const user = await getSessionUser();
  if (user) return user;
  return userFromApiKey(authHeader);
}

export async function userFromApiKey(authHeader: string | null): Promise<ApiCaller | null> {
  if (!authHeader?.startsWith("Bearer ddk_")) return null;
  const key = authHeader.slice("Bearer ".length).trim();
  if (key.length < 20) return null;
  const record = await db.apiKey.findFirst({
    where: { keyHash: hashApiKey(key), revoked: false },
    include: { user: true },
  });
  if (!record) return null;
  await db.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return {
    id: record.user.id,
    email: record.user.email,
    name: record.user.name,
    key: { id: record.id, scopes: record.scopes?.length ? record.scopes : [...KEY_SCOPES], monthlyLimit: record.monthlyLimit ?? null },
  };
}

export function hasScope(caller: ApiCaller, scope: KeyScope): boolean {
  return caller.key.scopes.includes(scope);
}

// --- durable per-account attempt tracking (v3.7) ---
// The in-memory limiter below is per serverless instance AND per-IP — cold
// starts reset it and rotating IPs sidestep it, so it can never be the thing
// that stops a brute-force. These DB-backed counters do: per-EMAIL lockouts
// that survive instance recycling (AuthAttempt table, 24h retention).
export type AttemptKind = "login" | "otp" | "otpsend";

export async function recentAttempts(kind: AttemptKind, email: string, windowMs: number): Promise<number> {
  return db.authAttempt
    .count({ where: { kind, email, createdAt: { gt: new Date(Date.now() - windowMs) } } })
    .catch(() => 0);
}

export async function recordAttempt(kind: AttemptKind, email: string): Promise<void> {
  await db.authAttempt.create({ data: { kind, email } }).catch(() => {});
  if (Math.random() < 0.05) {
    await db.authAttempt
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } } })
      .catch(() => {});
  }
}

export async function clearAttempts(kind: AttemptKind, email: string): Promise<void> {
  await db.authAttempt.deleteMany({ where: { kind, email } }).catch(() => {});
}

// --- tiny in-memory rate limiter (per-instance abuse telemetry net; the
// durable per-account lockouts above are the real brute-force defense) ---
const buckets = new Map<string, { n: number; reset: number }>();
const BUCKETS_MAX = 5000;

export function rateLimit(bucket: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  // v3.7: the map used to grow forever (every unique bucket key stayed);
  // prune expired entries whenever it crosses the ceiling.
  if (buckets.size > BUCKETS_MAX) {
    for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
    if (buckets.size > BUCKETS_MAX) buckets.clear(); // pathological load — reset
  }
  const b = buckets.get(bucket);
  if (!b || b.reset < now) {
    buckets.set(bucket, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n += 1;
  return b.n <= max;
}

export function clientIp(req: Request): string {
  // v3.7 SECURITY FIX: the proxy chain APPENDS the true client IP to
  // x-forwarded-for — client-supplied entries come FIRST. Reading the first
  // entry let anyone mint a fresh rate-limit bucket per request with a
  // spoofed header, silently disabling every IP-scoped limit. Read the LAST
  // entry (the platform-observed address) instead.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const last = fwd
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}
