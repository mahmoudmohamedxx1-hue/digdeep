"use client";

import { motion, useReducedMotion } from "framer-motion";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * SplitText — digdeep port of the ReactBits SplitText / BlurText pattern.
 * Word-staggered entrance: each word rises out of its clip and un-blurs in
 * sequence. Pure framer-motion (no GSAP), mount-triggered (the hero is above
 * the fold), reduced-motion safe, screen-reader safe.
 */
export function SplitText({
  text,
  className = "",
  delay = 0,
  stagger = 60,
  animate = true,
}: {
  text: string;
  className?: string;
  /** base delay in ms before the first word starts */
  delay?: number;
  /** per-word stagger in ms */
  stagger?: number;
  animate?: boolean;
}) {
  const reduce = useReducedMotion();
  if (!animate || reduce) return <span className={className}>{text}</span>;
  const words = text.split(" ");
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      {words.map((w, i) => (
        <span
          key={i}
          aria-hidden
          /* pb/-mb gives descenders (g, y, p) room inside the overflow clip */
          className="inline-block overflow-hidden pb-[0.14em] -mb-[0.14em] align-bottom"
        >
          <motion.span
            className="inline-block will-change-transform"
            initial={{ y: "115%", opacity: 0, filter: "blur(8px)" }}
            animate={{ y: "0%", opacity: 1, filter: "blur(0px)" }}
            transition={{ duration: 0.7, delay: (delay + i * stagger) / 1000, ease: EASE }}
          >
            {w}
            {i < words.length - 1 ? "\u00A0" : ""}
          </motion.span>
        </span>
      ))}
    </span>
  );
}
