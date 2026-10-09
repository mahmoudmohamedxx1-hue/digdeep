"use client";

/**
 * App mark for DigDeep — the topographic "D" emblem: concentric contour lines
 * narrowing toward a glowing core, animated as a slow breathing loop (the
 * dig that never stops going deeper). The asset is tight-cropped to the
 * emblem itself on full transparency — nothing but the logo — so it sits
 * directly beside the wordmark on any theme. A soft drop shadow (light mode
 * only) keeps the silver outer lines legible on bright surfaces.
 */

/** Animated brand emblem — the logo only, nothing else. */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <img
      src="/brand/logo-anim.webp"
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
    <span className={`font-semibold tracking-[-0.022em] ${className}`}>
      Dig<span className="text-primary">Deep</span>
    </span>
  );
}
