/**
 * Source quality gate (v2.5.0) — the fix for the garbage-evidence failure mode.
 *
 * The ECL-style live run scored 3.5/10 with 100% citation integrity: every
 * citation was honest, but the evidence base itself was junk — an empty GitHub
 * repo (★ 0), paid press releases and SEO market-report farms matched the
 * query's words without carrying any substance. Relevance gating alone cannot
 * see that; this module adds the quality axis:
 *
 *   1. JUNK FILTER   — results that must never spend a read slot:
 *                      empty/trivial GitHub repos, PR wires, paid press
 *                      releases, market-report farms, link aggregators.
 *   2. DOMAIN TIERS  — a curated registry of primary/authoritative domains
 *                      (arXiv, Nature, IEEE, Reuters, official docs…) that
 *                      stable-sorts ABOVE generic sites when both are on-topic.
 *   3. CONCRETENESS  — snippets carrying numbers, dates, versions and named
 *                      entities outrank word-salad snippets, because reports
 *                      graded 9+ need specific, checkable facts.
 *
 * All three compose with the existing relevance gate (relevance.ts): relevance
 * decides "is this about the question", quality decides "is this worth
 * reading". A result must pass both to spend a read slot.
 */

export interface QualityCandidate {
  url: string;
  domain: string;
  title: string;
  snippet?: string | null;
  engine?: string;
  excerpt?: string;
  publishedAt?: string | null;
}

/** Why a result was rejected — surfaced in the event stream, never silent. */
export function junkReason(r: QualityCandidate, query = ""): string | null {
  const title = (r.title || "").toLowerCase();
  const snip = `${r.snippet || ""} ${r.excerpt || ""}`.toLowerCase();
  const dom = (r.domain || "").toLowerCase();
  const q = query.toLowerCase();

  // ── GitHub: empty and trivial repos are noise, not evidence ─────────────
  // The GitHub engine formats titles as "Owner/repo (★ N)" — parse the stars
  // and reject 0-2 star repos unless the user explicitly asked for repos.
  if (dom.includes("github.com") || (r.engine || "").toLowerCase().includes("github")) {
    const stars = /\u2605\s*(\d+)/.exec(r.title || "")?.[1];
    const starN = stars != null ? Number(stars) : null;
    const wantsRepos = /\b(repo|repository|github|open[- ]source|oss)\b/.test(q);
    if (!wantsRepos) {
      if (starN != null && starN < 3) return `GitHub repo with only ${starN} stars`;
      if (/repository is empty|this repository is empty/.test(snip)) return "empty GitHub repository";
      if (/^\u2605\s*0$/.test((r.title || "").trim())) return "GitHub repo with 0 stars";
    }
  }

  // ── Press-release wires and paid promotions — marketing, not evidence ───
  const PR_WIRES = [
    "prnewswire.com", "businesswire.com", "globenewswire.com", "prweb.com",
    "pressrelease.com", "einpresswire.com", "send2press.com", "eprnews.com",
  ];
  if (PR_WIRES.some((w) => dom.includes(w))) return "press-release wire";
  if (/paid press release|this is a paid press release|a paid press release from/.test(snip)) return "paid press release";
  if (/contact the press release distributor|research and markets\b/.test(snip) && /market report|market size|cagr/i.test(title + snip)) return "market-report press release";

  // ── SEO market-report farms — "Global X Market 2026-2031" content mills ─
  const FARM_DOMAINS = [
    "grandviewresearch.com", "marketsandmarkets.com", "alliedmarketresearch.com",
    "mordorintelligence.com", "fortunebusinessinsights.com", "imarcgroup.com",
    "precedenceresearch.com", "verifiedmarketresearch.com", "dataintelo.com",
    "kingsresearch.com", "sphericalinsights.com", "gminsights.com",
    "statistifymarketresearch.com", "introspectivemarketresearch.com",
  ];
  if (FARM_DOMAINS.some((w) => dom.includes(w))) return "market-report SEO farm";

  // ── Content aggregators that republish without adding evidence ─────────
  if (["pulse.dzone.com", "scoop.it", "paper.li", "flipboard.com", "mix.com"].some((w) => dom.includes(w)))
    return "content aggregator";

  // ── Empty-shell pages the fetcher sometimes returns ─────────────────────
  if (/^\s*(reload|refresh|enable javascript|sign in|404|not found|access denied)\b/.test((r.excerpt || r.snippet || "").trim().slice(0, 60)))
    return "unreadable shell page";

  return null;
}

