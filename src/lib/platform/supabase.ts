/**
 * SUPABASE EMAIL OTP (v3.5) — real email-code sign-in via Supabase Auth.
 *
 * Design:
 *   - Supabase Auth is used as a STATELESS email-verification engine: it sends
 *     the one-time code (6–8 digits, per the project's mailer_otp_length) to
 *     the user's inbox and confirms it on verify. DigDeep keeps its own
 *     User/Session tables and issues its own session cookie on verify — every
 *     existing feature (admin allowlist by email, API keys, scopes, quotas,
 *     thread claiming) works unchanged for OTP accounts.
 *   - This repository ships with the operator's project as the DEFAULT target
 *     (v3.5.1): the values below are public-by-design — the Supabase
 *     publishable key is the successor of the legacy anon key and ships in
 *     every browser bundle, only reaching what Row Level Security allows.
 *     Email-code auth therefore works on every deployment of this repo out of
 *     the box, with no dashboard step.
 *   - Fail-closed override semantics: an env var that is SET (even to an empty
 *     string) always wins over the defaults. SUPABASE_URL="" turns the
 *     feature completely off (otpEnabled() false, UI tab hidden, endpoints
 *     answer 503) — an explicitly disabled deployment can never half-work.
 *   - The ANON (publishable) key is used server-side, not the secret key:
 *     these are the same calls a browser would make, so a leaked value grants
 *     nothing beyond what the public auth flow already allows.
 *
 * Wire-up (override/repoint): set SUPABASE_URL (https://<ref>.supabase.co)
 * and SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables and
 * redeploy. For CODES (not a magic link), the project's "Magic Link" email
 * template must contain {{ .Token }} — see scripts/supabase/.
 */

// Operator's production project — public-by-design values (see header).
const DEFAULT_SUPABASE_URL = "https://vvopggnkskzzwolxbjig.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D";

export interface SupabaseAuthConfig {
  url: string; // https://<ref>.supabase.co (no trailing slash)
  anonKey: string;
}

/** Resolve the Supabase Auth config. Null when the effective values are
 *  unset/malformed (fail-closed). Env PRESENT (even empty) beats the repo
 *  defaults — SUPABASE_URL="" is an explicit off switch. http URLs are
 *  accepted for local dev (supabase CLI stack / test mock); production is
 *  always https://<ref>.supabase.co. */
export function supabaseAuthConfig(): SupabaseAuthConfig | null {
  const url = (process.env.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).trim().replace(/\/+$/, "");
  const anonKey = (process.env.SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY).trim();
  if (!/^https?:\/\/[^\s/]+$/i.test(url) || anonKey.length < 20 || /\s/.test(anonKey)) {
    return null;
  }
  return { url, anonKey };
}

/** True when this deployment can send/verify email codes. */
export function otpEnabled(): boolean {
  return supabaseAuthConfig() !== null;
}

// --- result types (callers map these to stable HTTP responses) ---

export type OtpSendResult =
  | { ok: true }
  | { ok: false; kind: "unconfigured" | "rate_limited" | "rejected" | "unreachable" };

export type OtpVerifyResult =
  | { ok: true; authUserId: string; email: string }
  | { ok: false; kind: "unconfigured" | "invalid_code" | "rate_limited" | "unreachable" };

const REQUEST_TIMEOUT_MS = 10_000;

function authHeaders(cfg: SupabaseAuthConfig): Record<string, string> {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    "Content-Type": "application/json",
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; ok: boolean; json: unknown | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
      cache: "no-store",
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty body is fine */
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Supabase to email a 6-digit code. `create_user: true` so brand-new
 * addresses are usable immediately (Supabase creates the auth user on first
 * verify; DigDeep's own User row is created by the /api/auth route).
 */
export async function sendEmailOtp(email: string): Promise<OtpSendResult> {
  const cfg = supabaseAuthConfig();
  if (!cfg) return { ok: false, kind: "unconfigured" };
  try {
    const res = await postJson(`${cfg.url}/auth/v1/otp`, authHeaders(cfg), {
      email,
      create_user: true,
    });
    if (res.ok) return { ok: true };
    if (res.status === 429) return { ok: false, kind: "rate_limited" };
    return { ok: false, kind: "rejected" }; // 4xx other than throttling
  } catch {
    return { ok: false, kind: "unreachable" }; // DNS/network/timeout
  }
}

/**
 * Confirm a 6-digit code. On success returns the Supabase-confirmed email —
 * possession of the code proves control of that inbox, which is exactly the
 * "real auth" guarantee: no account is created or signed in without it.
 */
export async function verifyEmailOtp(email: string, code: string): Promise<OtpVerifyResult> {
  const cfg = supabaseAuthConfig();
  if (!cfg) return { ok: false, kind: "unconfigured" };
  try {
    const res = await postJson(`${cfg.url}/auth/v1/verify`, authHeaders(cfg), {
      email,
      token: code,
      type: "email",
    });
    if (res.ok) {
      const user = (res.json as { user?: { id?: unknown; email?: unknown } } | null)?.user;
      const confirmedEmail =
        typeof user?.email === "string" && user.email ? user.email.toLowerCase() : email;
      const authUserId = typeof user?.id === "string" && user.id ? user.id : "supabase-verified";
      return { ok: true, authUserId, email: confirmedEmail };
    }
    if (res.status === 429) return { ok: false, kind: "rate_limited" };
    // Supabase answers 400 for wrong AND expired codes (error_code otp_expired)
    return { ok: false, kind: "invalid_code" };
  } catch {
    return { ok: false, kind: "unreachable" };
  }
}
