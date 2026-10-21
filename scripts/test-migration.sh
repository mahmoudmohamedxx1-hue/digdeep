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
V34="prisma/migrations/20261021_v34_platform_scopes_webhooks_watches"
V35="prisma/migrations/20261021_v35_email_otp_auth"
STASH="$(mktemp -d)"

# stash/restore ALL post-init migration dirs — base states (A/B/D) must start
# from init+shared only, with v33+v34+v35 applied on top (v3.4 added v34, v3.5
# added v35: its ALTER targets "User" which only exists after v33).
stash_post() { mv "$V33" "$STASH/"; mv "$V34" "$STASH/"; mv "$V35" "$STASH/"; }
restore_post() {
  mv "$STASH/20261020_v33_accounts_workspaces_api_domain" prisma/migrations/
  mv "$STASH/20261021_v34_platform_scopes_webhooks_watches" prisma/migrations/
  mv "$STASH/20261021_v35_email_otp_auth" prisma/migrations/
}

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

for db in mig_a mig_b mig_c mig_d; do
  psql_admin "DROP DATABASE IF EXISTS $db;" >/dev/null
  psql_admin "CREATE DATABASE $db;" >/dev/null
done

# pg_scalar <db> <sql> [param] → prints integer of column "n" (first row)
pg_scalar() {
  node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: "postgresql://postgres:postgres@localhost:5433/" + process.argv[1] });
    (async () => {
      await c.connect();
      const r = await c.query(process.argv[2], process.argv[3] ? [process.argv[3]] : []);
      console.log(r.rows[0].n);
      await c.end();
    })().catch(e => { console.error("ERR:"+e.message); process.exit(1); });' "$1" "$2" "${3:-}"
}

echo "── State A: prod-like (init+shared applied, schema evolved by db push) ──"
stash_post
DATABASE_URL="$BASE_URL/mig_a" npx prisma migrate deploy >/dev/null 2>&1 && pass "init + shared_reports applied" || fail "base migrations failed on mig_a"
DATABASE_URL="$BASE_URL/mig_a" npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 && pass "db push evolution (prod simulation)" || fail "db push failed on mig_a"
restore_post
DATABASE_URL="$BASE_URL/mig_a" npx prisma migrate deploy >/dev/null 2>&1 && pass "v3.3+v3.4 migrations applied over evolved schema (idempotent)" || fail "post-init migrations FAILED on evolved schema — this is the deploy killer"

echo "── State B: clean history (init+shared only, v3.3+v3.4 add everything) ──"
stash_post
DATABASE_URL="$BASE_URL/mig_b" npx prisma migrate deploy >/dev/null 2>&1 && pass "init + shared_reports applied" || fail "base migrations failed on mig_b"
restore_post
DATABASE_URL="$BASE_URL/mig_b" npx prisma migrate deploy >/dev/null 2>&1 && pass "v3.3+v3.4 applied on clean history" || fail "post-init migrations FAILED on clean history"

echo "── State C: empty database (full history from zero) ──"
DATABASE_URL="$BASE_URL/mig_c" npx prisma migrate deploy >/dev/null 2>&1 && pass "full history applied from zero" || fail "full deploy FAILED from zero"

echo "── State D: P3009 wedge (the actual v3.3 production incident) ──"
# Recreate exactly what production went through:
#   1. evolved schema (init+shared, then db push) — the substrate
#   2. the ORIGINAL broken v33 migration (from git history, commit 56b8a33)
#      fails mid-deploy → leaves a FAILED record in _prisma_migrations
#   3. every naive `migrate deploy` is now P3009-blocked (deploy outage)
#   4. the PATCHED db-migrate-deploy.sh must clear the wedge and finish green
stash_post
DATABASE_URL="$BASE_URL/mig_d" npx prisma migrate deploy >/dev/null 2>&1 && pass "init + shared_reports applied (mig_d)" || fail "base migrations failed on mig_d"
DATABASE_URL="$BASE_URL/mig_d" npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 && pass "db push evolution (wedge substrate)" || fail "db push failed on mig_d"
mkdir -p "$V33"
git show 56b8a33:prisma/migrations/20261020_v33_accounts_workspaces_api_domain/migration.sql > "$V33/migration.sql"
if DATABASE_URL="$BASE_URL/mig_d" npx prisma migrate deploy >/dev/null 2>&1; then
  fail "broken migration unexpectedly SUCCEEDED — State D repro is invalid"
