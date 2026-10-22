#!/usr/bin/env node
// =====================================================================
// VERCEL REHOST — move DigDeep's hosting to a different Vercel account.
//
// One command. Idempotent (safe to re-run any stage). Token is read from
// --token or the VERCEL_TOKEN env var — NEVER hardcoded (GitHub push
// protection blocks committed tokens; keep it that way).
//
//   VERCEL_TOKEN="sk_..." node scripts/vercel-rehost.mjs \
//     --db-url "postgresql://postgres.REF:PASSWORD@HOST:5432/postgres" \
//     [--zai-key "..."] [--name digdeep] [--domain digdeepx.vercel.app]
//
// Stages (default: all, in order — re-run with --only to repeat one):
//   validate  check the token works and print the account
//   project   create the project on the new account (or adopt existing)
//   env       upsert all environment variables
//   deploy    production deploy of the current code via Vercel CLI
//   domain    claim the digdeepx.vercel.app URL for the new project
//   verify    hit the live endpoints and confirm the stack is healthy
//
// Notes:
//   • DATABASE_URL must be reachable from Vercel's build (migrations run
//     at build time). For Supabase use the SESSION POOLER string
//     (Connect → "Session pooler", port 5432). If a :6543 transaction
//     pooler URL is passed we auto-append ?pgbouncer=true.
//   • CRON_SECRET is auto-generated once and printed — save it if you
//     ever want to call /api/cron/watches directly.
//   • ZAI_API_KEY is optional: without it the app runs on the keyless
//     LLM7 pool + Pollinations (GLM lane sleeps until it is added).
// =====================================================================

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import crypto from "node:crypto";

// ---------- argv ----------
const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    if (["only", "token", "db-url", "zai-key", "name", "domain"].includes(key)) {
      opt[key] = args[++i];
    } else {
      opt[key] = true;
    }
  }
}
const TOKEN = opt.token || process.env.VERCEL_TOKEN || "";
const NAME = opt.name || "digdeep";
const DOMAIN = opt["domain"] === undefined && !opt.domain ? "digdeepx.vercel.app" : (typeof opt.domain === "string" ? opt.domain : null);
const ONLY = opt.only || null;

// Fixed app config (known-good values for this project)
const SUPABASE_URL = "https://vvopggnkskzzwolxbjig.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_PGIlUqfudf0aisRjfC9s6g_KatzsD-D";
const ADMIN_EMAILS = "mahmoudmohamedxx1@gmail.com";

const log = (m) => console.log(m);
const die = (m) => { console.error("\n✖ " + m); process.exit(1); };

if (!TOKEN) {
  die("No token. Pass --token \"sk_...\" or set VERCEL_TOKEN.\n" +
      "Create one: vercel.com → Account Settings → Tokens → Create Token (Full Account scope).");
}

// ---------- helpers ----------
const API = "https://api.vercel.com";
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function normDbUrl(raw) {
  let url = raw.trim();
  // transaction pooler (6543) is not prepared-statement safe for Prisma
  if (/^postgres(ql)?:\/\/.*:6543\//.test(url) && !url.includes("pgbouncer=")) {
    url += (url.includes("?") ? "&" : "?") + "pgbouncer=true&connection_limit=1";
  }
  return url;
}

const STAGES = ["validate", "project", "env", "deploy", "domain", "verify"];
function want(stage) { return !ONLY || ONLY === stage || ONLY.split(",").includes(stage); }

// ---------- state ----------
const stateFile = ".vercel/rehost-state.json";
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const saveState = () => { mkdirSync(".vercel", { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2)); };

// =====================================================================
// STAGE: validate
// =====================================================================
async function validate() {
  log("\n[1/6] Validating token…");
  const r = await api("GET", "/v2/user");
  if (r.status === 403 || r.status === 401) {
    die("Token REJECTED (" + r.status + " " + (r.json?.error?.code || "") + ").\n" +
        "The token is invalid, expired, or copied incompletely.\n" +
        "Fix: vercel.com → Account Settings → Tokens → Create Token → copy the FULL sk_… string.");
  }
  if (r.status !== 200) die("Unexpected /v2/user response " + r.status + ": " + r.text.slice(0, 200));
  const u = r.json.user || r.json;
  state.userId = u.id; state.username = u.username || u.email;
  saveState();
  log("    ✔ token valid — account: " + state.username + " (" + state.userId + ")");
}

// =====================================================================
// STAGE: project
// =====================================================================
async function project() {
  log("\n[2/6] Ensuring project \"" + NAME + "\" exists…");
  let r = await api("POST", "/v9/projects", { name: NAME, framework: "nextjs" });
  if (r.status === 200 || r.status === 201) {
    state.projectId = r.json.id;
    log("    ✔ project created (" + state.projectId + ")");
  } else if (r.status === 409 || (r.json?.error?.code === "project_name_already_exists")) {
    const g = await api("GET", `/v9/projects/${NAME}`);
    if (g.status !== 200) die("Project exists but cannot be read: " + g.status + " " + g.text.slice(0, 200));
    state.projectId = g.json.id;
    log("    ✔ project already exists — adopting (" + state.projectId + ")");
  } else {
    die("Project creation failed " + r.status + ": " + r.text.slice(0, 300));
  }
  // link the CLI (orgId = userId for personal accounts)
  mkdirSync(".vercel", { recursive: true });
  writeFileSync(".vercel/project.json", JSON.stringify({
    projectId: state.projectId, orgId: state.userId, name: NAME,
  }, null, 2));
  saveState();
  log("    ✔ CLI linked (.vercel/project.json)");
}

