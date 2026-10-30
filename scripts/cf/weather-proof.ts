/**
 * v3.11 targeted proof — the user's exact failing case: "weather in cairo".
 * Runs the REAL chat lane (real web pass + real LLM) end-to-end and prints
 * the actual reply, so the fix is demonstrated on the exact query shape the
 * operator reported as broken on the (stale) deployed worker.
 *
 * Flow: needsLiveFacts trigger → chatSearchQuery cleaner → runChatLane fresh
 * (web pass, checkpoint, yield) → runJob adoption → reply with [n] citations.
 *
 * Run:  bash scripts/cf/run-weather-proof.sh
 */
import { db } from "../../src/lib/db.ts";
import { runJob, runChatLane, Ctx } from "../../src/lib/research/engine.ts";
import { releaseLease, saveCheckpoint } from "../../src/lib/research/checkpoint.ts";
import { needsLiveFacts, chatSearchQuery } from "../../src/lib/research/intent-heuristics.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUERY = "hey, what's the weather in cairo right now?";

async function main() {
  console.log("══ WEATHER-IN-CAIRO CHAT PROOF ══");
  console.log(`query: ${JSON.stringify(QUERY)}`);
  console.log(`needsLiveFacts → ${needsLiveFacts(QUERY)}`);
  console.log(`chatSearchQuery → ${JSON.stringify(chatSearchQuery(QUERY))}`);
  if (!needsLiveFacts(QUERY)) { console.error("FAIL: heuristic did not trigger"); process.exit(1); }

  const user = await db.user.create({ data: { email: `weather-${Date.now()}@test.local`, name: "weather-proof" } });
  const job = await db.researchJob.create({
    data: {
      userId: user.id, query: QUERY, preset: "quick", mode: "chat", status: "queued", stage: "Queued",
      breadth: 2, depth: 1, maxSources: 8, maxMinutes: 5, language: "English",
    },
  });
  const JID = job.id;
  const sliceMs = Math.max(10_000, Number(process.env.DIGDEEP_SLICE_MS) || 45_000);
  const t0 = Date.now();
  let cpSaved = false;
  const persist = (s: never) =>
    (async () => {
      await saveCheckpoint(JID, {
        v: 1, phase: "drafting", t0, absoluteDeadline: t0 + 5 * 60_000,
        researchCutoffAt: null, sliceN: 1, researchQuery: QUERY, chat: s,
      });
      cpSaved = true;
    })();

  console.log("\n── fresh path: web pass → checkpoint → yield ──");
  {
    const ctx = new Ctx(JID, "auto", 1, { maxMinutes: 5, depth: 1, maxSources: 8, anyUnlimited: false, hardStopMs: sliceMs });
    await runChatLane(ctx, { id: JID, query: QUERY, language: "English" }, "", undefined, { persist, yieldBeforeCompose: true });
    await releaseLease(JID);
    await db.researchJob.update({ where: { id: JID }, data: { sliceN: 1 } }).catch(() => {});
  }
  {
    const row = await db.researchJob.findUnique({ where: { id: JID }, select: { status: true, stage: true, progress: true } });
    const sources = await db.source.findMany({ where: { jobId: JID }, select: { title: true, domain: true }, take: 8 });
    console.log(`checkpoint persisted: ${cpSaved}`);
    console.log(`job after fresh pass: status=${row?.status} stage="${row?.stage}" progress=${row?.progress}%`);
    console.log(`sources found (${sources.length}):`);
    for (const s of sources) console.log(`  - [${s.domain}] ${s.title}`);
  }

  console.log("\n── resume: runJob adopts → compose → complete ──");
  await sleep(26_000); // ACTIVE_STALE_MS + 1s — let the liveness entry go stale
  await runJob(JID);
  {
    const row = await db.researchJob.findUnique({ where: { id: JID }, select: { status: true, reportMd: true, stats: true, sliceN: true } });
    const stats = row?.stats ? JSON.parse(row.stats) : {};
    console.log(`final status: ${row?.status} (sliceN=${row?.sliceN})`);
    console.log(`stats: mode=${stats.mode} sourcesConsulted=${stats.sourcesConsulted} engines=${stats.searchEnginesUsed ?? "?"} throttledFallback=${stats.throttledFallback === true}`);
    console.log("\n══ REPLY (reportMd) ══");
    console.log(row?.reportMd ?? "(empty)");
    const ok = row?.status === "completed" && /\[\d+\]/.test((row?.reportMd ?? "").replace(/## References[\s\S]*$/, ""));
    console.log(`\n${ok ? "PROOF PASS" : "PROOF FAIL"}: ${ok ? "grounded reply with inline citations, completed via the real resume path" : "see output above"}`);
    process.exit(ok ? 0 : 1);
  }
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
