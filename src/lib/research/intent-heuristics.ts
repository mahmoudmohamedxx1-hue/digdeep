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

/**
 * Does this message look like a FOLLOW-UP that only makes sense inside an
 * ongoing conversation — pronouns ("it", "that"), ellipsis ("what about
 * France?"), references to earlier turns ("the second one", "go deeper"),
 * short questions with no topic of their own ("what is the court opinion")?
 *
 * Zero-LLM gate for the resolver: when true AND the thread has earlier turns,
 * one cheap model call rewrites the message into a self-contained question.
 * False negatives are fine (the message researches as written); false
 * positives only cost one small call — but real standalone topics ("what is
 * quantum computing") should not match, so the patterns stay tight.
 */
export function followUpishHeuristic(raw: string): boolean {
  const s = normalize(raw);
  if (!s) return false;
  const words = s.split(/\s+/).filter(Boolean);
  // very short messages with no topic of their own — "why", "sources?", "and egypt?"
  if (words.length <= 3 && !/^(hi+|hey+|hello+|yo+|sup|thanks+|thank you|ok+|okay|k|cool|nice|great|good|bye|test|ping)$/.test(s)) return true;
  // bare pronouns (it/that/this/they…) only in SHORT messages: a long message
  // that contains "them" usually resolves its own pronouns inside the sentence
  // ("…how the big 5 make the forward looking factor to help them in the ecl report"
  // is self-contained and must NOT trip the gate)
  if (words.length <= 12 && /\b(it|that|this|these|those|they|them|their)\b/.test(s)) return true;
  // strong thread-deixis at ANY length — these point outside the message itself
  if (/\b(the same|the above|the previous|the last one|the other one|the first one|the second|the third)\b/.test(s)) return true;
  // classic follow-up openers
  if (/^(what|how) about\b/.test(s)) return true;
  if (/^(and|but|also|plus|then)\b/.test(s) && words.length <= 10) return true;
  if (/^(why|how so|how come|since when|says who|according to whom|like what|such as|for example)\b/.test(s) && words.length <= 8) return true;
  if (/^(go|dig|goes|digs) deeper|dig into (that|this|it)|tell me more|expand (on|that|this)|elaborate|more (on|about|detail)|continue|keep going|and the rest\b/.test(s)) return true;
  if (/^(do the same|same for|what about the|how about the)\b/.test(s)) return true;
  // meta questions about the previous answer
  if (/\b(what did you mean|what do you mean|clarify|your sources|which sources|cite|citation|the court opinion|court s opinion|your verdict|the verdict|the jury|the judge)\b/.test(s)) return true;
  return false;
}

/* ==================================================================
 *  COURT MODE ROUTING (v2.9) — "chatting with the gavel up"
 *  Court mode ON must never mean "every message becomes a trial".
 *  Only genuine claims / propositions / debatable questions go to
 *  court; conversation, simple lookups and info requests keep the
 *  normal lanes, and questions ABOUT a trial that already ran get
 *  its verdict recalled instead of re-trying a concluded case.
 * ================================================================== */

/** Real-world courts/cases that must never be mistaken for DigDeep's own trial. */
const REAL_WORLD_COURT =
  /(supreme|international|criminal|civil|family|federal|district|high|constitutional|european|world|local|municipal|appeals?|small claims|sharia|juvenile|labor|labour|tax|military|state|county|provincial|national)\s+courts?\b/;

/**
 * Is this message asking ABOUT the trial DigDeep ran (its verdict, the jury's
 * votes, the judge's reasoning) rather than putting a new proposition on trial?
 * "what is the court opinion", "what did the jury say", "why did the judge rule
 * guilty", "summarize the trial" — a concluded case is never re-tried just
 * because you asked what the judge said.
 *
 * Deliberately conservative: short (≤9 words), question-shaped, and only
 * DigDeep's distinctive trial machinery (court/verdict/jury/judge/gavel).
 * Real-world courts ("supreme court opinion on X", "trial of socrates") and
 * longer messages with a topic of their own never match — those are real
 * questions and route normally. The engine only recalls when a court turn
 * actually exists in the thread.
 */
