"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight, Bot, Compass, Cpu, FlaskConical, Globe, Landmark,
  MessageSquare, RefreshCw, ShieldCheck, Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Favicon } from "@/components/pplx/sources-row";
import { StaggerIn } from "@/components/magic";

interface TrendingItem {
  title: string;
  url: string;
  domain: string;
  points: number;
  comments: number;
}

/** Category rules — a story lands in the first bucket whose domain/keyword matches. */
const CATEGORIES: { id: string; label: string; icon: typeof Bot; test: (t: TrendingItem) => boolean }[] = [
  {
    id: "ai", label: "AI & models", icon: Bot,
    test: (t) =>
      /arxiv\.org|openai|anthropic|huggingface|deepmind|stability\.ai/i.test(t.domain) ||
      /\b(ai|llm|gpt|claude|gemini|deepseek|llama|mistral|qwen|grok|model|models|neural|inference|training|agent|agents|transformer|diffusion|chatbot|speech|whisper|transcri|tokenizer|embedding|fine-?tun|prompt|copilot)\b/i.test(t.title),
  },
  {
    id: "oss", label: "Open source", icon: Wrench,
    test: (t) =>
      /github|gitlab|sourceforge|git\./i.test(t.domain) ||
      /^show hn|\b(open.?source|license|repo|repository|maintainer|fork|self.?host)\b/i.test(t.title),
  },
  {
    id: "security", label: "Security", icon: ShieldCheck,
    test: (t) => /\b(breach|breached|vulnerab|cve-|exploit|hack|hacked|hackers|ransomware|malware|zero.?day|patched|phishing|leaked|dumped|data.?use[d]?\b.{0,20}\b(tb|gb|mb)|privacy)\b/i.test(t.title),
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
    test: (t) => /\b(funding|raises|raised|ipo|acquisition|acquires|acquired|startup|valuation|revenue|layoffs|profit|pricing|subscription|billion|million deal)\b/i.test(t.title),
  },
];

function categorize(t: TrendingItem): string {
  for (const c of CATEGORIES) if (c.test(t)) return c.id;
  return "tech";
}

/** The research angle — an honest, templated line about how digdeep would
 *  attack the story. Deterministic (category + title shape), never fake-AI. */
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

const TECH_ICON = Globe;

export default function DiscoverPage() {
  const router = useRouter();
  const [items, setItems] = useState<TrendingItem[] | null>(null); // null = loading
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<string>("all");

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

  // attach a category to every story once
  const decorated = useMemo(
    () => (items ?? []).map((t) => ({ ...t, cat: categorize(t) })),
    [items]
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: decorated.length, tech: 0 };
    for (const c of CATEGORIES) m[c.id] = 0;
    for (const d of decorated) m[d.cat] = (m[d.cat] ?? 0) + 1;
    return m;
  }, [decorated]);
  const visible = tab === "all" ? decorated : decorated.filter((d) => d.cat === tab);

  const askAbout = (title: string) => {
    // land on the home composer with the question typed and focused
    sessionStorage.setItem("digdeep:prefill", title);
    router.push("/");
  };

  const tabs = [
    { id: "all", label: "All", icon: Compass },
    { id: "tech", label: "Tech", icon: Globe },
    ...CATEGORIES.filter((c) => (counts[c.id] ?? 0) > 0).map((c) => ({ id: c.id, label: c.label, icon: c.icon })),
  ];

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-10 sm:pt-14">
      <div className="flex items-center gap-2">
        <Compass className="h-4 w-4 text-primary" />
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Discover</h1>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        What the web is talking about right now — with the angle a proper research run would take. Tap a card to dig in.
      </p>

      {/* category tabs */}
      {items && items.length > 0 && (
        <div className="sticky top-[57px] z-20 -mx-4 mt-5 bg-background/85 px-4 py-2 backdrop-blur-lg md:top-0" role="tablist" aria-label="Story categories">
          <div className="slim-scroll flex gap-1.5 overflow-x-auto pb-1">
            {tabs.map((t) => (
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
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
                <span className="text-[10.5px] tabular-nums opacity-60">{counts[t.id] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* loading skeletons */}
      {items == null && (
        <div className="mt-6 space-y-2.5" aria-label="Loading stories">
          {[...Array(6)].map((_, i) => <div key={i} className="skeleton-line h-[108px] rounded-[18px]" />)}
        </div>
      )}

      {/* designed error state */}
      {failed && (
        <div className="mt-10 flex flex-col items-center gap-4 rounded-[20px] border border-dashed py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-primary/10 text-primary">
            <Compass className="h-7 w-7" strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-sm font-semibold">Couldn&apos;t load what&apos;s trending</p>
            <p className="mx-auto mt-1.5 max-w-[320px] text-[12px] leading-relaxed text-muted-foreground">
              The trending feed (Hacker News front page) didn&apos;t answer. It might be rate-limiting us — retry in a moment.
            </p>
          </div>
          <Button size="sm" variant="outline" className="press-scale gap-1.5 rounded-full" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Try again
          </Button>
        </div>
      )}

      {/* stories — editorial cards, no ranking numbers */}
      {visible.length > 0 && (
        <div className="mt-5 space-y-2.5">
          {visible.map((t, i) => {
            const CatIcon = CATEGORIES.find((c) => c.id === t.cat)?.icon ?? TECH_ICON;
            const catLabel = CATEGORIES.find((c) => c.id === t.cat)?.label ?? "Tech";
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
                    <span className="inline-flex items-center gap-1.5">
                      <Favicon domain={t.domain} className="h-3.5 w-3.5" />
                      <span className="max-w-[200px] truncate">{t.domain}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
                      <CatIcon className="h-3 w-3" /> {catLabel}
                    </span>
                    <span className="inline-flex items-center gap-1 opacity-80">
                      <MessageSquare className="h-3 w-3" aria-hidden /> {t.comments}
                    </span>
                    <span className="opacity-60">{t.points} points</span>
                  </span>
                </button>
              </StaggerIn>
            );
          })}
        </div>
      )}

      {/* designed empty state (feed loaded but this tab is empty) */}
      {items != null && !failed && visible.length === 0 && (
        <div className="mt-10 flex flex-col items-center gap-3 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-[16px] bg-muted text-muted-foreground">
            <Globe className="h-6 w-6" strokeWidth={1.8} />
          </span>
          <p className="text-sm font-semibold">Nothing in this lane right now</p>
          <p className="max-w-[300px] text-[12px] leading-relaxed text-muted-foreground">
            The current feed has no stories in this category — check All, or come back later when the front page shifts.
          </p>
          <Button size="sm" variant="outline" className="press-scale rounded-full" onClick={() => setTab("all")}>
            Show everything
          </Button>
        </div>
      )}
    </div>
  );
}
