/**
 * Mock OpenAI-compatible LLM server for deterministic E2E verification of
 * engine v6 (Claude-style comprehension + graded evidence + cross-verification).
 * Registered through the app's own pool-endpoint mechanism; pattern-matches the
 * prompt to return purpose-specific responses. Plain JSON (no SSE) — both the
 * streaming and non-streaming client paths handle JSON bodies.
 *
 * Run: node scripts/mock-llm.js  (listens on 127.0.0.1:8787)
 */
const http = require("http");

const RESP = {
  classify:
    "RESTATE: The user asks whether nuclear power is cheaper than solar and wind for decarbonizing the grid.\n" +
    "INTENT: They want an evidence-based cost comparison to settle a genuinely debated question.\n" +
    "STRATEGY: Research cost metrics and system-integration costs from multiple independent sources, then give a cited verdict.\n" +
    "LANE: research",
  comprehend: JSON.stringify({
    restate: "Whether nuclear generation is cheaper than solar+wind for decarbonizing an electricity grid, accounting for more than headline LCOE.",
    intent: "An evidence-grounded verdict on relative cost, including the hidden system costs that headline figures omit.",
    successCriteria: [
      "Compare like-for-like cost metrics (LCOE) from recent independent assessments",
      "Account for grid-integration and system costs that change the ranking",
      "State where credible sources genuinely disagree instead of averaging it away",
    ],
    ambiguous: ["'cheaper' — most likely means full system cost per MWh, not just build cost"],
    subQuestions: [
      "What do recent LCOE assessments say for each technology?",
      "How do system/integration costs change the comparison?",
      "Where do authoritative sources disagree, and why?",
    ],
  }),
  role: JSON.stringify({
    agent: "Energy Systems Analyst",
    role: "You are an energy systems analyst specializing in electricity generation economics. You prioritize levelized and system-cost comparisons over headline numbers, distrust vendor marketing, always anchor claims to named assessments (Lazard, IEA, OECD-NEA), and flag where credible sources disagree rather than picking favorites.",
  }),
  plan: JSON.stringify({
    restate: "The user needs an evidence-based comparison of nuclear vs solar+wind costs for grid decarbonization.",
    reportType: "general-research",
    academic: false,
    estimatedDifficulty: "moderate",
    priorKnowledge: "LCOE assessments (Lazard, IEA) generally show utility-scale solar and wind with lower levelized costs than new nuclear in western markets. Nuclear advocates argue system-integration costs (storage, backup, grid expansion) narrow the gap. Vogtle 3/4 and Hinkley Point C illustrate nuclear cost overruns.",
    unknowns: ["Latest LCOE ranges per technology", "Quantified system-integration costs", "Whether any recent study flips the ranking"],
    aspects: [
      {
        title: "Cost Metrics",
        question: "What do recent independent LCOE assessments say about nuclear vs solar and wind costs?",
        goal: "Establish like-for-like levelized cost ranges with named sources and years.",
        queries: ["levelized cost of energy LCOE comparison nuclear solar wind 2024", "Lazard LCOE 2024 nuclear solar wind"],
      },
      {
        title: "System Integration",
        question: "How do grid-integration and system costs affect the nuclear vs renewables comparison?",
        goal: "Quantify the hidden costs that change the headline ranking.",
        queries: ["system costs renewables grid integration nuclear comparison", "OECD NEA system cost solar wind nuclear"],
      },
    ],
  }),
  summarize:
    "- Utility-scale solar LCOE sits far below new nuclear in recent assessments [1].\n- Wind onshore is similarly cheaper than new nuclear builds [1].\n- Nuclear cost overruns at recent western projects (Vogtle, Hinkley Point C) push realized costs higher [2].\n- System-integration costs for renewables (storage, backup, grid) add meaningfully per MWh [2].\nGAPS: exact 2024 ranges, system-cost quantification",
  reflect: JSON.stringify({
    sufficient: true,
    assessment: "Evidence is thin — only two readable sources — and the cost story is incomplete, but the headline comparison is established.",
    learnings: [
      {
        claim: "Lazard's 2024 LCOE assessment puts utility-scale solar at roughly $29-92/MWh and new nuclear at $142-222/MWh",
        grade: "verified",
        basis: "agreed by both [1] and [2]",
      },
      {
        claim: "OECD-NEA estimates system costs of renewables add $20-40/MWh when grid integration is included",
        grade: "single-source",
        basis: "only [2] reports this figure",
      },
      {
        claim: "System-integration costs close most of the nuclear-renewables cost gap",
        grade: "contested",
        basis: "[2] supports it, [1] rejects it",
      },
    ],
    contradictions: [
      {
        claim: "Whether nuclear becomes cost-competitive once renewable system-integration costs are included",
        positions: "source [1] maintains renewables remain far cheaper even after integration costs, while source [2] argues integration costs close most of the gap",
      },
    ],
    followUps: [],
  }),
  critique: JSON.stringify({
    verdict: "solid",
    reasoning: "Headline cost comparison is established by two independent sources; the system-cost debate is flagged rather than hidden.",
    weakSections: [],
  }),
  verify: JSON.stringify({
    verdict: "unclear",
    reasoning: "Fresh sources discuss general cost ranges but do not address this specific comparison directly, so the claim stays as graded rather than confirmed or refuted.",
    correction: "",
  }),
  rerank: JSON.stringify({
    ranked: [
      { i: 2, why: "Primary assessment with concrete 2024 numbers — highest evidentiary value" },
      { i: 1, why: "Recent news context, useful for framing" },
      { i: 4, why: "Independent domain, good for diversity" },
    ],
    skip: [7],
  }),
  redteam: JSON.stringify({
    attacks: [
      {
        section: "Cost Metrics",
        claim: "Lazard's 2024 LCOE puts utility-scale solar at $29-92/MWh and new nuclear at $142-222/MWh",
        attack: "Exact LCOE ranges must be verified against the actual Lazard 2024 report — citing an assessment from memory without the primary document risks stale or invented numbers.",
        severity: "high",
      },
      {
        section: "System Integration",
        claim: "OECD-NEA estimates system costs of renewables add $20-40/MWh",
        attack: "Rests on a single secondary reference to an OECD-NEA estimate; the original methodology and year are unconfirmed.",
        severity: "medium",
      },
    ],
  }),
  "debate-pro": "The claim survives scrutiny on the evidence gathered: multiple recent assessments place utility-scale solar well below new nuclear on levelized cost, and even the higher system-integration estimates cited do not close a gap of this width. The proposer concedes the system-cost debate is real, but the burden of evidence sits squarely with anyone claiming the ranking flips.",
  "debate-con": "The skeptic's case rests on sourcing quality: the specific LCOE ranges trace back to a single assessment family, and the system-cost figures to one secondary reference. Regional variation (China, South Korea) is entirely absent from the evidence, and nuclear advocates argue those builds change the picture. The claim as stated is broader than the evidence supports.",
  "debate-judge": JSON.stringify({
    verdict: "unsettled",
    correctedClaim: "Whether renewables remain cheaper than new nuclear once regional build costs (not just western projects) and full system-integration costs are included remains open.",
    reasoning: "The evidence supports the headline ranking for western markets, but it is silent on non-western build costs and relies on one assessment family for the core numbers. The honest verdict is unsettled at the margins.",
  }),
  "cite-check": "__DYNAMIC__",
  score: JSON.stringify({
    overall: 7.4,
    dims: [
      { name: "evidence", score: 8.0, note: "Core cost figures are grounded; some single-source claims are hedged rather than asserted." },
      { name: "coverage", score: 7.5, note: "Both success criteria are addressed; regional variation outside western markets is thin." },
      { name: "honesty", score: 8.5, note: "Disagreements and single-source claims are surfaced rather than averaged away." },
      { name: "clarity", score: 6.5, note: "Dense numbers-heavy sections could use a comparison table." },
    ],
    criteria: [
      { criterion: "Compare like-for-like cost metrics (LCOE) from recent independent assessments", met: true, why: "Levelized ranges are given with named sources." },
      { criterion: "Account for grid-integration and system costs that change the ranking", met: true, why: "System-cost estimates are included and their contested nature flagged." },
      { criterion: "State where credible sources genuinely disagree instead of averaging it away", met: true, why: "A dedicated disagreements section presents both positions." },
    ],
    biggestWeakness: "The evidence base leans on one assessment family for its core numbers, and non-western build costs are absent.",
  }),
  diff:
    "- **New** — this run added explicit system-integration cost estimates and a self-scored quality audit that the previous run lacked.\n- **Changed** — the solar LCOE range is now stated as $29-92/MWh where the previous run cited only a point estimate near $40/MWh.\n- **Unsettled** — how much of the levelized gap integration costs actually erase remains contested, exactly as it was last run; nothing flipped.",
  draft:
    "Recent independent assessments place utility-scale solar at roughly **$29-92/MWh** and new nuclear at **$142-222/MWh** on a levelized basis [1]. Realized western nuclear projects have repeatedly overrun budgets — Vogtle 3/4 and Hinkley Point C being the canonical examples — which pushes effective costs toward the top of that range [2].\n\nThe picture changes once system costs enter: storage, backup capacity and grid expansion add an estimated $20-40/MWh for high-renewable systems [2]. Even so, the levelized gap is wide enough that most analysts find renewables retain the cost advantage [1]. Where sources genuinely disagree is on how much of the gap integration costs erase — a debate the report settles by presenting both positions rather than averaging them.",
  exec:
    "On levelized cost, utility-scale solar and wind sit well below new nuclear in every recent independent assessment — roughly $29-92/MWh versus $142-222/MWh. Grid-integration costs for renewables add an estimated $20-40/MWh, narrowing but not closing the gap. Credible sources disagree on how much of the gap system costs erase, and the report presents both positions explicitly.",
  conclusion:
    "Headline economics favor renewables; the honest caveat is that system-integration costs are real, contested, and growing as penetration rises. Anyone citing a single number for either side is overselling certainty.",
  title: "Nuclear vs Solar and Wind: What the Cost Evidence Actually Shows",
  related: JSON.stringify([
    "How much did Vogtle 3/4 cost per MWh versus projections?",
    "What is the carbon-intensity difference between the two paths?",
    "How do China's nuclear build costs compare with western projects?",
    "What breakthrough would make new nuclear cost-competitive?",
  ]),
  disagreements:
    "The two positions: utility-scale assessments maintain that renewables remain substantially cheaper even after integration costs [1], while system-level analyses argue those costs close most of the gap [2]. The weight of recent evidence favors the first position — the levelized gap is simply too wide for $20-40/MWh of integration costs to erase — but the disagreement is genuine, methodological, and unresolved.",
  generic: "ok",
};

