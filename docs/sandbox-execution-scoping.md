# Sandboxed Code Execution for Research Agents — Scoping Document

**Status:** scoped, not yet built · **Owner:** DigDeep · **Date:** v3.2
**Trigger:** user request to integrate `perplexityai/SPACE` "to make the experience really different."

---

## 1. What was assessed

[`perplexityai/SPACE`](https://github.com/perplexityai/SPACE) — the **Sandboxed Platform for Agentic Code Execution**:
a Rust control-plane that boots **Firecracker microVMs** on bare-metal hosts and exposes an HTTP API
(`POST /sandboxes`, `POST /sandboxes/{id}/commands`, snapshot/restore, async output over a data plane).
Applications embed it when their agents need to run untrusted code in isolated Linux environments.

**What it is NOT:** a UI library, a chat renderer, or anything user-visible. It changes nothing about how
DigDeep looks — it would change what research agents can *do*.

**Hard constraint:** Firecracker requires `/dev/kvm` on a bare-metal or nested-virt host. **Vercel cannot run it.**
Any SPACE-based feature is necessarily a separate, self-hosted service.

## 2. Why DigDeep research agents would want it

Today the pipeline is read→summarize→verify. A code sandbox unlocks a *computational* lane:

| Capability | Concrete DigDeep use | Value |
|---|---|---|
| **Data extraction & math** | A source links a CSV/JSON dataset — the agent downloads it into a sandbox, computes real statistics instead of paraphrasing prose | No more "according to the source, X%" — we compute X |
| **Claim verification by recomputation** | For numeric claims (market sizes, growth rates, survey percentages), recompute from the cited tables and compare | Turns "supported/unsupported" into "verified: 8.4% vs claimed 9%" |
| **Chart-grade evidence** | Produce tidy data tables (JSON→CSV) that the report can chart, with the generating script committed as provenance | Reports gain reproducible evidence |
| **JS-heavy page reading** | Headless Chromium in the sandbox executes the page, agent reads the rendered DOM | Sources that are blank HTML today become readable |
| **Attachment parsing** | Users attach XLSX/PDF/DOCX ground-truth docs — parse them properly with real libraries in the sandbox | Robust doc-QA lane |

## 3. Architecture options (ranked)

### Option A — SPACE, self-hosted (what was requested)
- **Shape:** 1–2 dedicated hosts (Hetzner AX102 / OVH / Fly.io bare-metal) running the SPACE control plane; DigDeep's research engine calls its HTTP API to create a sandbox per research run, stream commands, tear down on completion.
- **Pros:** real VM isolation (kernel boundary), snapshot/restore = cheap sandboxes per run, purpose-built for exactly this, Apache-2.0.
- **Cons:** +1 always-on infra to own (rust toolchain, upgrades, monitoring); KVM hosts cost ~€50–80/mo; latency to boot/restore ~hundreds of ms (fine for research runs).
- **Fit:** right choice once usage justifies dedicated hardware.

### Option B — Fly.io Machines / per-run VMs (pragmatic middle)
- **Shape:** a small "worker" container image (Python + pandas + headless-chromium optional) launched per research run via the Fly Machines API; the image contains OUR agent tooling, no SPACE needed.
- **Pros:** no hardware to own, per-second billing, fast-boot (≈300ms with Firecracker under Fly), same VM-class isolation.
- **Cons:** vendor coupling; outbound scraping IPs shared; egress costs.
- **Fit:** fastest path to production with real isolation. **Recommended Phase 1.**

### Option C — E2B / Modal / CodeInterpreter SDK (managed)
- **Shape:** drop-in SDK; per-run sandboxes as an API call.
- **Pros:** zero infra; minutes to integrate.
- **Cons:** per-run cost scales with usage; another third party in the data path; less control over the toolchain (custom libs, Chromium).
- **Fit:** experiment tier / fallback if Phase 1 load is low.

### Option D — In-process isolation (wasmer/V8 isolates, no VM)
- **Cons for us:** no real filesystem/network policy flexibility, no pandas/chromium; unsuitable for data work.
- **Verdict:** rejected.

## 4. Recommended plan (phased)

**Phase 0 — product wiring (in DigDeep itself, no sandbox yet):**
- Add a `code` tool to the research engine's tool loop (alongside read/verify): emit Python snippets + expected outputs, store them in the job record as *provenance*.
- Report UI renders code/verified-number blocks. This ships visible value before any infra.

**Phase 1 — Fly Machines worker (Option B):**
- `POST /api/execution` → mTLS-authenticated internal call → Fly Machine runs `agent-code-runner` (FastAPI: run snippet ≤10s, ≤512MB, no egress except a fetched allow-listed source URL), returns stdout/stderr/artifacts.
- Engine uses it for: dataset stats, claim recomputation, attachment parsing.
- Budget guard: max N sandbox-seconds per research run (preset-scaled), hard 15s timeout, queue depth cap.
- Security: per-run ephemeral VM, no secrets inside, allow-listed fetch, output size caps, all executions logged to the job record (user-visible provenance).

**Phase 2 — SPACE on dedicated hardware (Option A):**
- When monthly Fly execution spend > a dedicated host's cost, move to SPACE: same HTTP contract the engine already speaks (wrap both behind our `/api/execution` gateway), gain snapshot/restore pooling and zero marginal cloud cost.

## 5. Cost & effort estimate

| Phase | Eng. effort | Run cost | Notes |
|---|---|---|---|
| 0 | 2–3 days | 0 | pure app work |
| 1 | ~1 week | ~$0.003–0.02 per run (seconds of VM time) | Fly Machines, 1 region |
| 2 | ~1 week + ops | €50–80/mo fixed | SPACE host(s) |

## 6. Decision requested

1. Approve Phase 0+1 (Fly-based) — recommended; ships the computational-evidence lane with real isolation and no hardware.
2. Or hold until usage grows — the scoping above stays valid; nothing in the current app blocks on it.
