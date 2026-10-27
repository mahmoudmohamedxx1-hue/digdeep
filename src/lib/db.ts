import { PrismaClient } from "@prisma/client";
import type { SqlMigrationAwareDriverAdapterFactory } from "@prisma/driver-adapter-utils";

/**
 * v3.9.0 — SQLITE EVERYWHERE, PLATFORM-ADAPTIVE ADAPTER.
 *
 * One generated client (sqlite dialect, queryCompiler WASM — no native engine
 * binary), two runtime adapters:
 *
 *   * Cloudflare Workers (prod, OpenNext): the D1 binding `DB` from
 *     wrangler.jsonc, reached via getCloudflareContext() from
 *     @opennextjs/cloudflare. D1 enforces FK constraints (onDelete: Cascade)
 *     by default.
 *   * Node (local dev / tests / scripts): better-sqlite3 over a local file
 *     (DATABASE_URL=file:… or db/dev.db), with PRAGMA foreign_keys = ON so
 *     cascade deletes behave exactly like D1.
 *
 * WHY A LAZY PROXY: on workerd the whole Next server bundle is evaluated at
 * cold start, BEFORE any request context exists. getCloudflareContext() can
 * only resolve the D1 binding during request handling. So the PrismaClient is
 * constructed on FIRST USE (always inside a request handler or an after()
 * continuation — Next keeps request async storage alive in after()), and the
 * resolved binding/client are cached globally: the engine's continuation
 * slices reuse the same client long after the originating response finished.
 *
 * Postgres URLs are no longer supported (v3.8 PrismaPg path retired). A stale
 * postgres:// DATABASE_URL fails loudly on first use with migration guidance
 * instead of silently constructing a broken client.
 */

const DEFAULT_LOCAL_DB = "db/dev.db";

function resolveSqlitePath(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return DEFAULT_LOCAL_DB;
  if (raw.startsWith("file:")) {
    return raw.slice("file:".length) || DEFAULT_LOCAL_DB;
  }
  if (/^postgres(ql)?:\/\//.test(raw)) {
    throw new Error(
      "DigDeep v3.9.0+ runs on SQLite (D1 on Cloudflare, better-sqlite3 locally). " +
        "A postgres:// DATABASE_URL is no longer supported — see prisma/schema.prisma. " +
        "Locally, use DATABASE_URL=file:./db/dev.db (or unset it for the default)."
    );
  }
  // bare filesystem path
  return raw;
}

const isWorkersRuntime = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** Wrap the better-sqlite3 factory so every connection enables FK enforcement. */
function withForeignKeys(factory: SqlMigrationAwareDriverAdapterFactory): SqlMigrationAwareDriverAdapterFactory {
  return {
    adapterName: factory.adapterName,
    provider: "sqlite",
    connect: async () => {
      const adapter = await factory.connect();
      try {
        await adapter.executeScript("PRAGMA foreign_keys = ON");
      } catch {
        // non-fatal: local dev only — D1 (prod) enforces FKs by default
      }
      return adapter;
    },
    connectToShadowDb: () => factory.connectToShadowDb(),
  };
}

function createClient(): PrismaClient {
  if (isWorkersRuntime()) {
    // Workerd: reach the D1 binding through the OpenNext request context.
    // Must run inside request handling (lazy proxy guarantees that).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require("@opennextjs/cloudflare") as typeof import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext();
    const d1 = (env as { DB?: unknown }).DB;
    if (!d1) {
      throw new Error(
        "D1 binding `DB` not found on the worker. wrangler.jsonc must declare " +
          'd1_databases: [{ binding: "DB", database_name: "digdeep-db", ... }] — ' +
          "see scripts/cf/README or the v3.9.0 worklog entry."
      );
    }
    // PrismaD1 expects the D1Database binding (facade over prepare/bind/all/run)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaD1 } = require("@prisma/adapter-d1") as typeof import("@prisma/adapter-d1");
    return new PrismaClient({
      adapter: new PrismaD1(d1 as never),
      log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
    });
  }

  // Node: better-sqlite3 over a local file, FK enforcement on.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaBetterSQLite3 } = require("@prisma/adapter-better-sqlite3") as typeof import("@prisma/adapter-better-sqlite3");
  const path = resolveSqlitePath();
  const factory = new PrismaBetterSQLite3({ url: path });
  return new PrismaClient({
    adapter: withForeignKeys(factory as unknown as SqlMigrationAwareDriverAdapterFactory),
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
  return globalForPrisma.prisma;
}

/**
 * `db` is a lazy proxy — the real PrismaClient (and, on Workers, the D1
 * binding lookup) materializes on first property access, which always happens
 * inside request/after() code, never at module evaluation.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
}) as PrismaClient;
