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

if ! bunx prisma migrate deploy; then
  if on_vercel; then
    echo ""
    echo "ERROR: prisma migrate deploy failed — the deployment cannot work without the database schema."
    echo "  Check that the Vercel Postgres store is linked to this project and reachable."
    echo ""
    exit 1
  fi
  echo "db-migrate: prisma migrate deploy failed (is local Postgres running? 'bun run pg:start') — continuing."
  exit 0
fi
