"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import type { SourceItem } from "@/components/research/types";

function Favicon({ domain, className = "h-4 w-4" }: { domain: string; className?: string }) {
  const [err, setErr] = useState(false);
  if (err || !domain) return <Globe className={`${className} text-muted-foreground`} />;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      className={`${className} rounded-sm`}
      onError={() => setErr(true)}
    />
  );
}

export function SourcesRow({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="fade-up">
      <div className="mb-2 flex items-center gap-2 px-0.5">
        <span className="text-[13px] font-semibold">Sources</span>
        <span className="rounded-lg bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">{sources.length}</span>
      </div>
      <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {sources.map((s, i) => (
          <a
            key={s.id}
            href={s.url.startsWith("attachment://") ? undefined : s.url}
            target={s.url.startsWith("attachment://") ? undefined : "_blank"}
            rel="noreferrer"
            className="hover-lift group flex w-[176px] shrink-0 flex-col gap-1.5 rounded-[16px] border border-input bg-card p-3"
            title={s.title}
          >
            <div className="flex items-center gap-1.5">
              <Favicon domain={s.domain} />
              <span className="truncate text-[11px] text-muted-foreground">{s.domain}</span>
              <span className="ml-auto rounded-md bg-muted px-1 text-[10px] font-medium text-muted-foreground">{i + 1}</span>
            </div>
            <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-foreground/90 group-hover:text-foreground">{s.title}</p>
          </a>
        ))}
      </div>
    </div>
  );
}

export function SourcesPanel({ sources }: { sources: SourceItem[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="space-y-2">
      {sources.map((s, i) => (
        <a
          key={s.id}
          id={`ref-${i + 1}`}
          href={s.url.startsWith("attachment://") ? undefined : s.url}
          target={s.url.startsWith("attachment://") ? undefined : "_blank"}
          rel="noreferrer"
          className="hover-lift group flex gap-2.5 rounded-[16px] border border-input bg-card p-3"
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[11px] font-semibold text-primary">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[13px] font-medium leading-snug">{s.title}</span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Favicon domain={s.domain} className="h-3.5 w-3.5" />
              {s.domain}
              {s.words > 0 && <span className="opacity-60">· {s.words.toLocaleString()} words read</span>}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}
