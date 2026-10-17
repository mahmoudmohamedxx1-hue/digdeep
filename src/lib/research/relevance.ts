/**
 * Source relevance gating — the fix for the "garbage sources" failure mode.
 *
 * The ECL run showed the classic failure: vague user phrasing ("looking forward
 * factor ... big 4 method") matched film pages, toy GitHub repos and math papers
 * on filler words, and the whole report became "no relevant discussion in the
 * provided literature". This module scores each search result against the
 * aspect's question + the round's queries BEFORE any page is read, so off-topic
 * results are dropped and trigger a query reformulation instead of being cited.
 *
 * Pure lexical scoring (zero LLM calls — it runs on every result of every
 * round). The vocabulary carrier is the QUESTION plus the round's QUERIES: the
 * planner writes domain-expert queries ("IFRS 9 expected credit loss
 * forward-looking"), so a real methodology page matches several of those terms
 * while a film page matched on "can" matches none of them.
 */

const STOPWORDS = new Set([
  // generic + question filler
  "about", "after", "again", "all", "also", "and", "any", "are", "arent", "because", "been",
  "before", "being", "between", "both", "but", "can", "cant", "come", "could", "did", "does",
  "doing", "dont", "down", "even", "every", "for", "from", "get", "getting", "give", "had",
  "has", "have", "having", "here", "how", "into", "just", "like", "make", "many", "more",
  "most", "much", "must", "need", "new", "now", "off", "only", "other", "our", "out", "over",
  "said", "same", "should", "some", "such", "take", "than", "that", "the", "their", "them",
  "then", "there", "these", "those", "through", "time", "too", "under", "until", "very",
  "want", "was", "way", "well", "were", "what", "when", "where", "which", "while", "who",
  "why", "will", "with", "would", "you", "your", "tell", "use", "used", "using", "give",
  "gave", "one", "two", "per", "via", "each", "its", "when", "same", "big", "4",
]);

/** Tokenize for matching: lowercase, alphanumerics, 3+ chars, stopworded. */
export function keyTerms(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && t.length <= 24 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  );
}

export interface RelevanceInput {
  title: string;
  snippet?: string;
  domain?: string;
}

export interface RelevanceScored<T> {
  kept: T[];
  dropped: T[];
  /** median kept score — surfaced in events so the gate's behavior is visible */
  keptScore: number;
}

/**
 * A result is KEPT when its title+snippet genuinely overlap the topical
 * vocabulary (question + queries):
 *   - coverage >= 0.15 with >= 2 distinct matched terms (the normal path — a
 *     real methodology page hits several domain terms), or
 *   - >= 3 distinct matches (however thin the question set), or
 *   - exactly 1 match that is a rare, reasonably specific term (df < 25% of
 *     pool, 4+ chars — an "ifrs"-only hit survives; a "big"-only hit does not).
 * Everything else (the film pages and toy repos that matched filler words) is
 * dropped before the read budget is spent. Kept results are sorted best-first.
 */
export function gateByRelevance<T extends RelevanceInput>(
  question: string,
  queriesText: string,
  results: T[],
): RelevanceScored<T> {
  if (results.length === 0) return { kept: [], dropped: [], keptScore: 0 };
  const qTerms = keyTerms(`${question} ${queriesText}`);
  if (qTerms.length === 0) return { kept: results, dropped: [], keptScore: 1 };

  // term document-frequency across the pool — powers the rare-single-match path
  const df = new Map<string, number>();
  const rTermSets = results.map((r) => {
    const tokens = new Set(keyTerms(`${r.title} ${r.snippet ?? ""}`));
    for (const t of qTerms) if (tokens.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });

  const kept: { r: T; score: number }[] = [];
  const dropped: T[] = [];
  results.forEach((r, i) => {
    const tokens = rTermSets[i];
    const matched: string[] = [];
    for (const t of qTerms) if (tokens.has(t)) matched.push(t);
    const score = matched.length / qTerms.length;
    let keep = false;
    if (matched.length >= 3) keep = true;
    else if (matched.length >= 2 && score >= 0.15) keep = true;
    else if (matched.length === 1) {
      const t = matched[0];
      keep = t.length >= 4 && (df.get(t) ?? 0) / results.length < 0.25;
    }
    if (keep) kept.push({ r, score });
    else dropped.push(r);
  });

  kept.sort((a, b) => b.score - a.score); // best first — the read budget starts on-target
  const scores = kept.map((k) => k.score);
  return {
    kept: kept.map((k) => k.r),
    dropped,
    keptScore: scores.length ? scores[Math.floor(scores.length / 2)] : 0,
  };
}
