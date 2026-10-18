import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { LLM7_KEYLESS_CHOICES, LLM7_MODEL_CHOICES, LLM7_PREMIUM_CHOICES, pinModelOf, type ModelPrefValue } from "@/lib/model-choices";

/** The user's chosen model route. "auto" = GLM leads, the keyless pool helps
 *  (failover); "llm7" = the pool leads, GLM helps — the mirror route. "glm" /
 *  "pool" pin to one family only. "llm7pin:<model>" pins ONE specific LLM7
 *  model (e.g. minimax-m2.7, nemotron-3-nano:30b) to lead every step. */
export type ModelPref = ModelPrefValue;

/** Human-readable route descriptions for the four ROUTE families — shown in the
 *  run's first activity line and reused by the UI so the wording never drifts.
 *  Pinned prefs build theirs dynamically in routeInfoFor(). */
export const MODEL_PREF_ROUTES: Record<"auto" | "llm7" | "glm" | "pool", { label: string; route: string }> = {
  auto: { label: "GLM main", route: "z.ai GLM leads every step → LLM7 multi-model keyless pool (DeepSeek-V4 · Nemotron-1M · MiniMax · Mistral · gpt-oss) → Pollinations failover" },
  llm7: { label: "LLM7 main", route: "LLM7 multi-model keyless pool leads → Pollinations → z.ai GLM failover" },
  glm: { label: "GLM only", route: "z.ai GLM lane only (SDK, or the official API backstop on Vercel)" },
  pool: { label: "Pool only", route: "keyless pool only (LLM7 / Pollinations + your custom endpoints)" },
};

/** Route label+description for ANY pref, pinned models included — the engine's
 *  first activity line and any UI badge call this so a pin reads e.g.
 *  "LLM7 · MiniMax-M2.7 pinned — leads every step → keyless pool → GLM failover". */
export function routeInfoFor(pref: string): { label: string; route: string } {
  const pin = pinModelOf(pref);
  if (pin) {
    const c = LLM7_MODEL_CHOICES.find((x) => x.model.toLowerCase() === pin.toLowerCase());
    const label = c?.label ?? pin;
    const keyNote = c?.tier === "premium" ? " · rides your LLM7 key" : " · keyless";
    return {
      label,
      route: `LLM7 · ${label} pinned${keyNote} — leads every step → rest of the keyless pool → z.ai GLM failover`,
    };
  }
  return MODEL_PREF_ROUTES[(pref as "auto" | "llm7" | "glm" | "pool") ?? "auto"] ?? MODEL_PREF_ROUTES.auto;
}

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
  /** Z.ai-native endpoint (official API): sends the `thinking` body field and keeps
   *  system messages unfolded — the official API supports both natively. */
  zaiNative?: boolean;
}

interface BackendHealth {
  calls: number;
  ok: number;
  failures: number;
  cooldownUntil: number;
  lastError?: string;
  lastLatencyMs: number;
}

/** LLM7 keyless turbo tier — live-probed (scripts/probe_llm7_full.sh, Oct 2026):
 *  exactly these 7 chat models serve without any key (every other catalog entry
 *  returns missing_api_key — catalog flags lie, live probes don't). Order =
 *  best-answer-first, so a busy model falls through to the next keyless lane
 *  instead of stalling the run. Catalog + notes live in src/lib/model-choices.ts
 *  (shared with the picker UI). */
const LLM7_KEYLESS_MODELS: { model: string; label: string; note: string }[] = LLM7_KEYLESS_CHOICES;

