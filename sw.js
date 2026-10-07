const CACHE_NAME = 'konkoor-yar-shell-v20261007';

const SHELL = [
  './',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      await cache.addAll(SHELL);
    } catch (_) {
      // اگر یکی از فایل‌ها در دسترس نبود، نصب Service Worker متوقف نشود.
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(key => key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // فقط درخواست‌های همان دامنه را مدیریت کن.
  if (url.origin !== self.location.origin) {
    return;
  }

  // درخواست‌های صفحه را Network First اجرا می‌کنیم.
  // در صورت قطع اینترنت، نسخه کش‌شده نمایش داده می‌شود.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req);

        const copy = net.clone();
        const cache = await caches.open(CACHE_NAME);

        cache.put('./', copy).catch(() => {});

        return net;
      } catch (_) {
        return (
          (await caches.match(req)) ||
          (await caches.match('./')) ||
          new Response(
            'آفلاین هستی.',
            {
              status: 503,
              headers: {
                'Content-Type': 'text/plain; charset=utf-8'
              }
            }
          )
        );
      }
    })());

    return;
  }

  // فایل‌های استاتیک را Cache First اجرا می‌کنیم.
  if (
    ['style', 'script', 'font', 'image', 'manifest']
      .includes(req.destination)
  ) {
    event.respondWith((async () => {
      const cached = await caches.match(req);

      if (cached) {
        return cached;
      }

      try {
        const net = await fetch(req);

        const copy = net.clone();
        const cache = await caches.open(CACHE_NAME);

        cache.put(req, copy).catch(() => {});

        return net;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
});
