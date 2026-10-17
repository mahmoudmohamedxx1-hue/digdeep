"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight, BookOpen, Compass, Cpu, FlaskConical, Landmark, MessageSquare,
  Newspaper, RefreshCw, Rocket, Search, ShieldCheck, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Favicon } from "@/components/pplx/sources-row";
import { StaggerIn } from "@/components/magic";
import { useOnline } from "@/hooks/use-online";

type Lane = "hn" | "showhn" | "news" | "wiki";

interface TrendingItem {
  lane: Lane;
  title: string;
  url: string;
  domain: string;
  points?: number;
  comments?: number;
  ageMinutes?: number;
}

/** Source lanes — what the feed is made of. */
const LANES: { id: Lane; label: string; icon: typeof Rocket; hint: string }[] = [
  { id: "hn", label: "Front page", icon: Newspaper, hint: "Hacker News front page — tech's main street" },
  { id: "showhn", label: "Show HN", icon: Rocket, hint: "Fresh maker projects, last few days" },
  { id: "news", label: "News", icon: Compass, hint: "Bing News across technology, business, science" },
  { id: "wiki", label: "On Wikipedia", icon: BookOpen, hint: "Yesterday's most-read articles" },
];

/** Category rules — a story lands in the first bucket whose domain/keyword matches. */
const CATEGORIES: { id: string; label: string; icon: typeof Rocket; test: (t: TrendingItem) => boolean }[] = [
  {
    id: "ai", label: "AI & models", icon: Cpu,
    test: (t) =>
      /arxiv\.org|openai|anthropic|huggingface|deepmind|stability\.ai/i.test(t.domain) ||
      /\b(ai|llm|gpt|claude|gemini|deepseek|llama|mistral|qwen|grok|model|models|neural|inference|training|agent|agents|transformer|diffusion|chatbot|speech|whisper|transcri|tokenizer|embedding|fine-?tun|prompt|copilot)\b/i.test(t.title),
  },
  {
    id: "oss", label: "Open source", icon: Wrench,
    test: (t) =>
      /github|gitlab|sourceforge|git\./i.test(t.domain) ||
      /^show hn|\b(open.?source|license|repo|repository|maintainer|fork|self.?host)\b/i.test(t.title) ||
      t.lane === "showhn",
  },
  {
    id: "security", label: "Security", icon: ShieldCheck,
    test: (t) => /\b(breach|breached|vulnerab|cve-|exploit|hack|hacked|hackers|ransomware|malware|zero.?day|patched|phishing|leaked|dumped|privacy)\b/i.test(t.title),
  },
  {
    id: "hardware", label: "Hardware", icon: Cpu,
    test: (t) => /\b(chip|chips|cpu|gpu|tsmc|semiconductor|nvidia|amd|arm|risc-v|fpga|battery|batteries|silicon|asml|lithograph|drone|robot|robotics|satellite|ev|charging)\b/i.test(t.title),
  },
  {
    id: "science", label: "Science", icon: FlaskConical,
    test: (t) => /nature\.com|science\.org|nih\.gov|nasa|esa|quantum|physic|protein|crispr|genome|telescope|fusion|climate|carbon|clinical|trial|study finds|researchers/i.test(`${t.domain} ${t.title}`),
  },
  {
    id: "business", label: "Business", icon: Landmark,
    test: (t) => /\b(funding|raises|raised|ipo|acquisition|acquires|acquired|startup|valuation|revenue|layoffs|profit|pricing|subscription|billion|million deal|economy|inflation|market)\b/i.test(t.title),
  },
];

function categorize(t: TrendingItem): string {
  for (const c of CATEGORIES) if (c.test(t)) return c.id;
  return "tech";
}

/** The research angle — an honest, templated line about how digdeep would
 *  attack the story. Deterministic (lane + category + title shape), never fake-AI. */
function researchAngle(t: TrendingItem, cat: string): string {
  if (/^show hn/i.test(t.title)) return "Who built it, what does it replace, and is anyone using it for real?";
  if (/^(why|how|what)\b/i.test(t.title)) return `${t.title.replace(/[?.!]+$/, "")} — traced through primary sources, not summaries.`;
  switch (cat) {
    case "ai": return "Do the benchmarks hold up outside the vendor's own table — and what do skeptics measure instead?";
    case "oss": return "How mature is it really: release cadence, maintainer load, and who ships it in production.";
    case "security": return "What was actually exposed, who exploited it first, and what the mitigations cost.";
    case "hardware": return "Follow the supply chain: yields, orders, and the physics that limit the roadmap.";
    case "science": return "Replication status, effect sizes, and what the field's critics say about the method.";
    case "business": return "The real economics behind the headline: unit costs, concentration, and who pays.";
    default: return "The full story — primary sources, the numbers that matter, and what quietly changed.";
  }
}

