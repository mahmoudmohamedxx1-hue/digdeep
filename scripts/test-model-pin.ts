/** Pinned-model tests — the "choose minimax 2.7 / nemotron" feature.
 *  Run: bun scripts/test-model-pin.ts
 *  Covers: pref parsing/validation/labels (pure), routeInfoFor (llm.ts),
 *  and the REAL backend ordering against the local DB (orderedBackends):
 *  a pinned model must LEAD, the pool must ride behind it, GLM must close. */
import { LLM7_MODEL_CHOICES, PIN_PREFIX, isValidModelPref, modelPrefPillLabel, pinChoiceOf, pinModelOf } from "../src/lib/model-choices";
import { routeInfoFor, orderedBackends } from "../src/lib/research/llm";

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

console.log(fails === 0 ? "\nALL PIN TESTS PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
