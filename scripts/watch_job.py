#!/usr/bin/env python3
"""Watch a research run: poll the job, print new activity events, finish with stats."""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:3000"
JOB = sys.argv[1]
LAST = int(sys.argv[2]) if len(sys.argv) > 2 else 0

def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=30) as r:
        return json.load(r)

job = get(f"/api/research/{JOB}")
events = job.get("events", [])
since = LAST
new = [e for e in events if e["seq"] > since]
for e in new:
    tag = e.get("type", "?")
    title = (e.get("title") or "")[:110]
    detail = (e.get("detail") or "").replace("\n", " ")[:110]
    print(f"[{e['seq']:>3}] {tag:<11} {title}")
    if detail:
        print(f"     {'':<11} {detail}")
    since = e["seq"]
st = job.get("status")
print(f"-- status={st} progress={job.get('progress')}% stage={job.get('stage')!r} events={len(events)}")
if st in ("completed", "failed", "cancelled"):
    stats = job.get("stats")
    if stats:
        print("STATS:", json.dumps({k: stats.get(k) for k in ("byModel", "llmCalls", "sourcesConsulted", "reportWords", "sections", "durationMs")}, indent=1))
    print("LAST SEQ:", since)
