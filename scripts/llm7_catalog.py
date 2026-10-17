#!/usr/bin/env python3
"""Fetch LLM7 full model catalog; print id/tier/pricing/availability/usage_based_only."""
import json
import urllib.request

req = urllib.request.Request("https://api.llm7.io/v1/models")
with urllib.request.urlopen(req, timeout=60) as r:
    data = json.load(r)

models = data.get("data", [])
print(f"total models: {len(models)}\n")
rows = []
for m in models:
    mid = m.get("id", "?")
    if m.get("model_type") not in (None, "chat", ""):
        rows.append((mid, m.get("model_type"), m.get("tier", "?"), "", "", ""))
        continue
    pricing = m.get("pricing") or {}
    ubo = m.get("usage_based_only", False)
    avail = m.get("availability_last_hour_percent")
    ctx = (m.get("context_window") or {}).get("tokens")
    rows.append((mid, "chat", m.get("tier", "?"), f"in {pricing.get('input','?')}", 
                 f"{100*avail:.0f}%" if isinstance(avail, (int, float)) else "?",
                 f"{'KEYLESS' if not ubo else 'usage-based'} · ctx {ctx}"))

for mid, typ, tier, pin, av, extra in sorted(rows, key=lambda x: (x[1] != "chat", x[2] != "turbo", x[0])):
    print(f"{mid:34s} {typ:5s} tier={tier:6s} {pin:12s} avail={av:5s} {extra}")
