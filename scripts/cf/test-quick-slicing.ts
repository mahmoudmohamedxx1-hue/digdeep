/**
 * v3.9.1 QUICK-LANE SLICING PROOF (local, real engine, real web, real LLM lanes).
 *
 * Proves the CF-free-plan survival fix end to end, in-process:
 *   1. FRESH PATH: with yieldBeforeCompose (CF profile), runQuickLane runs
 *      search+read, PERSISTS a phase:"drafting" checkpoint with quick-lane
 *      state, emits the slice-boundary event, and RETURNS before composing.
 *   2. RESUME PATH: runJob (the poller's real adoption entry) picks the job up
 *      from that checkpoint, dispatches straight to compose — no re-search,
 *      no new section — and completes the run.
 *   3. SALVAGE: a resumed run whose section row holds a dead attempt's partial
 *      draft (>=400 chars, flushed every ~1.1s by llmLive) completes FROM it.
 *
 * The router (an LLM call) is deliberately bypassed in step 1 — its lane pick
 * is nondeterministic; the code under test is everything AFTER the pick.
 *
 * Run:  bash scripts/cf/run-quick-slicing-test.sh
 * (the wrapper creates a throwaway SQLite DB, pushes the schema, then runs this)
 */
import { db } from "../../src/lib/db.ts";
import { runJob, runQuickLane, Ctx } from "../../src/lib/research/engine.ts";
import type { EngineCheckpoint, QuickLaneState } from "../../src/lib/research/checkpoint.ts";
import { releaseLease } from "../../src/lib/research/checkpoint.ts";

