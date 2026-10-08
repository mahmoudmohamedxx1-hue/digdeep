# digdeep — Deep Analysis: Where We Are & What We Can Do

*Date: 2026-10-09 · Scope: full codebase audit + external landscape research · Method: code inspection, live web research (competitors, benchmarks, studies, trends), Fable 5.1 prompt study*

---

## Part 1 — WHERE WE ARE

### 1.1 Product state: v1.0.0 shipped, plus one polished follow-up

Everything the README claims exists and is verified in code:

| Claim | Status | Evidence |
|---|---|---|
| 3-lane routing (chat / quick / research) | ✅ | `intent-heuristics.ts` + Stage 0 in `engine.ts`; 67/67 routing tests pass |
| 13 search engines, keyless default | ✅ | `search.ts` (694 lines): DDG, SearXNG, Mojeek, Marginalia, Brave*, Google CSE*, Bing News, Wikipedia, arXiv, Crossref, HN, SO, GitHub |
| 10-stage pipeline with live streaming | ✅ | `engine.ts` (2,047 lines): route → comprehend → plan → parallel research → debate → red team → draft → citation audit → self-grade → deliver |
| Citation audit with integrity % | ✅ | Stage 4.5, quote-anchored lexical verification + judge re-anchoring |
| Red-team + proposer/skeptic debate | ✅ | Stage 3.7 / 3.4b, debate capped at 2 contested claims/run |
| Self-scored quality card | ✅ | Stage 5: evidence/coverage/honesty/clarity, published even when bad |
| Monitoring-lite diff | ✅ | Re-run produces "what changed" section |
| Local documents as sources | ✅ | 4 files, `[1000+]` citation namespace |
| BYOK frontier synthesis | ✅ | `llm.ts` (526 lines): GLM chain + LLM7/Pollinations failover + BYOK registry |
| Fable 5.1 chat craft + grounded self-knowledge | ✅ | `self-knowledge.ts` (product_information pattern mirrors the leaked Claude Fable 5.1 spec) + topic-specific chat prompts |
| Deterministic E2E + benchmark harness | ✅ | `mock-llm.js`, `benchmark-harness.mjs` |

**Honest baseline published:** ~52% keyword coverage on the quick preset. Weak, but reproducible — that's the right call for an honesty-first product.

### 1.2 Code state: small, dense, testable

- Core research lib: **~4,600 lines** (engine 2,047 · search 694 · prompts 599 · llm 526 · heuristics 174)
- TypeScript strict, ESLint clean, 67-case routing suite green
- Prisma + SQLite server-side; IndexedDB client-side; SSE streaming with token deltas
- Weak spots (technical debt): `engine.ts` at 2,047 lines is approaching the limit of comfortable maintenance; prompts live in one 599-line file; no CI workflow file in the repo yet

### 1.3 Verified gaps (README "Next" section vs. actual code)

| Roadmap item | Reality in code |
|---|---|
| Embedding-based reranking / semantic citation verification | **Not started** — zero embedding code; verification is lexical only |
| Scheduled monitoring (subscribe + digest) | **Not started** — no scheduler anywhere; monitoring is manual re-run only |
| DOCX / Notion export, report templates | **Not started** — export route handles MD + PDF only |
| Multi-user auth + shared links | **Not started** — `next-auth` sits unused in package.json |

### 1.4 Market position: the differentiation is real, the distribution is zero

External research findings (Oct 2026):

- **The citation crisis is documented.** The Tow Center study (confirmed by Fortune, WIRED, CJR coverage): AI search engines fail to cite accurately **>60% of the time**; Pew (Oct 2025): only 6% of users trust AI summaries "a lot". digdeep's core thesis — published citation-integrity %, self-graded reports, visible reasoning — attacks exactly this documented failure. **No competitor ships this.**
- **Commercial landscape:** Perplexity ($20/mo, fastest, most reliable citations), ChatGPT Deep Research (most polished reports, expensive), Gemini Deep Research (reads the most sources), Claude (best reasoning/writing), Grok. All metered, all opaque about their failure modes.
- **Open-source landscape:** GPT-Researcher (most actively maintained, but a report-generation *building block*, not an end-user product), Local Deep Research by LearningCircuit (healthiest local-first project), STORM (Stanford; reportedly stalled — no commits on main since Sept 2025 per recent comparisons). **No OSS project owns the "honest research" position.**
- **Benchmarks:** BrowseComp / BrowseComp+ leaders sit at ~89–95% on browse tasks. Our 52% keyword-coverage baseline is a different, stricter metric — but the gap is real and worth closing.

