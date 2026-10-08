import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPoolEndpoints, invalidateEndpointsCache, getBackendHealthSnapshot, type PoolEndpoint } from "@/lib/research/llm";
import { getSearchSettings, invalidateSearchSettingsCache, type SearchSettings } from "@/lib/research/search";

export const dynamic = "force-dynamic";

/** Mask stored API keys for the UI — the key itself never leaves the server
 *  once saved; the client only sees whether one exists. */
function maskEndpoint(e: PoolEndpoint) {
  return { id: e.id, label: e.label, baseUrl: e.baseUrl, model: e.model, enabled: e.enabled, hasKey: !!e.key, role: e.role ?? "general" };
}

export async function GET() {
  const endpoints = (await getPoolEndpoints(true)).map(maskEndpoint);
  const ss = await getSearchSettings(true);
  const searchSettings: SearchSettings & { hasBraveKey: boolean; hasGoogleKey: boolean } = {
    ...ss,
    braveKey: undefined,
    googleCseKey: undefined,
    hasBraveKey: !!ss.braveKey,
    hasGoogleKey: !!ss.googleCseKey,
  };
  return NextResponse.json({ endpoints, health: getBackendHealthSnapshot(), searchSettings, glm: { id: "glm-flash", label: "GLM-4.5-Flash", model: "GLM-4.5-Flash", enabled: true } });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === "test") {
      // quick endpoint probe (OpenAI-compatible) — supports BYOK Authorization headers
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45_000);
      try {
        const key = typeof body.key === "string" && body.key.trim() ? body.key.trim() : undefined;
        const res = await fetch(String(body.baseUrl), {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: String(body.model || "gpt-4o-mini"), messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
        });
        const data = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] };
        return NextResponse.json({ ok: res.ok && !!(data.choices?.[0]?.message?.content ?? "").trim(), status: res.status, reply: (data.choices?.[0]?.message?.content ?? "").slice(0, 40) });
      } finally {
        clearTimeout(timer);
      }
    }
    if (body.action === "save") {
      const list = Array.isArray(body.endpoints) ? body.endpoints : [];
      const existing = await db.setting.findUnique({ where: { key: "pool_endpoints" } });
      const prevByKey: Record<string, PoolEndpoint> = {};
      try {
        for (const e of existing ? (JSON.parse(existing.value) as PoolEndpoint[]) : []) prevByKey[e.baseUrl] = e;
      } catch { /* fresh */ }
      const clean = list
        .filter((e: { baseUrl?: string }) => typeof e?.baseUrl === "string" && /^https?:\/\//.test(e.baseUrl))
        .slice(0, 10)
        .map((e: { baseUrl: string; model?: string; label?: string; enabled?: boolean; key?: string; role?: string }, i: number) => {
          const prev = prevByKey[e.baseUrl.trim()];
          // key semantics: undefined = keep the stored key; "" = remove; string = set
          const key = typeof e.key === "string" ? (e.key.trim() ? e.key.trim() : undefined) : prev?.key;
          return {
            id: `custom-${i}-${Date.now()}`,
            label: String(e.label || `Custom endpoint ${i + 1}`).slice(0, 60),
            baseUrl: e.baseUrl.trim(),
            model: String(e.model || "gpt-4o-mini").slice(0, 80),
            enabled: e.enabled !== false,
            ...(key ? { key } : {}),
            ...(e.role === "synthesis" ? { role: "synthesis" as const } : {}),
          };
        });
      await db.setting.upsert({ where: { key: "pool_endpoints" }, update: { value: JSON.stringify(clean) }, create: { key: "pool_endpoints", value: JSON.stringify(clean) } });
      invalidateEndpointsCache();
      return NextResponse.json({ ok: true, endpoints: clean.map(maskEndpoint) });
    }
    if (body.action === "save-search") {
      const ss = await getSearchSettings(true);
      const s = body.searchSettings ?? {};
      const clean: SearchSettings = {
        ddg: s.ddg !== false,
        searxngInstances: Array.isArray(s.searxngInstances) ? s.searxngInstances.filter((x: unknown) => typeof x === "string" && /^https?:\/\//.test(String(x))).slice(0, 5) : [],
        mojeek: s.mojeek !== false,
        marginalia: s.marginalia !== false,
        braveKey: typeof s.braveKey === "string" ? (s.braveKey.trim() ? s.braveKey.trim() : undefined) : ss.braveKey,
        googleCseKey: typeof s.googleCseKey === "string" ? (s.googleCseKey.trim() ? s.googleCseKey.trim() : undefined) : ss.googleCseKey,
        googleCseCx: typeof s.googleCseCx === "string" ? (s.googleCseCx.trim() ? s.googleCseCx.trim() : undefined) : ss.googleCseCx,
      };
      await db.setting.upsert({ where: { key: "search_settings" }, update: { value: JSON.stringify(clean) }, create: { key: "search_settings", value: JSON.stringify(clean) } });
      invalidateSearchSettingsCache();
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Settings failed" }, { status: 500 });
  }
}
