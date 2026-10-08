"use client";

import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * BorderBeam — the 21st.dev "Border Beam" pattern, conic implementation:
 * a comet of light that orbits the host element's rounded ring. Built with
 * the same typed @property --angle technique as the aurora badge, so it
 * animates on the compositor. The ring is masked to a hairline that inherits
 * the host's border-radius — place it inside any `relative` element.
 * Reduced-motion users get nothing (a parked comet would read as an error).
 */
export function BorderBeam({
  className = "",
  /** seconds per lap */
  duration = 6,
  delay = 0,
  reverse = false,
  /** ring thickness in px */
  thickness = 1.5,
}: {
  className?: string;
  duration?: number;
  delay?: number;
  reverse?: boolean;
  thickness?: number;
}) {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return (
    <span
      aria-hidden
      className={cn("border-beam", className)}
      style={
        {
          "--beam-dur": `${duration}s`,
          "--beam-delay": `${delay}s`,
          "--beam-dir": reverse ? "reverse" : "normal",
          "--beam-thickness": `${thickness}px`,
        } as React.CSSProperties
      }
    />
  );
}
