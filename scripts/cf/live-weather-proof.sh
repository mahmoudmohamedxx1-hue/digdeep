#!/usr/bin/env bash
# v3.11.1 LIVE PROOF — the operator's exact scenario ("weather in cairo" in
# chat) against the DEPLOYED worker at digdeep.mahmoudmohamedxx1.workers.dev.
# Registers a throwaway account (password path), starts a chat-shaped run,
# polls (each poll drives a continuation slice), then checks the reply for
# real conditions + [n] citations.
set -uo pipefail
BASE="${1:-https://digdeep.mahmoudmohamedxx1.workers.dev}"
RND=$((RANDOM%100000))
EMAIL="live-weather-$RND@test.local"
JAR=$(mktemp)

echo "── register throwaway account ($EMAIL)"
REG=$(curl -s -c "$JAR" -m 30 -X POST "$BASE/api/auth" -H "Content-Type: application/json" \
  -d "{\"action\":\"register\",\"email\":\"$EMAIL\",\"password\":\"live-proof-pw-$RND\"}")
echo "$REG" | grep -q '"user"' && echo "  ✓ registered + session" || { echo "  ✗ register failed: $REG"; exit 1; }

echo "── start the chat run (the operator's exact message shape)"
START=$(curl -s -b "$JAR" -m 60 -X POST "$BASE/api/research" -H "Content-Type: application/json" \
  -d '{"query":"hey, what is the weather in cairo right now?","preset":"quick","threadId":"live-weather-proof","language":"English"}')
JOB=$(echo "$START" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$JOB" ] && echo "  ✓ run started: $JOB" || { echo "  ✗ start failed: $START"; exit 1; }

echo "── poll (each poll drives a continuation slice)"
FINAL=""
for i in $(seq 1 80); do
  sleep 4
  BODY=$(curl -s -b "$JAR" -m 45 "$BASE/api/research/$JOB")
  STATUS=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('job',{}).get('status') or d.get('status') or '')" 2>/dev/null)
  STAGE=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job',{}); print((j.get('stage') or '')[:40])" 2>/dev/null)
  echo "  poll $i: status=$STATUS stage=$STAGE"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then FINAL="$BODY"; break; fi
done

[ -n "$FINAL" ] || { echo "✗ run never completed in the poll window"; exit 1; }

echo "── the reply"
echo "$FINAL" | python3 -c "
import json,sys
d=json.load(sys.stdin); j=d.get('job',{})
md=j.get('reportMd') or ''
stats=j.get('stats') or {}
if isinstance(stats, str):
    import json as _j
    stats=_j.loads(stats)
print('status:', j.get('status'))
print('stats:', {k: stats.get(k) for k in ('mode','sourcesConsulted','throttledFallback')})
evs = d.get('events') or []
print('event feed (last 12):')
for e in evs[-12:]:
    print('  ', e.get('type'), '|', (e.get('title') or '')[:70])
srcs = d.get('sources') or []
print('sources:', [(s.get('n') if 'n' in s else i, s.get('domain')) for i, s in enumerate(srcs)])
print()
print(md[:1200])
print()
ok = j.get('status')=='completed' and '[1]' in md and ('°C' in md or '°F' in md)
print('LIVE PROOF', 'PASS ✓' if ok else 'FAIL ✗')
sys.exit(0 if ok else 1)
"
RC=$?
curl -s -o /dev/null -m 20 -b "$JAR" -X DELETE "$BASE/api/auth" -H "Content-Type: application/json" -d '{"action":"signout"}' 2>/dev/null
exit $RC
