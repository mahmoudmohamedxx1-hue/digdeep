#!/usr/bin/env bash
# =====================================================================
# P0-5 STANDALONE INTEGRATION TEST — the deployment-bug-class killer.
#
# The v3.2.1 lesson: the PDF export shipped broken to production because no
# test exercised the TRACED STANDALONE ARTIFACT — unit tests ran against the
# source tree, where pdfkit's files were all present. This script builds the
# real artifact, boots it, and exercises every export format + the new v3.3
# surfaces end to end. If a bundler/tracer/runtime mismatch exists, it dies
# HERE, in CI, instead of in a user's browser.
#
# Usage: bash scripts/test-standalone.sh [--fast]
#   --fast: skip the full next build if .next/standalone already exists and
#           is newer than src/ (for iterative local runs; CI always builds).
# Exit: 0 = all checks green, 1 = any failure.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${STANDALONE_PORT:-3111}"
BASE="http://localhost:$PORT"
FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

# v3.4.1 audit fix: the app (src/lib/db.ts) SKIPS invalid DATABASE_URL values
# (e.g. a stale file: SQLite URL exported in this shell by old tooling), but
# the direct-Prisma helpers here (inject-trial, the seed one-liners) do not —
# they would silently fail and cascade empty job ids through the whole suite.
# Normalize ONCE, up front, so every ${DATABASE_URL:-…} below gets a real
# postgres:// URL.
case "${DATABASE_URL:-}" in
  postgresql://* | postgres://* | "") ;;
  *)
    echo "  ⚠ DATABASE_URL='${DATABASE_URL}' is not a postgres URL — normalizing to local PG :5433"
    DATABASE_URL="postgresql://postgres:postgres@localhost:5433/digdeep"
    ;;
esac
export DATABASE_URL

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED=1; }
FAILED=0

echo "── 1 · Build the standalone artifact (the exact production shape) ──"
if [[ $FAST -eq 1 && -f .next/standalone/server.js && -z "$(find src prisma -newer .next/standalone/server.js \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | head -1)" ]]; then
  echo "  (fast mode: reusing existing build)"
else
  DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" npm run build > /tmp/standalone-build.log 2>&1 || {
    echo "BUILD FAILED — tail:"; tail -30 /tmp/standalone-build.log; exit 1;
  }
fi

echo "── 2 · Verify the traced artifact contains complete packages ──"
# the v3.2.1 bug class: tracer copied a partial pdfkit
for f in "node_modules/pdfkit/js/pdfkit.js" "node_modules/pdfkit/js/data/Helvetica.afm"; do
  [[ -f ".next/standalone/$f" ]] && pass "traced: $f" || fail "MISSING from trace: $f"
done
if [[ -d ".next/standalone/.next/static" ]]; then pass "static assets copied"; else fail "static assets missing from standalone"; fi

echo "── 3 · Boot the standalone server (node, production parity) ──"
# Robustness: a stale server from a previous (crashed) session holding $PORT
# makes the new server die with EADDRINUSE while curl keeps hitting the OLD
# build — tests would then verify the wrong binary. Kill any pre-existing
# holder loudly before booting.
STALE_PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [[ -n "$STALE_PIDS" ]]; then
  echo "  ⚠ killing stale process(es) on :$PORT → $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true; sleep 1
  kill -9 $STALE_PIDS 2>/dev/null || true; sleep 1
  if [[ -n "$(lsof -ti :"$PORT" 2>/dev/null || true)" ]]; then
    echo "  ❌ port $PORT still occupied — aborting rather than testing a stale server"
    exit 1
  fi
fi
# v3.6.1: lsof is blind in some sandboxes AND Next renames the server process
# to "next-server (vX)" — so a stale standalone server survives both the lsof
# check above and any pkill -f on the launch command, then EADDRINUSEs our
# boot while it keeps answering curls (observed in the wild). Sweep by the
# renamed title too; at this point none of THIS suite's servers exist yet.
STALE_NEXT=$(pgrep -f "next-server \(" 2>/dev/null || true)
if [[ -n "$STALE_NEXT" ]]; then
  echo "  ⚠ killing stale next-server process(es) → $STALE_NEXT"
  kill $STALE_NEXT 2>/dev/null || true; sleep 1
  kill -9 $STALE_NEXT 2>/dev/null || true; sleep 1
fi
SRV_PID=""
ASRV_PID=""
RECV_PID=""
MOCK_PID=""
cleanup() {
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
  [[ -n "$ASRV_PID" ]] && kill "$ASRV_PID" 2>/dev/null || true
  wait "$ASRV_PID" 2>/dev/null || true
  [[ -n "$RECV_PID" ]] && kill "$RECV_PID" 2>/dev/null || true
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT
NODE_ENV=production DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" PORT=$PORT CRON_SECRET="${CRON_SECRET:-ci-cron-secret}" ALLOW_LOCAL_WEBHOOKS=1 SUPABASE_URL="http://localhost:3199" SUPABASE_ANON_KEY="test-anon-key-0123456789abcdef" node .next/standalone/server.js > /tmp/standalone-server.log 2>&1 &
SRV_PID=$!

# v3.4 step 10 receiver: a local HTTP sink that records webhook deliveries
rm -f /tmp/ci-webhook-hits.jsonl
OUT=/tmp/ci-webhook-hits.jsonl node -e '
  const http = require("http"), fs = require("fs");
  http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { fs.appendFileSync(process.env.OUT, JSON.stringify({ event: req.headers["x-digdeep-event"], sig: req.headers["x-digdeep-signature"], ts: req.headers["x-digdeep-timestamp"], body: b }) + "\n"); } catch {}
      res.writeHead(200); res.end("ok");
    });
  }).listen(3999);' 2>/dev/null &
RECV_PID=$!

# v3.5 step 16 helper: mock Supabase Auth (email-OTP) on :3199 — stale
# holder check mirrors the :$PORT logic (a crashed session's mock would
# EADDRINUSE the new one and every OTP check would probe a dead port)
STALE_MIDS=$(lsof -ti :3199 2>/dev/null || true)
if [[ -n "$STALE_MIDS" ]]; then
  echo "  ⚠ killing stale mock-supabase on :3199 → $STALE_MIDS"
  kill $STALE_MIDS 2>/dev/null || true; sleep 0.5
fi
rm -f /tmp/mock-supabase.log
node scripts/mock-supabase.js > /tmp/mock-supabase.log 2>&1 &
MOCK_PID=$!

for i in $(seq 1 40); do
  curl -sf -o /dev/null "$BASE/" && break
  sleep 0.5
done
curl -sf -o /dev/null "$BASE/" && pass "server up on :$PORT" || { fail "server never came up"; tail -20 /tmp/standalone-server.log; exit 1; }
# v3.6.1 integrity gate: the readiness curl can be answered by a FOREIGN
# process holding the port while our own server lies dead from EADDRINUSE
# (observed in the wild: a lingering next-server served an entire suite run
# and every env-dependent check failed against the wrong binary). lsof is
# blind in some sandboxes, so ownership is proven WITHOUT it: our process
# must be alive, its boot log must show Ready, and must NOT show EADDRINUSE.
if ! kill -0 "$SRV_PID" 2>/dev/null; then
  echo "  ❌ suite server (pid $SRV_PID) died — boot log tail:"
  tail -5 /tmp/standalone-server.log
  exit 1
fi
if grep -q "EADDRINUSE" /tmp/standalone-server.log 2>/dev/null; then
  echo "  ❌ suite server hit EADDRINUSE — a foreign process owns :$PORT. Boot log tail:"
  tail -5 /tmp/standalone-server.log
  echo "  (hunt it with: pgrep -af 'next-server \(' )"
  exit 1
fi
if ! grep -q "Ready in" /tmp/standalone-server.log 2>/dev/null; then
  echo "  ❌ suite server never reported Ready — boot log tail:"
  tail -5 /tmp/standalone-server.log
  exit 1
