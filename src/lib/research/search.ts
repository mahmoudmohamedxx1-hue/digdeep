/** Keyless search + page reading layer.
 *  Verticals: Bing News RSS, Wikipedia, arXiv, Crossref, HN, StackOverflow, GitHub.
 *  General web (P0): DuckDuckGo HTML (paced), SearXNG JSON, Mojeek, Marginalia,
 *  plus optional keyed engines (Google CSE 100/day free, Brave 2k/month free). */

import { db } from "@/lib/db";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  domain: string;
  /** pre-extracted content (used when the page itself is not fetchable, e.g. DOI links) */
  excerpt?: string;
  /** publication date when the engine reports one (ISO-ish string) — feeds the recency model */
  publishedAt?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** Wikimedia blocks browser-like UAs from datacenter IPs — use a descriptive bot UA. */
const WIKI_UA = "DeepResearchBot/1.0 (autonomous keyless research tool)";

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—");
}

async function timedFetch(url: string, ms = 12000, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Trim long plan-generated queries to effective keyword searches. */
function keyTerms(query: string, maxWords = 8): string {
  const stop = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "with", "what", "why", "how", "is", "are", "vs", "versus", "about"]);
  const words = query
    .replace(/["'?]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w.toLowerCase()));
  return (words.length ? words : query.split(/\s+/)).slice(0, maxWords).join(" ");
}

// ---------- Bing News RSS (keyless) ----------
export async function bingNewsSearch(query: string, limit = 8): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://www.bing.com/news/search?q=${encodeURIComponent(keyTerms(query, 8))}&format=RSS&mkt=en-US`,
      12000
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const out: SearchResult[] = [];
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
    for (const it of items) {
      if (out.length >= limit) break;
      const title = decodeEntities(((it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim());
      let link = ((it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").trim();
      const desc = decodeEntities(((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "")).trim();
      // resolve bing redirect: ...apiclick.aspx?...&url=<encoded publisher url>
      const m = link.match(/[?&]url=([^&]+)/);
      if (m) link = decodeURIComponent(m[1]);
      if (!title || !/^https?:\/\//.test(link) || /bing\.com/.test(link)) continue;
      const pubDate = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]?.trim();
      out.push({ title, url: link, snippet: desc.slice(0, 320), engine: "Bing News", domain: domainOf(link), ...(pubDate && !isNaN(Date.parse(pubDate)) ? { publishedAt: new Date(pubDate).toISOString() } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- Wikipedia (API, keyless) ----------
export async function wikipediaSearch(query: string, limit = 4): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        keyTerms(query, 6)
      )}&srlimit=${limit}&format=json`,
      12000,
      { headers: { "User-Agent": WIKI_UA } }
    );
    const data = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
    return (data.query?.search ?? []).map((r) => {
      const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`;
      return {
        title: r.title,
        url,
        snippet: decodeEntities(r.snippet.replace(/<[^>]+>/g, "")).slice(0, 320),
        engine: "Wikipedia",
        domain: "en.wikipedia.org",
      };
    });
  } catch {
    return [];
  }
}

export async function wikipediaExtract(title: string): Promise<string> {
  try {
    const res = await timedFetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(
        title
      )}&format=json`,
      15000,
      { headers: { "User-Agent": WIKI_UA } }
    );
    const data = (await res.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
    const pages = data.query?.pages ?? {};
    const first = Object.values(pages)[0];
    return (first?.extract ?? "").slice(0, 12000);
  } catch {
    return "";
  }
}

// ---------- arXiv (API, keyless) ----------
export async function arxivSearch(query: string, limit = 4): Promise<SearchResult[]> {
  try {
    const q = keyTerms(query, 10).replace(/["']/g, "");
    const res = await timedFetch(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${limit}&sortBy=relevance`,
      15000
    );
    const xml = await res.text();
    const out: SearchResult[] = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(xml)) && out.length < limit) {
      const e = m[1];
      const id = (e.match(/<id>([^<]+)<\/id>/) || [])[1] ?? "";
      const title = decodeEntities(((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "").replace(/\s+/g, " ").trim());
      const summary = decodeEntities(((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] ?? "").replace(/\s+/g, " ").trim());
      if (id && title) out.push({ title, url: id.replace("http://", "https://"), snippet: summary.slice(0, 320), engine: "arXiv", domain: "arxiv.org", excerpt: summary.slice(0, 1800) });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- Crossref (API, keyless) ----------
export async function crossrefSearch(query: string, limit = 3): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://api.crossref.org/works?query=${encodeURIComponent(keyTerms(query, 10))}&rows=${limit}&select=title,URL,abstract,container-title,issued`,
      12000,
      { headers: { "User-Agent": "DeepResearch/1.0 (keyless research tool)" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { message?: { items?: { title?: string[]; URL?: string; abstract?: string; "container-title"?: string[]; issued?: { "date-parts"?: number[][] } }[] } };
    return (data.message?.items ?? [])
      .filter((it) => it.title?.[0] && it.URL)
      .map((it) => {
        const abs = decodeEntities((it.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        const year = it.issued?.["date-parts"]?.[0]?.[0];
        return {
          title: it.title![0].slice(0, 200),
          url: it.URL!,
          snippet: `${it["container-title"]?.[0] ?? "Journal"}${year ? ` · ${year}` : ""}. ${abs}`.slice(0, 320),
          engine: "Crossref",
          domain: "doi.org",
          excerpt: abs.slice(0, 1600),
        };
      });
  } catch {
    return [];
  }
}

// ---------- Hacker News (Algolia API, keyless) ----------
export async function hnSearch(query: string, limit = 3): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyTerms(query, 5))}&tags=story&hitsPerPage=${limit}`,
      10000
    );
    const data = (await res.json()) as { hits?: { title?: string; url?: string; objectID: string; points?: number }[] };
    return (data.hits ?? [])
      .filter((h) => h.title)
      .map((h) => ({
        title: h.title!,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: `Hacker News discussion · ${h.points ?? 0} points`,
        engine: "HackerNews",
        domain: domainOf(h.url || "https://news.ycombinator.com"),
      }));
  } catch {
    return [];
  }
}

// ---------- StackOverflow (API, keyless) ----------
export async function stackSearch(query: string, limit = 2): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(keyTerms(query, 6))}&site=stackoverflow&pagesize=${limit}&filter=default`,
      10000
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: { title?: string; link?: string; score?: number; is_answered?: boolean; tags?: string[] }[] };
    return (data.items ?? [])
      .filter((it) => it.title && it.link)
      .map((it) => ({
        title: decodeEntities(it.title!),
        url: it.link!,
        snippet: `StackOverflow · score ${it.score ?? 0}${it.is_answered ? " · answered" : ""}${it.tags?.length ? ` · ${it.tags.slice(0, 3).join(", ")}` : ""}`,
        engine: "StackOverflow",
        domain: "stackoverflow.com",
      }));
  } catch {
    return [];
  }
}

// ---------- GitHub (API, keyless) ----------
export async function githubSearch(query: string, limit = 2): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(keyTerms(query, 4))}&per_page=${limit}&sort=stars`,
      10000,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "DeepResearch" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: { full_name?: string; html_url?: string; description?: string; stargazers_count?: number }[] };
    return (data.items ?? [])
      .filter((it) => it.full_name && it.html_url)
      .map((it) => ({
        title: `GitHub: ${it.full_name} (★ ${it.stargazers_count ?? 0})`,
        url: it.html_url!,
        snippet: (it.description ?? "").slice(0, 280),
        engine: "GitHub",
        domain: "github.com",
      }));
  } catch {
    return [];
  }
}

/** ==================================================================
 *  GENERAL WEB SEARCH LAYER (P0) — the whole-web engines.
 *  The verticals above (news/wikipedia/arxiv/…) are deep but narrow;
 *  these engines make digdeep a whole-web research tool.
 *  ================================================================== */

export interface SearchSettings {
  ddg: boolean;
  searxngInstances: string[]; // user-added SearXNG instances (JSON API enabled)
  mojeek: boolean;
  marginalia: boolean;
  braveKey?: string;
  googleCseKey?: string;
  googleCseCx?: string;
}

const DEFAULT_SEARCH_SETTINGS: SearchSettings = { ddg: true, searxngInstances: [], mojeek: true, marginalia: true };

let searchSettingsCache: { at: number; data: SearchSettings } | null = null;

export async function getSearchSettings(force = false): Promise<SearchSettings> {
  if (!force && searchSettingsCache && Date.now() - searchSettingsCache.at < 30_000) return searchSettingsCache.data;
  let data = DEFAULT_SEARCH_SETTINGS;
  try {
    const row = await db.setting.findUnique({ where: { key: "search_settings" } });
    if (row) {
      const parsed = JSON.parse(row.value);
      data = {
        ddg: parsed.ddg !== false,
        searxngInstances: Array.isArray(parsed.searxngInstances) ? parsed.searxngInstances.filter((x: unknown) => typeof x === "string").slice(0, 5) : [],
        mojeek: parsed.mojeek !== false,
        marginalia: parsed.marginalia !== false,
        braveKey: typeof parsed.braveKey === "string" && parsed.braveKey.trim() ? parsed.braveKey.trim() : undefined,
        googleCseKey: typeof parsed.googleCseKey === "string" && parsed.googleCseKey.trim() ? parsed.googleCseKey.trim() : undefined,
        googleCseCx: typeof parsed.googleCseCx === "string" && parsed.googleCseCx.trim() ? parsed.googleCseCx.trim() : undefined,
      };
    }
  } catch { /* defaults */ }
  searchSettingsCache = { at: Date.now(), data };
  return data;
}

export function invalidateSearchSettingsCache() {
  searchSettingsCache = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ---------- DuckDuckGo HTML (keyless general web, heavily rate-shaped) ----------
 *  html.duckduckgo.com serves ~1-2 requests per IP then serves an "anomaly"
 *  page (HTTP 202) / refuses connections for a while. A process-wide pacer
 *  keeps it healthy: minimum interval between requests, anomaly cooldown,
 *  and a bounded queue wait so a search round never stalls for it. */
const DDG_MIN_INTERVAL_MS = 22_000;
const DDG_COOLDOWN_MS = 3 * 60_000;
let ddgLastAt = 0;
let ddgCooldownUntil = 0;

async function ddgGate(): Promise<boolean> {
  if (Date.now() < ddgCooldownUntil) return false;
  const waitMs = Math.max(0, ddgLastAt + DDG_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 12_000) return false; // never stall a search round for DDG — skip instead
  if (waitMs > 0) await sleep(waitMs);
  ddgLastAt = Date.now();
  return true;
}

export async function ddgSearch(query: string, limit = 8): Promise<SearchResult[]> {
  try {
    if (!(await ddgGate())) return [];
    const res = await timedFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyTerms(query, 10))}`, 14000, {
      headers: { Accept: "text/html" },
    });
    const html = await res.text();
    // DDG anomaly / bot-page: HTTP 202 or the anomaly marker — back off for minutes
    if (res.status === 202 || /anomaly|unfortunately, bots/i.test(html.slice(0, 4000))) {
      ddgCooldownUntil = Date.now() + DDG_COOLDOWN_MS;
      return [];
    }
    if (!res.ok) return [];
    const out: SearchResult[] = [];
    const linkRe = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && out.length < limit) {
      let url = m[1].replace(/&amp;/g, "&");
      const uddg = url.match(/uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//.test(url) || /duckduckgo\.com/.test(url)) continue;
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
      if (!title) continue;
      // snippet lives after the link in the same result block
      const after = html.slice(m.index, m.index + 2400);
      const snip = after.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      out.push({
        title: title.slice(0, 200),
        url,
        snippet: decodeEntities((snip?.[1] ?? "").replace(/<[^>]+>/g, "")).trim().slice(0, 320),
        engine: "Web (DuckDuckGo)",
        domain: domainOf(url),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** ---------- SearXNG (open-source metasearch, JSON API) ----------
 *  Public instances are reached best from residential IPs; datacenter IPs often
 *  get 429s. A small default list + user-added instances (settings) are tried
 *  in order with per-instance failure memory. */
const SEARXNG_DEFAULT = ["https://priv.au", "https://search.rhscz.eu", "https://searx.be"];
const searxngFailures = new Map<string, { n: number; until: number }>();

export async function searxngSearch(query: string, limit = 8, extraInstances: string[] = []): Promise<SearchResult[]> {
  const instances = [...extraInstances, ...SEARXNG_DEFAULT]
    .map((u) => u.replace(/\/+$/, ""))
    .filter((u, i, arr) => arr.indexOf(u) === i);
  for (const base of instances) {
    const f = searxngFailures.get(base);
    if (f && (f.n >= 3 || Date.now() < f.until)) continue; // dead from this host for a while
    try {
      const res = await timedFetch(`${base}/search?q=${encodeURIComponent(keyTerms(query, 10))}&format=json&language=en`, 10000, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 429 || res.status === 403) {
        searxngFailures.set(base, { n: (f?.n ?? 0) + 1, until: Date.now() + 10 * 60_000 });
        continue;
      }
      if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) {
        searxngFailures.set(base, { n: (f?.n ?? 0) + 1, until: f?.until ?? 0 });
        continue;
      }
      const data = (await res.json()) as { results?: { url?: string; title?: string; content?: string; publishedDate?: string; is_answer?: boolean }[] };
      const rs = (data.results ?? [])
        .filter((r) => r.url && r.title && !r.is_answer && !/searx/i.test(domainOf(r.url!)))
        .slice(0, limit)
        .map((r) => ({
          title: decodeEntities(r.title!).slice(0, 200),
          url: r.url!,
          snippet: decodeEntities(r.content ?? "").slice(0, 320),
          engine: "Web (SearXNG)",
          domain: domainOf(r.url!),
          ...(r.publishedDate && !isNaN(Date.parse(r.publishedDate)) ? { publishedAt: new Date(r.publishedDate).toISOString() } : {}),
        }));
      if (rs.length > 0) {
        searxngFailures.delete(base);
        return rs;
      }
    } catch {
      searxngFailures.set(base, { n: (f?.n ?? 0) + 1, until: f?.until ?? 0 });
    }
  }
  return [];
}

/** ---------- Mojeek (independent index, keyless HTML) ---------- */
export async function mojeekSearch(query: string, limit = 5): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(keyTerms(query, 10))}`, 12000, {
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out: SearchResult[] = [];
    const blockRe = /<h2><a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]{0,600}?)(?=<h2>|<\/ul>|<\/section|$)/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) && out.length < limit) {
      const url = m[1].replace(/&amp;/g, "&");
      if (/mojeek\.com/.test(url)) continue;
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
      if (!title) continue;
      const snip = m[3].match(/<p[^>]*class="s[^"]*"[^>]*>([\s\S]*?)<\/p>/) ?? m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
      out.push({
        title: title.slice(0, 200),
        url,
        snippet: decodeEntities((snip?.[1] ?? "").replace(/<[^>]+>/g, "")).trim().slice(0, 320),
        engine: "Web (Mojeek)",
        domain: domainOf(url),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** ---------- Marginalia (independent indie-web index, public API key) ---------- */
export async function marginaliaSearch(query: string, limit = 4, apiKey = "public"): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://api.marginalia-search.com/${encodeURIComponent(apiKey)}/search/${encodeURIComponent(keyTerms(query, 8))}?limit=${limit}`,
      12000,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: { url?: string; title?: string; description?: string }[] };
    return (data.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, limit)
      .map((r) => ({
        title: decodeEntities(r.title!).slice(0, 200),
        url: r.url!,
        snippet: decodeEntities(r.description ?? "").slice(0, 320),
        engine: "Marginalia",
        domain: domainOf(r.url!),
      }));
  } catch {
    return [];
  }
}

