/** Replicate the app's exact callGlm() shapes for glm-5.3-flash vs default,
 * to find why in-app glm-5.3-flash fails while the CLI succeeds. */
import ZAI from "z-ai-web-dev-sdk";

const zai = await ZAI.create();
const messages = [
  { role: "user", content: "In one sentence: what does IFRS 9 require about forward-looking information in ECL?" },
];

async function tryOne(name, body) {
  const t0 = Date.now();
  try {
    const out = (await Promise.race([
      zai.chat.completions.create({ messages, ...body }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 60s")), 60_000)),
    ]));
    const msg = out?.choices?.[0]?.message ?? {};
    const content = msg?.content ?? "";
    const reasoning = msg?.reasoning_content || msg?.reasoning || "";
    console.log(
      `[${name}] ${Date.now() - t0}ms OK — served model=${out?.model} content.len=${content.length} reasoning.len=${String(reasoning).length} | content: ${JSON.stringify(content.slice(0, 140))}`
    );
    if (!content.trim() && reasoning) console.log(`   ^ EMPTY CONTENT, reasoning instead: ${JSON.stringify(String(reasoning).slice(0, 140))}`);
  } catch (e) {
    console.log(`[${name}] ${Date.now() - t0}ms FAIL — ${e instanceof Error ? e.message : String(e)}`);
  }
}

await tryOne("5.3 + thinking disabled (app shape)", { model: "glm-5.3-flash", thinking: { type: "disabled" } });
await tryOne("5.3 + thinking enabled", { model: "glm-5.3-flash", thinking: { type: "enabled" } });
await tryOne("5.3 + no thinking field", { model: "glm-5.3-flash" });
await tryOne("5.3 + disabled + max_tokens 2000 (app draft shape)", { model: "glm-5.3-flash", thinking: { type: "disabled" }, max_tokens: 2000 });
await tryOne("default (no model) + disabled", { thinking: { type: "disabled" } });
await tryOne("glm-4.5-flash + disabled", { model: "glm-4.5-flash", thinking: { type: "disabled" } });
