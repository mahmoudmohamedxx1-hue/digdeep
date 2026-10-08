import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface TrendingItem { title: string; url: string; domain: string; points: number; comments: number }

let cache: { at: number; items: TrendingItem[] } | null = null;
const TTL = 10 * 60_000;

/** Keyless: HackerNews front page via Algolia — powers the Perplexity-style Discover cards. */
export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json({ items: cache.items });
  try {
    const r = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=16", {
      headers: { "User-Agent": "DeepResearch-Trending/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HN ${r.status}`);
    const d = (await r.json()) as { hits: any[] };
    const seen = new Set<string>();
    const items: TrendingItem[] = [];
    for (const h of d.hits ?? []) {
      const url: string = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      let domain = "";
      try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { domain = "news.ycombinator.com"; }
      const title = String(h.title ?? "").trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      items.push({ title, url, domain, points: h.points ?? 0, comments: h.num_comments ?? 0 });
      if (items.length >= 9) break;
    }
    cache = { at: Date.now(), items };
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: cache?.items ?? [] });
  }
}
