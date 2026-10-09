"use client";

/**
 * DigDeep mark — nested contour rings of the "D".
 *
 * The outer outline is fixed. The inner rings stream inward forever: each
 * ring fades in at the edge, travels toward the core with a slight organic
 * wobble, and fades out as it arrives — where the teal core glow sits. Idle
 * the dig is slow and calm; while research runs it speeds up. Per frame it
 * is 8 small path strings on one shared rAF ticker — no images, no network,
 * nothing to decode (the old animated WebP was 365 KB; this is a few hundred
 * bytes of markup).
 *
 * prefers-reduced-motion: static nested rings, evenly spaced, no loop.
 * The favicon mirrors the same geometry (src/lib/favicon.ts).
 */

import { useEffect, useRef } from "react";
import { activeJobIds } from "@/lib/live-poller";

const RINGS = 8; // inner rings, plus the fixed outer outline
const OUTER = "M22 12 L22 52 A20 20 0 0 1 22 12 Z"; // spine x=22, arc r=20, centered on (32,32)

function ringPath(s: number, dy = 0): string {
  // one contour ring at scale s (1 = the outer outline), dy = wobble offset
  const x = 32 - 10 * s;
  const top = 32 - 20 * s + dy;
  const bot = 32 + 20 * s + dy;
  const r = 20 * s;
  return `M${x.toFixed(2)} ${top.toFixed(2)} L${x.toFixed(2)} ${bot.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x.toFixed(2)} ${top.toFixed(2)} Z`;
}

/** life-position → opacity: fade in at the edge, out at the core. */
function lifeOpacity(p: number): number {
  const fadeIn = Math.min(Math.max((1 - p) / 0.12, 0), 1);
  const fadeOut = Math.min(Math.max(p / 0.16, 0), 1);
  return fadeIn * fadeOut;
}

// ---------- one shared ticker for every LogoMark on the page ----------
type Render = (t: number, rate: number) => void; // t = seconds, rate = cycles/sec
const subs = new Set<Render>();
let raf = 0;
let last = 0;
let rate = 0; // current cycles/sec (eases toward the target — never a jump)
const IDLE_RATE = 1 / 9; // one full inward trip ~9s — the slow idle dig
const WORK_RATE = 1 / 2.8; // ~2.8s while research runs

function tick(now: number) {
  const t = now / 1000;
  const dt = last ? Math.min(0.1, t - last) : 0.016;
  last = t;
  const target = activeJobIds().length > 0 ? WORK_RATE : IDLE_RATE;
  rate += (target - rate) * Math.min(1, dt * 1.6);
  for (const fn of subs) fn(t, rate);
  raf = requestAnimationFrame(tick);
}

function ensureLoop() {
  if (raf || typeof window === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; // static mode only
  last = 0;
  raf = requestAnimationFrame(tick);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  const gRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    const paths = Array.from(g.querySelectorAll<SVGPathElement>(".logo-ring"));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    const layout = (t: number, r: number) => {
      for (let k = 0; k < RINGS; k++) {
        const p = 1 - ((t * r + k / RINGS) % 1); // 1 = edge spawn … 0 = core arrival
        const wob = 1 + 0.01 * Math.sin(t * 1.9 + k * 2.39); // organic wobble
        const dy = 0.4 * Math.sin(t * 1.3 + k * 1.7);
        const s = (0.16 + 0.84 * p) * wob;
        const el = paths[k];
        if (!el) continue;
        el.setAttribute("d", ringPath(s, dy));
        el.setAttribute("opacity", lifeOpacity(p).toFixed(3));
        // deepen to teal as the ring approaches the core (the "Deep" in DigDeep)
        el.setAttribute("stroke", s < 0.45 ? "var(--verify)" : "currentColor");
      }
    };

    const staticLayout = () => {
      for (let k = 0; k < RINGS; k++) {
        const p = 1 - (k + 1) / (RINGS + 1);
        const el = paths[k];
        if (!el) continue;
        el.setAttribute("d", ringPath(0.16 + 0.84 * p));
        el.setAttribute("opacity", lifeOpacity(p).toFixed(3));
        el.setAttribute("stroke", p < 0.3 ? "var(--verify)" : "currentColor");
      }
    };

    const render: Render = (t, r) => layout(t, r);
    if (reduced.matches) staticLayout();
    else {
      subs.add(render);
      ensureLoop();
      layout(0, 0); // paint the first frame immediately (never an empty flash)
    }

    const onMotionChange = () => {
      if (reduced.matches) {
        subs.delete(render);
        stopLoop();
        staticLayout();
      } else {
        subs.add(render);
        ensureLoop();
      }
    };
    reduced.addEventListener("change", onMotionChange);

    return () => {
      subs.delete(render);
      reduced.removeEventListener("change", onMotionChange);
      if (subs.size === 0) stopLoop();
    };
  }, []);

  return (
    <svg
      viewBox="0 0 64 64"
      className={`${className} shrink-0 select-none overflow-visible`}
      role="img"
      aria-label="DigDeep"
      shapeRendering="geometricPrecision"
    >
      {/* fixed outer outline */}
      <path d={OUTER} fill="none" strokeWidth={2.6} className="text-foreground" />
      {/* inner rings — driven imperatively; this group never re-renders */}
      <g ref={gRef} className="text-foreground">
        {Array.from({ length: RINGS }, (_, i) => (
          <path key={i} className="logo-ring" fill="none" strokeWidth={2.1} />
        ))}
      </g>
      {/* core glow */}
      <circle cx="32" cy="32" r="2.8" className="fill-[var(--verify)]" />
    </svg>
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
