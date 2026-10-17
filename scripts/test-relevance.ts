/** Unit test: relevance gate on the exact ECL scenario — the film pages, toy
 *  repos and math papers from the user's garbage run must be dropped; real
 *  IFRS/Big-4 methodology pages must be kept. */
import { gateByRelevance, keyTerms } from "../src/lib/research/relevance";

const question = "How to derive a country's forward-looking factor for ECL reporting, using the same methodology the Big 4 firms use";
/** round-1 queries as the retrained planner now writes them (domain vocabulary) */
const queries = [
  "IFRS 9 expected credit loss forward-looking information methodology",
  "ECL macroeconomic scenarios Big 4 PwC KPMG Deloitte EY",
  "forward-looking overlay probability of default country risk GDP unemployment ECL",
];
const queriesText = queries.join(" ");

const results = [
  // ---- the garbage from the user's actual run (must ALL be dropped) ----
  { title: "Quit When You Can: Efficient Evaluation of Ensembles with Ordering Optimization", snippet: "We study greedy algorithms for evaluating ensembles with ordering optimization; 4-approximation guarantee, speedups of 2x-4x in ensemble evaluation.", domain: "arxiv.org" },
  { title: "Catch Me If You Can - Wikipedia", snippet: "Catch Me If You Can is a 2002 American biographical crime film directed by Steven Spielberg, starring Leonardo DiCaprio as Frank Abagnale, who conned Pan Am.", domain: "en.wikipedia.org" },
  { title: "Can you hear your location on a manifold?", snippet: "We consider the problem of identifying a location on a manifold through acoustic analysis. Sound and geometry of the manifold.", domain: "arxiv.org" },
  { title: "Google Docs Gets Voice Typing, Templates, Smart Sheets and More", snippet: "Google announced voice typing, templates and smart sheets in Google Docs at a press event.", domain: "techcrunch.com" },
  { title: "You Can Count on Me - Wikipedia", snippet: "You Can Count on Me is a 2000 American drama film written and directed by Kenneth Lonergan, starring Laura Linney and Mark Ruffalo.", domain: "en.wikipedia.org" },
  { title: "Tell Me You Love Me (TV series) - Wikipedia", snippet: "Tell Me You Love Me is an American television drama series that aired on HBO.", domain: "en.wikipedia.org" },
  { title: "in-class-project-2", snippet: "A fun animated film about bees — the story of a bee who sues the human race. GitHub repository for a class project.", domain: "github.com" },
  // ---- what a good round should have found (must ALL be kept) ----
  { title: "IFRS 9 — Expected credit loss: Forward-looking information", snippet: "How to incorporate forward-looking information including macroeconomic forecasts into expected credit loss measurement. IFRS 9 requires reasonable and supportable forward-looking information, scenario weighting, probability of default models.", domain: "pwc.com" },
  { title: "Expected credit loss - Wikipedia", snippet: "In accounting, expected credit loss (ECL) is the expected loss on a financial asset under IFRS 9. ECL uses probability of default (PD), loss given default (LGD) and exposure at default, with forward-looking macroeconomic scenarios.", domain: "en.wikipedia.org" },
  { title: "ECL macroeconomic scenarios methodology", snippet: "Big 4 methodology for ECL: base, upside and downside macroeconomic scenarios weighted to derive a probability-weighted ECL. Forward-looking overlays adjust PDs for GDP, unemployment forecasts at country level.", domain: "kpmg.com" },
  { title: "Applying IFRS 9: Expected Credit Loss model", snippet: "Deloitte guidance on the ECL model: lifetime vs 12-month expected credit loss, staging, forward-looking information and macroeconomic overlays per IFRS 9.", domain: "deloitte.com" },
];

const scored = gateByRelevance(question, queriesText, results);
console.log("question terms:", keyTerms(`${question} ${queriesText}`).join(", "));
console.log(`\nkept ${scored.kept.length}/${results.length} (median score ${scored.keptScore.toFixed(2)})\n`);
for (const k of scored.kept) console.log(`  KEPT   ${k.domain.padEnd(18)} ${k.title.slice(0, 60)}`);
console.log("");
for (const d of scored.dropped) console.log(`  DROP   ${d.domain.padEnd(18)} ${d.title.slice(0, 60)}`);

const expectKept = ["pwc.com", "en.wikipedia.org", "kpmg.com", "deloitte.com"];
const ok =
  scored.kept.length === 4 &&
  expectKept.every((dm) => scored.kept.some((k) => k.domain === dm)) &&
  scored.dropped.length === 7;
console.log("\nVERDICT:", ok ? "PASS — garbage dropped, methodology pages kept" : "FAIL");
if (!ok) process.exit(1);

// ---- case 2: the user's ACTUAL run — everything the engines returned was garbage.
// kept must be EMPTY so the engine fires the query-reformulation path.
const garbageOnly = results.slice(0, 7);
const g2 = gateByRelevance(question, queriesText, garbageOnly);
console.log(`\ncase2 (all-garbage pool): kept ${g2.kept.length} — ${g2.kept.length === 0 ? "PASS (reformulation will fire)" : "FAIL"}`);
if (g2.kept.length !== 0) process.exit(1);

// ---- case 3: benign consumer query — must NOT over-drop (a normal review page survives)
const q3 = "What are the best mechanical keyboards for programming in 2026?";
const queries3 = "best mechanical keyboards 2026 programming switches keycaps review";
const pool3 = [
  { title: "The best mechanical keyboards of 2026", snippet: "We tested the best mechanical keyboards with hot-swappable switches, PBT keycaps, and wireless modes for programming.", domain: "theverge.com" },
  { title: "Catch Me If You Can - Wikipedia", snippet: "2002 American biographical crime film directed by Steven Spielberg.", domain: "en.wikipedia.org" },
  { title: "Keyboard (computing) - Wikipedia", snippet: "In computing, a keyboard is a typewriter-style device which uses an arrangement of buttons or keys to act as mechanical levers.", domain: "en.wikipedia.org" },
];
const g3 = gateByRelevance(q3, queries3, pool3);
console.log(`case3 (consumer query): kept ${g3.kept.length}/3 — kept: ${g3.kept.map((k) => k.domain).join(", ")}`);
if (!(g3.kept.some((k) => k.domain === "theverge.com") && !g3.kept.some((k) => k.title.includes("Catch Me")))) {
  console.log("case3 FAIL"); process.exit(1);
}
console.log("\nALL CASES PASS");
