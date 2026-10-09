"use client";

import { useEffect, useState } from "react";
import { ListTree } from "lucide-react";

/**
 * The right-rail table of contents — tracks the report's h2 sections with an
 * IntersectionObserver and highlights the one you're reading. Click scrolls
 * smoothly (headings carry scroll-mt so the sticky toolbar never covers them).
 */
export function Toc({ headings }: { headings: { id: string; title: string }[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    const raf = requestAnimationFrame(() => setActive(null));
    const obs = new IntersectionObserver(
      (entries) => {
        // the topmost heading whose band crosses the upper third of the viewport
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: [0, 0.25, 1] }
    );
    els.forEach((el) => obs.observe(el));
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
        <ListTree className="h-3.5 w-3.5" aria-hidden /> On this page
      </p>
      <ul className="space-y-0.5 border-l border-border/70">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              aria-current={active === h.id ? "location" : undefined}
              className={`-ml-px block border-l-2 py-1 pl-3 text-[12px] leading-snug transition-colors ${
                active === h.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="line-clamp-2">{h.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
