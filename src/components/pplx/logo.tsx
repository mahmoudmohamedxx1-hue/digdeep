"use client";

/**
 * App mark for DigDeep — the user's neon maze INSIDE the D.
 *
 * The mark's only shape is the D itself (the whale emblem, outer contour
 * verbatim, internal detail closed — public/brand/mark-silhouette.png):
 *
 *   ┌ the D border — the silhouette painted var(--primary), the same paint
 *   │ as the "Deep" wordmark in every theme
 *   └ the D interior — a black stage carrying the maze, clipped INSIDE the
 *     silhouette by the same mask. Nothing exists outside the D.
 *
 * The animation is the maze the user gave — the verbatim 21st.dev "Neon Maze"
 * algorithm (muntazirzaidi), decoded from the component's published sandbox
 * bundle (cdn.21st.dev/bundled/1638.html):
 *
 *   - isometric cube field; cell = min(w,h) / adaptive divisor — the divisor
 *     runs 6 at mark sizes up to 15 (the reference's fullscreen density), so
 *     the cubes stay legible instead of sub-pixel dust; wave, palette,
 *     strokes, veil and speed are the reference verbatim
 *   - cube lift  Z = cell · (1 − dist/maxDist) · |sin(dist·0.5 + phase)|
 *     → the neon waves ripple out from the D's center and break against its
 *     border
 *   - fill: per-cube linear gradient, cyan rgba(0,255,255,.8) → magenta
 *     rgba(255,0,255,.8); rim stroke yellow rgba(255,255,0,.5); wall strokes
 *     white rgba(255,255,255,.3)
 *   - ghost trails: rgba(0,0,0,.1) veil each frame on the black stage
 *   - phase += 0.05 per frame (reference speed)
 *
 * The maze canvas sits at inset-6% of the mark; the border layer beneath it
 * is the same silhouette at full size — the exposed ring is the D's border.
 * Before hydration (and with JS off) the canvas is empty, so the mark reads
 * as the solid teal D. The only additions are invisible plumbing: DPR
 * scaling, ResizeObserver, offscreen pause, and prefers-reduced-motion
 * rendering ONE static frame.
 */

import { useEffect, useRef } from "react";

/** The D as a closed silhouette (outer contour of the emblem, holes filled). */
const D_MASK = "/brand/mark-silhouette.png";

function maskStyle(src: string) {
  return {
    maskImage: `url("${src}")`,
    WebkitMaskImage: `url("${src}")`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  } as const;
}

/** Animated brand emblem — the neon maze inside the D's border. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = canvasRef.current;
    if (!wrap || !cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const STATIC_PHASE = 2.2; // mid-wave moment: visible rings when still

    let W = 0;
    let H = 0;
    let raf = 0;
    let running = false;
    let visible = true;
    let phase = 0;

    /** One reference draw pass — verbatim wave, palette & strokes. */
    const draw = () => {
      // Cell density adapts to the mark size: the reference's min/15 divisor
      // assumes a ~600px+ stage — at logo scale it degenerates to sub-pixel
      // dust where the 1px rim strokes swamp the faces entirely. The divisor
      // scales from 6 (small marks: ~6 legible cubes across the D) up to 15
      // (the exact reference density at large stages). Everything else — the
      // |sin| wave, gradient faces, rim/wall colors, veil, speed — is exact.
      const div = Math.min(15, Math.max(6, Math.floor(Math.min(W, H) / 12)));
      const m = Math.min(W, H) / div; // cell size
      // Stroke weight follows the cell (the reference's 1px on 40-60px cells
      // is ~2%; at 4px cells 1px would be 25% — a yellow wash).
      ctx.lineWidth = Math.max(0.5, Math.min(1, m / 10));
      const R = Math.ceil(W / m) * 2; // grid half-extent, iso-x
      const O = Math.ceil(H / (m * 0.5)) * 2; // grid half-extent, iso-y
      const E = W / 2; // center x — the waves' origin, the D's heart
      const T = H / 2; // center y

      for (let C = -O; C < O; C++) {
        for (let z = -R; z < R; z++) {
          const D = E + ((z - C) * m) / 2; // iso projection: x
          const $ = T + ((z + C) * m) / 4; // iso projection: y
          if (D > W + m || D < -m || $ > H + m || $ < -2 * m) continue;

          const N = Math.sqrt(z * z + C * C); // grid distance from center
          const V = Math.sqrt(R * R + O * O); // max grid distance
          const G = 1 - N / V; // radial falloff
          const Z = m * G * Math.abs(Math.sin(N * 0.5 + phase)); // wave lift

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

          ctx.beginPath();
          ctx.moveTo(D, $);
          ctx.lineTo(D, $ - Z);
          ctx.moveTo(D + m, $);
          ctx.lineTo(D + m, $ - Z);
          ctx.moveTo(D + m / 2, $ + m / 2);
          ctx.lineTo(D + m / 2, $ - m / 2 - Z);
          ctx.strokeStyle = "rgba(255,255,255,.3)"; // walls — reference
          ctx.stroke();
        }
      }
    };

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // The stage is the canvas's own box (inset-6% inside the mark), not
      // the mark — the border ring must stay maze-free.
      const rect = cv.getBoundingClientRect();
      W = Math.max(1, rect.width);
      H = Math.max(1, rect.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#000"; // the reference stage is black
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
    ro.observe(cv); // the canvas resizes with the mark
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
    <span
      ref={wrapRef}
      aria-hidden="true"
      className={`relative inline-block shrink-0 select-none ${className}`}
    >
      {/* the D border — the emblem silhouette painted var(--primary); the
          exposed ring around the inset stage below is the border itself */}
      <span className="absolute inset-0 bg-primary" style={maskStyle(D_MASK)} />

      {/* the maze — the reference algorithm on its black stage, masked to
          the same silhouette so it lives strictly INSIDE the D's border.
          Explicit w/h because a canvas is a replaced element: inset alone
          would leave it at its intrinsic 300×150 instead of stretching. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-[6%] h-[88%] w-[88%]"
        style={maskStyle(D_MASK)}
      />
    </span>
  );
}

export function LogoWord({ className = "" }: { className?: string }) {
  return (
    <span className={`font-display font-semibold tracking-[-0.022em] ${className}`}>
      Dig<span className="text-primary">Deep</span>
    </span>
  );
}

/** Mark + wordmark as one tight unit — a 6px gap (optically the space inside
 *  a letter) so the pair reads as a single brand object, never two widgets
 *  that happen to sit near each other. Used by every header surface. */
export function LogoLockup({
  markClass = "h-7 w-7",
  textClass = "text-[15px]",
  className = "",
}: {
  markClass?: string;
  textClass?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <LogoMark className={`${markClass} shrink-0`} />
      <LogoWord className={textClass} />
    </span>
  );
}
