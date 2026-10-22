// DigDeep CPU probe v2 — staged, error-catching. Reports which operation
// survives on this account's plan: baseline → scrypt at increasing N →
// large JSON parse. Each stage is timed; failures are caught and reported.
import { scryptSync, randomBytes } from "node:crypto";

async function stage(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    return { stage: name, ok: true, ms: Date.now() - t, detail: detail ?? null };
  } catch (e) {
    return { stage: name, ok: false, ms: Date.now() - t, error: String(e && e.message || e) };
  }
}

export default {
  async fetch() {
    const results = [];
    results.push(await stage("baseline", () => 1 + 1));
    for (const N of [4096, 16384, 32768]) {
      results.push(
        await stage(`scrypt_N${N}`, () => {
          const hash = scryptSync("probe-password", randomBytes(16), 64, { N, r: 8, p: 1 });
          return hash.length;
        })
      );
    }
    results.push(
      await stage("json_200kb", () => {
        let big = "";
        for (let i = 0; i < 2000; i++) {
          big += `{"citation":${i},"text":"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod"}`;
        }
        return JSON.parse(`[${big}]`).length;
      })
    );
    return Response.json({ probe: "digdeep-cpu-probe-v2", results });
  },
};
