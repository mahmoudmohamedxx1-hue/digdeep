import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";

/**
 * v3.4 PLATFORM — signed webhooks + watched-research completion handling.
 *
 * Design constraints (learned the hard way in this codebase):
 *  - notifyRunFinished MUST NEVER THROW: a webhook outage may not fail a
 *    research run. Every step is guarded; errors go to the console only.
 *  - Deliveries are logged (WebhookDelivery) so owners can debug from /account
 *    without asking us for logs.
 *  - Signatures are HMAC-SHA256 over `${timestamp}.${body}` — the timestamp
 *    header lets receivers reject replays.
 */

export const WEBHOOK_EVENTS = ["run.completed", "run.failed", "watch.changed"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function newWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

export function signWebhook(secret: string, timestampMs: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret: string, timestampMs: number, body: string, signature: string): boolean {
  // v3.4.1: constant-time compare — receivers copy this reference
  // implementation, so it must teach the safe pattern.
  const expected = signWebhook(secret, timestampMs, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

async function postOnce(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "delivery failed" };
  }
}

/** Deliver an event to every active hook of the user subscribed to it. */
export async function deliverWebhookEvent(
  userId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
  jobId?: string,
): Promise<void> {
  const hooks = await db.webhook.findMany({ where: { userId, active: true, events: { has: event } } });
  if (!hooks.length) return;
  const body = JSON.stringify({ ...payload, event, deliveredAt: new Date().toISOString() });
  const ts = Date.now();
  await Promise.all(
    hooks.map(async (hook) => {
      const headers = {
        "X-DigDeep-Event": event,
        "X-DigDeep-Timestamp": String(ts),
        "X-DigDeep-Signature": `sha256=${signWebhook(hook.secret, ts, body)}`,
      };
      let last: { ok: boolean; status?: number; error?: string } = { ok: false, error: "not attempted" };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        last = await postOnce(hook.url, body, headers);
        if (last.ok) break;
      }
      await db.webhookDelivery
        .create({
          data: {
            webhookId: hook.id,
            jobId: jobId ?? null,
            event,
            ok: last.ok,
            status: last.status ?? null,
            attempts: last.ok ? (last.status && last.status < 500 ? 1 : MAX_ATTEMPTS) : MAX_ATTEMPTS,
            error: last.error ?? null,
          },
        })
        .catch(() => {});
    }),
  );
}

// ── Watch verdict fingerprints ──────────────────────────────────────────────

/**
 * Fingerprint what "the answer changed" means: the court verdict (if any),
 * the claim verdict, and the SET of source domains the report rests on.
 * Deliberately excludes word counts / integrity percentages — those jitter
 * run-to-run and would spam watch.changed notifications.
 */
export function verdictSignature(stats: Record<string, unknown> | null | undefined, sourceDomains: string[]): string {
  const s = (stats ?? {}) as Record<string, unknown>;
  const court = (s.court as Record<string, unknown> | undefined)?.verdict ?? null;
  const claimRaw = s.claimVerdict;
  const claim = typeof claimRaw === "string" ? claimRaw : ((claimRaw as Record<string, unknown> | undefined)?.verdict as string | undefined) ?? null;
  const domains = [...new Set(sourceDomains)].sort().slice(0, 12);
  return createHash("sha256").update(JSON.stringify({ court, claim, domains })).digest("hex");
}

/** Human one-liner for watch rows + webhook payloads. */
export function verdictSummary(
  job: { status: string; error?: string | null },
  stats: Record<string, unknown> | null | undefined,
): string {
  const s = (stats ?? {}) as Record<string, unknown>;
  if (job.status === "failed") return `failed: ${(job.error || "unknown error").slice(0, 140)}`;
  const court = (s.court as Record<string, unknown> | undefined);
  if (court?.verdict) {
    const g = court.guilty ?? "?";
    const ng = court.notGuilty ?? "?";
    return `court verdict ${court.verdict} (${g}–${ng})`;
  }
  const integrity = typeof s.citationIntegrity === "number" ? `${Math.round(s.citationIntegrity)}% citation integrity` : "verified";
  return `completed — ${integrity}`;
}

function runPayload(run: {
  id: string; query: string; status: string; completedAt: Date | null; reportMd: string | null;
}, stats: Record<string, unknown> | null | undefined, sourceCount: number) {
  const s = (stats ?? {}) as Record<string, unknown>;
  const court = s.court as Record<string, unknown> | undefined;
  return {
    run: {
      id: run.id,
      query: run.query,
      status: run.status,
      completedAt: run.completedAt?.toISOString() ?? null,
      verdict: verdictSummary(run, stats),
      verification: {
        citationIntegrity: (typeof s.citationIntegrity === "number" ? s.citationIntegrity : null),
        courtVerdict: court?.verdict ?? null,
      },
      sources: sourceCount,
      reportExcerpt: (run.reportMd ?? "").slice(0, 400) || null,
    },
  };
}

/**
 * THE completion hook — called by the engine at every terminal transition
 * (completed / failed) and by CI's inject-trial. Fires the owner's webhooks,
 * then advances any watch this run belongs to (compare fingerprints, notify on
 * change, schedule the next refresh). Never throws.
 */
export async function notifyRunFinished(jobId: string): Promise<void> {
  try {
    const job = await db.researchJob.findUnique({ where: { id: jobId }, include: { sources: { select: { domain: true } } } });
    if (!job) return;
    const event: WebhookEvent | null =
      job.status === "completed" ? "run.completed" : job.status === "failed" ? "run.failed" : null;
    if (!event) return;
    let stats: Record<string, unknown> = {};
    try { stats = job.stats ? JSON.parse(job.stats) : {}; } catch { stats = {}; }
    const payload = runPayload(job, stats, job.sources.length);

    // 1) the owner's webhooks (API users; anonymous runs have no owner)
    if (job.userId) {
      await deliverWebhookEvent(job.userId, event, payload, job.id).catch(() => {});
    }

    // 2) watch advancement
    if (job.watchId) {
      const watch = await db.watch.findUnique({ where: { id: job.watchId } });
      if (watch) {
        const sig = verdictSignature(stats, job.sources.map((s) => s.domain));
        const changed = !!watch.lastSignature && watch.lastSignature !== sig;
        const previousVerdict = watch.lastVerdict;
        await db.watch
          .update({
            where: { id: watch.id },
            data: {
              lastRunId: job.id,
              lastVerdict: verdictSummary(job, stats),
              lastSignature: sig,
              lastChangedAt: changed ? new Date() : watch.lastChangedAt,
              nextRunAt: new Date(Date.now() + Math.max(1, watch.cadenceDays) * 86_400_000),
            },
          })
          .catch(() => {});
        if (changed && watch.userId) {
          await deliverWebhookEvent(
            watch.userId,
            "watch.changed",
            {
              watch: { id: watch.id, query: watch.query, cadenceDays: watch.cadenceDays },
              previous: { verdict: previousVerdict },
              current: payload.run,
            },
            job.id,
          ).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("[notifyRunFinished]", jobId, e instanceof Error ? e.message : e);
  }
}