fi

echo "── 4 · Static surfaces respond ──"
for path in "/" "/gallery" "/benchmark" "/api-docs" "/manifest.webmanifest" "/sw.js" "/api/og-card" "/offline/"; do
  CODE=$(curl -sL -o /dev/null -w "%{http_code}" "$BASE$path")
  [[ "$CODE" == "200" ]] && pass "GET $path → 200" || fail "GET $path → $CODE"
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/s/nonexistent0000")
[[ "$CODE" == "404" ]] && pass "GET /s/<bogus> → 404 (clean)" || fail "GET /s/<bogus> → $CODE (want 404)"

echo "── 4b · OG card renderer (PNG, not SVG) + script degradation ──"
# seed two shared reports: Latin-script and Arabic-script (the shaper-killer)
if command -v bun >/dev/null 2>&1; then
  DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" bun -e '
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const base = { reportMd: "# t", stats: JSON.stringify({ citationIntegrity: 88, court: { verdict: "GUILTY" } }), sources: JSON.stringify([{ url: "https://a.com", domain: "a.com", title: "A", sectionTitle: "X" }, { url: "https://b.com", domain: "b.com", title: "B", sectionTitle: "Y" }]) };
await p.sharedReport.upsert({ where: { id: "s-citestand" }, update: {}, create: { id: "s-citestand", jobId: "ci-og-latin", query: "Is the wandering albatross the longest-winged living bird?", ...base } });
await p.sharedReport.upsert({ where: { id: "s-cistarab" }, update: {}, create: { id: "s-cistarab", jobId: "ci-og-arabic", query: "\u0647\u0644 \u0627\u0644\u0628\u062d\u062b \u0627\u0644\u0639\u0645\u064a\u0642 \u0645\u062c\u0627\u0646\u064a\u061f", ...base } });
await p.$disconnect();' 2>/dev/null && pass "share rows seeded (latin + arabic)" || fail "share seeding failed"
fi
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/og/nonexistent0000")
[[ "$CODE" == "404" ]] && pass "og card of bogus share → 404" || fail "og bogus → $CODE (want 404)"
for sid in s-citestand s-cistarab; do
  OUT="/tmp/ci-og-$sid.png"
  CODE=$(curl -s -o "$OUT" -w "%{http_code}" "$BASE/api/og/$sid")
  SZ=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  if [[ "$CODE" == "200" && "$SZ" -gt 5000 ]]; then
    # PNG magic: 89 50 4E 47 — X/Meta/LinkedIn only fetch raster og:images, SVG renders imageless
    if od -An -tx1 -N4 "$OUT" | grep -q "89 50 4e 47"; then
      pass "og card $sid → 200 PNG magic, ${SZ}B"
    else
      CT=$(curl -s -o /dev/null -w "%{content_type}" "$BASE/api/og/$sid")
      fail "og card $sid → 200 but content-type $CT (want image/png)"
    fi
  else
    fail "og card $sid → HTTP $CODE (${SZ}B) — Arabic must NOT crash the renderer"
  fi
done
OGHTML=$(curl -s "$BASE/s/s-citestand")
echo "$OGHTML" | grep -q 'property="og:image"' && pass "/s/ page emits og:image meta" || fail "/s/ page missing og:image"
echo "$OGHTML" | grep -q 'name="twitter:card" content="summary_large_image"' && pass "/s/ page emits twitter:card meta" || fail "/s/ page missing twitter:card"

echo "── 5 · Auth + accounts flow (register → session → keys) ──"
JAR=$(mktemp)
RND=$RANDOM$RANDOM
REG=$(curl -s -c "$JAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"ci-$RND@test.local\",\"password\":\"ci-password-123\"}")
echo "$REG" | grep -q '"user"' && pass "register → user session" || fail "register failed: $REG"
CI_USER_ID=$(echo "$REG" | grep -o '"id":"[a-z0-9]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$CI_USER_ID" ]] && pass "captured ci user id ($CI_USER_ID)" || fail "could not capture user id from register"
ME=$(curl -s -b "$JAR" "$BASE/api/auth")
echo "$ME" | grep -q "ci-$RND@test.local" && pass "session cookie works (GET /api/auth)" || fail "session lost: $ME"
KEY=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"ci"}')
# extract the FULL key from the "key" field only — the "prefix" field is
# truncated with an ellipsis, and a loose ddk_* grep matches BOTH lines; the
# embedded newline then corrupts the Authorization header and Node rejects
# the request with a bare 400 before it ever reaches the app.
DDK=$(echo "$KEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$DDK" ]] && pass "API key created (ddk_…${DDK: -4})" || fail "key creation failed: $KEY"
KEYS=$(curl -s -b "$JAR" "$BASE/api/keys")
echo "$KEYS" | grep -q '"prefix"' && pass "keys listable" || fail "keys not listable: $KEYS"

echo "── 5b · chat requires sign-in (v3.6 gate on POST /api/research) ──"
# The operator closed anonymous run-starting: anyone who wants to chat signs
# in first. What must NOT change: v1/MCP key starts, reading old anonymous
# runs (capability URLs), share pages.
GATE_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":"gate probe anonymous"}')
[[ "$GATE_CODE" == "401" ]] && pass "anonymous chat start → 401 (sign-in gate)" || fail "anonymous chat start → $GATE_CODE (want 401)"
GATE_BODY=$(curl -s -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":"gate probe anonymous"}')
echo "$GATE_BODY" | grep -q '"code":"auth_required"' && pass "gate body carries auth_required (UI routes to /account)" || fail "gate body: $GATE_BODY"
GATE_EMPTY=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":""}')
[[ "$GATE_EMPTY" == "400" ]] && pass "empty query still 400 before the gate (validation order stable)" || fail "empty query → $GATE_EMPTY (want 400)"
GATE_SESS=$(curl -s -b "$JAR" -X POST "$BASE/api/research" -H "Content-Type: application/json" -d '{"query":"ci signed-in gate probe","preset":"quick","threadId":"ci-gate-thread"}')
echo "$GATE_SESS" | grep -q '"id"' && pass "signed-in chat start → run created" || fail "signed-in chat start: $GATE_SESS"
GATE_JOB=$(echo "$GATE_SESS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$GATE_JOB" ]] && pass "gate probe run attributed + queued ($GATE_JOB)" || fail "no gate probe run id"

echo "── 5c · favicon set is the D-letter brand mark (v3.6.1 audit) ──"
# the user's mark: teal whale-D on the dark badge, on EVERY surface. The
# retired set shipped a purple-bars SVG in tabs and near-black ghost PNGs to
# iOS/PWA — this check makes that class of drift impossible to re-ship.
SVGI=$(curl -s "$BASE/icon.svg" || true)
echo "$SVGI" | grep -q "#2dd4bf" && pass "icon.svg carries the brand teal D" || fail "icon.svg is not the teal D mark"
if echo "$SVGI" | grep -qiE "7C3AED|C4B5FD|5B21B6"; then fail "icon.svg still carries the retired purple palette"; else pass "no retired purple in icon.svg"; fi
curl -s -o /tmp/ci-icon192.png "$BASE/icon-192.png" || true
curl -s -o /tmp/ci-apple.png "$BASE/apple-touch-icon.png" || true
if python3 - <<'PY'
from PIL import Image
import numpy as np, sys
bad = []
for name, path, opaque in (("192", "/tmp/ci-icon192.png", False), ("apple", "/tmp/ci-apple.png", True)):
    im = Image.open(path); a = np.array(im.convert("RGBA"))
    solid = a[:, :, 3] > 40
    rgb = a[:, :, :3][solid]
    teal = ((rgb[:, 1] > 150) & (rgb[:, 1] > rgb[:, 0] + 40) & (rgb[:, 2] > 100)).mean()
    lum = rgb.mean(axis=1).mean()
    mode_ok = (im.mode == "RGB") if opaque else True
    print(f"  icon {name}: {im.size[0]}x{im.size[1]} mode={im.mode} teal={100*teal:.0f}% lum={lum:.0f}")
    if not (teal > 0.05 and lum < 120 and mode_ok): bad.append(name)
