/**
 * Zero-LLM intent heuristics — shared by the engine and tests.
 * Matches obvious conversation (greetings, thanks, small talk, capability/meta
 * questions). Returns "chat" when the message clearly needs no research;
 * null = needs the LLM classifier.
 */

/** Shared message normalizer: lowercase, strip emoji/punctuation, collapse
 *  whitespace, then strip repeatable conversational wrappers ("so ok hey …"). */
function normalize(raw: string): string {
  let s = raw
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  for (let i = 0; i < 4; i++) {
    const stripped = s
      .replace(/^(so|ok|okay|k|well|hey|hi|hello|yo|hmm+|um+|please|pls|and|but|just|actually|really|btw|by the way) /, "")
      .replace(/( please| pls| man| bro| dude| mate| buddy| thanks| thank you| thx| lol| haha+| now| really)$/, "")
      .trim();
    if (stripped === s) break;
    s = stripped;
  }
  return s;
}

/** What the question is really about, when it is a question about DigDeep ITSELF.
 *  Used to (a) route self-machinery questions to chat — answering them with web
 *  research would be absurd — and (b) pick which part of the grounded
 *  SELF_KNOWLEDGE spec the answer must be built from. null = not about DigDeep. */
export type SelfTopic = "engines" | "process" | "models" | "sources" | "capabilities";

/**
 * Detects questions about DigDeep's own machinery — search engines, technical
 * process, models, data sources — including the frustrated corrections users
 * send when a previous answer missed ("i mean like brave and those engine not
 * the ai model", "iam asking about search engines you got"). These MUST be
 * answered from DigDeep's own configuration, never researched on the web and
 * never improvised by the model.
 *
 * Anchoring discipline: patterns either reference the second person (you/your)
 * or DigDeep by name, or have a distinctive correction shape — so real research
 * questions ("which search engine is the most private", "brave vs duckduckgo")
 * never match.
 */
