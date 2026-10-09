"use client";

/**
 * App mark for DigDeep — the topographic "D" emblem: concentric contour lines
 * narrowing toward a glowing core, animated as a slow breathing loop (the
 * dig that never stops going deeper). Rendered from an optimized animated
 * WebP baked from the brand animation; the static PNG stands in if the
 * animation cannot load. The wordmark keeps "Dig" light and "Deep" violet,
 * matching the brand sheet.
 */

/** Animated brand emblem. Sized by `className` (default matches the old SVG mark). */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <span
      className={`${className} relative inline-block shrink-0 select-none overflow-hidden rounded-[7.5px] bg-[#232227]`}
      aria-hidden="true"
    >
      <img
        src="/brand/logo-anim.webp"
        alt=""
        draggable={false}
        decoding="async"
        className="h-full w-full object-cover"
        onError={(e) => {
          // graceful stand-in if the animation fails to load (ancient browser / corrupt file)
          const img = e.currentTarget;
          img.onerror = null;
          img.src = "/brand/mark.png";
        }}
      />
    </span>
  );
}

export function LogoWord({ className = "" }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-[-0.022em] ${className}`}>
      Dig<span className="text-primary">Deep</span>
    </span>
  );
}
