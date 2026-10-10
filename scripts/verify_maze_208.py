#!/usr/bin/env python3
"""v2.0.8 pixel verification: the exact reference palette (cyan/magenta/yellow),
the teal D at center, and inter-frame change (animation running)."""
from PIL import Image
import sys

t0 = Image.open("/home/z/my-project/download/verification/v2.0.8-maze-t0.png").convert("RGB")
t2 = Image.open("/home/z/my-project/download/verification/v2.0.8-maze-t2s.png").convert("RGB")
W, H = t0.size
print(f"screenshot {W}x{H}")

# The maze stage: full hero width (max-w-768 centered in 1440 vp), h≈360 css px.
# Content column is centered; sidebar 240px on the left per prior session notes.
# Approximate stage box: center x, y around hero area.
# We'll scan the full screenshot and classify hues; then locate the stage by
# looking for the black rounded panel (rows with many near-black pixels).

px0 = t0.load()
px2 = t2.load()

def classify(p):
    r, g, b = p
    mx, mn = max(p), min(p)
    if mx < 40:
        return "black"
    if mx - mn < 28:
        return "gray/white"
    if g >= r and b >= r and g > 90:  # cyan family (incl. teal D)
        return "cyan/teal"
    if r > 100 and b > 100 and g < r * 0.75:  # magenta family
        return "magenta"
    if r > 100 and g > 100 and b < g * 0.72:  # yellow family
        return "yellow"
    return "other"

from collections import Counter
counts = Counter()
changed = 0
sampled = 0
for y in range(0, H, 2):
    for x in range(0, W, 2):
        p = px0[x, y]
        counts[classify(p)] += 1
        q = px2[x, y]
        sampled += 1
        if abs(p[0]-q[0]) + abs(p[1]-q[1]) + abs(p[2]-q[2]) > 30:
            changed += 1

total = sum(counts.values())
print("hue census (full page, every 2nd px):")
for k, v in counts.most_common():
    print(f"  {k:12s} {v:7d}  {100*v/total:5.1f}%")
print(f"inter-frame changed px: {changed}/{sampled} = {100*changed/sampled:.1f}% (page-wide)")

# Focus: find the stage band (rows where >55% of center-column pixels are near-black)
stage_rows = []
for y in range(0, H, 4):
    dark = sum(1 for x in range(W//4, 3*W//4, 8) if max(px0[x, y]) < 35)
    n = len(range(W//4, 3*W//4, 8))
    if dark / n > 0.55:
        stage_rows.append(y)
if stage_rows:
    y0, y1 = min(stage_rows), max(stage_rows)
    print(f"stage band rows: y={y0}..{y1} (h={y1-y0})")
    # hue census inside stage
    sc = Counter()
    ch = 0
    tot = 0
    for y in range(y0, y1, 2):
        for x in range(W//4, 3*W//4, 2):
            sc[classify(px0[x, y])] += 1
            tot += 1
            q = px2[x, y]
            p = px0[x, y]
            if abs(p[0]-q[0]) + abs(p[1]-q[1]) + abs(p[2]-q[2]) > 30:
                ch += 1
    print("stage hue census:")
    for k, v in sc.most_common():
        print(f"  {k:12s} {v:7d}  {100*v/tot:5.1f}%")
    print(f"stage inter-frame change: {100*ch/tot:.1f}%  (animation running)")
    # the D: teal census near stage center
    cy = (y0 + y1) // 2
    cx = W // 2
    teal = 0
    area = 0
    for y in range(cy - 70, cy + 70, 1):
        for x in range(cx - 70, cx + 70, 1):
            if 0 <= x < W and 0 <= y < H:
                area += 1
                r, g, b = px0[x, y]
                # production teal #2dd4bf = (45,212,191): green dominant, blue high, red low
                if g > 140 and b > 110 and r < 120 and g > r + 60:
                    teal += 1
    print(f"teal D pixels near center: {teal}/{area} ({100*teal/area:.1f}% of 140px box)")
else:
    print("NO STAGE FOUND — black panel not detected!")
    sys.exit(1)
