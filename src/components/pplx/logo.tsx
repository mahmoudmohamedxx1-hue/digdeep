"use client";

/**
 * App mark for DigDeep — the user's emblem repainted in the exact teal of the
 * "Deep" wordmark. The artwork is applied as an alpha MASK over a var(--primary)
 * fill (scripts/teal_brand.py re-crisped its alpha), so:
 *   - the mark and the wordmark's "Deep" are the same paint in every theme;
 *   - it reads SOLID — the old mid-alpha smear that made it look
 *     semi-transparent is gone;
 *   - the 64-frame webp still drives the animation (the mask is the image).
 * prefers-reduced-motion swaps the animation for the static mark.
 */

import { useEffect, useState } from "react";

function maskStyle(src: string) {
  return {
    maskImage: `url("${src}")`,
    WebkitMaskImage: `url("${src}")`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  } as const;
}

/** Animated brand emblem — the logo only, nothing else, in Deep teal. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);

  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 select-none bg-primary ${className}`}
      style={maskStyle(reduced ? "/brand/mark-mask.png" : "/brand/logo-mask.webp")}
    />
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
