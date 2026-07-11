/**
 * sw.js — service worker for rettfrabonden.com (rfb host only).
 *
 * dev-request 2026-07-04-app-strategi-pwa, slice 2 of 3: service worker +
 * offline shell. Conservative cache strategy — this is NOT a full offline-app
 * cache, just enough to survive a flaky connection and show a branded offline
 * page instead of the browser's default error screen.
 *
 *  - install:  precache a small "app shell" (manifest, icons, favicon, the
 *              /offline.html fallback page) under a VERSIONED cache name.
 *  - activate: delete any previously-versioned cache so a new deploy
 *              invalidates stale entries (bump CACHE_VERSION to force this).
 *  - fetch:
 *      * BYPASS (never intercept/cache) non-GET requests, any /api/* or
 *        /admin* path, and any cross-origin request — these always go
 *        straight to fetch(), untouched. This is an early-return guard at
 *        the very top of the fetch handler so it can't be silently broken
 *        by cache-matching logic added below it later.
 *      * navigations (HTML page loads): network-first, falling back to the
 *        precached /offline.html ONLY when the network request itself
 *        fails (offline / DNS failure) — never on a valid HTTP error
 *        response (e.g. a real 404/500 is left alone).
 *      * everything else (icons, manifest, static assets): cache-first with
 *        a network fallback, opportunistically re-caching successful GETs
 *        so repeat visits are fast.
 *
 * Registered only on the rfb host — see the inline registration script
 * added next to <link rel="manifest"> in app.html / selger.html /
 * dashboard.html / agent.html / seo.ts's shell() / conversation-ui.ts's
 * chatShell() / owner-portal.ts's portalShell() / discovery.ts's
 * privacy+terms pages. Dental (finn-tannlege.com) and experiences
 * (opplevagent.no) are excluded there.
 *
 * Isomorphic-ish for testability: the guard/precache-list logic is exported
 * via `module.exports` when running under Node (e.g. src/public/sw.test.ts),
 * and the actual `self.addEventListener(...)` registrations are skipped
 * outside a real service-worker global scope, so `require()`-ing this file
 * in a test never throws on a missing `self`/`caches`.
 */

const CACHE_VERSION = "rfb-pwa-v1";

// Small, rarely-changing "app shell" — precached on install.
const APP_SHELL = [
  "/manifest.json",
  "/logo-200.png",
  "/logo-512.png",
  "/favicon.svg",
  "/favicon.ico",
  "/offline.html",
];

/**
 * Requests that must NEVER be intercepted or cached by this service
 * worker. Checked as the very first thing the fetch handler does.
 *   - non-GET requests (POST/PUT/DELETE/... — never cache mutations)
 *   - /api/*  (never cache API responses)
 *   - /admin* (never cache admin surfaces)
 *   - cross-origin requests (only ever handle same-origin traffic)
 */
function shouldBypass(request, originOverride) {
  if (!request || request.method !== "GET") return true;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return true; // unparsable URL — don't touch it
  }

  const origin = originOverride || (typeof self !== "undefined" && self.location && self.location.origin);
  if (origin && url.origin !== origin) return true;

  const path = url.pathname.toLowerCase();
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/admin")) return true;

  return false;
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("install", (event) => {
    event.waitUntil(
      caches
        .open(CACHE_VERSION)
        .then((cache) => cache.addAll(APP_SHELL))
        .then(() => self.skipWaiting())
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => name !== CACHE_VERSION)
              .map((name) => caches.delete(name))
          )
        )
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;

    // Early-return guard — see shouldBypass() above. Nothing below this
    // line ever runs for API/admin/non-GET/cross-origin requests.
    if (shouldBypass(request)) {
      return;
    }

    // Navigations (HTML page loads): network-first, offline-fallback only
    // when the network itself is unreachable.
    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request).catch(() =>
          caches.match("/offline.html").then((cached) => cached || Response.error())
        )
      );
      return;
    }

    // Static assets (icons, manifest, css/js): cache-first, network fallback.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
  });
}

// Node/test-only export (no-op in a real service-worker global scope,
// where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CACHE_VERSION, APP_SHELL, shouldBypass };
}
