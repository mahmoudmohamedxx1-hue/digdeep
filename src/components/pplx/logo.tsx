"use client";

/** Apple-style app-icon mark for DigDeep — system-blue gradient, 22% corner radius,
 *  white "deep dig" N path (descending, then rising: dig deep, come back with answers). */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`${className} shrink-0`} aria-hidden="true">
      <defs>
        <linearGradient id="digdeep-lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5AC8FA" />
          <stop offset="0.5" stopColor="#0A84FF" />
          <stop offset="1" stopColor="#0055D7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill="url(#digdeep-lg)" />
      <path d="M10.5 22.5v-13L21.5 22.5v-13" stroke="#fff" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
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
