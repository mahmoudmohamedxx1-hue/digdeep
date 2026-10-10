#!/usr/bin/env python3
"""Generate public/brand/mark-silhouette.png from mark-mask.png.

The emblem mask is line-art: the whale/D body is solid but has internal
transparent details (eye, fin seams, throat pleats). For the v2.1.1 mark the
D itself must be the container — a border following the OUTER contour and a
stage filling the whole interior — so we need the outer silhouette with all
internal holes filled. Holes are found by flood-filling the transparent
region from the image border: any transparent pixel NOT reachable from
outside is an enclosed hole -> filled.
"""
from collections import deque

import numpy as np
from PIL import Image

SRC = "/home/z/my-project/public/brand/mark-mask.png"
DST = "/home/z/my-project/public/brand/mark-silhouette.png"

im = Image.open(SRC)
print("source mode:", im.mode, "size:", im.size)
rgba = np.array(im.convert("RGBA"))
a = rgba[:, :, 3] > 128  # solid mask
h, w = a.shape

# BFS from every border pixel that is transparent -> the true outside
outside = np.zeros((h, w), dtype=bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if not a[y, x] and not outside[y, x]:
            outside[y, x] = True
            q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if not a[y, x] and not outside[y, x]:
            outside[y, x] = True
            q.append((y, x))
while q:
    y, x = q.popleft()
    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
        if 0 <= ny < h and 0 <= nx < w and not a[ny, nx] and not outside[ny, nx]:
            outside[ny, nx] = True
            q.append((ny, nx))

sil = a | ~outside  # solid + enclosed holes filled
filled = int((sil & ~a).sum())
print(f"solid px: {int(a.sum())}  hole px filled: {filled}  silhouette px: {int(sil.sum())}")

# connected components of the ORIGINAL solid mask (sanity: any detached bits?)
lbl = np.zeros((h, w), dtype=np.int32)
cur = 0
for sy in range(h):
    for sx in range(w):
        if a[sy, sx] and lbl[sy, sx] == 0:
            cur += 1
            q = deque([(sy, sx)])
            lbl[sy, sx] = cur
            while q:
                y, x = q.popleft()
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and a[ny, nx] and lbl[ny, nx] == 0:
                        lbl[ny, nx] = cur
                        q.append((ny, nx))
sizes = sorted((int((lbl == i).sum()) for i in range(1, cur + 1)), reverse=True)
print(f"components: {cur}  sizes: {sizes[:6]}{' ...' if len(sizes) > 6 else ''}")

out = np.zeros((h, w, 4), dtype=np.uint8)
out[:, :, :3] = 255  # white RGB; only alpha matters for the CSS mask
out[:, :, 3] = np.where(sil, 255, 0)
Image.fromarray(out, "RGBA").save(DST)
print("wrote", DST)

# ASCII check of the silhouette
gy = gx = 42
cell = np.zeros((gy, gx))
for i in range(gy):
    for j in range(gx):
        y0, y1 = i * h // gy, (i + 1) * h // gy
        x0, x1 = j * w // gx, (j + 1) * w // gx
        cell[i, j] = sil[y0:y1, x0:x1].mean()
for r in range(0, gy, 2):
    print("".join("█" if cell[r, c] > .6 and cell[r + 1, c] > .6 else
                  ("▀" if cell[r, c] > .6 else
                   ("▄" if cell[r + 1, c] > .6 else
                    ("·" if cell[r, c] + cell[r + 1, c] > .3 else " ")))
                  for c in range(gx)))
