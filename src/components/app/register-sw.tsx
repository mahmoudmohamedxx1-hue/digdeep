"use client";

import { useEffect } from "react";

/** P2-4: register the service worker (static asset caching + offline fallback). */
export function RegisterSW() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const t = setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* SW is an enhancement — never block the app */
      });
    }, 1200);
    return () => clearTimeout(t);
  }, []);
  return null;
}
