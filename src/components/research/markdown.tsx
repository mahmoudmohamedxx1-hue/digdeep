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
    else if (m[6] !== undefined) out.push(<code key={key} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.84em]">{m[6]}</code>);
    else if (m[8] !== undefined)
      out.push(
        <sup key={key}>
          <a href={`#ref-${m[8]}`} className="mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/[0.12] px-1 text-[10.5px] font-semibold tabular-nums text-primary no-underline transition-colors hover:bg-primary/25" title="Jump to reference">
            {m[8]}
          </a>
        </sup>
      );
    else if (m[10] !== undefined)
      out.push(
        <a key={key} href={m[11]} target="_blank" rel="noreferrer" className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary">
          {m[10]}
        </a>
      );
    else if (m[12] !== undefined)
      out.push(
        <a key={key} href={m[12]} target="_blank" rel="noreferrer" className="break-all text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary">
          {m[12].replace(/^https?:\/\//, "").slice(0, 60)}
        </a>
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Editorial typography for research reports — the reading layer. */
export function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let table: string[][] | null = null;
  let k = 0;

  const flushList = () => {
    if (!list) return;
    const L = list;
    blocks.push(
      L.ordered ? (
        <ol key={`b${k++}`} className="my-[18px] list-decimal space-y-[7px] pl-[22px] marker:font-medium marker:text-muted-foreground/70">
          {L.items.map((it, i) => (
            <li key={i} id={`ref-${i + 1}`} className="leading-[1.65]">
              {inline(it, `li${k}-${i}`)}
            </li>
          ))}
        </ol>
      ) : (
        <ul key={`b${k++}`} className="my-[18px] space-y-[7px]">
          {L.items.map((it, i) => (
            <li key={i} className="relative leading-[1.65] pl-[20px] before:absolute before:left-[2px] before:top-[0.72em] before:h-[4px] before:w-[4px] before:rounded-full before:bg-primary/70 before:content-['']">
              {inline(it, `ul${k}-${i}`)}
            </li>
          ))}
        </ul>
      )
    );
    list = null;
  };

  const flushTable = () => {
    if (!table || table.length === 0) { table = null; return; }
    const T = table;
    const [head, ...rows] = T;
    blocks.push(
      <div key={`b${k++}`} className="my-5 overflow-x-auto rounded-[14px] border border-border/70">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-muted/50">
              {head.map((c, i) => (
                <th key={i} className="border-b border-border/70 px-3.5 py-2.5 text-left font-semibold tracking-tight">{inline(c, `th${k}-${i}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="transition-colors hover:bg-muted/30">
                {r.map((c, ci) => (
                  <td key={ci} className="border-b border-border/40 px-3.5 py-2.5 align-top leading-snug last:border-b-0">{inline(c, `td${k}-${ri}-${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    table = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      if (code) {
        blocks.push(
          <pre key={`b${k++}`} className="my-4 overflow-x-auto rounded-[14px] border border-border/70 bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed">
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
    // markdown table rows: | a | b | with a |---|---| separator second line
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    flushTable();
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
        <h3 key={`b${k++}`} className={`font-semibold tracking-[-0.018em] text-foreground ${compact ? "mt-4 mb-1.5 text-[15px]" : "mt-8 mb-2.5 text-[17.5px]"}`}>
          {inline(line.slice(4), `h3${k}`)}
        </h3>
      );
    else if (line.startsWith("## "))
      blocks.push(
        <h2 key={`b${k++}`} className={`font-semibold tracking-[-0.02em] text-foreground ${compact ? "mt-5 mb-2 text-[16px]" : "mt-11 mb-3.5 border-b border-border/60 pb-2.5 text-[22px]"}`}>
          {inline(line.slice(3), `h2${k}`)}
        </h2>
      );
    else if (line.startsWith("# "))
      blocks.push(
        <h1 key={`b${k++}`} className={`font-bold tracking-[-0.022em] ${compact ? "text-lg" : "mb-5 text-[28px]"}`}>
          {inline(line.slice(2), `h1${k}`)}
        </h1>
      );
    else if (line.trim() === "---")
      blocks.push(<hr key={`b${k++}`} className="my-8 border-border/60" />);
    else if (/^>\s?/.test(line))
      blocks.push(
        <blockquote key={`b${k++}`} className="my-4 rounded-r-lg border-l-2 border-primary/40 py-0.5 pl-4 pr-3 text-muted-foreground">
          {inline(line.replace(/^>\s?/, ""), `q${k}`)}
        </blockquote>
      );
    else
      blocks.push(
        <p key={`b${k++}`} className={`leading-[1.72] ${compact ? "text-sm text-muted-foreground" : "my-[14px]"}`}>
          {inline(line, `p${k}`)}
        </p>
      );
  }
  flushList();
  flushTable();
  if (code)
    blocks.push(
      <pre key={`b${k++}`} className="my-4 overflow-x-auto rounded-[14px] border border-border/70 bg-muted/40 p-4 font-mono text-[12.5px]">
        <code>{code.join("\n")}</code>
      </pre>
    );
  return <div className={compact ? "" : "text-[15.5px]"}>{blocks}</div>;
}
