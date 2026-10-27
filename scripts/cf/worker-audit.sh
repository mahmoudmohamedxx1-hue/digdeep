#!/usr/bin/env bash
# v3.9.0 WORKER AUDIT — the LIVE Cloudflare deployment (D1 era).
#
# The 49-check prod-audit-verify.sh battery, retargeted from
# digdeepx.vercel.app to the Cloudflare worker, with v3.9.0 semantic changes:
#   * /api/admin/migrate is BACK (D1-era schema snapshot tool, secret-guarded)
#     — anonymous now expects 401, not the v3.4-era 404.
#   * NEW: remote D1 schema verification through the migrate route's
#     PRAGMA table_info snapshot (column counts vs prisma/schema.prisma).
#   * og surfaces expect the CF_PROFILE SVG variants (no satori/resvg in the
#     worker bundle — the 3 MiB free-plan limit).
#   * NEW: single controlled otp-send to prove the worker→Supabase email lane
#     (no admin round-trip here — no service key in this environment; the
#     429-cap answer counts as "lane alive" per the F-A1 mapping).
#
# Cost hygiene: one real v1 quick run (~26s p50 on this worker), one
# immediately-cancelled gate-probe run, at most one real OTP email.
#
# Usage: bash scripts/cf/worker-audit.sh [BASE_URL]
set -uo pipefail
BASE="${1:-https://digdeep.mahmoudmohamedxx1.workers.dev}"
MIGRATE_SECRET="784a551d819251b7097d3834e16099da"
PASS=0; FAIL=0; WARN=0
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

JAR=$(mktemp)
RND=$RANDOM$RANDOM
EMAIL="audit-v39-$RND@test.local"

echo "── A · Core surfaces (assets binding, pages, extras) ──"
for p in / /gallery /benchmark /api-docs /account /offline /manifest.webmanifest /sw.js; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 30 "$BASE$p")
  [[ "$CODE" == "200" ]] && pass "$p → 200" || fail "$p → $CODE"
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/s/nonexistent0000")
[[ "$CODE" == "404" ]] && pass "/s/<bogus> → 404" || fail "/s/<bogus> → $CODE"
STATS=$(curl -s -m 20 "$BASE/api/stats")
echo "$STATS" | grep -q '"totals"' && pass "/api/stats → live D1 aggregates ($(echo "$STATS" | grep -o '"completedRuns":[0-9]*'))" || fail "/api/stats: $(echo "$STATS" | head -c 120)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/api/trending")
[[ "$CODE" == "200" ]] && pass "/api/trending → 200" || fail "/api/trending → $CODE"
OGCT=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" -m 20 "$BASE/api/og-card")
[[ "$OGCT" == *"image/svg+xml" && "$OGCT" == 200* ]] && pass "/api/og-card → 200 SVG (CF profile variant)" || fail "/api/og-card: $OGCT"
OAPI=$(curl -s -m 20 "$BASE/api/openapi.json")
echo "$OAPI" | grep -q '"version":"3.7.0"' && pass "/api/openapi.json → 200, version matches repo API_VERSION (3.7.0)" || fail "openapi version mismatch: $(echo "$OAPI" | grep -o '"version":"[^"]*"' | head -1)"

echo "── A2 · Remote D1 schema (migrate snapshot, PRAGMA table_info) ──"
SNAP=$(curl -s -m 20 "$BASE/api/admin/migrate?secret=$MIGRATE_SECRET")
SCHEMA_OK=$(echo "$SNAP" | node -e '
let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{
  try {
    const b=JSON.parse(r).before||{};
    const want={ResearchJob:33,ActivityEvent:10,Source:13,ResearchSection:11,Setting:2,SharedReport:11};
    let bad=[];
    for(const [t,n] of Object.entries(want)){
      const cols=(b[t]||[]);
      if(cols.length!==n) bad.push(`${t}:${cols.length}!=${n}`);
    }
    const rj=b.ResearchJob||[];
    for(const c of ["threadId","court","language","modelPref","docs","checkpoint","leaseUntil","sliceN","cancelRequested"])
      if(!rj.includes(c)) bad.push(`ResearchJob missing ${c}`);
    console.log(bad.length? "BAD "+bad.join(", ") : "OK");
  } catch(e){ console.log("BAD parse: "+e.message); }
})' 2>/dev/null)
[[ "$SCHEMA_OK" == "OK" ]] && pass "D1 schema exact: ResearchJob 33 / ActivityEvent 10 / Source 13 / ResearchSection 11 / Setting 2 / SharedReport 11 cols, v2.5+ engine columns present" || fail "D1 schema drift: $SCHEMA_OK"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/admin/migrate")
[[ "$CODE" == "401" ]] && pass "admin/migrate POST anonymous → 401 (secret-guarded, exists — v3.9.0 semantics)" || fail "admin/migrate POST anon → $CODE (want 401)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/api/admin/migrate?secret=wrong-secret")
[[ "$CODE" == "401" ]] && pass "admin/migrate wrong secret → 401" || fail "wrong secret → $CODE"

