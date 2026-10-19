/** quick DB probe: stop timeline for a thread */
import { Client } from "pg";
const c = new Client({ connectionString: "postgresql://postgres:postgres@localhost:5433/digdeep" });
await c.connect();
const tid = process.argv[2];
const j = await c.query('select id,status,stage,"cancelRequested","updatedAt" from "ResearchJob" where "threadId" like $1', [tid + "%"]);
console.log("JOB:", j.rows[0]);
if (j.rows[0]) {
  const e = await c.query('select seq, to_char(ts,\'HH24:MI:SS\') as t, type, title from "ActivityEvent" where "jobId" = $1 and seq >= 9999990 order by seq', [j.rows[0].id]);
  console.log("TAIL EVENTS:");
  for (const r of e.rows) console.log(`  ${r.t} seq=${r.seq} [${r.type}] ${r.title}`);
  const last = await c.query('select to_char(ts,\'HH24:MI:SS\') as t, seq, title from "ActivityEvent" where "jobId" = $1 and seq < 9999990 order by seq desc limit 3', [j.rows[0].id]);
  console.log("LAST WORK EVENTS:");
  for (const r of last.rows) console.log(`  ${r.t} seq=${r.seq} ${r.title}`);
}
await c.end();