### 1.5 The uncomfortable summary

The product is **feature-complete for v1 and differentiated on a validated thesis** — but the repo was created 2026-10-08 and has **0 stars, 0 forks, 0 watchers**. Nobody knows it exists. The binding constraint right now is not features; it is **distribution and proof**. A honesty-first product with no witnesses is a tree falling in an empty forest.

---

## Part 2 — WHAT WE CAN DO (researched, prioritized)

### Tier 0 — Make people know it exists (highest leverage, zero code)

The single highest-ROI action available. The differentiation story is already newsworthy; it just hasn't been told.

1. **Launch posts with evidence, not adjectives.** "We audited our own citations and published the integrity % — 8 audited, 1 re-anchored, 1 dropped, 88%." That's a screenshot that sells itself.
   - Show HN (title idea: *Show HN: digdeep — a deep research engine that audits its own citations*)
   - r/LocalLLaMA, r/opensource, r/SideProject — the Reddit consensus is that niche-community targeting + progress updates works
   - Product Hunt (the "30x PH #1 + 6,000 stars in 7 days" playbook: channels + content, not tips)
2. **Publish the Tow Center contrast.** ">60% of AI search citations are broken (Tow, 2025). So we built an engine that grades its own citations and shows the number even when it's bad." This is the hook every piece of coverage can hang on.
3. **CI badge + GitHub Actions workflow** so the 67/67 suite runs publicly on every push — trust signals for a trust product.

### Tier 1 — Close the promised gaps (low effort, high credibility)

4. **Semantic citation verification** (already promised in README). Embedding check *in addition to* the lexical anchor, so paraphrased-but-faithful citations stop being flagged and unsupported ones stop slipping through. Free-tier embedding APIs exist; keep the keyless guarantee via an LLM-based fallback (the judge can do semantic matching without embeddings).
5. **Scheduled monitoring.** Subscribe to a question → server-side cron → diff digest. This converts a one-shot tool into a recurring-visit product and is a feature Perplexity users explicitly ask for.
6. **DOCX export + report templates** (academic / brief / decision-memo). Mechanical work, broadens the audience.

### Tier 2 — Ride the standards (medium effort, strategic upside)

7. **Ship digdeep as an MCP server.** MCP became the defining standard for agent-tool integration over the past year (Nov 2025 spec release). Exposing "deep_research" as an MCP tool means Claude, ChatGPT, and every MCP-capable agent becomes a digdeep *distribution channel*. One of the strongest available moves — it turns competitors' surfaces into our front door.
8. **Share links for reports.** A report with a public URL is a growth loop: every shared report is a landing page with the integrity % on it. Requires a hosted deployment first (see Tier 3).

### Tier 3 — Bigger bets (choose deliberately)

9. **Local-model mode (Ollama / LM Studio).** The local-first research niche is healthy (Local Deep Research's momentum proves demand; Qwen3.6-class 27B models now do credible research on one GPU). digdeep's honesty stack + local models = the privacy answer to Perplexity. The engine is already BYOK-shaped, so an OpenAI-compatible localhost endpoint needs almost no new code.
10. **Benchmark push.** Adapt the harness to BrowseComp-Plus methodology, publish a reproducible scorecard. Even a mid score, published honestly, is on-thesis marketing — and closing the 52% → 70%+ gap (deeper presets, better query decomposition, semantic rerank) becomes a public narrative.
11. **Multi-user + hosted offering.** next-auth is already in the tree. Shared threads and accounts are the bridge from OSS project to sustainable product — but only after distribution proves demand.

### Recommended sequence

```
Now (this week):   Tier 0 launch posts + CI workflow          → distribution
Next 2–3 weeks:    Semantic citation verification (#4)        → credibility
                  + MCP server (#7)                           → distribution channel
Then:              Scheduled monitoring (#5) + share links     → retention loop
Later:             Local-model mode (#9) or benchmark push     → pick based on
                   based on launch feedback                     what users ask for
```

### What NOT to do (yet)

- Don't build multi-user auth before there are users to authenticate.
- Don't chase BrowseComp leaderboard parity — our metric is honesty, and the honesty numbers are already differentiated.
- Don't add more engines. 13 is plenty; the moat is verification, not source count.
