/**
 * Zero-LLM intent heuristics — shared by the engine and tests.
 * Matches obvious conversation (greetings, thanks, small talk, capability/meta
 * questions). Returns "chat" when the message clearly needs no research;
 * null = needs the LLM classifier.
 */

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
  let s = raw
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  // strip conversational wrappers (same loop as heuristicChatIntent)
  for (let i = 0; i < 4; i++) {
    const stripped = s
      .replace(/^(so|ok|okay|k|well|hey|hi|hello|yo|hmm+|um+|please|pls|and|but|just|actually|really|btw|by the way) /, "")
      .replace(/( please| pls| man| bro| dude| mate| buddy| thanks| thank you| thx| lol| haha+| now| really)$/, "")
      .trim();
    if (stripped === s) break;
    s = stripped;
  }
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
  let s = raw
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // emoji
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
  if (!s) return "chat";
  // strip conversational wrappers so "hey, how do you work?" matches "how do you work"
  // (repeatable — handles "so ok hey ...")
  for (let i = 0; i < 4; i++) {
    const stripped = s
      .replace(/^(so|ok|okay|k|well|hey|hi|hello|yo|hmm+|um+|please|pls|and|but|just|actually|really|btw|by the way) /, "")
      .replace(/( please| pls| man| bro| dude| mate| buddy| thanks| thank you| thx| lol| haha+| now| really)$/, "")
      .trim();
    if (stripped === s) break;
    s = stripped;
  }
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
  return null;
}
