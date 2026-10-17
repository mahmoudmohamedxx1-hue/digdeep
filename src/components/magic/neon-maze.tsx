"use client";

/**
 * NeonMazeD — the DigDeep D inside the REAL 21st.dev "Neon Maze" by
 * muntazirzaidi (https://21st.dev/@muntazirzaidi/components/neon-maze).
 *
 * This is a line-faithful port of the original component, decoded from its
 * published sandbox bundle (cdn.21st.dev/bundled/1638.html). Nothing about
 * the animation is retuned — the algorithm, palette, stroke colors, ghost
 * trails and speed are exactly the reference:
 *
 *   - isometric cube field; cell = min(w,h) / 15
 *   - cube lift  Z = cell · (1 − dist/maxDist) · |sin(dist·0.5 + phase)|
 *     → the radial neon waves ripple out from the center (where the D sits)
 *   - fill: per-cube linear gradient, cyan rgba(0,255,255,.8) → magenta
 *     rgba(255,0,255,.8)
 *   - silhouette stroke: yellow rgba(255,255,0,.5)
 *   - vertical wall strokes: white rgba(255,255,255,.3)
 *   - ghost trails: the whole canvas is veiled with rgba(0,0,0,.1) every
 *     frame, so moving cubes leave neon trails on the black stage
 *   - phase += 0.05 per animation frame (reference speed)
 *
 * The only additions are invisible plumbing: the canvas is sized to its
 * container instead of the window (the reference fills the viewport; the
 * demo sandbox runs it inside a box — same visual), DPR scaling for crisp
 * lines, offscreen cubes are skipped (identical pixels, less work), the
 * loop pauses off-screen, and prefers-reduced-motion renders ONE static
 * frame. The D is the production LogoMark — the same mark, mask and
 * var(--primary) paint as the header — centered in the eye of the maze.
 */

import { useEffect, useRef } from "react";
import { LogoMark } from "@/components/pplx/logo";
import { cn } from "@/lib/utils";

export function NeonMazeD({
  className = "",
  dClass = "h-20 w-20 sm:h-24 sm:w-24",
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
    const STATIC_PHASE = 2.2; // a mid-wave moment: visible rings for the still frame

    let W = 0;
    let H = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    let phase = 0;

    /** One reference draw pass — verbatim geometry & palette. */
    const draw = () => {
      const m = Math.min(W, H) / 15; // reference cell size
      const R = Math.ceil(W / m) * 2; // grid half-extent, iso-x
      const O = Math.ceil(H / (m * 0.5)) * 2; // grid half-extent, iso-y
      const E = W / 2; // center x — the waves' origin
      const T = H / 2; // center y

      for (let C = -O; C < O; C++) {
        for (let z = -R; z < R; z++) {
          const D = E + ((z - C) * m) / 2; // iso projection: x
          const $ = T + ((z + C) * m) / 4; // iso projection: y
          // offscreen skip — the reference draws these too, but they are
          // clipped away; skipping only saves work, pixels are identical
          if (D > W + m || D < -m || $ > H + m || $ < -2 * m) continue;

          const N = Math.sqrt(z * z + C * C); // grid distance from center
          const V = Math.sqrt(R * R + O * O); // max grid distance
          const G = 1 - N / V; // radial falloff
          const Z = m * G * Math.abs(Math.sin(N * 0.5 + phase)); // the wave lift

          // cube silhouette: lifted diamond top collapsing to the ground tile
          ctx.beginPath();
          ctx.moveTo(D, $ - Z);
          ctx.lineTo(D + m / 2, $ - m / 2 - Z);
          ctx.lineTo(D + m, $ - Z);
          ctx.lineTo(D + m, $);
          ctx.lineTo(D + m / 2, $ + m / 2);
          ctx.lineTo(D, $);
          ctx.closePath();

          const P = ctx.createLinearGradient(D, $ - Z, D + m, $);
          P.addColorStop(0, "rgba(0,255,255,.8)"); // cyan — reference face A
          P.addColorStop(1, "rgba(255,0,255,.8)"); // magenta — reference face B
          ctx.fillStyle = P;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,0,.5)"; // yellow rim — reference
          ctx.stroke();

          // vertical walls — the maze's neon rebar (reference)
          ctx.beginPath();
          ctx.moveTo(D, $);
          ctx.lineTo(D, $ - Z);
          ctx.moveTo(D + m, $);
          ctx.lineTo(D + m, $ - Z);
          ctx.moveTo(D + m / 2, $ + m / 2);
          ctx.lineTo(D + m / 2, $ - m / 2 - Z);
          ctx.strokeStyle = "rgba(255,255,255,.3)";
          ctx.stroke();
        }
      }
    };

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // the reference stage is black; trails veil toward black as well
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (reduced) {
        phase = STATIC_PHASE;
        draw();
      }
    };

    /** The reference loop: 10% black veil → draw → phase += 0.05. */
    const loop = () => {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      ctx.fillStyle = "rgba(0,0,0,.1)";
      ctx.fillRect(0, 0, W, H);
      draw();
      phase += 0.05;
    };

    const start = () => {
      if (running || reduced || !visible) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    size();

    const ro = new ResizeObserver(size);
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
    // the reference demo's stage: a black box, the canvas filling it. Sized
    // to the hero column (the sandbox runs the reference inside a box too).
    <div
      ref={wrapRef}
      className={cn(
        "relative h-[300px] w-full overflow-hidden rounded-2xl bg-black sm:h-[360px]",
        className,
      )}
    >
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />

      {/* the D — the production LogoMark (same mask + var(--primary) paint
          as the header), centered in the eye of the maze: the neon waves
          radiate out from it. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <LogoMark className={cn("shrink-0", dClass)} />
      </div>
    </div>
  );
}
