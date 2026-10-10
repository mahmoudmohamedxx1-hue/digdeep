"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * The classic decode/decrypt text effect (ReactBits "Text Scramble" family),
 * tuned quiet: one reveal lane, settled characters stay settled. Reduced
 * -motion users see plain text.
 */
const GLYPHS = "!<>-_\\/[]{}—=+*^?#________";
const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

/**
 * useScramble — animates into `target` whenever it changes: every frame,
 * characters past their settle time are real, the rest are random glyphs.
 * Single rAF, self-terminating, never re-runs for the same string.
 */
function useScramble(target: string, { charDelay = 26, startDelay = 0 }: { charDelay?: number; startDelay?: number } = {}) {
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    // reduced-motion callers render static text and never mount this effect's work
    if (reduce) return;
    let raf = 0;
    let t0 = -1;
    const total = startDelay + target.length * charDelay + 260;
    const tick = (t: number) => {
      if (t0 < 0) t0 = t;
      const el = t - t0;
      if (el >= total) {
        setDisplay(target);
        return;
      }
      let out = "";
      for (let i = 0; i < target.length; i++) {
        const ch = target[i];
        if (ch === " " || ch === "\n") {
          out += ch;
          continue;
        }
        out += el >= startDelay + i * charDelay ? ch : pick();
      }
      setDisplay(out);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, reduce, charDelay, startDelay]);

  return display;
}

/**
 * ScrambleText — decodes `children` (a plain string) on mount and whenever
 * the string changes (switching threads re-decodes the new title). The
 * screen-reader text is always the clean string.
 */
export function ScrambleText({
  children,
  className = "",
  charDelay = 26,
  startDelay = 0,
}: {
  children: string;
  className?: string;
  charDelay?: number;
  startDelay?: number;
}) {
  const reduce = useReducedMotion();
  const display = useScramble(children, { charDelay, startDelay });

  if (reduce) return <span className={className}>{children}</span>;
  return (
    <span className={cn("scramble", className)}>
      <span className="sr-only">{children}</span>
      <span aria-hidden>{display}</span>
    </span>
  );
}

/**
 * RotatingText — cycles through phrases, decoding each one in: the
 * ReactBits RotatingText pattern. Used for the composer's idle placeholder
 * so the empty state keeps demonstrating what the box can do. Reduced-motion
 * users see the first phrase, static.
 */
export function RotatingText({
  phrases,
  intervalMs = 3600,
  charDelay = 16,
  className = "",
}: {
  phrases: string[];
  /** total time a phrase stays decoded before the next one decodes in */
  intervalMs?: number;
  /** ms per character of the decode-in */
  charDelay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [idx, setIdx] = useState(0);
  const display = useScramble(phrases[idx] ?? "", { charDelay });

  useEffect(() => {
    if (reduce || phrases.length <= 1) return undefined;
    const iv = setInterval(() => setIdx((i) => (i + 1) % phrases.length), intervalMs);
    return () => clearInterval(iv);
  }, [reduce, phrases.length, intervalMs]);

  return <span className={className}>{reduce ? phrases[0] : display}</span>;
}
