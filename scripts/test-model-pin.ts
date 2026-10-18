/** Pinned-model tests — the "choose minimax 2.7 / nemotron" feature.
 *  Run: bun scripts/test-model-pin.ts
 *  Covers: pref parsing/validation/labels (pure), routeInfoFor (llm.ts),
 *  the REAL backend ordering against the local DB (orderedBackends):
 *  a pinned model must LEAD, the pool must ride behind it, GLM must close —
 *  and v2.8.1 STICKY PIN: short pin cooldowns get a bounded wait instead of a
 *  silent substitution, and pinnedBackendId resolves the live lane id. */
import { LLM7_MODEL_CHOICES, PIN_PREFIX, isValidModelPref, modelPrefPillLabel, pinChoiceOf, pinModelOf } from "../src/lib/model-choices";
import { routeInfoFor, orderedBackends, pinStickyWaitMs, pinnedBackendId } from "../src/lib/research/llm";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!cond) fails++;
};

console.log("— pin parsing");
ok(pinModelOf("llm7pin:minimax-m2.7") === "minimax-m2.7", "pinModelOf extracts minimax-m2.7");
ok(pinModelOf(`llm7pin:nemotron-3-nano:30b`) === "nemotron-3-nano:30b", "pinModelOf keeps colons inside the model id");
ok(pinModelOf("auto") === null && pinModelOf("llm7") === null && pinModelOf("pool") === null, "route prefs are not pins");
ok(pinModelOf("llm7pin:") === null, "empty pin rejected");
ok(pinChoiceOf("llm7pin:minimax-m2.7")?.label === "MiniMax-M2.7", "pinChoiceOf resolves the catalog entry");
ok(pinChoiceOf("llm7pin:MINIMAX-M2.7")?.model === "minimax-m2.7", "pin lookup is case-insensitive");
ok(pinChoiceOf("llm7pin:no-such-model") === null, "unknown model → null");

console.log("— pref validation (POST body guard)");
ok(isValidModelPref("auto") && isValidModelPref("llm7") && isValidModelPref("glm") && isValidModelPref("pool"), "the 4 route families pass");
ok(isValidModelPref("llm7pin:minimax-m2.7"), "pin minimax-m2.7 passes");
ok(isValidModelPref("llm7pin:nemotron-3-nano:30b"), "pin nemotron (colon id) passes");
ok(isValidModelPref("llm7pin:claude-opus-5-5"), "premium pin passes validation");
ok(!isValidModelPref("llm7pin:not-a-model"), "unknown model rejected");
ok(!isValidModelPref("llm7pin:"), "empty pin rejected");
ok(!isValidModelPref("evil"), "random string rejected");
ok(!isValidModelPref(42) && !isValidModelPref(null) && !isValidModelPref(undefined), "non-strings rejected");

console.log("— pill labels");
ok(modelPrefPillLabel("auto") === "GLM main", "auto → GLM main");
ok(modelPrefPillLabel("llm7") === "LLM7 main", "llm7 → LLM7 main");
ok(modelPrefPillLabel("llm7pin:minimax-m2.7") === "MiniMax-M2.7", "pin → the model's own label");
ok(modelPrefPillLabel("llm7pin:nemotron-3-nano:30b") === "Nemotron-3-Nano-30B", "nemotron pin label");
ok(modelPrefPillLabel("garbage") === "GLM main", "unknown falls back to GLM main");

console.log("— routeInfoFor (engine activity line)");
ok(routeInfoFor("auto").label === "GLM main", "auto route info");
const mm = routeInfoFor("llm7pin:minimax-m2.7");
ok(mm.label === "MiniMax-M2.7" && mm.route.includes("MiniMax-M2.7 pinned") && mm.route.includes("keyless"), "pin route text names the model + keyless");
const pro = routeInfoFor("llm7pin:gpt-6-sol");
ok(pro.route.includes("your LLM7 key"), "premium pin route mentions the key");
ok(routeInfoFor("llm7").route.includes("pool leads"), "llm7 route text intact");

console.log("— catalog integrity");
ok(LLM7_MODEL_CHOICES.length === 19, `catalog has 19 models (got ${LLM7_MODEL_CHOICES.length})`);
ok(new Set(LLM7_MODEL_CHOICES.map((c) => c.model.toLowerCase())).size === LLM7_MODEL_CHOICES.length, "no duplicate model ids (case-insensitive)");
ok(LLM7_MODEL_CHOICES.every((c) => c.tier === "keyless" || c.tier === "premium"), "every entry has a tier");
ok(PIN_PREFIX === "llm7pin:", "PIN_PREFIX format stable (parsing uses startsWith+slice, never split — colons in ids are safe)");

