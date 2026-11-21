// The shop screen's service worker (Plan 40B). It keeps the /tv page and
// its hashed assets, so that a screen that restarts without a network still
// opens the player, which then shows its saved copy of the board. It never
// keeps a /v1 answer: the player keeps its own saved feed.
const CACHE = "pantry-tv-v1";

// The page and every asset that it names: the first load of the page runs
// before this worker controls it, so the worker keeps them itself.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const page = await fetch("/tv", { cache: "no-store" });
      if (!page.ok) throw new Error("The screen page is unavailable");
      const html = await page.clone().text();
      const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? [])];
      await cache.put("/tv", page);
      await cache.addAll(assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/")) return;
  if (request.mode === "navigate") {
    // The page itself: the network first, so that a new release of the
    // player arrives; the kept page when the network is down.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put("/tv", copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match("/tv", { ignoreVary: true })
            .then((kept) => kept ?? Response.error()),
        ),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname === "/tv.webmanifest") {
    // Hashed assets never change: the kept copy first. A server may answer
    // with `Vary: Origin`, and a module script's request carries an Origin
    // that the kept request lacks, so the lookup ignores Vary.
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then(
        (kept) =>
          kept ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
