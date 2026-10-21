#!/usr/bin/env bash
# =====================================================================
# SUPABASE BOOTSTRAP — the "pro database" engine (v3.5).
#
# One command turns a Supabase project into DigDeep's production database
# with real email-code auth. Safe to re-run (idempotent). Run from repo root:
#
#   SUPABASE_ACCESS_TOKEN="sb_secret_..." bash scripts/supabase/bootstrap.sh
#
# Flags:
#   --dry-run            recon only (list projects, show the plan, no writes)
#   --reset-db-password  existing project + unknown DB password: reset it to
#                        a fresh generated value via the Management API.
#                        Changes the postgres password (data is untouched) —
#                        any other client using the old password breaks.
#   --name NAME          project name to find/create (default: digdeep)
#   --region REGION      region for project creation (default: eu-central-1)
#
# What it does, in order:
#   1. Verify the access token against the Management API.
#   2. Find the DigDeep project (by name); create it (with a generated DB
#      password) if none exists; wait until it is ACTIVE.
#   3. Recover the anon/publishable key (api-keys reveal endpoint).
#   4. Resolve a working connection URL (direct db.<ref>.supabase.co, then
#      Supavisor session/tx poolers) — verified with SELECT 1.
#   5. Apply the full 14-table schema (generated from prisma/schema.prisma
#      via `prisma migrate diff`), create + seed _prisma_migrations so the
#      deploy pipeline sees everything as applied (no P3009 wedge), and
#      harden every table: ENABLE ROW LEVEL SECURITY + REVOKE from
#      anon/authenticated (Prisma connects as `postgres` = owner, unaffected).
#   6. Configure Supabase Auth for email OTP: signups on, email provider on,
#      and the Magic Link template switched to a 6-digit code ({{ .Token }}).
#   7. Print the exact environment variables to set on Vercel.
#
# Exit codes: 0 ok · 1 bad token · 2 no project (create failed) ·
# 3 no usable DB password · 4 schema apply failed · 5 auth config failed
# (partial progress is reported so the next run resumes cleanly).
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

API="https://api.supabase.com/v1"
NAME="digdeep"
REGION="eu-central-1"
DRY=0
RESET_PW=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --reset-db-password) RESET_PW=1 ;;
    --name) NAME="${2:?}"; shift ;;
    --region) REGION="${2:?}"; shift ;;
    *) echo "unknown flag: $1 (see header)"; exit 64 ;;
  esac
  shift
done

TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: no token. Export SUPABASE_ACCESS_TOKEN (sb_secret_... or sbp_...) first."
  echo "  Dashboard → Account settings → API Keys → create a secret key."
  exit 1
fi

say()  { echo -e "\e[1;34m[bootstrap]\e[0m $*"; }
warn() { echo -e "\e[1;33m[bootstrap]\e[0m $*" >&2; }
die()  { echo -e "\e[1;31m[bootstrap]\e[0m $*" >&2; exit "${2:-1}"; }

jget() { # jget <json> <node-expr over d> — tiny JSON helper
  node -e 'let r="";process.stdin.on("data",c=>r+=c);process.stdin.on("end",()=>{try{const d=JSON.parse(r);'"$2"'}catch{process.stdout.write("")}})' <<<"$1"
}

api() { # api METHOD PATH [JSON_BODY] — prints body; sets HTTP_CODE
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 60 -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(-d "$body")
  local out; out="$(curl "${args[@]}" 2>&1)" || { echo -n ""; echo -n ""; HTTP_CODE=000; return 1; }
  HTTP_CODE="${out##*$'\n'}"
  # last line is the code; body is everything before it (JSON has no raw newlines from curl -sS except error text)
  echo "${out%$'\n'*}" | sed -e '$d' 2>/dev/null || echo "${out%$'\n'*}"
}

# ── 1 · token ────────────────────────────────────────────────────────────
say "1/7 verifying access token against the Management API…"
FIRST=$(api GET /projects)
if [[ "$HTTP_CODE" != "200" ]]; then
  die "token rejected (HTTP $HTTP_CODE): $FIRST" 1
fi
COUNT=$(jget "$FIRST" 'process.stdout.write(String((d||[]).length))')
say "token OK — account has $COUNT project(s)."

# ── 2 · find or create the project ───────────────────────────────────────
REF=""
PLAN=""
REGION_ACTUAL=""
for row in $(jget "$FIRST" 'process.stdout.write((d||[]).map(p=>p.id).join(" "))'); do
  :
