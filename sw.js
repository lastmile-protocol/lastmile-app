// Cache everything on first visit, then never need the network again.
// An app about bad connectivity that refuses to open on a bad connection would
// be a poor joke.
const V = 'lastmile-v5';
// Core offline bundle: must include all scripts and static assets
const FILES = [
  './', './index.html', './app.js', './lastmile.js', './store.js', './qr.js', './cash.js', './ramp.js',
  './manifest.webmanifest', './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first. The app is self-contained, so the network is never the better answer.
// Freshness is preserved by bypassing the cache exclusively for dynamic anchor & relayer APIs.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Somebody else's server is not ours to cache. It matters most for an anchor's
  // stellar.toml: that file is where the wallet learns which key to trust, and a
  // cached copy of it would mean a rotated or revoked key kept being believed.
  // Freshness there is the security property, so this never touches it.
  if (url.origin !== self.location.origin) return;
  // Banking asks the network a question only the network can answer. A cached
  // "yes, already banked" would be worse than no answer at all. All /api/ requests
  // bypass the service worker cache unconditionally.
  if (url.pathname.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
