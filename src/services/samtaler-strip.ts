// ─── /samtaler: referral strip off-thread + finished HTML cache ────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (A2A), skive 4.
//
// The event-loop ring showed GET /samtaler (and its ?kilde= variants) stalling
// every host for 1.3–7.3 s, ten times in one day. Two causes this module takes
// out of the request path:
//   - the "Menneskelige besøk" strip read ~half of analytics_page_views (720 h)
//     into JS and parsed a User-Agent per row. It now runs in the off-thread
//     stats worker's admin lane (admin-stats-compute.ts: humanReferrals, own
//     domains filtered in SQL) behind a stale-while-revalidate cache: a value
//     younger than STRIP_TTL_MS is served as-is, an older one up to
//     STRIP_MAX_STALE_MS is served at once while a refresh runs, otherwise the
//     route waits (asynchronously) for the worker. A worker failure with
//     nothing recent enough cached is a 503 — never a synchronous fallback.
//   - the page was rebuilt from scratch per request. The finished HTML is now
//     cached per source filter (kilde) for HTML_CACHE_TTL_MS.
// In-memory DBs, OFFTHREAD_STATS_DISABLED=1 (the test suite) and DBs outside
// WAL mode keep the original synchronous strip computation, like admin-stats.ts.

import { getDb } from "../database/init";
import { analyticsService } from "./analytics-service";
import type { HumanReferralPattern } from "./human-referrals";
import {
  createAdminStatsReader,
  ADMIN_STATS_RETRY_MS,
  ADMIN_STATS_TASK_TIMEOUT_MS,
  type AdminStatsRead,
  type AdminStatsReader,
} from "./admin-stats";
import { offThreadStatsEnvUsable, runStatsTaskOffThread } from "./offthread-stats";

/** Strip window, as before (30 days). */
export const STRIP_HOURS_BACK = 24 * 30;
/** Age after which a read starts a background refresh of the strip. */
export const STRIP_TTL_MS = 30 * 60_000;
/** Oldest strip ever served; anything older waits for a fresh answer. */
export const STRIP_MAX_STALE_MS = 60 * 60_000;
/** Finished /samtaler HTML is reused this long per source filter. */
export const HTML_CACHE_TTL_MS = 60_000;

const stripReader = createAdminStatsReader({
  getDb,
  offThreadUsable: offThreadStatsEnvUsable,
  // Not wrapped in trackJob(): the work never blocks the loop (see admin-stats.ts).
  runOffThread: (dbPath, query, nowMs) =>
    runStatsTaskOffThread(dbPath, { kind: "adminStats", query, nowMs }, ADMIN_STATS_TASK_TIMEOUT_MS),
  now: Date.now,
  ttlMs: STRIP_TTL_MS,
  maxStaleMs: STRIP_MAX_STALE_MS,
  retryAfterMs: ADMIN_STATS_RETRY_MS,
  maxEntries: 4,
  log: (msg) => console.warn(msg),
});

/** Express app setting a test can use to give one app its own strip reader. */
export const STRIP_READER_APP_KEY = "samtalerStripReader";

/** The strip for an Express app: its injected reader, else the process-wide one. */
export function readHumanReferralStrip(app?: { get(name: string): unknown }): Promise<AdminStatsRead<HumanReferralPattern[]>> {
  const reader = (app?.get(STRIP_READER_APP_KEY) as AdminStatsReader | undefined) ?? stripReader;
  return reader.read<HumanReferralPattern[]>(
    { name: "humanReferrals", hours: STRIP_HOURS_BACK },
    // The route's original synchronous computation (in-memory DB / kill switch / non-WAL).
    () => analyticsService.getHumanReferralPatterns({ hoursBack: STRIP_HOURS_BACK })
  );
}

// ── Finished-HTML cache ───────────────────────────────────────────────

export interface HtmlCache {
  get(key: string): string | undefined;
  set(key: string, html: string): void;
  clear(): void;
}

export function createHtmlCache(ttlMs: number, now: () => number = Date.now, maxEntries = 16): HtmlCache {
  const entries = new Map<string, { html: string; at: number }>();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      const t = now();
      if (t < e.at || t - e.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return e.html;
    },
    set(key, html) {
      entries.delete(key);
      entries.set(key, { html, at: now() });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
    clear() {
      entries.clear();
    },
  };
}

const defaultHtmlCache = createHtmlCache(HTML_CACHE_TTL_MS);

/** Express app setting a test can use to give one app its own HTML cache. */
export const HTML_CACHE_APP_KEY = "samtalerHtmlCache";

export function samtalerHtmlCacheFor(app?: { get(name: string): unknown }): HtmlCache {
  return (app?.get(HTML_CACHE_APP_KEY) as HtmlCache | undefined) ?? defaultHtmlCache;
}

export function __resetSamtalerCachesForTesting(): void {
  defaultHtmlCache.clear();
  stripReader.reset();
}
