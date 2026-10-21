#!/usr/bin/env bash
# Task 40: prod fingerprint + real-code verify through prod (no email budget).
# The publishable key is public-by-design (repo default). The SECRET key
# (service-role, admin generate_link) must come from env — NEVER committed
# (GitHub push protection blocks it, correctly).
set -u
BASE="https://digdeepx.vercel.app"
PROJ="https://vvopggnkskzzwolxbjig.supabase.co"
PUB="${SUPABASE_PUBLISHABLE_KEY:-sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D}"
SEC="${SUPABASE_SECRET_KEY:?export SUPABASE_SECRET_KEY=sb_secret_… (dashboard → Settings → API Keys) first}"
EMAIL="audit-fp-$RANDOM$RANDOM@digdeep-test.local"

echo "== A · validation fingerprints (no upstream cost) =="
R9=$(curl -sS -m 15 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"x@y.local\",\"code\":\"123456789\"}" -w "|%{http_code}")
echo "9-digit: $R9"
R5=$(curl -sS -m 15 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"x@y.local\",\"code\":\"12345\"}" -w "|%{http_code}")
echo "5-digit: $R5"
RB=$(curl -sS -m 15 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"notanemail\"}" -w "|%{http_code}")
echo "bad-email send: $RB"

echo; echo "== B · generate_link (admin, no email) → real code for $EMAIL =="
G=$(curl -sS -m 20 -X POST "$PROJ/auth/v1/admin/generate_link" \
  -H "apikey: $SEC" -H "Authorization: Bearer $SEC" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}")
CODE=$(echo "$G" | grep -oE '"email_otp":"[0-9]+"' | grep -oE '[0-9]+')
if [ -z "$CODE" ]; then
  echo "RAW generate_link response:"; echo "$G" | head -c 500; echo
fi
echo "code: ${CODE:0:2}****(${#CODE} digits)"

echo; echo "== C · otp-verify REAL code through PROD =="
V=$(curl -sS -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" -w "|%{http_code}")
echo "$V" | head -c 400; echo

echo; echo "== D · otp-verify REAL code through LOCAL (control) =="
# local control proves the code+key are good when the app uses repo defaults
cd /home/z/my-project
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/digdeep"
export PORT=3211
node .next/standalone/server.js > /tmp/local-fp.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sS -m 2 -o /dev/null http://127.0.0.1:3211/api/auth 2>/dev/null && break; sleep 0.5; done
V2=$(curl -sS -m 20 -X POST http://127.0.0.1:3211/api/auth -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" -w "|%{http_code}")
echo "$V2" | head -c 400; echo
