/* ============================================================================
   KONKOOR YAR — SERVICE WORKER v1.0.1
   ============================================================================ */

const VERSION = 'ky-v1.0.1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './vendor/supabase.min.js'
];

/* Install — همه فایل‌ها را کش کن، حتی اگر یکی 404 بود ادامه بده */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

/* Activate — کش‌های قدیمی را پاک کن */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys.filter(k => k !== VERSION).map(k => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Fetch */
self.addEventListener('fetch', (e) => {
  const req = e.request;

  /* فقط GET */
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* درخواست‌های خارج از دامنه (Supabase، API) را دست نزن */
  if (url.origin !== location.origin) return;

  /* ناوبری: HTML اول از شبکه، اگر نشد از کش */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => {
          const c = r.clone();
          caches.open(VERSION).then(x => x.put('./index.html', c));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* بقیه: cache-first با به‌روزرسانی پس‌زمینه */
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(r => {
        if (r.ok) {
          const c = r.clone();
          caches.open(VERSION).then(x => x.put(req, c));
        }
        return r;
      });
    })
  );
});
