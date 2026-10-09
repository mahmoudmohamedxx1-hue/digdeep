"use client";

/**
 * App mark for DigDeep — "the dig": three strata that narrow as they go
 * deeper (dig past the surface layer), with a bright core at the bottom —
 * the answer you came back up with. Geometric, ownable, and deliberately
 * nothing like any framework logo.
 */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`${className} shrink-0`} aria-hidden="true">
      <defs>
        <linearGradient id="dd-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#C4B5FD" />
          <stop offset="0.5" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#5B21B6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill="url(#dd-mark)" />
      {/* the strata — each layer shorter, the dig narrowing toward the find */}
      <rect x="8" y="8.5" width="16" height="3.2" rx="1.6" fill="#fff" fillOpacity="0.94" />
      <rect x="8" y="14.4" width="11" height="3.2" rx="1.6" fill="#fff" fillOpacity="0.72" />
      {/* the core — what the dig was for */}
      <circle cx="10.4" cy="23.4" r="2.6" fill="#fff" fillOpacity="0.96" />
    </svg>
  );
}

export function LogoWord({ className = "" }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-[-0.022em] ${className}`}>
      Dig<span className="text-primary">Deep</span>
    </span>
  );
}
