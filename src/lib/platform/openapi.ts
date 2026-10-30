/**
 * v3.4 — THE OpenAPI SPECIFICATION for the DigDeep public API.
 * Single source of truth: served at /api/openapi.json and rendered by the
 * /api-docs page (imported directly, no fetch). When an endpoint changes,
 * change it HERE — the docs page follows automatically.
 */

export const API_VERSION = "3.10.0";

const bearer = [{ bearerAuth: [] }] as const;
const jsonBody = (schema: Record<string, unknown>, example: Record<string, unknown>) => ({
  required: true,
  content: { "application/json": { schema, example } },
});

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "DigDeep Verified-Research API",
    version: API_VERSION,
    summary: "Start research runs, poll them, fetch verified reports, manage webhooks and scheduled watches.",
    description:
      "Every report is produced by the same engine the app runs: plan → live-web search → source reading → " +
      "claim-by-claim verification against citations → optional court trial (prosecutor, defense, jury of 12) → " +
      "pre-ship score. Authentication is a Bearer API key (`ddk_…`) created at [/account](/account); keys carry " +
      "scopes and optional monthly quotas. MCP clients: use the same key against the MCP server at `/api/mcp`.",
    contact: { name: "DigDeep", url: "https://digdeepx.vercel.app" },
    license: { name: "Proprietary" },
  },
  servers: [{ url: "https://digdeepx.vercel.app", description: "production" }],
  tags: [
    { name: "Research", description: "Start runs, poll status, fetch verified reports" },
    { name: "Webhooks", description: "Signed HTTP callbacks when runs finish or watched verdicts change" },
    { name: "Watches", description: "Scheduled research — re-run a query, alert when the verdict changes" },
    { name: "Public", description: "Keyless surfaces: track record, share pages, OG cards" },
  ],
  paths: {
    "/api/v1/research": {
      post: {
        tags: ["Research"],
        summary: "Start a research run",
        description:
          "Creates a run and returns its id (202). Research executes asynchronously — poll the detail endpoint. " +
          "Requires the `research:write` scope; counts against the key's monthly quota if one is set.",
        security: bearer,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", maxLength: 600, description: "The research question" },
              preset: { type: "string", enum: ["quick", "standard", "deep", "exhaustive"], default: "standard" },
              court: { type: "boolean", default: false, description: "Put the claim on trial (jury of 12)" },
              language: { type: "string", enum: ["English", "Arabic", "Chinese", "Spanish", "French", "German", "Auto-match topic"], default: "English" },
              domain: { type: "string", enum: ["general", "law", "finance", "medicine"], default: "general" },
              breadth: { type: "integer", minimum: 1, maximum: 50 },
              depth: { type: "integer", minimum: 1, maximum: 20 },
              maxSources: { type: "integer", minimum: 4, maximum: 1000 },
              maxMinutes: { type: "integer", minimum: 5, maximum: 2880 },
            },
          },
          { query: "Is the wandering albatross the longest-winged living bird?", preset: "quick", court: true },
        ),
        responses: {
          "202": {
            description: "Run accepted",
            content: { "application/json": { example: { id: "cmvgo8jlq0001l208475ptumd", status: "queued", detail: "/api/v1/research/cmvgo8jlq0001l208475ptumd" } } },
          },
          "401": { description: "Missing or invalid API key" },
          "403": { description: "Key lacks the research:write scope" },
          "429": { description: "Rate limit, or monthly quota exhausted (retryAt in body)" },
        },
      },
      get: {
        tags: ["Research"],
        summary: "List my recent runs",
        security: bearer,
        responses: {
          "200": {
            description: "The 50 most recent runs started by this account",
            content: {
              "application/json": {
                example: { jobs: [{ id: "cmvgo8jlq0001l208475ptumd", query: "How long do albatrosses live?", status: "completed", progress: 100, createdAt: "2026-10-21T09:00:00Z", completedAt: "2026-10-21T09:01:40Z" }] },
              },
            },
          },
        },
      },
    },
    "/api/v1/research/{id}": {
      get: {
        tags: ["Research"],
        summary: "Run detail + verification ledger",
        description:
          "Full read model of a run: status/progress while running; when completed, the full markdown report, the " +
          "verification object (citation integrity, claim checks, court verdict, pre-ship score), sources, and " +
          "export URLs. Polling this endpoint also resumes a run stalled at a serverless checkpoint. 404 for runs " +
          "the key does not own.",
        security: bearer,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "The run",
            content: {
              "application/json": {
                example: {
                  id: "cmvgo8jlq0001l208475ptumd",
                  query: "What is the wingspan of a wandering albatross?",
                  status: "completed",
                  progress: 100,
                  verification: { citationIntegrity: 100, citationsChecked: 6, claimChecks: 8, court: { verdict: "GUILTY", guilty: 12, notGuilty: 0 }, reportScore: { overall: 9.1 } },
                  sources: [{ url: "https://en.wikipedia.org/wiki/Albatross", domain: "en.wikipedia.org", title: "Albatross", used: true, section: "Quick answer" }],
                  exportUrls: { pdf: "/api/research/cmvg…/export?format=pdf", docx: "…", xlsx: "…", markdown: "…" },
                },
              },
            },
          },
          "404": { description: "Not found — or owned by another key" },
        },
      },
    },
    "/api/research/{id}/export": {
      get: {
        tags: ["Research"],
        summary: "Download a report (pdf · docx · xlsx · md · json)",
        description:
          "The run's export files. Access: the owner (session cookie or this Bearer key with research:read), " +
          "any run you have explicitly shared, or any keyless/anonymous run. Everything else 404s.",
        security: bearer,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "format", in: "query", required: true, schema: { type: "string", enum: ["pdf", "docx", "xlsx", "md"] } },
        ],
        responses: { "200": { description: "The file (content-type per format)" }, "404": { description: "Run not found or not completed" } },
      },
    },
    "/api/v1/webhooks": {
      get: {
        tags: ["Webhooks"],
        summary: "List my webhooks (+ recent deliveries)",
        security: bearer,
        responses: { "200": { description: "Webhooks with their signing secrets and last 3 deliveries each" } },
      },
      post: {
        tags: ["Webhooks"],
        summary: "Manage webhooks (create · update · rotate-secret · delete)",
        description:
          "Action-based. `create` registers a URL + subscribed events and returns the signing secret. Every " +
          "delivery is POSTed with `X-DigDeep-Signature: sha256=HMAC_SHA256(secret, \\`${X-DigDeep-Timestamp}.${body}\\`)` — " +
          "verify the signature and reject timestamps older than ~5 minutes. Requires the `webhooks` scope.",
        security: bearer,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["create", "update", "rotate-secret", "delete"] },
              url: { type: "string", format: "uri" },
              events: { type: "array", items: { type: "string", enum: ["run.completed", "run.failed", "watch.changed"] } },
              id: { type: "string" },
              active: { type: "boolean" },
            },
          },
          { action: "create", url: "https://example.com/digdeep-hook", events: ["run.completed", "watch.changed"] },
        ),
        responses: { "201": { description: "Webhook created (secret returned once)" }, "200": { description: "Action applied" }, "409": { description: "Limit reached (10 webhooks)" } },
      },
    },
    "/api/v1/watches": {
      get: {
        tags: ["Watches"],
        summary: "List my watches",
        security: bearer,
        responses: { "200": { description: "Watches with latest verdicts and next refresh times" } },
      },
      post: {
        tags: ["Watches"],
        summary: "Manage watches (create · update · delete)",
        description:
          "A watch re-runs its query every `cadenceDays`. When the verdict fingerprint (court verdict + claim " +
          "verdict + source-domain set) changes, `watch.changed` webhooks fire with previous and current verdicts. " +
          "Requires the `watches` scope.",
        security: bearer,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["action"],
            properties: {
              action: { type: "string", enum: ["create", "update", "delete"] },
              query: { type: "string", maxLength: 600 },
              preset: { type: "string", enum: ["quick", "standard", "deep", "exhaustive"], default: "standard" },
              court: { type: "boolean" },
              cadenceDays: { type: "integer", minimum: 1, maximum: 90, default: 7 },
              id: { type: "string" },
              active: { type: "boolean" },
            },
          },
          { action: "create", query: "What is the current consensus on intermittent fasting and muscle gain?", cadenceDays: 7, court: true },
        ),
        responses: { "201": { description: "Watch created" }, "200": { description: "Action applied" } },
      },
    },
    "/api/stats": {
      get: {
        tags: ["Public"],
        summary: "The public track record (live)",
        description: "Production-wide stats computed from real runs: completions, citation integrity, court verdict splits, durations. Refreshed every 60s. No key required.",
        responses: { "200": { description: "Track record" } },
      },
    },
    "/api/mcp": {
      post: {
        tags: ["Public"],
        summary: "MCP server (JSON-RPC 2.0 over Streamable HTTP)",
        description:
          "Model Context Protocol server for agents (Claude, etc.). Same Bearer key as v1. Methods: `initialize`, " +
          "`notifications/initialized`, `tools/list`, `tools/call`. Tools: `digdeep_research`, `digdeep_status`, " +
          "`digdeep_report`, `digdeep_watch_create`, `digdeep_watch_list`. Stateful session not required.",
        security: bearer,
        requestBody: jsonBody(
          { type: "object", properties: { jsonrpc: { type: "string", enum: ["2.0"] }, id: { type: ["string", "integer"] }, method: { type: "string" }, params: { type: "object" } } },
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
        ),
        responses: { "200": { description: "JSON-RPC response" }, "401": { description: "Missing/invalid key (WWW-Authenticate: Bearer)" } },
      },
    },
    "/s/{id}": {
      get: {
        tags: ["Public"],
        summary: "A shared report page (keyless)",
        description: "Read-only share view with SEO/OG meta; the OG card image is at /api/og/{id}.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Shared report" }, "404": { description: "No such share" } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "ddk_…", description: "API key created at /account" },
    },
  },
} as const;
