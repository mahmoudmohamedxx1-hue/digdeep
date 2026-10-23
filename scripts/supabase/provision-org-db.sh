#!/usr/bin/env bash
# =====================================================================
# PROVISION-ORG-DB — create the DigDeep production database in a SPECIFIC
# Supabase organization (built for the operator's "DIGDEEP" org, whose
# dedicated project the scoped sbp_ PAT can fully administer — unlike the
# OTP project vvopg…, whose org is outside every PAT generated so far).
#
#   SUPABASE_ACCESS_TOKEN="sbp_…" SUPABASE_ORG_ID="wunnusvrgrvaxkqeuexh" \
#     bash scripts/supabase/provision-org-db.sh
#
# What it does (idempotent — re-runs reuse the project + reset the password):
#   1. Verify token + org; find an existing "digdeep" project in THAT org
#      (reuse) or create it (name + db_pass + region + organization_id).
#   2. Wait for ACTIVE_HEALTHY.
#   3. Resolve a working SESSION-POOLER URL (aws-0/aws-1, port 5432,
#      sslmode=require, NO pgbouncer param — db.ts requires prepared-statement
#      safe connections) — verified with SELECT 1.
#   4. Regenerate scripts/supabase/schema.sql (canonical --emit-sql) and
#      apply it whole-file via the pg driver (simple-query protocol handles
#      the DO $$ blocks correctly — no client-side statement splitting).
#   5. Verify: 16 tables (15 app + _prisma_migrations), RLS 16/16,
#      migration rows = repo migrations, prisma migrate deploy → no-op.
#   6. Print the worker DATABASE_URL + the DB password (stdout only —
#      nothing is written to any file).
#
# Env: SUPABASE_ACCESS_TOKEN (required) · SUPABASE_ORG_ID (required) ·
#      SUPABASE_REGION (default eu-central-1) · SUPABASE_DB_PASSWORD
#      (optional override; generated when absent) · SUPABASE_PROJECT_NAME
#      (default digdeep)
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/../.."

API="https://api.supabase.com/v1"
TOKEN="${SUPABASE_ACCESS_TOKEN:?need SUPABASE_ACCESS_TOKEN (sbp_ PAT)}"
ORG="${SUPABASE_ORG_ID:?need SUPABASE_ORG_ID}"
NAME="${SUPABASE_PROJECT_NAME:-digdeep}"
REGION="${SUPABASE_REGION:-eu-central-1}"

say()  { echo -e "\e[1;34m[provision]\e[0m $*"; }
warn() { echo -e "\e[1;33m[provision]\e[0m $*" >&2; }
die()  { echo -e "\e[1;31m[provision]\e[0m $*" >&2; exit "${2:-1}"; }

api() { # api METHOD PATH [JSON_BODY] → API_BODY + HTTP_CODE globals
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 90 -w '\n%{http_code}' -X "$method" "$API$path" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  local out
  if ! out="$(curl "${args[@]}" 2>&1)"; then HTTP_CODE="000"; API_BODY="$out"; return 1; fi
  HTTP_CODE="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"; return 0
}
jget() { node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{const d=JSON.parse(r);'"$2"'}catch(e){process.stdout.write("")}})' <<<"$1"; }

