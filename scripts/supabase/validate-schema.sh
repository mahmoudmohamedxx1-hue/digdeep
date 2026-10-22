#!/usr/bin/env bash
# Validate scripts/supabase/schema.sql end-to-end against a THROWAWAY local
# Postgres database: first paste must apply cleanly, second paste must be a
# complete no-op (idempotency), and the end state must match the Prisma
# schema (table count + RLS on every table + migration records seeded).
set -euo pipefail
cd "$(dirname "$0")/../.."

PG="postgresql://postgres:postgres@localhost:5433"
TESTDB="digdeep_schema_test"
ROOT_URL="$PG/postgres"
TEST_URL="$PG/$TESTDB"

echo "── dropping any previous scratch db"
bunx prisma db execute --url "$ROOT_URL" --stdin <<< "DROP DATABASE IF EXISTS \"$TESTDB\";" >/dev/null
bunx prisma db execute --url "$ROOT_URL" --stdin <<< "CREATE DATABASE \"$TESTDB\";" >/dev/null
# Supabase platform roles (present in every real project, absent in vanilla
# PG) — the schema's REVOKE hardening targets them. Cluster-level: guard the
# re-run (roles survive the scratch DB's drop).
bunx prisma db execute --url "$TEST_URL" --stdin <<< "DO \$\$ BEGIN CREATE ROLE \"anon\" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$; DO \$\$ BEGIN CREATE ROLE \"authenticated\" NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;" >/dev/null

echo "── paste #1 (fresh database — the user's first Run)"
bunx prisma db execute --url "$TEST_URL" --stdin < scripts/supabase/schema.sql
echo "   OK"

echo "── paste #2 (idempotency — re-Run must be a no-op)"
bunx prisma db execute --url "$TEST_URL" --stdin < scripts/supabase/schema.sql
echo "   OK"

echo "── end-state verification"
# prisma db execute doesn't PRINT query results — use PrismaClient raw SQL.
q() { DATABASE_URL="$TEST_URL" bun -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const rows = await p.$queryRawUnsafe(process.argv[1]);
  console.log(JSON.stringify(rows));
  await p.$disconnect();
})().catch((e) => { console.error(String(e)); process.exit(1); });' "$1"; }
TABLES=$(q "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema='public';" | grep -oE '[0-9]+' | head -1)
RLS_ON=$(q "SELECT count(*)::int AS c FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity=true;" | grep -oE '[0-9]+' | head -1)
RLS_TOTAL=$(q "SELECT count(*)::int AS c FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';" | grep -oE '[0-9]+' | head -1)
MIGR=$(q "SELECT count(*)::int AS c FROM \"_prisma_migrations\";" | grep -oE '[0-9]+' | head -1)
MIGR_OK=$(q "SELECT count(*)::int AS c FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND applied_steps_count=1;" | grep -oE '[0-9]+' | head -1)
echo "   tables=$TABLES (want 15) · RLS on $RLS_ON/$RLS_TOTAL tables · migrations=$MIGR seeded ok=$MIGR_OK (want 5/5)"

[[ "$TABLES" == "15" ]] || { echo "FAIL: table count"; exit 1; }
[[ "$RLS_ON" == "$RLS_TOTAL" && "$RLS_ON" == "15" ]] || { echo "FAIL: RLS coverage"; exit 1; }
[[ "$MIGR" == "5" && "$MIGR_OK" == "5" ]] || { echo "FAIL: migration seeds"; exit 1; }

echo "── checksums identical to prisma/migrations?"
for mdir in prisma/migrations/*/; do
  mname=$(basename "$mdir")
  want=$(sha256sum "$mdir/migration.sql" | cut -d' ' -f1)
  got=$(q "SELECT checksum FROM \"_prisma_migrations\" WHERE migration_name='$mname';" | grep -oE '[0-9a-f]{64}' | head -1)
  [[ "$want" == "$got" ]] && echo "   $mname ✓" || { echo "   $mname MISMATCH (want $want got $got)"; exit 1; }
done

echo "── prisma migrate deploy against the bootstrapped db (must no-op)"
DEPLOY_OUT=$(DATABASE_URL="$TEST_URL" bunx prisma migrate deploy 2>&1 | tail -3)
echo "$DEPLOY_OUT" | sed 's/^/   /'
echo "$DEPLOY_OUT" | grep -qE "No pending migrations|already in sync" || { echo "FAIL: deploy not a no-op"; exit 1; }

echo "── cleanup"
bunx prisma db execute --url "$ROOT_URL" --stdin <<< "DROP DATABASE IF EXISTS \"$TESTDB\";" >/dev/null
echo "ALL CHECKS PASSED — schema.sql is paste-safe and deploy-compatible"
