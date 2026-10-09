"use client";

/**
 * App mark for DigDeep — the user's topographic "D" emblem (from the
 * uploaded GIF), tight-cropped to the logo alone on full transparency so it
 * sits directly beside the wordmark on any theme. A soft drop shadow (light
 * mode only) keeps the silver outer lines legible on bright surfaces.
 *
 * prefers-reduced-motion swaps the animation for the static mark. The
 * favicon (src/lib/favicon.ts) composites the same emblem onto a dark badge
 * with status dots — working flashes green, done is a fixed blue dot.
 */

import { useEffect, useState } from "react";

/** Animated brand emblem — the logo only, nothing else. */
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
    // eslint-disable-next-line @next/next/no-img-element -- static asset, no optimizer needed
    <img
      src={reduced ? "/brand/mark.png" : "/brand/logo-anim.webp"}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      className={`${className} shrink-0 select-none object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)] dark:drop-shadow-none`}
      onError={(e) => {
        // graceful stand-in if the animation fails to load (ancient browser / corrupt file)
        const img = e.currentTarget;
        img.onerror = null;
        img.src = "/brand/mark.png";
      }}
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
