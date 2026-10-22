#!/usr/bin/env node
// Supabase Management API helper — token ONLY via env SBP_TOKEN (never committed).
// Usage:
//   node scripts/sb-mgmt.mjs probe        — read-only: projects, status, pooler, api-keys, endpoint discovery
//   node scripts/sb-mgmt.mjs status       — one-line project status
//   node scripts/sb-mgmt.mjs restore      — restore a paused project
//   node scripts/sb-mgmt.mjs resetpass    — reset the DB password (NEW_DB_PASS env optional)
import crypto from 'node:crypto';

const TOKEN = process.env.SBP_TOKEN;
const REF = process.env.SB_REF || 'vvopggnkskzzwolxbjig';
const BASE = 'https://api.supabase.com';

if (!TOKEN) {
  console.error('SBP_TOKEN env var required');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, body: json };
}

const maskSecret = (v) =>
  typeof v === 'string' && (v.startsWith('sb_') || v.startsWith('eyJ')) && v.length > 16
    ? v.slice(0, 10) + '…(masked)…' + v.slice(-4)
    : v;

async function getProject() {
  const r = await call('GET', `/v1/projects/${REF}`);
  if (r.status !== 200) {
    console.error(`project fetch failed: ${r.status}`, JSON.stringify(r.body).slice(0, 400));
    process.exit(2);
  }
  return r.body;
}

async function main() {
  const cmd = process.argv[2] || 'probe';

  if (cmd === 'probe') {
    // fully resilient: every endpoint probed independently, no early exit —
    // a scoped-down token must reveal exactly what it can and cannot do.
    const targets = [
      ['GET', '/v1/organizations'],
      ['GET', '/v1/projects'],
      ['GET', `/v1/projects/${REF}`],
      ['GET', `/v1/projects/${REF}/api-keys`],
      ['GET', `/v1/projects/${REF}/database/settings`],
      ['GET', `/v1/projects/${REF}/config/database/pgbouncer`],
      ['GET', `/v1/projects/${REF}/database/connection-strings`],
      ['GET', `/v1/projects/${REF}/database/password`],
    ];
    for (const [m, path] of targets) {
      const r = await call(m, path);
      if (path === '/v1/projects' && Array.isArray(r.body)) {
        console.log(`GET /v1/projects → ${r.status}  (${r.body.length} projects visible)`);
        for (const p of r.body) {
          console.log(`  ${p.ref}  ${String(p.status).padEnd(16)} ${(p.region ?? '??').padEnd(11)} org=${(p.organization_slug ?? '').slice(0, 26).padEnd(26)} ${(p.created_at ?? '').slice(0, 10)}  ${p.name}`);
        }
      } else {
        const short = JSON.stringify(r.body, (k, v) => maskSecret(v)).replace(/\s+/g, ' ');
        console.log(`${m} ${path} → ${r.status}  ${short.slice(0, 240)}`);
      }
    }
  }

  else if (cmd === 'status') {
    const p = await getProject();
    console.log(JSON.stringify({ ref: p.ref, status: p.status, region: p.region, paused_at: p.paused_at ?? null }));
  }

  else if (cmd === 'restore') {
    const p = await getProject();
    if (p.status === 'active') { console.log('already active — nothing to do'); return; }
    const r = await call('POST', `/v1/projects/${REF}/restore`);
    console.log(`restore → ${r.status}`, JSON.stringify(r.body).slice(0, 400));
  }

  else if (cmd === 'resetpass') {
    const pass = process.env.NEW_DB_PASS || crypto.randomBytes(24).toString('base64url');
    // docs-verified 2026-10: PATCH /v1/projects/{ref}/database/password (scope: database_config_write)
    const attempts = [
      ['PATCH', `/v1/projects/${REF}/database/password`, { password: pass }],
      ['PUT',   `/v1/projects/${REF}/database/password`, { password: pass }],
      ['POST',  `/v1/projects/${REF}/database/reset`, { password: pass }],
    ];
    for (const [m, path, body] of attempts) {
      const r = await call(m, path, body);
      console.log(`${m} ${path} → ${r.status}`, JSON.stringify(r.body).slice(0, 300));
      if (r.status >= 200 && r.status < 300) {
        console.log(`\nOK via ${m} ${path}`);
        console.log(`NEW_PASS=${pass}`);
        return;
      }
    }
    console.error('all password-reset endpoint candidates failed — inspect probe output for the real route');
    process.exit(3);
  }

  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
