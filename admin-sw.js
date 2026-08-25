// Prabhvas Fashions — admin panel service worker.
//
// Exists only so the admin panel can be installed as an app on your phone
// (Chrome/Edge require a service worker before offering the install
// prompt). It deliberately does NOT cache anything beyond the bare app
// shell needed to open the page — your orders, products, and customer data
// must always come straight from the live API, never from a cache, so
// there is no risk of the admin panel ever showing you stale business
// data. Scoped to admin.html only, so it has no effect on the storefront.
const CACHE_NAME = "prabhvas-admin-shell-v1";

const PRECACHE_URLS = [
  "./admin.html",
  "./admin-manifest.webmanifest",
  "./assets/favicon-32.png",
  "./assets/admin-icon-192.png",
  "./assets/admin-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {})
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

  // Only ever touch the admin.html shell itself — every API call goes to a
  // different origin (the Worker) and is untouched by this handler either
  // way, but being explicit here keeps this file honest about its one job.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.endsWith("/admin.html")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
