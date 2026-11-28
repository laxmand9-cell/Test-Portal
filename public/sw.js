/* Test Portal app worker: keeps the app's screens on the phone so it opens fast,
   and always fetches marks and results fresh from the server (never stored). */
const VERSION = "tp-2026-11-28-4";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/vendor/omr_core.js", "/vendor/sheet_render.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return; // results: always live
  // app screens: try the network first (so updates show up), fall back to the stored copy when offline
  e.respondWith(
    fetch(req, SHELL.includes(url.pathname) ? { cache: "no-cache" } : undefined).then(res => {
      if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/icons/"))) {
        const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(r => r || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())))
  );
});
