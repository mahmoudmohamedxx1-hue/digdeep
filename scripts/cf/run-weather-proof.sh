#!/usr/bin/env bash
# v3.11 — wrapper for the targeted weather-in-Cairo chat proof (scripts/cf/weather-proof.ts).
# Same throwaway-DB discipline as run-chat-web-test.sh: never touches db/custom.db.
set -euo pipefail
cd "$(dirname "$0")/../.."

TEST_DB="/home/z/my-project/db/test-weather.db"
mkdir -p db
rm -f "$TEST_DB"

echo "── schema push to throwaway DB ($TEST_DB)"
DATABASE_URL="file:$TEST_DB" npx prisma db push --skip-generate >/tmp/weather-push.log 2>&1 || {
  tail -15 /tmp/weather-push.log
  echo "FAIL: prisma db push"; exit 1
}

echo "── run the weather proof (CF_PROFILE=1, DIGDEEP_SLICE_MS=20000)"
CF_PROFILE=1 DIGDEEP_SLICE_MS=20000 DATABASE_URL="file:$TEST_DB" \
  npx tsx scripts/cf/weather-proof.ts
RC=$?

rm -f "$TEST_DB"
exit $RC
