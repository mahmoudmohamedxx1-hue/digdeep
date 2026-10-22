#!/usr/bin/env python3
"""Parity check: browser-rendered icon.svg vs canonical icon-192.png badge."""
from PIL import Image
import numpy as np

shot = Image.open("/tmp/favcheck/render.png").convert("RGBA")
# the flexbox centers the 192x192 img in the 400x400 viewport — exact crop
icon = shot.crop((104, 104, 296, 296)).resize((192, 192), Image.LANCZOS)

ref = Image.open("/home/z/my-project/public/icon-192.png").convert("RGBA").resize((192, 192), Image.LANCZOS)

ia, ra = np.array(icon).astype(int), np.array(ref).astype(int)
# compare only where both are opaque (badge interior)
both = (ia[:, :, 3] > 200) & (ra[:, :, 3] > 200)
diff = np.abs(ia[:, :, :3] - ra[:, :, :3]).mean(axis=2)
interior_diff = diff[both].mean()
overlap = both.mean()

# teal presence in the SVG render (the D must be teal)
rgb = ia[:, :, :3][ia[:, :, 3] > 40]
teal = ((rgb[:, 1] > 150) & (rgb[:, 1] > rgb[:, 0] + 40) & (rgb[:, 2] > 100)).mean()
print(f"cropped the centered 192x192 icon region from the 400x400 screenshot")
print(f"opaque overlap: {100*overlap:.1f}%  interior mean|diff|: {interior_diff:.1f}/255")
print(f"SVG render teal fraction: {100*teal:.0f}%")
ok = interior_diff < 12 and teal > 0.20 and 0.75 < overlap <= 1.0
print("PARITY:", "PASS — SVG renders as the same D badge" if ok else "CHECK MANUALLY")
icon.save("/tmp/favcheck/svg_render_192.png")
