/** Routing sanity tests — chat heuristics must catch meta/casual messages,
 *  and must NOT catch real research questions. Run: bun scripts/test-routing.ts */
import { heuristicChatIntent, selfKnowledgeTopic, needsLiveFacts } from "../src/lib/research/intent-heuristics";

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
  // ---- must be CHAT: self-knowledge questions — the exact conversation that failed ----
  { q: "how do you make deep research", want: "chat" },
  { q: "how do you make a deep research", want: "chat" },
  { q: "how do you do deep research", want: "chat" },
  { q: "what engines you have and what is the full technical process", want: "chat" },
  { q: "iam asking about search engines you got", want: "chat" },
  { q: "i mean like brave and those engine not the ai model", want: "chat" },
  { q: "what search engines do you use", want: "chat" },
  { q: "which engines does digdeep use", want: "chat" },
  { q: "what engines do you have", want: "chat" },
  { q: "how many search engines do you have", want: "chat" },
  { q: "how does your research process work", want: "chat" },
  { q: "what is the full technical process", want: "chat" },
  { q: "explain your pipeline", want: "chat" },
  { q: "walk me through your process", want: "chat" },
  { q: "how does your pipeline work", want: "chat" },
  { q: "explain how you do research", want: "chat" },
  { q: "how does deep research work", want: "chat" },
  { q: "where do you get your information", want: "chat" },
  { q: "what sources do you search", want: "chat" },
  { q: "what models do you use", want: "chat" },
  { q: "what llms are you running", want: "chat" },
  { q: "no i mean your search engines not the ai model", want: "chat" },
  // ---- must NOT be chat: general questions that merely MENTION engines/models/search ----
  { q: "how do search engines make money", want: null },
  { q: "which search engine is the most private", want: null },
  { q: "brave vs duckduckgo which is better", want: null },
  { q: "how many search engines are there in the world", want: null },
  { q: "what engine does a tesla use", want: null },
  { q: "how do you make bread", want: null },
  { q: "what is the technical process of making steel", want: null },
  { q: "what is the difference between a search engine and an ai model", want: null },
  { q: "how do you make deep research on quantum computing", want: null },
  { q: "which language models are best for arabic", want: null },
  { q: "what database does instagram use", want: null },
];

let fails = 0;
for (const { q, want } of cases) {
  const got = heuristicChatIntent(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got ?? "(classifier)"}  (want ${want ?? "(classifier)"})`);
}

// ---- self-knowledge topic detection: which grounded spec the answer is built from ----
const topics: { q: string; want: string | null }[] = [
  { q: "what engines you have and what is the full technical process", want: "engines" },
  { q: "iam asking about search engines you got", want: "engines" },
  { q: "i mean like brave and those engine not the ai model", want: "engines" },
  { q: "what search engines do you use", want: "engines" },
  { q: "how do you make deep research", want: "process" },
  { q: "what is the full technical process", want: "process" },
  { q: "how does your research process work", want: "process" },
  { q: "walk me through your process", want: "process" },
  { q: "what models do you use", want: "models" },
  { q: "no i mean your search engines not the ai model", want: "engines" },
  { q: "where do you get your information", want: "sources" },
  { q: "what can you do", want: "capabilities" },
  { q: "who are you", want: "capabilities" },
  { q: "how do search engines make money", want: null },
  { q: "brave vs duckduckgo which is better", want: null },
  { q: "how do you make bread", want: null },
  { q: "what is the technical process of making steel", want: null },
  { q: "what is the capital of france", want: null },
];
console.log("\n--- self-knowledge topics ---");
for (const { q, want } of topics) {
  const got = selfKnowledgeTopic(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got ?? "(not self)"}  (want ${want ?? "(not self)"})`);
}