function detect(text) {
  if (text.includes("intent router for DigDeep")) return "classify";
  if (text.includes("deep-research effort")) return "comprehend";
  if (text.includes("staffing a research task")) return "role";
  if (text.includes("exhaustive, well-cited research report")) return "plan";
  if (text.includes("dense research notes")) return "summarize";
  if (text.includes("iterative research process")) return "reflect";
  if (text.includes("critical reviewer")) return "critique";
  if (text.includes("independent fact-checker")) return "verify";
  if (text.includes("Rank the sources")) return "curate";
  if (text.includes("writing one section")) return "draft";
  if (text.includes("EXECUTIVE SUMMARY")) return "exec";
  if (text.includes("CONCLUSION")) return "conclusion";
  if (text.includes("professional report title")) return "title";
  if (text.includes("FOLLOW-UP questions")) return "related";
  // NB: check these BEFORE disagreements — the score/diff prompts embed the report
  // text, which itself contains the "Where sources disagree" heading.
  if (text.includes("PROPOSER in a structured fact-check debate")) return "debate-pro";
  if (text.includes("SKEPTIC in a structured fact-check debate")) return "debate-con";
  if (text.includes("JUDGE in a structured fact-check debate")) return "debate-judge";
  if (text.includes("HOSTILE reviewer")) return "redteam";
  if (text.includes("auditing the citations")) return "cite-check";
  if (text.includes("Grade it honestly")) return "score";
  if (text.includes("researched twice")) return "diff";
  if (text.includes("most worth READING IN FULL")) return "rerank";
  if (text.includes('section titled "Where sources disagree"')) return "disagreements";
  return "generic";
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let kind = "generic";
    try {
      const parsed = JSON.parse(body);
      const text = (parsed.messages || []).map((m) => m.content || "").join("\n");
      kind = detect(text);
      // curate: return the source numbers listed in the prompt, reversed (proves reordering)
      if (kind === "curate") {
        const nums = [...text.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));
        const out = nums.reverse();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out.length ? out : [1]) } }] }));
        console.log(`[mock] curate → ${JSON.stringify(out)}`);
        return;
      }
      // cite-check: verdict per CASE parsed from the prompt — case 1 re-anchored to the
      // first available source, case 2 dropped as unsupported, the rest supported
      if (kind === "cite-check") {
        const caseCount = (text.match(/^CASE \d+/gm) || []).length;
        const firstSrc = Number((text.match(/^All sources available[\s\S]*?^(\d+)\./m) || [])[1] || 1);
        const cases = [];
        for (let i = 1; i <= caseCount; i++) {
          cases.push(
            i === 1
              ? { case: i, verdict: "wrong-source", use: firstSrc }
              : i === 2
                ? { case: i, verdict: "unsupported", use: 0 }
                : { case: i, verdict: "supported", use: 0 }
          );
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ cases }) } }] }));
        console.log(`[mock] cite-check → ${caseCount} cases (1 wrong-source→[${firstSrc}], 1 unsupported, rest supported)`);
        return;
      }
      // rerank: return the candidate indices in REVERSE order (proves the reorder)
      if (kind === "rerank") {
        const idx = [...text.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));
        const ranked = idx.reverse().map((i) => ({ i, why: `reversed by mock (was #${i})` }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ranked, skip: [] }) } }] }));
        console.log(`[mock] rerank → reversed ${ranked.length} candidates`);
        return;
      }
    } catch {}
    const content = RESP[kind] ?? RESP.generic;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content,
              reasoning_content: `(mock reasoning) Serving deterministic response for purpose: ${kind}. This is the live thinking stream the UI shows while the answer is prepared.`,
            },
          },
        ],
      })
    );
    console.log(`[mock] ${kind} → ${content.length} chars`);
  });
});

server.listen(8787, "127.0.0.1", () => console.log("[mock] listening on 127.0.0.1:8787"));
