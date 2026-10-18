/** LLM7 model catalog + pinned-model pref helpers — CLIENT-SAFE (zero server
 *  imports). One source of truth shared by the composer/model picker UI, the
 *  zustand store, the POST /api/research validation, and src/lib/research/llm.ts
 *  (the server chain), so the picker can never drift from what the engine can
 *  actually serve.
 *
 *  A "pinned" pref (llm7pin:<model>) makes ONE specific LLM7 model lead every
 *  step of the run — the rest of the keyless pool rides behind it as failover,
 *  then z.ai GLM. That is the user-facing answer to "i need to choose from llm7
 *  model like minimax 2.7 or nemotron". */

export const PIN_PREFIX = "llm7pin:";

export interface Llm7ModelChoice {
  /** the exact model string sent to api.llm7.io */
  model: string;
  /** human label shown in the picker */
  label: string;
  /** one-line note shown under the label */
  note: string;
  tier: "keyless" | "premium";
}

/** LLM7 keyless turbo tier — live-probed (scripts/probe_llm7_full.sh, Oct 2026):
 *  exactly these 7 chat models serve without any key. Order = best-answer-first.
 *  nemotron-3-nano:30b carries a 1M-token context — the widest of the tier. */
export const LLM7_KEYLESS_CHOICES: Llm7ModelChoice[] = [
  { model: "GLM-5.3-Flash", label: "GLM-5.3-Flash", note: "flagship flash, 400k ctx — frequently busy", tier: "keyless" },
  { model: "DeepSeek-V4-Flash-0731", label: "DeepSeek-V4-Flash", note: "the reliable star, 400k ctx", tier: "keyless" },
  { model: "nemotron-3-nano:30b", label: "Nemotron-3-Nano-30B", note: "1M-token context, reasoning", tier: "keyless" },
  { model: "minimax-m2.7", label: "MiniMax-M2.7", note: "180k ctx", tier: "keyless" },
  { model: "mistral-Nemo-Instruct-2407", label: "Mistral-Nemo", note: "128k ctx, 100% availability", tier: "keyless" },
  { model: "gpt-oss:20b", label: "gpt-oss-20b", note: "128k ctx — last-resort generalist", tier: "keyless" },
  { model: "codestral-latest", label: "Codestral", note: "32k ctx, code-leaning — final fallback", tier: "keyless" },
];

/** LLM7 premium tier — needs the user's own (free) LLM7 dashboard key with
 *  balance/quota; live-probed (Oct 2026). With no key these lanes simply don't
 *  exist in the chain — the pin falls back to the keyless pool route. */
export const LLM7_PREMIUM_CHOICES: Llm7ModelChoice[] = [
  { model: "DeepSeek-V4.1-Flash", label: "DeepSeek-V4.1-Flash", note: "reasoning + 1M ctx", tier: "premium" },
  { model: "gpt-6-sol", label: "GPT-6-Sol", note: "frontier generalist", tier: "premium" },
  { model: "claude-sonnet-5-5", label: "Claude-Sonnet-5.5", note: "best writing", tier: "premium" },
  { model: "gemini-3.8-flash-high", label: "Gemini-3.8-Flash-High", note: "cheap + fast", tier: "premium" },
  { model: "kimi-k3", label: "Kimi-K3", note: "agentic", tier: "premium" },
  { model: "claude-haiku-5-5", label: "Claude-Haiku-5.5", note: "fast assistant", tier: "premium" },
  { model: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", note: "deep reasoning", tier: "premium" },
  { model: "grok-4.7", label: "Grok-4.7", note: "xAI frontier", tier: "premium" },
  { model: "minimax-m3", label: "MiniMax-M3", note: "newer MiniMax", tier: "premium" },
  { model: "glm-5.3", label: "GLM-5.3", note: "GLM via LLM7", tier: "premium" },
  { model: "gemini-4-argon", label: "Gemini-4-Argon", note: "Google frontier", tier: "premium" },
  { model: "claude-opus-5-5", label: "Claude-Opus-5.5", note: "top tier", tier: "premium" },
];

/** Every pickable LLM7 model, keyless first (always available), premium behind. */
export const LLM7_MODEL_CHOICES: Llm7ModelChoice[] = [...LLM7_KEYLESS_CHOICES, ...LLM7_PREMIUM_CHOICES];

/** Every valid modelPref value: the 4 route families + a pin per LLM7 model. */
export type ModelPrefValue = "auto" | "llm7" | "glm" | "pool" | `llm7pin:${string}`;

const ALL_MODELS = new Map(LLM7_MODEL_CHOICES.map((c) => [c.model.toLowerCase(), c]));

/** The pinned raw model string of an llm7pin:<model> pref — null for route prefs. */
export function pinModelOf(pref: string): string | null {
  if (typeof pref !== "string" || !pref.startsWith(PIN_PREFIX)) return null;
  const m = pref.slice(PIN_PREFIX.length).trim();
  return m.length > 0 ? m : null;
}

/** The full choice entry behind a pin pref — null for route prefs or unknown models. */
export function pinChoiceOf(pref: string): Llm7ModelChoice | null {
  const m = pinModelOf(pref);
  if (!m) return null;
  return ALL_MODELS.get(m.toLowerCase()) ?? null;
}

/** POST-body guard: the 4 route families, or llm7pin:<a known catalog model>. */
export function isValidModelPref(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (v === "auto" || v === "llm7" || v === "glm" || v === "pool") return true;
  const m = pinModelOf(v);
  return m != null && ALL_MODELS.has(m.toLowerCase());
}

/** The composer pill label: "GLM main" / "LLM7 main" / … / "MiniMax-M2.7". */
export function modelPrefPillLabel(pref: string): string {
  const c = pinChoiceOf(pref);
  if (c) return c.label;
  switch (pref) {
    case "llm7":
      return "LLM7 main";
    case "glm":
      return "GLM only";
    case "pool":
      return "Pool only";
    default:
      return "GLM main";
  }
}
