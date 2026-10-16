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

// ─── submitIndexNow — awaited, batched submit (dev-request 2026-10-16-indexnow-alle-verter, S1) ───
// Unlike pingIndexNow this is awaited by the caller (the sitemap-diff job) and reports
// a status per chunk. It never throws. URLs that do not start with the host's baseUrl are
// dropped before the POST (a foreign host would make IndexNow answer 422).

export type IndexNowChunkResult = "ok" | "bad_request" | "key_invalid" | "host_mismatch" | "rate_limited" | "http_error" | "network_error";

export interface IndexNowChunkStatus {
  status: number; // HTTP status, 0 on network error / timeout
  result: IndexNowChunkResult;
  sent: number;
}

export interface SubmitIndexNowResult {
  chunks: IndexNowChunkStatus[];
  sent: number; // URLs in chunks that were accepted (200/202)
  dropped_foreign: number;
}

export interface SubmitIndexNowOptions {
  fetchImpl?: typeof fetch;
  chunkSize?: number; // default 1000; IndexNow spec max is 10 000 per POST
  baseUrl?: string; // default https://<host>
}

export function classifyIndexNowStatus(status: number): IndexNowChunkResult {
  if (status === 200 || status === 202) return "ok";
  if (status === 400) return "bad_request";
  if (status === 403) return "key_invalid";
  if (status === 422) return "host_mismatch";
  if (status === 429) return "rate_limited";
  return "http_error";
}

export async function submitIndexNow(
  host: string,
  urls: string[],
  opts: SubmitIndexNowOptions = {},
): Promise<SubmitIndexNowResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const chunkSize = Math.min(10_000, Math.max(1, Math.floor(opts.chunkSize ?? 1000)));
  const baseUrl = (opts.baseUrl ?? `https://${host}`).replace(/\/+$/, "");
  const own = urls.filter((u) => typeof u === "string" && (u === baseUrl || u.startsWith(baseUrl + "/")));
  const out: SubmitIndexNowResult = { chunks: [], sent: 0, dropped_foreign: urls.length - own.length };
  for (let i = 0; i < own.length; i += chunkSize) {
    const chunk = own.slice(i, i + chunkSize);
    try {
      const res = await doFetch(INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          host,
          key: INDEXNOW_KEY,
          keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
          urlList: chunk,
        }),
        signal: AbortSignal.timeout(INDEXNOW_TIMEOUT_MS),
      });
      const result = classifyIndexNowStatus(res.status);
      if (result === "ok") out.sent += chunk.length;
      else console.warn(`[indexnow] submit non-2xx for ${host}: ${res.status} (${result})`);
      out.chunks.push({ status: res.status, result, sent: chunk.length });
    } catch (err) {
      console.warn(`[indexnow] submit failed for ${host}:`, err instanceof Error ? err.message : err);
      out.chunks.push({ status: 0, result: "network_error", sent: chunk.length });
    }
  }
  return out;
}
