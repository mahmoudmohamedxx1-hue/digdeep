import type { Metadata } from "next";
import Link from "next/link";
import { openApiSpec, API_VERSION } from "@/lib/platform/openapi";

export const metadata: Metadata = {
  title: "Verified-report API — start a research run over HTTP",
  description:
    "The DigDeep verified-report API: start deep research runs with a Bearer key and get back the report, the citation audit, the per-claim ledger, the court verdict, and the pre-ship score — machine-readable. Plus webhooks, scheduled watches, and an MCP server.",
  alternates: { canonical: "/api-docs" },
};

/**
 * P2-3 / v3.4 PUBLIC API DOCS — /api-docs
 * Rendered FROM the OpenAPI spec (src/lib/platform/openapi.ts) — the page can
 * never drift from the contract, and /api/openapi.json serves the same object
 * for codegen and SDKs.
 */

type Op = {
  method: string;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  bodyExample?: unknown;
  responseExample?: unknown;
  params?: { name: string; in: string; required?: boolean; schema?: { enum?: readonly string[] } }[];
};

const TAG_ORDER = ["Research", "Webhooks", "Watches", "Public"] as const;

function opsFromSpec(): Op[] {
  const paths = openApiSpec.paths as unknown as Record<string, Record<string, unknown>>;
  const ops: Op[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const o = op as {
        tags?: readonly string[]; summary?: string; description?: string;
        requestBody?: { content?: { "application/json"?: { example?: unknown } } };
        responses?: Record<string, { content?: { "application/json"?: { example?: unknown } } }>;
        parameters?: { name: string; in: string; required?: boolean; schema?: { enum?: readonly string[] } }[];
      };
      const okResp = o.responses?.["200"] ?? o.responses?.["201"] ?? o.responses?.["202"];
      ops.push({
        method: method.toUpperCase(),
        path,
        tag: o.tags?.[0] ?? "Public",
        summary: o.summary ?? "",
        description: o.description,
        bodyExample: o.requestBody?.content?.["application/json"]?.example,
        responseExample: okResp?.content?.["application/json"]?.example,
        params: o.parameters,
      });
    }
  }
  return ops;
}

const fmt = (v: unknown) => (v == null ? "" : JSON.stringify(v, null, 2));

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  POST: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
};

const curlExample = `# 1 — create a key at /account, then:
curl -X POST https://digdeepx.vercel.app/api/v1/research \\
  -H "Authorization: Bearer ddk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"Is intermittent fasting supported by RCT evidence?","preset":"standard","court":true,"domain":"medicine"}'

# 2 — poll until status is "completed", then fetch the verified report:
curl https://digdeepx.vercel.app/api/v1/research/<id> \\
  -H "Authorization: Bearer ddk_YOUR_KEY"`;

const webhookVerifyExample = `# verify a delivery (Node.js)
import { createHmac, timingSafeEqual } from "crypto";

const raw = await readRawBody(req);            // the exact bytes received
const ts   = req.headers["x-digdeep-timestamp"];
const sig  = req.headers["x-digdeep-signature"]; // "sha256=<hex>"
const expected = createHmac("sha256", SECRET)
  .update(\`\${ts}.\${raw}\`).digest("hex");
const ok = timingSafeEqual(Buffer.from(sig.slice(7)), Buffer.from(expected))
  && Date.now() - Number(ts) < 5 * 60_000;    // reject replays
if (!ok) return res.status(401).end();`;

const mcpExample = `# any MCP client — server URL + the same Bearer key:
curl -X POST https://digdeepx.vercel.app/api/mcp \\
  -H "Authorization: Bearer ddk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Claude / agents: add a remote MCP server
#   URL:  https://digdeepx.vercel.app/api/mcp
#   Auth: Bearer <your ddk_… key>
# then call digdeep_research → digdeep_status → digdeep_report`;

const MCP_TOOLS = [
  ["digdeep_research", "Start a verified research run (preset, court, language, domain)"],
  ["digdeep_status", "Poll a run: status, progress, verdict summary — polls also resume stalled runs"],
  ["digdeep_report", "The full markdown report + verification ledger, truncated to a context-friendly size"],
  ["digdeep_watch_create", "Schedule a recurring watch; alerts when the verdict fingerprint changes"],
  ["digdeep_watch_list", "List watches with latest verdicts and next refresh times"],
];

