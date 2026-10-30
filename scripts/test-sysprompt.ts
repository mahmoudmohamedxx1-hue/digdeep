/** System-prompt structure tests — CHAT_SYS must keep the Fable-5-mirroring
 *  skeleton (product_information → identity_and_the_harness → tone → mistakes
 *  → knowledge_cutoff → evenhandedness → user_wellbeing → the_chat_lane),
 *  embed the grounded product spec ALWAYS, carry the identity/self-awareness
 *  rules, and stay consistent with the live model catalog.
 *  Run: bun scripts/test-sysprompt.ts */
import { CHAT_SYS, RESEARCHER_SYS, chatPrompt, quickAnswerPrompt } from "../src/lib/research/prompts";
import { SELF_KNOWLEDGE } from "../src/lib/research/self-knowledge";
import { LLM7_KEYLESS_CHOICES } from "../src/lib/model-choices";

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

console.log("── A · Fable-5 skeleton: every section present, in order ──");
const SECTIONS = [
  "# digdeep_behavior",
  "## product_information",
  "## identity_and_the_harness",
  "## tone_and_formatting",
  "### lists_and_bullets",
  "## responding_to_mistakes_and_criticism",
  "## knowledge_cutoff_and_live_information",
  "## evenhandedness",
  "## user_wellbeing",
  "## the_chat_lane",
];
let cursor = -1;
let ordered = true;
for (const s of SECTIONS) {
  const at = CHAT_SYS.indexOf(s);
  if (at === -1 || at < cursor) {
    ordered = false;
    console.error(`    out-of-order or missing: ${s} @${at}`);
    break;
  }
  cursor = at;
}
ok(ordered, `all ${SECTIONS.length} sections present in Fable order`);
ok(CHAT_SYS.startsWith("Never wrap chat replies"), "opener line (formatting guard) leads the prompt");

console.log("── B · product information is ALWAYS embedded ──");
ok(CHAT_SYS.includes(SELF_KNOWLEDGE), "SELF_KNOWLEDGE embedded verbatim in CHAT_SYS (every reply grounded)");
ok(SELF_KNOWLEDGE.includes("independent project, not affiliated"), "spec answers 'who made you' honestly (independent project)");
ok(SELF_KNOWLEDGE.includes("SEARCH ENGINES (13 total"), "spec still carries the 13-engine ground truth");
ok(SELF_KNOWLEDGE.includes("RESEARCH PIPELINE"), "spec still carries the pipeline ground truth");

console.log("── C · identity & harness self-awareness rules ──");
ok(CHAT_SYS.includes("Never identify as the underlying model"), "never identify as the base model");
ok(CHAT_SYS.includes("never claim to be ChatGPT, Claude, Gemini, Grok, Copilot".replace("never", "Never")), "never claim to be another assistant");
ok(CHAT_SYS.includes("which model are you?"), "direct 'which model are you' has an honest scripted answer");
ok(CHAT_SYS.includes("built-in script"), "aware of the throttled built-in-script fallback");
ok(CHAT_SYS.includes("interchangeable model backends"), "knows it is one of several interchangeable backends");
ok(CHAT_SYS.includes("harness"), "explicitly aware of the harness it runs inside");
// the backends named in the identity section must be REAL catalog labels (no drift)
for (const label of ["GLM-5.3-Flash", "Mistral-Nemo", "MiniMax-M2.7", "DeepSeek-V4-Flash"]) {
  ok(LLM7_KEYLESS_CHOICES.some((c) => c.label === label), `named backend '${label}' exists in the live model catalog`);
}
ok(CHAT_SYS.includes("DeepSeek-V4-Flash, and others"), "identity section names catalog backends");

console.log("── D · craft rules survived the restructure ──");
ok(CHAT_SYS.includes("SAME language the user wrote in"), "language mirroring rule");
ok(CHAT_SYS.includes("at most one question back"), "one-question-back rule");
ok(CHAT_SYS.includes('"genuinely", "honestly", "straightforward"'), "banned filler words");
ok(CHAT_SYS.includes("at most ONCE per conversation"), "invite-a-topic-once rule");
ok(CHAT_SYS.includes("NO web access"), "chat lane forbids pretending to browse");
ok(CHAT_SYS.includes("never fabricate"), "no fabricated facts/citations");

console.log("── E · size & hygiene ──");
const len = CHAT_SYS.length;
ok(len > 4000 && len < 12000, `size in range 4–12 KB (got ${(len / 1024).toFixed(1)} KB — fits 32k-context backends)`);
ok(!/\bTODO\b|XXX|【/.test(CHAT_SYS), "no placeholders");
ok(!CHAT_SYS.includes("Claude-like"), "no residual 'Claude-like voice' (self-identity leak)");

console.log("── F · the other lanes kept their identity line ──");
ok(!chatPrompt("hi", "").includes("Claude-like"), "chatPrompt no longer asks for a Claude-like voice");
ok(quickAnswerPrompt("q", [{ n: 1, title: "t", domain: "d", excerpt: "e" }], "English").includes("You ARE DigDeep"), "quick answer prompt carries the DigDeep byline");
ok(quickAnswerPrompt("q", [{ n: 1, title: "t", domain: "d", excerpt: "e" }], "English").includes("[n]"), "quick answer prompt still demands [n] citations");
ok(RESEARCHER_SYS.includes("interchangeable model backend inside the DigDeep harness"), "RESEARCHER_SYS has the harness identity line");
ok(RESEARCHER_SYS.includes("never invent facts or citations"), "RESEARCHER_SYS kept its rigor rules");
// self-topic path still shapes the answer AND re-states the grounding rule
const selfP = chatPrompt("what engines do you use?", "", "engines" as never);
ok(selfP.includes("PRODUCT INFORMATION"), "self-topic chat prompt still injects the product spec");
ok(selfP.includes("answer from the product information above ONLY") || selfP.includes("Answer from the product information above ONLY"), "self-topic prompt still enforces spec-only answers");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
