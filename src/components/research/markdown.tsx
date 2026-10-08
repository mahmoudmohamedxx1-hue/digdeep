"use client";

import React from "react";

/** Inline markdown: **bold**, *italic*, `code`, [n] citations, [text](url), bare URLs */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re =
    /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`\n]+`))|(\[(\d+)\])|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|((?:https?:\/\/)[^\s)<>,]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${k++}`;
    if (m[2] !== undefined) out.push(<strong key={key} className="font-semibold text-foreground">{m[2]}</strong>);
    else if (m[4] !== undefined) out.push(<em key={key}>{m[4]}</em>);
    else if (m[6] !== undefined) out.push(<code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{m[6]}</code>);
    else if (m[8] !== undefined)
      out.push(
        <sup key={key}>
          <a href={`#ref-${m[8]}`} className="mx-0.5 rounded bg-primary/10 px-1 py-0.5 text-[0.7em] font-medium text-primary no-underline hover:bg-primary/20" title="Jump to reference">
            {m[8]}
          </a>
        </sup>
      );
    else if (m[10] !== undefined)
      out.push(
        <a key={key} href={m[11]} target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
          {m[10]}
        </a>
      );
    else if (m[12] !== undefined)
      out.push(
        <a key={key} href={m[12]} target="_blank" rel="noreferrer" className="break-all text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
          {m[12].replace(/^https?:\/\//, "").slice(0, 60)}
        </a>
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let k = 0;

  const flushList = () => {
    if (!list) return;
    const L = list;
    blocks.push(
      L.ordered ? (
        <ol key={`b${k++}`} className="my-2 list-decimal space-y-1.5 pl-5">
          {L.items.map((it, i) => (
            <li key={i} id={`ref-${i + 1}`} className="leading-relaxed">
              {inline(it, `li${k}-${i}`)}
            </li>
          ))}
        </ol>
      ) : (
        <ul key={`b${k++}`} className="my-2 space-y-1.5 pl-4">
          {L.items.map((it, i) => (
            <li key={i} className="relative leading-relaxed before:absolute before:-left-4 before:text-primary before:content-['•']">
              {inline(it, `ul${k}-${i}`)}
            </li>
          ))}
        </ul>
      )
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      if (code) {
        blocks.push(
          <pre key={`b${k++}`} className="my-3 overflow-x-auto rounded-lg border bg-muted/60 p-3 text-xs leading-relaxed">
            <code>{code.join("\n")}</code>
          </pre>
        );
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ul) {
      if (list?.ordered) flushList();
      if (!list) list = { ordered: false, items: [] };
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      if (list && !list.ordered) flushList();
      if (!list) list = { ordered: true, items: [] };
      list.items.push(ol[2]);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (line.startsWith("### "))
      blocks.push(
        <h3 key={`b${k++}`} className={`font-semibold tracking-tight text-primary ${compact ? "mt-3 mb-1 text-sm" : "mt-6 mb-2 text-lg"}`}>
          {inline(line.slice(4), `h3${k}`)}
        </h3>
      );
    else if (line.startsWith("## "))
      blocks.push(
        <h2 key={`b${k++}`} className={`font-semibold tracking-tight ${compact ? "mt-4 mb-1.5 text-base" : "mt-9 mb-3 border-b pb-2 text-2xl"}`}>
          {inline(line.slice(3), `h2${k}`)}
        </h2>
      );
    else if (line.startsWith("# "))
      blocks.push(
        <h1 key={`b${k++}`} className={`font-bold tracking-tight ${compact ? "text-lg" : "mb-4 text-3xl"}`}>
          {inline(line.slice(2), `h1${k}`)}
        </h1>
      );
    else if (line.trim() === "---")
      blocks.push(<hr key={`b${k++}`} className="my-6 border-border/70" />);
    else if (/^>\s?/.test(line))
      blocks.push(
        <blockquote key={`b${k++}`} className="my-3 rounded-r-md border-l-2 border-primary/50 bg-primary/5 py-2 pl-4 pr-3 text-sm text-muted-foreground">
          {inline(line.replace(/^>\s?/, ""), `q${k}`)}
        </blockquote>
      );
    else
      blocks.push(
        <p key={`b${k++}`} className={`leading-relaxed ${compact ? "text-sm text-muted-foreground" : "my-3"}`}>
          {inline(line, `p${k}`)}
        </p>
      );
  }
  flushList();
  if (code)
    blocks.push(
      <pre key={`b${k++}`} className="my-3 overflow-x-auto rounded-lg border bg-muted/60 p-3 text-xs">
        <code>{code.join("\n")}</code>
      </pre>
    );
  return <div className={compact ? "" : "text-[15px]"}>{blocks}</div>;
}
