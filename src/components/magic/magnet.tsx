"use client";

import { motion, useReducedMotion, useSpring } from "framer-motion";
import { useEffect, useRef } from "react";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Magnet — the ReactBits Magnet micro-interaction, tuned subtle:
 * the wrapped element leans up to `maxPull` px toward the cursor when it is
 * within `pad` px of its bounds, and springs back on leave. Disabled on touch
 * devices (no hover) and for reduced-motion users.
 */
export function Magnet({
  children,
  className = "",
  strength = 0.24,
  maxPull = 4,
  pad = 28,
}: {
  children: React.ReactNode;
  className?: string;
  /** fraction of the cursor offset applied as pull */
  strength?: number;
  /** maximum displacement in px */
  maxPull?: number;
  /** activation padding around the element bounds in px */
  pad?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useSpring(0, { stiffness: 260, damping: 16, mass: 0.35 });
  const y = useSpring(0, { stiffness: 260, damping: 16, mass: 0.35 });
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return undefined;
    if (!window.matchMedia?.("(hover: hover)").matches) return undefined;

    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const within = Math.abs(dx) < r.width / 2 + pad && Math.abs(dy) < r.height / 2 + pad;
      if (within) {
        x.set(clamp(dx * strength, -maxPull, maxPull));
        y.set(clamp(dy * strength, -maxPull, maxPull));
      } else {
        x.set(0);
        y.set(0);
      }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [reduce, strength, maxPull, pad, x, y]);

  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div ref={ref} style={{ x, y }} className={className}>
      {children}
    </motion.div>
  );
}
