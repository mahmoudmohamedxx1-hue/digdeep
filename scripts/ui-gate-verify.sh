#!/usr/bin/env bash
# UI verification of the v3.6 chat sign-in gate, in one invocation (the
# sandbox reaps daemons between tool calls, so server + browser live here).
# NOTE: the home composer's accessible name ROTATES with its placeholder
# stream — always target the textarea by CSS, never by label.
set -u
cd /home/z/my-project
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/digdeep"
export PORT=3213
BASE="http://127.0.0.1:3213"

node .next/standalone/server.js > /tmp/ui-server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; agent-browser close >/dev/null 2>&1' EXIT
for i in $(seq 1 40); do curl -sS -m 2 -o /dev/null "$BASE/api/auth" 2>/dev/null && break; sleep 0.5; done

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
EMAIL="ui-gate-$RANDOM@test.local"

echo "── 1 · signed-out home shows the sign-in prompt ──"
agent-browser open "$BASE/" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 1
BANNER=$(agent-browser get text "body" 2>/dev/null | rg -c "Chatting needs a free account" || true)
[[ "$BANNER" == "1" ]] && ok "banner visible: 'Chatting needs a free account — sign in with an email code'" || bad "banner not found on signed-out home"

echo "── 2 · submitting while signed out routes to /account?next ──"
agent-browser find first "textarea" fill "What is the wingspan of a wandering albatross?" >/dev/null 2>&1
agent-browser press Enter >/dev/null 2>&1
agent-browser wait --url "account?next" --timeout 8000 >/dev/null 2>&1
URL=$(agent-browser get url 2>/dev/null)
echo "$URL" | grep -q "/account?next=%2F" && ok "redirected to /account?next=%2F (draft page)" || bad "URL after submit: $URL (want /account?next=%2F)"

echo "── 3 · register through the UI → bounced back to / ──"
agent-browser find text "Create one" click >/dev/null 2>&1
sleep 0.8
agent-browser find role textbox fill --name "you@example.com" "$EMAIL" >/dev/null 2>&1
agent-browser find role textbox fill --name "Password (8+ characters)" "ui-gate-pass-123" >/dev/null 2>&1
agent-browser find role button click --name "Create account" >/dev/null 2>&1
# poll the URL directly (wait --url pattern-matching proved flaky for the
# bare "/" target — the app redirect itself is fine, the harness wasn't)
URL=""
for i in $(seq 1 30); do
  U=$(agent-browser get url 2>/dev/null || true)
  case "$U" in "$BASE"|"$BASE/") URL="$U"; break;; esac
  sleep 0.5
done
[ -z "$URL" ] && URL=$(agent-browser get url 2>/dev/null)
[[ "$URL" == "$BASE/" || "$URL" == "$BASE" ]] && ok "bounced back to / after sign-in (next round-trip)" || bad "URL after register: $URL (want /)"
SESSION=$(agent-browser eval "fetch('/api/auth').then(r=>r.json()).then(d=>d.user?d.user.email:'ANON')" 2>/dev/null | tr -d '"')
[[ "$SESSION" == "$EMAIL" ]] && ok "session live ($SESSION)" || bad "session after register: $SESSION"
BODY=$(agent-browser get text "body" 2>/dev/null)
echo "$BODY" | rg -q "Chatting needs a free account" && bad "banner still visible after sign-in" || ok "banner gone after sign-in (session recognized)"

echo "── 4 · signed-in chat works end-to-end from the UI ──"
agent-browser find first "textarea" fill "How tall is the Eiffel Tower?" >/dev/null 2>&1
agent-browser press Enter >/dev/null 2>&1
agent-browser wait --url "/r/" --timeout 10000 >/dev/null 2>&1
URL=$(agent-browser get url 2>/dev/null)
echo "$URL" | grep -q "/r/" && ok "navigated to a thread (run started — gate open for accounts)" || bad "URL after chat submit: $URL (want /r/…)"

echo "── 5 · signed-out thread page shows the follow-up prompt ──"
agent-browser cookies clear >/dev/null 2>&1
agent-browser open "$URL" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 2.5
BODY=$(agent-browser get text "body" 2>/dev/null)
echo "$BODY" | rg -q "Sign in to send messages" && ok "thread page shows 'Sign in to send messages' prompt" || bad "thread prompt missing"
ERRS=$(agent-browser errors 2>/dev/null | rg -c . || true)
[[ -z "$ERRS" || "$ERRS" == "0" ]] && ok "zero page errors" || echo "  (page errors: $ERRS)"

echo
echo "UI VERIFICATION: $PASS passed, $FAIL failed"