echo "── B · Fresh account + keys (scrypt-16384 on CF profile) ──"
REG=$(curl -s -c "$JAR" -m 30 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"$EMAIL\",\"password\":\"ci-password-123\"}")
echo "$REG" | grep -q '"user"' && pass "register → session (password path, profile scrypt)" || fail "register failed: $REG"
KEY=$(curl -s -b "$JAR" -m 20 -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"audit-v39-full"}')
DDK=$(echo "$KEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$DDK" ]] && pass "full-scope key created" || fail "key creation failed: $KEY"
ROKEY=$(curl -s -b "$JAR" -m 20 -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"audit-v39-ro","scopes":["research:read"]}')
RODDK=$(echo "$ROKEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$RODDK" ]] && pass "read-only key created" || fail "ro key failed: $ROKEY"

echo "── C · MCP: -32600 + regression (initialize/tools) ──"
MR=$(curl -s -m 20 -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"id":99,"method":"tools/list"}')
echo "$MR" | grep -q '\-32600' && pass "MCP no-jsonrpc → -32600" || fail "MCP no-jsonrpc not rejected: $(echo "$MR" | head -c 100)"
INIT=$(curl -s -m 20 -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}')
echo "$INIT" | grep -q '"protocolVersion":"2025-06-18"' && pass "MCP initialize regression ok" || fail "MCP initialize broken: $(echo "$INIT" | head -c 100)"

echo "── D · Settings fail-closed ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save","endpoints":[]}')
[[ "$CODE" == "403" ]] && pass "settings POST anonymous → 403" || fail "settings anon → $CODE (want 403)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -b "$JAR" -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save-llm7-key","key":"x"}')
[[ "$CODE" == "403" ]] && pass "settings POST non-admin session → 403" || fail "settings session → $CODE (want 403)"
STGET=$(curl -s -m 20 "$BASE/api/settings")
echo "$STGET" | grep -q '"endpoints"' && pass "settings GET open + masked" || fail "settings GET broken"

echo "── E2 · v3.6 chat sign-in gate (POST /api/research) ──"
GBODY=$(curl -s -m 20 -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":"gate probe anonymous"}' -w "|%{http_code}")
echo "$GBODY" | grep -q "|401$" && pass "anonymous chat start → 401 (sign-in required)" || fail "anon chat start: $GBODY (want 401)"
echo "$GBODY" | grep -q '"code":"auth_required"' && pass "gate body carries auth_required (UI routes to /account)" || fail "gate body missing code: $GBODY"
GSESS=$(curl -s -m 20 -b "$JAR" -X POST "$BASE/api/research" -H "Content-Type: application/json" -d "{\"query\":\"gate probe signed in $RND\",\"preset\":\"quick\",\"threadId\":\"audit-gate-$RND\"}")
echo "$GSESS" | grep -q '"id"' && pass "signed-in chat start → run created (gate opens for accounts)" || fail "signed-in chat start: $GSESS"
GJOB=$(echo "$GSESS" | grep -o '"id":"[a-z0-9]*"' | head -1 | cut -d'"' -f4 || true)
[ -n "$GJOB" ] && curl -s -o /dev/null -m 20 -b "$JAR" -X PATCH "$BASE/api/research/$GJOB" -H "Content-Type: application/json" -d '{"action":"cancel"}'

echo "── E3 · v3.7 auth hardening live ──"
HHDR=$(curl -sI -m 20 "$BASE/" || true)
echo "$HHDR" | grep -qi "strict-transport-security" && pass "HSTS header on worker /" || fail "HSTS missing on /"
echo "$HHDR" | grep -qi "x-content-type-options: nosniff" && pass "nosniff header on worker /" || fail "nosniff missing on /"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d '{"action":"register","email":"weak-pw-probe@test.local","password":"password123"}')
[[ "$CODE" == "400" ]] && pass "register with password123 → 400 (common-password screen live)" || fail "weak register → $CODE (want 400)"
ME=$(curl -s -m 20 -b "$JAR" "$BASE/api/auth")
echo "$ME" | grep -q '"hasPassword":true' && pass "GET /api/auth reports hasPassword" || fail "hasPassword missing: $(echo "$ME" | head -c 160)"
SESS=$(echo "$ME" | grep -o '"activeSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
[[ "$SESS" -ge 1 ]] && pass "activeSessions present ($SESS)" || fail "activeSessions: $SESS"
JAR2=$(mktemp)
LOGIN2=$(curl -s -c "$JAR2" -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$EMAIL\",\"password\":\"ci-password-123\"}")
echo "$LOGIN2" | grep -q '"user"' && pass "second device login → session" || fail "second login: $(echo "$LOGIN2" | head -c 160)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -b "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d '{"action":"change-password","currentPassword":"totally-wrong","newPassword":"rotated-audit-pass-9"}')
[[ "$CODE" == "401" ]] && pass "change-password wrong current → 401" || fail "wrong current → $CODE (want 401)"
CHPW=$(curl -s -m 20 -b "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"change-password\",\"currentPassword\":\"ci-password-123\",\"newPassword\":\"rotated-audit-pass-9\"}")
echo "$CHPW" | grep -q '"ok":true' && pass "change-password → ok" || fail "change-password: $(echo "$CHPW" | head -c 160)"
DEAD=$(curl -s -m 20 -b "$JAR2" "$BASE/api/auth")
echo "$DEAD" | grep -q '"user":null' && pass "other device's session revoked on change" || fail "second session survived: $(echo "$DEAD" | head -c 160)"
ALIVE=$(curl -s -m 20 -b "$JAR" "$BASE/api/auth")
echo "$ALIVE" | grep -q '"user":{' && pass "current session survives the change" || fail "current session died: $(echo "$ALIVE" | head -c 160)"
NLOGIN=$(curl -s -m 20 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$EMAIL\",\"password\":\"rotated-audit-pass-9\"}")
echo "$NLOGIN" | grep -q '"user"' && pass "login with the NEW password → 200 (hash portability across scrypt profiles)" || fail "new-password login: $(echo "$NLOGIN" | head -c 160)"

