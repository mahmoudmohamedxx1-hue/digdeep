# Launch Package — DigDeep v3.3 (October 2026)

One-sentence positioning: **DigDeep is the research tool that puts its own answer on trial.**

Launch order: benchmark page first (the news hook), gallery second (the proof), product third (the tool).

---

## 1 · The news hook (benchmark post)

Title options:
- "We published our AI's benchmark scores — including the ones that hurt"
- "How do you know an AI research report is true? We made ours prove it in court"
- "DigDeep: deep research with a prosecutor, a defense, and 12 jurors — and we publish our failures"

Post (adapt per platform):

> We built a deep research tool that refuses to ship an answer it can't defend.
>
> Every DigDeep report goes through what we call the court: a prosecutor builds the case FOR the answer, a defense attacks it, twelve jurors with distinct analytical lenses vote, and a judge writes the verdict. The verdict card — with conviction meters, vote splits, and per-juror reasoning — ships WITH the report. Sometimes the verdict is HUNG JURY. That's a feature.
>
> Every claim is checked against the exact passage in its source that supports it — a per-claim evidence ledger. Every citation is audited: re-anchored or dropped citations are surfaced, not hidden. And every report now carries a deterministic pre-ship score: coverage, integrity, evidence, consistency, computed before delivery. We just shipped that number on every report.
>
> We also published our own benchmark methodology and results — including every question we answered badly:
> https://digdeepx.vercel.app/benchmark
>
> While others cut "unlimited" deep research quotas to ~20/month, DigDeep stays free and keyless. No account needed. No API key. Court mode included.
>
> What's new in 3.3:
> - Domain packs for legal, financial, and medical research (primary sources first: statutes, filings, peer-reviewed trials)
> - Accounts + cross-device sync (your anonymous history migrates when you sign up)
> - A verified-report API (start a run over HTTP, get the verdict + ledger back)
> - Team workspaces with an audit view for research leads
> - A machine-checked compute tool: the engine evaluates its own arithmetic
> - PWA: install it, works offline for your history
>
> Try it: https://digdeepx.vercel.app
> The gallery: https://digdeepx.vercel.app/gallery

Target communities (the quota-refugee thesis):
- r/PerplexityAI (quota complaints threads — answer them respectfully)
- r/LocalLLaMA, r/ArtificialInteligence (benchmark methodology angle)
- Hacker News (Show HN: the published-failures angle is the hook)
- X/Twitter AI-research community (verdict card screenshots travel)

---

## 2 · The assets

- OG card (site): `/api/og-card` — verdict-card style, 1200×630
- OG card (per report): `/api/og/<shareId>` — query + verdict + integrity, auto-generated
- Gallery: curated exemplar reports at /gallery (populate by sharing 5-10 strong runs before launch)
- Benchmark: /benchmark (auto-renders the latest committed harness run)
- API docs: /api-docs (for the developer-audience crosspost)

## 3 · The benchmark run (do this BEFORE launching)

```bash
# start PG + the standalone server, then:
node scripts/benchmark-harness.mjs --preset quick    # ~15 min, 10 questions
# commit scripts/bench/results/run-*.json + .md — the /benchmark page renders it
```

The page publishes failures automatically. Do not hand-edit results.

## 4 · Metrics to watch after launch (the KPI scorecard)

- Share-page conversion to a run: target 5% (Phase 0 KPI)
- Weekly active researchers: 1,000 target
- DRACO objectivity dimension: publishable run when judge budget is approved
- API key creations: leading indicator of developer adoption
- Account signups + anonymous→account migration rate: retention leading indicator

## 5 · Launch-day checklist

- [ ] Benchmark run committed, /benchmark renders real numbers
- [ ] Gallery populated with 5-10 strong shared reports
- [ ] OG cards render (test unfurl with a validator)
- [ ] sitemap.xml live, robots.txt points to it
- [ ] Rate limits verified (30 runs/min/IP, 60 starts/min/key, 20 auth/min/IP)
- [ ] Show HN + Reddit posts scheduled 9am ET
- [ ] Product Hunt teaser for the following week