sys.exit(1 if bad else 0)
PY
then pass "icon-192 + apple-touch-icon are the dark-badge teal D family (not ghosts)"
else fail "favicon PNG family failed the D-badge check"
fi
MAN=$(curl -s "$BASE/manifest.webmanifest" || true)
echo "$MAN" | grep -q "icon-192.png" && echo "$MAN" | grep -q "icon-512.png" && pass "manifest points at the 192/512 D icons" || fail "manifest icon refs broken"

echo "── 5d · auth hardening: password management + sessions (v3.7) ──"
# A dedicated account — the main ci-$RND session must stay alive for sections
# 6-16 (keys/webhooks/watches ownership checks ride on $JAR).
# Each simulated actor carries its own x-forwarded-for (v3.7 clientIp reads
# the LAST entry = the client here): 5d adds ~11 auth POSTs and the per-IP
# 20/min net would otherwise swallow section 16's OTP battery whole — one
# client per actor is also the honest model of what these checks simulate.
SECEMAIL="ci-sec-$RND@test.local"
# W5: breach-list staples must not become account passwords
for badpw in password123 123456789 qwerty123; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "x-forwarded-for: 198.51.100.201" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
    -d "{\"action\":\"register\",\"email\":\"ci-weak-$RND@test.local\",\"password\":\"$badpw\"}")
  [[ "$CODE" == "400" ]] && pass "register with '$badpw' → 400 (common-password screen)" || fail "register '$badpw' → $CODE (want 400)"
done
SECJAR=$(mktemp)
SECREG=$(curl -s -c "$SECJAR" -H "x-forwarded-for: 198.51.100.202" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"$SECEMAIL\",\"password\":\"sec-fixture-pass-11\"}")
echo "$SECREG" | grep -q '"user"' && pass "security fixture account registered" || fail "sec register: $(echo "$SECREG" | head -c 120)"
# new hashes carry the doubled scrypt cost (N=32768)
HARDFMT=$(DATABASE_URL="$DATABASE_URL" bun -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const u = await p.user.findUnique({ where: { email: "'$SECEMAIL'" }, select: { passwordHash: true } });
  console.log(u?.passwordHash?.split("$").slice(0, 4).join("$") ?? "none");
  await p.$disconnect();
})()' 2>/dev/null || echo "err")
[[ "$HARDFMT" == 'scrypt$32768$8$1' ]] && pass "registered hash is the new N=32768 scrypt format" || fail "hash format: $HARDFMT (want scrypt\$32768\$8\$1)"
# W6: change-password / signout-all
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "x-forwarded-for: 198.51.100.206" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"change-password","newPassword":"brand-new-pass-42"}')
[[ "$CODE" == "401" ]] && pass "change-password anonymous → 401" || fail "change-password anon → $CODE (want 401)"
SECJAR2=$(mktemp)
LOGIN2=$(curl -s -c "$SECJAR2" -H "x-forwarded-for: 198.51.100.203" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$SECEMAIL\",\"password\":\"sec-fixture-pass-11\"}")
echo "$LOGIN2" | grep -q '"user"' && pass "second device sign-in → session" || fail "second login: $(echo "$LOGIN2" | head -c 120)"
ME2=$(curl -s -b "$SECJAR2" "$BASE/api/auth")
echo "$ME2" | grep -q '"hasPassword":true' && pass "GET /api/auth reports hasPassword" || fail "hasPassword missing: $(echo "$ME2" | head -c 160)"
SESCOUNT=$(echo "$ME2" | grep -o '"activeSessions":[0-9]*' | grep -o '[0-9]*$' || echo 0)
[[ "$SESCOUNT" -ge 2 ]] && pass "activeSessions counts both devices ($SESCOUNT ≥ 2)" || fail "activeSessions: $SESCOUNT (want ≥ 2)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$SECJAR" -H "x-forwarded-for: 198.51.100.202" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d '{"action":"change-password","currentPassword":"totally-wrong-old","newPassword":"brand-new-pass-42"}')
[[ "$CODE" == "401" ]] && pass "change-password with wrong current → 401" || fail "wrong current → $CODE (want 401)"
CHPW=$(curl -s -b "$SECJAR" -H "x-forwarded-for: 198.51.100.202" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d '{"action":"change-password","currentPassword":"sec-fixture-pass-11","newPassword":"brand-new-pass-42"}')
echo "$CHPW" | grep -q '"ok":true' && pass "change-password → ok" || fail "change-password: $(echo "$CHPW" | head -c 160)"
REVOKED=$(echo "$CHPW" | grep -o '"revoked":[0-9]*' | grep -o '[0-9]*$' || echo 0)
[[ "$REVOKED" -ge 1 ]] && pass "other session(s) revoked on password change ($REVOKED)" || fail "revoked: $REVOKED (want ≥ 1)"
DEAD=$(curl -s -b "$SECJAR2" "$BASE/api/auth")
echo "$DEAD" | grep -q '"user":null' && pass "second device's session is dead after the change" || fail "second session survived: $(echo "$DEAD" | head -c 160)"
ALIVE=$(curl -s -b "$SECJAR" "$BASE/api/auth")
echo "$ALIVE" | grep -q "\"$SECEMAIL\"" && pass "current device stays signed in" || fail "current session died too: $(echo "$ALIVE" | head -c 160)"
RELOGIN=$(curl -s -H "x-forwarded-for: 198.51.100.204" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$SECEMAIL\",\"password\":\"brand-new-pass-42\"}")
echo "$RELOGIN" | grep -q '"user"' && pass "login with the NEW password → 200 (N=32768 verify end-to-end)" || fail "new-password login: $(echo "$RELOGIN" | head -c 160)"
# legacy N=16384 hashes (every pre-v3.7 account) must keep verifying live
LEMAIL="ci-legacy-$RND@test.local"
DATABASE_URL="$DATABASE_URL" bun -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  await p.user.create({ data: { email: "'$LEMAIL'", name: "legacy", passwordHash: "scrypt$16384$8$1$Hdf4dc5l0hytsqS+ZCflgg==$dhnBfG1MhhZfSxL9KQi0MB1ZMJreKAVJHwbZv/nN9LAeP4Xjtfdvav8ZAZxDKfJaLj0CmQabqI59sOVfA+/CvA==" } });
  await p.$disconnect();
})()' 2>/dev/null || true
LLOGIN=$(curl -s -H "x-forwarded-for: 198.51.100.205" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$LEMAIL\",\"password\":\"legacy-fixture-pass-9\"}")
echo "$LLOGIN" | grep -q '"user"' && pass "legacy N=16384 hash still logs in (params honored, zero migration)" || fail "legacy hash login: $(echo "$LLOGIN" | head -c 160)"
# signout-all kills every device including the caller's
SOA=$(curl -s -b "$SECJAR" -H "x-forwarded-for: 198.51.100.202" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"signout-all"}')
echo "$SOA" | grep -q '"ok":true' && pass "signout-all → ok" || fail "signout-all: $(echo "$SOA" | head -c 160)"
ALLDEAD=$(curl -s -b "$SECJAR" "$BASE/api/auth")
echo "$ALLDEAD" | grep -q '"user":null' && pass "caller's own session dead after signout-all" || fail "session survived signout-all: $(echo "$ALLDEAD" | head -c 160)"
# W9: baseline security headers on every response
HHDR=$(curl -sI "$BASE/" || true)
echo "$HHDR" | grep -qi "strict-transport-security" && pass "HSTS header present" || fail "HSTS missing on /"
echo "$HHDR" | grep -qi "x-content-type-options: nosniff" && pass "nosniff header present" || fail "nosniff missing on /"
# throwaway account for the 16b lockout battery (registered here so 16b burns
# zero auth-budget on it; ci- prefix → cleaned up by section 17)
LOCKEMAIL="ci-lock-$RND@test.local"
LOCKREG=$(curl -s -H "x-forwarded-for: 198.51.100.207" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"$LOCKEMAIL\",\"password\":\"lock-me-out-77\"}")
echo "$LOCKREG" | grep -q '"user"' && pass "lockout fixture account registered" || fail "lock fixture register: $(echo "$LOCKREG" | head -c 120)"

