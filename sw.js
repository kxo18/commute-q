/* Commute Queue offline support.
   App files: served from cache instantly, refreshed in the background (changes show on the next open).
   Daily picks: network first so mornings are fresh, cached copy when there's no signal. */
const VERSION = 'cq-1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'manifest.webmanifest',
  'data/library.json', 'data/daily.json',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req, timeoutMs) {
  return caches.open(VERSION).then(cache => {
    const net = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
    return Promise.race([net, timeout.then(() => cache.match(req, { ignoreSearch: true }))])
      .then(res => res || net)
      .catch(() => cache.match(req, { ignoreSearch: true }));
  });
}

function staleWhileRevalidate(req) {
  return caches.open(VERSION).then(cache =>
    cache.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.includes('/data/')) {
    e.respondWith(networkFirst(req, 4000));
  } else if (sameOrigin || url.host.endsWith('fonts.googleapis.com') || url.host.endsWith('fonts.gstatic.com')) {
    e.respondWith(staleWhileRevalidate(req));
  }
});
