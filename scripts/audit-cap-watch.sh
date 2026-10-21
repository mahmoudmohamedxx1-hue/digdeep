#!/usr/bin/env bash
# Task 40: poll prod otp-send until the Supabase 2/hour email cap frees a
# slot, then read the RAW upstream verdict via a direct probe.
#   429 "Too many codes requested" → still capped, keep waiting
#   200 "ok"                       → send path healthy (earlier 400s = transient)
#   400 "Enter a valid email..."   → POLICY REJECTION confirmed (the old code's
#                                     misleading mapping) → read raw error_code
set -u
BASE="https://digdeepx.vercel.app"
PROJ="https://vvopggnkskzzwolxbjig.supabase.co"
PUB="sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D"
EMAIL="capwatch-77331@example.org"
POLLS="${1:-8}"

for i in $(seq 1 "$POLLS"); do
  R=$(curl -sS -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
    -d "{\"action\":\"otp-send\",\"email\":\"$EMAIL\"}" -w "|%{http_code}")
  TS=$(date +%H:%M:%S)
  if echo "$R" | grep -q "Too many codes requested"; then
    echo "[$TS] poll $i/$POLLS: still capped (429)"
  elif echo "$R" | grep -q "A code was just sent"; then
    echo "[$TS] poll $i/$POLLS: own 60s cooldown active (from previous poll) — waiting it out"
    sleep 62
  elif echo "$R" | grep -q "unreachable"; then
    echo "[$TS] poll $i/$POLLS: upstream slow/unreachable (502) — Supabase edge flake, retrying"
    sleep 20
  elif echo "$R" | grep -q "temporarily unavailable"; then
    echo "[$TS] poll $i/$POLLS: upstream POLICY REJECTION (502) — the smoking-gun class"
    echo "== raw upstream verdict (direct probe, fresh email) =="
    curl -sS -m 20 -X POST "$PROJ/auth/v1/otp" \
      -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"capwatch-direct-77332@example.org\",\"create_user\":true}" \
      -w "\nHTTP %{http_code}\n" | head -c 500
    exit 0
  else
    echo "[$TS] poll $i/$POLLS: *** SLOT FREE *** → $R"
    echo
    echo "== raw upstream verdict (direct probe, fresh email) =="
    curl -sS -m 20 -X POST "$PROJ/auth/v1/otp" \
      -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"capwatch-direct-77332@example.org\",\"create_user\":true}" \
      -w "\nHTTP %{http_code}\n" | head -c 500
    exit 0
  fi
  [ "$i" -lt "$POLLS" ] && sleep 75
done
echo "STILL_CAPPED after $POLLS polls"
