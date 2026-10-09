"use client";

/**
 * digdeep browser storage — IndexedDB, per-user, per-browser.
 *
 * Everything (threads, turns, reports, sources, events) is saved HERE, in the
 * user's own browser. The server keeps only a transient working buffer while a
 * run is active; the browser DB is the source of truth for history and
 * completed work. Nothing is tied to a server account — each browser owns its
 * own data, which is exactly what "per each user" means for a keyless tool.
 */

import type { EventItem, SourceItem, SectionItem, JobItem, HistoryItem, Turn } from "@/components/research/types";

const DB_NAME = "digdeep";
const DB_VERSION = 2; // v2 (2026-10): turn-record normalization + meta store — see MIGRATIONS below
const TURNS = "turns"; // keyPath: jobId — full turn snapshots
const THREADS = "threads"; // keyPath: threadId — thread metadata
const META = "meta"; // keyPath: key — schema markers ("schema" → 2)

/**
 * MIGRATIONS ( IndexedDB `digdeep` )
 * v1 → v2 (2026-10): every existing turn record is normalized in place —
 *   `events`/`sources`/`sections` guaranteed arrays, `job.threadId` guaranteed
 *   present (null when the run had no thread), `savedAt` backfilled from
 *   `job.createdAt` when missing. A `meta` store is added and stamped with
 *   `schema: 2`. No record is dropped or rewritten beyond these defaults —
 *   threads survive the upgrade untouched.
 */

interface StoredTurn {
  jobId: string;
  threadId: string | null;
  savedAt: number;
  job: JobItem;
  events: EventItem[];
  sources: SourceItem[];
  sections: SectionItem[];
}