echo "── F · Webhook SSRF guard ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://169.254.169.254/latest/meta-data","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to metadata IP → 400" || fail "metadata webhook → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://localhost:8080/hook","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to localhost → 400" || fail "localhost webhook → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://10.1.2.3/hook","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to private range → 400" || fail "private webhook → $CODE (want 400)"

echo "── G · Owned v1 run (scope regression + real engine pass on D1) ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $RODDK" -H "Content-Type: application/json" -d '{"query":"scope regression"}')
[[ "$CODE" == "403" ]] && pass "read-only key still 403 on start (scope regression ok)" || fail "ro key start → $CODE (want 403)"
START=$(curl -s -m 30 -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"query":"What is the wingspan of a wandering albatross?","preset":"quick"}')
JOB_ID=$(echo "$START" | grep -o '"id":"[a-z0-9]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$JOB_ID" ]] && pass "owned run started via v1 ($JOB_ID)" || fail "v1 start failed: $START"

echo "── H · Ownership gates on the owned run ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/api/research/$JOB_ID")
[[ "$CODE" == "404" ]] && pass "internal status anonymous → 404" || fail "internal anon → $CODE (want 404)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 30 "$BASE/api/research/$JOB_ID/export?format=json")
[[ "$CODE" == "404" ]] && pass "internal export anonymous → 404" || fail "export anon → $CODE (want 404)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X PATCH "$BASE/api/research/$JOB_ID" -H "Content-Type: application/json" -d '{"action":"retry"}')
[[ "$CODE" == "404" || "$CODE" == "400" ]] && pass "PATCH retry anonymous → blocked ($CODE)" || fail "PATCH anon → $CODE (want 404/400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -X POST "$BASE/api/research/$JOB_ID/share")
[[ "$CODE" == "404" || "$CODE" == "409" ]] && pass "share-publish anonymous → blocked ($CODE)" || fail "share anon → $CODE (want 404/409)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 -b "$JAR" "$BASE/api/research/$JOB_ID")
[[ "$CODE" == "200" ]] && pass "internal status owner-session → 200 (UI works)" || fail "owner session → $CODE (want 200)"
DET=$(curl -s -m 20 "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK")
echo "$DET" | grep -q '"status"' && pass "v1 detail with owner key → run visible" || fail "v1 detail failed"
THREADLIST=$(curl -s -m 20 "$BASE/api/research?threadId=$JOB_ID")
N=$(echo "$THREADLIST" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(r).jobs.length)}catch{console.log("?")}})' 2>/dev/null)
[[ "$N" == "0" ]] && pass "thread list anonymous → 0 jobs" || fail "thread list → $N jobs (want 0)"

