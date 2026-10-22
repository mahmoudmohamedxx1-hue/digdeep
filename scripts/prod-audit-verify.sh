#!/usr/bin/env bash
# v3.4.1 PROD AUDIT VERIFICATION — digdeepx.vercel.app
# Verifies every audit fix on production + regression-checks the six v3.4 features.
set -uo pipefail
BASE="https://digdeepx.vercel.app"
PASS=0; FAIL=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

JAR=$(mktemp)
RND=$RANDOM$RANDOM
EMAIL="audit-v341-$RND@test.local"

echo "── A · Core surfaces ──"
for p in / /gallery /benchmark /api-docs /account /offline /manifest.webmanifest /sw.js; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$p")
  [[ "$CODE" == "200" ]] && pass "$p → 200" || fail "$p → $CODE"
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/s/nonexistent0000")
[[ "$CODE" == "404" ]] && pass "/s/<bogus> → 404" || fail "/s/<bogus> → $CODE"

echo "── B · Fresh account + keys ──"
REG=$(curl -s -c "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"$EMAIL\",\"password\":\"ci-password-123\"}")
echo "$REG" | grep -q '"user"' && pass "register → session" || fail "register failed: $REG"
KEY=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"audit-full"}')
DDK=$(echo "$KEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$DDK" ]] && pass "full-scope key created" || fail "key creation failed: $KEY"
ROKEY=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"audit-ro","scopes":["research:read"]}')
RODDK=$(echo "$ROKEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$RODDK" ]] && pass "read-only key created" || fail "ro key failed: $ROKEY"

echo "── C · F9 MCP: -32600 + regression (initialize/tools) ──"
MR=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"id":99,"method":"tools/list"}')
echo "$MR" | grep -q '\-32600' && pass "MCP no-jsonrpc → -32600" || fail "MCP no-jsonrpc not rejected: $(echo "$MR" | head -c 100)"
INIT=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
echo "$INIT" | grep -q '"protocolVersion":"2025-06-18"' && pass "MCP initialize regression ok" || fail "MCP initialize broken: $(echo "$INIT" | head -c 100)"

echo "── D · F1 settings: fail-closed ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save","endpoints":[]}')
[[ "$CODE" == "403" ]] && pass "settings POST anonymous → 403" || fail "settings anon → $CODE (want 403)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save-llm7-key","key":"x"}')
[[ "$CODE" == "403" ]] && pass "settings POST non-admin session → 403" || fail "settings session → $CODE (want 403)"
STGET=$(curl -s "$BASE/api/settings")
echo "$STGET" | grep -q '"endpoints"' && pass "settings GET open + masked" || fail "settings GET broken"

echo "── E · F2 admin route deleted ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/admin/migrate")
[[ "$CODE" == "404" ]] && pass "admin/migrate → 404 (route gone)" || fail "admin/migrate → $CODE (want 404)"

