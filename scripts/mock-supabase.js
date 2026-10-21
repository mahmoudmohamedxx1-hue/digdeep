/**
 * Mock Supabase Auth server for deterministic E2E verification of the v3.5
 * email-OTP flow (scripts/test-standalone.sh step 17). Implements exactly the
 * two endpoints DigDeep calls, with production-shaped responses:
 *
 *   POST /auth/v1/otp    { email, create_user: true } → 200 {}
 *   POST /auth/v1/verify { email, token, type: "email" }
 *        token 246810  → 200 { access_token, user: { id, email } }
 *        anything else → 400 { code: 400, error_code: "otp_expired",
 *                               msg: "Email link is invalid or has expired" }
 *        (production Supabase returns the same error_code for wrong AND
 *        expired codes — the app maps both to one user-facing message)
 *
 * Auth: requests must carry the apikey header matching the test anon key.
 * Run: node scripts/mock-supabase.js  (listens on 127.0.0.1:3199)
 */
const http = require("http");

const PORT = 3199;
const EXPECTED_KEY = "test-anon-key-0123456789abcdef"; // >20 chars: the app sanity-checks key length
const sent = new Map(); // email -> send count (for logs/assertions)

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith("/auth/v1/") || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.apikey !== EXPECTED_KEY) {
      return json(401, { msg: "Invalid API key" });
    }
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      /* empty body handled by per-endpoint validation */
    }
    const email = String(parsed.email || "").toLowerCase();

    if (req.url === "/auth/v1/otp") {
      if (!email) return json(400, { code: 400, msg: "Email is required" });
      if (parsed.create_user !== true) return json(400, { msg: "mock expects create_user" });
      sent.set(email, (sent.get(email) || 0) + 1);
      console.log(`[mock-supabase] otp → ${email} (#${sent.get(email)})`);
      return json(200, {});
    }

    if (req.url === "/auth/v1/verify") {
      if (String(parsed.type || "") !== "email") return json(400, { msg: "mock expects type email" });
      const token = String(parsed.token || "");
      if (token === "246810") {
        console.log(`[mock-supabase] verify OK → ${email}`);
        return json(200, {
          access_token: "mock-access-token",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "mock-refresh-token",
          user: {
            id: "mock-auth-" + Buffer.from(email).toString("hex").slice(0, 12),
            email,
            aud: "authenticated",
          },
        });
      }
      console.log(`[mock-supabase] verify REJECT → ${email} (token ${token})`);
      return json(400, { code: 400, error_code: "otp_expired", msg: "Email link is invalid or has expired" });
    }

    return json(404, { msg: "Not found" });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-supabase] listening on 127.0.0.1:${PORT}`));
