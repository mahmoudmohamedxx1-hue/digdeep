/** Quick smoke test: verify Prisma talks to the local embedded Postgres. */
process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5433/digdeep";
import { db } from "../src/lib/db";

const job = await db.researchJob.create({
  data: {
    query: "pg smoke test",
    preset: "quick",
    status: "completed",
    stage: "Done",
    progress: 100,
    completedAt: new Date(),
  },
});
console.log("created job:", job.id);

const ev = await db.activityEvent.create({
  data: { jobId: job.id, seq: 1, type: "info", title: "smoke" },
});
console.log("created event:", ev.id, "seq", ev.seq);

const src = await db.source.create({
  data: { jobId: job.id, url: "https://example.com/x", domain: "example.com", title: "Example", engine: "ddg" },
});
console.log("created source:", src.id);

const agg = await db.activityEvent.aggregate({ where: { jobId: job.id }, _max: { seq: true } });
console.log("aggregate max seq:", agg._max.seq);

const found = await db.researchJob.findFirst({
  where: { threadId: null, status: "completed", reportMd: { not: null } },
  orderBy: { createdAt: "desc" },
});
console.log("findFirst (reportMd not null) ok:", found === null);

const up = await db.setting.upsert({
  where: { key: "smoke" },
  update: { value: "1" },
  create: { key: "smoke", value: "1" },
});
console.log("upsert ok:", up.key);

await db.researchJob.delete({ where: { id: job.id } }); // cascades
await db.setting.delete({ where: { key: "smoke" } });
const count = await db.researchJob.count();
console.log("cascade delete ok, remaining jobs:", count);
console.log("ALL POSTGRES SMOKE TESTS PASSED");
process.exit(0);