// ---- follow-up detection (v2.7 conversation continuity): does the message
// only make sense inside a thread? true → the resolver call is worth making ----
import { followUpishHeuristic } from "../src/lib/research/intent-heuristics";
const followUps: { q: string; want: boolean }[] = [
  // the exact complaint: a follow-up that became a stray 40-minute trial
  { q: "what is the court opinion", want: true },
  { q: "what is the court's opinion", want: true },
  { q: "and france?", want: true },
  { q: "what about france", want: true },
  { q: "why", want: true },
  { q: "go deeper on the second one", want: true },
  { q: "tell me more about that", want: true },
  { q: "do the same for turkey", want: true },
  { q: "and the verdict?", want: true },
  { q: "which sources did you use", want: true },
  { q: "explain it again", want: true },
  // standalone topics — the resolver must NOT fire (echo-unchanged path skipped)
  { q: "make deep research about how the big 5 make the forward looking factor to help them in the ecl report", want: false },
  { q: "what is quantum computing", want: false }, // standalone — researches as written, no resolver call
  { q: "compare the economic policies of egypt and turkey in the last decade", want: false },
  { q: "latest developments in quantum computing 2026", want: false },
  { q: "how do electric car batteries work", want: false },
  { q: "hi", want: false }, // greetings never reach the resolver (chat lane catches them first)
  { q: "thanks", want: false },
];
console.log("\n--- follow-up detection (gate for the resolver) ---");
for (const { q, want } of followUps) {
  const got = followUpishHeuristic(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got}  (want ${want})`);
}

// ---- v2.9 court routing: chatting with the gavel up must stay chatting ----
// worthiness: with court ON, is a message a claim (→ trial), an info/conversation
// request (→ normal lanes, never a trial), or ambiguous (→ court-aware classifier)?
import { courtMetaQuestion, courtTrialWorthiness } from "../src/lib/research/intent-heuristics";
const worth: { q: string; want: "trial" | "info" | null }[] = [
  // ---- the complaint: simple chat with court ON must NOT go to trial ----
  { q: "what is 2+2", want: "info" },
  { q: "what is the capital of france", want: "info" },
  { q: "who is elon musk", want: "info" },
  { q: "tell me a joke", want: "info" },
  { q: "write me a poem about the sea", want: "info" },
  { q: "what time is it", want: "info" },
  { q: "translate hello to french", want: "info" },
  { q: "how do i screenshot on windows", want: "info" },
  { q: "tell me about quantum computing", want: "info" },
  { q: "explain how photosynthesis works", want: "info" },
  { q: "how does bitcoin work", want: "info" },
  { q: "what is python programming language", want: "info" },
  { q: "recommend me a good laptop", want: "info" },
  { q: "is it going to rain today", want: "info" }, // here-and-now, not a claim (falls to classifier)
  { q: "is this app free", want: null }, // addressed to the assistant — classifier decides
  { q: "can you tell me about ancient rome", want: "info" },
  { q: "do you know what time it is", want: "info" },
  { q: "summarize the article i sent", want: "info" },
  // ---- real claims DO go to trial with the gavel up ----
  { q: "is minimax m2.7 better than deepseek v4", want: "trial" },
  { q: "is it true that the earth is flat", want: "trial" },
  { q: "do you think ai will replace programmers", want: "trial" },
  { q: "quantum computing is overhyped", want: "trial" },
  { q: "react vs vue for large apps", want: "trial" },
  { q: "which is better for beginners python or rust", want: "trial" },
  { q: "should social media be banned for kids", want: "trial" },
  { q: "prove that the great pyramid was built by paid workers", want: "trial" },
  { q: "i think electric cars are worse for the environment", want: "trial" },
  { q: "my friend says fasting is bad for you what do you think", want: "trial" },
  { q: "everyone knows apple is a scam", want: "trial" },
  { q: "does the keto diet actually work", want: "trial" },
  { q: "is nuclear energy the future", want: "trial" },
  { q: "are we alone in the universe", want: "trial" },
  { q: "cold showers are overrated", want: "trial" },
  // ---- v3.0 comparative ASSERTIONS — "more/less ADJ than", "ADJ-er than",
  // "X makes Y more Z" are head-to-head claims → trial; info asks stay info ----
  { q: "remote work makes software teams more productive than office work", want: "trial" },
  { q: "python is more popular than javascript", want: "trial" },
  { q: "electric cars are safer than gas cars", want: "trial" },
  { q: "ai coding tools make developers faster", want: "trial" },
  { q: "nuclear power is less expensive than solar", want: "trial" },
  { q: "how do i make my site faster than wordpress", want: "info" }, // how-to ask, not a proposition
  { q: "what is faster than light", want: "info" }, // lookup, not a claim
  { q: "i want to know if python is faster than java", want: "info" }, // info opener dominates
  // ---- ambiguous → the court-aware classifier decides ----
  { q: "the earth is flat", want: null }, // statement asserting a claim — classifier reads it
  { q: "artificial intelligence", want: null },
  { q: "bitcoin", want: null },
];
console.log("\n--- v2.9 court trial-worthiness (gavel up: claim vs chat) ---");
for (const { q, want } of worth) {
  const got = courtTrialWorthiness(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got ?? "(classifier)"}  (want ${want ?? "(classifier)"})`);
}