GEN_PW() { # 32 alnum — URL-safe in a connection string
  local p=""
  while [[ ${#p} -lt 32 ]]; do p+="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"; done
  DB_PW="${p:0:32}"
}
DB_PW="${SUPABASE_DB_PASSWORD:-}"
[[ -z "$DB_PW" ]] && GEN_PW

# ── 1 · token + org + existing project ───────────────────────────────────
say "1/6 verifying token + org…"
api GET /projects
[[ "$HTTP_CODE" == "200" ]] || die "token rejected (HTTP $HTTP_CODE): $API_BODY" 1
api GET "/organizations/$ORG/projects"
[[ "$HTTP_CODE" == "200" ]] || die "org projects unreadable (HTTP $HTTP_CODE): $API_BODY" 1
REF=$(jget "$API_BODY" 'const p=(d.projects||[]).find(x=>x.name==="'"$NAME"'");process.stdout.write(p?p.ref:"")')
STATUS=""; REGION_ACTUAL=""
if [[ -n "$REF" ]]; then
  say "  found existing '$NAME' project → ref $REF (reusing; password will be reset)."
  api PATCH "/projects/$REF/database/password" "{\"password\":\"$DB_PW\"}"
  [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" || "$HTTP_CODE" == "204" ]] \
    || die "password reset failed (HTTP $HTTP_CODE): $API_BODY" 3
  api GET "/projects/$REF"
  REGION_ACTUAL=$(jget "$API_BODY" 'process.stdout.write(d.region||"")')
  STATUS=$(jget "$API_BODY" 'process.stdout.write(d.status||"")')
else
  say "  no '$NAME' project in org — creating (region $REGION)…"
  api POST /projects "{\"name\":\"$NAME\",\"organization_id\":\"$ORG\",\"db_pass\":\"$DB_PW\",\"region\":\"$REGION\"}"
  if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
    die "project creation failed (HTTP $HTTP_CODE): $API_BODY" 2
  fi
  REF=$(jget "$API_BODY" 'process.stdout.write(d.id||d.ref||"")')
  REGION_ACTUAL=$(jget "$API_BODY" 'process.stdout.write(d.region||"")')
  STATUS=$(jget "$API_BODY" 'process.stdout.write(d.status||"")')
  say "  created → ref $REF (region $REGION_ACTUAL, status $STATUS)."
fi
[[ -n "$REF" ]] || die "no project ref resolved" 2

# ── 2 · wait for ACTIVE_HEALTHY ─────────────────────────────────────────
if [[ "$STATUS" != ACTIVE* ]]; then
  say "2/6 waiting for ACTIVE_HEALTHY (provisioning 1–3 min)…"
  for i in $(seq 1 40); do
    sleep 10
    api GET "/projects/$REF"
    STATUS=$(jget "$API_BODY" 'process.stdout.write(d.status||"")')
    say "  status: $STATUS"
    [[ "$STATUS" == ACTIVE* ]] && break
    [[ "$STATUS" == "INACTIVE" || "$STATUS" == "PAUSED" ]] && {
      warn "paused — restoring…"; api POST "/projects/$REF/restore" >/dev/null || true; }
  done
  [[ "$STATUS" == ACTIVE* ]] || die "project never became ACTIVE (last: $STATUS)" 2
else
  say "2/6 project already $STATUS."
fi

# ── 3 · resolve working session-pooler URL ───────────────────────────────
# NOTE pg 8.23+ treats sslmode=require as verify-full; Supabase's pooler
# chain (self-signed intermediate) fails that check — uselibpqcompat=true
# restores libpq semantics (encrypt, no CA verify). The WORKER runs the same
# pg via PrismaPg, so its DATABASE_URL needs the flag too; the Prisma CLI
# engine has native libpq semantics and must NOT receive it.
say "3/6 resolving the worker DATABASE_URL (session pooler, port 5432)…"
WORK_URL=""
pg_ok() { echo "SELECT 1;" | node -e '
const {Client}=require("pg");let r="";process.stdin.on("data",c=>r+=c);
process.stdin.on("end",async()=>{const c=new Client({connectionString:process.argv[1]});
try{await c.connect();await c.query(r);console.log("OK");await c.end();process.exit(0)}
catch(e){process.exit(1)}});' "$1" >/dev/null 2>&1; }
for cand in \
  "postgresql://postgres.$REF:$DB_PW@aws-0-$REGION_ACTUAL.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true" \
  "postgresql://postgres.$REF:$DB_PW@aws-1-$REGION_ACTUAL.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true" \
  "postgresql://postgres:$DB_PW@db.$REF.supabase.co:5432/postgres?sslmode=require&uselibpqcompat=true"; do
  say "  trying ${cand%%@*}@${cand#*@}…"
  if pg_ok "$cand"; then WORK_URL="$cand"; break; fi
done
[[ -n "$WORK_URL" ]] || die "no reachable connection candidate (password/region issue?)" 3
say "  working URL confirmed."

# ── 4 · regenerate + apply schema ────────────────────────────────────────
say "4/6 regenerating schema.sql from prisma/schema.prisma (canonical --emit-sql)…"
bash scripts/supabase/bootstrap.sh --emit-sql >/dev/null || die "--emit-sql failed" 4
say "  applying whole-file via pg simple-query protocol…"
DATABASE_URL="$WORK_URL" node -e '
const fs=require("fs");const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});
await c.connect();await c.query(fs.readFileSync("scripts/supabase/schema.sql","utf8"));
console.log("applied");await c.end()})().catch(e=>{console.error(String(e).slice(0,600));process.exit(1)});' \
  || die "schema apply failed (above)" 4

# ── 5 · verify ───────────────────────────────────────────────────────────
say "5/6 verifying schema state…"
DATABASE_URL="$WORK_URL" node -e '
const {Client}=require("pg");
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const q=async s=>(await c.query(s)).rows;
const t=await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='"'"'public'"'"'");
const rls=await q("SELECT count(*)::int n FROM pg_tables WHERE schemaname='"'"'public'"'"' AND rowsecurity");
const m=await q("SELECT migration_name FROM _prisma_migrations ORDER BY migration_name");
const cols=await q("SELECT column_name FROM information_schema.columns WHERE table_name='"'"'ResearchJob'"'"' AND column_name IN ('"'"'checkpoint'"'"','"'"'leaseUntil'"'"','"'"'sliceN'"'"')");
const at=await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='"'"'public'"'"' AND table_name='"'"'AuthAttempt'"'"'");
console.log(JSON.stringify({tables:t[0].n,rls:rls[0].n,migrations:m.map(x=>x.migration_name),continuationCols:cols.map(x=>x.column_name),authAttempt:at[0].n}));
await c.end()})().catch(e=>{console.error(String(e).slice(0,600));process.exit(1)});' > /tmp/provision-verify.json || die "verification query failed" 4
cat /tmp/provision-verify.json
TABLES=$(jget "$(cat /tmp/provision-verify.json)" 'process.stdout.write(String(d.tables))')
RLSN=$(jget "$(cat /tmp/provision-verify.json)" 'process.stdout.write(String(d.rls))')
[[ "$TABLES" == "16" ]] || die "expected 16 tables, found $TABLES" 4
[[ "$RLSN" == "16" ]] || die "expected 16 RLS-enabled tables, found $RLSN" 4
say "  16 tables, RLS 16/16 ✓ — running prisma migrate deploy (must be a no-op)…"
CLI_URL="${WORK_URL%&uselibpqcompat=true}"   # Prisma CLI engine: native libpq require, no compat flag
if DATABASE_URL="$CLI_URL" bunx prisma migrate deploy 2>&1 | tail -3; then
  say "  migrate deploy clean ✓"
else
  warn "  migrate deploy reported an issue (above) — inspect before shipping."
fi

# ── 6 · print the result ─────────────────────────────────────────────────
say "6/6 done. Worker secret to set (Cloudflare → digdeep):"
echo ""
echo "DATABASE_URL=$WORK_URL"
echo "DB_PASSWORD=$DB_PW"
echo "PROJECT_REF=$REF"
rm -f /tmp/provision-verify.json