else
  pass "broken migration failed mid-deploy (as it did in production)"
fi
WEDGE=$(pg_scalar mig_d "SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
[[ "$WEDGE" == "1" ]] && pass "failed migration record wedges _prisma_migrations" || fail "expected 1 failed record, found $WEDGE — repro diverges from prod"
if DATABASE_URL="$BASE_URL/mig_d" npx prisma migrate deploy >/dev/null 2>&1; then
  fail "naive re-deploy unexpectedly passed — wedge not reproduced"
else
  pass "naive re-deploy blocked by P3009 (the deploy outage, reproduced)"
fi
rm -rf "$V33"
restore_post
HEAL_LOG=/tmp/mig-d-heal.log
if DATABASE_URL="$BASE_URL/mig_d" bash scripts/db-migrate-deploy.sh > "$HEAL_LOG" 2>&1; then :; fi  # exit code is lenient off-Vercel; assert on state below
grep -q "self-heal complete" "$HEAL_LOG" && pass "db-migrate-deploy.sh self-healed the wedge (v3.3+v3.4 applied)" || { fail "self-heal did not trigger"; sed -n '1,25p' "$HEAL_LOG"; }
V33DONE=$(pg_scalar mig_d "SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = \$1 AND finished_at IS NOT NULL" 20261020_v33_accounts_workspaces_api_domain)
[[ "$V33DONE" == "1" ]] && pass "v3.3 migration now recorded as cleanly applied" || fail "v3.3 migration not applied after self-heal ($V33DONE)"
V34DONE=$(pg_scalar mig_d "SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = \$1 AND finished_at IS NOT NULL" 20261021_v34_platform_scopes_webhooks_watches)
[[ "$V34DONE" == "1" ]] && pass "v3.4 migration recorded as cleanly applied" || fail "v3.4 migration not applied after self-heal ($V34DONE)"
V35DONE=$(pg_scalar mig_d "SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name = \$1 AND finished_at IS NOT NULL" 20261021_v35_email_otp_auth)
[[ "$V35DONE" == "1" ]] && pass "v3.5 migration recorded as cleanly applied (heal applied it too)" || fail "v3.5 migration not applied after self-heal ($V35DONE)"
LEFT=$(pg_scalar mig_d "SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL")
[[ "$LEFT" == "0" ]] && pass "no failed records remain" || fail "$LEFT failed record(s) remain after self-heal"

echo "── Drift check: migrations must reproduce schema.prisma exactly ──"
# v3.5 purpose check on the from-zero DB: OTP accounts need a nullable password
NULLABLE=$(pg_scalar mig_c "SELECT (is_nullable = 'YES')::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'passwordHash'")
[[ "$NULLABLE" == "1" ]] && pass "User.passwordHash is nullable after full history (OTP-only accounts possible)" || fail "passwordHash still NOT NULL after migrations"
for db in mig_a mig_b mig_c mig_d; do
  DIFF=$(npx prisma migrate diff --from-url "$BASE_URL/$db" --to-schema-datamodel prisma/schema.prisma 2>/dev/null | grep -cE '^\s*[-+~]' || true)
  [[ "$DIFF" == "0" ]] && pass "$db matches schema.prisma (no drift)" || fail "$db DRIFTS from schema.prisma ($(npx prisma migrate diff --from-url "$BASE_URL/$db" --to-schema-datamodel prisma/schema.prisma 2>/dev/null | grep -E '^\s*[-+~]' | head -3))"
done

for db in mig_a mig_b mig_c mig_d; do
  psql_admin "DROP DATABASE IF EXISTS $db;" >/dev/null
done

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "  MIGRATION STATE TEST: ALL CHECKS PASSED"
else
  echo "  MIGRATION STATE TEST: FAILURES — DO NOT PUSH"
  exit 1
fi
