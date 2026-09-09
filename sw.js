/* ─────────────────────────────────────────────────────────────
   Onyx SDI — Service Worker

   Cache version comes from the registration URL query string
   (`sw.js?v=2.0.0`), which is built from BUILD_VERSION in
   js/version.js. That gives a single source of truth: bumping
   BUILD_VERSION changes this worker's URL, so the browser
   installs a fresh worker, which in turn creates a fresh cache
   and deletes every older one in `activate`.

   Strategies
     - code (HTML/CSS/JS/manifest) : network-first, 3 s timeout, cache fallback
     - media (icons) + Google Fonts: cache-first

   Why code is network-first rather than cache-first: on event day a
   hotfix has to be live after ONE reload. With cache-first JS the page
   boots the old script and only picks up the new one on the *second*
   reload, which is exactly the failure mode this app cannot afford.
   Network-first costs a few hundred ms on a warm network and still
   falls back to cache the moment a request fails, so offline launch
   is unaffected. Icons and fonts never change and stay cache-first.
   ───────────────────────────────────────────────────────────── */

const CACHE_VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL_CACHE   = `onyx-sdi-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `onyx-sdi-runtime-${CACHE_VERSION}`;
const NETWORK_TIMEOUT = 3000;

/* App shell — everything needed to boot with no network. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/layout.css',
  './css/components.css',
  './css/silhouette.css',
  './js/version.js',
  './js/pwa.js',
  './js/constants.js',
  './js/pressure.js',
  './js/validation.js',
  './js/store.js',
  './js/audio.js',
  './js/bluetooth.js',
  './js/alert.js',
  './js/session.js',
  './js/coach.js',
  './js/tabs/live.js',
  './js/tabs/training.js',
  './js/tabs/config.js',
  './js/tabs/log.js',
  './js/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

/* ── Install: precache the shell, activate immediately ───────── */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll() is atomic — one 404 aborts the whole install. Cache
    // entries individually so a single missing file cannot brick
    // the worker mid-event.
    // index.html references assets as `css/x.css?v=<version>`, so the
    // precache keys must carry the same query or nothing would hit.
    // Reads additionally use ignoreSearch as a safety net.
    const versioned = (url) =>
      /\.(?:css|js)$/i.test(url) ? `${url}?v=${CACHE_VERSION}` : url;

    await Promise.all(SHELL_ASSETS.map(async (url) => {
      const target = versioned(url);
      try {
        const res = await fetch(target, { cache: 'reload' });
        if (res.ok) await cache.put(target, res);
      } catch (err) {
        console.warn('[SW] precache skipped:', target, err);
      }
    }));
    await self.skipWaiting();
  })());
});

/* ── Activate: drop every cache from a previous version ──────── */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('onyx-sdi-') && !keep.has(n))
        .map(n => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

/* ── Helpers ─────────────────────────────────────────────────── */

function isHtmlRequest(request) {
  return request.mode === 'navigate' ||
         (request.headers.get('accept') || '').includes('text/html');
}

function isFontRequest(url) {
  return url.hostname === 'fonts.googleapis.com' ||
         url.hostname === 'fonts.gstatic.com';
}

/* Application code — must never be served stale while online. */
function isCodeRequest(request, url) {
  return isHtmlRequest(request) ||
         /\.(?:js|css|json)$/i.test(url.pathname);
}

/* Immutable media — safe to serve from cache indefinitely. */
function isMediaRequest(url) {
  return /\.(?:png|jpg|jpeg|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname);
}

/* Network-first with a hard timeout, falling back to cache. Used for
   HTML and the manifest so a code fix is never masked by the cache. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  const fromNetwork = (async () => {
    // Bypass the browser's own HTTP cache. GitHub Pages serves assets
    // with Cache-Control: max-age=600, so a plain fetch() here could
    // hand back a ten-minute-old file and defeat the whole point of
    // going network-first. Same-origin GET only, so dropping the
    // original Request's headers is safe.
    const res = await fetch(request.url, { cache: 'no-store', credentials: 'same-origin' });
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  })();

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT));

  try {
    return await Promise.race([fromNetwork, timeout]);
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true }) ||
                   await cache.match('./index.html') ||
                   await cache.match('./');
    if (cached) return cached;
    // Let the in-flight network request finish rather than hard-failing.
    return fromNetwork;
  }
}

/* Cache-first, with a background refresh so the next load is current. */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  // ignoreSearch so a ?v= stamped request still hits its precached
  // entry. Caches are already scoped per version, so this can never
  // return an asset from a different build.
  const cached = await cache.match(request, { ignoreSearch: true });

  if (cached) {
    // Revalidate in the background; ignore failures (offline).
    fetch(request)
      .then(res => { if (res && res.ok) cache.put(request, res.clone()); })
      .catch(() => {});
    return cached;
  }

  const res = await fetch(request);
  // Opaque responses (cross-origin fonts) have status 0 but are still
  // usable from cache, so store them too.
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

/* ── Fetch routing ───────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch non-GET, or schemes we cannot cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Google Fonts: runtime cache so the UI font survives offline.
  if (isFontRequest(url)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // Anything else cross-origin: leave it to the network untouched.
  if (url.origin !== self.location.origin) return;

  // Icons and any other immutable media: cache-first.
  if (isMediaRequest(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Everything that is code goes to the network first, so a deploy is
  // live after a single reload. Falls back to cache when offline.
  if (isCodeRequest(request, url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

/* ── Messages from the page ──────────────────────────────────── */
self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }

  if (type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n.startsWith('onyx-sdi-')).map(n => caches.delete(n)));
      event.ports[0]?.postMessage({ cleared: true });
    })());
  }
});
