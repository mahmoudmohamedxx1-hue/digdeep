"use client";

import { motion, useReducedMotion, useSpring } from "framer-motion";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Tilt — the ReactBits TiltedCard interaction, tuned way down: the surface
 * leans a few degrees toward the cursor with spring physics and settles
 * back on leave. Disabled on touch (no hover) and for reduced-motion users.
 * Children keep their own layout — wrap any block to make it feel physical.
 */
export function Tilt({
  children,
  className = "",
  /** max lean in degrees */
  max = 6,
  /** perspective distance in px */
  perspective = 900,
}: {
  children: React.ReactNode;
  className?: string;
  max?: number;
  perspective?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const rotateX = useSpring(0, { stiffness: 240, damping: 20, mass: 0.45 });
  const rotateY = useSpring(0, { stiffness: 240, damping: 20, mass: 0.45 });

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return undefined;
    if (!window.matchMedia?.("(hover: hover)").matches) return undefined;

    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / Math.max(1, r.width);
      const py = (e.clientY - r.top) / Math.max(1, r.height);
      rotateY.set((px - 0.5) * 2 * max);
      rotateX.set(-(py - 0.5) * 2 * max);
    };
    const leave = () => {
      rotateX.set(0);
      rotateY.set(0);
    };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [reduce, max, rotateX, rotateY]);

  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      ref={ref}
      className={cn("will-change-transform", className)}
      style={{ rotateX, rotateY, transformPerspective: perspective, transformStyle: "preserve-3d" }}
    >
      {children}
    </motion.div>
  );
}
