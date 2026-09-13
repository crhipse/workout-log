'use strict';

/* 네트워크 우선, 실패 시 캐시 — 오프라인에서도 앱이 열리게 함 */
const CACHE = 'workout-v2';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './life-sync.mjs',
  './xlsx.full.min.js', './manifest.json', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('workout-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.open(CACHE).then(cache => cache.match(e.request, { ignoreSearch: true })
          .then(res => res || (e.request.mode === 'navigate' ? cache.match('./index.html') : Response.error())))
      )
  );
});
