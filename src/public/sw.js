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
 *        /admin* path, any cross-origin request, any URL with a query
 *        string, and every owner/producer path that can carry personal
 *        owner HTML (/eier, /selger, /produsent, /kategori/<slug>/eier,
 *        owner login/token pages — see PRIVATE_PATH_PREFIXES) — these
 *        always go straight to fetch(), untouched. This is an early-return
 *        guard at the very top of the fetch handler so it can't be silently
 *        broken by cache-matching logic added below it later.
 *      * navigations (HTML page loads): network-first, falling back to the
 *        precached /offline.html ONLY when the network request itself
 *        fails (offline / DNS failure) — never on a valid HTTP error
 *        response (e.g. a real 404/500 is left alone). Never cached.
 *      * static files only (the precached APP_SHELL paths and files with a
 *        STATIC_EXTENSIONS type — see isCacheableStatic()): cache-first with
 *        a network fallback, re-caching a fetched response only when
 *        isCacheableResponse() allows it (2xx, and no `no-store`/`private`
 *        in Cache-Control).
 *      * every other non-navigation GET (e.g. the owner portal's own
 *        `fetch(...?fragment=...)` partial-page requests) is NOT
 *        intercepted at all — no respondWith(), the browser handles it with
 *        normal HTTP caching. Nothing but static files is ever written to
 *        the cache.
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

// v2: the old version cached every same-origin GET forever (incl. owner
// pages fetched with ?fragment=); bumping deletes those entries on activate.
const CACHE_VERSION = "rfb-pwa-v2";

// Small, rarely-changing "app shell" — precached on install.
const APP_SHELL = [
  "/manifest.json",
  "/logo-200.png",
  "/logo-512.png",
  "/favicon-192.png",
  "/favicon-512.png",
  "/favicon.svg",
  "/favicon.ico",
  "/offline.html",
];

// File types the fetch handler may serve cache-first and store. Allowlist:
// anything not matching is never cached.
const STATIC_EXTENSIONS = [".png", ".svg", ".ico", ".css", ".js", ".woff2", ".webmanifest"];

// Owner/producer paths that can carry personal owner HTML (prefix match,
// lower-cased). Sources:
//   /eier         owner portal + its sub-pages (routes/owner-portal.ts,
//                 owner-features.ts /valg, owner-orders.ts /ordrer,
//                 owner-product-import.ts, payments.ts /eier/:id/betaling)
//   /selger       producer sign-up/claim page (/selger.html, index.ts)
//   /produsent    producer pages incl. /produsent/ordre/:token (index.ts,
//                 owner-orders.ts, seo.ts)
//   /magic-link-verify, /auth/  owner login links (owner-portal.ts,
//                 marketplace.ts)
//   /lagerstatus  stock-check token page (services/stock-check-reminder.ts)
//   /avmeld       unsubscribe token page (routes/avmeld.ts)
//   /betaling     payment return pages (routes/payments.ts)
const PRIVATE_PATH_PREFIXES = [
  "/eier",
  "/selger",
  "/produsent",
  "/magic-link-verify",
  "/auth/",
  "/lagerstatus",
  "/avmeld",
  "/betaling",
];
// /kategori/<slug>/eier… — category-scoped owner portals (e.g. the
// gardssalg owner portal in routes/gardssalg-claim.ts).
const PRIVATE_PATH_PATTERNS = [/^\/kategori\/[^/]+\/eier(\/|$)/];

/** True when `pathname` is an owner/producer path that must never be cached. */
function isPrivatePath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (PRIVATE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return PRIVATE_PATH_PATTERNS.some((re) => re.test(path));
}

/**
 * True only for requests the cache-first branch may serve/store: same-path
 * APP_SHELL entries and static file types, never with a query string and
 * never on an owner/producer path. Accepts a URL string or URL object.
 */
function isCacheableStatic(url) {
  let u;
  try {
    u = url instanceof URL ? url : new URL(String(url));
  } catch {
    return false;
  }
  if (u.search) return false;
  const path = u.pathname.toLowerCase();
  if (isPrivatePath(path)) return false;
  if (APP_SHELL.includes(path)) return true;
  return STATIC_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * True when a fetched response may be written to the cache: a successful
 * (2xx) response whose Cache-Control has neither `no-store` nor `private`.
 */
function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  const cc = (response.headers && typeof response.headers.get === "function" && response.headers.get("cache-control")) || "";
  return !/(^|[\s,])(no-store|private)([\s,=]|$)/i.test(cc);
}

/**
 * Requests that must NEVER be intercepted or cached by this service
 * worker. Checked as the very first thing the fetch handler does.
 *   - non-GET requests (POST/PUT/DELETE/... — never cache mutations)
 *   - /api/*  (never cache API responses)
 *   - /admin* (never cache admin surfaces)
 *   - cross-origin requests (only ever handle same-origin traffic)
 *   - any URL with a query string (query URLs are dynamic by definition)
 *   - owner/producer paths (isPrivatePath) — personal owner HTML must never
 *     end up in Cache Storage, e.g. on a shared PC after logout
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
  if (url.search) return true;
  if (isPrivatePath(path)) return true;

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
    // line ever runs for API/admin/non-GET/cross-origin/query/owner requests.
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

    // Any other non-static GET: not intercepted — the browser handles it.
    if (!isCacheableStatic(request.url)) {
      return;
    }

    // Static files (app shell, icons, manifest, css/js, fonts): cache-first,
    // network fallback; store only responses isCacheableResponse() allows.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (isCacheableResponse(response)) {
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
  module.exports = {
    CACHE_VERSION,
    APP_SHELL,
    STATIC_EXTENSIONS,
    PRIVATE_PATH_PREFIXES,
    PRIVATE_PATH_PATTERNS,
    shouldBypass,
    isPrivatePath,
    isCacheableStatic,
    isCacheableResponse,
  };
}
