/**
 * Claim-level verification — the shared substrate.
 *
 * One implementation of the lexical-support algorithm, imported by BOTH the
 * engine (server, at report time) and the client (honest local re-checks) —
 * so a "re-check" in the evidence panel is the same computation the engine
 * ran, never a different rule pretending to agree.
 *
 * Pure functions only: no DOM, no node APIs — safe on both sides of the wire.
 */

export type ClaimVerdict = "verified" | "partly" | "unverified";

export interface ClaimCheck {
  /** stable id within one report: "c1", "c2", … (document order) */
  id: string;
  /** the claim sentence, exactly as it appears in the report */
  text: string;
  /** FINAL citation number as printed in the report (post-remap) */
  n: number;
  verdict: ClaimVerdict;
  /** lexical support ratio 0–1 (rounded to 2dp) */
  support: number;
  /** the source passage the claim rests on */
  passage: string;
  /** report section the claim appears in */
  section: string;
  /** how close this source is to the original */
  closeness: "primary" | "peer" | "secondary" | "community";
  sourceTitle: string;
  sourceDomain: string;
  /** honest caveat when present (judge action, snippet-grade source, …) */
  note?: string;
}

export interface ClaimVerdictSummary {
  /** distinct sources cited by checked claims (final numbering) */
  citedSources: number;
  /** sources whose every checked claim is verified */
  fullySupported: number;
  verified: number;
  partly: number;
  unverified: number;
}

const CITE_STOP = new Set([
  "about", "after", "again", "their", "there", "these", "those", "which", "while", "would", "could",
  "should", "other", "because", "being", "under", "between", "through", "during", "before", "above",
  "below", "further", "once", "where", "both", "each", "more", "most", "some", "such", "only", "same",
  "than", "very", "just", "also", "into", "over", "have", "this", "that", "from", "they", "been",
  "were", "when", "what", "will", "your", "them", "then", "many", "much", "since", "based",
  "including", "according", "reported", "argues", "suggests", "compared", "largely", "several",
  "various", "important", "significant", "currently", "recently", "however", "therefore", "whereas",
  "although", "despite", "across", "within", "without", "toward", "among",
]);

/** Content words of a sentence — the tokens that must overlap for real support. */
export function supportTokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/\[\d+\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !CITE_STOP.has(w));
}

/** Share of the claim's content words present in the source text (0–1). */
export function lexicalSupport(sentence: string, sourceText: string): number {
  const st = supportTokens(sentence);
  if (st.length < 2) return 1; // too generic to judge — never flag on vibes
  const src = new Set(supportTokens(sourceText));
  let hit = 0;
  for (const t of st) if (src.has(t)) hit++;
  return hit / st.length;
}

/**
 * The passage the claim rests on: the best-scoring run of consecutive source
 * sentences (window of 3), trimmed for display. Honest by construction — it
 * is a verbatim slice of what the engine actually read.
 */
export function bestPassage(claim: string, sourceText: string): { passage: string; support: number } {
  const support = lexicalSupport(claim, sourceText);
  if (!sourceText.trim()) return { passage: "", support };
  const sentences = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return { passage: "", support };

  const claimTokens = new Set(supportTokens(claim));
  let best = { score: -1, text: sentences[0] };
  for (let i = 0; i < sentences.length; i++) {
    for (const w of [1, 2, 3]) {
      if (i + w > sentences.length) continue;
      const window = sentences.slice(i, i + w);
      const windowTokens = new Set(window.flatMap((s) => supportTokens(s)));
      let hit = 0;
      for (const t of claimTokens) if (windowTokens.has(t)) hit++;
      const score = claimTokens.size >= 2 ? hit / claimTokens.size : 0;
      if (score > best.score) best = { score, text: window.join(" ") };
    }
  }
  return { passage: best.text.slice(0, 360), support };
}

/** Verdict from the support ratio — the same thresholds for every grade of
 *  source (deliberately: one rule, no special cases to game). */
export function verdictFromSupport(support: number): ClaimVerdict {
  if (support >= 0.3) return "verified";
  if (support >= 0.15) return "partly";
  return "unverified";
}

const PEER_HOSTS = [
  "pubmed.ncbi.nlm.nih.gov", "nature.com", "science.org", "doi.org", "springer.com", "wiley.com",
  "ieee.org", "acm.org", "mdpi.com", "plos.org", "academic.oup.com", "oup.com", "jstor.org",
  "tandfonline.com", "sagepub.com", "cambridge.org", "thelancet.com", "nejm.org", "bmj.com",
  "cell.com", "frontiersin.org", "aps.org", "royalsocietypublishing.org", "pnas.org", "ncbi.nlm.nih.gov",
];
const PRIMARY_HOSTS = [
  "gov", "europa.eu", "imf.org", "worldbank.org", "oecd.org", "un.org", "who.int", "ecb.europa.eu",
  "federalreserve.gov", "data.gov", "statista.com", "census.gov", "bls.gov", "cdc.gov", "nasa.gov",
  "esa.int", "gov.uk", "gc.ca", "data.gov.uk", "bankofengland.co.uk", "bis.org", "wto.org", "iaea.org",
];
const COMMUNITY_HOSTS = [
  "reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com",
  "substack.com", "medium.com", "wordpress.com", "blogspot.com", "tumblr.com", "discord.com",
  "x.com", "twitter.com", "facebook.com", "wikipedia.org", "wiki",
];
const PREPRINT_HOSTS = ["arxiv.org", "biorxiv.org", "ssrn.com", "medrxiv.org", "osf.io", "preprints.org"];

/** How close is this source to the original? Deterministic domain heuristics — no model calls. */
export function classifyCloseness(domain: string, url = ""): ClaimCheck["closeness"] {
  const d = (domain || "").toLowerCase().replace(/^www\./, "");
  const u = (url || "").toLowerCase();
  const host = d || (u.startsWith("http") ? u.replace(/^https?:\/\//, "").split("/")[0] : "");

  // community first — the most specific signal (forums, social, wikis)
  if (COMMUNITY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h.replace(".com", "")))) {
    return "community";
  }
  // peer-reviewed venues (preprints are NOT peer-reviewed — they fall through to secondary)
  if (PEER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "peer";
  // primary: official statistics, regulators, intergovernmental data
  if (PRIMARY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return "primary";
  if (/\.gov$/.test(host) || /\.gov\.[a-z]{2}$/.test(host) || /\.int$/.test(host)) return "primary";
  if (PREPRINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return "secondary"; // preprint — deliberately not "peer"
  }
  return "secondary";
}

export const CLOSENESS_LABEL: Record<ClaimCheck["closeness"], string> = {
  primary: "Primary — official data, regulator or government",
  peer: "Peer-reviewed — journal or proceedings",
  secondary: "Secondary — reporting on or aggregating the original",
  community: "Community — forums, social or collaboratively edited",
};

/** Worst-of verdict for a set of checks (a claim chain is as strong as its weakest link). */
export function worstVerdict(v: ClaimVerdict[]): ClaimVerdict {
  if (v.includes("unverified")) return "unverified";
  if (v.includes("partly")) return "partly";
  return "verified";
}
