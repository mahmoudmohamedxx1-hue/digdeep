import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// DigDeep on Cloudflare Workers (free-plan profile).
// Notes:
// - The research engine's long-running slices run inside waitUntil()/after();
//   wall-clock is dominated by LLM I/O waits, not CPU.
// - Incremental cache is not configured: reports are served from Postgres
//   (ResearchJob rows), not the ISR cache, so the default no-cache behavior
//   is correct for this app.
export default defineCloudflareConfig();
