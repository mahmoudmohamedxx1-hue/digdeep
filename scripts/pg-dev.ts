/**
 * Local PostgreSQL for development — mirrors the Vercel Postgres production
 * setup (same provider, same schema).
 *
 * Self-contained embedded binaries (no root / apt needed):
 *   - Data dir:  db/pgdata     (persistent across restarts)
 *   - Port:      5433
 *   - Database:  digdeep
 *   - URL:       postgresql://postgres:postgres@localhost:5433/digdeep
 *
 * Postgres is started via `pg_ctl` so it daemonizes and SURVIVES this script
 * exiting (unlike a foreground child process, which dies with the shell).
 *
 * Usage:  bun scripts/pg-dev.ts        (idempotent; safe to re-run)
 *         bun scripts/pg-dev.ts stop   (clean shutdown)
 */
import { mkdirSync, existsSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const NATIVE = join(ROOT, "node_modules", "@embedded-postgres", "linux-x64", "native");
const DATA_DIR = join(ROOT, "db", "pgdata");
const SERVER_LOG = join(ROOT, "db", "pg-server.log");
const PORT = 5433;
const DB_NAME = "digdeep";
const USER = "postgres";
const PASSWORD = "postgres";
const URL = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;

// ── loader path + versioned symlinks the binaries need ────────────────────
process.env.LD_LIBRARY_PATH = `${join(NATIVE, "lib")}:${process.env.LD_LIBRARY_PATH ?? ""}`;
for (const [link, target] of [
  ["libicudata.so.60", "libicudata.so.60.2"],
  ["libicui18n.so.60", "libicui18n.so.60.2"],
  ["libicuuc.so.60", "libicuuc.so.60.2"],
] as const) {
  try { rmSync(join(NATIVE, "lib", link), { force: true }); } catch { /* noop */ }
  try {
    const { symlinkSync } = await import("node:fs");
    symlinkSync(target, join(NATIVE, "lib", link));
  } catch { /* exists */ }
}

const BIN = join(NATIVE, "bin");
const env = { ...process.env };
mkdirSync(join(ROOT, "db"), { recursive: true });

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function isListening(): Promise<boolean> {
  try {
    await Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: { data() {}, open(s) { s.end(); }, close() {}, error() {} },
      tls: false,
    });
    return true;
  } catch {
    return false;
  }
}

// ── stop mode ─────────────────────────────────────────────────────────────
if (process.argv[2] === "stop") {
  if (!existsSync(DATA_DIR)) { console.log("[pg-dev] No data dir — nothing to stop."); process.exit(0); }
  try {
    run(join(BIN, "pg_ctl"), ["-D", DATA_DIR, "-m", "fast", "stop"]);
    console.log("[pg-dev] Postgres stopped.");
  } catch (e) {
    console.warn(`[pg-dev] stop: ${e instanceof Error ? e.message : e}`);
  }
  process.exit(0);
}

// ── already running? ──────────────────────────────────────────────────────
if (await isListening()) {
  console.log(`[pg-dev] Postgres already listening on :${PORT} — nothing to do.`);
  console.log(`[pg-dev] ${URL}`);
  process.exit(0);
}

// ── first run: initialise the cluster ─────────────────────────────────────
if (!existsSync(join(DATA_DIR, "PG_VERSION"))) {
  console.log("[pg-dev] First run — initialising cluster…");
  const pwfile = join(ROOT, "db", ".pgpw");
  writeFileSync(pwfile, PASSWORD);
  try {
    run(join(BIN, "initdb"), ["-D", DATA_DIR, "-U", USER, `--pwfile=${pwfile}`, "-A", "password", "-E", "UTF8"]);
  } finally {
    unlinkSync(pwfile);
  }
}

// ── start (daemonizes; survives this process and the shell) ───────────────
console.log(`[pg-dev] Starting Postgres on :${PORT}…`);
run(join(BIN, "pg_ctl"), ["-D", DATA_DIR, "-o", `-p ${PORT}`, "-l", SERVER_LOG, "-w", "start"]);

// ── ensure the database exists (via node-postgres) ────────────────────────
const { Client } = await import("pg");
const admin = new Client({ connectionString: `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/postgres` });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  console.log(`[pg-dev] Database "${DB_NAME}" created.`);
} else {
  console.log(`[pg-dev] Database "${DB_NAME}" already exists.`);
}
await admin.end();

console.log(`[pg-dev] Ready. DATABASE_URL=${URL}`);
console.log("[pg-dev] Postgres runs as a daemon — it stays up after this script exits.");