export function courtMetaQuestion(raw: string): boolean {
  const s = normalize(raw);
  if (!s) return false;
  // real-world courts/cases that must never be mistaken for DigDeep's own trial
  if (REAL_WORLD_COURT.test(s)) return false;
  // "the trial of socrates", "court in paris" — a real-world case, not our trial
  if (/\b(courts?|trials?)\s+(of|in|against|vs)\b/.test(s)) return false;
  // worldly CONCEPTS built from trial words — "the jury system", "jury duty",
  // "the jury is still out on X" — claims about the world, not our trial
  if (/\b(jury|judge|court|verdict|trial)s?\s+(system|systems|duty|duties|selection|process|reform|law|laws|precedent)\b/.test(s)) return false;
  if (/\bstill out\b/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 9) return false;
  // "the court's opinion/verdict/ruling", "the trial's outcome" (normalize turns
  // "court's" into "court s")
  if (/\b(court s|courts|court|trial s|trials|trial)\s+(opinion|verdict|view|ruling|decision|say|said|says|think|thinks|found|finding|findings|conclusion|concluded|summary|outcome|result)\b/.test(s)) return true;
  // "what was the verdict", "what did the jury say", "why did the judge rule guilty"
  if (
    /^(what|why|how|when|who|is|was|did|does|do|can|could|tell me|explain|summarize|summarise|show me|give me)\b/.test(s) &&
    /(\bverdict\b|\bthe jury\b|\bjurors?\b|\bthe judge\b|\bgavel\b|\bthe trials?\b)/.test(s)
  ) return true;
  return false;
}

/**
 * With court mode ON, is this message SHAPED like a claim / proposition /
 * debate (→ trial), an information or conversation request (→ never a trial),
 * or ambiguous (→ the court-aware classifier decides)?
 *
 * "trial" answers must be confident: the fast path skips the classifier
 * entirely, so a simple question misread as a claim would go straight to a
 * full trial. "info" answers only block the throttle-fallback from sending an
 * ambiguous-but-clearly-not-a-claim message to court; the classifier can still
 * route a genuinely debatable message to trial on its own read.
 */
