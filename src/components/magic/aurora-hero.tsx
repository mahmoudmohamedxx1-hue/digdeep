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
      className={cn("pointer-events-none absolute inset-x-0 top-0 z-0 h-[520px] overflow-hidden", className)}
    >
      <div className="aurora-blob aurora-a" />
      <div className="aurora-blob aurora-b" />
      <div className="aurora-blob aurora-c" />
      <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