export function selfKnowledgeTopic(raw: string): SelfTopic | null {
  const s = normalize(raw);
  if (!s) return null;
  const patterns: [RegExp, SelfTopic][] = [
    // ---- engines ----
    [/(what|which|how many) (search |web )?engines (do|does|did|can|would|will|have|has|are|is) (you|u|it|this|that|digdeep)\b/, "engines"],
    [/(what|which|how many) (search |web )?engines? (you|u) (have|has|got|use|used|run|running)\b/, "engines"],
    [/engines? (that |which )?(you|u) (got|have|has|use|used|run|search|employ)/, "engines"],
    [/what (search )?engines (are|is) (in|inside|under the hood|behind)\b/, "engines"],
    // ---- sources / where does information come from ----
    [/(what|which) (sources|sites|websites|databases|places|verticals) (do|does|can|would) (you|u|it|this|digdeep)\b/, "sources"],
    [/where do (you|u) (search|look|get|find|fetch|pull)\b/, "sources"],
    // ---- process / how a run actually works ----
    [new RegExp(
      `^how (do|does) (you|u) (make|do|run|perform|conduct|carry out|handle|build|write) (a |an |any |your |this )?` +
      `(deep |web |online |full |proper |serious |thorough |real |quick |good |complete |autonomous )?` +
      `(research|researches|search|searches|investigation|investigations|analysis|analyses|report|reports|dig|digs)` +
      `( for me| for real| seriously| right now| today| as well| too| also)?\\s*[?.!]*$`
    ), "process"],
    [/^how (do|does) (a |an |this |your )?(deep |web )?(research|dig) work\s*[?.!]*$/, "process"],
    [/^how (does|do) (your|ur) (research|search|technical|full|whole|entire|report|deep research) (process|pipeline|workflow|methodology|method|engines?)\b/, "process"],
    [/^explain (how|your) (you |u )?(do|make|run|perform|conduct|work|research|process|pipeline)/, "process"],
    [/(walk me through|tell me about|describe) (your|the) (full |complete |whole |entire |research |technical )?(process|pipeline|workflow|methodology|steps|stages)\b/, "process"],
    [/(your|ur|digdeep|this (app|tool|site|assistant|thing|product))'?s? (full |complete |whole |entire |exact |actual |real )?(technical )?(process|pipeline|workflow|methodology|stages?|steps?)\b/, "process"],
    [/^(what|explain|describe|tell me about) (is )?(the )?(full |complete |entire |whole )?technical process( of (yours|you|digdeep|this|it|the app|this app))?\s*[?.!]*$/, "process"],
    // ---- models / backends ----
    [/what (models?|llms?|ais?|backends?) (do|does|are|can|would|will|have|has) (you|u|it|this|that|digdeep)\b/, "models"],
    [/what (models?|llms?|ais?|backends?) (you|u) (have|got|use|used|run|running)\b/, "models"],
    // ---- corrections: the user is telling us the previous answer missed ----
    [/i (mean|meant|am asking|m asking|was asking|said|want)[^.!?]{0,60}\b(those|these|that'?s|your|the actual|the real)\b[^.!?]{0,30}\b(engines?|search engines?)\b/, "engines"],
    [/\b(engines?|search engines?)\b[^.!?]{0,50}\b(not|instead of|rather than|no|never)\b[^.!?]{0,25}\b(ai|llm|model|models|gpt|glm|chatgpt)\b/, "engines"],
    [/\b(not|no)\b[^.!?]{0,15}\bthe (ai|llm|language )?models?\b[^.!?]{0,40}\b(engines?|search)\b/, "engines"],
    [/i (mean|meant)[^.!?]{0,60}\b(models?|llm|ai)\b[^.!?]{0,40}\byou\b/, "models"],
    // ---- identity / capabilities ----
    [/what (can|could|do|does) (you|u) (do|offer|provide|help with)/, "capabilities"],
    [/what (you|u) (can|could) do/, "capabilities"],
    [/tell me (more )?about (yourself|you)\s*$/, "capabilities"],
    [/^(who|what) (are|r) (you|u)\b/, "capabilities"],
    [/how (do|does) (you|u|this|it|digdeep) work/, "capabilities"],
    [/^what is this( app| tool| thing| website| page)?\s*[?.!]*$/, "capabilities"],
    [/^is (this|it|digdeep) (free|really free)\b/, "capabilities"],
    [/do (you|u|i) need (an? )?(api )?key/, "capabilities"],
  ];
  for (const [p, topic] of patterns) if (p.test(s)) return topic;
  return null;
}

/**
 * Capability questions about DigDeep's own abilities, phrased with NO topic —
 * "can you make a deep research?", "do you do deep research?", "i want you to
 * do a deep research". The user is asking WHETHER the assistant can do it, so
 * the right response is an instant "yes — give me a topic", NEVER launching a
 * research run on the literal words.
 *
 * Strictly anchored and topic-free: as soon as a real topic follows
 * ("can you research electric cars", "do a deep research on quantum computing")
 * these MUST NOT match — that is a genuine research request.
 */
export function capabilityQuestion(raw: string): boolean {
  const s = normalize(raw);
  if (!s) return true;
  const MOD = "(deep |web |online |full |proper |serious |thorough |real |quick |good |long )?";
  const THING = "(research|researches|search|searches|searching|reports?|investigations?|investigating|analysis|analyses|digging|dig)";
  const VERB = "(do|make|perform|conduct|run|carry out|handle|manage|generate|write|create|produce)";
  const FOR = "( for me| for real| seriously| right now| today| as well| too| also| by yourself| on your own)?";
  const patterns: RegExp[] = [
    // "can you make a deep research?" / "can you do research?" / "can you run a full investigation for me?"
    new RegExp(`^can (you|u) ${VERB} (a |an |any |some |one )?${MOD}${THING}${FOR}\\s*[?.!]*$`),
    // "are you able to do a deep research?"
    new RegExp(`^are (you|u) able to ${VERB} (a |an |any |some |one )?${MOD}${THING}${FOR}\\s*[?.!]*$`),
    // "do you do deep research?" / "do you support deep research?" / "does this do research?"
    new RegExp(`^do (you|u|this|it|digdeep) (do|offer|support|provide|have|make|do any) ${MOD}${THING}${FOR}\\s*[?.!]*$`),
    // bare verb, no object at all: "can you research?" / "can you dig?"
    /^can (you|u) (research|search|investigate|dig|analy[sz]e|look things up)[?.!]*$/,
    // "i want you to do a deep research" (no topic → the answer is "yes — on what?")
    new RegExp(`^(i want|i'd like|i would like) (you|u) to ${VERB} (a |an |any |some |one )?${MOD}${THING}${FOR}\\s*[?.!]*$`),
    // imperative with no topic: "make me a deep research" / "do a research"
    new RegExp(`^${VERB} (me )?(a |an |any |some |one )?${MOD}${THING}${FOR}\\s*[?.!]*$`),
    // "how long does a deep research take?" — about DigDeep's own process
    /^(how long|how much time) (does|do|would|will) (a |an |this |your |your )?(deep )?research take/,
  ];
  return patterns.some((p) => p.test(s));
}

export function heuristicChatIntent(raw: string): "chat" | null {
  const s = normalize(raw);
  if (!s) return "chat";
  const patterns: RegExp[] = [
    /^(hi+|hey+|hello+|yo+|sup|hiya|hy+|hola|salut|bonjour|merhaba)$/,
    /^(marhaba|ahlan|salam|as?salamu? alaikum|assalamualaikum|صباح الخير|مرحبا|اهلا|اهلين|السلام عليكم)$/u,
    /^(good (morning|afternoon|evening|day|night)|صباح الخير|مساء الخير)$/u,
    /^(thanks+|thank you|thank u|thx+|ty|tyvm|much appreciated|shukran|shokran|merci|gracias|شكرا|شكرا لك)$/u,
    /^(how are (you|u|y all)|how's it going|hows it going|what'?s up|whats up|wassup|wyd|how you doing|كيف حالك|كيف الحال)$/u,
    // identity — second person only unanchored (distinctive enough)
    /who (are|r) (you|u)\b/,
    /^who (made|created|built|trained) you$/,
    // capability / identity / meta questions — NEVER research these, regardless of selected mode.
    // Unanchored but highly distinctive phrases; requests like "can you compare X and Y" must NOT match.
    /what (can|could|do|does) (you|u) (do|offer|provide)/,
    /what (you|u) (can|could) do/,
    // "what can you help me with (today)?" / "how can you help?" — capability questions that
    // end there. Strictly anchored so "can you help me compare X and Y" still researches.
    /^(what|how) (can|could|do|does) (you|u) help( (me|us))?( with)?( today| now| here| please)?\s*[?.!]*$/,
    /tell me (more )?about (yourself|you)\s*$/,
    /(your|ur) (features|capabilities|skills|modes|options|settings|limits)/,
    /how (do|does) (you|u) work/,
    /^how (do|does) (this|it|digdeep) work/,
    /^what is this( app| tool| thing| website| page| all about)?\s*[?.!]*$/,
    /^(what can i (do|ask|use) (here|you|with you)|what should i (ask|do|research))\s*[?.!]*$/,
    /^(how do i (use|start|begin|ask))\b/,
    /^is (this|it|digdeep) (free|really free)\b/,
    /do (you|u|i) need (an? )?(api )?key/,
    /what models? (do|does|are) (you|u|this|it|digdeep)/,
    /^(help|help me|can you help( me)?|i need help|assist me)$/u,
    /^(are you (an? )?(ai|bot|robot|human|real|chatgpt|claude|perplexity|gemini|free)|من انت|ما اسمك)$/u,
    // casual acks and their combinations ("ok cool", "nice nice", "ok thanks")
    /^(ok+|okay|k|cool|nice|great|awesome|good|fine|perfect|lol|lmao|haha+|hehe+|brb|bye|goodbye|good bye|see (ya|you)|cya|gn|later|تمام|اوك)([ ,!]+(ok+|okay|k|cool|nice|great|awesome|good|fine|perfect|lol|lmao|thanks+|thank you|ty))*$/u,
    /^(test|testing|ping|hi\?|hello\?|anyone there|are you there|you there)$/u,
    /^(i (love|like|hat(e|ing)) this|this is (cool|great|awesome|amazing|nice|slow|fast)|good (job|work|bot)|well done|nice work)$/u,
  ];
  if (patterns.some((p) => p.test(s))) return "chat";
  // "can you make a deep research?" — a topic-free ask about my own abilities: answer, never research
  if (capabilityQuestion(raw)) return "chat";
  // "what engines you have" / "how do you make deep research" / "i mean the engines
  // not the ai model" — questions about DigDeep's own machinery: answer from the
  // grounded self-knowledge spec, never research the literal words on the web
  if (selfKnowledgeTopic(raw)) return "chat";
  return null;
}
