export interface ReportRef {
  n: number;
  title: string;
  domain: string;
  url: string;
}

export interface ParsedReport {
  exec: string;
  body: string;
  conclusion: string;
  diff: string;
  refs: ReportRef[];
}

/** Parse the final research report markdown into structured parts. */
export function parseReport(md: string): ParsedReport {
  const lines = md.split("\n");
  let mode: "title" | "exec" | "body" | "conclusion" | "diff" | "refs" | "meta" = "title";
  const bodyLines: string[] = [];
  const execLines: string[] = [];
  const concLines: string[] = [];
  const diffLines: string[] = [];
  const refs: ReportRef[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## Executive Summary")) { mode = "exec"; continue; }
    if (line.startsWith("## Conclusion")) { mode = "conclusion"; continue; }
    if (line.startsWith("## What changed since the last run")) { mode = "diff"; continue; }
    if (line.startsWith("## References")) { mode = "refs"; continue; }
    if (line.trim() === "---") { mode = "meta"; continue; }
    if (mode === "meta") continue;
    if (mode === "title") continue;
    if (mode === "refs") {
      const m = line.trim().match(/^(\d+)\.\s(.+?)\s+—\s+\*(.+?)\*\s+—\s+(\S+)$/);
      if (m) refs.push({ n: Number(m[1]), title: m[2], domain: m[3], url: m[4] });
      continue;
    }
    if (/^##\s/.test(line)) { mode = "body"; bodyLines.push(line); continue; }
    if (mode === "exec") execLines.push(line);
    else if (mode === "conclusion") concLines.push(line);
    else if (mode === "diff") diffLines.push(line);
    else bodyLines.push(line);
  }
  return {
    exec: execLines.join("\n").trim(),
    body: bodyLines.join("\n").trim(),
    conclusion: concLines.join("\n").trim(),
    diff: diffLines.join("\n").trim(),
    refs,
  };
}

/** Mode-aware parse: chat = plain reply; quick = answer + references; research = full report. */
export function parseAnswer(md: string, mode?: string): ParsedReport {
  if (mode === "chat") return { exec: "", body: md, conclusion: "", diff: "", refs: [] };
  if (!md.includes("## Executive Summary")) {
    const idx = md.indexOf("## References");
    const body = (idx >= 0 ? md.slice(0, idx) : md).trim();
    const refs: ReportRef[] = [];
    if (idx >= 0) {
      for (const line of md.slice(idx).split("\n")) {
        const m = line.trim().match(/^(\d+)\.\s(.+?)\s+—\s+\*(.+?)\*\s+—\s+(\S+)$/);
        if (m) refs.push({ n: Number(m[1]), title: m[2], domain: m[3], url: m[4] });
      }
    }
    return { exec: "", body, conclusion: "", diff: "", refs };
  }
  return parseReport(md);
}

/** The executive summary as a short lead plus 3–5 key findings. */
export interface ExecShape {
  lead: string;
  findings: string[];
  tail: string;
}

export function parseExec(exec: string): ExecShape {
  const lines = exec.split("\n").map((l) => l.trim()).filter(Boolean);
  const lead = lines.find((l) => !/^[-*•]\s/.test(l) && !/^#/.test(l)) ?? "";
  const findings = lines
    .filter((l) => /^[-*•]\s/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/\*\*/g, "").trim())
    .slice(0, 5);
  const nonBullet = lines.filter((l) => !/^[-*•]\s/.test(l));
  const tail = nonBullet.length > 1 ? nonBullet[nonBullet.length - 1] : "";
  return { lead: lead.replace(/\*\*/g, "").trim(), findings, tail: tail === lead ? "" : tail };
}

/** Heading id (for the table of contents + anchor links). */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[(\d+)\]/g, "")
    .replace(/[^\w\s\u0600-\u06ff\u4e00-\u9fff-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "section";
}

/** The report's h2 sections — powers the sticky table of contents. */
export function extractHeadings(md: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      out.push({ id: headingId(title), title });
    }
  }
  return out;
}
