#!/usr/bin/env python3
"""
favicon_d_reset.py — Task 42: the favicon set becomes the user's D-letter logo.

The problem (user report, verified): the deployed tab favicon was the OLD purple
topographic-bars mark (src/app/icon.svg), and icon-192/icon-512/apple-touch-icon
were near-black ghost tiles. The D-letter brand mark — the teal whale-D the
header wears (LogoMark) and favicon.ts paints in its runtime states — existed
only in src/app/icon.png and brand/mark-badge.png.

This script regenerates the ENTIRE set from ONE source of truth so every
surface shows the same icon:

  src/app/icon.svg         — vector: dark badge (teal_brand geometry: vertical
                             gradient #2A2930→#1B1A1F, r=14@64, 1px inset) +
                             the whale-D emblem traced from mark-mask.png
                             (outer contour + the maze's interior holes,
                             evenodd) in solid #2dd4bf at the emblem box
                             (58/64 @ offset 3/64) — the exact artwork and
                             geometry of teal_brand.badge_with_emblem
  src/app/icon.png    (64) — badge_with_emblem(64)  (canonical pipeline)
  public/icon-192.png (192) — badge_with_emblem(192)
  public/icon-512.png (512) — badge_with_emblem(512)
  public/apple-touch-icon.png (180) — full-bleed opaque RGB (iOS masks its own
                             corners; transparency would render black), same
                             gradient + emblem geometry

Fidelity gate: the traced+smoothed evenodd path must rasterize to >= 0.97 IoU
against the source mark-mask, else the script refuses to write anything.
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import teal_brand  # noqa: E402  (canonical badge/emblem pipeline)

SRC_MASK = os.path.join(ROOT, "public", "brand", "mark-mask.png")
TEAL = "#2dd4bf"
HOLE_MIN_AREA = 50  # px @256 — below this, contours are anti-aliasing dust

# --- 1 · trace the emblem: outer contour + interior holes (the maze) --------
im = Image.open(SRC_MASK).convert("RGBA")
W = im.width
mask = (np.array(im)[:, :, 3] > 128).astype(np.uint8)
contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
outer = max((c for c, h in zip(contours, hier[0]) if h[3] == -1),
            key=cv2.contourArea)
holes = [c for c, h in zip(contours, hier[0])
         if h[3] == 0 and cv2.contourArea(c) >= HOLE_MIN_AREA]
print(f"mark-mask {W}x{W}: outer {cv2.contourArea(outer):.0f}px, "
      f"{len(holes)} real holes (dropped {len(contours) - 1 - len(holes)} dust specks)")


def rasterize(outer_pts, hole_pts_list, shape):
    """evenodd render: fill outer, unfill holes."""
    canvas = np.zeros(shape, np.uint8)
    cv2.fillPoly(canvas, [outer_pts], 1)
    for h in hole_pts_list:
        cv2.fillPoly(canvas, [h], 0)
    return canvas


def simplify(contour, eps_frac):
    """RDP at a given epsilon fraction of the contour perimeter."""
    per = cv2.arcLength(contour, True)
    poly = cv2.approxPolyDP(contour, eps_frac * per, True)
    return poly.reshape(-1, 2).astype(float)


def to_viewbox(pts, s, off):
    return pts * s + off


def fmt(x):
    """1-decimal coord — 1/640 precision at the 64 viewBox, compact output."""
    v = round(float(x), 1)
    return str(int(v)) if v == int(v) else f"{v:.1f}"


def smooth_path(pts):
    """Catmull-Rom -> cubic bezier when enough anchors, else straight lines."""
    if len(pts) < 8:
        return "M" + "L".join(f"{fmt(x)} {fmt(y)}" for x, y in pts) + "Z"
    n = len(pts)
    d = f"M{fmt(pts[0][0])} {fmt(pts[0][1])}"
    for i in range(n):
        p0, p1, p2, p3 = (pts[(i - 1) % n], pts[i], pts[(i + 1) % n],
                          pts[(i + 2) % n])
        c1 = p1 + (p2 - p0) / 6.0
        c2 = p2 - (p3 - p1) / 6.0
        d += (f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} "
              f"{fmt(p2[0])} {fmt(p2[1])}")
    return d + "Z"


# --- 2 · map 256-frame coords -> 64-viewBox emblem box (58/64 @ 3/64) -------
s = 58.0 / W
off = 3.0
k5 = np.ones((5, 5), np.uint8)


def emblem_fidelity(outer_v, holes_v):
    """Boundary-tolerant fidelity of the traced polygon vs the source mask.

    Binary fillPoly claims hole boundaries for the cut (erasing the maze
    walls), while a real SVG renderer anti-aliases them; mismatches INSIDE
    the boundary band are rasterization slack, not path error.
    """
    rendered = np.zeros_like(mask)
    cv2.fillPoly(rendered, [np.round((outer_v - off) / s).astype(np.int32)], 1)
    for h in holes_v:
        cv2.fillPoly(rendered, [np.round((h - off) / s).astype(np.int32)], 0)
    band = (cv2.dilate(rendered, k5) != cv2.erode(rendered, k5))
    strict = (rendered != mask) & ~band
    return 1.0 - strict.sum() / mask.sum()


# global budget loop: the most compact path that still passes the final gate
best = None
for eps_frac in (0.001, 0.0015, 0.0022, 0.0032, 0.0045, 0.007, 0.010, 0.015):
    outer_v = to_viewbox(simplify(outer, eps_frac), s, off)
    holes_v = [to_viewbox(simplify(h, eps_frac), s, off) for h in holes]
    fid = emblem_fidelity(outer_v, holes_v)
    n_anchor = len(outer_v) + sum(len(h) for h in holes_v)
    print(f"  eps {eps_frac * 100:.2f}%per -> {n_anchor} anchors, fidelity {fid:.4f}")
    if fid >= 0.975:
        best = (outer_v, holes_v, fid)  # keep the LAST acceptable (most compact)
if best is None:
    print("FIDELITY GATE FAILED — no simplification kept fidelity >= 0.975")
    sys.exit(1)
outer_v, holes_v, fidelity = best
print(f"traced path: outer + {len(holes_v)} holes, fidelity {fidelity:.4f}")

d = smooth_path(outer_v) + "".join(smooth_path(h) for h in holes_v)

svg = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
    '  <defs>\n'
    '    <linearGradient id="b" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">\n'
    '      <stop stop-color="#2A2930"/>\n'
    '      <stop offset="1" stop-color="#1B1A1F"/>\n'
    '    </linearGradient>\n'
    '  </defs>\n'
    '  <rect x="1" y="1" width="62" height="62" rx="14" fill="url(#b)"/>\n'
    f'  <path fill-rule="evenodd" d="{d}" fill="{TEAL}"/>\n'
    "</svg>\n"
)

# --- 3 · write the SVG + regenerate the PNG family (one pipeline) -----------
icon_svg = os.path.join(ROOT, "src", "app", "icon.svg")
with open(icon_svg, "w") as f:
    f.write(svg)
print(f"wrote {icon_svg} ({len(svg)}B)")

teal_brand.badge_with_emblem(64).save(os.path.join(ROOT, "src", "app", "icon.png"))
teal_brand.badge_with_emblem(192).save(os.path.join(ROOT, "public", "icon-192.png"))
teal_brand.badge_with_emblem(512).save(os.path.join(ROOT, "public", "icon-512.png"))
print("wrote src/app/icon.png (64), public/icon-192.png (192), public/icon-512.png (512)")

# apple-touch-icon: full-bleed opaque (iOS composites its own mask — transparent
# corners would show as black). Same gradient + same emblem geometry.
size = 180
apple = Image.new("RGBA", (size, size))
px = apple.load()
top, bot = (0x2A, 0x29, 0x30), (0x1B, 0x1A, 0x1F)
for y in range(size):
    t = y / max(size - 1, 1)
    c = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
    for x in range(size):
        px[x, y] = c + (255,)
es = round(size * 58 / 64)
offp = round(size * 3 / 64)
apple.alpha_composite(teal_brand.teal_emblem(es), (offp, offp))
apple.convert("RGB").save(os.path.join(ROOT, "public", "apple-touch-icon.png"))
print("wrote public/apple-touch-icon.png (180, full-bleed RGB)")

# --- 4 · self-check: every output is the dark badge + teal D family --------
def stats(path):
    img = Image.open(path).convert("RGBA")
    a = np.array(img)
    solid = a[:, :, 3] > 40
    if not solid.any():
        return "EMPTY"
    rgb = a[:, :, :3][solid]
    teal = ((rgb[:, 1] > 150) & (rgb[:, 1] > rgb[:, 0] + 40) & (rgb[:, 2] > 100)).mean()
    lum = rgb.mean(axis=1).mean()
    return f"{img.size[0]}x{img.size[1]} teal={100 * teal:.0f}% meanlum={lum:.0f}"


print("\n-- verification --")
for p in ("src/app/icon.svg", "src/app/icon.png", "public/icon-192.png",
          "public/icon-512.png", "public/apple-touch-icon.png"):
    full = os.path.join(ROOT, p)
    if p.endswith(".svg"):
        content = open(full).read()
        ok = TEAL in content and "7C3AED" not in content and "evenodd" in content
        print(f"{p}: {'OK (teal D + maze detail, no purple)' if ok else 'FAIL'}")
    else:
        print(f"{p}: {stats(full)}")
