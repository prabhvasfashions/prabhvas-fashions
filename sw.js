// Prabhvas Fashions — storefront service worker.
//
// This exists to make the storefront installable as an app on Android/iOS
// (Chrome/Edge require a service worker with a fetch handler before they'll
// offer the install prompt) and to give a basic offline fallback. It is
// deliberately "network-first" for everything it touches, never
// "cache-first" — the catalog (categories.json/products.json/settings.json)
// changes whenever the shop owner publishes, and this must never show a
// shopper a stale price, stale stock count, or an old hero photo just
// because a service worker cached it. The cache here is purely a fallback
// for when the network is unavailable, refreshed from the network on every
// successful request.
//
// Bump CACHE_NAME any time this file's caching behaviour changes, so
// visitors on an old cached version pick up the new one cleanly.
const CACHE_NAME = "prabhvas-shell-v1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/favicon-32.png",
  "./assets/favicon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/logo-header.png",
  "./assets/logo-hero.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {}) // a missing/renamed asset shouldn't block install
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept anything but simple same-origin page loads: leave
  // POSTs (order/review/visitor submissions), the Worker API, WhatsApp
  // links, and Google Fonts to behave exactly as they would with no
  // service worker at all.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
