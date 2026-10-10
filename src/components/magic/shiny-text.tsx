"use client";

/**
 * ShinyText — the 21st.dev "Text Shimmer" pattern: a soft band of light
 * sweeping through otherwise-muted text. The band is tinted with the brand
 * violet so the line feels alive without shouting. Pure CSS (see globals.css).
 */
export function ShinyText({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`text-shimmer ${className}`}>{children}</span>;
}
