"use client";

/**
 * NeonMazeD — the 21st.dev "neon maze" (muntazirzaidi) rebuilt for DigDeep:
 * an isometric field of cubes whose lift follows |sin(0.5·u + t)| rings
 * radiating from the center, each frame veiled 10% so moved cubes leave
 * neon ghost trails. Faithful port of the reference algorithm, retuned:
 *
 *   - trails fade toward TRANSPARENT (destination-out), not black — the
 *     stage floats on the page canvas (paper/charcoal) and over AuroraHero;
 *   - palette is Deep-teal neon (cyan→teal faces, aqua edges) per theme —
 *     one brand color, same family as the "Deep" wordmark and the aurora;
 *   - the maze parts around the logo: cubes near the center have their lift
 *     and paint scaled by a smooth "clearing" falloff, so the D sits in the
 *     eye of the maze instead of fighting it for legibility;
 *   - the D itself is the production LogoMark (mask + var(--primary)) —
 *     pixel-identical to the header mark and still animated, so the logo
 *     lives INSIDE the maze, not printed on top of it.
 *
 * Engine details: DPR-aware sizing, ResizeObserver, IntersectionObserver
 * pause, time-normalized stepping (120Hz screens run the same speed as 60Hz,
 * unlike the reference), and prefers-reduced-motion renders ONE static
 * frame (no loop, no trails).
 */

import { useEffect, useRef } from "react";
import { LogoMark } from "@/components/pplx/logo";
import { cn } from "@/lib/utils";

/** Face gradient ends / edge / wall colors as RGB triplets, per theme. */
const PALETTES = {
  dark: {
    faceA: [34, 211, 238], // cyan-400 — the neon sweep's bright end
    faceB: [45, 212, 191], // teal-400 — "Deep" dark-mode paint
    edge: [153, 246, 228], // teal-200 neon rim on the cube silhouette
    wall: [255, 255, 255], // vertical wall strokes
  },
  light: {
    faceA: [8, 145, 178], // cyan-700
    faceB: [15, 118, 110], // teal-700 — "Deep" light-mode paint
    edge: [13, 148, 136], // teal-600
    wall: [15, 23, 42], // slate-900
  },
} as const;

