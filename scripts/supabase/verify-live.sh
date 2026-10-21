#!/usr/bin/env bash
# v3.5.1 LIVE verification on digdeepx.vercel.app: the email-OTP feature is
# active with repo defaults. Proves the whole chain on the real Vercel
# runtime + the real Supabase project. The verify round-trip uses admin
# generate_link (no inbox, no email budget).
set -euo pipefail

BASE="https://digdeepx.vercel.app"
REF="vvopggnkskzzwolxbjig"
PUB="sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D"
SEC="${SUPABASE_SECRET_KEY:?export SUPABASE_SECRET_KEY=sb_secret_… first}"
RND=$RANDOM$RANDOM
EMAIL="prod-otp-$RND@digdeep-test.local"

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; echo "LIVE VERIFY FAILED"; exit 1; }

echo "── 1 · core surfaces + otpEnabled"
for p in "/" "/api/stats" "/api-docs" "/account"; do
  C=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE$p")
  [[ "$C" == "200" ]] && pass "$p → 200" || fail "$p → $C"
done
SES=$(curl -s -m 20 "$BASE/api/auth")
echo "$SES" | grep -q '"otpEnabled":true' && pass "GET /api/auth → otpEnabled TRUE (feature live)" || fail "otpEnabled: $SES"

echo "── 2 · otp-send through the app (uniform, non-enumerating)"
S=$(curl -s -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$EMAIL\"}")
if echo "$S" | grep -q '"ok":true'; then
  pass "otp-send → ok (real send accepted)"
elif echo "$S" | grep -q 'Too many codes'; then
  echo "  ⚠ upstream mailer cap (2/hour project-wide) — mapped 429, continuing"
else
  fail "otp-send: $S"
fi
S2=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$EMAIL\"}")
[[ "$S2" == "429" || "$S2" == "200" ]] && pass "resend → $S2 (cooldown path mapped)" || fail "resend → $S2"

echo "── 3 · validation + wrong code"
C=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"otp-verify","email":"x@y.co","code":"12345"}')
[[ "$C" == "400" ]] && pass "5-digit code → 400" || fail "5-digit → $C"
C=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"00000000\"}")
[[ "$C" == "401" ]] && pass "wrong 8-digit code → 401 (upstream rejected, mapped)" || fail "wrong code → $C"

echo "── 4 · FULL round-trip: generate_link → app verify → session"
G=$(curl -s -m 20 -X POST "https://$REF.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SEC" -H "Authorization: Bearer $SEC" -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}")
CODE=$(echo "$G" | grep -oE '"email_otp":"[0-9]+"' | grep -oE '[0-9]+')
[[ -n "$CODE" ]] && pass "real ${#CODE}-digit code issued (admin, no email sent)" || fail "generate_link: $(echo "$G" | head -c 200)"
V=$(curl -s -m 30 -c /tmp/prod-otp.jar -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"$CODE\"}")
echo "$V" | grep -q "\"email\":\"$EMAIL\"" && pass "otp-verify on PROD → signed in, account created" || fail "verify: $(echo "$V" | head -c 300)"
SES=$(curl -s -m 20 -b /tmp/prod-otp.jar "$BASE/api/auth")
echo "$SES" | grep -q "\"email\":\"$EMAIL\"" && pass "session persists on prod (GET /api/auth)" || fail "session: $SES"
rm -f /tmp/prod-otp.jar

echo "── 5 · password register still works alongside (no regression)"
P=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"prod-pw-$RND@digdeep-test.local\",\"password\":\"prod-pw-check-123\"}")
[[ "$P" == "200" ]] && pass "password register → 200 (both auth modes live)" || fail "register → $P"

echo ""
echo "LIVE VERIFICATION: ALL PASSED — email-code sign-in is LIVE on $BASE"
echo "(probe accounts prod-otp-$RND / prod-pw-$RND @digdeep-test.local remain as inert residue)"
