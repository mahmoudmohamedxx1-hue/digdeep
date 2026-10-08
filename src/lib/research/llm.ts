import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";

export type ModelPref = "auto" | "glm" | "pool";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A live token fragment as it is generated — reasoning = the model's visible thinking,
 *  content = the answer text itself. Emitted the instant each chunk arrives.
 *  attempt:"start" marks a (re)start of a backend attempt so consumers can reset
 *  partial state from a failed attempt. */
export interface StreamDelta {
  reasoning?: string;
  content?: string;
  attempt?: "start";
}

export interface LlmResult {
  text: string;
  reasoning?: string;
  backendId: string;
  model: string;
  latencyMs: number;
}

export interface PoolEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** optional API key (BYOK frontier backends) — sent as Authorization: Bearer <key> */
  key?: string;
  /** "synthesis" = prefer this backend for report-writing steps (frontier synthesis),
   *  with the free keyless chain as failover. Default "general" = normal chain position. */
  role?: "general" | "synthesis";
}

interface BackendHealth {
  calls: number;
  ok: number;
  failures: number;
  cooldownUntil: number;
  lastError?: string;
  lastLatencyMs: number;
}

/** Built-in keyless backends. GLM Flash via the z.ai SDK is primary (newest model first); keyless pool as failover. */
const BUILTIN_POOL: PoolEndpoint[] = [
  { id: "llm7", label: "LLM7 · keyless", baseUrl: "https://api.llm7.io/v1/chat/completions", model: "GLM-5.3-Flash", enabled: true },
  { id: "pollinations", label: "Pollinations · keyless", baseUrl: "https://text.pollinations.ai/openai", model: "openai", enabled: true },
];

/** GLM models served through the z.ai SDK, tried in order (newest first; default last). */
const GLM_SDK_MODELS: { id: string; label: string; model?: string }[] = [
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", model: "glm-5.3-flash" },
  { id: "glm-4.5-flash", label: "GLM-4.5-Flash", model: undefined }, // SDK default
];

const health = new Map<string, BackendHealth>();
const COOLDOWN_MS = 90 * 1000; // GLM/LLM7 429 windows are typically ~60s — 90s aligns with real throttle periods
let cachedZai: Awaited<ReturnType<typeof ZAI.create>> | null = null;

function getHealth(id: string): BackendHealth {
  if (!health.has(id)) health.set(id, { calls: 0, ok: 0, failures: 0, cooldownUntil: 0, lastLatencyMs: 0 });
  return health.get(id)!;
}

let endpointsCache: { at: number; data: PoolEndpoint[] } | null = null;

export async function getPoolEndpoints(force = false): Promise<PoolEndpoint[]> {
  if (!force && endpointsCache && Date.now() - endpointsCache.at < 30_000) return endpointsCache.data;
  let stored: PoolEndpoint[] = [];
  try {
    const row = await db.setting.findUnique({ where: { key: "pool_endpoints" } });
    if (row) stored = JSON.parse(row.value);
  } catch {
    stored = [];
  }
  // custom endpoints only — builtins are always prepended and never duplicated
  const builtinUrls = new Set(BUILTIN_POOL.map((e) => e.baseUrl));
  const custom = (Array.isArray(stored) ? stored : []).filter((e) => e?.baseUrl && !builtinUrls.has(e.baseUrl));
  const data = [...BUILTIN_POOL, ...custom];
  endpointsCache = { at: Date.now(), data };
  return data;
}

export function invalidateEndpointsCache() {
  endpointsCache = null;
}

async function glmBackends(): Promise<PoolEndpoint[]> {
  return GLM_SDK_MODELS.map(
    (m) => ({ id: m.id, label: `${m.label} · z.ai SDK`, baseUrl: "z-ai-sdk", model: m.label, enabled: true }) as PoolEndpoint
  );
}

async function orderedBackends(pref: ModelPref, purpose?: string): Promise<PoolEndpoint[]> {
  const pool = (await getPoolEndpoints()).filter((e) => e.enabled);
  const glms = await glmBackends();
  if (pref === "glm") return glms;
  if (pref === "pool") return pool;
  // Frontier synthesis (P2-4): an endpoint flagged role:"synthesis" (a user's own
  // paid key) is tried FIRST for report-writing steps — the free keyless chain stays
  // right behind it as failover, and every other step still runs keyless.
  const SYNTHESIS_PURPOSES = new Set(["draft", "exec-summary", "conclusion", "disagreements", "title", "score", "diff"]);
  if (purpose && SYNTHESIS_PURPOSES.has(purpose)) {
    const frontier = pool.filter((e) => e.role === "synthesis");
    if (frontier.length > 0) return [...frontier, ...glms, ...pool.filter((e) => e.role !== "synthesis")];
  }
  return [...glms, ...pool];
}

