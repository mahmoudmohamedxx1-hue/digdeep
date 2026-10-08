"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * SpotlightCard — digdeep port of the ReactBits SpotlightCard:
 * a pointer-following light with two layers — a soft radial fill over the
 * surface and a 1px edge glow cut with a mask. The light wakes when the
 * pointer is within `proximity` px of the card, eases in/out, and its
 * position is smoothed in a rAF loop that only runs while the light is live.
 * Reduced-motion users get a plain static card.
 */
export function SpotlightCard({
  children,
  className = "",
  /** spotlight radius in px */
  size = 220,
  /** how close (px) the pointer must be for the light to wake */
  proximity = 56,
}: {
  children: React.ReactNode;
  className?: string;
  size?: number;
  proximity?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;

    const s = { x: 0, y: 0, tx: 0, ty: 0, on: 0, ton: 0 };
    let raf = 0;
    let live = false;

    const loop = () => {
      s.x += (s.tx - s.x) * 0.16;
      s.y += (s.ty - s.y) * 0.16;
      s.on += (s.ton - s.on) * 0.14;
      root.style.setProperty("--mx", `${s.x.toFixed(1)}px`);
      root.style.setProperty("--my", `${s.y.toFixed(1)}px`);
      root.style.setProperty("--spot", s.on.toFixed(3));
      if (s.ton === 0 && s.on < 0.004) {
        live = false;
        root.style.setProperty("--spot", "0");
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      s.tx = x;
      s.ty = y;
      s.ton =
        x > -proximity && x < rect.width + proximity && y > -proximity && y < rect.height + proximity
          ? 1
          : 0;
      if (s.ton > 0 && !live) {
        live = true;
        raf = requestAnimationFrame(loop);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, [proximity]);

  return (
    <div
      ref={rootRef}
      className={cn("spotlight-card", className)}
      style={{ "--spot-size": `${size}px` } as React.CSSProperties}
    >
      <div className="spotlight-fill" aria-hidden />
      <div className="spotlight-edge" aria-hidden />
      {children}
    </div>
  );
}