/** Domain quality tier, 0-10. 5 = neutral default; higher = authoritative
 * primary sources; lower = user-generated / low editorial bar. Used ONLY as a
 * stable sort hint among on-topic results — it never overrides relevance. */
const TIER_10 = [
  "arxiv.org", "nature.com", "science.org", "cell.com", "thelancet.com", "nejm.org", "bmj.com", "pubmed.ncbi.nlm.nih.gov",
  "ieeexplore.ieee.org", "dl.acm.org", "springer.com", "link.springer.com", "sciencedirect.com", "wiley.com",
  "nist.gov", "cdc.gov", "who.int", "nih.gov", "census.gov", "bls.gov", "federalreserve.gov", "ecb.europa.eu",
  "oecd.org", "worldbank.org", "imf.org", "un.org", "europa.eu",
];
const TIER_9 = [
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "economist.com", "wsj.com", "nytimes.com", "washingtonpost.com",
  "theguardian.com", "bbc.com", "bbc.co.uk", "npr.org", "propublica.org", "theverge.com", "arstechnica.com", "wired.com",
  "technologyreview.com", "quantamagazine.org", "nature.org", "sciencenews.org",
];
const TIER_8 = [
  "docs.python.org", "developer.mozilla.org", "rust-lang.org", "go.dev", "nodejs.org", "kernel.org",
  "openai.com", "blog.google", "deepmind.google", "research.google", "ai.meta.com", "meta.com",
  "ibm.com", "microsoft.com", "azure.microsoft.com", "aws.amazon.com", "cloud.google.com",
  "nvidia.com", "intel.com", "apple.com", "android.com", "postgresql.org", "mongodb.com",
  "ansible.com", "redhat.com", "nginx.org", "docker.com", "kubernetes.io", "linuxfoundation.org",
  "w3.org", "ietf.org", "rfc-editor.org", "unicode.org", "iso.org", "iana.org",
  "python.org", "java.com", "oracle.com", "sap.com", "salesforce.com",
];
const TIER_7 = [
  "wikipedia.org", "britannica.com", "stackoverflow.com", "serverfault.com", "superuser.com",
  "hackernews.com", "news.ycombinator.com", "github.io", "readthedocs.io", "gitlab.com",
  "cnbc.com", "cnn.com", "abcnews.go.com", "nbcnews.com", "cbsnews.com", "usatoday.com",
  "time.com", "newsweek.com", "forbes.com", "fortune.com", "businessinsider.com", "techcrunch.com",
  "engadget.com", "zdnet.com", "cnet.com", "pcworld.com", "theinformation.com", "semianalysis.com",
  "medium.com", "substack.com", "dev.to", "hashnode.dev",
];
const TIER_4 = [
  "quora.com", "answers.com", "yahoo.com", "reddit.com", "twitter.com", "x.com",
  "facebook.com", "tiktok.com", "pinterest.com", "amazon.com", "ebay.com", "aliexpress.com",
  "yelp.com", "tripadvisor.com", "yellowpages.com", "whitepages.com", "ziprecruiter.com",
  "coursehero.com", "chegg.com", "scribd.com", "slideshare.net", "issuu.com", "studocu.com",
  "essayexamples.com", "bartleby.com", "enotes.com", "gradesfixer.com",
];

export function domainTier(domain: string): number {
  const d = (domain || "").toLowerCase().replace(/^www\./, "");
  if (TIER_10.some((t) => d === t || d.endsWith(`.${t}`) || d.includes(t))) return 10;
  if (TIER_9.some((t) => d === t || d.endsWith(`.${t}`) || d.includes(t))) return 9;
  if (TIER_8.some((t) => d === t || d.endsWith(`.${t}`) || d.includes(t))) return 8;
  if (TIER_7.some((t) => d === t || d.endsWith(`.${t}`) || d.includes(t))) return 7;
  if (TIER_4.some((t) => d === t || d.endsWith(`.${t}`) || d.includes(t))) return 4;
  // government / academic TLD patterns get a tier bump even unlisted
  if (/\.gov(\.[a-z]{2})?$/.test(d) || /\.edu(\.[a-z]{2})?$/.test(d) || /\.ac\.[a-z]{2}$/.test(d)) return 9;
  // an unknown domain inside a known platform host (github.io etc.) already matched above
  return 5;
}

