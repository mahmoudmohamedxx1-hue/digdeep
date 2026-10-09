"use client";

import { cn } from "@/lib/utils";

/**
 * AuroraHero — CSS port of the ReactBits Aurora background (no WebGL):
 * three drifting, heavily-blurred color fields behind the hero, fading out
 * into the canvas before mid-viewport. GPU-composited transforms only, so it
 * stays smooth while research streams. Reduced-motion is handled globally in
 * globals.css (the drift keyframes are neutralized there).
 */
export function AuroraHero({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      // bleeds 240px beyond the content column on each side so the blurred
      // color fields are never cut by the container edge (the old version had
      // a visible hard clip on the right where the blobs ran past the box)
      className={cn("pointer-events-none absolute inset-x-[-240px] top-0 z-0 h-[min(560px,68dvh)] overflow-hidden", className)}
    >
      <div className="aurora-blob aurora-a" />
      <div className="aurora-blob aurora-b" />
      <div className="aurora-blob aurora-c" />
      <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
