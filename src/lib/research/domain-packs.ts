/**
 * P2-1 Domain packs — curated source whitelists, evidence standards, and
 * citation formats for law, finance, and medicine. A pack influences:
 *   1. the research plan (evidence standards injected into the plan prompt),
 *   2. search (whitelist domains get site: query variants + quality boost),
 *   3. synthesis + court (domain guidance block),
 *   4. exports (the pack's citation format label).
 */

export type DomainKey = "general" | "law" | "finance" | "medicine";

export interface DomainPack {
  key: DomainKey;
  label: string;
  emoji: string;
  /** One-line evidence standard shown in the composer when selected. */
  hint: string;
  /** Authoritative domains — searched explicitly and boosted in quality scoring. */
  authorities: string[];
  /** Guidance injected into planning / synthesis / court prompts. */
  guidance: string;
  /** How citations are formatted in exports. */
  citationFormat: string;
}

export const GENERAL_PACK: DomainPack = {
  key: "general",
  label: "General",
  emoji: "🌐",
  hint: "Balanced sourcing across the open web",
  authorities: [],
  guidance: "",
  citationFormat: "Source title — domain (accessed date)",
};

export const LAW_PACK: DomainPack = {
  key: "law",
  label: "Legal",
  emoji: "⚖️",
  hint: "Primary law first: statutes, regulations, cases, dockets",
  authorities: [
    "law.cornell.edu",
    "supremejustia.com",
    "justia.com",
    "casetext.com",
    "courtlistener.com",
    "supremecourt.gov",
    "congress.gov",
    "govinfo.gov",
    "ecfr.gov",
    "federalregister.gov",
    "eur-lex.europa.eu",
    "legislation.gov.uk",
    "icosgroup.org",
  ],
  guidance:
    "LEGAL EVIDENCE STANDARDS: cite primary authority first (statutes, regulations, case law, official dockets) before secondary commentary. Every legal claim must state its jurisdiction and date — the law varies by jurisdiction and changes over time. Name cases with full citations, statutes with sections. Distinguish holding from dicta, and majority from dissent. Bar-periodical commentary (ABA, law reviews) is persuasive, not binding. If a claim depends on an unresolved circuit split or pending litigation, say so explicitly rather than picking a side. NEVER give legal advice — state what the law says and where.",
  citationFormat: "Case/Statute name, citation (court year) — per Bluebook-style convention",
};

export const FINANCE_PACK: DomainPack = {
  key: "finance",
  label: "Financial",
  emoji: "📊",
  hint: "Filings, filings, filings — then reputable analysis",
  authorities: [
    "sec.gov",
    " investor.gov",
    "federalreserve.gov",
    "fca.org.uk",
    "bis.org",
    "imf.org",
    "worldbank.org",
    "ecb.europa.eu",
    "oecd.org",
    "irs.gov",
    "annualreports.com",
    "bamsec.com",
  ],
  guidance:
    "FINANCIAL EVIDENCE STANDARDS: primary sources first — SEC filings (10-K, 10-Q, 8-K, S-1), central-bank data, audited annual reports — before sell-side or media commentary. Every number must carry its period and unit (fiscal year, quarter, currency, GAAP/IFRS basis). Distinguish reported figures from adjusted/non-GAAP ones, and forecast from actual. When sources disagree on a figure, prefer the primary filing and note the discrepancy. Company guidance and analyst estimates must be labeled as such. Recency matters: market data older than a quarter gets a date flag.",
  citationFormat: "Company/Filing name, form type & period (filing date) — per filing-citation convention",
};

export const MEDICINE_PACK: DomainPack = {
  key: "medicine",
  label: "Medical",
  emoji: "🩺",
  hint: "Peer-reviewed evidence graded by study design",
  authorities: [
    "pubmed.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "who.int",
    "fda.gov",
    "ema.europa.eu",
    "cdc.gov",
    "nih.gov",
    "cochranelibrary.com",
    "nejm.org",
    "thelancet.com",
    "bmj.com",
    "jamanetwork.com",
    "clinicaltrials.gov",
    "uptodate.com",
  ],
  guidance:
    "MEDICAL EVIDENCE STANDARDS: grade evidence by study design — systematic reviews/meta-analyses and RCTs outrank cohort studies, which outrank case reports and expert opinion. Cite trials by registry number (NCT…) where available. State effect sizes with confidence intervals, not just p-values; distinguish relative from absolute risk. Population matters: results in one demographic do not automatically generalize. Guidelines (WHO/CDC/specialty bodies) carry their dates. If evidence is preliminary, preprint, or contested, say so explicitly. NEVER give clinical advice — describe the evidence base, not a treatment decision.",
  citationFormat: "Author/Study name, journal & year (trial registry if available) — per AMA-style convention",
};

const PACKS: Record<DomainKey, DomainPack> = {
  general: GENERAL_PACK,
  law: LAW_PACK,
  finance: FINANCE_PACK,
  medicine: MEDICINE_PACK,
};

export function isValidDomain(v: unknown): v is DomainKey {
  return typeof v === "string" && v in PACKS;
}

export function getDomainPack(domain: string | null | undefined): DomainPack {
  if (domain && isValidDomain(domain)) return PACKS[domain];
  return GENERAL_PACK;
}

export const DOMAIN_CHOICES: { key: DomainKey; label: string; emoji: string; hint: string }[] = [
  { key: "general", label: "General", emoji: "🌐", hint: GENERAL_PACK.hint },
  { key: "law", label: "Legal", emoji: "⚖️", hint: LAW_PACK.hint },
  { key: "finance", label: "Financial", emoji: "📊", hint: FINANCE_PACK.hint },
  { key: "medicine", label: "Medical", emoji: "🩺", hint: MEDICINE_PACK.hint },
];

/** Site-restricted query variants for an aspect's queries (P2-1 search wiring). */
export function siteVariants(queries: string[], pack: DomainPack, perQuery = 1): string[] {
  if (!pack.authorities.length) return [];
  const out: string[] = [];
  for (const q of queries) {
    // rotate through authorities so each query probes a different authority
    for (let i = 0; i < perQuery; i++) {
      const d = pack.authorities[(q.length + i) % pack.authorities.length];
      out.push(`${q} site:${d}`);
    }
  }
  return out.slice(0, 3);
}

/** Quality boost for authoritative domains (used in sourcequality scoring). */
export function authorityBoost(domain: string, pack: DomainPack): number {
  if (!pack.authorities.length) return 0;
  return pack.authorities.some((a) => domain === a.trim() || domain.endsWith(`.${a.trim()}`) || domain.includes(a.trim()))
    ? 18
    : 0;
}