/** Concreteness 0-10: density of checkable specifics in title+snippet.
 * Numbers, percentages, dates, versions and acronyms are the raw material of
 * evidence-graded reports — "many companies improved" scores 1, "IBM's 1,121-qubit
 * Condor (Dec 2023)" scores 9. */
export function concretenessScore(r: QualityCandidate): number {
  const text = `${r.title || ""} ${r.snippet || r.excerpt || ""}`;
  if (!text.trim()) return 0;
  let s = 0;
  const words = text.split(/\s+/).length || 1;
  const digits = (text.match(/\d[\d,.]*\b/g) || []).length;
  const pcts = (text.match(/\d+(\.\d+)?\s*%/g) || []).length;
  const years = (text.match(/\b(19|20)\d{2}\b/g) || []).length;
  const versions = (text.match(/\bv?\d+\.\d+(\.\d+)?\b/gi) || []).length;
  const acronyms = (text.match(/\b[A-Z]{2,6}\b/g) || []).length;
  const money = (text.match(/[$€£¥]\s?\d[\d,.]*(\s?(billion|million|trillion|bn|m|k))?/gi) || []).length;
  s += Math.min(4, digits * 0.6) + Math.min(2, pcts * 1) + Math.min(2, years * 0.8) + Math.min(1.5, versions * 0.8) + Math.min(1.5, acronyms * 0.25) + Math.min(1.5, money * 1);
  // long enough to carry substance?
  if (words < 12) s *= 0.5;
  return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
}

/** Quality score used for ordering on-topic candidates: domain tier dominates,
 * concreteness breaks ties. 0-20 scale. */
export function qualityScore(r: QualityCandidate): number {
  return domainTier(r.domain) + concretenessScore(r);
}

/** The gate every search-pick point calls: drops junk (with reasons for the
 * event stream) and stable-sorts the survivors so authoritative, concrete
 * sources spend the read budget first. Preserves the caller's existing order
 * among equals (stability matters — the caller may have boosted news). */
export function applySourceQualityGate<T extends QualityCandidate>(
  results: T[],
  query = "",
  opts: { boostNews?: boolean; authorityDomains?: string[] } = {},
): { kept: T[]; dropped: { title: string; domain: string; reason: string }[] } {
  const dropped: { title: string; domain: string; reason: string }[] = [];
  const kept: T[] = [];
  const auth = (opts.authorityDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const isAuthority = (r: T) =>
    auth.length > 0 &&
    auth.some(
      (a) => r.domain === a || r.domain.endsWith(`.${a}`) || (r.domain || "").toLowerCase().includes(a),
    );
  for (const r of results) {
    const reason = junkReason(r, query);
    if (reason) {
      dropped.push({ title: (r.title || r.url || "").slice(0, 90), domain: r.domain || "", reason });
      continue;
    }
    kept.push(r);
  }
  // stable sort: quality desc; within ±1.5 quality, original order stands
  // P2-1 domain packs: whitelisted authorities (statutes, filings, journals) get
  // a decisive +18 boost — primary sources outrank commentary in domain runs.
  const scored = kept.map((r, i) => ({ r, i, q: qualityScore(r) + (isAuthority(r) ? 18 : 0) }));
  scored.sort((a, b) => {
    const dq = b.q - a.q;
    if (dq > 1.5) return 1; // b clearly better
    if (dq < -1.5) return -1; // a clearly better
    // near-tie → preserve caller order (news boost, engine interleave)
    if (opts.boostNews) {
      const an = (a.r.engine || "").includes("News") ? 1 : 0;
      const bn = (b.r.engine || "").includes("News") ? 1 : 0;
      if (bn !== an) return bn - an;
    }
    return a.i - b.i;
  });
  return { kept: scored.map((s) => s.r), dropped };
}
