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
SRV_PID=""
cleanup() {
  [[ -n "$SRV_PID" ]] && kill "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
}
trap cleanup EXIT
NODE_ENV=production DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/digdeep}" PORT=$PORT node .next/standalone/server.js > /tmp/standalone-server.log 2>&1 &
SRV_PID=$!

for i in $(seq 1 40); do
  curl -sf -o /dev/null "$BASE/" && break
  sleep 0.5
done
curl -sf -o /dev/null "$BASE/" && pass "server up on :$PORT" || { fail "server never came up"; tail -20 /tmp/standalone-server.log; exit 1; }

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
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
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

echo "── 6 · Public API v1 auth boundary ──"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/research" -H "Content-Type: application/json" -d '{"query":"test"}')
[[ "$CODE" == "401" ]] && pass "v1 without key → 401" || fail "v1 without key → $CODE (want 401)"
START=$(curl -s -X POST "$BASE/api/v1/research" -H "Authorization: Bearer $DDK" -H "Content-Type: application/json" -d '{"query":"What is the wingspan of a wandering albatross?","preset":"quick"}')
JOB_ID=$(echo "$START" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
[[ -n "$JOB_ID" ]] && pass "v1 run started via API key ($JOB_ID)" || fail "v1 start failed: $START"

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
