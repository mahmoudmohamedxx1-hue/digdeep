/** Debug probe: what does searchAll return for the cleaned chat query? */
import { searchAll } from "../../src/lib/research/search.ts";
import { chatSearchQuery } from "../../src/lib/research/intent-heuristics.ts";
import { gateByRelevance } from "../../src/lib/research/relevance.ts";

async function main() {
const raw = process.argv[2] ?? "btw what's the weather in cairo right now?";
const sq = chatSearchQuery(raw);
console.log(`cleaned query: "${sq}"\n`);
const rs = await searchAll(sq, { academic: false });
console.log(`total results: ${rs.length}`);
for (const r of rs.slice(0, 12)) {
  console.log(`  [${r.engine}] ${r.domain} — ${r.title?.slice(0, 70)}`);
}
const gated = gateByRelevance(sq, raw, rs.filter((r) => r.url && !r.domain.includes("duckduckgo.com")));
console.log(`\ngated: kept ${gated.kept.length}, dropped ${gated.dropped.length}`);
for (const r of gated.kept.slice(0, 6)) {
  console.log(`  KEPT [${r.engine}] ${r.domain} — ${r.title?.slice(0, 60)}`);
}
}
main().catch((e)=>{console.error(e);process.exit(1);});
