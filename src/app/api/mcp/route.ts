import { NextResponse } from "next/server";
import { after } from "next/server";
import { db } from "@/lib/db";
import { runJob, engineAlive } from "@/lib/research/engine";
import { userFromApiKey, hasScope, type ApiCaller } from "@/lib/auth";
import { startResearchRun, PRESETS } from "@/lib/platform/start-run";
import { createWatch, listWatches } from "@/lib/platform/manage";
import { verdictSummary } from "@/lib/platform/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * v3.4 — MCP SERVER (Model Context Protocol) at /api/mcp.
 * Lets Claude, agents, and any MCP client run DigDeep research as a tool.
 *
 * Transport: Streamable HTTP, STATELESS — every request is a self-contained
 * JSON-RPC 2.0 message answered with a single `application/json` response
 * (allowed by the 2025-06-18 spec; no session id is issued). Hand-rolled on
 * purpose: zero new dependencies, zero standalone-tracing risk — the v3.2.1
 * pdfkit lesson. Auth: `Authorization: Bearer ddk_…` (same API keys as v1).
 *
 * Tools: digdeep_research · digdeep_status · digdeep_report ·
 *        digdeep_watch_create · digdeep_watch_list
 */

const PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "digdeep", version: "3.7.0" };
const INSTRUCTIONS =
  "DigDeep is a verified-research engine: it plans, searches the live web, reads sources, " +
  "audits every claim against citations, and (optionally) puts the question on trial with a " +
  "prosecutor, a defense, and a jury of 12. Start with digdeep_research, poll digdeep_status " +
  "until completed, then fetch the full verified report with digdeep_report. " +
  "Create an API key at https://digdeepx.vercel.app/account.";

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "digdeep_research",
    description:
      "Start a verified research run on a question. Returns a run id — research takes tens of seconds " +
      "(quick) to minutes (deep); poll digdeep_status until status is 'completed', then call digdeep_report. " +
      "Requires the research:write scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The research question (max 600 chars)" },
        preset: { type: "string", enum: Object.keys(PRESETS), description: "quick | standard | deep | exhaustive (default standard)" },
        court: { type: "boolean", description: "Put the claim on trial: prosecutor + defense + jury of 12 + judge" },
        language: { type: "string", description: "English (default) | Arabic | Chinese | Spanish | French | German | Auto-match topic" },
        domain: { type: "string", description: "Domain pack: general (default) | law | finance | medicine" },
      },
      required: ["query"],
    },
  },
  {
    name: "digdeep_status",
    description: "Poll a research run: status, progress, stage, sources so far, and the verification summary once complete. Requires the research:read scope.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Run id from digdeep_research" } },
      required: ["id"],
    },
  },
  {
    name: "digdeep_report",
    description: "Fetch the full verified report (markdown) with its verification ledger: citation integrity, claim checks, court verdict, and sources. Requires the research:read scope.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Run id" },
        max_chars: { type: "number", description: "Truncate the report to this many characters (default 30000; 0 = no limit)" },
      },
      required: ["id"],
    },
  },
  {
    name: "digdeep_watch_create",
    description: "Schedule a recurring watch on a question: DigDeep re-runs it on a cadence and fires watch.changed webhooks when the verdict or evidence set changes. Requires the watches scope.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cadenceDays: { type: "number", description: "Refresh interval in days, 1–90 (default 7)" },
        court: { type: "boolean", description: "Court trial each refresh" },
      },
      required: ["query"],
    },
  },
  {
    name: "digdeep_watch_list",
    description: "List your scheduled watches with their latest verdicts and next refresh times. Requires the watches scope.",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpcResult(id: JsonRpc["id"], result: unknown, protocolVersion?: string | null) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : undefined },
  );
}

