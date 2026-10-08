import type { ChatMsg } from "./llm";

export function msg(role: ChatMsg["role"], content: string): ChatMsg {
  return { role, content };
}

export const RESEARCHER_SYS =
  "You are DigDeep, a rigorous autonomous deep-research agent. You think carefully, rely ONLY on the provided source material, never invent facts or citations, and distinguish clearly between what sources establish and what remains uncertain. You always follow the exact output format requested.";

/** ------------------------------------------------------------------
 *  INTENT ROUTING — decide chat vs quick answer vs deep research
 *  ------------------------------------------------------------------ */
export type Intent = "chat" | "quick" | "research";

export function classifyPrompt(message: string, recentTurns: string, preset?: string): string {
  return `You are the intent router for DigDeep, a deep-research assistant. Work the way a careful assistant reads a new message: understand it FIRST, then decide what to do.

The user's latest message:
"""
${message.slice(0, 800)}
"""
${recentTurns ? `Recent thread context (earlier turns):\n${recentTurns.slice(0, 600)}\n` : ""}
Read it in this order:
1. About DigDeep ITSELF (abilities, identity, how it works — "what can you do?", "who are you?") or plain conversation (greetings, thanks, small talk)? → chat.
2. A "can you …?" question about the ASSISTANT'S OWN ABILITIES with NO topic ("can you make a deep research?", "are you able to run a research?") — the user is asking WHETHER it can be done → ALWAYS chat (answer "yes — give me a topic"). The same phrasing WITH a real topic ("can you research the best electric cars?") IS a genuine request → research.
3. One simple factual question answerable from 2-4 sources in a single pass (definitions, "what is X", "who won Y", lookups)? → quick.
4. Anything needing multi-source, multi-angle investigation — comparisons, analysis, "why/how", state of a field, open-ended topics → research.

CRITICAL: A selected depth mode (like "unlimited") only sets HOW DEEP real questions go — it never forces research onto conversational or capability questions. Unsure between quick and research → research. Clearly not a real question about the world → chat.

Respond with EXACTLY these four lines, nothing else:
RESTATE: <one short sentence — what the message literally says>
INTENT: <one short sentence — what the user actually wants to happen>
STRATEGY: <one short sentence — the best way to respond, and why>
LANE: <chat | quick | research>`;
}

/** Claude-style comprehension of a research question — run BEFORE planning.
 *  Asks: what is really being asked, what would a great answer establish,
 *  what is ambiguous, what sub-questions must the answer cover. */
export function comprehensionPrompt(query: string, threadContext?: string, docs?: { name: string }[]): string {
  const docNote = docs?.length
    ? `\nThe user attached ${docs.length} ground-truth document${docs.length > 1 ? "s" : ""} (${docs.map((d) => d.name).join(", ")}) to this thread — their content is authoritative for this research and will be available as sources.\n`
    : "";
  return `You are about to lead a deep-research effort. Before any searching, understand the request the way a careful researcher would.

The request:
"""
${query}
"""
${docNote}${threadContext ? `Earlier turns in this thread already covered:\n"""\n${threadContext.slice(0, 1500)}\n"""\n` : ""}
Respond with ONLY valid JSON (no fences):
{
  "restate": "1-2 sentences: what is actually being asked, in the user's own frame of reference",
  "intent": "1 sentence: what a great answer must DELIVER (the decision, comparison, explanation or evidence the user is really after)",
  "successCriteria": ["2-4 concrete tests a great answer must pass — what must be established, quantified, or compared"],
  "ambiguous": ["0-3 terms or phrases in the request that need disambiguation or scoping, each with the most likely intended meaning"],
  "subQuestions": ["3-6 natural sub-questions the answer must cover, in logical order"]
}`;
}

export const CHAT_SYS =
  "You are DigDeep, an autonomous deep-research assistant. Write in the conversational voice of Claude: " +
  "warm but measured, direct and substantive. Lead with the answer, never with filler. " +
  "Short paragraphs; bold the key terms sparingly; use a compact list only when the items are genuinely parallel. " +
  "No emoji unless the user used one first. No flattery, no exclamation-mark padding, no 'Hey there!' cheer. " +
  "Be precise — if you are unsure about something, say so plainly instead of guessing. " +
  "Reply in the SAME language the user wrote in. " +
  "You are chatting (not researching) right now: never fabricate facts or citations, and do not start a research report. " +
  "If the user seems to want research, say plainly that you can dig deep into anything they ask.";

