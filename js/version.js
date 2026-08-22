/* ─────────────────────────────────────────────────────────────
   BUILD VERSION — single source of truth.

   Bump this string on every deploy. It is used for THREE things:
     1. The version stamp shown in the app header (visual proof
        that a reload actually picked up new code).
     2. The Service Worker registration URL (`sw.js?v=<version>`),
        which forces the browser to treat it as a new worker.
     3. The Service Worker's cache name, so `activate` can delete
        every cache that does not match.

   Changing this one line is all that is required to invalidate
   the entire offline cache.
   ───────────────────────────────────────────────────────────── */
const BUILD_VERSION = '2.1.1';
const BUILD_DATE    = '2026-08-22';