const rgba = (c: readonly number[], a: number) =>
  `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** smoothstep clamp01 — the clearing falloff around the D. */
const smooth01 = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

function drawMaze(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  pal: typeof PALETTES.dark,
) {
  // Reference geometry: cell = min/15 full-screen was dust at stage size;
  // /10 keeps the cube legible at 768-wide while reading as the same maze.
  const e = Math.min(w, h) / 10;
  const T = 2 * Math.ceil(w / e); // grid half-extent along iso-x
  const L = 2 * Math.ceil(h / (e / 2)); // grid half-extent along iso-y
  const cx = w / 2;
  const cy = h / 2;
  const maxU = Math.hypot(T, L);

  ctx.lineJoin = "round";
  for (let n = -L; n < L; n++) {
    for (let c = -T; c < T; c++) {
      const s = cx + ((c - n) * e) / 2;
      const y = cy + ((c + n) * e) / 4;
      const u = Math.hypot(c, n);
      // The D's clearing: flat + dimmed within ~2 cells, full by ~4.6.
      // VLM audit asked for more figure-ground: near-center cubes now sit at
      // 25% paint so the maze visibly parts around the logo.
      const clear = smooth01((u - 2.0) / 2.6);
      const lift = e * (1 - u / maxU) * Math.abs(Math.sin(0.5 * u + t)) * clear;

      // Cube silhouette: lifted diamond (top face) + ground diamond (shadow
      // seat) — a hexagon when lifted, collapsing to the tile when flat.
      ctx.beginPath();
      ctx.moveTo(s, y - lift);
      ctx.lineTo(s + e / 2, y - e / 2 - lift);
      ctx.lineTo(s + e, y - lift);
      ctx.lineTo(s + e, y);
      ctx.lineTo(s + e / 2, y + e / 2);
      ctx.lineTo(s, y);
      ctx.closePath();

      const a = 0.5 * (0.25 + 0.75 * clear);
      const g = ctx.createLinearGradient(s, y - lift, s + e, y);
      g.addColorStop(0, rgba(pal.faceA, a));
      g.addColorStop(1, rgba(pal.faceB, a));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(pal.edge, 0.5 * (0.35 + 0.65 * clear));
      ctx.stroke();

      // Vertical wall strokes — the maze's neon rebar.
      ctx.beginPath();
      ctx.moveTo(s, y);
      ctx.lineTo(s, y - lift);
      ctx.moveTo(s + e, y);
      ctx.lineTo(s + e, y - lift);
      ctx.moveTo(s + e / 2, y + e / 2);
      ctx.lineTo(s + e / 2, y - e / 2 - lift);
      ctx.strokeStyle = rgba(pal.wall, 0.3 * (0.4 + 0.6 * clear));
      ctx.stroke();
    }
  }
}

export function NeonMazeD({
  className = "",
  dClass = "h-[72px] w-[72px] sm:h-[84px] sm:w-[84px]",
}: {
  className?: string;
  dClass?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDark = () => document.documentElement.classList.contains("dark");

    let W = 0;
    let H = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    let phase = 0;
    let last = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const paintStatic = () => {
      ctx.clearRect(0, 0, W, H);
      drawMaze(ctx, W, H, 2.6, isDark() ? PALETTES.dark : PALETTES.light);
    };

    const frame = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(now - last, 50); // clamp tab-return spikes
      last = now;
      const k = dt / 16.667; // time-normalized: 120Hz == 60Hz speed

      // Ghost trails: fade everything 10%/ref-frame toward transparent.
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.25, Math.max(0.03, 1 - Math.pow(0.9, k)))})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      phase += 0.05 * k;
      drawMaze(ctx, W, H, phase, isDark() ? PALETTES.dark : PALETTES.light);
    };

    const start = () => {
      if (running || reduced || !visible) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    size();
    if (reduced) paintStatic();

    const ro = new ResizeObserver(() => {
      size();
      if (reduced) paintStatic();
    });
    ro.observe(wrap);

    const io = new IntersectionObserver(
      (es) => {
        visible = es.some((e) => e.isIntersecting);
        if (visible) start();
        else stop();
      },
      { threshold: 0.05 },
    );
    io.observe(wrap);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cn(
        // Bleed wider than the content column (root clips overflow-x, so the
        // pan-protection from v2.0.5 is inherited) — the maze reads immersive
        // edge-to-edge like the reference, while the D stays column-centered.
        "relative -mx-5 h-[230px] w-[calc(100%+40px)] overflow-hidden sm:-mx-20 sm:h-[290px] sm:w-[calc(100%+160px)]",
        className,
      )}
    >
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />

      {/* dissolve the maze's outer edges into the page canvas */}
      <div aria-hidden className="maze-vignette absolute inset-0" />

      {/* frosted pane behind the D (VLM v2 audit): blurs the maze lines that
          run through the logo area so the mark floats on clean glass instead
          of sitting on a fence. Sits under the halo so the glow stays lit. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/35 backdrop-blur-[6px] sm:h-48 sm:w-48"
      />

      {/* soft teal wash behind the D — the clearing's glow, theme-following.
          V2: larger + stronger; the first pass read muddy (VLM audit). */}
      <div
        aria-hidden
        className="absolute left-1/2 top-1/2 h-40 w-72 -translate-x-1/2 -translate-y-1/2 rounded-[100%] bg-primary/30 blur-3xl sm:h-48 sm:w-96"
      />

      {/* the D — the production LogoMark: same mask, same var(--primary) paint
          as the header, still animated. It lives INSIDE the maze. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <LogoMark className={cn(dClass, "maze-d-glow")} />
      </div>
    </div>
  );
}
