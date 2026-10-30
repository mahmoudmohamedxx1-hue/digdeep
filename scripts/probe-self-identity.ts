/** Live self-identity probe — sends the REAL CHAT_SYS to a real keyless
 *  backend and asks the questions that used to break identity ("which model
 *  are you", "are you ChatGPT", "who made you"). No db import: direct fetch.
 *  Run: bun scripts/probe-self-identity.ts [model] */
import { CHAT_SYS } from "../src/lib/research/prompts";
import { chatPrompt } from "../src/lib/research/prompts";

const MODEL = process.argv[2] || "mistral-Nemo-Instruct-2407"; // pass "openai" for the pollinations lane
const MODEL_URLS: Record<string, string> = {
  llm7: "https://api.llm7.io/v1/chat/completions",
  pollinations: "https://text.pollinations.ai/openai",
};
const URL = MODEL_URLS[process.argv[3] ?? "llm7"] ?? "https://api.llm7.io/v1/chat/completions";

// some backends reject system roles — mirror the engine's fold behavior
function foldSystemIntoUser(sys: string, user: string): { role: string; content: string }[] {
  return [{ role: "user", content: `${sys}\n\n---\n\n${user}` }];
}

const QUESTIONS = [
  "hey, which model are you exactly? are you chatgpt?",
  "who made you? are you affiliated with openai or anthropic?",
  "what can you do? can you browse the web right now?",
];

async function ask(q: string): Promise<string> {
  const user = chatPrompt(q, "");
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: foldSystemIntoUser(CHAT_SYS, user),
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

console.log(`Probing model: ${MODEL}\n`);
let leaks = 0;
for (let i = 0; i < QUESTIONS.length; i++) {
  const q = QUESTIONS[i];
  if (i > 0) await new Promise((r) => setTimeout(r, 32_000)); // pollinations free lane: 1 reply / 30s per IP
  console.log(`── Q: ${q}`);
  try {
    const a = await ask(q);
    console.log(a.slice(0, 600).replace(/\n+/g, "\n") + "\n");
    const bad = /I am (an? )?(ChatGPT|GPT|Claude|Gemini|Grok|Mistral|MiniMax|DeepSeek)|I'?m (ChatGPT|Claude|Gemini|Grok)|made by (OpenAI|Anthropic|Google|Mistral AI|Z\.ai)|affiliated with (OpenAI|Anthropic|Google)/i.test(a);
    const good = /DigDeep/i.test(a);
    if (bad || !good) {
      leaks++;
      console.log(`   ⚠ IDENTITY CHECK: ${!good ? "did not identify as DigDeep" : ""}${bad ? " + leaked base identity" : ""}\n`);
    } else {
      console.log(`   ✓ identifies as DigDeep, no base-model leak\n`);
    }
  } catch (e) {
    leaks++;
    console.log(`   ✗ probe error: ${e instanceof Error ? e.message : e}\n`);
  }
}
console.log(leaks === 0 ? "RESULT: clean — model answers as DigDeep" : `RESULT: ${leaks}/${QUESTIONS.length} identity problems`);
process.exit(leaks ? 1 : 0);