export function chatPrompt(message: string, prevTurnSummary: string): string {
  return `${prevTurnSummary ? `Context — the user's recent conversation in this thread:\n"""\n${prevTurnSummary.slice(0, 1200)}\n"""\n\n` : ""}The user says:

"""
${message.slice(0, 1500)}
"""

Reply conversationally, in a Claude-like voice — direct, honest, no fluff.
If they ask whether you can do research ("can you make a deep research?", "can you do deep research?"), the answer is YES, plainly and immediately — one or two short sentences on what a run looks like (plan → parallel searches → reading sources → live self-critique → cited report), then invite them to give you a topic. Do not start researching anything and do not ask more than one question back.
If they ask what you are or what you can do, describe yourself factually and concisely:
- You route every message yourself: small talk gets a direct reply, simple factual questions get a quick cited answer, and real questions get full autonomous multi-source research.
- Research runs with visible step-by-step reasoning, honest time estimates, live self-critique of your own evidence, and a cited report (PDF/Markdown export).
- Modes from Quick up to Unlimited (no caps on aspects, rounds, sources or time), follow-ups stay in one thread.
- Everything runs on free keyless models (GLM Flash first, with automatic failover) — no API keys.
Keep it tight — a short intro line plus a compact list at most. Do not oversell; state what you actually do.`;
}

export function quickAnswerPrompt(
  query: string,
  sources: { n: number; title: string; domain: string; excerpt: string }[],
  language: string
): string {
  const src = sources.map((s) => `[${s.n}] ${s.title} (${s.domain})\n${s.excerpt}`).join("\n\n---\n\n");
  return `Question: "${query}"

Web sources retrieved:

${src}

Write a concise, direct answer to the question in ${language}, in a Claude-like voice — measured, precise, no filler:
- 120-350 words for simple lookups; up to 500 only if truly needed.
- Markdown. Lead with the direct answer in the first sentence — no preamble, no "Based on my research".
- Cite inline with [n] after claims, e.g. "The battery uses a solid electrolyte [2]". Use ONLY the given source numbers.
- Add a short "**Details**" or a few bullets ONLY if they add real value for this question.
- If the sources disagree or are thin, say so plainly instead of papering over it.
- Never mention that you are an AI or that you searched the web.`;
}

/** ------------------------------------------------------------------
 *  AGENT ROLE CHOOSER (gpt-researcher choose_agent pattern)
 *  ------------------------------------------------------------------ */
export function roleChooserPrompt(query: string): string {
  return `You are staffing a research task. Pick the single best expert persona to lead it.

Task: "${query}"

Respond with ONLY valid JSON (no fences):
{
  "agent": "2-4 word persona name (e.g. 'Battery Industry Analyst', 'Health Science Writer', 'Market Researcher', 'Policy Analyst')",
  "role": "One paragraph (40-80 words) written as a system prompt for that expert: their perspective, what they prioritize, what vocabulary they use, and what pitfalls they avoid (e.g. hype, vendor marketing, outdated numbers). Match the domain of the query."
}`;
}

export function planPrompt(
  query: string,
  breadth: number,
  language: string,
  threadContext?: string,
  initialSnippets?: string,
  comprehension?: string
): string {
  const breadthRule =
    breadth > 0
      ? `Produce exactly ${breadth} aspects covering the most important, non-overlapping dimensions of "${query}".`
      : `Produce as many aspects as the topic genuinely needs for exhaustive coverage — typically 5 to 12. Do NOT pad with filler aspects; every aspect must earn its place.`;
  const context = threadContext
    ? `\nThis is a FOLLOW-UP inside an ongoing research thread. Earlier turns already covered:\n"""\n${threadContext}\n"""\nFocus the plan on what is NEW or needs deeper investigation — avoid re-researching what the thread already answered, and reference it as known context.\n`
    : "";
  const scout = initialSnippets
    ? `\nA quick scouting search on the raw query already surfaced these pages (so you can gauge what actually exists on the web — do NOT treat their content as verified fact):\n"""\n${initialSnippets}\n"""\n`
    : "";
  const comp = comprehension
    ? `\nA comprehension pass on the request already established:\n"""\n${comprehension.slice(0, 2200)}\n"""\nThe plan MUST deliver the intent and pass the success criteria listed there, and should resolve the ambiguities it flagged.\n`
    : "";
  return `A user wants an exhaustive, well-cited research report on:

"${query}"
${comp}${context}${scout}
Design a research plan. THINK FROM KNOWLEDGE FIRST: state what you already confidently know about this topic, then aim the research at what is genuinely uncertain, fast-changing, or contested.

Respond with ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{
  "restate": "1-2 sentences: what the user really needs to know and why it matters",
  "reportType": "one of: technology-review | market-analysis | scientific-explainer | how-to-guide | news-analysis | general-research",
  "academic": true/false (true if arXiv/academic sources would materially help),
  "estimatedDifficulty": "one of: quick | moderate | demanding | very-demanding (your honest read of how much research this needs)",
  "priorKnowledge": "3-6 sentences of what is already confidently known about this topic (definitions, key entities, rough timeline) — the baseline the research builds on, NOT copied from the snippets",
  "unknowns": ["3-6 specific things that genuinely need web verification, are fast-changing, or are contested"],
  "aspects": [
    {
      "title": "short aspect name (2-5 words)",
      "question": "the specific research question this aspect answers",
      "goal": "1-2 sentences: what this aspect must establish, why it matters to the whole report, and how to advance once first results arrive",
      "queries": ["2-3 diverse web search queries for this aspect, each phrased differently to maximize source coverage"]
    }
  ]
}
Rules:
- ${breadthRule}
- Aspects should together fully cover the topic: context/definitions, current state, key players/examples, data & evidence, trends/outlook, risks/criticism — adapted to the topic.
- Queries must be effective web searches (include specific entities, years where relevant) — NEVER the literal text of the user's question.
- The final report will be written in ${language}.`;
}

export function summarizePrompt(section: string, question: string, sources: { n: number; title: string; domain: string; excerpt: string }[], round: number): string {
  const src = sources.map((s) => `[${s.n}] ${s.title} (${s.domain})\n${s.excerpt}`).join("\n\n---\n\n");
  return `Research question: "${question}" (aspect: "${section}") — round ${round} of iterative research.

Below are source excerpts retrieved so far:

${src}

Write dense research notes answering the question using ONLY these sources. Format as markdown bullets grouped by theme.
- Every factual claim must end with its citation like [2] or [1][5].
- Capture specific numbers, dates, names, methods, and direct insights — not vague generalities.
- Note disagreements between sources and notable limitations.
- End with a line "GAPS: <comma-separated list of things still unknown or thinly covered>".
Write the notes in English (they are internal working notes).`;
}

/** Reflect v3 — dual critic (WebWalker) + EVIDENCE-GRADED learnings + contradiction detection.
 *  Grading: verified (multiple independent sources) / likely (one strong primary source) /
 *  single-source (one source, unconfirmed) / contested (sources disagree). */
export function reflectPrompt(
  section: string,
  question: string,
  notes: string,
  depthLeft: number | "unlimited",
  linkCandidates?: { url: string; text: string }[],
  priorLearnings?: string[]
): string {
  const budget =
    depthLeft === "unlimited"
      ? "Research rounds are UNLIMITED — continue for as long as real gaps remain."
      : `There ${depthLeft > 0 ? `are ${depthLeft} more research round(s) available` : "are no more research rounds available"}.`;
  const links = (linkCandidates ?? []).length
    ? `\nLink candidates harvested from pages just read (you may WALK one of these — visit it directly — if it clearly looks like it answers the remaining gap better than a new search would):\n${(linkCandidates ?? [])
        .slice(0, 10)
        .map((l, i) => `${i + 1}. ${l.text} — ${l.url}`)
        .join("\n")}\n`
    : "";
  const learned = (priorLearnings ?? []).length
    ? `\nDense learnings captured so far in OTHER aspects of this same report (do not re-research these):\n${(priorLearnings ?? []).slice(0, 10).map((l) => `- ${l}`).join("\n")}\n`
    : "";
  return `You are managing an iterative research process for aspect "${section}" (question: "${question}").

Current accumulated notes:
${notes.slice(0, 6000)}
${learned}${links}
${budget}

Self-critique the evidence HONESTLY — do not flatter the work. Then distill what is now solidly known, and GRADE each finding by how well the sources actually support it. Respond with ONLY valid JSON (no fences):
{
  "sufficient": true/false,
  "assessment": "1-3 sentences of brutally honest self-assessment: is the evidence strong, specific, and comprehensive? Name what is weakest.",
  "learnings": [
    {"claim": "one dense fact nailed down this round — exact entities, numbers, dates, versions, names", "grade": "verified | likely | single-source | contested", "basis": "short: which sources (numbers) and why this grade"}
  ],
  "contradictions": [
    {"claim": "the point of disagreement", "positions": "source [n] says X, while source [m] says Y — one sentence each"}
  ],
  "followUps": [
    {"type": "search", "value": "a new web search query", "reason": "which gap this targets"},
    {"type": "walk", "value": "one of the candidate URLs (or a URL seen in the notes) worth visiting directly", "reason": "why visiting this page beats another search"}
  ]
}
Grading rules: "verified" needs agreement from 2+ INDEPENDENT domains in the notes; "likely" = one authoritative primary source; "single-source" = one source alone, unconfirmed; "contested" = sources genuinely disagree (and then also list it under contradictions). followUps: 0-3 max, mix search and walk as genuinely useful, empty if sufficient. Learnings may be empty if nothing new was nailed down.`;
}

/** Cross-verification of a load-bearing claim — a fresh evidence check against NEW sources
 *  that were not part of the original research pass (beyond-Perplexity fact-checking). */
export function verifyClaimPrompt(claim: string, originalBasis: string, newEvidence: string): string {
  return `You are an independent fact-checker. A research report is about to publish this claim:

CLAIM: "${claim}"

Original basis: ${originalBasis || "(no explicit basis recorded)"}

Freshly retrieved evidence from a NEW targeted search (sources not used for the original claim):
"""
${newEvidence.slice(0, 4000)}
"""

Judge ONLY from the fresh evidence: CONFIRMED (new sources agree), REFUTED (new sources contradict it — say what is true instead), or UNCLEAR (fresh sources don't address it). Respond with ONLY valid JSON (no fences):
{"verdict": "confirmed | refuted | unclear", "reasoning": "1-2 sentences citing the fresh evidence [n]", "correction": "if refuted: the corrected statement, else empty string"}`;
}

/** "Where sources disagree" — the honest-disagreement section (beyond Perplexity:
 *  surfacing contested claims instead of averaging them away). */
export function disagreementsPrompt(
  query: string,
  contradictions: { claim: string; positions: string }[],
  contested: { claim: string; basis: string }[],
  refuted: { claim: string; correction: string; reasoning: string }[],
  language: string
): string {
  const items = [
    ...contradictions.map((c) => `- CONTRADICTED: ${c.claim} — ${c.positions}`),
    ...contested.map((c) => `- CONTESTED: ${c.claim} (${c.basis})`),
    ...refuted.map((c) => `- REFUTED ON CROSS-CHECK: ${c.claim} → ${c.correction || c.reasoning}`),
  ].join("\n");
  return `A research report on "${query}" finished its evidence pass. The following points are NOT settled — sources disagree or cross-checks failed:

${items}

Write a short section titled "Where sources disagree" in ${language} (the report body will place it after the conclusion):
- 80-200 words, plain paragraphs or a short bullet list.
- For each point: state the disagreement plainly, both/all positions with their reasoning, and — where you honestly can — which side the weight of evidence favors and why.
- Do NOT average away the disagreement or pick a side without evidence. This section exists precisely to show readers what is contested.
- No citations needed beyond mentioning the positions themselves.`;
}

/** LLM rerank before read (P0-3) — spend the read budget on the pages that matter.
 *  Ranks candidate URLs for a research question; publication dates are included
 *  so the ranker can prefer fresh evidence for fast-moving topics. */
export function rerankPrompt(
  question: string,
  candidates: { title: string; domain: string; snippet: string; publishedAt?: string }[],
  keep: number
): string {
  const list = candidates
    .map((c, i) => `${i + 1}. ${c.title} — ${c.domain}${c.publishedAt ? ` — published ${c.publishedAt.slice(0, 10)}` : ""}\n   ${(c.snippet || "").slice(0, 200)}`)
    .join("\n");
  return `Research question: "${question}"

Candidate web pages from search engines:
${list}

Pick the ${keep} pages most worth READING IN FULL to answer the question. Judge by: relevance to the specific question, source credibility (primary/official > blog > aggregator), likely depth of content, and recency (for fast-moving topics prefer fresh sources; for background topics recency matters less). Respond with ONLY valid JSON (no fences):
{"ranked": [{"i": <candidate number>, "why": "one short line"}], "skip": [<candidate numbers that look like junk/ads/duplicates>]}
At most ${keep} entries in ranked, best first.`;
}

/** Citation repair (P0-4 Stage 4.5) — a batched judge for citations whose claim
 *  sentence has weak lexical overlap with the source they point at.
 *  Verdicts: supported (keep) / wrong-source (re-anchor to a better source number)
 *  / unsupported (remove the citation marker). */
export function citeRepairPrompt(
  question: string,
  weak: { n: number; sentence: string; sourceTitle: string; sourceExcerpt: string }[],
  allSources: { n: number; title: string; domain: string }[]
): string {
  const items = weak
    .map(
      (w, i) =>
        `CASE ${i + 1} — citation [${w.n}]:
Claim sentence from the report: "${w.sentence.slice(0, 320)}"
Cited source [${w.n}] (${w.sourceTitle}) excerpt:\n"""${w.sourceExcerpt.slice(0, 900)}"""`
    )
    .join("\n\n");
  const srcList = allSources.map((s) => `${s.n}. ${s.title} — ${s.domain}`).join("\n");
  return `You are auditing the citations of a research report on "${question}" before it is published. For each case below, decide whether the CITED SOURCE actually supports the CLAIM SENTENCE that cites it.

${items}

All sources available in this report:
${srcList}

Rules:
- "supported": the cited source's content genuinely backs the claim (even if phrased differently).
- "wrong-source": the claim is real but a DIFFERENT available source supports it better — name that source number in "use".
- "unsupported": no available source backs this claim — the citation must be removed (the sentence stays, the marker goes).
Judge ONLY from the provided excerpts — never assume. Respond with ONLY valid JSON (no fences):
{"cases": [{"case": <case number>, "verdict": "supported | wrong-source | unsupported", "use": <source number when wrong-source, else 0>}]}`;
}

/** Adversarial red-team pass (P1-2, Stage 3.7) — attack the draft's weakest claims
 *  before writing, so the writer strengthens or hedges them. */
export function redTeamPrompt(query: string, sections: { title: string; findings: string }[]): string {
  const body = sections.map((s) => `## ${s.title}\n${(s.findings ?? "").slice(0, 1800)}`).join("\n\n");
  return `A research report on "${query}" is about to be written from these findings:

${body}

You are a HOSTILE reviewer whose job is to break this report before an external critic can. Find the claims a knowledgeable skeptic would attack: numbers that smell off, causal claims resting on one source, outdated facts presented as current, vendor-marketing numbers repeated as truth, apples-to-oranges comparisons. Respond with ONLY valid JSON (no fences):
{
  "attacks": [
    {"section": "section title exactly as shown", "claim": "the specific claim to attack", "attack": "why a skeptic would reject it (1-2 sentences)", "severity": "high | medium | low"}
  ]
}
Max 4 attacks, highest severity first — only claims where the attack has real substance. Empty array if the evidence genuinely holds up.`;
}

/** Self-score (P1-1, Stage 5) — digdeep grades its own finished report against the
 *  comprehension pass's success criteria, on four dimensions. Honest when bad. */
export function qualityScorePrompt(query: string, successCriteria: string[], report: string, language: string): string {
  const crit = successCriteria.length ? successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") : "(the report should have established the core of the question with evidence)";
  return `A research report on "${query}" was just completed. Grade it honestly — the purpose of this score is trust, not marketing.

Success criteria defined BEFORE the research (a great answer must pass these):
${crit}

The report:
"""
${report.slice(0, 12000)}
"""

Grade on four dimensions, each 0-10 with one decimal: evidence (are claims grounded in the cited sources?), coverage (do the success criteria get answered?), honesty (are uncertainties and disagreements acknowledged rather than papered over?), clarity (is it well-structured and readable?). Then say whether each success criterion is met. Respond with ONLY valid JSON (no fences), in ${language}:
{
  "overall": <0-10, one decimal>,
  "dims": [{"name": "evidence | coverage | honesty | clarity", "score": <0-10>, "note": "one short sentence"}],
  "criteria": [{"criterion": "<the criterion>", "met": true | false, "why": "one short sentence"}],
  "biggestWeakness": "one sentence: the single biggest honest weakness of this report"
}`;
}

/** Multi-agent debate (P2-1) — proposer / skeptic / judge over a contested claim. */
export function debateProposerPrompt(claim: string, evidence: string): string {
  return `You are the PROPOSER in a structured fact-check debate. A research report is deciding this claim:

CLAIM: "${claim}"

Evidence gathered:
"""
${evidence.slice(0, 4000)}
"""

Argue the strongest honest case FOR the claim being true, citing the evidence. 80-140 words. If the evidence genuinely does not support it, say so instead of arguing — you persuade by being right, not loud. No headers, plain prose.`;
}

export function debateSkepticPrompt(claim: string, evidence: string): string {
  return `You are the SKEPTIC in a structured fact-check debate. A research report is deciding this claim:

CLAIM: "${claim}"

Evidence gathered:
"""
${evidence.slice(0, 4000)}
"""

Argue the strongest honest case AGAINST the claim — unsupported premises, contradicting evidence, weak sourcing, missing context. 80-140 words. If the evidence genuinely supports the claim, concede that instead of manufacturing doubt. No headers, plain prose.`;
}

export function debateJudgePrompt(claim: string, evidence: string, proposer: string, skeptic: string): string {
  return `You are the JUDGE in a structured fact-check debate over this claim:

CLAIM: "${claim}"

Evidence:
"""
${evidence.slice(0, 3000)}
"""

PROPOSER argued:
"""
${proposer.slice(0, 1200)}
"""

SKEPTIC argued:
"""
${skeptic.slice(0, 1200)}
"""

Weigh both arguments against the evidence ONLY. Respond with ONLY valid JSON (no fences):
{"verdict": "supported | refuted | unsettled", "correctedClaim": "if refuted: the claim as it should be stated; if unsettled: the precise question that remains open; else empty", "reasoning": "2-3 sentences citing the evidence"}`;
}

/** Monitoring diff digest (P2-2) — what changed between two research runs of the
 *  same question. Powers the "Re-run research" flow. */
export function diffDigestPrompt(query: string, prevReport: string, newReport: string, language: string): string {
  return `The question "${query}" was researched twice. Compare the two reports and write the "What changed since the last run" section for the NEW report.

PREVIOUS report (from the earlier run):
"""
${prevReport.slice(0, 6000)}
"""

NEW report (just completed):
"""
${newReport.slice(0, 6000)}
"""

Write in ${language}, 120-220 words, structured as exactly three short bold-led bullet groups:
- **New** — findings that appeared only in the new run
- **Changed** — numbers, dates or conclusions that shifted between runs (give both values)
- **Unsettled** — questions that remain open or flipped direction
Only state differences you can actually see in the two texts. If the reports essentially agree, say that plainly — an honest "little has changed" beats invented novelty. No citations.`;
}

/** Source curator (gpt-researcher SourceCurator pattern): rank sources by credibility + relevance. */
export function curateSourcesPrompt(
  query: string,
  sources: { n: number; title: string; domain: string; words?: number }[],
  keep: number
): string {
  const list = sources.map((s) => `${s.n}. ${s.title} — ${s.domain}`).join("\n");
  return `A research report on "${query}" is about to be written. Rank the sources consulted by how credible and useful each is for citation.

Sources:
${list}

Evaluate relevance to the question, source quality (primary > secondary > aggregator), depth actually read, and domain reputation. Respond with ONLY a valid JSON array (no fences) of the source NUMBERS in priority order, best first, keeping at most ${keep}. Example: [4, 1, 7, 2]. Do not invent numbers that are not in the list.`;
}

export function critiquePrompt(query: string, sections: { title: string; findings: string }[]): string {
  const body = sections.map((s) => `## ${s.title}\n${(s.findings ?? "").slice(0, 2500)}`).join("\n\n");
  return `A research report is being prepared on: "${query}".

Below are the accumulated findings per section:

${body}

Act as a critical reviewer. Respond with ONLY valid JSON (no fences):
{
  "verdict": "one of: solid | needs-targeted-followup | has-critical-gaps",
  "reasoning": "2-3 sentences on overall evidence quality",
  "weakSections": [
    {"title": "section title exactly as shown", "reason": "what is missing or weak", "queries": ["1-2 targeted search queries to fix it"]}
  ]
}
Only list sections with real evidentiary weaknesses (max 3). If everything is well-covered, return an empty weakSections array.`;
}

export function draftSectionPrompt(
  query: string,
  sectionTitle: string,
  question: string,
  findings: string,
  sources: { n: number; title: string; url: string; domain: string }[],
  words: [number, number],
  language: string,
  evidenceNotes?: string,
  adversarialNotes?: string
): string {
  const refs = sources.map((s) => `[${s.n}] ${s.title} — ${s.domain} (${s.url})`).join("\n");
  const evid = evidenceNotes
    ? `\nEvidence-strength notes for claims in this section (from the reflection pass — reflect them in how confidently you state each claim):\n"""\n${evidenceNotes.slice(0, 1800)}\n"""\nState verified claims plainly. For single-source or contested claims, say so inline ("one source reports…", "sources disagree on…") instead of asserting them as settled.\n`
    : "";
  const adv = adversarialNotes
    ? `\nA red-team pass attacked these claims in this section — strengthen them with evidence, hedge them honestly, or attribute them to their source. Do NOT repeat a claim the attack broke without addressing it:\n"""\n${adversarialNotes.slice(0, 1500)}\n"""\n`
    : "";
  return `You are writing one section of a professional research report on: "${query}".

Section: "${sectionTitle}"
Research question: "${question}"

Accumulated verified findings:
${findings.slice(0, 9000)}
${evid}${adv}
Sources available for citation (use ONLY these numbers):
${refs}

Write the section body in ${language}:
- ${words[0]}-${words[1]} words, markdown. Start directly with substance (no "# heading" — it will be added automatically).
- Use ### for internal sub-headings where helpful, bullet lists, and bold for key terms.
- Cite inline with [n] immediately after claims, e.g. "adoption grew 340% in 2025 [2]". Every substantive claim needs a citation.
- Include concrete data, examples, comparisons and mechanisms. Flag genuine uncertainty ("sources disagree…", "evidence is limited to…").
- Do NOT write a reference list — only cite with [n].`;
}

export function execSummaryPrompt(query: string, drafts: string, language: string, preset: string): string {
  return `Research report on: "${query}"

Section drafts (in order):
${drafts.slice(0, 14000)}

Write the report's EXECUTIVE SUMMARY in ${language}:
- ${preset === "exhaustive" || preset === "deep" ? "200-300" : "120-200"} words, plain paragraphs (no headings, no bullets, no citations).
- Lead with the single most important takeaway, then the key findings (with concrete numbers where available), then implications.
- Write in ${language}.`;
}

export function conclusionPrompt(query: string, drafts: string, language: string): string {
  return `Research report on: "${query}"

Section drafts:
${drafts.slice(0, 12000)}

Write the report's CONCLUSION in ${language}:
- 120-200 words, plain paragraphs, no citations, no new facts.
- Synthesize the overall picture, acknowledge key uncertainties, and outline what to watch next.
- Write in ${language}.`;
}

export function relatedPrompt(query: string, sectionTitles: string[], language: string): string {
  return `A research report just answered: "${query}"
Report sections: ${sectionTitles.join(" · ")}

Suggest 4 FOLLOW-UP questions a curious reader would naturally ask next — going deeper or wider than the report, not repeating it. Respond with ONLY a valid JSON array of 4 strings (no fences), written in ${language}. Each question max 14 words.`;
}

export function titlePrompt(query: string, planSummary: string, language: string): string {
  return `A research report covers: "${query}"
Plan: ${planSummary.slice(0, 500)}

Propose a professional report title in ${language}. Max 12 words. Respond with ONLY the title text (no quotes, no prefix).`;
}
