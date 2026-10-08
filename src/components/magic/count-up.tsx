"use client";

import { useInView, useMotionValue, useSpring } from "framer-motion";
import { useCallback, useEffect, useRef } from "react";

/**
 * CountUp — spring-physics number ticker, ported from ReactBits CountUp.
 * Animates on first view AND on every later change of `to` (so live metrics
 * like streaming source counts tick up as they grow).
 */
export function CountUp({
  to,
  from = 0,
  duration = 1,
  delay = 0,
  decimals = 0,
  suffix = "",
  className = "",
}: {
  to: number;
  from?: number;
  /** seconds the spring settles in (≈ visual duration) */
  duration?: number;
  /** seconds before the count starts */
  delay?: number;
  /** decimal places (0 = integer with grouping) */
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(from);
  const damping = 20 + 40 * (1 / duration);
  const stiffness = 100 * (1 / duration);
  const springValue = useSpring(motionValue, { damping, stiffness });
  const isInView = useInView(ref, { once: true, margin: "0px" });

  const format = useCallback(
    (latest: number) =>
      (decimals > 0 ? latest.toFixed(decimals) : Math.round(latest).toLocaleString("en-US")) + suffix,
    [decimals, suffix]
  );

  useEffect(() => {
    if (ref.current) ref.current.textContent = format(from);
  }, [from, format]);

  useEffect(() => {
    if (!isInView) return;
    const t = setTimeout(() => motionValue.set(to), delay * 1000);
    return () => clearTimeout(t);
  }, [isInView, motionValue, to, delay]);

  useEffect(
    () => springValue.on("change", (v) => {
      if (ref.current) ref.current.textContent = format(v);
    }),
    [springValue, format]
  );

  return (
    <span ref={ref} className={className}>
      {format(from)}
    </span>
  );
}
