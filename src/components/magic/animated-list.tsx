"use client";

import { motion, useReducedMotion } from "framer-motion";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * StaggerIn — the ReactBits AnimatedList entrance pattern as a wrapper:
 * items rise/fade in with a small index-based stagger. Animate-on-mount only
 * (re-renders do not re-trigger), capped so long lists stay snappy.
 */
export function StaggerIn({
  children,
  index = 0,
  enterDelay = 0,
  y = 10,
  scale = 0.98,
  className = "",
}: {
  children: React.ReactNode;
  index?: number;
  /** base delay (seconds) before item 0 starts */
  enterDelay?: number;
  y?: number;
  scale?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y, scale }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, delay: enterDelay + Math.min(index * 0.045, 0.4), ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/**
 * FadeIn — the same motion as StaggerIn but with no index logic: one element
 * materializing the moment it appears (streaming timeline rows, fresh sources).
 */
export function FadeIn({
  children,
  delay = 0,
  y = 6,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}