// =====================================================================
// STAGE: env
// =====================================================================
async function env() {
  if (!state.projectId) die("No projectId in state — run --only=project first.");
  log("\n[3/6] Upserting environment variables…");

  const vars = [
    { key: "SUPABASE_URL", value: SUPABASE_URL },
    { key: "SUPABASE_ANON_KEY", value: SUPABASE_ANON_KEY },
    { key: "ADMIN_EMAILS", value: ADMIN_EMAILS },
  ];

  if (opt["db-url"]) {
    state.dbUrl = normDbUrl(opt["db-url"]);
    saveState();
  }
  if (!state.dbUrl) {
    die("DATABASE_URL missing. Pass --db-url \"postgresql://…\" (Supabase: Connect → Session pooler, port 5432).");
  }
  vars.push({ key: "DATABASE_URL", value: state.dbUrl });

  if (!state.cronSecret) {
    state.cronSecret = crypto.randomBytes(24).toString("hex");
    saveState();
    log("    • generated CRON_SECRET: " + state.cronSecret + "  (save it if you will call /api/cron/watches)");
  }
  vars.push({ key: "CRON_SECRET", value: state.cronSecret });

  if (opt["zai-key"]) {
    state.zaiKey = opt["zai-key"]; saveState();
    log("    • ZAI_API_KEY provided — GLM lane will be live");
  } else if (!state.zaiKey) {
    log("    • no ZAI_API_KEY — app runs on the keyless pool (add later: --only=env --zai-key \"…\")");
  }
  if (state.zaiKey) vars.push({ key: "ZAI_API_KEY", value: state.zaiKey });

  const payload = vars.map((v) => ({ ...v, type: "encrypted", target: ["production", "preview", "development"] }));
  const r = await api("POST", `/v9/projects/${state.projectId}/env?upsert=true`, payload);
  if (r.status !== 200) die("Env upsert failed " + r.status + ": " + r.text.slice(0, 300));
  log("    ✔ " + vars.length + " variables set (production + preview + development)");
}

// =====================================================================
// STAGE: deploy
// =====================================================================
function deploy() {
  if (!state.projectId) die("No projectId in state — run --only=project first.");
  if (!state.dbUrl) die("No DATABASE_URL in state — run --only=env --db-url \"postgresql://…\" first.");
  log("\n[4/6] Deploying current code to production (this builds on Vercel — several minutes)…");
  const res = spawnSync("vercel", ["deploy", "--prod", "--yes"], {
    env: { ...process.env, VERCEL_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
  });
  const out = (res.stdout || "").trim().split("\n").filter(Boolean);
  const url = out.length ? out[out.length - 1] : null;
  if (res.status !== 0 || !url || !url.includes(".vercel.app")) {
    die("Deploy failed (exit " + res.status + "). Last output:\n" + out.slice(-6).join("\n"));
  }
  state.deployUrl = url;
  saveState();
  log("    ✔ deployed: " + url);
}

// =====================================================================
// STAGE: domain
// =====================================================================
async function domain() {
  if (!state.projectId) die("No projectId in state — run --only=project first.");
  if (!DOMAIN) { log("\n[5/6] Domain: skipped (--no-domain)"); return; }
  log("\n[5/6] Claiming " + DOMAIN + " …");
  const r = await api("POST", `/v9/projects/${state.projectId}/domains`, { name: DOMAIN });
  if (r.status === 200 || r.status === 201) {
    state.domain = DOMAIN; saveState();
    log("    ✔ " + DOMAIN + " attached to the new project");
  } else if (r.json?.error?.code === "domain_already_exists_on_project" || /same project/i.test(r.text)) {
    state.domain = DOMAIN; saveState();
    log("    ✔ already attached to this project");
  } else {
    log("    ✖ could not claim " + DOMAIN + " (" + r.status + " " + (r.json?.error?.code || "") + ")");
    log("      The old account still owns the name. To free it:");
    log("      old Vercel dashboard → project digdeep → Settings → Domains → remove " + DOMAIN);
    log("      then re-run:  --only=domain");
    log("      (the fresh deployment stays reachable at " + (state.deployUrl || "its .vercel.app URL") + " meanwhile)");
  }
}

// =====================================================================
// STAGE: verify
// =====================================================================
async function verify() {
  const base = state.domain ? "https://" + state.domain : state.deployUrl;
  if (!base) die("Nothing to verify — run deploy first.");
  log("\n[6/6] Verifying " + base + " …");
  const home = await fetch(base, { redirect: "manual" }).then((r) => r.status).catch(() => "ERR");
  log("    /            → " + home);
  const auth = await fetch(base + "/api/auth").then(async (r) => r.status + " " + (await r.text()).slice(0, 80)).catch(() => "ERR");
  log("    /api/auth    → " + auth);
  if (String(home) === "200") log("\n🎉 LIVE on " + base + " — DigDeep is hosted on the new account.");
  else log("\n⚠ / returned " + home + " — check the deploy logs (vercel inspect " + (state.deployUrl || "") + ").");
}

// ---------- run ----------
(async () => {
  log("DigDeep Vercel rehost — project \"" + NAME + "\", domain \"" + (DOMAIN || "none") + "\"" + (ONLY ? ", stage: " + ONLY : ""));
  const runners = { validate, project, env, deploy, domain, verify };
  for (const s of STAGES) {
    if (!want(s)) continue;
    await runners[s]();
  }
})().catch((e) => die(e.stack || String(e)));