echo "── 6 · Public API v1 auth boundary ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Content-Type: application/json" -d '{"query":"test"}')
[[ "$CODE" == "401" ]] && pass "v1 without key → 401" || fail "v1 without key → $CODE (want 401)"
START=$(curl -s -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"query":"What is the wingspan of a wandering albatross?","preset":"quick"}')
JOB_ID=$(echo "$START" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$JOB_ID" ]] && pass "v1 run started via API key ($JOB_ID)" || fail "v1 start failed: $START"

echo "── 6b · v1 run must actually process (after() kickoff + v1 continuation) ──"
# v3.3.1 regression class: the run is started via the public API, then the
# serverless after() slice dies at a checkpoint — only a v1 poll may resume it.
# If the status never leaves 'queued', the public API is a row-inserter, not a
# pipeline. (No LLM key in CI is fine: the engine still transitions — to a
# planning or error state — the point is that it RUNS.)
V1STAT=""
for i in $(seq 1 12); do
  V1STAT=$(curl -s "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK" | grep -o '"status":"[^"]*"' | head -1 || true)
  [[ -n "$V1STAT" && "$V1STAT" != '"status":"queued"' ]] && break
  sleep 5
done
[[ -n "$V1STAT" && "$V1STAT" != '"status":"queued"' ]] \
  && pass "v1 run left the queue ($V1STAT) — engine runs from the public API" \
  || fail "v1 run stuck in 'queued' — after() kickoff / v1 continuation broken"

echo "── 7 · Inject a completed run and exercise EVERY export format ──"
# a deterministic completed job with sources (inject-trial pattern) — no LLM, no waiting
EXPORT_JOB=""
if command -v bun >/dev/null 2>&1; then
  INJ=$(DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" bun scripts/inject-trial.ts ci-standalone-thread 2>/dev/null || true)
  EXPORT_JOB=$(echo "$INJ" | grep -o 'job [a-z0-9]*' | head -1 | cut -d' ' -f2 || true)
fi
[[ -n "$EXPORT_JOB" ]] && pass "deterministic completed run injected ($EXPORT_JOB)" || fail "inject-trial failed — cannot test exports"
for fmt in pdf docx xlsx md; do
  OUT="/tmp/ci-export.$fmt"
  # per-format floor: the injected trial job is deliberately small — its md
  # export is legitimately ~350B; 500B would false-fail the format.
  FLOOR=500; [[ "$fmt" == "md" ]] && FLOOR=100
  CODE=$(curl -s -o "$OUT" -w "%{http_code}" "$BASE/api/research/$EXPORT_JOB/export?format=$fmt")
  SZ=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  if [[ "$CODE" == "200" && "$SZ" -gt "$FLOOR" ]]; then
    # content sniff: the exact v3.2.1 bug was a 500 on pdf — verify real file magic
    # (od, not xxd — xxd is not guaranteed present on CI runners)
    case $fmt in
      pdf) head -c4 "$OUT" | grep -q "%PDF" && pass "export pdf → 200, %PDF magic, ${SZ}B" || fail "export pdf → 200 but not a PDF";;
      docx) od -An -tx1 -N2 "$OUT" | grep -qi "50 4b" && pass "export docx → 200, zip magic, ${SZ}B" || fail "export docx → 200 but not a zip";;
      xlsx) od -An -tx1 -N2 "$OUT" | grep -qi "50 4b" && pass "export xlsx → 200, zip magic, ${SZ}B" || fail "export xlsx → 200 but not a zip";;
      md) head -c1 "$OUT" | grep -q "#" && pass "export md → 200, ${SZ}B" || fail "export md → 200 but empty/odd";;
    esac
  else
    fail "export $fmt → HTTP $CODE (${SZ}B)"
  fi
done

echo "── 8 · v1 detail: ownership boundary + verification object ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/research/$EXPORT_JOB" -H "Authorization: Bearer $DDK")
[[ "$CODE" == "404" ]] && pass "v1 detail of another owner's run → 404 (isolation)" || fail "v1 detail of other's run → $CODE (want 404)"
DET=$(curl -s "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $DDK" || true)
echo "$DET" | grep -q '"verification"' && pass "v1 detail carries the verification object (own run)" || fail "no verification object: $(echo "$DET" | head -c 200)"
echo "  (own v1 run status: $(echo "$DET" | grep -o '"status":"[^"]*"' | head -1 || true) — quick preset runs in background; not gated)"

echo "── 9 · Per-key scopes + monthly quotas (v3.4) ──"
ROKEY=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"ci-readonly","scopes":["research:read"]}')
RODDK=$(echo "$ROKEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $RODDK" -H "Content-Type: application/json" -d '{"query":"scope test"}')
[[ "$CODE" == "403" ]] && pass "research:read-only key cannot start runs → 403" || fail "read-only key POST → $CODE (want 403)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/research/$JOB_ID" -H "Authorization: Bearer $RODDK")
[[ "$CODE" == "200" || "$CODE" == "404" ]] && pass "read-only key CAN read runs (scope allows)" || fail "read-only key GET → $CODE (want 200/404)"
QKEY=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H "Content-Type: application/json" -d '{"action":"create","name":"ci-quota","monthlyLimit":1}')
QDDK=$(echo "$QKEY" | grep -o '"key":"ddk_[^"]*"' | head -1 | cut -d'"' -f4 || true)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $QDDK" -H "Content-Type: application/json" -d '{"query":"quota run one","preset":"quick"}')
[[ "$CODE" == "202" ]] && pass "quota key: 1st run of the month → 202" || fail "quota 1st run → $CODE (want 202)"
Q2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $QDDK" -H "Content-Type: application/json" -d '{"query":"quota run two","preset":"quick"}')
[[ "$Q2" == "429" ]] && pass "quota key: 2nd run → 429 (monthly cap enforced)" || fail "quota 2nd run → $Q2 (want 429)"