export function courtTrialWorthiness(raw: string): "trial" | "info" | null {
  const s = normalize(raw);
  if (!s) return "info";
  const words = s.split(/\s+/).filter(Boolean);

  // ---- clear CLAIM / DEBATE shapes → trial ----
  // opinion solicitation
  if (/\b(do you (think|agree|believe|find)|in your opinion|what do you think)\b/.test(s)) return "trial";
  // truth-testing openers
  if (/^(is|are) (it|this|that) (true|right|fair|safe|legal|real|possible|correct|wise|smart)\b/.test(s)) return "trial";
  if (/^is it true that\b/.test(s)) return "trial";
  // argument verbs
  if (/^(prove|disprove|refute|defend|argue|debate|settle|adjudicate|make (the )?case)\b/.test(s)) return "trial";
  // first-person opinion statements
  if (/^(i (think|believe|feel|guess|reckon|bet|say)|in my opinion|imo|imho|honestly i|to be honest i|personally i)\b/.test(s)) return "trial";
  // hearsay / received claims
  if (/\b(everyone knows|everybody knows|people say|they say|my friend says|my friend thinks|experts say|scientists say|studies show|it is said)\b/.test(s)) return "trial";
  // charged claim vocabulary
  if (/\b(overrated|underrated|overhyped|underhyped|scam|hoax|conspiracy|myth|better (for|than)|worse (for|than)|superior to|inferior to|waste of|no future)\b/.test(s)) return "trial";
  // comparative ASSERTIONS — "X is more productive than Y", "X is faster than
  // Y", "X makes teams more productive than Y": head-to-head claims, trial-
  // shaped. Only when the message is not an info/how-to ask — "how do i make
  // my site faster than wordpress" is a lookup, not a proposition.
  const INFO_ASK = /^(what|whos|whose|when|where|why|how|which|tell|explain|teach|describe|define|write|make me|make a|create|generate|give|recommend|suggest|list|name|translate|calculate|solve|convert|summar|rewrite|reword|fix|improve|review|find|search|look|help|does anyone|do you know|i want|i need|curious|show)\b/.test(s);
  const comparative =
    /\b(more|less|fewer)\s+\w+(\s+\w+)?\s+than\b/.test(s) ||
    /\b(faster|slower|safer|riskier|cheaper|costlier|cleaner|greener|smarter|stronger|weaker|harder|easier|simpler|tougher|bigger|smaller|larger|older|newer|higher|lower|deeper|wider|busier|quieter|healthier|happier|richer|poorer|more secure|more reliable|more efficient|more effective|more productive|more popular|more dangerous|more sustainable)\s+than\b/.test(s) ||
    /\bmakes?\s+[\w\s]{0,30}\b(more|less|faster|slower|safer|riskier|cheaper|better|worse|stronger|weaker|harder|easier|smarter)\b/.test(s);
  if (comparative && !INFO_ASK) return "trial";
  // head-to-head comparisons
  if (words.length >= 3 && /(^|\s)(vs|versus)(\s|$)/.test(s)) return "trial";
  if (/^which is (better|worse|best|worst|safer|faster|smarter|cheaper|more|less)\b/.test(s)) return "trial";
  // prescriptive claims: "should we / should companies / must the government…"
  if (/\b(should|shouldnt|must|mustnt)\s+(we|i|you|they|people|anyone|the|it|this|companies|governments|schools|developers|kids|students|beginners|users)\b/.test(s)) return "trial";
  // "should X be banned/legal/taught…" and messages that OPEN with should/must
  // ("should i learn python or rust") — prescriptive asks, trial-shaped
  if (/\b(should|shouldn t|shouldnt|must|mustn t|mustnt)\s+[\w\s]{1,40}\bbe\s+(banned|legal|illegal|allowed|taught|regulated|stopped|built|adopted|trusted|cancelled|canceled|mandatory|free|paid|taxed|subsidized)\b/.test(s)) return "trial";
  if (/^(should|shouldn t|shouldnt|must|mustn t|mustnt)\b/.test(s)) return "trial";
  // grand assertions: "X is the future", "X is the past"
  if (/\bis (the|our|a) (future|past|present)\b/.test(s)) return "trial";
  // debatable aux-initial question with a real topic — but questions addressed
  // to the assistant itself ("is this app free", "are you sure") or about the
  // here-and-now (weather, time) are NOT claims; those fall through to null
  const aux = s.match(/^(is|are|was|were|will|would|could|can|does|do|did|has|have|had)\s+([^?]+)$/);
  if (aux) {
    const rest = aux[2].trim();
    const toAssistant = /^(you|u|this|that|it|digdeep|the app)\b/.test(rest);
    const hereNow = /\b(rain|weather|temperature|time|date|day|today|tonight|tomorrow|my (ip|location|city|battery|phone|wifi))\b/.test(rest);
    if (hereNow) return "info"; // the here-and-now is never a claim
    if (!toAssistant && rest.split(/\s+/).length >= 2) return "trial";
  }

  // ---- clear INFO / CONVERSATION shapes → never a trial ----
  if (/^(what|who|whos|whose|when|where|why|how many|how much|how old|how tall|how far|how long|how deep|what time|what year|which country|which city|which planet)\b/.test(s)) return "info";
  if (/^(tell me about|explain|teach me|describe|define|what is|what are|who is|who was|who were|how does|how do|how did|why does|why do|why did|how can i|how to|what do you know about)\b/.test(s)) return "info";
  if (/^(tell me a|write|make me|make a|make|create|generate|give me|recommend|suggest|list|name|translate|calculate|solve|convert|summarize|summarise|rewrite|reword|fix|improve|review|find me|find|search for|look up|help me|i want to know|i need to know|i am curious about|curious about|can you tell me|do you know|does anyone know)\b/.test(s)) return "info";
  // creative / entertainment asks
  if (/\b(joke|poem|poetry|story|song|lyrics|riddle|haiku|limerick|rap|meme)\b/.test(s)) return "info";
  return null; // ambiguous — the court-aware classifier decides
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

/** v3.11 — does a CHAT-lane message need live web facts?
 *
 *  The chat lane keeps its conversational shape, but when the message asks
 *  about something time-sensitive (a price, news, weather, who won, "latest…")
 *  or explicitly asks to look something up, the lane runs ONE bounded web pass
 *  (search + up to 3 reads) and grounds the reply in it — chat answers current
 *  questions with citations instead of "I cannot see the live web".
 *
 *  Precision beats recall here: a false positive costs a ~5s web pass, but a
 *  false trigger on pure small talk makes chat feel sluggish — so every
 *  pattern is anchored to genuinely time-sensitive language, and questions
 *  about DigDeep itself NEVER need the web (the grounded spec answers them).
 *  Both the normalized text AND the raw message are matched: normalize()
 *  strips a trailing "now", which would otherwise hide "right now". */
export function needsLiveFacts(raw: string): boolean {
  const s = normalize(raw);
  if (!s) return false;
  const rawLo = raw.toLowerCase();
  const hit = (re: RegExp) => re.test(s) || re.test(rawLo);
  // questions about DigDeep itself never need the web — the product spec answers them
  if (selfKnowledgeTopic(raw) || capabilityQuestion(raw)) return false;
  // explicit search asks — "search for X", "look it up", "google it", "fact check"
  if (hit(/\b(search (the web |the internet |online )?(for|up)|look (it|this|that|them|him|her|up)+ up|google (it|the|what|who|when|where|how|that)|fact ?check)\b/)) return true;
  // freshness markers — the answer changes with time
  if (hit(/\b(right now|as we speak|currently|at the moment|these days|nowadays|up to date|up-to-date|breaking|latest|newest|just (released|announced|dropped|came out|launched))\b/)) return true;
  // time-anchored factual nouns — "today's weather", "the match today", "news this week"
  if (hit(/\b(today|tonight|this (morning|afternoon|evening|week|month|year))('?s)? (weather|news|price|match|game|score|stock|headlines|deal|quote|episode|top|best)\b/)) return true;
  if (hit(/\b(weather|news|price|match|game|score|stock|headline|episode|version|release|poll) (today|tonight|now|this (week|month|year))\b/)) return true;
  // recent-event shapes — "who won", "what happened", "any news on", "any updates"
  if (hit(/\b(who (won|wins|leads|playing)|what happened|what s happening|any (news|updates?|word) (on|about)|any update|is it true that .* (just )?(happened|died|released|announced))\b/)) return true;
  // volatile facts — prices, rates, standings, dates, elections
  if (hit(/\b(price|prices|stock price|share price|exchange rate|market cap|net worth|weather|forecast|temperature|odds|release date|launch date|box office|election|exit poll|score|standings?|leaderboard)\b/)) return true;
  // year-qualified comparisons — "best laptops 2026" (bare years never fire)
  if (hit(/\b(best|top|new|newest|fastest|cheapest|most popular|flagship)\b[^.]*\b(20\d{2})\b|\b(20\d{2})\b[^.]*\b(best|top|new|newest|fastest|cheapest|most popular|flagship)\b/)) return true;
  // state-of-the-world checks — "is X still called Y", "is X down"
  if (hit(/\bstill (called|named|available|open|down|banned|legal|alive|out|the case|true)\b|\b(down|offline) right now\b/)) return true;
  return false;
}

/** v3.11 — clean a conversational message into the SEARCH QUERY for the chat
 *  lane's web pass. Mixed messages ("btw what's the weather in cairo right
 *  now?") must not be searched verbatim — the conversational wrappers poison
 *  the ranking (live-observed: "btw …weather…right now" surfaced SPACE-weather
 *  pages). Strips lead-ins and trailing politeness, keeps the question's own
 *  words (time words like "right now" stay — they signal freshness); falls
 *  back to the raw message when nothing recognizable remains. */
export function chatSearchQuery(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const stripped = s
      .replace(/^(hey|hi|hello|yo|ok|okay|so|well|hmm+|um+|btw|by the way|quick (one|question)|sorry|please|pls|and|but|just|actually|really)[,!?.\s]+/i, "")
      .trim();
    if (stripped === s) break;
    s = stripped;
  }
  s = s.replace(/[\s,]*(please|pls|thanks|thank you|thx|man|bro|dude|mate|buddy)[\s,.!?]*$/i, "").trim();
  s = s.replace(/[?!.]+$/, "").trim();
  if (s.length < 8 || s.split(/\s+/).length < 2) return raw.trim(); // nothing recognizable — search the raw message
  return s;
}
