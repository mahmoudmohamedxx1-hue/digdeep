#!/usr/bin/env bash
# Replay the exact conversation that failed (from the user's complaint) end-to-end
# against the live engine, printing mode + answer for each turn.
# v3.6: chatting requires an account — the script signs in a local dev account
# first and rides its session cookie (register is idempotent-shaped: if the
# account exists, login instead).
set -u
BASE="http://localhost:3000"
JAR=$(mktemp)

echo "── signing in (chat gate, v3.6) ──"
R=$(curl -s -c "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d '{"action":"register","email":"replay-dev@digdeep.local","password":"replay-dev-pass-123"}')
if ! echo "$R" | grep -q '"user"'; then
  R=$(curl -s -c "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
    -d '{"action":"login","email":"replay-dev@digdeep.local","password":"replay-dev-pass-123"}')
fi
if ! echo "$R" | grep -q '"user"'; then
  echo "SIGN-IN FAILED (is the dev server running on $BASE?): $R"
  exit 1
fi
echo "signed in (replay-dev@digdeep.local)"

send() {
  local q="$1" thread="$2" preset="${3:-standard}"
  local body id mode answer
  body=$(curl -s -b "$JAR" -X POST "$BASE/api/research" -H 'Content-Type: application/json' \
    -d "{\"query\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$q"), \"preset\": \"$preset\"${thread:+, \"threadId\": \"$thread\"}}")
  id=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
  if [ -z "$id" ]; then echo "CREATE FAILED: $body"; exit 1; fi
  # poll until completed/failed (max ~120s)
  for i in $(seq 1 120); do
    sleep 1
    status=$(curl -s -b "$JAR" "$BASE/api/research/$id" | python3 -c "
import json,sys
d=json.load(sys.stdin)
j=d.get('job',d)
print(j.get('status',''))" 2>/dev/null)
    case "$status" in completed|failed|cancelled) break;; esac
  done
  curl -s -b "$JAR" "$BASE/api/research/$id" | python3 -c "
import json,sys
d=json.load(sys.stdin)
j=d.get('job',d)
print('MODE:', j.get('mode'))
print('STATUS:', j.get('status'))
print('ANSWER:')
print((j.get('reportMd') or '')[:1400])"
  echo "$id"
}

echo "=============== TURN 1: hii ==============="
send "hii" ""
sleep 2
echo ""
echo "=============== TURN 2: how do you make deep research ==============="
send "how do you make deep research" ""
sleep 2
echo ""
echo "=============== TURN 3: what engines you have and what is the full technical process ==============="
send "what engines you have and what is the full technical process" ""
sleep 2
echo ""
echo "=============== TURN 4: iam asking about search engines you got ==============="
send "iam asking about search engines you got" ""
sleep 2
echo ""
echo "=============== TURN 5: i mean like brave and those engine not the ai model ==============="
send "i mean like brave and those engine not the ai model" ""