interface StoredThread {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastStatus: string;
  lastMode: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      const fromV = (ev as IDBVersionChangeEvent).oldVersion ?? 0;
      if (!db.objectStoreNames.contains(TURNS)) {
        const s = db.createObjectStore(TURNS, { keyPath: "jobId" });
        s.createIndex("threadId", "threadId");
        s.createIndex("savedAt", "savedAt");
      }
      if (!db.objectStoreNames.contains(THREADS)) {
        db.createObjectStore(THREADS, { keyPath: "threadId" });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
      // v1 → v2: normalize every existing turn record in place (arrays, threadId,
      // savedAt) so all readers can rely on shape. Safe: adds defaults only.
      if (tx && fromV === 1) {
        try {
          const store = tx.objectStore(TURNS);
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const rec = cursor.value as Partial<StoredTurn> & { job?: Partial<StoredTurn["job"]> & { threadId?: string | null; createdAt?: string | number | Date } };
              let changed = false;
              const next: StoredTurn = rec as StoredTurn;
              if (!Array.isArray(next.events)) { next.events = []; changed = true; }
              if (!Array.isArray(next.sources)) { next.sources = []; changed = true; }
              if (!Array.isArray(next.sections)) { next.sections = []; changed = true; }
              if (next.job) {
                if (next.job.threadId === undefined) { next.job.threadId = null; changed = true; }
              }
              if (next.threadId === undefined) { next.threadId = next.job?.threadId ?? null; changed = true; }
              if (typeof next.savedAt !== "number") {
                const c = next.job?.createdAt;
                next.savedAt = c ? new Date(c).getTime() || Date.now() : Date.now();
                changed = true;
              }
              if (changed) cursor.update(next);
              cursor.continue();
            }
          };
          tx.objectStore(META).put({ key: "schema", value: 2, migratedAt: Date.now() });
        } catch { /* normalization is best-effort — records stay readable either way */ }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/** Save/overwrite a full turn snapshot + refresh its thread metadata. */
export async function saveTurn(turn: Turn): Promise<void> {
  if (!turn.job) return;
  const rec: StoredTurn = {
    jobId: turn.jobId,
    threadId: turn.job.threadId ?? null,
    savedAt: Date.now(),
    job: turn.job,
    events: turn.events,
    sources: turn.sources,
    sections: turn.sections,
  };
  try {
    await tx(TURNS, "readwrite", (s) => s.put(rec));
    await upsertThread(rec);
  } catch {
    /* storage unavailable — degrade to server-only behavior */
  }
}

async function upsertThread(rec: StoredTurn): Promise<void> {
  if (!rec.threadId) return;
  const tid: string = rec.threadId; // capture so the guard survives into closures
  const db = await openDb();
  const existing: StoredThread | undefined = await new Promise((resolve) => {
    const t = db.transaction(THREADS, "readonly");
    const r = t.objectStore(THREADS).get(tid);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
  const meta: StoredThread = {
    threadId: tid,
    title: existing?.title ?? rec.job.query,
    createdAt: existing?.createdAt ?? (rec.job.createdAt ? new Date(rec.job.createdAt).getTime() : rec.savedAt),
    updatedAt: Math.max(existing?.updatedAt ?? 0, rec.savedAt),
    turnCount: (existing?.turnCount ?? 0) + (existing ? 0 : 1),
    lastStatus: rec.job.status,
    lastMode: rec.job.mode ?? "research",
  };
  await new Promise<void>((resolve) => {
    const t = db.transaction(THREADS, "readwrite");
    t.objectStore(THREADS).put(meta);
    t.oncomplete = () => resolve();
    t.onerror = () => resolve();
  });
}

/** Load one turn snapshot (jobId). */
export async function getTurn(jobId: string): Promise<Turn | null> {
  try {
    const rec = await tx<StoredTurn | undefined>(TURNS, "readonly", (s) => s.get(jobId));
    if (!rec) return null;
    return { jobId: rec.jobId, job: rec.job, events: rec.events, sources: rec.sources, sections: rec.sections };
  } catch {
    return null;
  }
}

/** All turns of a thread, oldest first. */
export async function getThreadTurns(threadId: string): Promise<Turn[]> {
  try {
    const db = await openDb();
    const recs = await new Promise<StoredTurn[]>((resolve, reject) => {
      const t = db.transaction(TURNS, "readonly");
      const idx = t.objectStore(TURNS).index("threadId");
      const r = idx.getAll(threadId);
      r.onsuccess = () => resolve(r.result as StoredTurn[]);
      r.onerror = () => reject(r.error);
    });
    return recs
      .sort((a, b) => new Date(a.job.createdAt).getTime() - new Date(b.job.createdAt).getTime())
      .map((rec) => ({ jobId: rec.jobId, job: rec.job, events: rec.events, sources: rec.sources, sections: rec.sections }));
  } catch {
    return [];
  }
}

function toHistoryItem(rec: StoredTurn): HistoryItem {
  const j = rec.job;
  return {
    id: j.id,
    query: j.query,
    threadId: j.threadId ?? null,
    status: j.status,
    stage: j.stage,
    progress: j.progress,
    preset: j.preset,
    mode: j.mode,
    createdAt: j.createdAt,
    completedAt: j.completedAt ?? null,
    modelPref: j.modelPref,
  };
}

/** Recent history — latest turn per thread, newest first. */
export async function listHistory(limit = 60): Promise<HistoryItem[]> {
  try {
    const db = await openDb();
    const recs = await new Promise<StoredTurn[]>((resolve, reject) => {
      const t = db.transaction(TURNS, "readonly");
      const r = t.objectStore(TURNS).getAll();
      r.onsuccess = () => resolve(r.result as StoredTurn[]);
      r.onerror = () => reject(r.error);
    });
    const latestPerThread = new Map<string, StoredTurn>();
    for (const rec of recs) {
      const key = rec.threadId ?? `single:${rec.jobId}`;
      const cur = latestPerThread.get(key);
      if (!cur || rec.savedAt > cur.savedAt) latestPerThread.set(key, rec);
    }
    return [...latestPerThread.values()]
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, limit)
      .map(toHistoryItem);
  } catch {
    return [];
  }
}

/** Delete one turn. Returns its threadId (for cleanup) or null. */
export async function deleteTurn(jobId: string): Promise<string | null> {
  try {
    const rec = await tx<StoredTurn | undefined>(TURNS, "readonly", (s) => s.get(jobId));
    await tx(TURNS, "readwrite", (s) => s.delete(jobId));
    return rec?.threadId ?? null;
  } catch {
    return null;
  }
}

/** Delete every turn in a thread + the thread metadata. */
export async function deleteThread(threadId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const t = db.transaction([TURNS, THREADS], "readwrite");
      const turns = t.objectStore(TURNS);
      const idx = turns.index("threadId");
      const cursorReq = idx.openCursor(IDBKeyRange.only(threadId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      t.objectStore(THREADS).delete(threadId);
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/** Wipe ALL browser-stored digdeep data. */
export async function clearAll(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const t = db.transaction([TURNS, THREADS], "readwrite");
      t.objectStore(TURNS).clear();
      t.objectStore(THREADS).clear();
      t.oncomplete = () => resolve();
      t.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  }
}

/** Mark a turn that the server no longer knows (e.g. after a server restart). */
export async function orphanTurn(jobId: string, note: string): Promise<Turn | null> {
  const existing = await getTurn(jobId);
  if (!existing?.job) return null;
  const job: JobItem = {
    ...existing.job,
    status: "cancelled",
    stage: "Interrupted",
    completedAt: new Date().toISOString(),
    error: note,
  };
  const updated: Turn = { ...existing, job };
  await saveTurn(updated);
  return updated;
}
