"use client";

import type { AttachedDoc } from "@/components/research/types";
import { useSettings, requestNotificationPermission } from "@/lib/store";
import { registerJob } from "@/lib/live-poller";

/**
 * Start a research run from anywhere (home composer, follow-up box, related
 * question, Discover card). Returns the job + thread ids so the caller can
 * navigate to the thread route.
 */
export async function startResearchRun(opts: {
  query: string;
  /** null/undefined = fresh thread (home box); a string = follow-up in that thread */
  threadId?: string | null;
  docs?: AttachedDoc[];
}): Promise<{ id: string; threadId: string } | { error: string }> {
  const question = opts.query.trim();
  if (question.length < 3) return { error: "Please enter a research question first" };

  const s = useSettings.getState();
  const useTid =
    opts.threadId ??
    (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}`);
  const useDocs = (opts.docs ?? []).filter((d) => d.text.trim().length > 0);

  requestNotificationPermission();

  try {
    const r = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: question,
        preset: s.mode === "custom" ? "standard" : s.mode,
        language: s.language,
        modelPref: s.modelPref,
        threadId: useTid,
        ...(useDocs.length > 0 ? { docs: useDocs } : {}),
        ...s.adv,
      }),
    });
    const d = await r.json();
    if (d.id) {
      registerJob(d.id, { jobId: d.id, job: null, events: [], sources: [], sections: [] });
      return { id: d.id as string, threadId: (d.threadId as string) ?? useTid };
    }
    return { error: d.error ?? "Could not start research" };
  } catch {
    return { error: "Network error — check your connection and try again" };
  }
}
