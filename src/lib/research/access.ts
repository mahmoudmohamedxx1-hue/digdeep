import { db } from "@/lib/db";
import { getSessionUser, userFromApiKey, hasScope } from "@/lib/auth";

/**
 * v3.4.1 AUDIT FIX — the keyless access model for job-keyed routes.
 *
 * Before accounts existed (v1–v2), every run was anonymous and job ids were
 * capability URLs: unguessable cuids, open to anyone holding them. Accounts
 * (v3.3) added OWNERSHIP — the public API v1 enforces it strictly (404 for
 * other owners' runs) — but the older internal routes never learned it, so
 * anyone with a job id could read / cancel / re-run / export / PUBLISH any
 * owned run. This helper closes that gap with one rule used everywhere:
 *
 *   allowed ⇔ the run is anonymous (no owner — the keyless UX)
 *          ∨ the owner has shared it (SharedReport = public by choice)
 *          ∨ the caller is the owner (session cookie, UI)
 *          ∨ the caller is the owner (Bearer key with research:read, API)
 *
 * Anonymous runs stay exactly as open as they always were — the keyless
 * product does not change. Owned runs get the same isolation the public API
 * already promises. Callers see 404 (not 403) so run existence stays secret,
 * matching v1's behavior.
 */
export async function canAccessJob(
  req: Request,
  job: { id: string; userId: string | null },
): Promise<boolean> {
  // 1) keyless core: anonymous runs are capability URLs
  if (!job.userId) return true;

  // 2) the owner explicitly published this run — anyone may read it
  const shared = await db.sharedReport
    .findFirst({ where: { jobId: job.id }, select: { id: true } })
    .catch(() => null);
  if (shared) return true;

  // 3) the owner's browser session (the UI polls these routes with cookies)
  const session = await getSessionUser();
  if (session && session.id === job.userId) return true;

  // 4) the owner's API key (research:read — same contract as v1 GET)
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (caller && caller.id === job.userId && hasScope(caller, "research:read")) return true;

  return false;
}
