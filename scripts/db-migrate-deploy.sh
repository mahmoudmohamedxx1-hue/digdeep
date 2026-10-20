#!/usr/bin/env bash
# Apply pending Prisma migrations — idempotent. Runs from postinstall AND build
# (double execution is safe: already-applied migrations are a no-op).
#
# URL resolution (first match wins):
#   1. DATABASE_URL            (only if it is a postgres:// URL)
#   2. POSTGRES_URL_NON_POOLING (Vercel Postgres direct URL — the right choice for DDL)
#   3. .env via the Prisma CLI (local dev)
#
# Failure policy:
#   - ON VERCEL: any failure is fatal (a deploy without a reachable database is
#     a broken deploy — fail loudly with instructions instead).
#   - OFF VERCEL: missing URL (fresh clone, pre-.env) skips gracefully so
#     `bun install` never breaks; a connection failure warns but exits 0 so a
#     stopped local Postgres during postinstall does not wedge installs.
set -uo pipefail

# ── stale .env auto-repair (4th occurrence: sandbox resets keep restoring a SQLite
#    file: URL into .env while schema.prisma is postgresql — every prisma CLI call
#    then fails with "the URL must start with the protocol postgresql://").
#    Runs from postinstall AND build, so any install or build heals it.
if [ -f .env ] && [ -f prisma/schema.prisma ] \
   && grep -q 'provider *= *"postgresql"' prisma/schema.prisma \
   && grep -Eq '^DATABASE_URL=("|'"'"')?file:' .env; then
  echo "db-migrate: stale SQLite DATABASE_URL in .env (schema is postgresql) — repairing to local Postgres"
  sed -i '1s|^DATABASE_URL=.*|DATABASE_URL=postgresql://postgres:postgres@localhost:5433/digdeep|' .env
fi

on_vercel() { [ -n "${VERCEL:-}" ] && [ "${VERCEL}" != "0" ]; }

# a non-postgres DATABASE_URL (e.g. a stale file: path exported in the shell)
# must not shadow .env — drop it and let the CLI resolve from .env instead
case "${DATABASE_URL:-}" in
  postgres* ) ;;
  * ) unset DATABASE_URL ;;
esac

if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_URL_NON_POOLING:-}" ]; then
  export DATABASE_URL="$POSTGRES_URL_NON_POOLING"
fi

have_url=0
if [ -n "${DATABASE_URL:-}" ]; then
  have_url=1
elif [ -f .env ] && grep -Eq '^DATABASE_URL="?postgres(ql)?://' .env; then
  # no env-var URL, but .env has one — the Prisma CLI loads it automatically
  have_url=1
fi

if [ "$have_url" != "1" ]; then
  if on_vercel; then
    echo ""
    echo "ERROR: No PostgreSQL connection URL found (looked for DATABASE_URL, POSTGRES_URL_NON_POOLING)."
    echo "  Fix: Vercel project -> Storage -> link your Postgres database (or set"
    echo "  DATABASE_URL in Settings -> Environment Variables), then redeploy."
    echo ""
    exit 1
  fi
  echo "db-migrate: no DATABASE_URL yet — skipping (local dev: bun run pg:start && bun run db:deploy)."
  exit 0
fi

migrate_fail() {
  if on_vercel; then
    echo ""
    echo "ERROR: prisma migrate deploy failed — the deployment cannot work without the database schema."
    echo "  Check that the Vercel Postgres store is linked to this project and reachable."
    echo ""
    exit 1
  fi
  echo "db-migrate: prisma migrate deploy failed (is local Postgres running? 'bun run pg:start') — continuing."
  exit 0
}

DEPLOY_LOG="$(mktemp)"
if bunx prisma migrate deploy 2>&1 | tee "$DEPLOY_LOG"; then
  :
else
  # ── P3009 self-heal ──────────────────────────────────────────────────────
  # A migration that failed mid-deploy leaves a FAILED record in
  # _prisma_migrations, and every subsequent `migrate deploy` refuses to run
  # (P3009) — one bad deploy wedges the whole pipeline. This is exactly the
  # v3.3 incident: the first push's migration failed, and the fixed migration
  # could never ship because the failed record blocked every retry. All
  # migrations in this repo are idempotent and state-tested
  # (scripts/test-migration.sh, incl. State D: this exact wedge), so marking
  # the failed record rolled-back and re-attempting is safe.
  FAILED_MIGRATIONS=$(grep -oE 'The `[^`]+` migration' "$DEPLOY_LOG" | sed -e 's/^The `//' -e 's/` migration$//' | sort -u || true)
  if [ -z "$FAILED_MIGRATIONS" ]; then
    migrate_fail  # not a failed-record wedge (e.g. unreachable DB) — no self-heal
  fi
  echo ""
  echo "db-migrate: P3009 — failed migration record(s) blocking deploy: $FAILED_MIGRATIONS"
  echo "db-migrate: marking rolled-back and re-attempting (migrations are idempotent; see scripts/test-migration.sh)"
  for m in $FAILED_MIGRATIONS; do
    bunx prisma migrate resolve --rolled-back "$m" >/dev/null 2>&1 || true
  done
  echo ""
  if ! bunx prisma migrate deploy; then
    migrate_fail
  fi
  echo "db-migrate: self-heal complete — failed record cleared, migrations applied."
fi
