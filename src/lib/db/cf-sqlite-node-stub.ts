/**
 * CF_PROFILE webpack stub (wired in next.config.ts): `better-sqlite3` and
 * `@prisma/adapter-better-sqlite3` are Node-only (native .node binary) and
 * must never enter the workerd bundle. On Workers, src/lib/db.ts routes to
 * the D1 adapter via isWorkersRuntime(), so the Node branch that require()s
 * these packages is dead code at runtime — this module only exists so that
 * dead branch still resolves at build time.
 *
 * Touching this at runtime is a bug: fail loudly, with the fix spelled out.
 *
 * LOST-AND-FOUND note: this file was originally created in the v3.9.0 D1
 * session but was never committed — the unanchored `db/` gitignore pattern
 * swallowed `src/lib/db/` whole, and a sandbox reset then destroyed the
 * untracked file, breaking every CF_PROFILE build. Reconstructed in
 * v3.11.1; the pattern is now anchored to `/db/`.
 */

const CF_SQLITE_STUB_ERROR =
  "better-sqlite3 is Node-only and cannot run on Cloudflare Workers. " +
  "src/lib/db.ts should have taken the isWorkersRuntime() → PrismaD1(env.DB) " +
  "branch instead. If you are seeing this error, the D1 binding or the " +
  "worker-runtime detection is broken — see wrangler.jsonc (d1_databases) " +
  "and src/lib/db.ts.";

/** Shape-compatible stand-in for @prisma/adapter-better-sqlite3's export. */
export class PrismaBetterSQLite3 {
  constructor() {
    throw new Error(CF_SQLITE_STUB_ERROR);
  }
}

/** Shape-compatible stand-in for better-sqlite3's default export. */
export class Database {
  constructor() {
    throw new Error(CF_SQLITE_STUB_ERROR);
  }
}

export default Database;