echo "── 10 · Webhooks E2E: create → signed delivery → logged (v3.4) ──"
HOOK=$(curl -s -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://localhost:3999/hook","events":["run.completed","run.failed","watch.changed"]}')
HOOK_ID=$(echo "$HOOK" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
HOOK_SECRET=$(echo "$HOOK" | grep -o '"secret":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$HOOK_ID" && -n "$HOOK_SECRET" ]] && pass "webhook created via v1 (secret returned once)" || fail "webhook create failed: $HOOK"
if command -v bun >/dev/null 2>&1 && [[ -n "$CI_USER_ID" ]]; then
  INJ2=$(DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" bun scripts/inject-trial.ts ci-webhook-thread hung --user "$CI_USER_ID" --notify 2>/dev/null || true)
  NOTIFY_JOB=$(echo "$INJ2" | grep -o 'job [a-z0-9]*' | head -1 | cut -d' ' -f2 || true)
  [[ -n "$NOTIFY_JOB" ]] && pass "completed run injected + completion hook fired ($NOTIFY_JOB)" || fail "inject --notify failed: $INJ2"
  sleep 1
  HITS=$(cat /tmp/ci-webhook-hits.jsonl 2>/dev/null || true)
  echo "$HITS" | grep -q '"event":"run.completed"' && pass "receiver got the run.completed POST" || fail "no run.completed delivery received: $(echo "$HITS" | head -c 200)"
  if echo "$HITS" | grep -q '"event":"run.completed"'; then
    LINE=$(grep '"event":"run.completed"' /tmp/ci-webhook-hits.jsonl | head -1)
    SIGOK=$(echo "$LINE" | node -e '
      const { createHmac, timingSafeEqual } = require("crypto");
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        const hit = JSON.parse(raw);
        const expected = createHmac("sha256", process.argv[1]).update(`${hit.ts}.${hit.body}`).digest("hex");
        const got = (hit.sig || "").replace(/^sha256=/, "");
        console.log(expected.length === got.length && timingSafeEqual(Buffer.from(expected), Buffer.from(got)) ? "valid" : "invalid");
      });' "$HOOK_SECRET" || echo "invalid")
    [[ "$SIGOK" == "valid" ]] && pass "HMAC-SHA256 signature verifies against the hook secret" || fail "signature INVALID — receivers would reject our deliveries"
    echo "$LINE" | grep -q "$NOTIFY_JOB" && pass "payload carries the finished run id" || fail "payload missing run id"
  fi
  LIST=$(curl -s "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" || true)
  echo "$LIST" | grep -q '"ok":true' && pass "delivery logged as ok in the webhook list" || fail "delivery not logged: $(echo "$LIST" | head -c 200)"
fi

echo "── 11 · MCP server: initialize → tools → call (v3.4) ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/mcp" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[[ "$CODE" == "401" ]] && pass "MCP without key → 401" || fail "MCP no-auth → $CODE (want 401)"
INIT=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}')
echo "$INIT" | grep -q '"protocolVersion":"2025-06-18"' && pass "MCP initialize echoes protocol version" || fail "initialize failed: $(echo "$INIT" | head -c 150)"
TL=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$TL" | grep -q '"digdeep_research"' && echo "$TL" | grep -q '"digdeep_watch_create"' && pass "tools/list exposes the 5 digdeep tools" || fail "tools/list incomplete: $(echo "$TL" | head -c 150)"
if [[ -n "${NOTIFY_JOB:-}" ]]; then
  TC=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"digdeep_status\",\"arguments\":{\"id\":\"$NOTIFY_JOB\"}}}")
  echo "$TC" | grep -q '"type":"text"' && echo "$TC" | grep -q "Status: completed" && pass "tools/call digdeep_status returns the run (completed)" || fail "digdeep_status failed: $(echo "$TC" | head -c 200)"
  TR=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"digdeep_report\",\"arguments\":{\"id\":\"$NOTIFY_JOB\",\"max_chars\":2000}}}")
  echo "$TR" | grep -q "Verdict: court verdict" && pass "tools/call digdeep_report returns report + verdict header" || fail "digdeep_report failed: $(echo "$TR" | head -c 200)"
fi

echo "── 12 · Scheduled watches + cron auth boundary (v3.4) ──"
WC=$(curl -s -X POST "$BASE/api/v1/watches" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","query":"ci watch: is the albatross still the largest?","cadenceDays":7,"court":true}')
WATCH_ID=$(echo "$WC" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$WATCH_ID" ]] && pass "watch created via v1 (cadence 7d, court)" || fail "watch create failed: $WC"
WL=$(curl -s "$BASE/api/v1/watches" -H "Authorization: Bearer $DDK" || true)
echo "$WL" | grep -q "ci watch: is the albatross" && pass "watch listable" || fail "watch not listable: $(echo "$WL" | head -c 150)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/cron/watches")
[[ "$CODE" == "401" ]] && pass "cron endpoint without secret → 401" || fail "cron no-auth → $CODE (want 401)"
CRON=$(curl -s "$BASE/api/cron/watches" -H "Authorization: Bearer ${CRON_SECRET:-ci-cron-secret}" || true)
echo "$CRON" | grep -q '"processed"' && pass "cron tick with secret → 200 {processed,started,skipped}" || fail "cron tick failed: $(echo "$CRON" | head -c 150)"
DEL=$(curl -s -X POST "$BASE/api/v1/watches" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d "{\"action\":\"delete\",\"id\":\"$WATCH_ID\"}" || true)
echo "$DEL" | grep -q '"ok":true' && pass "watch deleted" || fail "watch delete failed: $DEL"

echo "── 13 · Public track record + OpenAPI contract (v3.4) ──"
ST=$(curl -s "$BASE/api/stats" || true)
echo "$ST" | grep -q '"completedRuns"' && echo "$ST" | grep -q '"avgCitationIntegrity"' && pass "/api/stats serves the live track record" || fail "/api/stats broken: $(echo "$ST" | head -c 150)"
OA=$(curl -s "$BASE/api/openapi.json" || true)
echo "$OA" | grep -q '"openapi":"3.1.0"' && echo "$OA" | grep -q '"/api/v1/webhooks"' && pass "/api/openapi.json serves the 3.1 contract (webhooks documented)" || fail "openapi spec broken: $(echo "$OA" | head -c 150)"
# v3.6.1 hardening: single-shot curls of prerendered pages can race a busy
# event loop (observed once: api-docs grep missed while neighbors passed and
# the same page served 10/10 clean on retry) — fetch with retries instead.
DOCHTML=""
for _ in 1 2 3; do
  DOCHTML=$(curl -s --max-time 20 "$BASE/api-docs" || true)
  echo "$DOCHTML" | grep -q "digdeep_research" && break
  sleep 1
done
echo "$DOCHTML" | grep -q "digdeep_research" && pass "/api-docs renders MCP tools from the spec" || fail "/api-docs missing MCP section"
echo "$DOCHTML" | grep -q "api/v1/webhooks" && pass "/api-docs documents the webhook endpoints" || fail "/api-docs missing webhooks"
BENCHHTML=""
for _ in 1 2 3; do
  BENCHHTML=$(curl -s --max-time 20 "$BASE/benchmark" || true)
  echo "$BENCHHTML" | grep -q "Live track record" && break
  sleep 1
done
echo "$BENCHHTML" | grep -q "Live track record" && pass "/benchmark renders the live track-record section" || fail "/benchmark missing live stats section"

echo "── 14 · v3.4.1 audit gates: ownership on internal routes, SSRF, settings ──"
# F4: internal status/export/PATCH of an OWNED run must 404 for strangers
if [[ -n "${NOTIFY_JOB:-}" ]]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$NOTIFY_JOB")
  [[ "$CODE" == "404" ]] && pass "internal status of another owner's run → 404 (was: full report leak)" || fail "internal status no-auth → $CODE (want 404)"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$NOTIFY_JOB/export?format=json")
  [[ "$CODE" == "404" ]] && pass "internal export (json dump) of owned run → 404 (was: full artifact leak)" || fail "internal export no-auth → $CODE (want 404)"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/research/$NOTIFY_JOB" -H "Content-Type: application/json" -d '{"action":"retry"}')
  [[ "$CODE" == "404" ]] && pass "PATCH retry of owned run by stranger → 404 (was: artifact wipe + cost drain)" || fail "PATCH no-auth → $CODE (want 404)"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/research/$NOTIFY_JOB/share")
  [[ "$CODE" == "404" ]] && pass "share-publish of owned run by stranger → 404 (was: private report made public)" || fail "share no-auth → $CODE (want 404)"
  # owner (session cookie) still has full access — the UI paths keep working
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" "$BASE/api/research/$NOTIFY_JOB")
  [[ "$CODE" == "200" ]] && pass "internal status with owner session → 200 (UI unaffected)" || fail "owner session status → $CODE (want 200)"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/research/$NOTIFY_JOB/share")
  [[ "$CODE" == "200" || "$CODE" == "201" ]] && pass "share-publish with owner session → ok (owner can still share)" || fail "owner share → $CODE"
fi
# keyless UX preserved: anonymous runs stay capability-URL open
if [[ -n "${EXPORT_JOB:-}" ]]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/research/$EXPORT_JOB")
  [[ "$CODE" == "200" ]] && pass "anonymous run internal status stays open (keyless UX preserved)" || fail "anonymous status → $CODE (want 200)"
fi
# F5: thread list must not leak other users' runs
ANON_THREAD=$(curl -s "$BASE/api/research?threadId=ci-webhook-thread" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(r).jobs.length)}catch{console.log("parse-error")}})' 2>/dev/null || echo "?")
[[ "$ANON_THREAD" == "0" ]] && pass "thread list of another user's thread → 0 jobs (was: every query leaked)" || fail "thread list leak: $ANON_THREAD jobs visible"
OWNER_THREAD=$(curl -s -b "$JAR" "$BASE/api/research?threadId=ci-webhook-thread" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(r).jobs.length)}catch{console.log("parse-error")}})' 2>/dev/null || echo "?")
[[ "$OWNER_THREAD" != "0" && "$OWNER_THREAD" != "?" ]] && pass "owner sees own thread jobs ($OWNER_THREAD)" || fail "owner thread list broken: $OWNER_THREAD"
# F6: webhook SSRF guard — metadata + private ranges rejected even with the local-testing flag
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://169.254.169.254/latest/meta-data","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to cloud metadata IP → 400 (SSRF guard)" || fail "metadata webhook → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/webhooks" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"action":"create","url":"http://10.0.0.1/hook","events":["run.completed"]}')
[[ "$CODE" == "400" ]] && pass "webhook to private range → 400 (SSRF guard)" || fail "private webhook → $CODE (want 400)"
# F1: settings POST is admin-gated and fail-closed (ADMIN_EMAILS unset here)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save","endpoints":[]}')
[[ "$CODE" == "403" ]] && pass "settings POST anonymous → 403 (was: prod pool takeover)" || fail "settings no-auth → $CODE (want 403)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$JAR" -X POST "$BASE/api/settings" -H "Content-Type: application/json" -d '{"action":"save-llm7-key","key":"x"}')
[[ "$CODE" == "403" ]] && pass "settings POST signed-in non-admin → 403 (fail-closed without ADMIN_EMAILS)" || fail "settings signed-in → $CODE (want 403)"
STGET=$(curl -s "$BASE/api/settings")
echo "$STGET" | grep -q '"endpoints"' && pass "settings GET stays open + masked (UI health surface)" || fail "settings GET broken: $(echo "$STGET" | head -c 120)"
# F2: admin/migrate route is gone
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/admin/migrate")
[[ "$CODE" == "404" ]] && pass "admin/migrate route deleted (hardcoded-secret DDL endpoint removed)" || fail "admin/migrate → $CODE (want 404)"
# F9: MCP rejects non-2.0 jsonrpc
MR=$(curl -s -X POST "$BASE/api/mcp" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"id":99,"method":"tools/list"}')
echo "$MR" | grep -q '\-32600' && pass "MCP message without jsonrpc 2.0 → -32600 Invalid Request" || fail "MCP no-jsonrpc not rejected: $(echo "$MR" | head -c 120)"