/** ---------- Brave Search API (optional key — 2,000 free queries/month) ---------- */
export async function braveSearch(query: string, key: string, limit = 8): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(keyTerms(query, 10))}&count=${limit}&country=us`,
      12000,
      { headers: { Accept: "application/json", "X-Subscription-Token": key } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] } };
    return (data.web?.results ?? [])
      .filter((r) => r.url && r.title)
      .slice(0, limit)
      .map((r) => {
        const desc = (r.description ?? "").replace(/<[^>]+>/g, "");
        // age like "2 days ago" / "3 months ago" → rough ISO
        let publishedAt: string | undefined;
        const ag = r.age?.match(/(\d+)\s+(day|week|month|year)/i);
        if (ag) {
          const mult = /day/i.test(ag[2]) ? 1 : /week/i.test(ag[2]) ? 7 : /month/i.test(ag[2]) ? 30 : 365;
          publishedAt = new Date(Date.now() - Number(ag[1]) * mult * 86_400_000).toISOString();
        }
        return { title: decodeEntities(r.title!).slice(0, 200), url: r.url!, snippet: desc.slice(0, 320), engine: "Web (Brave)", domain: domainOf(r.url!), ...(publishedAt ? { publishedAt } : {}) };
      });
  } catch {
    return [];
  }
}

/** ---------- Google Custom Search JSON API (optional key — 100 free queries/day) ---------- */
export async function googleCseSearch(query: string, key: string, cx: string, limit = 6): Promise<SearchResult[]> {
  try {
    const res = await timedFetch(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(keyTerms(query, 10))}&num=${Math.min(10, limit)}`,
      12000,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: { title?: string; link?: string; snippet?: string }[] };
    return (data.items ?? [])
      .filter((r) => r.link && r.title)
      .slice(0, limit)
      .map((r) => ({ title: decodeEntities(r.title!).slice(0, 200), url: r.link!, snippet: decodeEntities(r.snippet ?? "").slice(0, 320), engine: "Web (Google CSE)", domain: domainOf(r.link!) }));
  } catch {
    return [];
  }
}

