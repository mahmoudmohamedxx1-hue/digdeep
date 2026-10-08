"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * Particles — a CSS-free canvas "star dust" field (ReactBits Particles
 * pattern, redrawn for digdeep's iris palette): tiny violet/blue motes
 * drifting slowly upward, gently twinkling. The field pauses when scrolled
 * out of view, re-seeds on theme change (light/dark palettes), and renders
 * nothing at all for reduced-motion users.
 */
interface Mote {
  x: number;
  y: number;
  r: number;
  baseA: number;
  tw: number;
  twSpeed: number;
  vy: number;
  swayAmp: number;
  phase: number;
  phaseSpeed: number;
  hue: 0 | 1; // 0 = iris, 1 = sky
}

export function Particles({
  className = "",
  /** px² of canvas per mote (lower = denser) */
  density = 9200,
  max = 96,
}: {
  className?: string;
  density?: number;
  max?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let inView = true;
    let alive = true;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let dark = document.documentElement.classList.contains("dark");
    const motes: Mote[] = [];

    const seed = () => {
      motes.length = 0;
      const area = Math.max(1, W * H);
      const n = Math.min(max, Math.max(24, Math.round(area / density)));
      for (let i = 0; i < n; i++) {
        motes.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: 0.7 + Math.random() * 1.3,
          baseA: 0.22 + Math.random() * 0.5,
          tw: Math.random() * Math.PI * 2,
          twSpeed: 0.008 + Math.random() * 0.02,
          vy: -(0.05 + Math.random() * 0.16),
          swayAmp: 0.12 + Math.random() * 0.3,
          phase: Math.random() * Math.PI * 2,
          phaseSpeed: 0.003 + Math.random() * 0.006,
          hue: Math.random() < 0.68 ? 0 : 1,
        });
      }
    };

    const resize = () => {
      const r = cvs.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      cvs.width = Math.round(W * dpr);
      cvs.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const frame = () => {
      if (!alive) return;
      if (inView) {
        ctx.clearRect(0, 0, W, H);
        for (const m of motes) {
          m.tw += m.twSpeed;
          m.phase += m.phaseSpeed;
          m.x += Math.sin(m.phase) * m.swayAmp;
          m.y += m.vy;
          if (m.y < -6) {
            m.y = H + 6;
            m.x = Math.random() * W;
          }
          if (m.x < -8) m.x = W + 8;
          else if (m.x > W + 8) m.x = -8;
          const a = m.baseA * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(m.tw)));
          ctx.beginPath();
          ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
          ctx.fillStyle =
            m.hue === 0
              ? dark
                ? `rgba(167, 139, 250, ${a.toFixed(3)})`
                : `rgba(124, 58, 237, ${(a * 0.9).toFixed(3)})`
              : `rgba(100, 167, 255, ${(a * 0.85).toFixed(3)})`;
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    };

    resize();
    raf = requestAnimationFrame(frame);

    const onResize = () => {
      resize();
    };
    const io = new IntersectionObserver(
      (es) => {
        inView = es[0]?.isIntersecting ?? true;
      },
      { rootMargin: "80px" }
    );
    io.observe(cvs);
    // re-seed when the theme flips (palette swap without a canvas rebuild)
    const themeObs = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains("dark");
      if (nowDark !== dark) {
        dark = nowDark;
        seed();
      }
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      themeObs.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [reduce, density, max]);

  if (reduce) return null;
  return <canvas ref={ref} aria-hidden className={cn("pointer-events-none block", className)} />;
}
