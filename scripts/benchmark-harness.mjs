#!/usr/bin/env node
/** ==================================================================
 *  DIGDEEP BENCHMARK HARNESS (P1-4 — benchmark participation)
 *  A BrowseComp / DeepResearch-Bench-style scorer for digdeep itself:
 *  runs questions through the live engine, then scores each finished
 *  report on keyword coverage + citation integrity + self-score.
 *
 *  Usage:
 *    node scripts/benchmark-harness.mjs                          # built-in 10-question set, quick preset
 *    node scripts/benchmark-harness.mjs --file my.jsonl --preset standard --base http://localhost:3000
 *    node scripts/benchmark-harness.mjs --only quick-001,drb-001  # subset
 *    node scripts/benchmark-harness.mjs --list                    # show the question set
 *
 *  Question JSONL shape: {"id","question","answerKeywords":[...],"difficulty","origin"}
 *  Output: results JSON + a markdown scoreboard under scripts/bench/results/.
 *  ================================================================== */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const file = flag("file", resolve(__dirname, "bench", "questions.jsonl"));
const base = flag("base", "http://localhost:3000").replace(/\/+$/, "");
const preset = flag("preset", "quick");
const only = flag("only", "");
const timeoutMin = Number(flag("timeout", preset === "quick" ? 12 : 45)) * 60_000;
const outDir = resolve(__dirname, "bench", "results");

if (args.includes("--list")) {
  const qs = loadQuestions();
  for (const q of qs) console.log(`${q.id}\t[${q.difficulty}]\t${q.question.slice(0, 90)}`);
  process.exit(0);
}

function loadQuestions() {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().startsWith("{"));
  const qs = lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      console.error(`Bad JSONL at line ${i + 1}: ${e.message}`);
      process.exit(1);
    }
  }).filter((q) => q.id && q.question && Array.isArray(q.answerKeywords));
  return only ? qs.filter((q) => only.split(",").includes(q.id)) : qs;
}

/** Keyword coverage: fraction of expected answer keywords found in the report (case-insensitive). */
function scoreReport(reportMd, keywords) {
  const hay = (reportMd || "").toLowerCase();
  const hits = keywords.map((k) => (hay.includes(String(k).toLowerCase()) ? 1 : 0));
  const coverage = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : 0;
  return { coverage, hits: hits.map((h, i) => (h ? null : keywords[i])).filter(Boolean) };
}

async function waitJob(id, deadline) {
  for (;;) {
    if (Date.now() > deadline) throw new Error("timeout");
    const res = await fetch(`${base}/api/research/${id}`).catch((e) => null);
    if (!res) throw new Error("poll fetch failed");
    const text = await res.text();
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      throw new Error(`bad JSON from GET /api/research/${id} (HTTP ${res.status}): ${text.slice(0, 140)}`);
    }
    if (!r?.job) throw new Error(`job lost: ${text.slice(0, 140)}`);
    if (["completed", "failed", "cancelled"].includes(r.job.status)) return r;
    await new Promise((res2) => setTimeout(res2, 4000));
  }
}