function rpcError(id: JsonRpc["id"], code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

const ACTIVE = ["queued", "planning", "researching", "critiquing", "synthesizing"];

async function callTool(caller: ApiCaller, name: string, args: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  if (name === "digdeep_research") {
    const r = await startResearchRun(caller, args);
    if (!r.ok) return toolText(`❌ ${r.error}${r.retryAt ? ` (quota resets ${r.retryAt})` : ""}`, true);
    return toolText(
      `Research run started: ${r.id}\nStatus: queued. Poll digdeep_status with this id — ` +
        `quick ~1 min, standard ~3–8 min, deep/exhaustive longer. Report: digdeep_report once completed.`,
    );
  }

  if (name === "digdeep_status" || name === "digdeep_report") {
    if (!hasScope(caller, "research:read")) return toolText("❌ This API key lacks the 'research:read' scope.", true);
    const id = String(args.id ?? "");
    const job = await db.researchJob.findUnique({ where: { id }, include: { sources: { orderBy: { createdAt: "asc" } } } });
    if (!job || job.userId !== caller.id) return toolText("❌ Run not found for this key.", true);
    let stats: Record<string, unknown> = {};
    try { stats = job.stats ? JSON.parse(job.stats) : {}; } catch { stats = {}; }
    const court = stats.court as Record<string, unknown> | undefined;

    if (name === "digdeep_status") {
      // same continuation contract as the public API: an owner's poll resumes
      // a run stalled at a serverless checkpoint boundary.
      if (ACTIVE.includes(job.status) && !engineAlive(job.id)) {
        after(runJob(job.id).catch((e) => console.error("[mcp-resume]", job.id, e)));
      }
      const lines = [
        `Run ${job.id}`,
        `Query: ${job.query}`,
        `Status: ${job.status} (${job.stage}) — ${job.progress}%`,
        `Preset: ${job.preset}${job.court ? " · court trial" : ""} · ${job.sources.length} source(s)`,
      ];
      if (job.status === "completed") {
        lines.push(`Verdict: ${verdictSummary(job, stats)}`);
        lines.push(`Citation integrity: ${typeof stats.citationIntegrity === "number" ? `${stats.citationIntegrity}%` : "n/a"}`);
        if (court?.verdict) lines.push(`Court: ${court.verdict} (${court.guilty}–${court.notGuilty})`);
        lines.push("Completed — call digdeep_report for the full report.");
      }
      return toolText(lines.join("\n"));
    }

    // digdeep_report
    if (job.status !== "completed") {
      return toolText(`Run is ${job.status} (${job.progress}%). Call digdeep_report again once completed.`, true);
    }
    const maxChars = Number(args.max_chars ?? 30_000) || 0;
    const report = maxChars > 0 && job.reportMd && job.reportMd.length > maxChars
      ? `${job.reportMd.slice(0, maxChars)}\n\n…[truncated — full length ${job.reportMd.length} chars; raise max_chars]`
      : job.reportMd ?? "(no report body)";
    const header = [
      `# ${job.query}`,
      `Verdict: ${verdictSummary(job, stats)} · Citation integrity: ${typeof stats.citationIntegrity === "number" ? `${stats.citationIntegrity}%` : "n/a"}`,
      court?.verdict ? `Court: ${court.verdict} (${court.guilty}–${court.notGuilty}) — ${court.judgeSummary ?? ""}`.trim() : "",
      `Sources: ${job.sources.map((s) => s.domain).filter((d, i, a) => a.indexOf(d) === i).join(", ")}`,
      "",
    ].filter(Boolean).join("\n");
    return toolText(`${header}\n${report}`);
  }

  if (name === "digdeep_watch_create") {
    if (!hasScope(caller, "watches")) return toolText("❌ This API key lacks the 'watches' scope.", true);
    const r = await createWatch(caller.id, {
      query: String(args.query ?? ""),
      court: args.court === true,
      cadenceDays: args.cadenceDays != null ? Number(args.cadenceDays) : undefined,
    });
    if (!r.ok) return toolText(`❌ ${r.error}`, true);
    const w = r.watch as { id: string; cadenceDays: number; nextRunAt: string };
    return toolText(`Watch created: ${w.id}\nQuery re-runs every ${w.cadenceDays} day(s); first run at the next scheduler tick (${w.nextRunAt}). watch.changed webhooks fire when the verdict or evidence set changes.`);
  }

  if (name === "digdeep_watch_list") {
    if (!hasScope(caller, "watches")) return toolText("❌ This API key lacks the 'watches' scope.", true);
    const watches = await listWatches(caller.id);
    if (!watches.length) return toolText("No watches yet — create one with digdeep_watch_create.");
    return toolText(watches.map((w) =>
      `${w.active ? "●" : "○"} ${w.query}\n   every ${w.cadenceDays}d · last: ${w.lastVerdict ?? "not yet run"} · next: ${w.nextRunAt}${w.lastChangedAt ? ` · last change: ${w.lastChangedAt}` : ""}`
    ).join("\n\n"));
  }

  return toolText(`Unknown tool: ${name}`, true);
}

export async function POST(req: Request) {
  const caller = await userFromApiKey(req.headers.get("authorization"));
  if (!caller) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: pass 'Authorization: Bearer ddk_…' (create an API key at /account)." } },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  let msg: JsonRpc;
  try {
    msg = (await req.json()) as JsonRpc;
  } catch {
    return rpcError(null, -32700, "Parse error: invalid JSON");
  }

  const method = msg.method ?? "";
  const headerProto = req.headers.get("mcp-protocol-version");

  // notifications (no id) get no body — 202 Accepted
  if (msg.id === undefined || msg.id === null) {
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return new NextResponse(null, { status: 202 });
    }
    return new NextResponse(null, { status: 202 });
  }

  // v3.4.1: JSON-RPC 2.0 requires the version field on requests — malformed
  // messages get -32600 instead of silently executing.
  if (msg.jsonrpc !== "2.0") {
    return rpcError(msg.id, -32600, "Invalid Request: jsonrpc must be \"2.0\".");
  }

  if (method === "initialize") {
    const requested = String((msg.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "");
    return rpcResult(msg.id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }, headerProto ?? requested);
  }

  if (method === "ping") return rpcResult(msg.id, {}, headerProto);
  if (method === "tools/list") return rpcResult(msg.id, { tools: TOOLS }, headerProto);
  if (method === "tools/call") {
    const name = String((msg.params as { name?: string } | undefined)?.name ?? "");
    const args = ((msg.params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}) as Record<string, unknown>;
    try {
      return rpcResult(msg.id, await callTool(caller, name, args), headerProto);
    } catch (e) {
      return rpcResult(msg.id, toolText(`Tool execution failed: ${e instanceof Error ? e.message : String(e)}`, true), headerProto);
    }
  }
  if (method === "resources/list") return rpcResult(msg.id, { resources: [] }, headerProto);
  if (method === "prompts/list") return rpcResult(msg.id, { prompts: [] }, headerProto);

  return rpcError(msg.id, -32601, `Method not found: ${method}`);
}

// Streamable HTTP: this server offers no SSE channel — 405 per the spec.
export async function GET() {
  return NextResponse.json({ error: "SSE stream not offered; POST JSON-RPC messages to this endpoint." }, { status: 405 });
}