let pass = 0;
let fail = 0;
const ok = (m: string) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m: string) => { console.log(`  ❌ ${m}`); fail++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobRow(id: string) {
  return db.researchJob.findUnique({ where: { id }, select: { status: true, stage: true, progress: true, sliceN: true, checkpoint: true, reportMd: true } });
}
async function events(id: string) {
  const rows = await db.activityEvent.findMany({ where: { jobId: id }, orderBy: { seq: "asc" } });
  return rows.map((e) => `${e.type}:${e.title}`);
}

async function main() {
  console.log("── seed user + a queued quick job ──");
  const user = await db.user.create({
    data: { email: `slicing-test-${Date.now()}@test.local`, name: "slicing" },
  });
  const job = await db.researchJob.create({
    data: {
      userId: user.id,
      query: "What is the wingspan of a wandering albatross?",
      preset: "quick", mode: "quick", status: "queued", stage: "Queued",
      breadth: 2, depth: 1, maxSources: 8, maxMinutes: 5, language: "English",
    },
  });
  const JID = job.id;

  console.log("── 1 · FRESH PATH: search+read → persist → YIELD before compose ──");
  // exactly what runJob's quick dispatch constructs (CF profile: yield before compose)
  const sliceMs = Math.max(10_000, Number(process.env.DIGDEEP_SLICE_MS) || 45_000);
  const t0 = Date.now();
  const persist = (s: QuickLaneState) =>
    (async () => {
      const { saveCheckpoint } = await import("../../src/lib/research/checkpoint.ts");
      await saveCheckpoint(JID, {
        v: 1, phase: "drafting", t0, absoluteDeadline: t0 + 5 * 60_000,
        researchCutoffAt: null, sliceN: 1, researchQuery: job.query, quick: s,
      });
    })();
  const ctx = new Ctx(JID, "auto", 1, { maxMinutes: 5, depth: 1, maxSources: 8, anyUnlimited: false, hardStopMs: sliceMs });
  await runQuickLane(ctx, { id: JID, query: job.query, language: "English" }, "", {
    persist,
    yieldBeforeCompose: true,
  });
  // mirror runJob's finally (the direct call bypassed it): release the lease the
  // checkpoint renewed, persist sliceN, and let the same-instance liveness entry
  // (heartbeated by every ctx.emit — see engine.ts Ctx.emit) go stale, exactly
  // as it would the instant runJob's finally ran activeJobs.delete(jobId).
  await releaseLease(JID);
  await db.researchJob.update({ where: { id: JID }, data: { sliceN: 1 } }).catch(() => {});
  await sleep(26_000); // ACTIVE_STALE_MS (25s) + 1s — the real flow deletes the entry in finally

  let row = await jobRow(JID);
  let ev = await events(JID);
  if (row?.status === "researching" && (row.progress ?? 0) >= 80) ok(`yielded at the compose boundary (status=researching, progress=${row.progress})`);
  else bad(`post-yield state: ${row?.status}/${row?.progress} (want researching/80)`);
  const cp = row?.checkpoint ? (JSON.parse(row.checkpoint) as EngineCheckpoint) : null;
  if (cp?.phase === "drafting" && !!cp.quick?.secId) ok(`checkpoint: phase=drafting, quick.secId=${cp.quick!.secId.slice(0, 10)}…, ${cp.quick!.valid.length} read source(s) kept`);
  else bad(`checkpoint shape: phase=${cp?.phase}, quick=${!!cp?.quick}`);
  if (ev.some((e) => e.includes("Slice boundary — composing the answer in a fresh slice"))) ok("slice-boundary event emitted");
  else bad("slice-boundary event missing");
  if (!ev.some((e) => e.includes("Composing a quick answer"))) ok("compose did NOT start in slice 1 (the whole point of the yield)");
  else bad("compose ran inside slice 1 — yieldBeforeCompose not honored");
  const searchesAfterSlice1 = ev.filter((e) => e.startsWith("search:")).length;
  const secCount = await db.researchSection.count({ where: { jobId: JID } });
  if (secCount === 1) ok("exactly one Quick-answer section row");
  else bad(`section rows after slice 1: ${secCount}`);

  console.log("── 2 · RESUME PATH: runJob adoption dispatches straight to compose ──");
  await runJob(JID);
  row = await jobRow(JID);
  ev = await events(JID);
  if (row?.status === "completed") ok("run completed on the resume slice");
  else bad(`status after resume: ${row?.status} (stage=${row?.stage})`);
  if ((row?.reportMd ?? "").length > 200) ok(`report written (${row?.reportMd?.length} chars)`);
  else bad(`report too short: ${row?.reportMd?.length ?? 0}`);
  if (ev.filter((e) => e.startsWith("search:")).length === searchesAfterSlice1) ok("NO new search on resume (sources kept from the checkpoint)");
  else bad("resume re-searched — checkpoint not honored");
  if (secCount === (await db.researchSection.count({ where: { jobId: JID } }))) ok("no new section row on resume");
  else bad("resume created another section row");
  if (ev.some((e) => e.includes("Continuing the quick answer"))) ok("continuation event emitted");
  else bad("continuation event missing");
  if ((row?.sliceN ?? 0) >= 2) ok(`sliceN climbed across adoptions (${row?.sliceN})`);
  else bad(`sliceN after resume: ${row?.sliceN}`);

  console.log("── 3 · SALVAGE: a dead attempt's partial draft completes the run ──");
  const job2 = await db.researchJob.create({
    data: {
      userId: user.id,
      query: "How tall is the Eiffel Tower?",
      preset: "quick", mode: "quick", status: "queued", stage: "Queued",
      breadth: 2, depth: 1, maxSources: 8, maxMinutes: 5, language: "English",
    },
  });
  // slice 1 for job2: same fresh path (search+read → persist → yield)
  const ctx2 = new Ctx(job2.id, "auto", 1, { maxMinutes: 5, depth: 1, maxSources: 8, anyUnlimited: false, hardStopMs: sliceMs });
  await runQuickLane(ctx2, { id: job2.id, query: job2.query, language: "English" }, "", {
    persist: (s) => (async () => {
      const { saveCheckpoint } = await import("../../src/lib/research/checkpoint.ts");
      await saveCheckpoint(job2.id, {
        v: 1, phase: "drafting", t0: Date.now(), absoluteDeadline: Date.now() + 5 * 60_000,
        researchCutoffAt: null, sliceN: 1, researchQuery: job2.query, quick: s,
      });
    })(),
    yieldBeforeCompose: true,
  });
  await releaseLease(job2.id); // mirror runJob's finally
  await db.researchJob.update({ where: { id: job2.id }, data: { sliceN: 1 } }).catch(() => {});
  await sleep(26_000); // same-instance liveness window (see step 1)
  let row2 = await jobRow(job2.id);
  const cp2 = row2?.checkpoint ? (JSON.parse(row2.checkpoint) as EngineCheckpoint) : null;
  if (cp2?.quick?.secId) {
    // simulate the dead attempt: the stream flushed a long partial into the section
    const partial =
      "The Eiffel Tower stands 330 metres (1,083 ft) tall [1], including its antennas, " +
      "and was the tallest man-made structure in the world upon its completion in 1889 [2]. " +
      "Its height has changed over the decades as antennas were added: the original structure " +
      "was about 300 metres, and today's broadcast antennas bring the total to roughly 330 " +
      "metres [1]. The tower was designed by Gustave Eiffel's engineering company for the 1889 " +
      "World's Fair in Paris, and it was initially criticized by many prominent artists and " +
      "intellectuals of the time [2]. Today it is one of the most visited paid monuments in " +
      "the world, and its height makes it visible from much of central Paris on a clear day.";
    await db.researchSection.update({ where: { id: cp2.quick.secId }, data: { draftMd: partial } });
    ok(`partial draft (${partial.length} chars) staged in the dead attempt's section`);
  } else {
    bad("no quick checkpoint for job2 — cannot stage salvage");
  }
  await runJob(job2.id); // the adoption: must salvage, not re-compose
  row2 = await jobRow(job2.id);
  const ev2 = await events(job2.id);
  if (row2?.status === "completed") ok("salvage run completed");
  else bad(`salvage status: ${row2?.status} (stage=${row2?.stage})`);
  if (ev2.some((e) => e.includes("Recovering the interrupted answer"))) ok("salvage event emitted");
  else bad("salvage event missing — did it re-compose instead?");
  if ((row2?.reportMd ?? "").includes("330 metres")) ok("the report IS the salvaged partial, not a fresh compose");
  else bad("report does not contain the staged partial text");
  if (ev2.filter((e) => e.includes("Composing a quick answer")).length === 0) ok("no compose LLM call was spent (the salvage skipped it)");
  else bad("a compose ran despite the salvageable draft");

  console.log("── cleanup ──");
  await db.researchJob.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await db.user.delete({ where: { id: user.id } }).catch(() => {});
  await db.$disconnect?.();

  console.log("");
  if (fail === 0) console.log(`QUICK-LANE SLICING PROOF: ALL ${pass} CHECKS PASSED`);
  else console.log(`QUICK-LANE SLICING PROOF: ${fail} FAILURES (of ${pass + fail})`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("PROOF CRASHED:", e);
  process.exit(1);
});