async function callGlm(
  model: string | undefined,
  messages: ChatMsg[],
  wantThinking: boolean,
  maxTokens?: number,
  timeoutMs = 150_000
): Promise<{ text: string; reasoning?: string }> {
  if (!cachedZai) cachedZai = await ZAI.create();
  const completion = (await Promise.race([
    cachedZai.chat.completions.create({
      messages: messages as never,
      thinking: { type: wantThinking ? "enabled" : "disabled" },
      ...(model ? { model } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`GLM timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)),
  ])) as { choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[] };
  const msg = completion.choices?.[0]?.message;
  const text = msg?.content ?? "";
  if (!text.trim()) throw new Error("GLM returned empty response");
  return { text, reasoning: msg?.reasoning_content || msg?.reasoning || undefined };
}

/** Some keyless OpenAI-compatible endpoints (Pollinations) return HTTP 500 on system-role
 *  messages. Fold any system content into the first user message — always valid everywhere. */
function foldSystemIntoUser(messages: ChatMsg[]): ChatMsg[] {
  if (!messages.some((m) => m.role === "system")) return messages;
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  if (rest.length === 0) return [{ role: "user", content: sys }];
  return [{ role: "user", content: `${sys}\n\n---\n\n${rest[0].content}` }, ...rest.slice(1)];
}

async function callOpenAiCompatible(
  ep: PoolEndpoint,
  messages: ChatMsg[],
  maxTokens?: number,
  timeoutMs = 90_000
): Promise<{ text: string; reasoning?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ep.baseUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify({
        model: ep.model,
        messages: foldSystemIntoUser(messages),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${ep.label} HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${ep.label} empty response`);
    return { text, reasoning: data.choices?.[0]?.message?.reasoning_content || undefined };
  } finally {
    clearTimeout(timer);
  }
}

export interface LlmOptions {
  purpose: string;
  pref?: ModelPref;
  wantThinking?: boolean;
  maxTokens?: number;
  /** per-call timeout in ms (default: GLM 150s / pool 90s) */
  timeoutMs?: number;
  patient?: boolean;
  /** Bound the TOTAL patient ride (all rounds + waits) — budgeted runs pass this so no
   *  single step can eat the whole research budget while waiting out throttling. */
  maxWaitMs?: number;
  /** STREAMING: invoked the instant each reasoning/content fragment is generated. */
  onDelta?: (d: StreamDelta) => void;
}

/**
 * Keyless LLM completion with automatic backend failover.
 * Tries backends in order (GLM Flash first in auto mode), skipping those in cooldown.
 * Patient mode (default): if every backend is cooling down or failing — normal for free
 * keyless tiers — waits for cooldowns to expire and retries instead of giving up.
 */
export async function llmComplete(messages: ChatMsg[], opts: LlmOptions): Promise<LlmResult> {
  // fast mode: single pass, one attempt per backend, short per-call timeout — for intent routing etc.
  const fast = opts.timeoutMs != null && opts.patient === false;
  // Patient mode: up to 40 rounds (with 20-120s waits ≈ 15-80 min of patience) so a fully
  // throttled free-tier window never kills an hours-long research run the user asked for.
  const maxRounds = fast ? 1 : opts.patient === false ? 1 : 40;
  const rideStart = Date.now();
  let lastError = "";
  for (let round = 0; round < maxRounds; round++) {
    const backends = await orderedBackends(opts.pref ?? "auto", opts.purpose);
    const errors: string[] = [];
    for (const be of backends) {
      const h = getHealth(be.id);
      if (h.cooldownUntil > Date.now()) {
        errors.push(`${be.label}: in cooldown`);
        continue;
      }
      // A backend that has served its cooldown deserves a fresh slate — otherwise one bad
      // stretch permanently poisons it (every later single failure would re-trigger cooldown).
      if (h.cooldownUntil > 0) {
        h.cooldownUntil = 0;
        h.failures = 0;
      }
      // one retry per backend (skipped in fast mode)
      const attempts = fast ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const started = Date.now();
        h.calls++;
        try {
          const isGlm = be.baseUrl === "z-ai-sdk";
          const out = isGlm
            ? await callGlm(
                GLM_SDK_MODELS.find((m) => m.id === be.id)?.model,
                messages,
                opts.wantThinking ?? false,
                opts.maxTokens,
                opts.timeoutMs ?? 150_000
              )
            : await callOpenAiCompatible(be, messages, opts.maxTokens, opts.timeoutMs ?? 90_000);
          h.ok++;
          h.failures = 0;
          h.lastLatencyMs = Date.now() - started;
          return {
            text: out.text,
            reasoning: out.reasoning,
            backendId: be.id,
            model: be.model || be.label,
            latencyMs: h.lastLatencyMs,
          };
        } catch (err) {
          h.failures++;
          h.lastError = err instanceof Error ? err.message : String(err);
          if (h.failures >= 4) {
            h.cooldownUntil = Date.now() + COOLDOWN_MS;
            errors.push(`${be.label}: ${h.lastError} (cooling down)`);
          } else {
            errors.push(`${be.label}: ${h.lastError}`);
          }
          if (attempt === 0 && attempts > 1) await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    lastError = errors.join(" | ");
    if (round < maxRounds - 1) {
      // ride-budget bound: a budgeted run must not let one step's patience eat the whole clock
      if (opts.maxWaitMs != null && Date.now() - rideStart >= opts.maxWaitMs) {
        throw new Error(`All LLM backends failed [${opts.purpose}] — ride budget of ${Math.round(opts.maxWaitMs / 1000)}s exhausted. ${lastError}`);
      }
      // Progressive backoff: waiting until the earliest cooldown, but the cap grows with each
      // round (120s → up to 12 min). Deeply exhausted tiers need real rest — hammering a
      // rate-limited backend every 2 minutes can keep its window resetting forever.
      const capMs = 120_000 + round * 15_000;
      const nextCooldown = Math.min(
        ...[...health.values()].filter((h) => h.cooldownUntil > Date.now()).map((h) => h.cooldownUntil - Date.now()),
        capMs
      );
      const waitMs = Math.max(20_000, Math.min(nextCooldown, capMs));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(`All LLM backends failed [${opts.purpose}] after ${maxRounds} rounds. ${lastError}`);
}

export function getBackendHealthSnapshot() {
  const out: Record<string, BackendHealth & { cooldownActive: boolean }> = {};
  for (const [id, h] of health.entries()) out[id] = { ...h, cooldownActive: h.cooldownUntil > Date.now() };
  return out;
}

/** ==================================================================
 *  STREAMING LAYER — instant visible thinking
 *  Streams reasoning_content (the model's thinking) and content (the
 *  answer) the moment each token is generated, via onDelta callbacks.
 *  Falls back to the patient non-streaming chain when no backend can stream.
 *  ================================================================== */

/** Idle watchdog: cancels the stream if no bytes arrive within `ms`. */
function idleWatch(ms: number, onStall: () => void) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return {
    touch() {
      if (t) clearTimeout(t);
      t = setTimeout(onStall, ms);
    },
    clear() {
      if (t) clearTimeout(t);
      t = null;
    },
  };
}

/** Read an SSE body, invoking onData for each `data:` payload. Throws if the stream stalls. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
  idleMs = 90_000
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stalled = false;
  const watch = idleWatch(idleMs, () => {
    stalled = true;
    void reader.cancel().catch(() => {});
  });
  watch.touch();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watch.touch();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const p = line.slice(5).trim();
          if (p) onData(p);
        }
      }
    }
  } finally {
    watch.clear();
    reader.releaseLock?.();
  }
  if (stalled) throw new Error("LLM stream stalled (no data received)");
}

interface StreamOutcome {
  text: string;
  reasoning?: string;
}

/** Consume a streaming response: accumulate text + reasoning, forward every fragment to onDelta.
 *  Defensive: if a backend ignored stream:true and returned a plain JSON body, parse it directly. */
async function consumeStream(
  body: unknown,
  onDelta: (d: StreamDelta) => void,
  label: string,
  idleMs = 90_000
): Promise<StreamOutcome> {
  if (!body || typeof (body as ReadableStream).getReader !== "function") {
    const data = body as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${label} empty response`);
    const reasoning = data.choices?.[0]?.message?.reasoning_content || undefined;
    if (reasoning) onDelta({ reasoning });
    return { text, reasoning };
  }
  let text = "";
  let reasoning = "";
  await readSse(body as ReadableStream<Uint8Array>, (payload) => {
    if (payload === "[DONE]") return;
    let j: unknown;
    try {
      j = JSON.parse(payload);
    } catch {
      return; // keep-alive comments / partial frames are ignored
    }
    const d = (j as { choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string } }[] })?.choices?.[0]?.delta;
    if (!d) return;
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string" && r) {
      reasoning += r;
      onDelta({ reasoning: r });
    }
    if (typeof d.content === "string" && d.content) {
      text += d.content;
      onDelta({ content: d.content });
    }
  });
  if (!text.trim()) throw new Error(`${label} empty stream`);
  return { text, reasoning: reasoning || undefined };
}

/** Stream a GLM completion through the z.ai SDK (returns the raw SSE ReadableStream). */
async function callGlmStream(
  model: string | undefined,
  messages: ChatMsg[],
  wantThinking: boolean,
  maxTokens: number | undefined,
  onDelta: (d: StreamDelta) => void,
  headerTimeoutMs = 60_000
): Promise<StreamOutcome> {
  if (!cachedZai) cachedZai = await ZAI.create();
  const out = await Promise.race([
    cachedZai.chat.completions.create({
      messages: messages as never,
      stream: true,
      thinking: { type: wantThinking ? "enabled" : "disabled" },
      ...(model ? { model } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`GLM stream timeout (${Math.round(headerTimeoutMs / 1000)}s to connect)`)), headerTimeoutMs)
    ),
  ]);
  return consumeStream(out, onDelta, "GLM");
}

/** Stream a completion from an OpenAI-compatible keyless endpoint.
 *  Two-phase guarding: headers must arrive fast (a dead/queueing backend must not hold
 *  the connection for the full timeout), then the body is bounded by an idle-watch. */
async function callOpenAiStream(
  ep: PoolEndpoint,
  messages: ChatMsg[],
  maxTokens: number | undefined,
  onDelta: (d: StreamDelta) => void,
  timeoutMs = 90_000
): Promise<StreamOutcome> {
  const ctrl = new AbortController();
  // SSE headers arrive within seconds on a healthy backend — a long wait here means the
  // endpoint is queueing/dead (Pollinations holds connections when its queue is full),
  // so bail out early and let the next backend take the call.
  const headerCapMs = Math.min(timeoutMs, 15_000);
  const timer = setTimeout(() => ctrl.abort(), headerCapMs);
  try {
    const res = await fetch(ep.baseUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify({
        model: ep.model,
        messages: foldSystemIntoUser(messages),
        stream: true,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${ep.label} HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (res.body && (ct.includes("text/event-stream") || ct.includes("text/plain"))) {
      clearTimeout(timer); // headers are in — the body phase is guarded by the idle-watch instead
      return await consumeStream(res.body, onDelta, ep.label, Math.min(90_000, Math.max(30_000, timeoutMs)));
    }
    // backend ignored stream:true — plain JSON response
    const data = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${ep.label} empty response`);
    const reasoning = data.choices?.[0]?.message?.reasoning_content || undefined;
    if (reasoning) onDelta({ reasoning });
    return { text, reasoning };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * STREAMING completion with the same failover semantics as llmComplete:
 * tries each healthy backend with stream:true (GLM SDK first in auto mode), forwarding
 * reasoning + content fragments to onDelta the instant they are generated. If no backend
 * can stream, falls back to the patient non-streaming chain and delivers its reasoning
 * in one final onDelta (unless fragments were already streamed).
 */
export async function llmStreamComplete(
  messages: ChatMsg[],
  opts: LlmOptions & { onDelta?: (d: StreamDelta) => void }
): Promise<LlmResult> {
  const onDelta = opts.onDelta;
  let streamedAny = false;
  const forward = (d: StreamDelta) => {
    streamedAny = true;
    onDelta?.(d);
  };
  const backends = (await orderedBackends(opts.pref ?? "auto", opts.purpose)).filter((e) => e.enabled);
  for (const be of backends) {
    const h = getHealth(be.id);
    if (h.cooldownUntil > Date.now()) continue;
    if (h.cooldownUntil > 0) {
      h.cooldownUntil = 0;
      h.failures = 0; // fresh slate after cooldown — matches llmComplete
    }
    const started = Date.now();
    h.calls++;
    forward({ attempt: "start" }); // let consumers reset any partial state from a prior attempt
    try {
      const out =
        be.baseUrl === "z-ai-sdk"
          ? await callGlmStream(
              GLM_SDK_MODELS.find((m) => m.id === be.id)?.model,
              messages,
              opts.wantThinking ?? false,
              opts.maxTokens,
              forward,
              Math.min(opts.timeoutMs ?? 60_000, 60_000)
            )
          : await callOpenAiStream(be, messages, opts.maxTokens, forward, opts.timeoutMs ?? 90_000);
      h.ok++;
      h.failures = 0;
      h.lastLatencyMs = Date.now() - started;
      return { text: out.text, reasoning: out.reasoning, backendId: be.id, model: be.model || be.label, latencyMs: h.lastLatencyMs };
    } catch (err) {
      h.failures++;
      h.lastError = err instanceof Error ? err.message : String(err);
      if (h.failures >= 4) {
        h.cooldownUntil = Date.now() + COOLDOWN_MS;
      }
    }
  }
  // Nothing could stream — ride the patient non-streaming chain instead.
  forward({ attempt: "start" });
  const r = await llmComplete(messages, opts);
  if (r.reasoning && !streamedAny) forward({ reasoning: r.reasoning });
  return r;
}
