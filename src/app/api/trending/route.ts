import { NextResponse } from "next/server";
import { bingNewsSearch } from "@/lib/research/search";

export const dynamic = "force-dynamic";

export type Lane = "hn" | "showhn" | "news" | "wiki";
export interface TrendingItem {
  lane: Lane;
  title: string;
  url: string;
  domain: string;
  points?: number;
  comments?: number;
  /** minutes since the story appeared (HN created_at / Bing pubDate) */
  ageMinutes?: number;
}

/** last-good copy per lane — one feed failing must not blank the page */
const lastGood = new Map<Lane, { at: number; items: TrendingItem[] }>();

const HN_UA = "DeepResearch-Trending/1.0 (keyless research app; https://digdeep.app)";

function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "news.ycombinator.com";
  }
}

function ageMin(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (isNaN(t)) return undefined;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

/** HN front page — the flagship tech feed. */
async function hnFrontPage(): Promise<TrendingItem[]> {
  const r = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=16", {
    headers: { "User-Agent": HN_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HN ${r.status}`);
  const d = (await r.json()) as { hits: any[] };
  const items: TrendingItem[] = [];
  const seen = new Set<string>();
  for (const h of d.hits ?? []) {
    const url: string = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    const title = String(h.title ?? "").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    items.push({
      lane: "hn",
      title,
      url,
      domain: domainOf(url),
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      ageMinutes: ageMin(h.created_at),
    });
    if (items.length >= 10) break;
  }
  return items;
}

/** Show HN — fresh maker projects (last 4 days, newest first). */
async function showHn(): Promise<TrendingItem[]> {
  const since = Math.floor((Date.now() - 4 * 86_400_000) / 1000);
  const r = await fetch(
    `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=14&numericFilters=created_at_i>${since},points>30`,
    { headers: { "User-Agent": HN_UA }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`ShowHN ${r.status}`);
  const d = (await r.json()) as { hits: any[] };
  const items: TrendingItem[] = [];
  const seen = new Set<string>();
  for (const h of d.hits ?? []) {
    const url: string = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
    const title = String(h.title ?? "").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    items.push({
      lane: "showhn",
      title,
      url,
      domain: domainOf(url),
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      ageMinutes: ageMin(h.created_at),
    });
    if (items.length >= 6) break;
  }
  return items;
}

/** Bing News RSS across four beats — the general-news lane. Single-word beats
 *  return an empty RSS, so these are multi-word; index pages ("World News",
 *  "Research News") and anything older than 3 days are filtered out. */
async function newsLane(): Promise<TrendingItem[]> {
  const beats = ["technology industry news", "business and economy news", "science and research news", "world news today"];
  const rs = await Promise.allSettled(beats.map((b) => bingNewsSearch(b, 6)));
  const items: TrendingItem[] = [];
  const seen = new Set<string>();
  const perDomain = new Map<string, number>();
  for (const s of rs) {
    if (s.status !== "fulfilled") continue;
    for (const r of s.value) {
      if (!r.url || seen.has(r.title) || seen.has(r.url)) continue;
      // freshness: Discover is a "now" page — anything older than 3 days is a archive hit
      const age = ageMin(r.publishedAt);
      if (age == null || age > 3 * 24 * 60) continue;
      // index pages: bare category names ("World News", "Research News") — not stories
      if (r.title.trim().split(/\s+/).length < 4) continue;
      const dc = perDomain.get(r.domain) ?? 0;
      if (dc >= 2) continue;
      perDomain.set(r.domain, dc + 1);
      seen.add(r.title);
      seen.add(r.url);
      items.push({ lane: "news", title: r.title, url: r.url, domain: r.domain || domainOf(r.url), ageMinutes: age });
    }
  }
  items.sort((a, b) => (a.ageMinutes ?? 999) - (b.ageMinutes ?? 999)); // freshest first
  return items.slice(0, 10);
}

/** Wikipedia most-read yesterday — the curiosity lane. The pageviews/top
 *  endpoint 301s to a docs page now; the featured feed for YESTERDAY carries
 *  the `mostread` section (43 top articles of the day before), live-verified. */
async function wikiLane(): Promise<TrendingItem[]> {
  const day = new Date(Date.now() - 86_400_000);
  const yyyy = day.getUTCFullYear();
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day.getUTCDate()).padStart(2, "0");
  const r = await fetch(
    `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${yyyy}/${mm}/${dd}`,
    { headers: { "User-Agent": HN_UA }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`Wiki feed ${r.status}`);
  const d = (await r.json()) as {
    mostread?: { articles?: { title: string; normalizedtitle?: string; views: number; content_urls?: { desktop?: { page?: string } } }[] };
  };
  const arts = d.mostread?.articles ?? [];
  const skip = /^(Main_Page|Special:|Portal:|Wikipedia:|File:|Category:|Talk:|Template:|Help:)/i;
  const items: TrendingItem[] = [];
  for (const a of arts) {
    const raw = String(a.title ?? "");
    const title = String(a.normalizedtitle || raw).replace(/_/g, " ").trim();
    if (!title || skip.test(raw) || raw.includes(":")) continue;
    const url = a.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(raw)}`;
    items.push({
      lane: "wiki",
      title,
      url,
      domain: "en.wikipedia.org",
      points: a.views ?? 0, // reuse the points slot: rendered as "N views" for the wiki lane
    });
    if (items.length >= 12) break;
  }
  return items;
}

const FEEDS: { lane: Lane; run: () => Promise<TrendingItem[]> }[] = [
  { lane: "hn", run: hnFrontPage },
  { lane: "showhn", run: showHn },
  { lane: "news", run: newsLane },
  { lane: "wiki", run: wikiLane },
];

/** Keyless multi-source Discover feed: HN front page + Show HN + Bing News + Wikipedia top-viewed.
 *  Each lane fails over to its last good copy independently — one dead feed never blanks the page. */
export async function GET() {
  const lanes: Record<string, TrendingItem[]> = {};
  const degraded: string[] = [];
  await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const items = await f.run();
        lanes[f.lane] = items;
        if (items.length > 0) lastGood.set(f.lane, { at: Date.now(), items });
      } catch {
        const prev = lastGood.get(f.lane);
        if (prev && Date.now() - prev.at < 60 * 60_000) {
          lanes[f.lane] = prev.items;
          degraded.push(f.lane);
        } else {
          lanes[f.lane] = [];
          degraded.push(f.lane);
        }
      }
    })
  );
  const items = [
    ...(lanes.hn ?? []),
    ...(lanes.showhn ?? []),
    ...(lanes.news ?? []),
    ...(lanes.wiki ?? []),
  ];
  return NextResponse.json({ items, degraded });
}
