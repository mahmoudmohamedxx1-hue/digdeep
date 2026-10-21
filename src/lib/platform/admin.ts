import { getSessionUser } from "@/lib/auth";

/**
 * ADMIN ALLOWLIST (v3.4.1 audit, F1) — the operator console
 * (POST /api/settings: LLM pool, endpoint keys, search providers) is gated to
 * signed-in sessions whose email is listed in the ADMIN_EMAILS environment
 * variable (comma-separated, case-insensitive).
 *
 * Design: env-based, not a DB role column —
 *   - fail-closed: unset/empty ADMIN_EMAILS means NOBODY is admin (the same
 *     posture as CRON_SECRET), so an unconfigured deployment can never be
 *     taken over by a default account;
 *   - works before the account even exists: the moment the operator
 *     registers with the listed email, they are admin;
 *   - revocation is an env change + redeploy — nothing to migrate, nothing
 *     to corrupt, and it is auditable in the deploy config.
 *
 * Emails are normalized to lowercase on register/login (src/app/api/auth),
 * and compared case-insensitively here regardless.
 */

/** Parse ADMIN_EMAILS into a lowercase list. Empty array when unset. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the email is on the allowlist. Fail-closed when unset. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = adminEmails();
  if (!list.length) return false; // unset → closed, never open
  return list.includes(email.toLowerCase());
}

/** True when the current session belongs to an admin. False when signed out. */
export async function isAdminSession(): Promise<boolean> {
  const user = await getSessionUser();
  return !!user && isAdminEmail(user.email);
}
