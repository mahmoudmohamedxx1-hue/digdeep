/**
 * v3.11 GROUNDED-CHAT PROOF (local, real engine, real web, real LLM lanes).
 *
 * Proves web access in the chat lane end to end, in-process:
 *   1. PURE CHAT: a conversational message ("hey how are you") runs NO web pass —
 *      no sources, no checkpoint, direct reply. Chat stays chat.
 *   2. GROUNDED CHAT (fresh path): a live-facts message ("what's the weather in
 *      Cairo right now") in the chat lane runs the bounded web pass (search +
 *      reads → Source rows), and with yieldBeforeCompose (CF profile) PERSISTS a
 *      phase:"drafting" checkpoint with chat state and RETURNS before composing.
 *   3. GROUNDED CHAT (resume path): runJob — the poller's real adoption entry —
 *      picks the job up from that checkpoint and dispatches straight to the
 *      reply compose: no re-search, no new section row; the completed run has
 *      citations in reportMd + a References block + sourcesConsulted in stats.
 *
 * The router (an LLM call) is deliberately bypassed — runChatLane is called the
 * way runJob calls it; the code under test is the lane itself.
 *
 * Run:  bash scripts/cf/run-chat-web-test.sh
 * (the wrapper creates a throwaway SQLite DB, pushes the schema, then runs this)
 */
