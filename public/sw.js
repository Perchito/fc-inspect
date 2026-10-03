// FC Inspect service worker: network first for the app's own files, falling back to
// the last copy so the app still opens with no signal. API calls are never cached
// (unsent photos/notes live in IndexedDB, see outbox in inspect.js).
const CACHE = 'fci-shell';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        // keep only the newest ?v= copy of each file
        for (const old of await cache.keys()) {
          if (new URL(old.url).pathname === url.pathname && old.url !== e.request.url) cache.delete(old);
        }
        cache.put(e.request, res.clone());
      }
      return res;
    } catch {
      return (await cache.match(e.request)) || (e.request.mode === 'navigate' && (await cache.match('/'))) || Response.error();
    }
  })());
});
