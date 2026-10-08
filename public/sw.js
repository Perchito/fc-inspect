// FC Inspect service worker.
// - App files: network first, last copy when offline, so the app opens with no signal.
// - API reads (GET /api/...): network first, cached copy when offline, so lists and inspections
//   already seen still open. Writes never touch the cache — unsent work lives in the IndexedDB outbox.
// - Photos never change once taken: cache first.
// The app deletes the API + photo caches on logout.
const SHELL = 'fci-shell', API = 'fci-api', PHOTOS = 'fci-photos';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function networkFirst(req, cacheName, { prune = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) {
      if (prune) { // keep only the newest ?v= copy of each app file
        const path = new URL(req.url).pathname;
        for (const old of await cache.keys()) if (new URL(old.url).pathname === path && old.url !== req.url) cache.delete(old);
      }
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return (await cache.match(req)) || (req.mode === 'navigate' && (await caches.open(SHELL).then((c) => c.match('/')))) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/photos/')) {
    e.respondWith(caches.open(PHOTOS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
  } else if (url.pathname.endsWith('/pdf')) {
    return; // always fresh
  } else if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(req, API));
  } else {
    e.respondWith(networkFirst(req, SHELL, { prune: true }));
  }
});

// ── phone pop-up notifications (Web Push) ──
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New notification', {
    body: d.body || '', icon: '/img/icon-192.png', badge: '/img/icon-192.png', tag: d.tag || undefined, data: { link: d.link || '/' },
  }));
});
// tapping it opens the app (or the open window) on the right screen
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = e.notification.data?.link || '/';
  const url = new URL(link.startsWith('#') ? `/${link}` : link, self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus(); return w.navigate(url).catch(() => w.postMessage({ go: link })); }
    return self.clients.openWindow(url);
  })());
});
