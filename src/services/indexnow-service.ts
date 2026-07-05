// ─── IndexNow — key + best-effort ping ──────────────────────────────
// dev-request 2026-07-04-sokemotor-indeksering-og-lenker, slice 1:
// "IndexNow key + <key>.txt on all three hosts + ping on new/changed pages"
//
// IndexNow (https://www.indexnow.org/) is a free protocol Bing/Yandex
// support: a static key file is hosted at https://<host>/<key>.txt
// containing exactly the key, and a POST to api.indexnow.org tells the
// search engine a page was added/changed so it doesn't have to wait for
// a crawl.
//
// This module is intentionally dependency-free (global fetch, same
// outbound-HTTP pattern used across the codebase — see
// src/services/render-client.ts, src/routes/contact.ts, etc., all of
// which use fetch() + AbortSignal.timeout()) and best-effort only: no
// queueing/retry infra. pingIndexNow() must never throw and must never
// block or slow down the caller — it's meant to be fired-and-forgotten
// from inside a request handler.

const FALLBACK_INDEXNOW_KEY = "2353dee86f6d4b5e8c74cc5c23575ac4";

// Resolved once at module load. Falls back to the hardcoded constant
// above (NOT crypto.randomBytes() at runtime) so the key served at
// GET /<key>.txt stays identical across restarts when INDEXNOW_KEY
// isn't set in the environment — IndexNow requires the served key file
// to match the key used in ping requests every time.
export const INDEXNOW_KEY: string = process.env.INDEXNOW_KEY || FALLBACK_INDEXNOW_KEY;

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const INDEXNOW_TIMEOUT_MS = 5_000;

/**
 * Fire-and-forget best-effort ping to IndexNow (Bing/Yandex) telling it
 * that `urls` on `host` were added or changed. Safe to call synchronously
 * from a request handler: never throws, never rejects, never awaited by
 * the caller — all errors/non-2xx responses are swallowed and logged via
 * console.warn only.
 */
export function pingIndexNow(urls: string[], host: string): void {
  if (!urls.length) return;
  try {
    const payload = {
      host,
      key: INDEXNOW_KEY,
      keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    };
    fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(INDEXNOW_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[indexnow] ping non-2xx for ${host}: ${res.status} ${res.statusText}`);
        }
      })
      .catch((err) => {
        console.warn(`[indexnow] ping failed for ${host}:`, err instanceof Error ? err.message : err);
      });
  } catch (err) {
    // Belt-and-suspenders: JSON.stringify or fetch() itself throwing
    // synchronously (e.g. bad input) must still never bubble up.
    console.warn(`[indexnow] ping setup failed for ${host}:`, err instanceof Error ? err.message : err);
  }
}
