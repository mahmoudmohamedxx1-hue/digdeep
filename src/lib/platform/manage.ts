import { db } from "@/lib/db";
import { WEBHOOK_EVENTS, newWebhookSecret, type WebhookEvent } from "@/lib/platform/webhooks";
import { PRESETS } from "@/lib/platform/start-run";
import { isPublicHttpUrl } from "@/lib/platform/url-guard";
import { encodeStringArray, parseStringArray } from "@/lib/platform/dbjson";

/**
 * v3.4 PLATFORM — owner-scoped CRUD for webhooks + watches. Shared by the
 * key-authed public API (/api/v1/…) and the session-authed account UI
 * (/api/webhooks, /api/watches). Every function takes the OWNER's userId and
 * enforces ownership on every read/write — routes only do auth + JSON.
 */

const MAX_WEBHOOKS = 10;
const MAX_WATCHES = 25;

function validWebhookUrl(url: string): boolean {
  // v3.4.1 AUDIT FIX: the platform fetches this URL on the owner's behalf —
  // private/loopback/metadata targets are refused (SSRF guard, shared with
  // the settings probe via url-guard). One explicit escape hatch: local
  // testing against a loopback receiver (the CI standalone test's HMAC
  // verifier) — gated by an env flag production never sets, loopback ONLY
  // (other private ranges stay blocked even with the flag).
  if (isPublicHttpUrl(url)) return true;
  return (
    process.env.ALLOW_LOCAL_WEBHOOKS === "1" &&
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(url)
  );
}

// ── webhooks ────────────────────────────────────────────────────────────────

export async function listWebhooks(userId: string) {
  const hooks = await db.webhook.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { deliveries: { orderBy: { createdAt: "desc" }, take: 3 } },
  });
  return hooks.map((h) => ({
    id: h.id,
    url: h.url,
    events: parseStringArray(h.events),
    active: h.active,
    secret: h.secret, // owner-only surface (session or key auth) — needed to verify signatures
    createdAt: h.createdAt.toISOString(),
    recentDeliveries: h.deliveries.map((d) => ({
      id: d.id, event: d.event, ok: d.ok, status: d.status, error: d.error, createdAt: d.createdAt.toISOString(),
    })),
  }));
}

export async function createWebhook(
  userId: string,
  url: string,
  events: string[],
): Promise<{ ok: true; webhook: unknown } | { ok: false; error: string; status: number }> {
  if (!validWebhookUrl(url)) return { ok: false, error: "A valid http(s) URL is required.", status: 400 };
  const evts = [...new Set(events.filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e)))];
  if (!evts.length) return { ok: false, error: `Subscribe to at least one event: ${WEBHOOK_EVENTS.join(", ")}.`, status: 400 };
  const count = await db.webhook.count({ where: { userId } });
  if (count >= MAX_WEBHOOKS) return { ok: false, error: `Webhook limit reached (${MAX_WEBHOOKS}).`, status: 409 };
  const hook = await db.webhook.create({ data: { userId, url, events: encodeStringArray(evts), secret: newWebhookSecret() } });
  return { ok: true, webhook: { id: hook.id, url: hook.url, events: parseStringArray(hook.events), secret: hook.secret, active: hook.active } };
}

export async function updateWebhook(
  userId: string,
  id: string,
  patch: { active?: boolean; events?: string[]; url?: string },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const hook = await db.webhook.findUnique({ where: { id } });
  if (!hook || hook.userId !== userId) return { ok: false, error: "Webhook not found.", status: 404 };
  const data: { active?: boolean; events?: string; url?: string; secret?: string } = {};
  if (patch.active != null) data.active = patch.active;
  if (patch.url != null) {
    if (!validWebhookUrl(patch.url)) return { ok: false, error: "A valid http(s) URL is required.", status: 400 };
    data.url = patch.url;
  }
  if (patch.events != null) {
    const evts = [...new Set(patch.events.filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e)))];
    if (!evts.length) return { ok: false, error: "Subscribe to at least one event.", status: 400 };
    data.events = encodeStringArray(evts);
  }
  await db.webhook.update({ where: { id }, data });
  return { ok: true };
}

export async function rotateWebhookSecret(
  userId: string,
  id: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string; status: number }> {
  const hook = await db.webhook.findUnique({ where: { id } });
  if (!hook || hook.userId !== userId) return { ok: false, error: "Webhook not found.", status: 404 };
  const secret = newWebhookSecret();
  await db.webhook.update({ where: { id }, data: { secret } });
  return { ok: true, secret };
}

export async function deleteWebhook(userId: string, id: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const hook = await db.webhook.findUnique({ where: { id } });
  if (!hook || hook.userId !== userId) return { ok: false, error: "Webhook not found.", status: 404 };
  await db.webhook.delete({ where: { id } });
  return { ok: true };
}

// ── watches ─────────────────────────────────────────────────────────────────

export async function listWatches(userId: string) {
  const watches = await db.watch.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return watches.map((w) => ({
    id: w.id,
    query: w.query,
    preset: w.preset,
    domain: w.domain,
    language: w.language,
    court: w.court,
    cadenceDays: w.cadenceDays,
    active: w.active,
    lastRunId: w.lastRunId,
    lastVerdict: w.lastVerdict,
    lastChangedAt: w.lastChangedAt?.toISOString() ?? null,
    nextRunAt: w.nextRunAt.toISOString(),
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function createWatch(
  userId: string,
  input: { query: string; preset?: string; domain?: string; language?: string; court?: boolean; cadenceDays?: number },
): Promise<{ ok: true; watch: unknown } | { ok: false; error: string; status: number }> {
  const query = (input.query ?? "").trim();
  if (!query) return { ok: false, error: "query is required", status: 400 };
  const count = await db.watch.count({ where: { userId } });
  if (count >= MAX_WATCHES) return { ok: false, error: `Watch limit reached (${MAX_WATCHES}).`, status: 409 };
  const preset = input.preset && input.preset in PRESETS ? input.preset : "standard";
  const cadence = Math.min(90, Math.max(1, Math.round(Number(input.cadenceDays) || 7)));
  const watch = await db.watch.create({
    data: {
      userId,
      query: query.slice(0, 600),
      preset,
      court: input.court === true,
      cadenceDays: cadence,
      // the FIRST run happens at the next cron tick (nextRunAt = now), so a
      // new watch baselines within a day even on the Hobby daily cron.
      nextRunAt: new Date(),
    },
  });
  return { ok: true, watch: { id: watch.id, query: watch.query, cadenceDays: watch.cadenceDays, nextRunAt: watch.nextRunAt.toISOString() } };
}

export async function updateWatch(
  userId: string,
  id: string,
  patch: { active?: boolean; cadenceDays?: number },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const watch = await db.watch.findUnique({ where: { id } });
  if (!watch || watch.userId !== userId) return { ok: false, error: "Watch not found.", status: 404 };
  const data: { active?: boolean; cadenceDays?: number } = {};
  if (patch.active != null) data.active = patch.active;
  if (patch.cadenceDays != null) {
    const c = Math.round(Number(patch.cadenceDays));
    if (!Number.isFinite(c) || c < 1 || c > 90) return { ok: false, error: "cadenceDays must be 1–90.", status: 400 };
    data.cadenceDays = c;
  }
  await db.watch.update({ where: { id }, data });
  return { ok: true };
}

export async function deleteWatch(userId: string, id: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const watch = await db.watch.findUnique({ where: { id } });
  if (!watch || watch.userId !== userId) return { ok: false, error: "Watch not found.", status: 404 };
  await db.watch.delete({ where: { id } });
  return { ok: true };
}