async function main() {
  const questions = loadQuestions();
  if (questions.length === 0) {
    console.log("No questions to run.");
    process.exit(0);
  }
  console.log(`digdeep benchmark harness — ${questions.length} question(s) · preset=${preset} · base=${base}\n`);
  mkdirSync(outDir, { recursive: true });
  const results = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`[${i + 1}/${questions.length}] ${q.id} · ${q.question.slice(0, 70)}… `);
    const t0 = Date.now();
    try {
      const start = await fetch(`${base}/api/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q.question, preset, language: "English" }),
      }).then((x) => x.json());
      if (!start.id) throw new Error(start.error || "could not start job");
      const done = await waitJob(start.id, t0 + timeoutMin);
      const job = done.job;
      // NB: the API already returns stats as a parsed object — do NOT JSON.parse it again
      const stats = job.stats ?? {};
      const { coverage, hits: missed } = scoreReport(job.reportMd, q.answerKeywords);
      const row = {
        id: q.id,
        origin: q.origin,
        difficulty: q.difficulty,
        mode: job.mode,
        coverage: Math.round(coverage * 100),
        missedKeywords: missed,
        citationIntegrity: stats.citationIntegrity ?? null,
        selfScore: stats.quality?.overall ?? null,
        sources: stats.sourcesConsulted ?? 0,
        words: stats.reportWords ?? 0,
        durationMs: Date.now() - t0,
        status: job.status,
        jobId: start.id,
      };
      results.push(row);
      console.log(
        job.status !== "completed"
          ? `${job.status.toUpperCase()}`
          : `coverage ${row.coverage}% · integrity ${row.citationIntegrity}% · self ${row.selfScore ?? "-"} · ${row.sources} src · ${(row.durationMs / 60000).toFixed(1)}m${row.missedKeywords.length ? ` · missed: ${row.missedKeywords.join(", ")}` : ""}`
      );
    } catch (e) {
      results.push({ id: q.id, origin: q.origin, difficulty: q.difficulty, error: String(e.message || e), coverage: 0 });
      console.log(`ERROR: ${e.message}`);
    }
  }

  // scoreboard
  const scored = results.filter((r) => typeof r.coverage === "number");
  const avgCoverage = scored.length ? Math.round(scored.reduce((a, r) => a + r.coverage, 0) / scored.length) : 0;
  const withIntegrity = scored.filter((r) => r.citationIntegrity != null);
  const avgIntegrity = withIntegrity.length ? Math.round(withIntegrity.reduce((a, r) => a + r.citationIntegrity, 0) / withIntegrity.length) : null;
  const withSelf = scored.filter((r) => r.selfScore != null);
  const avgSelf = withSelf.length ? (withSelf.reduce((a, r) => a + r.selfScore, 0) / withSelf.length).toFixed(1) : null;
  const byOrigin = {};
  for (const r of scored) {
    byOrigin[r.origin] = byOrigin[r.origin] || { n: 0, cov: 0 };
    byOrigin[r.origin].n++;
    byOrigin[r.origin].cov += r.coverage;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(resolve(outDir, `run-${stamp}.json`), JSON.stringify({ preset, base, avgCoverage, avgIntegrity, avgSelf, results }, null, 2));

  let md = `# digdeep benchmark run — ${stamp}\n\n- Preset: **${preset}** · Base: ${base} · Questions: ${questions.length}\n`;
  md += `- **Average keyword coverage: ${avgCoverage}%**\n- Average citation integrity: ${avgIntegrity != null ? avgIntegrity + "%" : "n/a"}\n- Average self-score: ${avgSelf ?? "n/a"}\n\n`;
  md += `| id | origin | difficulty | mode | coverage | integrity | self | sources | duration |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    md += `| ${r.id} | ${r.origin ?? ""} | ${r.difficulty ?? ""} | ${r.mode ?? r.status ?? "error"} | ${r.coverage ?? 0}% | ${r.citationIntegrity ?? "-"} | ${r.selfScore ?? "-"} | ${r.sources ?? 0} | ${r.durationMs ? (r.durationMs / 60000).toFixed(1) + "m" : "-"} |\n`;
  }
  md += `\n### By origin\n\n| origin | n | avg coverage |\n|---|---|---|\n`;
  for (const [o, v] of Object.entries(byOrigin)) md += `| ${o} | ${v.n} | ${Math.round(v.cov / v.n)}% |\n`;
  md += `\n_Public, verifiable numbers — including the bad ones. That is the point._\n`;
  writeFileSync(resolve(outDir, `run-${stamp}.md`), md);

  console.log(`\n=== SCOREBOARD ===`);
  console.log(`Average keyword coverage : ${avgCoverage}%`);
  if (avgIntegrity != null) console.log(`Average citation integrity: ${avgIntegrity}%`);
  if (avgSelf != null) console.log(`Average self-score        : ${avgSelf}/10`);
  console.log(`\nResults written to scripts/bench/results/run-${stamp}.{json,md}`);
}

main().catch((e) => {
  console.error("Harness failed:", e);
  process.exit(1);
});