export default function ApiDocsPage() {
  const ops = opsFromSpec();
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 md:py-14">
      <p className="text-xs font-medium uppercase tracking-widest text-primary">API · v1 · MCP · webhooks</p>
      <h1 className="mt-2 text-3xl font-serif font-semibold tracking-tight">The verified-report API</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
        Start a deep research run over HTTP and get back not just a report, but its evidence: the citation audit, the
        per-claim ledger, the court verdict, and the pre-ship score — all machine-readable. This is the same engine
        the app runs, with the same honesty guarantees. Webhooks push results to you; watches re-run questions and
        alert when the answer changes; an MCP server exposes the whole engine to agents.
      </p>

      <div className="mt-6 rounded-xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Authentication & scopes</p>
        <p className="mt-1 text-muted-foreground">
          Every request carries a Bearer key: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">Authorization: Bearer ddk_…</code>.
          Create keys on the <Link href="/account" className="text-primary hover:underline">Account page</Link> — stored
          server-side as SHA-256 hashes, shown exactly once. Keys carry <strong>scopes</strong>{" "}
          (<code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">research:read</code>,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">research:write</code>,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">webhooks</code>,{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">watches</code>) and an optional{" "}
          <strong>monthly run quota</strong>. Rate limit: 60 requests/minute per key. Machine-readable contract:{" "}
          <Link href="/api/openapi.json" className="text-primary hover:underline">/api/openapi.json</Link>.
        </p>
      </div>

      {TAG_ORDER.map((tag) => {
        const tagOps = ops.filter((o) => o.tag === tag);
        if (!tagOps.length) return null;
        return (
          <div key={tag}>
            <h2 className="mt-10 text-xl font-semibold">{tag === "Public" ? "Public surfaces" : tag}</h2>
            <div className="mt-4 space-y-6">
              {tagOps.map((e) => (
                <section key={`${e.method}-${e.path}`} className="rounded-2xl border">
                  <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-3">
                    <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold ${METHOD_COLOR[e.method] ?? "bg-muted text-muted-foreground"}`}>
                      {e.method}
                    </span>
                    <code className="font-mono text-[13px] font-semibold">{e.path}</code>
                    <span className="ml-auto text-[12px] text-muted-foreground">{e.summary}</span>
                  </div>
                  <div className="space-y-3 p-4">
                    {e.description && <p className="text-sm leading-relaxed text-muted-foreground">{e.description}</p>}
                    {!!e.params?.length && (
                      <p className="text-[12px] text-muted-foreground">
                        Parameters:{" "}
                        {e.params.map((p) => (
                          <code key={p.name} className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                            {p.in === "path" ? `{${p.name}}` : `${p.name}=${p.schema?.enum?.length ? `${p.schema.enum.join("|")}` : "…"}`}
                          </code>
                        ))}
                      </p>
                    )}
                    {e.bodyExample != null && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Request body</p>
                        <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[12px] leading-relaxed">{fmt(e.bodyExample)}</pre>
                      </div>
                    )}
                    {e.responseExample != null && (
                      <div>
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Response</p>
                        <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[12px] leading-relaxed">{fmt(e.responseExample)}</pre>
                      </div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        );
      })}

      <h2 className="mt-10 text-xl font-semibold">MCP server — DigDeep as an agent tool</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        The same engine speaks the Model Context Protocol at{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">/api/mcp</code> (JSON-RPC 2.0 over
        Streamable HTTP, stateless). Point Claude or any MCP client at it with your Bearer key — agents can then run
        verified research, poll it, fetch reports, and manage watches as first-class tools.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {MCP_TOOLS.map(([name, desc]) => (
          <div key={name} className="rounded-xl border p-3">
            <code className="font-mono text-[13px] font-semibold">{name}</code>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>
      <pre className="mt-3 overflow-x-auto rounded-xl bg-muted/60 p-4 font-mono text-[12px] leading-relaxed">{mcpExample}</pre>

      <h2 className="mt-10 text-xl font-semibold">Verifying webhook deliveries</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Every delivery is signed with the hook&apos;s secret and timestamped — reject anything that fails the HMAC or
        is older than five minutes.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-xl bg-muted/60 p-4 font-mono text-[12px] leading-relaxed">{webhookVerifyExample}</pre>

      <h2 className="mt-10 text-xl font-semibold">Quickstart</h2>
      <pre className="mt-3 overflow-x-auto rounded-xl bg-muted/60 p-4 font-mono text-[12px] leading-relaxed">{curlExample}</pre>

      <h2 className="mt-10 text-xl font-semibold">Notes & limits</h2>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>Runs are async — typically 1–10 minutes by preset; poll the detail endpoint (polling also resumes stalled runs).</li>
        <li>Presets: quick (≤10 min), standard (≤30 min), deep (≤3 h), exhaustive (≤12 h).</li>
        <li>Domain packs (law / finance / medicine) route search toward primary authorities and apply domain evidence standards.</li>
        <li>Exports: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">/api/research/&#123;id&#125;/export?format=pdf|docx|xlsx|md</code>.</li>
        <li>Watch refreshes run on the scheduler (daily tick at 06:00 UTC; each watch follows its own cadence).</li>
        <li>A failed or cancelled run returns honestly in <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">status</code>; the report field stays null.</li>
        <li>The API is free during beta — keyed for attribution, scopes, and abuse control, not billing.</li>
      </ul>
    </div>
  );
}