echo "── 15 · admin allowlist: ADMIN_EMAILS operator saves, everyone else 403 ──"
# Second server instance on the next port, identical EXCEPT ADMIN_EMAILS is
# set. Idempotency (found by the re-audit): emails are unique per run
# ($RANDOM, same pattern as step 5) — a fixed email would 409 on every run
# after the first against a non-ephemeral dev DB. The env entry is mixed-case
# and the registration uses a different case mix of the SAME address — both
# prove case-insensitivity (emails normalize to lowercase at registration;
# the allowlist lowercases before compare).
ARND=$RANDOM$RANDOM
AADMIN="ci-admin-$ARND@example.org"
APLAIN="ci-plain-$ARND@example.org"
APORT=$((PORT + 1))
ABASE="http://localhost:$APORT"
STALE_APIDS=$(lsof -ti :"$APORT" 2>/dev/null || true)
if [[ -n "$STALE_APIDS" ]]; then
  echo "  ⚠ killing stale process(es) on :$APORT → $STALE_APIDS"
  kill $STALE_APIDS 2>/dev/null || true; sleep 1
  kill -9 $STALE_APIDS 2>/dev/null || true; sleep 1
fi
NODE_ENV=production DATABASE_URL="$DATABASE_URL" PORT=$APORT CRON_SECRET="${CRON_SECRET:-ci-cron-secret}" ALLOW_LOCAL_WEBHOOKS=1 ADMIN_EMAILS="CI-Admin-$ARND@Example.ORG" SUPABASE_URL="" SUPABASE_ANON_KEY="" node .next/standalone/server.js > /tmp/standalone-admin-server.log 2>&1 &
ASRV_PID=$!
ADMIN_UP=0
for i in $(seq 1 40); do
  curl -sf -o /dev/null "$ABASE/" && ADMIN_UP=1 && break
  sleep 0.5
done
if [[ $ADMIN_UP -ne 1 ]]; then
  fail "admin-configured server never came up on :$APORT"; tail -20 /tmp/standalone-admin-server.log
else
  pass "admin-configured server up on :$APORT (ADMIN_EMAILS set)"
  # register with the UPPERCASE form of the listed email → stored lowercase,
  # allowlist matches case-insensitively, session reports isAdmin
  AJAR="/tmp/ci-admin.jar"; rm -f "$AJAR"
  REG=$(curl -s -c "$AJAR" -X POST "$ABASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"register\",\"email\":\"ci-ADMIN-$ARND@example.org\",\"password\":\"ci-admin-pass-123\"}")
  echo "$REG" | grep -q '"isAdmin":true' && pass "admin email register → isAdmin true (case-insensitive allowlist)" || fail "admin register response: $(echo "$REG" | head -c 160)"
  SES=$(curl -s -b "$AJAR" "$ABASE/api/auth")
  echo "$SES" | grep -q '"isAdmin":true' && pass "GET /api/auth flags the admin session" || fail "admin session GET: $(echo "$SES" | head -c 160)"
  # gate probe: an UNKNOWN action with an admin session must reach the router
  # (400 Unknown action) — a 403 here would mean the gate blocked the admin.
  # Unknown action = zero side effects, unlike a real save.
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$AJAR" -X POST "$ABASE/api/settings" -H "Content-Type: application/json" -d '{"action":"__ci_gate_probe__"}')
  [[ "$CODE" == "400" ]] && pass "settings POST with admin session passes the gate (400 unknown-action, not 403)" || fail "admin settings POST → $CODE (want 400 = gate passed)"
  # real action with zero side effects: re-save the MASKED searchSettings we
  # just GET — undefined keys keep their stored values, so this is a no-op
  # round-trip that proves a genuine action executes (200) for the admin.
  STGET2=$(curl -s -b "$AJAR" "$ABASE/api/settings")
  RESEND=$(echo "$STGET2" | node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{const d=JSON.parse(r);process.stdout.write(JSON.stringify({action:"save-search",searchSettings:d.searchSettings||{}}))}catch{process.stdout.write("{}")}})' 2>/dev/null || echo '{}')
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$AJAR" -X POST "$ABASE/api/settings" -H "Content-Type: application/json" -d "$RESEND")
  [[ "$CODE" == "200" ]] && pass "real action (save-search no-op round-trip) with admin session → 200" || fail "admin save-search → $CODE (want 200)"
  # non-admin on the SAME server (allowlist active) → still 403
  NJAR="/tmp/ci-nonadmin.jar"; rm -f "$NJAR"
  curl -s -c "$NJAR" -X POST "$ABASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"register\",\"email\":\"$APLAIN\",\"password\":\"ci-plain-pass-123\"}" > /dev/null
  NSES=$(curl -s -b "$NJAR" "$ABASE/api/auth")
  echo "$NSES" | grep -q '"isAdmin":false' && pass "non-admin session reports isAdmin false" || fail "non-admin session: $(echo "$NSES" | head -c 160)"
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$NJAR" -X POST "$ABASE/api/settings" -H "Content-Type: application/json" -d '{"action":"__ci_gate_probe__"}')
  [[ "$CODE" == "403" ]] && pass "settings POST non-admin (allowlist active) → 403" || fail "non-admin → $CODE (want 403)"
