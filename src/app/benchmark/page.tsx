import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ArrowRight, FlaskConical, Eye, ShieldCheck, AlertTriangle } from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Benchmark methodology & results — how DigDeep scores itself",
  description:
    "Our public benchmark methodology: the question set, the scoring rules, the judges, and every failure case — published in full, including the numbers that hurt. This page is the proof that verification is the product.",
  alternates: { canonical: "/benchmark" },
};

interface BenchRow {
  id: string;
  origin?: string;
  difficulty?: string;
  mode?: string;
  coverage?: number;
  missedKeywords?: string[];
  citationIntegrity?: number | null;
  selfScore?: number | null;
  sources?: number;
  words?: number;
  durationMs?: number;
  status?: string;
  error?: string;
}
interface BenchRun {
  preset?: string;
  base?: string;
  avgCoverage?: number;
  avgIntegrity?: number | null;
  avgSelf?: string | null;
  results?: BenchRow[];
}

/**
 * P0-1 PUBLIC METHODOLOGY PAGE — /benchmark
 * Renders the LATEST committed harness run (scripts/bench/results/run-*.json)
 * with the full methodology text: question provenance, scoring rules, judge
 * configuration, and failure cases. The strategic thesis: a transparent
 * mid-table score from the only adversarial-verification system in the field
 * is a story; the failures we publish are the proof.
 */
function latestRun(): BenchRun | null {
  try {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/bench/results");
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((f: string) => f.startsWith("run-") && f.endsWith(".json"))
      .sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(resolve(dir, files[files.length - 1]), "utf8")) as BenchRun;
  } catch {
    return null;
  }
}