const BUILTIN_POOL: PoolEndpoint[] = [
  ...LLM7_KEYLESS_MODELS.map(
    (m) =>
      ({
        id: `llm7-${m.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
        label: `LLM7 · ${m.label} · keyless`,
        baseUrl: "https://api.llm7.io/v1/chat/completions",
        model: m.model,
        enabled: true,
      }) as PoolEndpoint
  ),
  { id: "pollinations", label: "Pollinations · keyless", baseUrl: "https://text.pollinations.ai/openai", model: "openai", enabled: true },
];

/** LLM7 premium tier — locked behind the user's own (free) LLM7 dashboard key.
 *  A key changes two things: (a) the keyless turbo lanes above ride the user's
 *  PERSONAL daily quota instead of the shared anonymous pool (which exhausts
 *  daily — live probe showed "Retry after 13397 seconds"), and (b) these pro
 *  models become reachable when the key has balance/quota. Order = best value
 *  for research first: DeepSeek-V4.1 reasoning + 1M ctx, GPT-6, Claude Sonnet
 *  5.5 writing, Gemini-3.8 flash (cheap+fast), Kimi-K3 agentic, then the rest
 *  by strength-per-cost. Live-probed against the catalog (scripts/
 *  probe_llm7_keyless_now.sh, Oct 2026): every entry below answers "Missing
 *  API key" keyless, i.e. reachable with a key; hard-access failures skip in
 *  one round-trip and cool down 30 min, so deep lanes cost nothing when the
 *  key lacks balance. */
const LLM7_PREMIUM_MODELS: { model: string; label: string }[] = LLM7_PREMIUM_CHOICES;

let llm7KeyCache: { at: number; key: string } | null = null;
/** The user's LLM7 dashboard key (Setting "llm7_key") — empty string when absent. */
async function getLlm7Key(): Promise<string> {
  if (llm7KeyCache && Date.now() - llm7KeyCache.at < 30_000) return llm7KeyCache.key;
  let key = "";
  try {
    const row = await db.setting.findUnique({ where: { key: "llm7_key" } });
    if (row) key = JSON.parse(row.value);
  } catch { key = ""; }
  if (typeof key !== "string") key = "";
  llm7KeyCache = { at: Date.now(), key };
  return key;
}

export function invalidateLlm7KeyCache() {
  llm7KeyCache = null;
}

/** Z.ai official API backstop — activated only when ZAI_API_KEY is set (server-side
 *  env var on Vercel; NEVER committed to the repo, never sent to the client).
 *  Sits right behind the keyless builtins: keyless serves the common case for free,
 *  and this backstop rescues jobs during keyless throttle storms instead of making
 *  users wait out 90s+ cooldowns. Free-tier models only (glm-4.5-flash) so a zero
 *  balance still works. Models are configurable via ZAI_API_MODELS (comma-separated). */
function zaiEnvBackends(): PoolEndpoint[] {
  const key = process.env.ZAI_API_KEY?.trim();
  if (!key) return [];
  const base = (process.env.ZAI_API_URL?.trim() || "https://api.z.ai/api/paas/v4").replace(/\/+$/, "");
  const models = (process.env.ZAI_API_MODELS || "glm-4.5-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 4);
  return models.map((m) => ({
    id: `zai-api-${m}`,
    label: `Z.ai API · ${m} · server key`,
    baseUrl: `${base}/chat/completions`,
    model: m,
    enabled: true,
    key,
    zaiNative: true,
  }));
}

/** The SDK loads .z-ai-config from cwd / home / /etc (mirroring its own loadConfig()
 *  search order). Where none exists — e.g. on Vercel — the SDK path is dead weight
 *  that would fail on every call, so we probe once per process and skip it entirely. */
let sdkAvailable: boolean | null = null;
function isSdkAvailable(): boolean {
  if (sdkAvailable === null) {
    const candidates = [path.join(process.cwd(), ".z-ai-config"), path.join(os.homedir(), ".z-ai-config"), "/etc/.z-ai-config"];
    sdkAvailable = candidates.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  }
  return sdkAvailable;
}

/** The z.ai SDK serves ONE keyless lane. Live probes (scripts/probe_sdk_glm53.mjs)
 *  show the server ignores the requested model name — every call, whatever model is
 *  asked for, comes back served as a glm-4-plus class model. The old two-entry design
 *  ("glm-5.3-flash" + "glm-4.5-flash") was therefore two failure counters on the same
 *  physical lane — the first absorbed the 429s and the second inherited, which is exactly
 *  why 5.3 looked "broken" while "4.5" served. One entry, four failures to cooldown:
 *  identical recovery, honest attribution (the REAL served model from the response). */
const GLM_SDK_MODELS: { id: string; label: string; model?: string }[] = [
  { id: "zai-sdk", label: "GLM · z.ai SDK", model: "glm-5.3-flash" },
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
  // custom endpoints only — builtins (keyless + env-keyed Z.ai backstop) are always
  // prepended and never duplicated
  const zai = zaiEnvBackends();
  const builtinUrls = new Set([...BUILTIN_POOL, ...zai].map((e) => e.baseUrl));
  const custom = (Array.isArray(stored) ? stored : []).filter((e) => e?.baseUrl && !builtinUrls.has(e.baseUrl));
  // LLM7 key unlock: with the user's dashboard key, (a) the premium tier joins the
  // chain ahead of keyless and (b) the turbo lanes send the key so they ride the
  // user's personal daily quota instead of the shared anonymous pool.
  const llm7Key = await getLlm7Key();
  let builtin: PoolEndpoint[] = BUILTIN_POOL;
  if (llm7Key) {
    const premium: PoolEndpoint[] = LLM7_PREMIUM_MODELS.map((m) => ({
      id: `llm7pro-${m.model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      label: `LLM7 · ${m.label} · your key`,
      baseUrl: "https://api.llm7.io/v1/chat/completions",
      model: m.model,
      enabled: true,
      key: llm7Key,
    }));
    builtin = [
      ...premium,
      ...BUILTIN_POOL.map((e) =>
        e.baseUrl === "https://api.llm7.io/v1/chat/completions" ? { ...e, key: llm7Key, label: e.label.replace("keyless", "your key") } : e
      ),
    ];
  }
  const data = [...builtin, ...zai, ...custom];
  endpointsCache = { at: Date.now(), data };
  return data;
}