fi

echo "── 16 · email-OTP auth (mock Supabase): fail-closed, send, throttle, verify ──"
# The MAIN server (started with SUPABASE_URL=http://localhost:3199 + the test
# anon key) exercises the configured path; the ADMIN server from step 15
# (:$APORT, SUPABASE_* explicitly BLANKED — empty env beats the repo defaults,
# the v3.5.1 off switch) proves the fail-closed posture. Mock contract:
# codes 246810 (6-digit) and 24681099 (8-digit — the real project issues 8)
# verify any email, anything else → 400 otp_expired (production Supabase
# returns the same error_code for wrong AND expired codes).

# v3.5.1 config semantics: repo defaults when unset · blank env disables ·
# set env repoints (what the main/admin servers above rely on).
CFGP=$(bun -e '(async () => {
  const m = await import(process.cwd() + "/src/lib/platform/supabase.ts");
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
  const c = m.supabaseAuthConfig();
  console.log(m.otpEnabled() && c && c.url === "https://vvopggnkskzzwolxbjig.supabase.co" && c.anonKey.startsWith("sb_publishable_") ? "DEFAULTS-OK" : "DEFAULTS-BAD");
  process.env.SUPABASE_URL = ""; process.env.SUPABASE_ANON_KEY = "";
  console.log(!m.otpEnabled() ? "DISABLE-OK" : "DISABLE-BAD");
  process.env.SUPABASE_URL = "http://localhost:3199"; process.env.SUPABASE_ANON_KEY = "test-anon-key-0123456789abcdef";
  const c2 = m.supabaseAuthConfig();
  console.log(c2 && c2.url === "http://localhost:3199" && c2.anonKey === "test-anon-key-0123456789abcdef" ? "OVERRIDE-OK" : "OVERRIDE-BAD");
})()')
echo "$CFGP" | grep -q DEFAULTS-OK && pass "config: unset env → repo defaults (prod project, otpEnabled)" || fail "config defaults: $CFGP"
echo "$CFGP" | grep -q DISABLE-OK && pass "config: SUPABASE_URL="" (blank) → feature OFF (fail-closed off switch)" || fail "config disable: $CFGP"
echo "$CFGP" | grep -q OVERRIDE-OK && pass "config: set env beats defaults (mock URL active on main server)" || fail "config override: $CFGP"

ORND=$RANDOM$RANDOM
OEMAIL="ci-otp-$ORND@test.local"
PEMAIL="ci-pw-otp-$ORND@test.local"
OJAR="/tmp/ci-otp.jar"; rm -f "$OJAR"

# fail-closed: admin server has SUPABASE_* blanked — feature inert, 503, no email
SES=$(curl -s "$ABASE/api/auth")
echo "$SES" | grep -q '"otpEnabled":false' && pass "GET /api/auth with SUPABASE env blanked → otpEnabled false" || fail "admin-server session GET: $(echo "$SES" | head -c 160)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$ABASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$OEMAIL\"}")
[[ "$CODE" == "503" ]] && pass "otp-send without SUPABASE env → 503 (fail-closed, nothing emailed)" || fail "otp-send unconfigured → $CODE (want 503)"
grep -q "otp → " /tmp/mock-supabase.log && fail "mock recorded a send while unconfigured (must not call upstream)" || pass "no upstream call when unconfigured (503 short-circuits)"

# configured path on the main server
SES=$(curl -s "$BASE/api/auth")
echo "$SES" | grep -q '"otpEnabled":true' && pass "GET /api/auth with SUPABASE env → otpEnabled true" || fail "main-server session GET: $(echo "$SES" | head -c 160)"

# validation
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"otp-send","email":"not-an-email"}')
[[ "$CODE" == "400" ]] && pass "otp-send malformed email → 400" || fail "otp-send bad email → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL\",\"code\":\"12345\"}")
[[ "$CODE" == "400" ]] && pass "otp-verify 5-digit code → 400" || fail "otp-verify short code → $CODE (want 400)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL\",\"code\":\"123456789\"}")
[[ "$CODE" == "400" ]] && pass "otp-verify 9-digit code → 400 (validation ceiling)" || fail "otp-verify 9-digit → $CODE (want 400)"

# send + 60s per-email cooldown (server-side)
S1=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$OEMAIL\"}")
echo "$S1" | grep -q '"ok":true' && pass "otp-send → ok (upstream accepted, uniform response)" || fail "otp-send: $(echo "$S1" | head -c 160)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$OEMAIL\"}")
[[ "$CODE" == "429" ]] && pass "otp-send resend within 60s → 429 cooldown" || fail "otp-send resend → $CODE (want 429)"
grep -qF "otp → $OEMAIL (#1)" /tmp/mock-supabase.log && pass "mock Supabase logged exactly one send (apikey auth accepted)" || fail "mock log missing the send"

# wrong code → 401; right code 246810 → brand-new OTP-only account + session
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL\",\"code\":\"111111\"}")
[[ "$CODE" == "401" ]] && pass "otp-verify wrong code → 401 (mapped from upstream 400 otp_expired)" || fail "otp-verify wrong code → $CODE (want 401)"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL\",\"code\":\"11111111\"}")
[[ "$CODE" == "401" ]] && pass "otp-verify wrong 8-digit code → 401 (8-digit codes pass validation)" || fail "otp-verify wrong 8-digit → $CODE (want 401)"
V=$(curl -s -c "$OJAR" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL\",\"code\":\"246810\"}")
echo "$V" | grep -q "\"email\":\"$OEMAIL\"" && pass "otp-verify right code → signed in, OTP-only account created" || fail "otp-verify response: $(echo "$V" | head -c 200)"
SES=$(curl -s -b "$OJAR" "$BASE/api/auth")
echo "$SES" | grep -q "\"email\":\"$OEMAIL\"" && pass "OTP session persists (GET /api/auth)" || fail "OTP session GET: $(echo "$SES" | head -c 160)"
echo "$SES" | grep -q '"isAdmin":false' && pass "OTP account is non-admin → isAdmin false" || fail "OTP session isAdmin: $(echo "$SES" | head -c 160)"

# OTP-only accounts have no password — login stays non-enumerating 401
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"login\",\"email\":\"$OEMAIL\",\"password\":\"whatever-pass\"}")
[[ "$CODE" == "401" ]] && pass "password login for OTP-only account → 401 (null hash, no crash)" || fail "password login OTP-only → $CODE (want 401)"

# a password account can ALSO sign in by code — same row reused, not duplicated
REG=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"register\",\"email\":\"$PEMAIL\",\"password\":\"ci-pw-pass-123\"}")
PWID=$(echo "$REG" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
S2=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$PEMAIL\"}")
echo "$S2" | grep -q '"ok":true' && pass "otp-send for a password account → ok" || fail "otp-send (password account): $(echo "$S2" | head -c 160)"
V2=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$PEMAIL\",\"code\":\"246810\"}")
V2ID=$(echo "$V2" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[[ -n "$PWID" && "$V2ID" == "$PWID" ]] && pass "password account signs in by code → SAME user row reused ($PWID)" || fail "OTP on password account: got '$V2ID' want '$PWID'"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"login\",\"email\":\"$PEMAIL\",\"password\":\"ci-pw-pass-123\"}")
[[ "$CODE" == "200" ]] && pass "password login still works after a code sign-in" || fail "password login after OTP → $CODE (want 200)"

