"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Offline awareness for every screen — one shared hook so the whole app
 * reacts to the browser going offline consistently. Values:
 *  - true  — navigator says we have a connection (also the SSR default)
 *  - false — no connection; screens that need the server say so and offer
 *            local recovery actions instead of a dead spinner.
 *
 * useSyncExternalStore keeps SSR and client in agreement without
 * state-setting effects.
 */
function subscribe(onStoreChange: () => void) {
  window.addEventListener("online", onStoreChange);
  window.addEventListener("offline", onStoreChange);
  return () => {
    window.removeEventListener("online", onStoreChange);
    window.removeEventListener("offline", onStoreChange);
  };
}

export function useOnline(): boolean {
  const getSnapshot = useCallback(() => navigator.onLine, []);
  const getServerSnapshot = useCallback(() => true, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