// ---------- Page fetching + text extraction ----------
export interface PageContent {
  title: string;
  text: string;
  words: number;
  domain: string;
  /** Outbound/in-page links discovered in the page (WebWalker-style traversal candidates). */
  links: { url: string; text: string }[];
}

/** ------------------------------------------------------------------
 *  WebWalker-style link extraction (inspired by Alibaba-NLP/WebWalker):
 *  harvest followable <a href> links from a fetched page so the engine can
 *  "click" promising ones and go deeper than search snippets.
 *  ------------------------------------------------------------------ */
const JUNK_LINK_RE =
  /javascript:|mailto:|tel:|\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|zip|rar|tar|gz|mp4|mp3|pdf|dmg|exe|apk)([?#].*)?$/i;
const NAV_LINK_RE =
  /(facebook|twitter|x\.com|instagram|linkedin|youtube|tiktok|pinterest|reddit)\.|\/(login|signin|signup|register|subscribe|newsletter|privacy|terms|cookie|advert|share|comment)/i;

export function extractLinks(html: string, baseUrl: string, limit = 24): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const raw = decodeEntities(m[1].trim());
    if (!raw || JUNK_LINK_RE.test(raw)) continue;
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const url = u.toString().replace(/[#?].*$/, "");
    const key = url.replace(/\/$/, "");
    if (key === base.toString().replace(/[#?].*$/, "").replace(/\/$/, "")) continue; // self
    if (seen.has(key) || /bing\.com|google\.com|duckduckgo\.com/.test(key)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text.length < 3 || text.length > 140) continue;
    if (NAV_LINK_RE.test(url) || NAV_LINK_RE.test(text)) continue;
    seen.add(key);
    out.push({ url, text });
  }
  return out;
}

export function htmlToText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  return t
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchPageContent(url: string, maxWords = 3200, preloadedExcerpt?: string): Promise<PageContent | null> {
  try {
    if (url.includes("en.wikipedia.org/wiki/")) {
      const title = decodeURIComponent(url.split("/wiki/")[1] || "").replace(/_/g, " ");
      const extract = await wikipediaExtract(title);
      if (extract) {
        const words = extract.split(/\s+/).length;
        return { title, text: extract.split(/\s+/).slice(0, maxWords).join(" "), words, domain: "en.wikipedia.org", links: [] };
      }
    }
    const res = await timedFetch(url, 14000, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || (!ct.includes("html") && !ct.includes("text"))) {
      // fall back to pre-extracted excerpt (e.g. Crossref abstract)
      if (preloadedExcerpt && preloadedExcerpt.split(/\s+/).length > 60) {
        return { title: domainOf(url), text: preloadedExcerpt.split(/\s+/).slice(0, maxWords).join(" "), words: preloadedExcerpt.split(/\s+/).length, domain: domainOf(url), links: [] };
      }
      return null;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 900_000) return null;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const title = decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 200);
    const text = htmlToText(html);
    const words = text.split(/\s+/).length;
    if (words < 80) {
      if (preloadedExcerpt && preloadedExcerpt.split(/\s+/).length > 60) {
        return { title: title || domainOf(url), text: preloadedExcerpt.split(/\s+/).slice(0, maxWords).join(" "), words: preloadedExcerpt.split(/\s+/).length, domain: domainOf(url), links: [] };
      }
      return null;
    }
    return { title: title || domainOf(url), text: text.split(/\s+/).slice(0, maxWords).join(" "), words, domain: domainOf(url), links: extractLinks(html, url) };
  } catch {
    if (preloadedExcerpt && preloadedExcerpt.split(/\s+/).length > 60) {
      return { title: domainOf(url), text: preloadedExcerpt.split(/\s+/).slice(0, maxWords).join(" "), words: preloadedExcerpt.split(/\s+/).length, domain: domainOf(url), links: [] };
    }
    return null;
  }
}

/** Run all engines for a query in parallel, deduped by URL, interleaved round-robin across engines.
 *  P0 query-type router: general-web engines run on every query; academic verticals
 *  when the plan is academic; news/verticals always (they're cheap and reliable). */
export async function searchAll(query: string, opts: { academic?: boolean } = {}): Promise<SearchResult[]> {
  const ss = await getSearchSettings();
  const jobs: Promise<SearchResult[]>[] = [
    bingNewsSearch(query, 8),
    wikipediaSearch(query, 4),
    hnSearch(query, 3),
    stackSearch(query, 2),
    githubSearch(query, 2),
    // ---- general web layer (whole-web coverage) ----
    ...(ss.ddg ? [ddgSearch(query, 8)] : []),
    searxngSearch(query, 8, ss.searxngInstances),
    ...(ss.mojeek ? [mojeekSearch(query, 5)] : []),
    ...(ss.marginalia ? [marginaliaSearch(query, 4)] : []),
    ...(ss.braveKey ? [braveSearch(query, ss.braveKey, 8)] : []),
    ...(ss.googleCseKey && ss.googleCseCx ? [googleCseSearch(query, ss.googleCseKey, ss.googleCseCx, 6)] : []),
  ];
  if (opts.academic) jobs.push(arxivSearch(query, 4), crossrefSearch(query, 3));
  else jobs.push(arxivSearch(query, 2));
  const settled = await Promise.allSettled(jobs);
  const seen = new Set<string>();
  const byEngine: SearchResult[][] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const group: SearchResult[] = [];
    for (const r of s.value) {
      const key = r.url.replace(/[#?].*$/, "");
      if (!seen.has(key) && !/bing\.com|google\.com/.test(key)) {
        seen.add(key);
        group.push({ ...r, url: key });
      }
    }
    if (group.length) byEngine.push(group);
  }
  // round-robin interleave so downstream picking reads from every engine, not just the first
  const out: SearchResult[] = [];
  let idx = 0;
  while (out.length < 44) {
    let added = false;
    for (const g of byEngine) {
      if (idx < g.length) {
        out.push(g[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx++;
  }
  return out;
}