function fmtAge(min?: number): string {
  if (min == null) return "";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

export default function DiscoverPage() {
  const router = useRouter();
  const online = useOnline();
  const [items, setItems] = useState<TrendingItem[] | null>(null); // null = loading
  const [failed, setFailed] = useState(false);
  const [lane, setLane] = useState<Lane | "all">("all");
  const [tab, setTab] = useState<string>("all");
  const [feedQuery, setFeedQuery] = useState("");

  const load = useCallback(async () => {
    setFailed(false);
    setItems(null);
    try {
      const r = await fetch("/api/trending");
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setItems((d.items ?? []) as TrendingItem[]);
      if (!Array.isArray(d.items) || d.items.length === 0) throw new Error("empty");
    } catch {
      setFailed(true);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // decorate once: category per story
  const decorated = useMemo(
    () => (items ?? []).map((t) => ({ ...t, cat: categorize(t) })),
    [items]
  );

  const laneCounts = useMemo(() => {
    const m: Record<string, number> = { all: decorated.length };
    for (const l of LANES) m[l.id] = 0;
    for (const d of decorated) m[d.lane] = (m[d.lane] ?? 0) + 1;
    return m;
  }, [decorated]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = { all: 0, tech: 0 };
    for (const c of CATEGORIES) m[c.id] = 0;
    for (const d of decorated) m[d.cat] = (m[d.cat] ?? 0) + 1;
    return m;
  }, [decorated]);

  // three orthogonal filters: source lane × category × text
  const visible = useMemo(() => {
    const q = feedQuery.trim().toLowerCase();
    return decorated.filter((d) => {
      if (lane !== "all" && d.lane !== lane) return false;
      if (tab !== "all" && d.cat !== tab) return false;
      if (q && !`${d.title} ${d.domain}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [decorated, lane, tab, feedQuery]);

  const askAbout = (title: string) => {
    sessionStorage.setItem("digdeep:prefill", title);
    router.push("/");
  };

  const laneTabs = [{ id: "all" as const, label: "All", icon: Compass }, ...LANES].filter(
    (l) => l.id === "all" || (laneCounts[l.id] ?? 0) > 0
  );
  const catTabs = [
    { id: "all", label: "All", count: catCounts.all },
    { id: "tech", label: "Tech", count: catCounts.tech },
    ...CATEGORIES.filter((c) => (catCounts[c.id] ?? 0) > 0).map((c) => ({ id: c.id, label: c.label, count: catCounts[c.id] ?? 0 })),
  ];

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-10 sm:pt-14">
      <div className="flex items-center gap-2">
        <Compass className="h-4 w-4 text-primary" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Discover</h1>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Four feeds, one page — Hacker News, fresh Show HN projects, live news, and what the world read on Wikipedia yesterday. Tap a card to dig in.
      </p>

      {/* loading skeletons */}
      {items == null && (
        <div className="mt-6 space-y-2.5" aria-label="Loading stories">
          {[...Array(8)].map((_, i) => <div key={i} className="skeleton-line h-[108px] rounded-[18px]" />)}
        </div>
      )}

      {/* designed error state */}
      {failed && (
        <div className="mt-10 flex flex-col items-center gap-4 rounded-[20px] border border-dashed py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-primary/10 text-primary">
            <Compass className="h-7 w-7" strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-sm font-semibold">{online ? "Couldn't load what's trending" : "You're offline"}</p>
            <p className="mx-auto mt-1.5 max-w-[320px] text-[12px] leading-relaxed text-muted-foreground">
              {online
                ? "The trending feeds didn't answer. They might be rate-limiting us — retry in a moment."
                : "The trending feeds need a connection. Your saved threads stay available — reconnect and retry."}
            </p>
          </div>
          <Button size="sm" variant="outline" className="press-scale gap-1.5 rounded-full" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        </div>
      )}

      {/* filters: text search + lane chips + category chips (only when loaded) */}
      {items != null && !failed && (
        <>
          <div className="sticky top-[57px] z-20 -mx-4 mt-5 bg-background/85 px-4 backdrop-blur-lg md:top-0">
            <div className="flex items-center gap-2 pt-2 pb-1.5">
              <span className="relative flex flex-1 items-center">
                <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" aria-hidden />
                <input
                  value={feedQuery}
                  onChange={(e) => setFeedQuery(e.target.value)}
                  placeholder="Filter the feed…"
                  aria-label="Filter stories"
                  className="h-9 w-full rounded-full border border-border/80 bg-card pl-9 pr-4 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50"
                />
              </span>
              <Button size="sm" variant="ghost" className="press-scale h-9 w-9 rounded-full p-0" title="Refresh feeds" onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <div className="slim-scroll flex gap-1.5 overflow-x-auto pb-2" role="tablist" aria-label="Source feeds">
              {laneTabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={lane === t.id}
                  onClick={() => setLane(t.id as Lane | "all")}
                  title={LANES.find((l) => l.id === t.id)?.hint ?? "Every feed together"}
                  className={`press-scale flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors ${
                    lane === t.id
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/80 bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                  <span className="text-[10.5px] tabular-nums opacity-60">{laneCounts[t.id] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="slim-scroll flex gap-1.5 overflow-x-auto pb-2" role="tablist" aria-label="Story categories">
              {catTabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`press-scale flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors ${
                    tab === t.id
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/80 bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {CATEGORIES.find((c) => c.id === t.id)?.label ? <span className="h-3.5 w-3.5" aria-hidden /> : null}
                  {t.label}
                  <span className="text-[10.5px] tabular-nums opacity-60">{t.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* stories — editorial cards, no ranking numbers */}
          {visible.length > 0 && (
            <div className="mt-5 space-y-2.5">
              {visible.map((t, i) => {
                const catDef = CATEGORIES.find((c) => c.id === t.cat);
                const laneDef = LANES.find((l) => l.id === t.lane);
                const LaneIcon = laneDef?.icon ?? Newspaper;
                const CatIcon = catDef?.icon ?? Compass;
                const catLabel = catDef?.label ?? "Tech";
                return (
                  <StaggerIn key={t.url} index={Math.min(i, 8)} y={10}>
                    <button
                      onClick={() => askAbout(t.title)}
                      className="surface-card hover-lift group flex w-full flex-col gap-2.5 rounded-[18px] p-4 text-left transition-colors hover:border-primary/30"
                      title={`Research: ${t.title}`}
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span dir="auto" className="line-clamp-2 text-[14.5px] font-medium leading-snug">{t.title}</span>
                        <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:text-primary" aria-hidden />
                      </span>
                      {/* the research angle — why this story is worth a real dig */}
                      <span className="flex items-start gap-2 rounded-[12px] bg-primary/[0.055] px-3 py-2 dark:bg-primary/[0.09]">
                        <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
                        <span className="text-[12px] leading-relaxed text-foreground/75">{researchAngle(t, t.cat)}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                          <LaneIcon className="h-3 w-3" /> {laneDef?.label ?? t.lane}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <Favicon domain={t.domain} className="h-3.5 w-3.5" />
                          <span className="max-w-[180px] truncate">{t.domain}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
                          <CatIcon className="h-3 w-3" /> {catLabel}
                        </span>
                        {t.lane !== "wiki" && (t.comments ?? 0) > 0 && (
                          <span className="inline-flex items-center gap-1.5 opacity-80">
                            <MessageSquare className="h-3 w-3" aria-hidden /> {t.comments}
                          </span>
                        )}
                        {t.lane === "wiki" ? (
                          <span className="opacity-60">{((t.points ?? 0) / 1000).toFixed(0)}k views</span>
                        ) : (
                          <span className="opacity-60">
                            {t.ageMinutes != null ? fmtAge(t.ageMinutes) : `${t.points ?? 0} points`}
                          </span>
                        )}
                      </span>
                    </button>
                  </StaggerIn>
                );
              })}
            </div>
          )}

          {/* designed empty state (filters matched nothing) */}
          {visible.length === 0 && (
            <div className="mt-10 flex flex-col items-center gap-3 py-14 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-muted text-muted-foreground">
                <Search className="h-6 w-6" strokeWidth={1.8} />
              </span>
              <p className="text-sm font-semibold">Nothing matches those filters</p>
              <p className="max-w-[300px] text-[12px] leading-relaxed text-muted-foreground">
                {feedQuery
                  ? `No story matches “${feedQuery}” in the current feed — try a shorter word, or clear the filters.`
                  : "The current feed has nothing in this slice — widen the filters or refresh in a moment."}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="press-scale rounded-full"
                onClick={() => {
                  setFeedQuery("");
                  setLane("all");
                  setTab("all");
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
