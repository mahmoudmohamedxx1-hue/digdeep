/**
 * v3.9.0 — SQLite/D1 scalar-array emulation.
 *
 * SQLite has no array columns (PG's TEXT[] is gone with the dialect switch).
 * `ApiKey.scopes` and `Webhook.events` are stored as JSON-encoded TEXT and
 * decoded at every read boundary, so the API surface (and the account UI)
 * keeps speaking REAL string arrays — the storage change is invisible to
 * clients and to downstream code holding parsed arrays.
 *
 * Fixed token sets (KEY_SCOPES / WEBHOOK_EVENTS) make the encoding stable and
 * the DB-level `contains` filter in webhooks.ts exact: every token is stored
 * wrapped in double quotes, and no token can appear quoted inside another.
 */

export function encodeStringArray(arr: string[]): string {
  return JSON.stringify(arr);
}

export function parseStringArray(
  raw: string | null | undefined,
  fallback: readonly string[] = [],
): string[] {
  if (raw == null || raw === "") return [...fallback];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
  } catch {
    // fall through to fallback — malformed rows must never crash a request
  }
  return [...fallback];
}