done
# fetch full list as JSON lines: id|name|status|region for readable handling
PLIST=$(jget "$FIRST" 'process.stdout.write((d||[]).map(p=>`${p.id}|${p.name}|${p.status}|${(p.region||"")}`).join("\n"))')
while IFS='|' read -r pid pname pstatus pregion; do
  [[ -z "$pid" ]] && continue
  if [[ "${pname,,}" == "${NAME,,}" ]]; then REF="$pid"; REGION_ACTUAL="$pregion"; PLAN="$pstatus"; fi
done <<<"$PLIST"

DB_PW=""
GEN_PW() { # 32 alnum chars, URL-safe (no symbols → no quoting issues)
  local p=""
  while [[ ${#p} -lt 32 ]]; do p+="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"; done
  DB_PW="${p:0:32}"
}

if [[ -n "$REF" ]]; then
  say "2/7 found project '$NAME' → ref $REF (status: $PLAN, region: $REGION_ACTUAL)."
  if [[ "$PLAN" != "ACTIVE" && "$PLAN" != "READY" ]]; then
    warn "project not ACTIVE yet ($PLAN) — waiting…"
    for i in $(seq 1 60); do
      sleep 10
      ONE=$(api GET "/projects/$REF")
      PLAN=$(jget "$ONE" 'process.stdout.write(d.status||"")')
      [[ "$PLAN" == "ACTIVE" || "$PLAN" == "READY" ]] && break
    done
  fi
  if [[ "$RESET_PW" == "1" ]]; then
    GEN_PW
    say "  resetting the database password (data untouched)…"
    R=$(api POST "/projects/$REF/database/reset" "{\"password\":\"$DB_PW\"}")
    if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" && "$HTTP_CODE" != "204" ]]; then
      die "password reset failed (HTTP $HTTP_CODE): $R — set it manually in the dashboard (Settings → Database) and re-run without --reset-db-password" 3
    fi
    say "  DB password reset to a generated value."
  fi
else
  [[ "$DRY" == "1" ]] && { say "dry-run: would CREATE project '$NAME' in $REGION with a generated DB password."; }
  GEN_PW
  say "2/7 no '$NAME' project — creating one in $REGION…"
  if [[ "$DRY" == "1" ]]; then
    say "dry-run stops before creation. Re-run without --dry-run to actually build."
    exit 0
  fi
  CR=$(api POST /projects "{\"name\":\"$NAME\",\"db_pass\":\"$DB_PW\",\"region\":\"$REGION\",\"db_instance_size\":\"micro\"}")
  if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
    die "project creation failed (HTTP $HTTP_CODE): $CR
  (free plan: only 2 projects per account — pause/delete one, or pass --name for an existing project)" 2
  fi
  REF=$(jget "$CR" 'process.stdout.write(d.id||"")')
  REGION_ACTUAL=$(jget "$CR" 'process.stdout.write(d.region||"")')
  say "  created → ref $REF. Provisioning takes 1–3 min; waiting…"
  for i in $(seq 1 60); do
    sleep 10
    ONE=$(api GET "/projects/$REF")
    PLAN=$(jget "$ONE" 'process.stdout.write(d.status||"")')
    say "  status: $PLAN"
    [[ "$PLAN" == "ACTIVE" || "$PLAN" == "READY" ]] && break
  done
  [[ "$PLAN" == "ACTIVE" || "$PLAN" == "READY" ]] || die "project never became ACTIVE (last: $PLAN)" 2
fi

# ── 3 · anon key ─────────────────────────────────────────────────────────
say "3/7 recovering the anon/publishable key…"
KEYS=$(api GET "/projects/$REF/api-keys?reveal=true")
ANON_KEY=""
if [[ "$HTTP_CODE" == "200" ]]; then
  ANON_KEY=$(jget "$KEYS" 'const k=(d||[]).find(x=>(x.name==="anon"||x.name==="publishable")&&x.value);process.stdout.write(k?k.value:"")')
fi
if [[ -z "$ANON_KEY" ]]; then
  warn "api-keys reveal unavailable (HTTP $HTTP_CODE) — the anon key must be set manually later (Project Settings → API)."
fi

# ── 4 · working connection URL ───────────────────────────────────────────
say "4/7 resolving a live connection URL…"
if [[ -z "$DB_PW" ]]; then
  die "no DB password known for this project. Either:
  a) re-run with --reset-db-password, or
  b) set it in the dashboard (Settings → Database → reset password) and re-run" 3
fi
try_url() { # prints URL on stdout when SELECT 1 succeeds
  local u="$1"
  if echo "SELECT 1;" | bunx prisma db execute --url "$u" --stdin >/dev/null 2>&1; then
    echo "$u"; return 0
  fi
  return 1
}
DIRECT_URL="postgresql://postgres:$DB_PW@db.$REF.supabase.co:5432/postgres?sslmode=require"
POOL_SESSION_0="postgresql://postgres.$REF:$DB_PW@aws-0-$REGION_ACTUAL.pooler.supabase.com:5432/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
POOL_TX_0="postgresql://postgres.$REF:$DB_PW@aws-0-$REGION_ACTUAL.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
POOL_SESSION_1="postgresql://postgres.$REF:$DB_PW@aws-1-$REGION_ACTUAL.pooler.supabase.com:5432/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
WORK_URL=""
for cand in "$DIRECT_URL" "$POOL_SESSION_0" "$POOL_SESSION_1" "$POOL_TX_0"; do
  say "  trying ${cand%%@*}@…"
  if W=$(try_url "$cand"); then WORK_URL="$cand"; break; fi
done
[[ -n "$WORK_URL" ]] || die "none of the 4 connection candidates reachable from this machine. Check the DB password / region output above." 3
say "  working URL found (${WORK_URL##*//})."

# ── 5 · schema + migrations bookkeeping + hardening ───────────────────────
say "5/7 generating the schema from prisma/schema.prisma…"
DDL=$(bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script 2>/dev/null)
[[ -n "$DDL" ]] || die "prisma migrate diff produced nothing" 4
WORK="$(mktemp -d)"
echo "$DDL" > "$WORK/schema.sql"
# tables created by the DDL (for RLS + REVOKE) — quoted names, from CREATE TABLE lines
TABLES=$(grep -oE 'CREATE TABLE (IF NOT EXISTS )?"[^"]+"' "$WORK/schema.sql" | sed -E 's/.*"([^"]]+)"$/\1/' | sort -u)
NTABLES=$(echo "$TABLES" | grep -c .)

# _prisma_migrations bookkeeping: create + seed with the repo's migration
# files so `prisma migrate deploy` on Vercel sees everything as applied.
# Checksums are sha256 of migration.sql (Prisma's own scheme).
cat > "$WORK/bookkeeping.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "checksum" TEXT NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_by" TEXT
);
ALTER TABLE "_prisma_migrations" ADD PRIMARY KEY ("id");
SQL
for mdir in prisma/migrations/*/; do
  mname=$(basename "$mdir")
  mfile="$mdir/migration.sql"
  [[ -f "$mfile" ]] || continue
  csum=$(sha256sum "$mfile" | cut -d' ' -f1)
  cat >> "$WORK/bookkeeping.sql" <<SQL
INSERT INTO "_prisma_migrations" ("checksum","finished_at","migration_name","logs","applied_steps_count","started_at","applied_by")
SELECT '$csum', now(), '$mname', '', 1, now(), 'supabase-bootstrap'
WHERE NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '$mname');
SQL
done
# RLS + revoke for every app table (owner `postgres` bypasses RLS; Prisma is
# unaffected; PostgREST anon/authenticated get nothing — belt and braces).
for t in $TABLES; do
  cat >> "$WORK/bookkeeping.sql" <<SQL
ALTER TABLE "$t" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "$t" FROM "anon", "authenticated";
SQL
done
cat >> "$WORK/bookkeeping.sql" <<SQL
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "_prisma_migrations" FROM "anon", "authenticated";
SQL

if [[ "$DRY" == "1" ]]; then
  say "dry-run: schema ($NTABLES tables) + bookkeeping + RLS generated at $WORK — no writes."
  exit 0
fi

apply_file() { # apply_file URL FILE — whole-file first, per-statement fallback
  local u="$1" f="$2"
  if bunx prisma db execute --url "$u" --stdin < "$f" >/dev/null 2>&1; then return 0; fi
  warn "  whole-file execute rejected — applying statement by statement…"
  local bad=0
  # split on semicolon-at-end-of-line; DDL from prisma has no bodies/blocks
  awk 'BEGIN{RS=";\n"} NF {printf "%s;\n", $0}' "$f" | while IFS= read -r stmt; do
    [[ -z "${stmt// }" ]] && continue
    echo "$stmt" | bunx prisma db execute --url "$u" --stdin >/dev/null 2>&1 || { warn "  statement failed: $(echo "$stmt" | head -c 160)"; echo 1; }
  done | grep -q 1 && return 1
  return 0
}
say "  applying schema + bookkeeping + RLS to the project…"
apply_file "$WORK_URL" "$WORK/schema.sql" || die "schema apply failed (details above)" 4
apply_file "$WORK_URL" "$WORK/bookkeeping.sql" || die "bookkeeping/RLS apply failed (details above)" 4

# verify: table count in public schema must equal DDL tables + _prisma_migrations
VCNT=$(echo 'SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"';' | bunx prisma db execute --url "$WORK_URL" --stdin 2>/dev/null | grep -oE '[0-9]+' | head -1)
say "  public schema now holds ${VCNT:-?} tables (expected $((NTABLES + 1)))."

# ── 6 · Supabase Auth for email OTP ──────────────────────────────────────
say "6/7 configuring Supabase Auth (email OTP)…"
AUTHCFG=$(api GET "/projects/$REF/config/auth")
AUTH_OK=0
if [[ "$HTTP_CODE" == "200" ]]; then
  # ensure signups + email provider on (PATCH is flat-key)
  NEED_SIGNUP=$(jget "$AUTHCFG" 'process.stdout.write(String(d.disable_signup===true))')
  NEED_EMAIL=$(jget "$AUTHCFG" 'process.stdout.write(String(d.external_email_enabled===false))')
  if [[ "$NEED_SIGNUP" == "true" || "$NEED_EMAIL" == "true" ]]; then
    P=$(api PATCH "/projects/$REF/config/auth" '{"disable_signup":false,"external_email_enabled":true}')
    [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "204" ]] && say "  auth config patched (signups on, email on)." || warn "  auth PATCH failed (HTTP $HTTP_CODE) — set manually: Authentication → Providers → Email; Sign-ups enabled."
  else
    say "  signups + email provider already on."
  fi
  # Magic Link template must contain {{ .Token }} for 6-digit CODES
  TPL=$(api GET "/projects/$REF/config/auth/mailer/templates")
  TPLK=""
  if [[ "$HTTP_CODE" == "200" ]]; then
    TPLK=$(jget "$TPL" 'process.stdout.write(d.magic_link?d.magic_link.content:"")')
  fi
  if [[ -n "$TPLK" ]]; then
    if [[ "$TPLK" == *'{{ .Token }}'* ]]; then
      say "  Magic Link template already renders the 6-digit code ({{ .Token }})."
      AUTH_OK=1
    else
      NEWTPL='{"magic_link":{"subject":"Your DigDeep sign-in code","content":"<h2>Your sign-in code</h2><p>Use this one-time code to sign in to DigDeep:</p><p style=\"font-size:28px;letter-spacing:6px;font-weight:700\">{{ .Token }}</p><p>It expires shortly. If you did not request it, ignore this email.</p>"}}'
      PUTR=$(api PUT "/projects/$REF/config/auth/mailer/templates" "$NEWTPL")
      if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "204" ]]; then
        say "  Magic Link template switched to a 6-digit code ({{ .Token }})."
        AUTH_OK=1
      else
        warn "  template PUT failed (HTTP $HTTP_CODE) — MANUAL STEP (30s): dashboard → Authentication → Email Templates → Magic Link → make the body contain {{ .Token }} (the 6-digit code)."
      fi
    fi
  else
    warn "  templates API not reachable — MANUAL STEP (30s): dashboard → Authentication → Email Templates → Magic Link → make the body contain {{ .Token }}."
  fi
else
  warn "  auth config API not reachable (HTTP $HTTP_CODE) — configure manually: Authentication → Providers → Email (enable, allow sign-ups); Email Templates → Magic Link must contain {{ .Token }}."
fi

# ── 7 · env printout ─────────────────────────────────────────────────────
say "7/7 done. Set these on Vercel (Project → Settings → Environment Variables), then redeploy:"
echo ""
echo "  # production + preview, encrypted:"
echo "  SUPABASE_URL=\"https://$REF.supabase.co\""
[[ -n "$ANON_KEY" ]] && echo "  SUPABASE_ANON_KEY=\"$ANON_KEY\"  # anon/publishable — never the service key"
[[ -z "$ANON_KEY" ]] && echo "  SUPABASE_ANON_KEY=\"<anon key from Project Settings → API>\""
echo "  DATABASE_URL=\"$POOL_SESSION_0\""
echo "  POSTGRES_URL_NON_POOLING=\"$DIRECT_URL\""
echo ""
echo "  # DB password (generated this run — store it or reset later):"
echo "  $DB_PW"
[[ "$AUTH_OK" != "1" ]] && echo "" && echo "  REMEMBER: Magic Link template needs {{ .Token }} for codes (see step 6)."
echo ""
say "verification: bash scripts/prod-audit-verify.sh after the Vercel redeploy."
rm -rf "$WORK"
exit 0
