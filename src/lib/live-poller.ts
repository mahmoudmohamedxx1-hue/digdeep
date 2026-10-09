"use client";

import type { EventItem, JobItem, SectionItem, SourceItem, Turn } from "@/components/research/types";
import { ACTIVE_STATUSES } from "@/components/research/types";
import { saveTurn, orphanTurn } from "@/lib/idb-store";

/**
 * The live poller — ONE loop for the whole app.
 *
 * Every active research run is registered here exactly once (module-level
 * singleton, survives route changes). The thread page subscribes for full
 * rendering; the global JobSignals component subscribes for favicon state +
 * browser notifications; completed turns are persisted to IndexedDB by the
 * poller itself, so nothing is lost when a page unmounts mid-run.
 */

type Subscriber = (turn: Turn, active: boolean) => void;

const state = new Map<string, Turn>();
const subs = new Map<string, Set<Subscriber>>();
const sinceSeq = new Map<string, number>();
const orphans = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function isActive(t: Turn): boolean {
  return !t.job || ACTIVE_STATUSES.includes(t.job.status);
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    for (const [jid, cur] of state) {
      // finished runs are never re-polled — the final update (delivered on the
      // tick that saw them finish) is the last one subscribers ever get, so a
      // completed report's DOM stays perfectly still (hover cards keep working)
      if (!isActive(cur)) continue;
      try {
        const since = sinceSeq.get(jid) ?? 0;
        const r = await fetch(`/api/research/${jid}?sinceSeq=${since}`);
        if (r.status === 404) {
          if (!orphans.has(jid)) {
            orphans.add(jid);
            const upd = await orphanTurn(jid, "The server restarted — this run was interrupted. Everything gathered so far is kept in this browser.");
            if (upd) { state.set(jid, upd); notify(jid); }
          }
          continue;
        }
        if (!r.ok) continue;
        const d = await r.json();
        const seen = new Set(cur.events.map((e) => e.seq));
        const add = (d.events ?? [] as EventItem[]).filter((e: EventItem) => !seen.has(e.seq));
        const u: Turn = {
          ...cur,
          job: d.job as JobItem,
          sources: (d.sources ?? []) as SourceItem[],
          sections: (d.sections ?? []) as SectionItem[],
          events: [...cur.events, ...add].sort((a, b) => a.seq - b.seq),
        };
        state.set(jid, u);
        if (d.events?.length) sinceSeq.set(jid, Math.max(since, ...d.events.map((e: EventItem) => e.seq)));
        if (u.job && !ACTIVE_STATUSES.includes(u.job.status)) {
          await saveTurn(u); // persist the finished run to this browser
        }
        notify(jid);
      } catch { /* transient network hiccup — next tick retries */ }
    }
    maybeStopTimer(); // everything finished → the loop parks itself
  } finally {
    inFlight = false;
  }
}

function notify(jid: string) {
  const t = state.get(jid);
  if (!t) return;
  for (const cb of subs.get(jid) ?? []) cb(t, isActive(t));
}

function ensureTimer() {
  if (timer != null || typeof window === "undefined") return;
  let anyActive = false;
  for (const t of state.values()) if (isActive(t)) { anyActive = true; break; }
  if (!anyActive) return; // nothing to poll — the loop stays off until a live run registers
  timer = setInterval(() => void tick(), 1200);
}

function maybeStopTimer() {
  // the loop only exists to poll ACTIVE runs — with none left, stop it
  // (a fresh registerJob restarts it instantly)
  let anyActive = false;
  for (const t of state.values()) if (isActive(t)) anyActive = true;
  if (timer != null && !anyActive) {
    clearInterval(timer);
    timer = null;
  }
}

/** Register a run to be polled. `seed` primes the state (e.g. the optimistic
 *  turn created right after POST, or the IndexedDB copy when reopening). */
export function registerJob(jobId: string, seed?: Turn) {
  const existing = state.get(jobId);
  if (existing && seed && seed.job) {
    // prefer whichever copy knows more
    if ((seed.job.status ?? "") !== "queued" && existing.job == null) state.set(jobId, seed);
  } else if (!existing && seed) {
    state.set(jobId, seed);
  } else if (!existing) {
    state.set(jobId, { jobId, job: null, events: [], sources: [], sections: [] });
  }
  const maxSeq = state.get(jobId)?.events.reduce((m, e) => Math.max(m, e.seq), 0) ?? 0;
  sinceSeq.set(jobId, Math.max(sinceSeq.get(jobId) ?? 0, maxSeq));
  ensureTimer();
}

/** Subscribe to a run's updates. Returns the unwatch function. */
export function watchJob(jobId: string, cb: Subscriber): () => void {
  let set = subs.get(jobId);
  if (!set) { set = new Set(); subs.set(jobId, set); }
  set.add(cb);
  registerJob(jobId);
  const cur = state.get(jobId);
  if (cur) cb(cur, isActive(cur));
  return () => {
    const s = subs.get(jobId);
    if (s) { s.delete(cb); if (s.size === 0) subs.delete(jobId); }
    maybeStopTimer();
  };
}

/** Snapshot of a registered run (or undefined). */
export function getJob(jobId: string): Turn | undefined {
  return state.get(jobId);
}

/** Wipe a run's accumulated state (used after a retry — the server restarts
 *  the event stream from seq 1). */
export function resetJob(jobId: string) {
  state.set(jobId, { jobId, job: null, events: [], sources: [], sections: [] });
  sinceSeq.set(jobId, 0);
  orphans.delete(jobId);
  ensureTimer();
  notify(jobId);
}

/** All currently active job ids — for the global favicon state. */
export function activeJobIds(): string[] {
  const out: string[] = [];
  for (const [jid, t] of state) if (isActive(t)) out.push(jid);
  return out;
}
