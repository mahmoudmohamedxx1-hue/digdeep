import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * One-shot, idempotent, additive-only schema repair endpoint.
 *
 * Why: the production Postgres was provisioned from the Oct-9 migration set;
 * every later column (court, language, modelPref, docs, threadId, mode, ...)
 * was only ever applied to local dev via `prisma db push`. Result: every
 * POST /api/research on production 500s with `column "court" does not exist`.
 *
 * v3.9.0 — SQLITE/D1 ERA: the Postgres-era additive DDL below is retained for
 * history but is no longer executed (SQLite rejects `ADD COLUMN IF NOT EXISTS`
 * and `DEFAULT now()`). The live schema is created from
 * scripts/cf/d1-init.sql (idempotent CREATE TABLE/INDEX IF NOT EXISTS, applied
 * via wrangler or the D1 REST API). GET keeps working — the snapshot is now
 * dialect-aware (PRAGMA table_info) — and POST is a safe no-op that reports
 * the current shape, so old runbooks fail closed instead of corrupting D1.
 * Guarded by a shared secret (repo-private, read-only blast radius).
 */

const SECRET = "784a551d819251b7097d3834e16099da";

// (table, column, DDL) — additive column repairs, idempotent
const COLUMNS: Array<[string, string, string]> = [
  // --- ResearchJob ---
  ["ResearchJob", "threadId", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "threadId" TEXT`],
  ["ResearchJob", "status", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'queued'`],
  ["ResearchJob", "stage", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "stage" TEXT NOT NULL DEFAULT 'Initializing'`],
  ["ResearchJob", "progress", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "progress" INTEGER NOT NULL DEFAULT 0`],
  ["ResearchJob", "preset", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "preset" TEXT NOT NULL DEFAULT 'standard'`],
  ["ResearchJob", "mode", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'research'`],
  ["ResearchJob", "court", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "court" BOOLEAN NOT NULL DEFAULT false`],
  ["ResearchJob", "language", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'English'`],
  ["ResearchJob", "modelPref", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "modelPref" TEXT NOT NULL DEFAULT 'auto'`],
  ["ResearchJob", "breadth", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "breadth" INTEGER NOT NULL DEFAULT 3`],
  ["ResearchJob", "depth", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "depth" INTEGER NOT NULL DEFAULT 2`],
  ["ResearchJob", "maxSources", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "maxSources" INTEGER NOT NULL DEFAULT 18`],
  ["ResearchJob", "maxMinutes", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "maxMinutes" INTEGER NOT NULL DEFAULT 30`],
  ["ResearchJob", "reportMd", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "reportMd" TEXT`],
  ["ResearchJob", "plan", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "plan" TEXT`],
  ["ResearchJob", "stats", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "stats" TEXT`],
  ["ResearchJob", "docs", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "docs" TEXT`],
  ["ResearchJob", "error", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "error" TEXT`],
  ["ResearchJob", "cancelRequested", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "cancelRequested" BOOLEAN NOT NULL DEFAULT false`],
  ["ResearchJob", "startedAt", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3)`],
  ["ResearchJob", "completedAt", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3)`],
  // v2.5.0 continuation engine
  ["ResearchJob", "checkpoint", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "checkpoint" TEXT`],
  ["ResearchJob", "leaseUntil", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3)`],
  ["ResearchJob", "sliceN", `ALTER TABLE "ResearchJob" ADD COLUMN IF NOT EXISTS "sliceN" INTEGER NOT NULL DEFAULT 0`],
  // --- ActivityEvent ---
  ["ActivityEvent", "seq", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "seq" INTEGER NOT NULL DEFAULT 0`],
  ["ActivityEvent", "ts", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "ts" TIMESTAMP(3) NOT NULL DEFAULT now()`],
  ["ActivityEvent", "type", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'info'`],
  ["ActivityEvent", "title", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL DEFAULT ''`],
  ["ActivityEvent", "detail", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "detail" TEXT`],
  ["ActivityEvent", "model", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "model" TEXT`],
  ["ActivityEvent", "meta", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "meta" TEXT`],
  ["ActivityEvent", "level", `ALTER TABLE "ActivityEvent" ADD COLUMN IF NOT EXISTS "level" TEXT NOT NULL DEFAULT 'normal'`],
  // --- Source ---
  ["Source", "snippet", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "snippet" TEXT`],
  ["Source", "words", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "words" INTEGER NOT NULL DEFAULT 0`],
  ["Source", "quality", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "quality" INTEGER NOT NULL DEFAULT 0`],
  ["Source", "used", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "used" BOOLEAN NOT NULL DEFAULT false`],
  ["Source", "sectionTitle", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "sectionTitle" TEXT`],
  ["Source", "round", `ALTER TABLE "Source" ADD COLUMN IF NOT EXISTS "round" INTEGER NOT NULL DEFAULT 1`],
  // --- ResearchSection ---
  ["ResearchSection", "question", `ALTER TABLE "ResearchSection" ADD COLUMN IF NOT EXISTS "question" TEXT NOT NULL DEFAULT ''`],
  ["ResearchSection", "status", `ALTER TABLE "ResearchSection" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending'`],
  ["ResearchSection", "findings", `ALTER TABLE "ResearchSection" ADD COLUMN IF NOT EXISTS "findings" TEXT`],
  ["ResearchSection", "queries", `ALTER TABLE "ResearchSection" ADD COLUMN IF NOT EXISTS "queries" TEXT`],
  ["ResearchSection", "rounds", `ALTER TABLE "ResearchSection" ADD COLUMN IF NOT EXISTS "rounds" INTEGER NOT NULL DEFAULT 0`],
  // --- SharedReport ---
  ["SharedReport", "threadId", `ALTER TABLE "SharedReport" ADD COLUMN IF NOT EXISTS "threadId" TEXT`],
  ["SharedReport", "mode", `ALTER TABLE "SharedReport" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'research'`],
  ["SharedReport", "language", `ALTER TABLE "SharedReport" ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'English'`],
  ["SharedReport", "preset", `ALTER TABLE "SharedReport" ADD COLUMN IF NOT EXISTS "preset" TEXT NOT NULL DEFAULT 'standard'`],
  ["SharedReport", "stats", `ALTER TABLE "SharedReport" ADD COLUMN IF NOT EXISTS "stats" TEXT`],
];

