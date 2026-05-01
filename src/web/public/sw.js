// Paper Hoard service worker — offline shell, with extra coverage for the
// scan flow so the camera UI works on a totally dead cellular signal in
// a basement bookstore.
//
// IMPORTANT: bump the CACHE name every release that touches /static/
// assets. Combined with the stale-while-revalidate fetch handler below,
// existing clients pick up the new bundle on their next page load — no
// hard-refresh / "clear site data" required.
const CACHE = "ph-shell-v4";
const PRECACHE = [
  "/",
  "/scan",
  "/static/style.css",
  "/static/ui.js",
  "/static/icon.svg",
  "/static/zxing-browser.min.js",
  "/scan/cache.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      // addAll fails atomically; fall back to per-URL adds so a single
      // miss (e.g. user not logged in for cache.json) doesn't poison
      // the install.
      Promise.all(
        PRECACHE.map((url) =>
          fetch(url, { credentials: "same-origin" })
            .then((r) => (r.ok ? c.put(url, r.clone()) : undefined))
            .catch(() => undefined)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // /scan/cache.json — stale-while-revalidate so the field-lookup chip
  // works instantly offline AND eventually refreshes when online.
  if (url.pathname === "/scan/cache.json") {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetched = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetched;
      })
    );
    return;
  }

  // Network-first for HTML so the user sees fresh content when online.
  if (req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/scan") || caches.match("/")))
    );
    return;
  }
  // Stale-while-revalidate for /static/ + /uploads/ — serve the cached
  // copy immediately for snappiness, but refresh in the background so
  // the next visit gets the latest CSS/JS. Old strategy was cache-first
  // with no revalidation, which left users stuck on stale style.css and
  // ui.js for as long as the cache name held — the v3.5.22 hamburger
  // menu hit this: HTML updated to reference a new ☰ button but cached
  // ui.js had no handler for it, so taps did nothing.
  if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/uploads/")) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetched = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetched;
      })
    );
  }
});