// ---- v2.9 verdict recall: questions ABOUT the trial that already ran ----
const meta: { q: string; want: boolean }[] = [
  // recall the verdict — never re-try a concluded case
  { q: "what is the court opinion", want: true },
  { q: "what is the court's opinion", want: true },
  { q: "what was the court's verdict", want: true },
  { q: "what did the jury say", want: true },
  { q: "why did the judge rule guilty", want: true },
  { q: "what was the verdict", want: true },
  { q: "summarize the trial", want: true },
  { q: "explain the verdict", want: true },
  { q: "what did the jurors vote", want: true },
  { q: "show me the judge's summary", want: true },
  // real-world courts and trials with their own topic — NOT our trial
  { q: "what is the supreme court opinion on abortion", want: false },
  { q: "what did the international court say about the war", want: false },
  { q: "summarize the trial of socrates", want: false },
  { q: "how did the defense play in the match yesterday", want: false },
  { q: "what did the jury say about the chauvin trial outcome", want: false }, // long, own topic
  // claims about the world that merely mention trials/judges
  { q: "is the jury system fair", want: false }, // worthiness: trial (a claim) — meta must not catch it
  { q: "are judges biased against defendants", want: false },
];
console.log("\n--- v2.9 court meta questions (verdict recall gate) ---");
for (const { q, want } of meta) {
  const got = courtMetaQuestion(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got}  (want ${want})`);
}

// ---- v3.11 needsLiveFacts — when does the CHAT lane run a live-web pass? ----
const live: { q: string; want: boolean }[] = [
  // must TRIGGER the web pass (current facts, explicitly time-sensitive)
  { q: "btw what's the price of bitcoin right now?", want: true },
  { q: "what's the weather in cairo today?", want: true },
  { q: "who won the match yesterday?", want: true },
  { q: "any news on the openai thing?", want: true },
  { q: "what's the latest version of node?", want: true },
  { q: "hey, can you look up the exchange rate for me?", want: true },
  { q: "google it: who is the current ceo of twitter", want: true },
  { q: "what are the best laptops 2026?", want: true },
  { q: "is twitter still called x?", want: true },
  { q: "what's happening in the world right now", want: true },
  { q: "any update on the gaza ceasefire?", want: true },
  // must NOT trigger (pure conversation / self-knowledge / timeless chat)
  { q: "how are you today?", want: false },
  { q: "hey, how are you doing?", want: false },
  { q: "thanks, that was helpful", want: false },
  { q: "what can you do?", want: false },
  { q: "who made you?", want: false },
  { q: "what engines do you use?", want: false },
  { q: "can you make a deep research?", want: false },
  { q: "tell me about yourself", want: false },
  { q: "i was born in 1999", want: false },
  { q: "that answer was right", want: false },
  { q: "are you still free to use?", want: false },
];
console.log("\n--- v3.11 needsLiveFacts (chat-lane web-pass trigger) ---");
for (const { q, want } of live) {
  const got = needsLiveFacts(q);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(q)}  →  ${got}  (want ${want})`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
