"use client";

import { useEffect, useState } from "react";

/**
 * Offline awareness for every screen — one shared hook so the whole app
 * reacts to the browser going offline consistently. Values:
 *  - "online"  — navigator says we have a connection
 *  - "offline" — no connection; screens that need the server say so and
 *                offer local recovery actions instead of a dead spinner.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}
