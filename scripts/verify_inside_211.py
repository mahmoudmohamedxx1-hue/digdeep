#!/usr/bin/env python3
"""v2.1.1 verification: maze strictly INSIDE the D — census the mark rect
(from DOM geometry), the border ring, and the outside band; zoom crop."""
import sys

from PIL import Image

A = "/home/z/my-project/download/verification/v2.1.1-inside-d-a.png"
B = "/home/z/my-project/download/verification/v2.1.1-inside-d-b.png"

# DOM-measured geometry (agent-browser eval): mark 93,37 28x28; canvas 95,39 25x25
MX, MY, MS = 93, 37, 28

a = Image.open(A).convert("RGB")
b = Image.open(B).convert("RGB")
pa, pb = a.load(), b.load()


def mazeish(r, g, bl):
    if r > 90 and bl > 90 and g < r * 0.75 and g < bl * 0.75:  # magenta/violet
        return True
    if g > 140 and bl > 140 and r < g * 0.6:  # bright cyan
        return True
    return False


def tealish(r, g, bl):
    # primary family: light #0f766e (15,118,110), dark #2dd4bf (45,212,191)
    return g > r + 40 and bl > r + 30 and g > 60 and not mazeish(r, g, bl)


def census(p, x0, x1, y0, y1):
    tot = black = maze = teal = light = 0
    for y in range(max(0, y0), min(900, y1 + 1)):
        for x in range(max(0, x0), min(1440, x1 + 1)):
            r, g, bl = p[x, y]
            tot += 1
            if max(r, g, bl) < 32: black += 1
            elif mazeish(r, g, bl): maze += 1
            elif tealish(r, g, bl): teal += 1
            elif min(r, g, bl) > 200: light += 1
    return tot, black, maze, teal, light


print("== the mark (D silhouette zone) ==")
tot, black, maze, teal, light = census(pa, MX, MX + MS - 1, MY, MY + MS - 1)
print(f"mark rect {MS}x{MS}: black {100*black/tot:.1f}%  maze {100*maze/tot:.1f}%  teal {100*teal/tot:.1f}%  light-bg {100*light/tot:.1f}%  other {100*(tot-black-maze-teal-light)/tot:.1f}%")

# split mark into border ring (outer 2px frame of the rect) vs interior
ring = census(pa, MX, MX + MS - 1, MY, MY + MS - 1)
inner = census(pa, MX + 3, MX + MS - 4, MY + 3, MY + MS - 4)
rt, rb, rm, rtl, rl = ring
it, ib, im, itl, il = inner
print(f"ring (outer 3px frame): tot {rt-it}  black {100*(rb-ib)/max(1,rt-it):.0f}%  maze {100*(rm-im)/max(1,rt-it):.0f}%  teal {100*(rtl-itl)/max(1,rt-it):.0f}%  light {100*(rl-il)/max(1,rt-it):.0f}%")
print(f"interior (22x22):       tot {it}  black {100*ib/it:.0f}%  maze {100*im/it:.0f}%  teal {100*itl/it:.0f}%  light {100*il/it:.0f}%  other {100*(it-ib-im-itl-il)/it:.0f}%")

print("\n== OUTSIDE the D (should be page background — no maze, no black chip) ==")
# band around the mark, excluding the mark itself and the wordmark gap zone
ox0, ox1, oy0, oy1 = MX - 10, MX + MS + 9, MY - 10, MY + MS + 9
tot, black, maze, teal, light = census(pa, ox0, ox1, oy0, oy1)
innert, ib2, im2, itl2, il2 = census(pa, MX, MX + MS - 1, MY, MY + MS - 1)
ot = tot - innert
print(f"band ±10px: tot {ot}  black {100*(black-ib2)/max(1,ot):.1f}%  maze {100*(maze-im2)/max(1,ot):.1f}%  teal {100*(teal-itl2)/max(1,ot):.1f}%  light-bg {100*(light-il2)/max(1,ot):.1f}%")

print("\n== animation (inter-frame change inside mark) ==")
ch = 0
for y in range(MY, MY + MS):
    for x in range(MX, MX + MS):
        p1, p2 = pa[x, y], pb[x, y]
        if abs(p1[0] - p2[0]) + abs(p1[1] - p2[1]) + abs(p1[2] - p2[2]) > 25: ch += 1
print(f"changed px: {ch}/{MS*MS} ({100*ch/(MS*MS):.1f}%)")

# zoom crop for eyeballing
crop = a.crop((MX - 6, MY - 6, MX + MS + 6, MY + MS + 6))
crop.resize((crop.width * 14, crop.height * 14), Image.NEAREST).save(
    "/home/z/my-project/download/verification/v2.1.1-mark-zoom.png")
cropb = b.crop((MX - 6, MY - 6, MX + MS + 6, MY + MS + 6))
cropb.resize((cropb.width * 14, cropb.height * 14), Image.NEAREST).save(
    "/home/z/my-project/download/verification/v2.1.1-mark-zoom-b.png")
print("zoom saved: v2.1.1-mark-zoom.png / -b.png")
