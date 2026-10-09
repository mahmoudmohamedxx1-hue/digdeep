"use client";

import { memo, createContext, useContext, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationChip, type CitationContext } from "@/components/research/citation-chip";
import { headingId, type ReportRef } from "@/lib/report-parse";
import { copyText } from "@/lib/utils";
import type { SourceItem } from "@/components/research/types";

/**
 * The reading layer — react-markdown + remark-gfm (correctly nested emphasis,
 * real lists, real tables) instead of the old hand-rolled regex parser.
 *
 * Streaming performance: the text is split into blank-line blocks (code fences
 * kept whole) and each block renders through a memoized component — while the
 * typer streams a long report only the LAST block re-renders, not the whole
 * document. Citation markers `[n]` become hover-card chips; h2s carry anchor
 * ids so the right-rail table of contents can track them.
 *
 * The citation context (sources/refs/audit/checks/selection) travels through a
 * React context, NOT through component props — so the react-markdown component
 * identities stay stable and selecting a claim never remounts the report DOM
 * (which would drop focus and kill hover states mid-read).
 */

const CiteCtx = createContext<CitationContext>({});

/** Convert bare citation markers into internal links the `a` override can style. */
function linkifyCitations(text: string): string {
  return text.replace(/(?<![![])\[(\d+)\](?!\()/g, "[$1](#cite-$1)");
}

function childText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childText).join("");
  if (children && typeof children === "object" && "props" in (children as object)) {
    return childText((children as { props?: { children?: React.ReactNode } }).props?.children);
  }
  return "";
}

/** The `a` override — uppercase so hooks inside are legal (rules-of-hooks). */
function MdLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const m = typeof href === "string" ? href.match(/^#cite-(\d+)$/) : null;
  const ctx = useContext(CiteCtx);
  if (m) return <CitationChip n={Number(m[1])} ctx={ctx} />;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="break-words text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary">
      {children}
    </a>
  );
}

/** Code block with a quiet header — language tag + copy button. The button is
 *  hover-revealed on pointer devices and always visible on touch. */
function CodeBlock({ lang, text, children }: { lang?: string; text: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-4 overflow-hidden rounded-[14px] border border-border/70 bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/60 py-1 pl-3.5 pr-1.5">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80" aria-hidden>
          {lang ?? "code"}
        </span>
        <button
          onClick={async () => {
            if (await copyText(text)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100 max-sm:opacity-100"
          aria-label="Copy code"
          title="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed">{children}</pre>
    </div>
  );
}

/** The one set of markdown components — created a single time. — created a single time. Selection or
 *  context changes flow through CiteCtx, never through new identities. */
const MD_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mb-4 mt-9 text-[24px] font-bold tracking-[-0.022em]">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 id={headingId(childText(children))} className="mt-9 mb-2.5 scroll-mt-24 text-[19.5px] font-semibold tracking-[-0.022em] text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-7 mb-2 text-[16px] font-semibold tracking-[-0.018em] text-foreground">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="mt-6 mb-2 text-[15.5px] font-semibold text-foreground">{children}</h4>
  ),
  p: ({ children }: { children?: React.ReactNode }) => <p className="my-4 leading-[1.68]">{children}</p>,
  a: MdLink,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-[18px] space-y-2">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-[18px] list-decimal space-y-2 pl-[22px] marker:font-medium marker:text-muted-foreground/70">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-[1.7]">{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-4 rounded-r-lg border-l-2 border-primary/40 py-0.5 pl-4 pr-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-8 border-border/60" />,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) return <code className={`${className ?? ""} font-mono text-[12.5px]`}>{children}</code>;
    return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.84em]">{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => {
    // pull the language tag + raw text out of the <code> child for the header
    const codeEl = Array.isArray(children) ? children[0] : children;
    const codeCls =
      codeEl && typeof codeEl === "object" && "props" in (codeEl as object)
        ? String((codeEl as { props?: { className?: unknown } }).props?.className ?? "")
        : "";
    const lang = codeCls.match(/language-([\w+-]+)/)?.[1];
    return (
      <CodeBlock lang={lang} text={childText(children)}>
        {children}
      </CodeBlock>
    );
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-5 overflow-x-auto rounded-[14px] border border-border/70">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead>{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => <tr className="transition-colors hover:bg-muted/30">{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border/70 bg-muted/50 px-3.5 py-2.5 text-left font-semibold tracking-tight">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/40 px-3.5 py-2.5 align-top leading-snug last:border-b-0">{children}</td>
  ),
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} className="my-4 max-h-[420px] rounded-[14px] border border-border/70" loading="lazy" />
  ),
};

/** One memoized markdown block — completed blocks never re-render while streaming. */
const MdBlock = memo(function MdBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS as never}>
      {linkifyCitations(text)}
    </ReactMarkdown>
  );
});

/** Split markdown into blank-line-separated blocks; fenced code stays whole. */
export function splitBlocks(md: string): string[] {
  const lines = md.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      cur.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    cur.push(line);
  }
  if (cur.length) flush();
  return blocks;
}

export function Markdown({
  text,
  compact = false,
  serif = false,
  sources,
  refs,
  audit,
  checks,
  onSelectClaim,
  selectedClaimId,
}: {
  text: string;
  compact?: boolean;
  /** apply the editorial serif reading layer (report bodies) */
  serif?: boolean;
  sources?: SourceItem[];
  refs?: ReportRef[];
  audit?: CitationContext["audit"];
  /** claim ledger — chips with a matching check show its verdict */
  checks?: CitationContext["checks"];
  onSelectClaim?: CitationContext["onSelectClaim"];
  /** id of the currently selected claim (for active chip styling) */
  selectedClaimId?: string;
}) {
  const ctx = useMemo<CitationContext>(
    () => ({ sources, refs, audit, checks, onSelectClaim, selectedCheckId: selectedClaimId }),
    [sources, refs, audit, checks, onSelectClaim, selectedClaimId]
  );
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <CiteCtx.Provider value={ctx}>
      <div
        dir="auto"
        className={
          compact
            ? "text-[14px] text-foreground"
            : serif
              ? "report-prose text-[15px] text-foreground"
              : "text-[15px] text-foreground"
        }
      >
        {blocks.map((b, i) => (
          <MdBlock key={i} text={b} />
        ))}
      </div>
    </CiteCtx.Provider>
  );
}
