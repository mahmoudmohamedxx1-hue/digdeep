import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { waitUntil } from "@vercel/functions";
import { db } from "@/lib/db";

/**
 * DEPLOYMENT DIAGNOSTIC — figures out, from inside the real Vercel runtime:
 *   1. which Postgres URL the app resolved (pooled vs direct)
 *   2. whether DB writes succeed AFTER the response (after() vs waitUntil())
 *   3. how long background work actually survives (heartbeat every 15s)
 *   4. whether the keyless LLM endpoints are reachable from Vercel's network
 *
 * Usage: POST /api/diag            → starts a tracked run, returns its id
 *        GET  /api/diag?run=<id>   → read the collected marks
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function mask(u?: string): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname}${x.search}`;
  } catch {
    return "invalid-url";
  }
}

async function w(key: string, value: unknown) {
  await db.setting.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  });
}

async function beat(key: string, started: number, extra?: Record<string, unknown>) {
  const t = Date.now() - started;
  try {
    await w(key, { t, ok: true, ...extra });
  } catch (e) {
    try {
      await w(key, { t, ok: false, err: String(e).slice(0, 200) });
    } catch {
      /* even the error write failed — nothing more we can do */
    }
  }
}

export async function POST(req: NextRequest) {
  const run = `diag-${Date.now()}`;
  const started = Date.now();

  // clean up previous diagnostic runs
  await db.setting.deleteMany({ where: { key: { startsWith: "diag-" } } }).catch(() => {});

  // t=0: write during the handler — plus the resolved URLs
  await w(run, {
    t: 0,
    phase: "handler",
    vercel: process.env.VERCEL ?? null,
    region: process.env.VERCEL_REGION ?? null,
    urls: {
      DATABASE_URL: mask(process.env.DATABASE_URL),
      POSTGRES_PRISMA_URL: mask(process.env.POSTGRES_PRISMA_URL),
      POSTGRES_URL: mask(process.env.POSTGRES_URL),
      POSTGRES_URL_NON_POOLING: mask(process.env.POSTGRES_URL_NON_POOLING),
    },
  });

  // ---- track A: after() ----
  after(
    (async () => {
      await beat(`${run}:after:start`, started);
      for (let i = 1; i <= 18; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        await beat(`${run}:after:b${i * 15}`, started);
      }
    })().catch(async (e) => {
      await beat(`${run}:after:fatal`, started, { err: String(e).slice(0, 300) });
    })
  );

  // ---- track B: waitUntil() ----
  waitUntil(
    (async () => {
      await beat(`${run}:wu:start`, started);
      for (let i = 1; i <= 18; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        await beat(`${run}:wu:b${i * 15}`, started);
      }
    })().catch(async (e) => {
      await beat(`${run}:wu:fatal`, started, { err: String(e).slice(0, 300) });
    })
  );

  // ---- track C: endpoint reachability with the app's REAL model ids ----
  waitUntil(
    (async () => {
      const probes: [string, string, string][] = [
        ["llm7-glm53", "https://api.llm7.io/v1/chat/completions", "GLM-5.3-Flash"],
        ["pollinations-openai", "https://text.pollinations.ai/openai", "openai"],
      ];
      for (const [name, url, model] of probes) {
        const t0 = Date.now();
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
            signal: AbortSignal.timeout(20_000),
          });
          const body = await r.text();
          await beat(`${run}:probe:${name}`, started, { ms: Date.now() - t0, status: r.status, body: body.slice(0, 140) });
        } catch (e) {
          await beat(`${run}:probe:${name}`, started, { ms: Date.now() - t0, err: String(e).slice(0, 160) });
        }
      }
    })()
  );

  // ---- track E: ENGINE-MIMIC — promise started DURING the handler, passed to after()
  //      (exactly the pattern POST /api/research used). If its post-response writes
  //      die while track A/B survive, that's the root cause. ----
  const engineLike = (async () => {
    await beat(`${run}:eng:e0-during-handler`, started);
    await new Promise((r) => setTimeout(r, 2_000));
    await beat(`${run}:eng:e2s`, started);
    try {
      const { llmComplete } = await import("@/lib/research/llm");
      const r = await llmComplete([{ role: "user", content: "Reply with exactly: ok" }], { purpose: "diag-classify", patient: false, timeoutMs: 18_000, maxTokens: 20 });
      await beat(`${run}:eng:llm`, started, { backend: r.backendId, model: r.model, text: (r.text ?? "").slice(0, 60) });
    } catch (e) {
      await beat(`${run}:eng:llm`, started, { err: String(e).slice(0, 220) });
    }
    for (let i = 1; i <= 18; i++) {
      await new Promise((r) => setTimeout(r, 15_000));
      await beat(`${run}:eng:b${i * 15}`, started);
    }
  })();
  after(
    engineLike.catch(async (e) => {
      await beat(`${run}:eng:fatal`, started, { err: String(e).slice(0, 300) });
    })
  );

  return NextResponse.json({ run, note: "background tracks run ~4.5 min; then GET /api/diag?run=<run>" });
}

export async function GET(req: NextRequest) {
  const run = req.nextUrl.searchParams.get("run");
  if (!run) return NextResponse.json({ error: "pass ?run=<id> (from POST)" });
  const rows = await db.setting.findMany({ where: { key: { startsWith: run } } });
  return NextResponse.json({
    now: Date.now(),
    marks: rows
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => ({ k: r.key, ...JSON.parse(r.value) as Record<string, unknown> })),
  });
}
