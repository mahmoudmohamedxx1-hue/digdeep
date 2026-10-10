#!/usr/bin/env python3
"""
teal_brand.py — v2.0.5 brand pass.

The animated emblem ships as silver/periwinkle artwork with ~38% of its painted
pixels at mid alpha — which is why it has read as "semi-transparent" on both
canvases. This pass rebuilds every brand asset around ONE color: the Deep teal
of the wordmark ("Deep" = var(--primary) = #0f766e light / #2dd4bf dark).

Outputs (all overwrite in place):
  public/brand/logo-mask.webp  — the animation SMOOTHED: every source frame is
                                 recolored white + alpha CRISPED (smoothstep
                                 72→144), then 2 cross-fade in-betweens are
                                 inserted per gap (Image.blend of the processed
                                 frames — blending before the crisp would
                                 collapse every in-between to solid, since a
                                 2:1 mix of 255/0 is 170 and crisp saturates
                                 at 144). The gap list is CYCLIC, so the loop
                                 seam (last→first) is bridged too. Every frame
                                 gets an EXPLICIT duration — the source webp
                                 carries 0ms on all 64 frames (the old
                                 .get("duration", 80) returned the key present
                                 as 0, never the fallback), so browsers paced
                                 the loop by decode speed: the stutter this
                                 pass fixes. Used as a CSS mask, so paint color
                                 comes from var(--primary): pixel-identical to
                                 the "Deep" text in both themes, animation-driven.
                                 K=2, 27ms → 3n frames, ~37fps, 3n×27ms loop.
  public/brand/mark-mask.png   — static reduced-motion mask, same treatment.
  public/brand/mark-favicon.png— solid #2dd4bf emblem (crisped alpha) at 110px,
                                 composited by favicon.ts onto its dark badge.
  public/brand/mark-badge.png  — 256px dark rounded badge + teal emblem (toast
                                 icon in job-signals, same family as the tab).
  src/app/icon.png             — 64px idle tab icon: the same badge geometry as
                                 favicon.ts drawIcon (r=14 @64, emblem 58 @3) so
                                 idle / working / done read as one icon.

The crisp curve: a < 72 → 0 (gaps), a > 144 → 255 (solid), between → smoothstep.
Kills the mid-alpha smear while keeping true gaps and anti-aliased edges.
"""

from PIL import Image, ImageDraw
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRAND = os.path.join(ROOT, "public", "brand")

# Deep teal — the dark-mode "Deep" (wordmark) color; used on dark badges only.
TEAL = (45, 212, 191)  # #2dd4bf


def crisp(alpha: int) -> int:
    """smoothstep(72, 144) on an 8-bit alpha value."""
    if alpha <= 72:
        return 0
    if alpha >= 144:
        return 255
    t = (alpha - 72) / 72.0
    return round(t * t * (3 - 2 * t) * 255)


def recolor_frame(im: Image.Image, rgb: tuple) -> Image.Image:
    """Keep geometry (alpha), replace paint (rgb), crisp the alpha."""
    src = im.convert("RGBA")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    sp, op = src.getdata(), out.load()
    for y in range(src.size[1]):
        for x in range(src.size[0]):
            r, g, b, a = sp[y * src.size[0] + x]
            ca = crisp(a)
            if ca:
                op[x, y] = (rgb[0], rgb[1], rgb[2], ca)
    return out


def save_webp_animation(frames: list, durations: list, path: str):
    head, *rest = frames
    head.save(
        path, "WEBP", save_all=True, append_images=rest,
        duration=durations, loop=0, lossless=True, method=6,
    )


# Smoothness knobs: K in-betweens per gap (K+1 frames per source step),
# FRAME_MS per output frame. K=2/27ms → 37fps; K=1/40ms → 25fps (half file).
K, FRAME_MS = 2, 27


def build_masks():
    # --- animated mask: process each source frame, then cross-fade upsample ---
    anim = Image.open(os.path.join(BRAND, "logo-anim.webp"))
    n = getattr(anim, "n_frames", 1)
    done = []
    for i in range(n):
        anim.seek(i)
        done.append(recolor_frame(anim, (255, 255, 255)))

    seq = []
    for i in range(n):
        a, b = done[i], done[(i + 1) % n]  # cyclic: bridges the loop seam
        seq.append(a)
        for t in range(1, K + 1):
            seq.append(Image.blend(a, b, t / (K + 1)))

    durations = [FRAME_MS] * len(seq)
    save_webp_animation(seq, durations, os.path.join(BRAND, "logo-mask.webp"))
    print(f"logo-mask.webp: {len(seq)} frames ({n} source ×{K + 1}) "
          f"@ {done[0].size}, {1000 / FRAME_MS:.0f}fps, "
          f"loop {sum(durations) / 1000:.2f}s")

    # --- static mask (reduced-motion + favicon-style reuse) ---
    mark = Image.open(os.path.join(BRAND, "mark.png"))
    recolor_frame(mark, (255, 255, 255)).save(
        os.path.join(BRAND, "mark-mask.png"))
    print(f"mark-mask.png: {mark.size}")


def teal_emblem(size: int) -> Image.Image:
    """The static mark recolored solid teal, resized to `size`."""
    mark = Image.open(os.path.join(BRAND, "mark.png"))
    return recolor_frame(mark, TEAL).resize((size, size), Image.LANCZOS)


def build_favicon_mark():
    out = teal_emblem(110)
    out.save(os.path.join(BRAND, "mark-favicon.png"))
    print("mark-favicon.png: 110px solid teal (crisped)")


def badge_with_emblem(size: int) -> Image.Image:
    """Dark rounded badge + teal emblem at 58/64 (≈90.6%), inset 3/64 —
    exactly the favicon.ts geometry, at any resolution."""
    badge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    r = round(size * 0.22)
    top, bot = (0x2A, 0x29, 0x30), (0x1B, 0x1A, 0x1F)
    for y in range(1, size - 1):
        t = (y - 1) / max(size - 3, 1)
        c = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3))
        d.line([(1, y), (size - 2, y)], fill=c + (255,))
    clip = Image.new("L", (size, size), 0)
    ImageDraw.Draw(clip).rounded_rectangle([1, 1, size - 2, size - 2], radius=r, fill=255)
    flat = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    badge.putalpha(clip)
    # emblem: 58/64 of the badge, offset 3/64
    es = round(size * 58 / 64)
    off = round(size * 3 / 64)
    badge.alpha_composite(teal_emblem(es), (off, off))
    return badge


def main():
    build_masks()
    build_favicon_mark()
    p = os.path.join(BRAND, "mark-badge.png")
    badge_with_emblem(256).save(p)
    print("mark-badge.png: 256px dark badge + teal emblem")
    p = os.path.join(ROOT, "src", "app", "icon.png")
    badge_with_emblem(64).save(p)
    print("src/app/icon.png: 64px idle tab icon (teal)")


if __name__ == "__main__":
    main()
