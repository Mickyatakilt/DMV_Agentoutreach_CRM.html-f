/* Mestate CRM service worker — installability + fast app-shell load.
   DATA SAFETY: Supabase (and any API) calls are NEVER cached — always live network.
   Only the static app shell (HTML + icons + manifest) is cached, cache-first.
   Bump VERSION on every deploy to bust the old shell cache. */
const VERSION = 'mestate-crm-v1';
const SHELL = [
  './DMV_Agent_Outreach_CRM.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // never touch POST/PATCH/etc.

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // NEVER cache data / API traffic — Supabase, GHL, any cross-origin API. Live only.
  const isData =
    url.hostname.endsWith('.supabase.co') ||
    url.hostname.endsWith('.supabase.in') ||
    url.hostname.includes('gohighlevel') ||
    url.hostname.includes('leadconnector') ||
    url.pathname.includes('/rest/v1/') ||
    url.pathname.includes('/functions/v1/') ||
    url.pathname.includes('/auth/v1/');
  if (isData || url.origin !== self.location.origin) {
    return; // fall through to the network (default browser fetch)
  }

  // App shell: cache-first, then network, and refresh the cache copy in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
