import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Verified-report API — start a research run over HTTP",
  description:
    "The DigDeep verified-report API: start deep research runs with a Bearer key and get back the report, the citation audit, the per-claim ledger, the court verdict, and the pre-ship score — machine-readable.",
  alternates: { canonical: "/api-docs" },
};

/**
 * P2-3 PUBLIC API DOCS — /api-docs
 * Static, crawlable documentation for the v1 endpoints.
 */

const endpoints = [
  {
    method: "POST",
    path: "/api/v1/research",
    desc: "Start a verified research run. Same engine as the app — planning, multi-engine search, citation audit, claim ledger, optional court.",
    body: `{
  "query": "Compare solid-state vs lithium-ion EV batteries in 2026",
  "preset": "standard",        // quick | standard | deep | exhaustive
  "court": true,               // adversarial trial (optional)
  "language": "English",       // optional
  "domain": "general"          // general | law | finance | medicine (optional)
}`,
    response: `202 Accepted
{
  "id": "clx…",
  "status": "queued",
  "detail": "/api/v1/research/clx…"
}`,
  },
  {
    method: "GET",
    path: "/api/v1/research/{id}",
    desc: "Fetch the run — status while running; when completed, the full report markdown plus the verification object: citation integrity, the per-claim evidence ledger (claimChecks), the court verdict, and the pre-ship score. Sources listed with used-flags. Export URLs for PDF/Word/Excel/Markdown included.",
    response: `200 OK
{
  "id": "clx…",
  "status": "completed",
  "report": "# …full markdown report…",
  "verification": {
    "citationIntegrity": 96,
    "citationsChecked": 41,
    "claimVerdict": { "verified": 12, "partly": 3, "unverified": 1 },
    "claimChecks": [ { "id": "c1", "text": "…", "n": 3, "verdict": "verified", "support": 0.82, "passage": "…" } ],
    "court": { "verdict": "GUILTY", "guilty": 9, "notGuilty": 3 },
    "reportScore": { "overall": 84, "dims": { "coverage": 88, "integrity": 96, "evidence": 79, "consistency": 81, "compute": 100 } }
  },
  "sources": [ { "url": "…", "domain": "…", "used": true } ],
  "exportUrls": { "pdf": "/api/research/clx…/export?format=pdf", "docx": "…", "xlsx": "…", "markdown": "…" }
}`,
  },
  {
    method: "GET",
    path: "/api/v1/research",
    desc: "List your most recent API runs with statuses (polling helper).",
    response: `200 OK
{ "jobs": [ { "id": "clx…", "query": "…", "status": "completed", "progress": 100 } ] }`,
  },
];

const curlExample = `# 1 — create a key at /account, then:
curl -X POST https://digdeepx.vercel.app/api/v1/research \\
  -H "Authorization: Bearer ddk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"Is intermittent fasting supported by RCT evidence?","preset":"standard","court":true,"domain":"medicine"}'

# 2 — poll until status is "completed", then fetch the verified report:
curl https://digdeepx.vercel.app/api/v1/research/<id> \\
  -H "Authorization: Bearer ddk_YOUR_KEY"`;

export default function ApiDocsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 md:py-14">
      <p className="text-xs font-medium uppercase tracking-widest text-primary">API · v1</p>
      <h1 className="mt-2 text-3xl font-serif font-semibold tracking-tight">The verified-report API</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
        Start a deep research run over HTTP and get back not just a report, but its evidence: the citation audit, the
        per-claim ledger, the court verdict, and the pre-ship score — all machine-readable. This is the same engine
        the app runs, with the same honesty guarantees.
      </p>

      <div className="mt-6 rounded-xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">Authentication</p>
        <p className="mt-1 text-muted-foreground">
          Every request carries a Bearer key: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">Authorization: Bearer ddk_…</code>.
          Create and revoke keys on the{" "}
          <Link href="/account" className="text-primary hover:underline">Account page</Link>. Keys are stored
          server-side as SHA-256 hashes — the full key is shown exactly once at creation. Rate limit: 60 run-starts per
          minute per key.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">Endpoints</h2>
      <div className="mt-4 space-y-6">
        {endpoints.map((e) => (
          <section key={e.path} className="rounded-2xl border">
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-3">
              <span className={`rounded px-2 py-0.5 font-mono text-[11px] font-bold ${e.method === "POST" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-sky-500/15 text-sky-700 dark:text-sky-400"}`}>
                {e.method}
              </span>
              <code className="font-mono text-[13px] font-semibold">{e.path}</code>
            </div>
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">{e.desc}</p>
              {e.body && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Request body</p>
                  <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[12px] leading-relaxed">{e.body}</pre>
                </div>
              )}
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Response</p>
                <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[12px] leading-relaxed">{e.response}</pre>
              </div>
            </div>
          </section>
        ))}
      </div>

      <h2 className="mt-10 text-xl font-semibold">Quickstart</h2>
      <pre className="mt-3 overflow-x-auto rounded-xl bg-muted/60 p-4 font-mono text-[12px] leading-relaxed">{curlExample}</pre>

      <h2 className="mt-10 text-xl font-semibold">Notes & limits</h2>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>Runs are async — a run typically takes 2–10 minutes depending on preset; poll the detail endpoint.</li>
        <li>Presets: quick (≤10 min), standard (≤30 min), deep (≤3 h), exhaustive (≤12 h).</li>
        <li>Domain packs (law / finance / medicine) route search toward primary authorities and apply domain evidence standards.</li>
        <li>Export endpoints are shared with the app: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">/api/research/&#123;id&#125;/export?format=pdf|docx|xlsx|md</code> — no key required, the run id is the capability.</li>
        <li>A failed or cancelled run returns honestly in <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">status</code>; the report field stays null.</li>
        <li>The API is free during beta — keyed for attribution and abuse control, not billing.</li>
      </ul>
    </div>
  );
}
