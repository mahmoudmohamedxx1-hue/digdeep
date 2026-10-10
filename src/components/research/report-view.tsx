"use client";

import { useState } from "react";
import { Download, FileText, FileJson, Copy, Check, Clock, BookMarked, Cpu, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JobItem } from "./types";
import { Markdown } from "./markdown";

function fmtDuration(ms: number) {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

interface Stats {
  durationMs?: number;
  sourcesConsulted?: number;
  llmCalls?: number;
  reportWords?: number;
  sections?: number;
  byModel?: Record<string, { calls: number; totalMs: number }>;
}

export function ReportView({ job }: { job: JobItem }) {
  const [copied, setCopied] = useState(false);
  const stats = (job.stats ?? {}) as Stats;
  const models = Object.entries(stats.byModel ?? {});

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(job.reportMd ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div>
      {/* stats + exports */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
          <BookMarked className="h-3.5 w-3.5" /> {stats.sourcesConsulted ?? 0} sources
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" /> ~{(stats.reportWords ?? 0).toLocaleString()} words
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <Clock className="h-3.5 w-3.5" /> {fmtDuration(stats.durationMs ?? 0)}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <Layers className="h-3.5 w-3.5" /> {stats.sections ?? 0} sections
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <Cpu className="h-3.5 w-3.5" /> {stats.llmCalls ?? 0} LLM calls
        </span>
        {models.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 px-3 py-1.5 font-mono text-[11px] font-medium text-primary">
            {models.map(([m, v]) => `${m}×${v.calls}`).join(" + ")}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={copy} className="h-8 gap-1.5">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <a href={`/api/research/${job.id}/export?format=md`}>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Download className="h-3.5 w-3.5" /> Markdown
            </Button>
          </a>
          <a href={`/api/research/${job.id}/export?format=json`}>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <FileJson className="h-3.5 w-3.5" /> JSON log
            </Button>
          </a>
          <a href={`/api/research/${job.id}/export?format=pdf`}>
            <Button size="sm" className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90">
              <Download className="h-3.5 w-3.5" /> PDF
            </Button>
          </a>
        </div>
      </div>

      {/* report body */}
      <article className="rounded-2xl border bg-card px-5 py-5 sm:px-8 sm:py-7">
        <Markdown text={job.reportMd ?? "_Report not available._"} />
      </article>
    </div>
  );
}
