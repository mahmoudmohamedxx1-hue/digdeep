#!/usr/bin/env bash
# v3.11 — wrapper for the grounded-chat proof (scripts/cf/test-chat-web.ts).
# Creates a THROWAWAY SQLite DB (never touches db/custom.db), pushes the schema,
# runs the proof with CF_PROFILE=1 + a 20s slice clock, then deletes the DB.
# NOTE the absolute path: prisma resolves file: URLs against the schema dir while
# the runtime adapter resolves against the CWD — an absolute path is unambiguous.
set -euo pipefail
cd "$(dirname "$0")/../.."

TEST_DB="/home/z/my-project/db/test-chatweb.db"
mkdir -p db
rm -f "$TEST_DB"

echo "── schema push to throwaway DB ($TEST_DB)"
DATABASE_URL="file:$TEST_DB" npx prisma db push --skip-generate >/tmp/chatweb-push.log 2>&1 || {
  tail -15 /tmp/chatweb-push.log
  echo "FAIL: prisma db push"; exit 1
}

echo "── run the proof (CF_PROFILE=1, DIGDEEP_SLICE_MS=20000)"
CF_PROFILE=1 DIGDEEP_SLICE_MS=20000 DATABASE_URL="file:$TEST_DB" \
  npx tsx scripts/cf/test-chat-web.ts
RC=$?

rm -f "$TEST_DB"
exit $RC
