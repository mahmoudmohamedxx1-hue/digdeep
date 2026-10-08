/** Routing sanity tests — chat heuristics must catch meta/casual messages,
 *  and must NOT catch real research questions. Run: bun scripts/test-routing.ts */
import { heuristicChatIntent } from "../src/lib/research/intent-heuristics";

const cases: { q: string; want: "chat" | null }[] = [
  // ---- must be CHAT (the user's complaint) ----
  { q: "what you can do", want: "chat" },
  { q: "WHAT YOU CAN DO", want: "chat" },
  { q: "what can you do", want: "chat" },
  { q: "what can you do for me?", want: "chat" },
  { q: "tell me what you can do", want: "chat" },
  { q: "what do you do", want: "chat" },
  { q: "tell me about yourself", want: "chat" },
  { q: "who are you?", want: "chat" },
  { q: "how do you work?", want: "chat" },
  { q: "what is this?", want: "chat" },
  { q: "is this free?", want: "chat" },
  { q: "do i need an api key?", want: "chat" },
  { q: "what models do you use?", want: "chat" },
  { q: "hii", want: "chat" },
  { q: "thanks", want: "chat" },
  { q: "how are you", want: "chat" },
  { q: "ok cool", want: "chat" },
  { q: "help", want: "chat" },
  { q: "what are your modes?", want: "chat" },
  { q: "who made you", want: "chat" },
  { q: "hey, how do you work?", want: "chat" },
  { q: "so what can you do for me", want: "chat" },
  { q: "ok tell me about yourself", want: "chat" },
  // ---- must be CHAT: capability questions with NO topic (router v3 — the exact complaint) ----
  { q: "can you make a deep research", want: "chat" },
  { q: "CAN YOU MAKE A DEEP RESEARCH", want: "chat" },
  { q: "can you make a deep research?", want: "chat" },
  { q: "can you make a deep research for me?", want: "chat" },
  { q: "can you do deep research", want: "chat" },
  { q: "can you do a deep research", want: "chat" },
  { q: "can you research?", want: "chat" },
  { q: "can you run a research", want: "chat" },
  { q: "can you conduct deep research?", want: "chat" },
  { q: "can you perform a full investigation", want: "chat" },
  { q: "are you able to do a deep research", want: "chat" },
  { q: "do you do deep research?", want: "chat" },
  { q: "do you support deep research", want: "chat" },
  { q: "i want you to do a deep research", want: "chat" },
  { q: "make me a deep research", want: "chat" },
  { q: "do a research", want: "chat" },
  { q: "so can you make a deep research please", want: "chat" },
  { q: "how long does a deep research take", want: "chat" },
  // ---- must NOT be chat (real research/quick questions, even with "you" in them) ----
  { q: "hi what is the capital of france", want: null },
  { q: "hey can you compare react vs vue for large apps", want: null },
  { q: "so how are we going to fix climate change", want: null },
  { q: "please explain how CRISPR gene editing works", want: null },
  { q: "can you compare rtx 5090 vs 5080 for deep learning workloads", want: null },
  { q: "can you research the best electric cars of 2026", want: null },
  { q: "find me the best restaurants in cairo", want: null },
  { q: "what is the capital of france", want: null },
  { q: "how do quantum computers work", want: null },
  { q: "what programming languages does google use in production", want: null },
  { q: "give me a research report on solar panel efficiency trends", want: null },
  { q: "what do doctors say about intermittent fasting", want: null },
  { q: "how does photosynthesis work in plants", want: null },
  { q: "what are the side effects of metformin", want: null },
  // ---- must NOT be chat: capability PHRASING but WITH a real topic → research ----
  { q: "can you make a deep research about ai trends", want: null },
  { q: "can you make a deep research on quantum computing", want: null },
  { q: "do a deep research on quantum computing", want: null },
  { q: "make me a research report about renewable energy", want: null },
  { q: "can you research the history of ancient egypt", want: null },
  { q: "i want you to research the solar energy market", want: null },
  { q: "research the best evs of 2026", want: null },
];

let fails = 0;
for (const { q, want } of cases) {
  const got = heuristicChatIntent(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got ?? "(classifier)"}  (want ${want ?? "(classifier)"})`);
}
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
