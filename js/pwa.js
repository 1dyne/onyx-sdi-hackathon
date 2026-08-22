/* ─────────────────────────────────────────────────────────────
   PWA lifecycle + developer bypass.

   Dev mode exists for one reason: on event day a hotfix must be
   visible after a single reload. When it is on, no Service Worker
   is registered, any existing one is unregistered, and every
   onyx-sdi-* cache is deleted — the app behaves like a plain site.

   Two ways in:
     - URL:      ?nosw=1  (turns it on and remembers)  /  ?nosw=0 (off)
     - CONFIG:   "개발 모드" switch

   Uses raw localStorage rather than store.js so it can run before
   any other module is initialised.
   ───────────────────────────────────────────────────────────── */
const pwa = (() => {
  const DEV_KEY     = 'onyxSDI_devMode';
  const RELOADED_KEY = 'onyxSDI_devReloaded';

  let registration = null;
  let updateReady  = false;
  let _onUpdate    = null;   // called when a new worker is waiting

  /* ── Dev-mode flag ─────────────────────────────────────────── */
  function readDevFlag() {
    return localStorage.getItem(DEV_KEY) === '1';
  }

  /* A ?nosw= parameter wins over the stored flag and updates it, so
     one hand-typed URL sticks for the rest of the session. */
  function resolveDevMode() {
    const param = new URLSearchParams(location.search).get('nosw');
    if (param === '1' || param === 'true') {
      localStorage.setItem(DEV_KEY, '1');
      return true;
    }
    if (param === '0' || param === 'false') {
      localStorage.removeItem(DEV_KEY);
      return false;
    }
    return readDevFlag();
  }

  let devMode = false;

  /* ── Teardown: remove every trace of the worker + caches ───── */
  async function unregisterEverything() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(
          names.filter(n => n.startsWith('onyx-sdi-')).map(n => caches.delete(n)),
        );
      }
    } catch (err) {
      console.warn('[PWA] teardown failed', err);
    }
  }

  /* ── Registration ──────────────────────────────────────────── */
  async function register() {
    if (!('serviceWorker' in navigator)) return;

    try {
      // Version lives in the URL: a new BUILD_VERSION is a new worker.
      registration = await navigator.serviceWorker.register(
        `./sw.js?v=${encodeURIComponent(BUILD_VERSION)}`,
        { scope: './', updateViaCache: 'none' },
      );

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // A worker reaching "installed" while one is already in
          // control means new code is ready behind the current page.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            updateReady = true;
            _onUpdate?.();
          }
        });
      });

      // Ask the browser to re-check on every launch.
      registration.update().catch(() => {});
    } catch (err) {
      console.warn('[PWA] registration failed', err);
    }
  }

  return {
    get isDevMode()    { return devMode; },
    get isUpdateReady(){ return updateReady; },
    set onUpdate(fn)   { _onUpdate = fn; },

    /* Called once, as early as possible. */
    async init() {
      devMode = resolveDevMode();

      if (devMode) {
        const wasControlled = !!navigator.serviceWorker?.controller;
        await unregisterEverything();
        console.info('[PWA] dev mode — Service Worker bypassed');

        // Unregistering does not un-control the page that is already
        // running: this load was still served by the old worker, so
        // its scripts came from the cache we just deleted. Reload once
        // to get a genuinely uncontrolled, fully fresh page. The
        // sessionStorage guard makes a reload loop impossible.
        if (wasControlled && !sessionStorage.getItem(RELOADED_KEY)) {
          sessionStorage.setItem(RELOADED_KEY, '1');
          location.reload();
        }
        return;
      }
      sessionStorage.removeItem(RELOADED_KEY);
      await register();
    },

    /* CONFIG switch. Turning dev mode ON tears the worker down right
       away; turning it OFF registers again. Either way the caller
       reloads so the change is unambiguous. */
    async setDevMode(on) {
      if (on) {
        localStorage.setItem(DEV_KEY, '1');
        await unregisterEverything();
      } else {
        localStorage.removeItem(DEV_KEY);
      }
      devMode = on;
    },

    /* Manual "force refresh" for event day. */
    async hardRefresh() {
      await unregisterEverything();
      location.reload();
    },

    /* Activate a waiting worker immediately, then reload. */
    applyUpdate() {
      const waiting = registration?.waiting;
      if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
      location.reload();
    },
  };
})();