export function invalidateEndpointsCache() {
  endpointsCache = null;
}

async function glmBackends(): Promise<PoolEndpoint[]> {
  if (!isSdkAvailable()) return []; // no SDK config in this runtime (e.g. Vercel)
  return GLM_SDK_MODELS.map(
    (m) => ({ id: m.id, label: `${m.label} · z.ai SDK`, baseUrl: "z-ai-sdk", model: m.label, enabled: true }) as PoolEndpoint
  );
}

/** Backend order for a pref — exported for tests (scripts/test-model-pin.ts) and
 *  any admin surface that wants to SHOW the user their exact chain. */
export async function orderedBackends(pref: ModelPref, purpose?: string): Promise<PoolEndpoint[]> {
  const pool = (await getPoolEndpoints()).filter((e) => e.enabled);
  const glms = await glmBackends();
  // "glm" pref: the SDK path where a .z-ai-config exists (sandbox/local), else the
  // official Z.ai API backstop — so the GLM preference still works on Vercel.
  if (pref === "glm") return glms.length > 0 ? glms : zaiEnvBackends();
  if (pref === "pool") return pool;
  // "llm7pin:<model>": ONE specific LLM7 model (user's pick — e.g. minimax-m2.7,
  // nemotron-3-nano:30b) leads EVERY step; the rest of the pool rides right
  // behind it as failover (a pinned lane in cooldown degrades gracefully to the
  // next lane), and z.ai GLM closes the chain. A premium pin without the user's
  // LLM7 key never materializes as an endpoint — fall back to the llm7 route so
  // the run still works and the choice auto-upgrades the moment a key is saved.
  const pin = pinModelOf(pref);
  if (pin) {
    const pinned = pool.find((e) => e.model.toLowerCase() === pin.toLowerCase());
    if (pinned) return [pinned, ...pool.filter((e) => e !== pinned), ...glms];
  }
  // "llm7" pref: the multi-model keyless pool leads every step and z.ai GLM
  // rides behind it as the failover lane — the mirror image of "auto".
  if (pref === "llm7") return [...pool, ...glms];
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
): Promise<{ text: string; reasoning?: string; servedModel?: string }> {
  if (!cachedZai) cachedZai = await ZAI.create();
  const completion = (await Promise.race([
    cachedZai.chat.completions.create({
      messages: messages as never,
      thinking: { type: wantThinking ? "enabled" : "disabled" },
      ...(model ? { model } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`GLM timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)),
  ])) as { model?: string; choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[] };
  const msg = completion.choices?.[0]?.message;
  const text = msg?.content ?? "";
  if (!text.trim()) throw new Error("GLM returned empty response");
  return { text, reasoning: msg?.reasoning_content || msg?.reasoning || undefined, servedModel: completion.model || undefined };
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

interface Served { text: string; reasoning?: string; servedModel?: string }

async function callOpenAiCompatible(
  ep: PoolEndpoint,
  messages: ChatMsg[],
  maxTokens?: number,
  timeoutMs = 90_000,
  wantThinking = false
): Promise<Served> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ep.baseUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify({
        model: ep.model,
        messages: ep.zaiNative ? messages : foldSystemIntoUser(messages),
        ...(ep.zaiNative ? { thinking: { type: wantThinking ? "enabled" : "disabled" } } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
    if (!res.ok) {
      // surface the server's own error message (LLM7 quota errors carry the exact
      // "Retry after N seconds" text the cooldown logic parses — an HTTP status
      // alone would hide it)
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string; code?: string } };
        detail = [j?.error?.code, j?.error?.message].filter(Boolean).join(": ").slice(0, 300);
      } catch { /* non-JSON body */ }
      throw new Error(`${ep.label} HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${ep.label} empty response`);
    return { text, reasoning: data.choices?.[0]?.message?.reasoning_content || undefined, servedModel: data.model || undefined };
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
  // v2.4.7: the rescue pass applies only to substantive calls (≥15s budget) — tiny
  // routing calls (classify 12s, role 12s) fail fast without it; their worst case
  // doubled with the rescue and planning variance grew to 135s.
  // v2.4.2: a fast timeout must bound the WHOLE CHAIN, not each backend — with ~19
  // backends a per-backend 30s ceiling lets one throttled call ride 9+ minutes and
  // freeze the serverless function with the report unpersisted. The chain deadline
  // is the fast budget; each backend gets what's left of it (3s floor).
  const chainDeadline = fast && opts.timeoutMs != null ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
  // Patient mode: up to 40 rounds (with 20-120s waits ≈ 15-80 min of patience) so a fully
  // throttled free-tier window never kills an hours-long research run the user asked for.
  // v2.4.4: fast calls get TWO passes — pass 1, an 8s stagger, then ONE rescue
  // pass with a +10s deadline grace. Parallel tail calls trip lanes into failure
  // counts together; a momentary hot window (not a real cooldown) kills pass 1,
  // and the rescue pass recovers it. Without this, one bad window turned every
  // tail call into findings-fallback + an unscored report.
  const maxRounds = fast ? (opts.timeoutMs != null && opts.timeoutMs >= 15_000 ? 2 : 1) : opts.patient === false ? 1 : 40;
  const rideStart = Date.now();
  let lastError = "";
  for (let round = 0; round < maxRounds; round++) {
    const roundDeadline = round === 0 ? chainDeadline : chainDeadline + 10_000;
    const backends = await orderedBackends(opts.pref ?? "auto", opts.purpose);
    const errors: string[] = [];
    for (const be of backends) {
      if (Date.now() >= roundDeadline) {
        errors.push(`chain deadline (${opts.timeoutMs}ms) hit — ${be.label} not tried`);
        break;
      }
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
          // v2.4.2: in fast mode the per-call timeout is clamped to the chain's
          // remaining budget (3s floor) — the whole chain must fit opts.timeoutMs.
          const callTimeout = fast ? Math.max(3_000, roundDeadline - Date.now()) : undefined;
          const out: Served = isGlm
            ? await callGlm(
                GLM_SDK_MODELS.find((m) => m.id === be.id)?.model,
                messages,
                opts.wantThinking ?? false,
                opts.maxTokens,
                callTimeout ?? opts.timeoutMs ?? 150_000
              )
            : await callOpenAiCompatible(be, messages, opts.maxTokens, callTimeout ?? opts.timeoutMs ?? 90_000, opts.wantThinking ?? false);
          h.ok++;
          h.failures = 0;
          h.lastLatencyMs = Date.now() - started;
          return {
            text: out.text,
            reasoning: out.reasoning,
            backendId: be.id,
            // honest attribution: report the model the backend ACTUALLY served — the
            // z.ai SDK ignores requested names (everything comes back glm-4-plus class),
            // and OpenAI-compatible endpoints echo the real model id in `data.model`.
            model: out.servedModel || be.model || be.label,
            latencyMs: h.lastLatencyMs,
          };
        } catch (err) {
          h.failures++;
          h.lastError = err instanceof Error ? err.message : String(err);
          // Error-class-aware cooldown — LLM7 tells us exactly how long to back off:
          //   "Daily token quota exceeded. Retry after 13397 seconds."  → honor it
          //   (bounded to 30 min; hammering a quota-exhausted lane burns the daily
          //   pool faster and wastes a round-trip on every call).
          // Hard-access errors (invalid key, pro access) will never heal by retrying
          // within a run — long cooldown so the lane stops costing wall-clock.
          const quota = /retry after (\d+)\s*second/i.exec(h.lastError);
          const hardAccess = /invalid_api_key|pro_access_required|missing_api_key|unsupported_model_feature/i.test(h.lastError);
          if (quota) {
            const waitS = Math.min(Number(quota[1]) + 5, 1800);
            h.cooldownUntil = Date.now() + waitS * 1000;
            h.failures = 0; // the lane isn't unhealthy — it's quota-resting
            errors.push(`${be.label}: quota — resting ${Math.round(waitS / 60)} min (server said so)`);
            break; // no in-lane retry: the server just told us it cannot serve
          }
          if (hardAccess) {
            h.cooldownUntil = Date.now() + 30 * 60_000;
            h.failures = 0;
            errors.push(`${be.label}: ${h.lastError} (unreachable keyless — skipping for 30 min)`);
            break;
          }
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
      if (fast) {
        // v2.4.4: the fast rescue stagger — short wait, then one more pass
        await new Promise((r) => setTimeout(r, 8_000));
        continue;
      }
      // ride-budget bound: a budgeted run must not let one step's patience eat the whole clock
      if (opts.maxWaitMs != null && Date.now() - rideStart >= opts.maxWaitMs) {
        throw new Error(`All LLM backends failed [${opts.purpose}] — ride budget of ${Math.round(opts.maxWaitMs / 1000)}s exhausted. ${lastError}`);
      }
      // Progressive backoff: waiting until the earliest cooldown, but the cap grows with each
      // round (120s → up to 12 min). Deeply exhausted tiers need real rest — hammering a
      // rate-limited backend every 2 minutes can keep its window resetting forever.
      // v2.5.1: +0-7s jitter — parallel workers waking at the same cooldown end hit the
      // shared anonymous pool simultaneously and re-trip it; the stagger spreads them.
      const capMs = 120_000 + round * 15_000;
      const nextCooldown = Math.min(
        ...[...health.values()].filter((h) => h.cooldownUntil > Date.now()).map((h) => h.cooldownUntil - Date.now()),
        capMs
      );
      const waitMs = Math.max(20_000, Math.min(nextCooldown, capMs)) + Math.random() * 7_000;
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
  servedModel?: string;
}

/** Consume a streaming response: accumulate text + reasoning, forward every fragment to onDelta.
 *  Defensive: if a backend ignored stream:true and returned a plain JSON body, parse it directly. */
async function consumeStream(
  body: unknown,
  onDelta: (d: StreamDelta) => void,
  label: string,
  idleMs = 90_000,
  servedModel?: string
): Promise<StreamOutcome> {
  if (!body || typeof (body as ReadableStream).getReader !== "function") {
    const data = body as { model?: string; choices?: { message?: { content?: string; reasoning_content?: string } }[] };
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${label} empty response`);
    const reasoning = data.choices?.[0]?.message?.reasoning_content || undefined;
    if (reasoning) onDelta({ reasoning });
    return { text, reasoning, servedModel: servedModel ?? data?.model };
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
  return { text, reasoning: reasoning || undefined, servedModel };
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
  return consumeStream(out, onDelta, "GLM", undefined, (out as { model?: string })?.model);
}

/** Stream a completion from an OpenAI-compatible keyless endpoint.
 *  Two-phase guarding: headers must arrive fast (a dead/queueing backend must not hold
 *  the connection for the full timeout), then the body is bounded by an idle-watch. */
async function callOpenAiStream(
  ep: PoolEndpoint,
  messages: ChatMsg[],
  maxTokens: number | undefined,
  onDelta: (d: StreamDelta) => void,
  timeoutMs = 90_000,
  wantThinking = false
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
        messages: ep.zaiNative ? messages : foldSystemIntoUser(messages),
        ...(ep.zaiNative ? { thinking: { type: wantThinking ? "enabled" : "disabled" } } : {}),
        stream: true,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: { message?: string; code?: string } };
        detail = [j?.error?.code, j?.error?.message].filter(Boolean).join(": ").slice(0, 300);
      } catch { /* non-JSON body */ }
      throw new Error(`${ep.label} HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (res.body && (ct.includes("text/event-stream") || ct.includes("text/plain"))) {
      clearTimeout(timer); // headers are in — the body phase is guarded by the idle-watch instead
      return await consumeStream(res.body, onDelta, ep.label, Math.min(90_000, Math.max(30_000, timeoutMs)));
    }
    // backend ignored stream:true — plain JSON response
    const data = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[]; model?: string };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error(`${ep.label} empty response`);
    const reasoning = data.choices?.[0]?.message?.reasoning_content || undefined;
    if (reasoning) onDelta({ reasoning });
    return { text, reasoning, servedModel: data.model || undefined };
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
  // v2.4.3: fast streaming calls get a CHAIN deadline like llmComplete — the whole
  // backend loop must fit opts.timeoutMs, each attempt clamped to what remains
  // (3s floor). Without this, ~19 backends x 60-90s each rode past the serverless
  // function freeze with the report unpersisted.
  // v2.5.1: PATIENT streaming calls get a stream-pass deadline too (bounded by the
  // ride budget) — the worst case (every lane hanging until its own timeout) must
  // never outlive the slice; the patient non-streaming ride handles the cooldowns.
  const fastStream = opts.timeoutMs != null && opts.patient === false;
  const chainDeadline = fastStream && opts.timeoutMs != null ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
  const streamPassDeadline = fastStream ? chainDeadline : Date.now() + Math.min(opts.maxWaitMs ?? 120_000, 150_000);
  const streamPassStart = Date.now();
  const backends = (await orderedBackends(opts.pref ?? "auto", opts.purpose)).filter((e) => e.enabled);
  for (const be of backends) {
    if (Date.now() >= chainDeadline || Date.now() >= streamPassDeadline) break;
    const h = getHealth(be.id);
    if (h.cooldownUntil > Date.now()) continue;
    if (h.cooldownUntil > 0) {
      h.cooldownUntil = 0;
      h.failures = 0; // fresh slate after cooldown — matches llmComplete
    }
    const started = Date.now();
    h.calls++;
    forward({ attempt: "start" }); // let consumers reset any partial state from a prior attempt
    const callT = fastStream ? Math.max(3_000, chainDeadline - Date.now()) : Math.max(3_000, Math.min(streamPassDeadline - Date.now(), opts.timeoutMs ?? 90_000));
    try {
      const out =
        be.baseUrl === "z-ai-sdk"
          ? await callGlmStream(
              GLM_SDK_MODELS.find((m) => m.id === be.id)?.model,
              messages,
              opts.wantThinking ?? false,
              opts.maxTokens,
              forward,
              Math.min(callT ?? opts.timeoutMs ?? 60_000, 60_000)
            )
          : await callOpenAiStream(be, messages, opts.maxTokens, forward, callT ?? opts.timeoutMs ?? 90_000, opts.wantThinking ?? false);
      h.ok++;
      h.failures = 0;
      h.lastLatencyMs = Date.now() - started;
      return { text: out.text, reasoning: out.reasoning, backendId: be.id, model: out.servedModel || be.model || be.label, latencyMs: h.lastLatencyMs };
    } catch (err) {
      h.failures++;
      h.lastError = err instanceof Error ? err.message : String(err);
      // same error-class awareness as llmComplete: honor quota retry-after, skip
      // hard-access errors for 30 min (they cannot heal inside a run)
      const quota = /retry after (\d+)\s*second/i.exec(h.lastError);
      if (quota) {
        h.cooldownUntil = Date.now() + Math.min(Number(quota[1]) + 5, 1800) * 1000;
        h.failures = 0;
      } else if (/invalid_api_key|pro_access_required|missing_api_key|unsupported_model_feature/i.test(h.lastError)) {
        h.cooldownUntil = Date.now() + 30 * 60_000;
        h.failures = 0;
      } else if (h.failures >= 4) {
        h.cooldownUntil = Date.now() + COOLDOWN_MS;
      }
    }
  }
  // Nothing could stream — ride the patient non-streaming chain instead.
  // v2.4.4: the fallback gets HALF the fast budget — the stream pass already spent
  // its share probing headers; the non-streaming rescue must stay inside the wall
  // time the caller budgeted for the whole call.
  // v2.5.1: patient rides hand the REMAINING ride budget to the non-streaming chain.
  forward({ attempt: "start" });
  const streamElapsed = Date.now() - streamPassStart;
  const r = await llmComplete(messages, {
    ...opts,
    ...(fastStream && opts.timeoutMs != null ? { timeoutMs: Math.max(10_000, Math.round(opts.timeoutMs / 2)) } : {}),
    ...(opts.maxWaitMs != null ? { maxWaitMs: Math.max(15_000, opts.maxWaitMs - streamElapsed) } : {}),
  });
  if (r.reasoning && !streamedAny) forward({ reasoning: r.reasoning });
  return r;
}