# 8-digit code shape (the real project's mailer_otp_length is 8) — end-to-end
OEMAIL8="ci-otp8-$ORND@test.local"
S8=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$OEMAIL8\"}")
echo "$S8" | grep -q '"ok":true' && pass "otp-send (8-digit flow) → ok" || fail "otp-send 8-digit flow: $(echo "$S8" | head -c 160)"
V8=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-verify\",\"email\":\"$OEMAIL8\",\"code\":\"24681099\"}")
echo "$V8" | grep -q "\"email\":\"$OEMAIL8\"" && pass "otp-verify 8-digit code → signed in (config-agnostic 6–8)" || fail "otp-verify 8-digit: $(echo "$V8" | head -c 200)"

# upstream policy rejection (mock: @reject.test → 400 signup_disabled): the
# email passed OUR validation, so the app must NOT blame the email address —
# it reports a temporary outage (502). Found live on prod 2026-10-22: real
# Supabase 4xx rejections surfaced as "Enter a valid email address."
RCODE=$(curl -s -w "|%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"ci-reject-$ORND@reject.test\"}")
if echo "$RCODE" | grep -q "temporarily unavailable" && echo "$RCODE" | grep -q "|502$"; then
  pass "otp-send upstream policy rejection → 502 temporary-unavailable (not 'invalid email')"
else
  fail "otp-send rejection mapping: $RCODE (want 502 + temporarily unavailable)"
fi
if echo "$RCODE" | grep -q "Enter a valid email address"; then
  fail "otp-send rejection still blames the email (regression)"
fi

echo "── 16b · v3.7 lockouts: login brute-force freeze (DB-backed) ──"
# Sections 5d+15+16 burned close to the 20/min IP budget — let the window
# roll over so the per-IP limiter can never masquerade as the DB lockout.
sleep 65
# 5 wrong passwords → 401s (each recorded in AuthAttempt)…
LOCKFAILS=0
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
    -d "{\"action\":\"login\",\"email\":\"$LOCKEMAIL\",\"password\":\"wrong-pass-$i\"}")
  [[ "$CODE" == "401" ]] || LOCKFAILS=$((LOCKFAILS+1))
done
[[ "$LOCKFAILS" == "0" ]] && pass "5 wrong passwords → five 401s (attempt counter filling)" || fail "$LOCKFAILS of the 5 wrong logins were not 401"
# …the 6th is frozen out EVEN WITH THE CORRECT PASSWORD (fail-closed window)
LOCKED=$(curl -s -w "|%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"login\",\"email\":\"$LOCKEMAIL\",\"password\":\"lock-me-out-77\"}")
if echo "$LOCKED" | grep -q "|429$" && echo "$LOCKED" | grep -q "Too many failed sign-ins"; then
  pass "6th attempt with the CORRECT password → 429 account lockout (fail-closed)"
else
  fail "login lockout: $(echo "$LOCKED" | head -c 200) (want 429 + Too many failed sign-ins)"
fi

echo "── 16c · v3.7 lockouts: OTP code-entry freeze (DB-backed, cross-IP) ──"
# 10 wrong codes → 401s; the 11th arrives from a DIFFERENT client IP (fresh
# XFF entry — v3.7's last-entry clientIp) so the per-IP limiter is provably
# NOT what stops it: only the per-email DB lockout can.
sleep 65
OTPLOCKEMAIL="ci-otplock-$RND@test.local"
S=$(curl -s -X POST "$BASE/api/auth" -H "Content-Type: application/json" -d "{\"action\":\"otp-send\",\"email\":\"$OTPLOCKEMAIL\"}")
echo "$S" | grep -q '"ok":true' && pass "otp-send for the lock battery → ok" || fail "otp-send (lock): $(echo "$S" | head -c 120)"
OTPFAILS=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  WRONGCODE=$(printf "%08d" "$i") # always 8 digits (i=10 must not become 9)
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
    -d "{\"action\":\"otp-verify\",\"email\":\"$OTPLOCKEMAIL\",\"code\":\"$WRONGCODE\"}")
  [[ "$CODE" == "401" ]] || OTPFAILS=$((OTPFAILS+1))
done
[[ "$OTPFAILS" == "0" ]] && pass "10 wrong codes → ten 401s (attempt counter filling)" || fail "$OTPFAILS of the 10 wrong codes were not 401"
OTPLOCKED=$(curl -s -w "|%{http_code}" -H "x-forwarded-for: 203.0.113.99" -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"otp-verify\",\"email\":\"$OTPLOCKEMAIL\",\"code\":\"246810\"}")
if echo "$OTPLOCKED" | grep -q "|429$" && echo "$OTPLOCKED" | grep -q "Too many incorrect codes"; then
  pass "11th code from a fresh IP (even the RIGHT code) → 429 per-email lockout"
else
  fail "otp lockout: $(echo "$OTPLOCKED" | head -c 200) (want 429 + Too many incorrect codes)"
fi

echo "── 17 · Cleanup: purge this suite's test data (cascade) ──"
# The suite creates ci-* accounts + injected runs + seeded shares. On CI the
# DB is ephemeral, but locally they accumulate run-after-run.
# ORDER MATTERS — found by the re-audit: ResearchJob.userId is onDelete:
# SetNull (runs survive account deletion as public artifacts, by design), so
# deleting users alone ORPHANS their runs into anonymous (= publicly
# readable) state — which then breaks the F5 thread-privacy check on the
# next run. Correct cleanup deletes the RUNS and SNAPSHOTS first, then the
# users (whose keys/hooks/watches/sessions cascade for real).
CLEANED=$(DATABASE_URL="$DATABASE_URL" bun -e '
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  // 1. runs of this suite: the two inject threads + any run attributed to a
  //    ci-* account (covers orphans left by pre-cleanup-fix runs)
  const ciUsers = await p.user.findMany({ where: { email: { startsWith: "ci-" } }, select: { id: true } });
  const jobs = await p.researchJob.findMany({
    where: { OR: [
      { threadId: { in: ["ci-standalone-thread", "ci-webhook-thread"] } },
      { userId: { in: ciUsers.map((u) => u.id) } },
    ] },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);
  // 2. share snapshots reference jobId as a plain string (no FK) — delete
  //    explicitly, plus the fixed-id og-card seeds from step 4b
  const shares = await p.sharedReport.deleteMany({
    where: { OR: [
      { jobId: { in: jobIds } },
      { id: { in: ["s-citestand", "s-cistarab"] } },
      { threadId: { startsWith: "ci-" } },
    ] },
  });
  // 3. runs (events/sources/sections cascade via FK)
  const runs = await p.researchJob.deleteMany({
    where: { OR: [
      { id: { in: jobIds } },
      { threadId: { in: ["ci-standalone-thread", "ci-webhook-thread"] } },
      { userId: { in: ciUsers.map((u) => u.id) } },
    ] },
  });
  // 4. users (keys/webhooks/watches/sessions cascade)
  const users = await p.user.deleteMany({
    where: { email: { startsWith: "ci-" }, OR: [{ email: { endsWith: "@test.local" } }, { email: { endsWith: "@example.org" } }] },
  });
  console.log(`${users.count}:${runs.count}:${shares.count}`);
  await p.$disconnect();
})().catch(() => { console.log("-1:0:0"); });' 2>/dev/null || echo "-1:0:0")
U_COUNT=$(echo "$CLEANED" | cut -d: -f1)
R_COUNT=$(echo "$CLEANED" | cut -d: -f2)
S_COUNT=$(echo "$CLEANED" | cut -d: -f3)
if [[ "$U_COUNT" == "-1" ]]; then fail "cleanup query failed"
else pass "purged $U_COUNT user(s), $R_COUNT run(s), $S_COUNT share snapshot(s) — nothing orphaned"; fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "==================================================================="
  echo "  STANDALONE INTEGRATION: ALL CHECKS PASSED"
  echo "==================================================================="
else
  echo "==================================================================="
  echo "  STANDALONE INTEGRATION: FAILURES ABOVE — DO NOT SHIP"
  echo "==================================================================="
  exit 1
fi