console.log("— orderedBackends (real chain, local DB)");
const chainMini = await orderedBackends("llm7pin:minimax-m2.7" as never);
ok(chainMini[0]?.model === "minimax-m2.7", "MiniMax-M2.7 pinned → LEADS the chain");
ok(chainMini.filter((e) => e.model === "minimax-m2.7").length === 1, "pinned model appears exactly once");
ok(chainMini.slice(1).some((e) => e.baseUrl?.includes("llm7.io")), "rest of the LLM7 pool rides behind it");
ok(chainMini.some((e) => e.baseUrl === "z-ai-sdk" || e.baseUrl?.includes("z.ai") || e.baseUrl?.includes("paas")), "GLM failover closes the chain");

const chainNemo = await orderedBackends("llm7pin:nemotron-3-nano:30b" as never);
ok(chainNemo[0]?.model === "nemotron-3-nano:30b", "Nemotron pin (colon id) leads");

const chainAuto = await orderedBackends("auto");
ok(chainAuto[0]?.baseUrl === "z-ai-sdk", "auto still starts on the GLM SDK lane");

const chainLlm7 = await orderedBackends("llm7");
ok(chainLlm7[0]?.baseUrl?.includes("llm7.io") || chainLlm7[0]?.baseUrl?.includes("pollinations"), "llm7 route still starts on the pool");

// premium pin WITHOUT a key: the endpoint never materializes → graceful fallback
// to the pool-led route (never a dead first lane)
const chainPremiumNoKey = await orderedBackends("llm7pin:gpt-6-sol" as never);
ok(chainPremiumNoKey[0]?.model !== "gpt-6-sol", "premium pin without key does NOT lead (no dead lane)");
ok(chainPremiumNoKey.some((e) => e.baseUrl?.includes("llm7.io")), "premium pin falls back to the live pool");

console.log("— sticky pin (v2.8.1: the pin waits out SHORT cooldowns instead of being silently substituted)");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 8_000, 30_000) === 8_250, "chat 30s budget waits out an 8s pin cooldown (cap 10.5s)");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 60_000, 30_000) === 0, "chat budget never waits out a long quota rest");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 20_000, 60_000) === 20_250, "60s patient budget waits up to its 21s cap");
ok(pinStickyWaitMs("llm7pin:nemotron-3-nano:30b", 85_000, 300_000) === 85_250, "deep budgets wait up to the 90s cap");
ok(pinStickyWaitMs("llm7pin:nemotron-3-nano:30b", 95_000, 300_000) === 0, "cooldowns beyond the 90s cap fall through");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 5_000, 12_000) === 0, "routing-class 12s calls never wait (substitution fine, latency not)");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 0, 30_000) === 0, "no cooldown → no wait");
ok(pinStickyWaitMs("auto", 8_000, 30_000) === 0 && pinStickyWaitMs(undefined, 8_000, 30_000) === 0, "non-pin prefs never wait");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 10_000, 15_000) === 0, "tight budget falls through (6s call floor must fit after the wait)");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 8_000, 15_000) === 8_250, "tight-but-fitting budget still waits (8s + 6s ≤ 15s)");
ok(pinStickyWaitMs("llm7pin:minimax-m2.7", 40_000, undefined) === 40_250, "patient default budget (120s) waits up to its 42s cap");

console.log("— pinnedBackendId (live lane resolution — powers the substitution notice)");
ok((await pinnedBackendId("llm7pin:minimax-m2.7")) === "llm7-minimax-m2-7", "minimax pin → its keyless lane id");
ok((await pinnedBackendId("llm7pin:nemotron-3-nano:30b")) === "llm7-nemotron-3-nano-30b", "colon-id nemotron pin → lane id");
ok((await pinnedBackendId("auto")) === null && (await pinnedBackendId("llm7")) === null, "route prefs → null");
ok((await pinnedBackendId("llm7pin:gpt-6-sol")) === null, "premium pin without a key → null (not materialized, no false notice)");

console.log(fails === 0 ? "\nALL PIN TESTS PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
