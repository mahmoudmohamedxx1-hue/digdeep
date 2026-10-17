#!/usr/bin/env bash
# Live probe: GLM-5.3-Flash via z-ai SDK, via LLM7, and the full LLM7 model list.
set -u
echo "=== 1) z-ai SDK direct: glm-5.3-flash ==="
timeout 90 z-ai chat -m glm-5.3-flash -p "Reply with exactly: OK-5.3" 2>&1 | head -20
echo
echo "=== 2) LLM7: GLM-5.3-Flash ==="
timeout 90 curl -s -X POST https://api.llm7.io/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"Reply with exactly: OK-LLM7"}],"max_tokens":20}' | head -c 1200
echo
echo "=== 3) LLM7 model list ==="
timeout 60 curl -s https://api.llm7.io/v1/models | head -c 4000
echo