export default function BenchmarkPage() {
  const run = latestRun();
  const rows = run?.results ?? [];
  const failures = rows.filter((r) => (r.coverage ?? 0) < 60 || r.error);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 md:py-14">
      <div className="mb-10">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-primary">
          <FlaskConical className="h-3.5 w-3.5" /> Benchmark
        </p>
        <h1 className="mt-2 text-3xl font-serif font-semibold tracking-tight">We publish our scores. And our failures.</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          This page documents exactly how DigDeep measures itself: the question set, the scoring rules, the judge
          configuration, and the raw per-question results of our latest harness run — including every question we
          answered poorly. Methodology transparency is the currency of the benchmark economy; a score without a
          published harness is marketing.
        </p>
      </div>

      {/* The numbers */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-[11px] font-medium text-muted-foreground">KEYWORD COVERAGE</div>
          <div className="mt-1 text-2xl font-semibold">{run?.avgCoverage != null ? `${run.avgCoverage}%` : "—"}</div>
          <div className="text-[11px] text-muted-foreground">expected-answer terms found in the report</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-[11px] font-medium text-muted-foreground">CITATION INTEGRITY</div>
          <div className="mt-1 text-2xl font-semibold">{run?.avgIntegrity != null ? `${run.avgIntegrity}%` : "—"}</div>
          <div className="text-[11px] text-muted-foreground">citations surviving the audit, run-average</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-[11px] font-medium text-muted-foreground">SELF-SCORE</div>
          <div className="mt-1 text-2xl font-semibold">{run?.avgSelf ?? "—"}</div>
          <div className="text-[11px] text-muted-foreground">engine&apos;s own graded quality, run-average</div>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="text-[11px] font-medium text-muted-foreground">QUESTIONS</div>
          <div className="mt-1 text-2xl font-semibold">{rows.length || "—"}</div>
          <div className="text-[11px] text-muted-foreground">preset {run?.preset ?? "—"}, latest committed run</div>
        </div>
      </section>

      {/* Methodology */}
      <section className="mt-12 space-y-8 text-[15px] leading-relaxed">
        <div>
          <h2 className="text-xl font-semibold">1 · The question set</h2>
          <p className="mt-2 text-muted-foreground">
            The harness (open-sourced in this repository at <code className="rounded bg-muted px-1 py-0.5 text-[13px]">scripts/benchmark-harness.mjs</code>)
            runs a 10-question set spanning three difficulty families: simple lookups (albatross wingspan, Nobel 2024),
            BrowseComp-style needle-in-haystack questions, and DeepResearch-Bench-style synthesis questions that require
            reading many sources and comparing entities across dimensions. Questions live in versioned JSONL with
            expected answer keywords per question.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold">2 · Scoring rules</h2>
          <p className="mt-2 text-muted-foreground">
            Four numbers per question, all machine-computed, none hand-graded:
            <strong> keyword coverage</strong> — the fraction of expected answer terms present in the final report
            (a proxy for factual completeness); <strong>citation integrity</strong> — the share of citations that
            survived the engine&apos;s own quote-anchored audit; <strong>self-score</strong> — the engine&apos;s
            LLM-graded quality rubric; and <strong>pre-ship score</strong> — the deterministic evidence/coverage/
            consistency gate every report now passes before delivery. Coverage is deliberately a harsh proxy: a report
            can be excellent prose and still miss a keyword; we accept that harshness because it cannot be gamed.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold">3 · Judge configuration & known sensitivity</h2>
          <p className="mt-2 text-muted-foreground">
            The self-score dimension uses the same keyless LLM pool the product ships with, at default sampling
            parameters, no judge-swapping, and no retries on grading calls. We note the documented industry finding
            that judge choice alone moves DRACO-style absolute scores by 10–25 points; that is precisely why our
            primary metrics (coverage, integrity) are deterministic string/audit computations rather than LLM judgments.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold">4 · What we do NOT claim</h2>
          <p className="mt-2 text-muted-foreground">
            We do not claim a DRACO leaderboard rank yet (that run requires a judge budget and is the first roadmap
            milestone). We do not cherry-pick questions. When a question fails, the failure row stays in the table
            below with its missed keywords visible — the same honesty standard we hold the engine to.
          </p>
        </div>
      </section>

      {/* Results table */}
      {rows.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xl font-semibold">Latest run — per-question results</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-3">question</th>
                  <th className="p-3">difficulty</th>
                  <th className="p-3">mode</th>
                  <th className="p-3">coverage</th>
                  <th className="p-3">integrity</th>
                  <th className="p-3">self</th>
                  <th className="p-3">sources</th>
                  <th className="p-3">time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="max-w-[260px] p-3">
                      <div className="truncate font-medium" title={r.id}>{r.id}</div>
                      {r.missedKeywords?.length ? (
                        <div className="mt-0.5 truncate text-[11px] text-destructive" title={r.missedKeywords.join(", ")}>
                          missed: {r.missedKeywords.join(", ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="p-3 text-muted-foreground">{r.difficulty ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{r.mode ?? r.status ?? "?"}</td>
                    <td className="p-3 font-semibold">
                      <span className={(r.coverage ?? 0) >= 75 ? "text-emerald-600" : (r.coverage ?? 0) >= 50 ? "text-amber-600" : "text-destructive"}>
                        {r.error ? "ERR" : `${r.coverage ?? 0}%`}
                      </span>
                    </td>
                    <td className="p-3 text-muted-foreground">{r.citationIntegrity ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{r.selfScore ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{r.sources ?? "—"}</td>
                    <td className="p-3 text-muted-foreground">{r.durationMs ? `${(r.durationMs / 60000).toFixed(1)}m` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Failures — the point of the page */}
      {failures.length > 0 && (
        <section className="mt-12">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Published failures ({failures.length})
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The questions we did not answer well enough, with the exact keywords the reports missed. Fixed runs will
            replace these rows — never hide them.
          </p>
          <ul className="mt-4 space-y-2">
            {failures.map((f) => (
              <li key={f.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                <span className="font-medium">{f.id}</span>
                <span className="text-muted-foreground">
                  {" "}— {f.error ? f.error : `coverage ${f.coverage}%${f.missedKeywords?.length ? `, missed: ${f.missedKeywords.join(", ")}` : ""}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-12 rounded-2xl border bg-gradient-to-br from-primary/10 to-transparent p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-5 w-5 text-primary" /> Reproduce it yourself
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The harness, the question set, and every result JSON are in the repository. Clone it, run the engine, and
          check our arithmetic — the same standard we apply to every report the engine ships.
        </p>
        <Link href="/" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          Run the engine on your own question <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