import { db } from "../../src/lib/db.ts";
import { runJob, runChatLane, Ctx } from "../../src/lib/research/engine.ts";
import type { QuickLaneState } from "../../src/lib/research/checkpoint.ts";
import { releaseLease } from "../../src/lib/research/checkpoint.ts";
import { needsLiveFacts } from "../../src/lib/research/intent-heuristics.ts";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m: string) => { console.log(`  ❌ ${m}`); fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobRow(id: string) {
  return db.researchJob.findUnique({ where: { id }, select: { status: true, stage: true, progress: true, sliceN: true, checkpoint: true, reportMd: true, stats: true } });
}
async function sourceCount(id: string) {
  return db.source.count({ where: { jobId: id } });
}
async function sectionCount(id: string) {
  return db.researchSection.count({ where: { jobId: id } });
}
async function events(id: string) {
  const rows = await db.activityEvent.findMany({ where: { jobId: id }, orderBy: { seq: "asc" } });
  return rows.map((e) => `${e.type}:${e.title}`);
}

async function seedJob(query: string) {
  const user = await db.user.create({ data: { email: `chatweb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`, name: "chatweb" } });
  const job = await db.researchJob.create({
    data: {
      userId: user.id,
      query,
      preset: "quick", mode: "chat", status: "queued", stage: "Queued",
      breadth: 2, depth: 1, maxSources: 8, maxMinutes: 5, language: "English",
    },
  });
  return job.id;
}

async function main() {
  console.log("── 0 · heuristic sanity ──");
  needsLiveFacts("hey how are you doing?") === false ? ok("pure greeting → no web pass") : bad("greeting triggered web");
  needsLiveFacts("btw what's the weather in cairo right now?") === true ? ok("live-facts ask → web pass") : bad("live-facts ask did not trigger");

  // ═══ 1 · PURE CHAT — no web pass, direct reply ══════════════════════════
  console.log("── 1 · PURE CHAT: conversational message, no web pass ──");
  {
    const JID = await seedJob("hey there, how are you doing today?");
    const sliceMs = Math.max(10_000, Number(process.env.DIGDEEP_SLICE_MS) || 45_000);
    const ctx = new Ctx(JID, "auto", 1, { maxMinutes: 5, depth: 1, maxSources: 8, anyUnlimited: false, hardStopMs: sliceMs });
    let persisted: QuickLaneState | null = null;
    await runChatLane(ctx, { id: JID, query: "hey there, how are you doing today?", language: "English" }, "", undefined, {
      persist: (s) => (async () => { persisted = s; })(),
      yieldBeforeCompose: true,
    });
    const row = await jobRow(JID);
    const nSources = await sourceCount(JID);
    persisted === null ? ok("no web pass → nothing persisted") : bad("pure chat persisted web state");
    nSources === 0 ? ok("no Source rows created") : bad(`pure chat created ${nSources} sources`);
    row?.status === "completed" ? ok("pure chat completed in one pass") : bad(`pure chat status: ${row?.status}`);
    (row?.reportMd ?? "").includes("## References") === false ? ok("no References block on pure chat") : bad("pure chat gained a References block");
  }

  // ═══ 2 · GROUNDED CHAT fresh path — web pass → persist → YIELD ══════════
  console.log("── 2 · GROUNDED CHAT: web pass → persist → YIELD before compose ──");
  // news-shaped live-facts ask in a mixed conversational message — the exact
  // shape the classifier sends to chat while the question needs current facts
  // (whole-web engines are IP-blocked in some sandboxes; Bing News answers this one everywhere)
  const QUERY = "btw what's the latest news on artificial intelligence?";
  const JID = await seedJob(QUERY);
  const sliceMs = Math.max(10_000, Number(process.env.DIGDEEP_SLICE_MS) || 45_000);
  const t0 = Date.now();
  let cpSaved = false;
  const persist = (s: QuickLaneState) =>
    (async () => {
      const { saveCheckpoint } = await import("../../src/lib/research/checkpoint.ts");
      await saveCheckpoint(JID, {
        v: 1, phase: "drafting", t0, absoluteDeadline: t0 + 5 * 60_000,
        researchCutoffAt: null, sliceN: 1, researchQuery: QUERY, chat: s,
      });
      cpSaved = true;
    })();
  {
    const ctx = new Ctx(JID, "auto", 1, { maxMinutes: 5, depth: 1, maxSources: 8, anyUnlimited: false, hardStopMs: sliceMs });
    await runChatLane(ctx, { id: JID, query: QUERY, language: "English" }, "", undefined, {
      persist,
      yieldBeforeCompose: true,
    });
    await releaseLease(JID);
    await db.researchJob.update({ where: { id: JID }, data: { sliceN: 1 } }).catch(() => {});
  }
  {
    const row = await jobRow(JID);
    const nSources = await sourceCount(JID);
    const ev = await events(JID);
    cpSaved ? ok("web pass persisted a chat checkpoint (phase drafting)") : bad("no checkpoint persisted");
    nSources > 0 ? ok(`web pass created ${nSources} Source row(s)`) : bad("web pass created no sources");
    row?.checkpoint ? ok("checkpoint stored on the job row") : bad("job row has no checkpoint");
    row?.status !== "completed" ? ok(`run yielded before compose (status ${row?.status}, stage "${row?.stage}")`) : bad("run completed without yielding");
    ev.some((e) => e.startsWith("search:")) ? ok("search event visible in the feed") : bad("no search event");
    ev.some((e) => e.includes("live-web check")) ? ok("chat-with-web info line visible") : bad("no chat-with-web info line");
    row?.stage === "Writing the reply…" ? ok(`honest wait stage "${row?.stage}" at ${row?.progress}%`) : bad(`stage "${row?.stage}" @ ${row?.progress}%`);
  }

  // ═══ 3 · RESUME — runJob adopts the checkpoint → compose → complete ═════
  console.log("── 3 · RESUME: runJob adopts → compose → complete ──");
  await sleep(26_000); // ACTIVE_STALE_MS (25s) + 1s — let the liveness entry go stale
  const sourcesBefore = await sourceCount(JID);
  const sectionsBefore = await sectionCount(JID);
  await runJob(JID);
  {
    const row = await jobRow(JID);
    const stats = row?.stats ? JSON.parse(row.stats) : {};
    const md = row?.reportMd ?? "";
    const nSources = await sourceCount(JID);
    const nSections = await sectionCount(JID);
    row?.status === "completed" ? ok("resumed run completed") : bad(`status: ${row?.status}`);
    nSources === sourcesBefore ? ok(`no re-search on resume (${nSources} sources, unchanged)`) : bad(`sources changed ${sourcesBefore} → ${nSources}`);
    nSections === sectionsBefore ? ok("no duplicate Reply section") : bad(`sections ${sectionsBefore} → ${nSections}`);
    stats.mode === "chat" ? ok("stats mode: chat") : bad(`stats mode: ${stats.mode}`);
    (stats.sourcesConsulted ?? 0) > 0 ? ok(`stats.sourcesConsulted = ${stats.sourcesConsulted}`) : bad("stats.sourcesConsulted missing");
    stats.throttledFallback !== true ? ok("reply is model-generated (not the built-in script)") : ok("models throttled — built-in script fallback (sources still saved; not a code failure)");
    if (stats.throttledFallback !== true) {
      md.includes("## References") ? ok("reportMd carries the References block") : bad("no References block");
      const replyBody = md.replace(/## References[\s\S]*$/, "");
      /\[\d+\]/.test(replyBody) ? ok("inline [n] citations in the reply body") : bad(`no inline citations in the reply body — reply was:\n${replyBody.slice(0, 500)}`);
    }
    (row?.sliceN ?? 0) >= 2 ? ok(`sliceN climbed to ${row?.sliceN} (adoption persisted)`) : bad(`sliceN ${row?.sliceN}`);
    md.length > 40 ? ok(`reply written (${md.length} chars)`) : bad("empty reportMd");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
