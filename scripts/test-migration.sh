#!/usr/bin/env bash
# =====================================================================
# MIGRATION STATE TEST — apply the migration folder against every
# plausible database state and assert zero drift.
#
# The v3.3 lesson: migration.sql had never been EXECUTED (local dev used
# `prisma db push`, which bypasses migration files) and it re-added columns
# production already had → `prisma migrate deploy` failed inside the Vercel
# build → the push deployed nothing. This script runs each migration file
# against scratch databases in the three states production can be in.
#
# Usage: bash scripts/test-migration.sh
# Needs: local Postgres on :5433 (bun scripts/pg-dev.ts), psql in PATH.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGUSER=postgres
PGPASSWORD=postgres
PGHOST=localhost
PGPORT=5433
export PGUSER PGPASSWORD PGHOST PGPORT
BASE_URL="postgresql://postgres:postgres@localhost:5433"
V33="prisma/migrations/20261020_v33_accounts_workspaces_api_domain"
STASH="$(mktemp -d)"

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED=1; }
FAILED=0

# psql is not shipped with the embedded postgres — drive CREATE/DROP DATABASE
# through node-postgres (already a dependency).
psql_admin() {
  node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: "postgresql://postgres:postgres@localhost:5433/postgres" });
    (async () => {
      await c.connect();
      await c.query(process.argv[1]);
      await c.end();
    })().catch(e => { console.error(e.message); process.exit(1); });' "$1"
}

for db in mig_a mig_b mig_c; do
  psql_admin "DROP DATABASE IF EXISTS $db;" >/dev/null
  psql_admin "CREATE DATABASE $db;" >/dev/null
done

echo "── State A: prod-like (init+shared applied, schema evolved by db push) ──"
mv "$V33" "$STASH/"
DATABASE_URL="$BASE_URL/mig_a" npx prisma migrate deploy >/dev/null 2>&1 && pass "init + shared_reports applied" || fail "base migrations failed on mig_a"
DATABASE_URL="$BASE_URL/mig_a" npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 && pass "db push evolution (prod simulation)" || fail "db push failed on mig_a"
mv "$STASH/20261020_v33_accounts_workspaces_api_domain" prisma/migrations/
DATABASE_URL="$BASE_URL/mig_a" npx prisma migrate deploy >/dev/null 2>&1 && pass "v3.3 migration applied over evolved schema (idempotent)" || fail "v3.3 migration FAILED on evolved schema — this is the deploy killer"

echo "── State B: clean history (init+shared only, v3.3 adds everything) ──"
mv "$V33" "$STASH/"
DATABASE_URL="$BASE_URL/mig_b" npx prisma migrate deploy >/dev/null 2>&1 && pass "init + shared_reports applied" || fail "base migrations failed on mig_b"
mv "$STASH/20261020_v33_accounts_workspaces_api_domain" prisma/migrations/
DATABASE_URL="$BASE_URL/mig_b" npx prisma migrate deploy >/dev/null 2>&1 && pass "v3.3 migration applied on clean history" || fail "v3.3 migration FAILED on clean history"

echo "── State C: empty database (full history from zero) ──"
DATABASE_URL="$BASE_URL/mig_c" npx prisma migrate deploy >/dev/null 2>&1 && pass "full history applied from zero" || fail "full deploy FAILED from zero"

echo "── Drift check: migrations must reproduce schema.prisma exactly ──"
for db in mig_a mig_b mig_c; do
  DIFF=$(npx prisma migrate diff --from-url "$BASE_URL/$db" --to-schema-datamodel prisma/schema.prisma 2>/dev/null | grep -cE '^\s*[-+~]' || true)
  [[ "$DIFF" == "0" ]] && pass "$db matches schema.prisma (no drift)" || fail "$db DRIFTS from schema.prisma ($(npx prisma migrate diff --from-url "$BASE_URL/$db" --to-schema-datamodel prisma/schema.prisma 2>/dev/null | grep -E '^\s*[-+~]' | head -3))"
done

for db in mig_a mig_b mig_c; do
  psql_admin "DROP DATABASE IF EXISTS $db;" >/dev/null
done

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "  MIGRATION STATE TEST: ALL CHECKS PASSED"
else
  echo "  MIGRATION STATE TEST: FAILURES — DO NOT PUSH"
  exit 1
fi