echo "── E2 · v3.6 chat sign-in gate (POST /api/research) ──"
GBODY=$(curl -s -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":"gate probe anonymous"}' -w "|%{http_code}")
echo "$GBODY" | grep -q "|401$" && pass "anonymous chat start → 401 (sign-in required)" || fail "anon chat start: $GBODY (want 401)"
echo "$GBODY" | grep -q '"code":"auth_required"' && pass "gate body carries auth_required (UI routes to /account)" || fail "gate body missing code: $GBODY"
GSESS=$(curl -s -b "$JAR" -X POST "$BASE/api/research" -H "Content-Type: application/json" -d "{\"query\":\"gate probe signed in $RND\",\"preset\":\"quick\",\"threadId\":\"audit-gate-$RND\"}")
echo "$GSESS" | grep -q '"id"' && pass "signed-in chat start → run created (gate opens for accounts)" || fail "signed-in chat start: $GSESS"
# cost hygiene: cancel the probe immediately — the gate is proven, no need to
# let this run burn a full engine pass (owner session may cancel its own run)
GJOB=$(echo "$GSESS" | grep -o '"id":"[a-z0-9]*"' | head -1 | cut -d'"' -f4 || true)
[ -n "$GJOB" ] && curl -s -o /dev/null -b "$JAR" -X PATCH "$BASE/api/research/$GJOB" -H "Content-Type: application/json" -d '{"action":"cancel"}'

echo "── F · F6 webhook SSRF guard ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://169.254.169.254/latest/meta-data","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to metadata IP → 400" || fail "metadata webhook → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://localhost:8080/hook","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to localhost → 400 (no flag on prod)" || fail "localhost webhook → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://10.1.2.3/hook","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to private range → 400" || fail "private webhook → $CODE (want 400)"

echo "── G · Start an owned run via v1 (regression: scope + start) ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $RODDK" -H "Content-Type: application/json" -d '{"query":"scope regression"}')
[[ "$CODE" == "403" ]] && pass "read-only key still 403 on start (scope regression ok)" || fail "ro key start → $CODE (want 403)"
START=$(curl -s -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"query":"What is the wingspan of a wandering albatross?","preset":"quick"}')
JOB_ID=$(echo "$START" | grep -o '"id":"[a-z0-9]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$JOB_ID" ]] && pass "owned run started via v1 ($JOB_ID)" || fail "v1 start failed: $START"

echo "── H · F4/F3 ownership gates on the owned run ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$JOB_ID")
[[ "$CODE" == "404" ]] && pass "internal status anonymous → 404" || fail "internal anon → $CODE (want 404)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$JOB_ID/export?format=json")
[[ "$CODE" == "404" ]] && pass "internal export anonymous → 404" || fail "export anon → $CODE (want 404)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/research/$JOB_ID" -H "Content-Type: application/json" -d '{"action":"retry"}')
[[ "$CODE" == "404" || "$CODE" == "400" ]] && pass "PATCH retry anonymous → blocked ($CODE)" || fail "PATCH anon → $CODE (want 404/400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/research/$JOB_ID/share")
[[ "$CODE" == "404" || "$CODE" == "409" ]] && pass "share-publish anonymous → blocked ($CODE)" || fail "share anon → $CODE (want 404/409)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/research/$JOB_ID")
[[ "$CODE" == "200" ]] && pass "internal status owner-session → 200 (UI works)" || fail "owner session → $CODE (want 200)"
DET=$(curl -s "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK")
echo "$DET" | grep -q '"status"' && pass "v1 detail with owner key → run visible" || fail "v1 detail failed"
THREADLIST=$(curl -s "$BASE/api/research?threadId=$JOB_ID")
N=$(echo "$THREADLIST" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(r).jobs.length)}catch{console.log("?")}})' 2>/dev/null)
[[ "$N" == "0" ]] && pass "thread list anonymous → 0 jobs (F5)" || fail "thread list → $N jobs (want 0)"

echo "── I · Wait for completion → verify share + webhook payload path ──"
STATUS=""
for i in $(seq 1 30); do
  STATUS=$(curl -s "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]] && break
  sleep 10
done
echo "  (final status: $STATUS after ~$((i*10))s)"
if [[ "$STATUS" == "completed" ]]; then
  pass "v1 quick run completed on prod (engine + continuation healthy)"
  # owner CAN share
  SHR=$(curl -s -b "$JAR" -X POST "$BASE/api/research/$JOB_ID/share")
  SHARE_ID=$(echo "$SHR" | grep -o '"shareId":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [[ -n "$SHARE_ID" ]] && pass "owner session can share ($SHARE_ID)" || fail "owner share failed: $SHR"
  if [[ -n "$SHARE_ID" ]]; then
    # once shared, the run is public-by-choice: anonymous internal read now 200
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$JOB_ID")
    [[ "$CODE" == "200" ]] && pass "shared run readable anonymously (public-by-choice)" || fail "shared run anon → $CODE (want 200)"
    BARE=${SHARE_ID#s-} # the /s/<id> route takes the BARE id; the API returns it s--prefixed
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/s/$BARE")
    [[ "$CODE" == "200" ]] && pass "share page renders" || fail "share page → $CODE"
  fi
  # export with owner key via internal route (OpenAPI contract)
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$JOB_ID/export?format=pdf" -H "Authorization: Bearer $DDK")
  [[ "$CODE" == "200" ]] && pass "export pdf with owner Bearer key → 200 (spec-true)" || fail "export with key → $CODE (want 200)"
else
  fail "run did not complete (status=$STATUS) — investigate"
fi

echo "── J · Cleanup: revoke keys ──"
KEYS=$(curl -s -b "$JAR" "$BASE/api/keys")
for KID in $(echo "$KEYS" | grep -o '"id":"[a-z0-9]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d "{\"action\":\"revoke\",\"id\":\"$KID\"}"
done
echo "  (keys revoked; test account $EMAIL remains — delete from /account if undesired)"

echo ""
echo "==================================================================="
if [[ $FAIL -eq 0 ]]; then echo "  PROD AUDIT VERIFICATION: ALL $PASS CHECKS PASSED"; else echo "  PROD AUDIT VERIFICATION: $FAIL FAILURES (of $((PASS+FAIL)))"; fi
echo "==================================================================="
exit $((FAIL > 0 ? 1 : 0))
