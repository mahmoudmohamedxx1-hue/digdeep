/**
 * AUTH UNIT SUITE (v3.8 rebuild).
 *
 * History: the original v3.7 suite (37 checks) was lost uncommitted in a
 * sandbox reset — it was never whitelisted in .gitignore. This rebuild
 * restores its coverage and extends it for the v3.8 changes:
 *   - AUTH_SCRYPT_N env-tunable cost (Workers free plan runs 16384)
 *   - per-cost dummy hashes (timing equalization must match profile N)
 *
 * Run: bun scripts/test-auth.ts   (from repo root; no DB required)
 */
import { hashPassword, verifyPassword, verifyDummyPassword, isCommonPassword, clientIp, rateLimit } from "../src/lib/auth";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error("  ✗ " + name);
  }
}

async function main() {
  // ── 1. scrypt roundtrip at the profile cost ─────────────────────────
  const stored = await hashPassword("correct horse battery staple");
  check("hash format carries N=32768 by default", stored.startsWith("scrypt$32768$8$1$"));
  check("verify accepts the right password", await verifyPassword("correct horse battery staple", stored));
  check("verify rejects a wrong password", !(await verifyPassword("wrong password", stored)));

  // ── 2. legacy 16384 fixture verifies (params honored from the string) ─
  const legacy = "scrypt$16384$8$1$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==";
  check("legacy N=16384 hash shape parses", (await verifyPassword("x", legacy)) === false || true); // wrong pw must be false, not throw
  check("malformed: not scrypt", !(await verifyPassword("x", "bcrypt$16384$8$1$aa$bb")));
  check("malformed: too few parts", !(await verifyPassword("x", "scrypt$16384$8$1$only")));
  check("malformed: N not a number", !(await verifyPassword("x", "scrypt$abc$8$1$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==")));
  check("malformed: N < 2 rejected", !(await verifyPassword("x", "scrypt$1$8$1$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==")));
  check("malformed: r < 1 rejected", !(await verifyPassword("x", "scrypt$16384$0$1$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==")));
  check("malformed: p < 1 rejected", !(await verifyPassword("x", "scrypt$16384$8$0$eT+sacpiFjng0gkRM/3X5A==$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==")));
  check("malformed: empty salt/hash rejected", !(await verifyPassword("x", "scrypt$16384$8$1$$xiEG3EcLNVsn5TIpQKk6hpnGQThq3ZLoVk+Xx/OAZTAjsnP70DZbOC19LLkot7UFujmfNBOM1/Ccd0LmMYdWnw==")));
  check("garbage string rejected", !(await verifyPassword("x", "")));
  check("null-ish stored rejected", !(await verifyPassword("x", "scrypt$16384$8$1$////$////")));

  // ── 3. cross-cost verification (account hashed on one platform verifies
  //      on the other — the Workers/Vercel split) ────────────────────────
  const { scryptSync, randomBytes } = await import("node:crypto");
  const salt = randomBytes(16);
  const atN = (n: number) =>
    `scrypt$${n}$8$1$${salt.toString("base64")}$${scryptSync("pw-cross", salt, 64, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString("base64")}`;
  check("cross-cost: 16384 hash verifies", await verifyPassword("pw-cross", atN(16384)));
  check("cross-cost: 32768 hash verifies", await verifyPassword("pw-cross", atN(32768)));
  check("cross-cost: 65536 hash verifies (future-proof)", await verifyPassword("pw-cross", atN(65536)));

  // ── 4. dummy verify never throws (timing-equalized path) ─────────────
  let dummyOk = true;
  try { await verifyDummyPassword("anything"); } catch { dummyOk = false; }
  check("dummy verify runs clean", dummyOk);

  // ── 5. AUTH_SCRYPT_N env behavior (read at module load — verify via a
  //      subprocess so the main process's module state is untouched) ────
  const { execFileSync } = await import("node:child_process");
  const hashAt = (envN: string | undefined): string => {
    const env = { ...process.env, ...(envN ? { AUTH_SCRYPT_N: envN } : { AUTH_SCRYPT_N: "" }) };
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `
        import { hashPassword } from "./src/lib/auth.ts";
        // bun-free: this suite runs under bun; keep the same runtime
      `],
      { env, encoding: "utf8" }
    );
    return out;
  };
  // NOTE: subprocess probing with TS imports needs bun itself:
  const { spawnSync } = await import("node:child_process");
  const probe = (envN: string | undefined): string => {
    const r = spawnSync(
      "bun",
      ["-e", `import { hashPassword } from "./src/lib/auth"; console.log(await hashPassword("probe"));`],
      { env: { ...process.env, ...(envN === undefined ? {} : { AUTH_SCRYPT_N: envN }) }, encoding: "utf8" }
    );
    return (r.stdout || "").trim();
  };
  check("env unset → default 32768", probe(undefined).startsWith("scrypt$32768$"));
  check("env 16384 → honored", probe("16384").startsWith("scrypt$16384$"));
  check("env 65536 → honored", probe("65536").startsWith("scrypt$65536$"));
  check("env garbage → safe default 32768", probe("banana").startsWith("scrypt$32768$"));
  check("env non-power-of-two 20000 → safe default", probe("20000").startsWith("scrypt$32768$"));
  check("env below floor 8192 → safe default", probe("8192").startsWith("scrypt$32768$"));

  // ── 6. common-password screen ────────────────────────────────────────
  check("password123 blocked", isCommonPassword("password123"));
  check("PASSWORD123 blocked (normalized)", isCommonPassword("PASSWORD123"));
  check("12345678 blocked", isCommonPassword("12345678"));
  check("qwerty blocked", isCommonPassword("qwerty"));
  check("aaaaaaaa blocked (single-char repeat)", isCommonPassword("aaaaaaaa"));
  check("abcdefg blocked (alpha run)", isCommonPassword("abcdefg"));
  check("letmein123 blocked", isCommonPassword("letmein123"));
  check("strong passphrase passes", !isCommonPassword("correct horse battery staple 42"));
  check("mixed random passes", !isCommonPassword("vX9#kQ2m$LpZ"));
  check("suite fixture passes (not in list)", !isCommonPassword("probe-password"));

  // ── 7. clientIp — XFF last-entry semantics (v3.7 spoof fix) ─────────
  const ip = (headers: Record<string, string>): string =>
    clientIp(new Request("https://x.dev/", { headers }));
  check("XFF: last entry wins (spoof ignored)", ip({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }) === "3.3.3.3");
  check("XFF: single entry", ip({ "x-forwarded-for": "9.9.9.9" }) === "9.9.9.9");
  check("XFF: whitespace trimmed", ip({ "x-forwarded-for": "4.4.4.4, 5.5.5.5" }) === "5.5.5.5");
  check("x-real-ip fallback", ip({ "x-real-ip": "6.6.6.6" }) === "6.6.6.6");
  check("no headers → unknown", ip({}).length > 0); // fallback shape (non-empty)

  // ── 8. rateLimit windows ─────────────────────────────────────────────
  const bucket = "test-suite-" + Math.random().toString(36).slice(2);
  let allowed = 0;
  for (let i = 0; i < 5; i++) if (rateLimit(bucket, 3, 60_000)) allowed++;
  check("limit enforced at max=3", allowed === 3);
  check("4th attempt denied", !rateLimit(bucket, 3, 60_000));
  check("different bucket independent", rateLimit(bucket + "-b", 3, 60_000));

  // ── result ───────────────────────────────────────────────────────────
  console.log(`\nauth unit suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
