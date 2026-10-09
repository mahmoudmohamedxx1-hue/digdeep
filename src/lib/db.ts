import { PrismaClient } from "@prisma/client";

/**
 * Resolve the PostgreSQL connection URL.
 *
 * Precedence (first valid postgres:// URL wins):
 *   1. DATABASE_URL                       — explicit override (local dev, CI)
 *   2. POSTGRES_PRISMA_URL                — Vercel Postgres pooled URL (pgbouncer, best for serverless)
 *   3. POSTGRES_URL                       — Vercel Postgres direct URL
 *   4. POSTGRES_URL_NON_POOLING           — Vercel Postgres non-pooled fallback
 *   5. Local embedded Postgres default    — `bun scripts/pg-dev.ts` dev setup
 *
 * Invalid values (e.g. a stale `file:` SQLite URL left in the process
 * environment) are skipped instead of crashing the app.
 */
const LOCAL_DEFAULT = "postgresql://postgres:postgres@localhost:5433/digdeep";

function resolveDatabaseUrl(): string {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_URL_NON_POOLING,
  ];
  for (const c of candidates) {
    if (c && /^postgres(ql)?:\/\//.test(c.trim())) return c.trim();
  }
  return LOCAL_DEFAULT;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // never resolve to a SQLite URL now that the schema is postgresql
    datasourceUrl: resolveDatabaseUrl(),
    // query logging is noisy + slow in production/serverless — dev only
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  })

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db

// pg migration nudge
