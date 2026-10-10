#!/usr/bin/env python3
"""v2.1.0 verification: the LogoMark chip is now the neon maze (animating,
cyan+magenta on black) with the teal D centered."""
from PIL import Image

a = Image.open("/home/z/my-project/download/verification/v2.1.0-mazemark-a.png").convert("RGB")
b = Image.open("/home/z/my-project/download/verification/v2.1.0-mazemark-b.png").convert("RGB")
W, H = a.size
pa, pb = a.load(), b.load()

# locate the chip: near-black pixels in the top-left header area (logo lockup)
xs, ys = [], []
for y in range(0, 160):
    for x in range(0, 400):
        r, g, bl = pa[x, y]
        if max(r, g, bl) < 30:
            xs.append(x); ys.append(y)
if not xs:
    print("NO BLACK CHIP FOUND in header area!"); raise SystemExit(1)
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
w, h = x1 - x0 + 1, y1 - y0 + 1
print(f"chip bbox: x {x0}-{x1}, y {y0}-{y1}  ({w}x{h})")

# 1. maze colors inside the chip: cyan & magenta & black
cyan = magenta = teal_d = black = tot = 0
for y in range(y0, y1 + 1):
    for x in range(x0, x1 + 1):
        r, g, bl = pa[x, y]
        tot += 1
        if max(r, g, bl) < 30: black += 1
        elif g > 110 and bl > 110 and r < g * 0.7: cyan += 1        # maze cyan / D teal share hue
        if r > 110 and bl > 110 and g < r * 0.7: magenta += 1       # maze magenta
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
for y in range(cy - h // 3, cy + h // 3):
    for x in range(cx - w // 3, cx + w // 3):
        r, g, bl = pa[x, y]
        if g > 150 and bl > 130 and r < 110 and g > r + 70: teal_d += 1  # D paint #2dd4bf/#0f766e family
print(f"chip pixel census: black {100*black/tot:.0f}%  cyan-family {100*cyan/tot:.0f}%  magenta {100*magenta/tot:.0f}%")
print(f"D teal pixels in center third: {teal_d}")

# 2. animating? inter-frame diff inside chip
ch = 0
for y in range(y0, y1 + 1):
    for x in range(x0, x1 + 1):
        p, q = pa[x, y], pb[x, y]
        if abs(p[0]-q[0]) + abs(p[1]-q[1]) + abs(p[2]-q[2]) > 25: ch += 1
print(f"chip inter-frame change: {ch}/{tot} px ({100*ch/tot:.1f}%)")

ok = cyan > 5 and magenta > 5 and teal_d > 5 and ch > 10
print("VERDICT:", "PASS — maze animating, D centered" if ok else "FAIL")
