// digdeep-pg-probe v2 — temporary diagnostic worker (delete after use).
// Manually walks the Postgres connection stages to find where Supabase's
// pooler connection dies on workerd: raw TCP, the SSLRequest dance, direct
// TLS, and pg with TLS disabled.
import pg from "pg";
import net from "node:net";
import tls from "node:tls";

const decoder = new TextDecoder();

async function rawTcp(host, port, ms = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port }, () => {
      resolve({ ok: true, ms: Date.now() - t0, note: "tcp connect callback fired" });
      s.destroy();
    });
    s.on("error", (e) => resolve({ ok: false, ms: Date.now() - t0, error: String(e.message), code: e.code }));
    s.setTimeout(ms, () => { resolve({ ok: false, ms: Date.now() - t0, error: "timeout" }); s.destroy(); });
  });
}

async function sslDance(host, port, ms = 6000) {
  // PostgreSQL SSLRequest: int32 len=8, int32 code=80877103 → server replies 'S' or 'N'
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port }, () => {
      const buf = Buffer.alloc(8);
      buf.writeInt32BE(8, 0);
      buf.writeInt32BE(80877103, 4);
      s.write(buf);
    });
    let got = "";
    s.on("data", (d) => {
      got += decoder.decode(d);
      if (got.length >= 1) {
        resolve({ ok: true, ms: Date.now() - t0, reply: JSON.stringify(got[0]), note: "'S'=TLS supported, 'N'=not" });
        s.destroy();
      }
    });
    s.on("error", (e) => resolve({ ok: false, ms: Date.now() - t0, error: String(e.message), gotSoFar: JSON.stringify(got), code: e.code }));
    s.on("close", () => resolve({ ok: got.length > 0, ms: Date.now() - t0, reply: JSON.stringify(got) || "closed with zero bytes", error: got ? undefined : "socket closed before any data" }));
    s.setTimeout(ms, () => { resolve({ ok: false, ms: Date.now() - t0, error: "timeout", gotSoFar: JSON.stringify(got) }); s.destroy(); });
  });
}

async function directTls(host, port, ms = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port, rejectUnauthorized: false, servername: host }, () => {
      const cert = s.getPeerCertificate();
      resolve({ ok: true, ms: Date.now() - t0, protocol: s.getProtocol(), cipher: s.getCipher()?.name, certCN: cert?.subject?.CN, certSAN: (cert?.subjectaltstring || "").slice(0, 120) });
      s.destroy();
    });
    s.on("error", (e) => resolve({ ok: false, ms: Date.now() - t0, error: String(e.message), code: e.code }));
    s.setTimeout(ms, () => { resolve({ ok: false, ms: Date.now() - t0, error: "timeout" }); s.destroy(); });
  });
}

async function pgAttempt(connectionString, ms = 10000) {
  const t0 = Date.now();
  try {
    const c = new pg.Client({ connectionString, connectionTimeoutMillis: ms });
    await c.connect();
    const r = await c.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
    await c.end();
    return { ok: true, ms: Date.now() - t0, tables: r.rows[0].n };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message), code: e.code, stack: String(e.stack || "").split("\n").slice(0, 4).join(" | ") };
  }
}

function parse(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432), userDb: `${u.username}@${u.pathname}` };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") || "all";
    const dbUrl = env.DATABASE_URL;
    const { host, port } = parse(dbUrl);
    const out = { host, port, mode, results: {} };
    if (mode === "all" || mode === "tcp") out.results.rawTcp = await rawTcp(host, port);
    if (mode === "all" || mode === "dance") out.results.sslDance = await sslDance(host, port);
    if (mode === "all" || mode === "tls") out.results.directTls = await directTls(host, port);
    if (mode === "all" || mode === "pg") out.results.pg = await pgAttempt(dbUrl);
    if (mode === "all" || mode === "pgnotls") out.results.pgNoTls = await pgAttempt(dbUrl.replace(/sslmode=[^&]*/, "sslmode=disable").replace(/uselibpqcompat=[^&]*/, ""));
    if (mode === "all" || mode === "pgverify") out.results.pgVerifyFull = await pgAttempt(dbUrl.replace(/uselibpqcompat=[^&]*/, ""));
    if (mode === "all" || mode === "pgaws0") out.results.pgAws0 = await pgAttempt(dbUrl.replace("aws-1-", "aws-0-"));
    return Response.json(out);
  },
};
