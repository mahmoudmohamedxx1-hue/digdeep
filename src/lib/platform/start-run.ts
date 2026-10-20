import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob } from "@/lib/research/engine";
import { isValidModelPref } from "@/lib/model-choices";
import { isValidDomain } from "@/lib/research/domain-packs";
import type { ApiCaller } from "@/lib/auth";

/**
 * v3.4 PLATFORM — the single code path that starts a research run for an API
 * caller (public API v1 POST /api/v1/research AND the MCP server's
 * digdeep_research tool). Centralizes:
 *   - scope enforcement (research:write)
 *   - monthly per-key quota (ApiKey.monthlyLimit, calendar month UTC)
 *   - key attribution (ResearchJob.apiKeyId — usage dashboards + audits)
 *   - preset/param validation + clamping
 */

export const PRESETS: Record<string, { breadth: number; depth: number; maxSources: number; maxMinutes: number }> = {
  quick: { breadth: 2, depth: 1, maxSources: 8, maxMinutes: 10 },
  standard: { breadth: 3, depth: 2, maxSources: 18, maxMinutes: 30 },
  deep: { breadth: 4, depth: 3, maxSources: 45, maxMinutes: 180 },
  exhaustive: { breadth: 5, depth: 3, maxSources: 120, maxMinutes: 720 },
};

export const LANGUAGES = ["English", "Arabic", "Chinese", "Spanish", "French", "German", "Auto-match topic"] as const;

export type StartRunResult =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 403 | 429 | 500; error: string; retryAt?: string };

/** Runs started this calendar month (UTC) through the given key. */
export async function monthlyKeyUsage(keyId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return db.researchJob.count({ where: { apiKeyId: keyId, createdAt: { gte: monthStart } } });
}

export async function startResearchRun(
  caller: ApiCaller,
  body: Record<string, unknown>,
): Promise<StartRunResult> {
  // scope: starting a run is a WRITE
  if (!caller.key.scopes.includes("research:write")) {
    return { ok: false, status: 403, error: "This API key lacks the 'research:write' scope. Create a key with write access at /account." };
  }

  // monthly quota (null = unlimited)
  if (caller.key.monthlyLimit != null) {
    const used = await monthlyKeyUsage(caller.key.id);
    if (used >= caller.key.monthlyLimit) {
      const now = new Date();
      const retry = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return {
        ok: false,
        status: 429,
        error: `Monthly quota reached for this key (${used}/${caller.key.monthlyLimit} runs). Quota resets or can be raised at /account.`,
        retryAt: retry.toISOString(),
      };
    }
  }

  const query = String(body.query ?? "").trim();
  if (!query) return { ok: false, status: 400, error: "query is required" };
  const presetKey = typeof body.preset === "string" && body.preset in PRESETS ? body.preset : "standard";
  const p = PRESETS[presetKey];
  const clamp = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  try {
    const job = await db.researchJob.create({
      data: {
        query: query.slice(0, 600),
        preset: presetKey,
        court: body.court === true,
        language: (LANGUAGES as readonly string[]).includes(body.language as string) ? (body.language as string) : "English",
        modelPref: isValidModelPref(body.modelPref) ? (body.modelPref as string) : "auto",
        domain: isValidDomain(body.domain) ? (body.domain as string) : "general",
        userId: caller.id,
        apiKeyId: caller.key.id,
        breadth: body.breadth != null ? clamp(body.breadth, 1, 50, p.breadth) : p.breadth,
        depth: body.depth != null ? clamp(body.depth, 1, 20, p.depth) : p.depth,
        maxSources: body.maxSources != null ? clamp(body.maxSources, 4, 1000, p.maxSources) : p.maxSources,
        maxMinutes: body.maxMinutes != null ? clamp(body.maxMinutes, 5, 2880, p.maxMinutes) : p.maxMinutes,
        status: "queued",
        stage: "Queued",
      },
    });
    after(runJob(job.id).catch((e) => console.error("[api-start]", job.id, e)));
    return { ok: true, id: job.id };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Failed to start research" };
  }
}
