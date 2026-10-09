"use client";

import { useEffect } from "react";
import { watchJob, activeJobIds } from "@/lib/live-poller";
import { setFaviconState, initFaviconManager } from "@/lib/favicon";
import type { Turn } from "@/components/research/types";
import { ACTIVE_STATUSES } from "@/components/research/types";

/**
 * Global job signals — mounted once in the shell, survives every route
 * change. While any registered run is active the tab icon pulses green;
 * when a run completes (or fails) the icon flips to a fixed blue dot and —
 * if the tab is hidden — a browser notification fires. Watching continues
 * even after the thread page unmounts, because this component keeps the
 * poller alive for every job it has seen active.
 */
export function JobSignals() {
  useEffect(() => {
    initFaviconManager();

    const prevStatus = new Map<string, string>();
    const unwatches = new Map<string, () => void>();
    let sawFinish = false;

    const onFinished = (id: string, turn: Turn) => {
      sawFinish = true;
      setFaviconState("done");
      const query = turn.job?.query ?? "Your research";
      const failed = turn.job?.status === "failed";
      try {
        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
          const n = new Notification(failed ? "Research failed" : "Research complete", {
            body: failed
              ? `${query}\n${(turn.job?.error ?? "").slice(0, 120)}`
              : `${query}\nYour report is ready.`,
            tag: id,
            icon: "/brand/mark-badge.png",
          });
          n.onclick = () => {
            window.focus();
            const tid = turn.job?.threadId;
            window.location.href = tid ? `/r/${tid}` : `/r/${id}`;
            n.close();
          };
        }
      } catch { /* notifications can throw on some platforms — never fatal */ }
    };

    const handleUpdate = (id: string, turn: Turn) => {
      const status = turn.job?.status ?? "";
      const prev = prevStatus.get(id);
      prevStatus.set(id, status);
      const wasActiveish = !prev || prev === "" || ACTIVE_STATUSES.includes(prev);
      const nowFinished = status !== "" && !ACTIVE_STATUSES.includes(status);
      if (wasActiveish && nowFinished) onFinished(id, turn);
      if (nowFinished && unwatches.has(id)) {
        unwatches.get(id)?.();
        unwatches.delete(id);
      }
    };

    const scan = () => {
      const ids = activeJobIds();
      let anyActive = false;
      for (const id of ids) {
        anyActive = true;
        if (!unwatches.has(id)) {
          const un = watchJob(id, (turn) => handleUpdate(id, turn));
          unwatches.set(id, un);
        }
      }
      setFaviconState(anyActive ? "working" : sawFinish ? "done" : "idle");
    };

    const iv = setInterval(scan, 1000);
    scan();

    return () => {
      clearInterval(iv);
      for (const un of unwatches.values()) un();
      setFaviconState("idle");
    };
  }, []);

  return null;
}
