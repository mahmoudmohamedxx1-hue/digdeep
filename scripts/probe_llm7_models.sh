#!/usr/bin/env bash
# Probe LLM7 keyless candidates + usage-based behavior + GLM-5.3-Flash retry.
set -u
probe() {
  local model="$1"; local tag="$2"
  echo "--- $model ($tag) ---"
  timeout 60 curl -s -X POST https://api.llm7.io/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"In one sentence: what does IFRS 9 require about forward-looking information in ECL?\"}],\"max_tokens\":120}" \
    | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  if 'error' in d: print('ERROR:', d['error'].get('message','')[:120], '| code:', d['error'].get('code'))
  else:
    c=d.get('choices',[{}])[0].get('message',{}).get('content','')
    m=d.get('model','?'); u=d.get('usage',{})
    print(f'OK model={m} chars={len(c)} | {c[:180].replace(chr(10),\" \")}')
except Exception as e: print('PARSE FAIL:', str(e)[:80])"
}
probe "GLM-5.3-Flash" "retry busy check"
probe "DeepSeek-V4-Flash-0731" "keyless turbo"
probe "kimi-k2.6" "keyless pro"
probe "minimax-m2.7" "keyless turbo"
probe "nemotron-3-nano:30b" "keyless 1M-ctx"
probe "DeepSeek-V4.1-Flash" "usage-based - expect fail?"
probe "gpt-5.6-luna" "usage-based - expect fail?"
