#!/usr/bin/env bash
# REAL-Supabase E2E for the v3.5.1 email-OTP activation (local server, real
# project at vvopggnkskzzwolxbjig.supabase.co). Proves the exact production
# contract with zero mocks:
#   1. server booted with SUPABASE_* env UNSET → repo defaults active
#   2. GET /api/auth → otpEnabled:true
#   3. POST otp-send → real Supabase /auth/v1/otp accepts (200)
#   4. admin generate_link (secret key) → a REAL valid code, no inbox needed
#   5. POST otp-verify through the app → Supabase 200 → DigDeep session
#   6. session persists on GET /api/auth
# Cleans up its probe user from the local DB afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=3211
BASE="http://localhost:$PORT"
REF="vvopggnkskzzwolxbjig"
# Public-by-design (ships in browsers): the publishable key. The SECRET key
# (service-role, used only for admin generate_link) comes from env — NEVER
# commit it (GitHub push protection blocks it, correctly).
PUB="${SUPABASE_PUBLISHABLE_KEY:-sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D}"
SEC="${SUPABASE_SECRET_KEY:?export SUPABASE_SECRET_KEY=sb_secret_… (dashboard → Settings → API Keys) first}"
DB="postgresql://postgres:postgres@localhost:5433/digdeep"
RND=$RANDOM$RANDOM
# example.com: RFC-reserved but DNS-resolvable — bogus TLDs (.local) are
# rejected by the upstream mailer (4xx) which the app maps to a uniform 400.
EMAIL="e2e-real-$RND@example.com"

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

echo "── build standalone (skipped when fresh)"
if [[ ! -f .next/standalone/server.js ]] || [[ -n "$(find src prisma -newer .next/standalone/server.js \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | head -1)" ]]; then
  bun run build >/tmp/e2e-build.log 2>&1 || { tail -20 /tmp/e2e-build.log; fail "build"; }
fi

echo "── boot server on :$PORT with SUPABASE env UNSET (repo defaults)"
STALE=$(lsof -ti :$PORT 2>/dev/null || true); [[ -n "$STALE" ]] && kill $STALE 2>/dev/null || true; sleep 1
DATABASE_URL="$DB" NODE_ENV=production PORT=$PORT CRON_SECRET=e2e-cron \
  env -u SUPABASE_URL -u SUPABASE_ANON_KEY \
  node .next/standalone/server.js >/tmp/e2e-server.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -sf -o /dev/null "$BASE/" && break; sleep 1; done
curl -sf -o /dev/null "$BASE/" || { tail -10 /tmp/e2e-server.log; fail "server never came up"; }
pass "server up"

cleanup() { kill $SRV 2>/dev/null || true; }
trap cleanup EXIT

echo "── 1 · defaults active"
SES=$(curl -s "$BASE/api/auth")
echo "$SES" | grep -q '"otpEnabled":true' && pass "GET /api/auth (env unset) → otpEnabled TRUE (repo defaults)" || fail "otpEnabled: $SES"

echo "── 2 · real send (Supabase built-in mailer)"
# The built-in mailer is capped at 2 sends/hour PROJECT-WIDE (dev-grade) —
# accept the cap's 429 as a sane mapped response; the decisive contract
# proof is the verify round-trip below (generate_link sends no email).
S=$(curl -s -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$EMAIL\"}")
if echo "$S" | grep -q '"ok":true'; then
  pass "otp-send → ok (real Supabase accepted, uniform response)"
elif echo "$S" | grep -q 'Too many codes'; then
  echo "  ⚠ upstream mailer cap (2/hour project-wide) — send path proven mapped, continuing"
else
  fail "otp-send: $S"
fi

echo "── 3 · admin generate_link → real code (no inbox needed)"
G=$(curl -s -m 20 -X POST "https://$REF.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SEC" -H "Authorization: Bearer $SEC" -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}")
CODE=$(echo "$G" | grep -oE '"email_otp":"[0-9]+"' | grep -oE '[0-9]+')
[[ -n "$CODE" ]] && pass "generate_link issued code (${#CODE} digits)" || fail "generate_link: $(echo "$G" | head -c 200)"

echo "── 4 · wrong code first (negative control)"
W=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"000000\"}")
[[ "$W" == "401" ]] && pass "wrong code → 401" || fail "wrong code → $W"

echo "── 5 · verify the REAL code through the app → session"
V=$(curl -s -m 20 -c /tmp/e2e-real.jar -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
echo "$V" | grep -q "\"email\":\"$EMAIL\"" && pass "otp-verify real code → signed in, account created" || fail "verify: $(echo "$V" | head -c 300)"
SES=$(curl -s -b /tmp/e2e-real.jar "$BASE/api/auth")
echo "$SES" | grep -q "\"email\":\"$EMAIL\"" && pass "session persists (GET /api/auth)" || fail "session: $SES"
rm -f /tmp/e2e-real.jar

echo "── cleanup: purge probe user from local DB"
DATABASE_URL="$DB" bun -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
(async () => {
  const u = await p.user.findUnique({ where: { email: process.argv[1] } });
  if (u) await p.session.deleteMany({ where: { userId: u.id } }), await p.user.delete({ where: { id: u.id } });
  console.log("purged");
  await p.$disconnect();
})();' "$EMAIL" >/dev/null

echo "REAL-SUPABASE E2E: ALL PASSED"
