import type { Metadata } from "next";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Globe, ShieldCheck, Scale, FileDown } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * P0-2 INDEXABLE SHARE PAGE — /s/<shareId>
 * Server-rendered SEO surface for a shared report: full metadata, Open Graph /
 * Twitter cards, and a crawlable extract of the report body (the first ~600
 * words) with the verdict, verification stats, and sources. The interactive
 * app view stays at /r/s-<shareId>; this page is what Google and link
 * unfurlers see, and what ranks.
 */

interface ShareData {
  id: string;
  query: string;
  reportMd: string;
  stats: Record<string, unknown> | null;
  sources: { url: string; domain: string; title: string }[];
  createdAt: Date;
  court: boolean;
}

async function loadShare(id: string): Promise<ShareData | null> {
  const snap = await db.sharedReport.findUnique({ where: { id } }).catch(() => null);
  if (!snap) return null;
  let stats: Record<string, unknown> = {};
  try {
    stats = snap.stats ? JSON.parse(snap.stats) : {};
  } catch {
    stats = {};
  }
  let sources: { url: string; domain: string; title: string }[] = [];
  try {
    sources = JSON.parse(snap.sources);
  } catch {
    sources = [];
  }
  return {
    id: snap.id,
    query: snap.query,
    reportMd: snap.reportMd,
    stats,
    sources,
    createdAt: snap.createdAt,
    court: !!(stats.court as Record<string, unknown> | undefined),
  };
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const share = await loadShare(id);
  if (!share) return { title: "Shared report — DigDeep" };
  const court = share.stats?.court as { verdict?: string } | undefined;
  const integrity = typeof share.stats?.citationIntegrity === "number" ? `${share.stats.citationIntegrity}% citation integrity` : "every citation audited";
  const title = `${share.query.slice(0, 80)}${share.query.length > 80 ? "…" : ""} — DigDeep verified research`;
  const description = court?.verdict
    ? `Court verdict: ${court.verdict}. ${integrity}. ${share.sources.length} sources read. Full verified research report on DigDeep — the research tool that puts its own answer on trial.`
    : `${integrity}. ${share.sources.length} sources read. Full verified research report on DigDeep — every claim checked, every citation audited.`;
  return {
    title,
    description,
    alternates: { canonical: `/s/${share.id}` },
    openGraph: {
      title,
      description,
      type: "article",
      siteName: "DigDeep",
      publishedTime: share.createdAt.toISOString(),
      images: [{ url: `/api/og/${share.id}`, width: 1200, height: 630, alt: share.query.slice(0, 100) }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`/api/og/${share.id}`],
    },
  };
}

function mdExcerpt(md: string, words = 600): string {
  const body = md
    .replace(/^#{1,2} .*$/gm, "") // strip the title + top-level headings for the excerpt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  const parts = body.split(/\s+/);
  return parts.slice(0, words).join(" ") + (parts.length > words ? "…" : "");
}

export default async function SharedReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const share = await loadShare(id);
  if (!share) notFound();

  const court = share.stats?.court as { verdict?: string; guilty?: number; notGuilty?: number; judgeSummary?: string } | undefined;
  const integrity = typeof share.stats?.citationIntegrity === "number" ? share.stats.citationIntegrity : null;
  const checked = typeof share.stats?.citationsChecked === "number" ? share.stats.citationsChecked : null;
  const reportScore = share.stats?.reportScore as { overall?: number } | undefined;
  const claimVerdict = share.stats?.claimVerdict as { verified?: number; partly?: number; unverified?: number } | undefined;
  const domains = [...new Set(share.sources.map((s) => s.domain))];

  // JSON-LD: what Google needs to show a rich result for a research article
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: share.query.slice(0, 110),
    datePublished: share.createdAt.toISOString(),
    author: { "@type": "Organization", name: "DigDeep" },
    description: `Verified deep-research report${court?.verdict ? ` — court verdict: ${court.verdict}` : ""} with ${share.sources.length} audited sources.`,
    isAccessibleForFree: true,
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Link href="/" className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> DigDeep — deep research that shows its work
      </Link>

      <h1 className="text-2xl md:text-3xl font-serif font-semibold leading-tight tracking-tight">{share.query}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Verified research report · {new Date(share.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
        {share.sources.length > 0 && <> · {share.sources.length} sources · {domains.length} domains</>}
      </p>

      {/* Verification stats — the product thesis, visible to crawlers */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {court?.verdict && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary"><Scale className="h-3 w-3" /> COURT VERDICT</div>
            <div className="mt-1 text-lg font-semibold">{court.verdict}</div>
            <div className="text-[11px] text-muted-foreground">{court.guilty ?? 0}–{court.notGuilty ?? 0} jury vote</div>
          </div>
        )}
        {integrity != null && (
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><ShieldCheck className="h-3 w-3" /> CITATION INTEGRITY</div>
            <div className="mt-1 text-lg font-semibold">{integrity}%</div>
            {checked != null && <div className="text-[11px] text-muted-foreground">{checked} citations audited</div>}
          </div>
        )}
        {claimVerdict && (
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><ShieldCheck className="h-3 w-3" /> CLAIM LEDGER</div>
            <div className="mt-1 text-lg font-semibold">{claimVerdict.verified ?? 0}/{(claimVerdict.verified ?? 0) + (claimVerdict.partly ?? 0) + (claimVerdict.unverified ?? 0)}</div>
            <div className="text-[11px] text-muted-foreground">claims fully verified</div>
          </div>
        )}
        {reportScore?.overall != null && (
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"><Globe className="h-3 w-3" /> PRE-SHIP SCORE</div>
            <div className="mt-1 text-lg font-semibold">{reportScore.overall}/100</div>
            <div className="text-[11px] text-muted-foreground">scored before delivery</div>
          </div>
        )}
      </div>

      {court?.judgeSummary && (
        <blockquote className="mt-6 border-l-2 border-primary/40 pl-4 text-[15px] italic text-foreground/90">
          {court.judgeSummary.slice(0, 600)}
        </blockquote>
      )}

      {/* Crawlable report extract */}
      <article className="report-prose mt-8 text-[15px] leading-relaxed text-foreground/90">
        <h2 className="text-lg font-semibold">Report</h2>
        <p className="whitespace-pre-line">{mdExcerpt(share.reportMd)}</p>
      </article>

      {/* Sources — crawlable link list */}
      {share.sources.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Sources ({share.sources.length})</h2>
          <ol className="mt-3 space-y-1.5 text-sm">
            {share.sources.slice(0, 30).map((s, i) => (
              <li key={i} className="truncate">
                <span className="text-muted-foreground">[{i + 1}]</span>{" "}
                <a href={s.url} target="_blank" rel="noopener nofollow" className="text-primary hover:underline">
                  {s.title || s.url}
                </a>
                <span className="text-muted-foreground"> — {s.domain}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* CTA — every shared report is a landing page */}
      <div className="mt-12 rounded-2xl border bg-gradient-to-br from-primary/10 to-transparent p-6">
        <h2 className="text-lg font-semibold">This report put itself on trial before it reached you.</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          DigDeep audits every citation, verifies every claim against its source passage, and can withhold its own verdict
          when the evidence is thin. Free, no API key, no account needed.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Run your own research
          </Link>
          <Link
            href={`/r/s-${share.id}`}
            className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent transition-colors"
          >
            <FileDown className="h-3.5 w-3.5" /> Open the interactive report (exports: PDF / Word / Excel)
          </Link>
        </div>
      </div>
    </div>
  );
}