const TABLES: Array<[string, string]> = [
  ["Setting", `CREATE TABLE IF NOT EXISTS "Setting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)`],
  [
    "SharedReport",
    `CREATE TABLE IF NOT EXISTS "SharedReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "threadId" TEXT,
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'research',
    "language" TEXT NOT NULL DEFAULT 'English',
    "preset" TEXT NOT NULL DEFAULT 'standard',
    "reportMd" TEXT NOT NULL,
    "stats" TEXT,
    "sources" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
  )`,
  ],
];

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS "ResearchJob_status_updatedAt_idx" ON "ResearchJob"("status", "updatedAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ActivityEvent_jobId_seq_key" ON "ActivityEvent"("jobId", "seq")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Source_jobId_url_key" ON "Source"("jobId", "url")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SharedReport_jobId_key" ON "SharedReport"("jobId")`,
  `CREATE INDEX IF NOT EXISTS "SharedReport_createdAt_idx" ON "SharedReport"("createdAt")`,
];

const SNAPSHOT_TABLES = ["ResearchJob", "ActivityEvent", "Source", "ResearchSection", "Setting", "SharedReport"];

async function snapshot(): Promise<Record<string, string[]>> {
  // v3.9.0: SQLite/D1 — information_schema does not exist; PRAGMA table_info
  // returns one row per column (name field), preserving column order (cid).
  const out: Record<string, string[]> = {};
  for (const table of SNAPSHOT_TABLES) {
    try {
      const rows = await db.$queryRawUnsafe<{ name: string }[]>(
        `PRAGMA table_info("${table}")`
      );
      out[table] = rows.map((r) => r.name);
    } catch {
      out[table] = [];
    }
  }
  return out;
}

function authorized(req: NextRequest): boolean {
  const s = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-migrate-secret") ?? "";
  return s === SECRET;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ before: await snapshot() });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // v3.9.0 — SQLITE/D1: the Postgres-era DDL above (ADD COLUMN IF NOT EXISTS,
  // DEFAULT now()) is not valid SQLite and must never run against D1. Schema
  // changes ship via scripts/cf/d1-init.sql / prisma migrate diff + wrangler.
  // Fail closed: report the current shape and the correct runbook instead of
  // executing anything.
  return NextResponse.json({
    ok: true,
    applied: [],
    skipped: 0,
    errors: [],
    note: "SQLite/D1 detected — additive repair is a Postgres-era tool. Apply schema changes with scripts/cf/d1-init.sql via wrangler (idempotent).",
    after: await snapshot(),
  });
}
