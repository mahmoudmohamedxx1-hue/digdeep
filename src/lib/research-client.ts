"use client";

import type { AttachedDoc } from "@/components/research/types";
import { useSettings, requestNotificationPermission } from "@/lib/store";
import { registerJob } from "@/lib/live-poller";

/**
 * Start a research run from anywhere (home composer, follow-up box, related
 * question, Discover card). Returns the job + thread ids so the caller can
 * navigate to the thread route.
 *
 * v3.6: chatting requires an account — when the server answers 401 with
 * code "auth_required", the result carries authRequired: true so callers can
 * route to /account (with ?next= back-navigation) instead of showing a dead
 * error toast.
 */
export async function startResearchRun(opts: {
  query: string;
  /** null/undefined = fresh thread (home box); a string = follow-up in that thread */
  threadId?: string | null;
  docs?: AttachedDoc[];
}): Promise<{ id: string; threadId: string } | { error: string; authRequired?: boolean }> {
  const question = opts.query.trim();
  if (question.length < 2) return { error: "Please enter a research question first" }; // v3.0.2: 2-char floor

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
        court: s.court,
        domain: s.domain,
        ...(useDocs.length > 0 ? { docs: useDocs } : {}),
        ...s.adv,
      }),
    });
    const d = await r.json();
    if (d.id) {
      registerJob(d.id, { jobId: d.id, job: null, events: [], sources: [], sections: [] });
      return { id: d.id as string, threadId: (d.threadId as string) ?? useTid };
    }
    if (r.status === 401 || d.code === "auth_required") {
      return { error: d.error ?? "Sign in to chat", authRequired: true };
    }
    return { error: d.error ?? "Could not start research" };
  } catch {
    return { error: "Network error — check your connection and try again" };
  }
}
