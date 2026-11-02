/* Cache somente do shell público do aplicativo. Dados de conta e API ficam sempre na rede. */
const CACHE_NAME = 'coruja-app-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/logo.png',
  '/icons/coruja-180.png',
  '/icons/coruja-192.png',
  '/icons/coruja-512.png'
];
const SHELL_PATHS = new Set(SHELL_ASSETS.slice(1));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('coruja-app-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('authorization')) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/uploads' || url.pathname.startsWith('/uploads/')) return;
  if (url.pathname === '/service-worker.js' || url.pathname === '/login' || url.pathname === '/callback') return;

  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') && !url.search) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) await (await caches.open(CACHE_NAME)).put('/', response.clone());
        return response;
      } catch {
        return (await caches.match('/')) || new Response('CORUJA está offline no momento.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  if (!url.search && SHELL_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) {
        fetch(request).then(async response => {
          if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
        }).catch(() => {});
        return cached;
      }
      const response = await fetch(request);
      if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
      return response;
    })());
  }
});