echo "── I · Completion → share → share page → og → PDF export ──"
STATUS=""
for i in $(seq 1 30); do
  STATUS=$(curl -s -m 20 "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]] && break
  sleep 10
done
echo "  (final status: $STATUS after ~$((i*10))s)"
if [[ "$STATUS" == "completed" ]]; then
  pass "v1 quick run completed on the worker (engine + D1 continuation healthy)"
  SHR=$(curl -s -m 20 -b "$JAR" -X POST "$BASE/api/research/$JOB_ID/share")
  SHARE_ID=$(echo "$SHR" | grep -o '"shareId":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  [[ -n "$SHARE_ID" ]] && pass "owner session can share ($SHARE_ID)" || fail "owner share failed: $SHR"
  if [ -n "$SHARE_ID" ]; then
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$BASE/api/research/$JOB_ID")
    [[ "$CODE" == "200" ]] && pass "shared run readable anonymously (public-by-choice)" || fail "shared run anon → $CODE (want 200)"
    BARE=${SHARE_ID#s-}
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 30 "$BASE/s/$BARE")
    [[ "$CODE" == "200" ]] && pass "share page renders" || fail "share page → $CODE"
    OGCT=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" -m 20 "$BASE/api/og/$BARE")
    [[ "$OGCT" == 200*"image/svg+xml" ]] && pass "og image for the share → 200 SVG (CF profile, no satori)" || fail "og/$BARE: $OGCT"
  fi
  PDFCT=$(curl -s -o /dev/null -w "%{http_code} %{content_type}" -m 60 "$BASE/api/research/$JOB_ID/export?format=pdf" -H "Authorization: Bearer $DDK")
  [[ "$PDFCT" == 200*"application/pdf" ]] && pass "export pdf with owner Bearer key → 200 application/pdf (pdfkit on workerd)" || fail "export pdf: $PDFCT"
else
  fail "run did not complete (status=$STATUS) — investigate"
fi

echo "── J · Cleanup: revoke keys ──"
KEYS=$(curl -s -m 20 -b "$JAR" "$BASE/api/keys")
for KID in $(echo "$KEYS" | grep -o '"id":"[a-z0-9]*"' | cut -d'"' -f4); do
  curl -s -o /dev/null -m 20 -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d "{\"action\":\"revoke\",\"id\":\"$KID\"}"
done
LEFT=$(curl -s -m 20 -b "$JAR" "$BASE/api/keys" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(r).keys.filter(k=>!k.revoked).length)}catch{console.log("?")}})' 2>/dev/null)
[[ "$LEFT" == "0" ]] && pass "all audit keys revoked" || fail "keys remaining: $LEFT"

echo "── K · signout-all ends every session ──"
SOA=$(curl -s -m 20 -b "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"signout-all"}')
echo "$SOA" | grep -q '"ok":true' && pass "signout-all → ok" || fail "signout-all: $(echo "$SOA" | head -c 160)"
ALLDEAD=$(curl -s -m 20 -b "$JAR" "$BASE/api/auth")
echo "$ALLDEAD" | grep -q '"user":null' && pass "caller's session dead after signout-all" || fail "session survived signout-all: $(echo "$ALLDEAD" | head -c 160)"

echo "── L · OTP email lane (single controlled send) ──"
# NOTE the address domain: Supabase REJECTS reserved domains (example.com,
# .test, .invalid) with 400 email_address_invalid — which the app correctly
# maps to the honest 502 outage answer (the F-A1 fix). A deliverable domain
# (gmail.com) is required to exercise the actual send path.
OS=$(curl -s -m 30 -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"digdeep.audit.probe.$RND@gmail.com\"}")
if echo "$OS" | grep -q '"ok":true'; then
  pass "otp-send → ok (Supabase accepted from the worker network path)"
elif echo "$OS" | grep -qi 'too many\|rate'; then
  warn "otp-send → upstream cap/cooldown mapped (lane alive — 429 semantics)"
else
  fail "otp-send: $OS (a 400 'valid email' answer = F-A1 regression)"
fi

echo ""
echo "==================================================================="
if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then echo "  WORKER AUDIT: ALL $PASS CHECKS PASSED"
elif [[ $FAIL -eq 0 ]]; then echo "  WORKER AUDIT: $PASS PASSED, $WARN WARNINGS, 0 FAILURES"
else echo "  WORKER AUDIT: $FAIL FAILURES (of $((PASS+FAIL+WARN)))"; fi
echo "==================================================================="
echo "  (audit account $EMAIL + shared probe run remain on prod D1 — delete from /account if undesired)"
exit $((FAIL > 0 ? 1 : 0))
