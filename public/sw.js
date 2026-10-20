/* DigDeep service worker — P2-4 PWA.
 * Strategy: network-first for pages/API (research data must be fresh),
 * cache-first only for immutable static assets (_next/static, fonts, icons).
 * Offline: the offline page + cached shell let the user read their local
 * (IndexedDB) history even with no connection.
 */
const VERSION = "digdeep-v3.3.0";
const STATIC_CACHE = `${VERSION}-static`;
const PAGE_CACHE = `${VERSION}-pages`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((c) => c.addAll(["/offline/", "/"]).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // immutable build assets — cache-first, they never change
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/fonts/") || url.pathname === "/logo.svg" || url.pathname === "/manifest.webmanifest" || /^\/(icon-(192|512)|apple-touch-icon)\.png$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // live research data — always the network
  if (url.pathname.startsWith("/api/")) return;

  // pages — network-first with offline fallback (the app itself is offline-first via IDB)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(req);
        return cached || caches.match("/offline/") || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      })
    );
  }
});
