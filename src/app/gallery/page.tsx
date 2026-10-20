import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { ArrowRight, Scale, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Research gallery — verified deep research reports | DigDeep",
  description:
    "Real deep research reports, each with an audited citation trail, a per-claim evidence ledger, and verdicts from an adversarial court. See what machine-verified research looks like.",
  alternates: { canonical: "/gallery" },
};

/**
 * P0-2 PUBLIC GALLERY — /gallery
 * Every shared report is a landing page; this is the index of the best ones.
 * Server-rendered + crawlable; each card links to the SEO page /s/<id>.
 */
export default async function GalleryPage() {
  const snaps = await db.sharedReport
    .findMany({
      orderBy: { createdAt: "desc" },
      take: 24,
      select: { id: true, query: true, mode: true, preset: true, stats: true, sources: true, createdAt: true },
    })
    .catch(() => []);

  const items = snaps.map((s) => {
    let stats: Record<string, unknown> = {};
    try { stats = s.stats ? JSON.parse(s.stats) : {}; } catch { stats = {}; }
    let srcN = 0;
    let domains: string[] = [];
    try {
      const parsed = JSON.parse(s.sources) as { domain: string }[];
      srcN = parsed.length;
      domains = [...new Set(parsed.map((p) => p.domain))].slice(0, 4);
    } catch { /* empty */ }
    const court = stats.court as { verdict?: string; guilty?: number; notGuilty?: number } | undefined;
    const integrity = typeof stats.citationIntegrity === "number" ? stats.citationIntegrity : null;
    const reportScore = stats.reportScore as { overall?: number } | undefined;
    return { id: s.id, query: s.query, court, integrity, reportScore, srcN, domains, createdAt: s.createdAt.toISOString() };
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:py-14">
      <div className="mb-10">
        <p className="text-xs font-medium uppercase tracking-widest text-primary">The gallery</p>
        <h1 className="mt-2 text-3xl font-serif font-semibold tracking-tight">Research that shows its work</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          Every report below ran the full pipeline: multi-engine search, source-quality gating, an adversarial court,
          a per-claim evidence ledger, and a citation audit before delivery. These are real runs, shared by their authors —
          including the numbers that hurt.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-12 text-center">
          <p className="text-lg font-medium">The gallery is waiting for its first exhibit.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Run a research report, then share it from the report&apos;s action bar — shared reports land here.
          </p>
          <Link href="/" className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            Start a research run <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((it) => (
            <Link
              key={it.id}
              href={`/s/${it.id}`}
              className="group rounded-2xl border bg-card p-5 transition-all hover:border-primary/40 hover:shadow-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                  {it.court ? "court run" : "research report"}
                </span>
                {it.reportScore?.overall != null && (
                  <span className="text-[11px] text-muted-foreground">score {it.reportScore.overall}/100</span>
                )}
              </div>
              <h2 className="mt-3 line-clamp-2 font-serif text-[17px] font-semibold leading-snug group-hover:text-primary transition-colors">
                {it.query}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                {it.court?.verdict && (
                  <span className="inline-flex items-center gap-1">
                    <Scale className="h-3 w-3" /> {it.court.verdict} ({it.court.guilty ?? 0}–{it.court.notGuilty ?? 0})
                  </span>
                )}
                {it.integrity != null && (
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" /> {it.integrity}% citation integrity
                  </span>
                )}
                <span>{it.srcN} sources</span>
                <span>{new Date(it.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
              </div>
              {it.domains.length > 0 && (
                <p className="mt-2 truncate text-[11px] text-muted-foreground/70">{it.domains.join(" · ")}</p>
              )}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-12 rounded-2xl border bg-gradient-to-br from-primary/10 to-transparent p-6">
        <h2 className="text-lg font-semibold">Want one of these on your own question?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Free, keyless, unlimited runs — with exports to PDF, Word, and Excel including the verification ledger.
        </p>
        <Link href="/" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Ask anything <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
