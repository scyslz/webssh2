const CACHE = 'webssh-v2';
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

/**
 * 接口前缀：这些路径的请求**不拦截、不缓存**，直接交给浏览器默认处理。
 *
 * v1 的坑：fetch handler 对任意同源 GET 都走「缓存优先」，于是接口响应也会被写进缓存 ——
 * 包括服务端某次把 SPA fallback 的 index.html 当作 /ai/config 的响应返回时，那份 HTML
 * 就被永久缓存在 /ai/config 这个 key 下。此后即使服务端修好了，浏览器仍会先吐出缓存里的
 * HTML，前端报 `Unexpected token '<'`。接口响应必须实时反映服务端，不能进缓存。
 */
const API_PREFIXES = ['/auth', '/check', '/ssh', '/config', '/file', '/ai'];

function isApiPath(pathname) {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApiPath(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() =>
          caches
            .match('./index.html')
            .then((cached) => cached || caches.match('./'))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
