// ─── Cached analytics counts for GET /health ────────────────────────
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
//
// /health used to run `SELECT COUNT(*) FROM analytics_page_views` (~1.19 M
// rows, 757 MB DB, 64 MB page cache) plus a last-hour count on EVERY call.
// better-sqlite3 is synchronous, so each probe blocked the one event loop
// every host shares — measured live 2026-09-21/25 at 2.2–2.6 s time-to-first-
// byte on a cold cache. /health is polled by fleet routines and external
// monitors.
//
// PR #922 cached the counts for 60 s; the event-loop monitor then showed the
// one refresh per minute still stalling the loop for ~1.8 s. With a
// file-backed DB the refresh now runs in the off-thread stats worker
// (offthread-stats.ts): /health serves the cached numbers and a stale value
// triggers a background refresh. The very first call after boot fills the
// cache synchronously once, so /health never reports placeholder zeros.
// In-memory DBs, OFFTHREAD_STATS_DISABLED=1 and a broken worker keep the
// original synchronous 60 s cache.
//
// Both numbers are informational (a pruning hint and a traffic gauge), so a
// value up to about a TTL old is fine. `cachedAgeMs` says how old.

import type Database from "better-sqlite3";
import { computePageViewCounts, type PageViewCounts } from "./health-counts-compute";
import { createSwrCache, offThreadStatsUsable, runStatsTaskOffThread } from "./offthread-stats";

export const HEALTH_COUNTS_TTL_MS = 60_000;
const HEALTH_COUNTS_RETRY_MS = 60_000;
const KEY = "page-views";

export interface PageViewHealthCounts {
  pageViews: number;
  lastHourPageViews: number;
  cachedAgeMs: number;
}

export interface PageViewHealthCounterDeps {
  offThreadUsable: (db: Database.Database) => boolean;
  runOffThread: (dbPath: string, nowMs: number) => Promise<PageViewCounts>;
  computeSync: (db: Database.Database, nowMs: number) => PageViewCounts;
  now: () => number;
  offThreadTtlMs: number;
  retryAfterMs: number;
  log: (msg: string) => void;
}

export interface PageViewHealthCounter {
  get(db: Database.Database, nowMs: number, ttlMs: number): PageViewHealthCounts;
  /** Test hook: resolves once an in-flight off-thread refresh settles. */
  settled(): Promise<void>;
  reset(): void;
}

export function createPageViewHealthCounter(deps: PageViewHealthCounterDeps): PageViewHealthCounter {
  // Synchronous-path cache (unchanged behaviour from PR #922).
  let syncCache: { at: number; pageViews: number; lastHourPageViews: number } | null = null;
  let offThreadDbPath: string | null = null;
  const offThread = createSwrCache<PageViewCounts>({
    ttlMs: deps.offThreadTtlMs,
    retryAfterMs: deps.retryAfterMs,
    now: deps.now,
    refresh: () => {
      const dbPath = offThreadDbPath;
      if (!dbPath) return Promise.reject(new Error("no DB path for off-thread /health counts"));
      return deps.runOffThread(dbPath, deps.now());
    },
    onError: (_key, err) =>
      deps.log(`[health-counts] off-thread refresh failed: ${err instanceof Error ? err.message : String(err)}`),
  });

  return {
    get(db, nowMs, ttlMs) {
      if (deps.offThreadUsable(db)) {
        if (offThreadDbPath !== db.name) {
          offThread.clear();
          offThreadDbPath = db.name;
        }
        if (!offThread.has(KEY)) {
          // First call after boot: one synchronous fill (exact numbers).
          const v = deps.computeSync(db, nowMs);
          offThread.set(KEY, v);
          return { pageViews: v.pageViews, lastHourPageViews: v.lastHourPageViews, cachedAgeMs: 0 };
        }
        const hit = offThread.get(KEY)!;
        return {
          pageViews: hit.value.pageViews,
          lastHourPageViews: hit.value.lastHourPageViews,
          cachedAgeMs: hit.ageMs,
        };
      }

      if (syncCache && nowMs >= syncCache.at && nowMs - syncCache.at < ttlMs) {
        return {
          pageViews: syncCache.pageViews,
          lastHourPageViews: syncCache.lastHourPageViews,
          cachedAgeMs: nowMs - syncCache.at,
        };
      }
      const { pageViews, lastHourPageViews } = deps.computeSync(db, nowMs);
      syncCache = { at: nowMs, pageViews, lastHourPageViews };
      return { pageViews, lastHourPageViews, cachedAgeMs: 0 };
    },
    settled() {
      return offThread.settled(KEY);
    },
    reset() {
      syncCache = null;
      offThread.clear();
      offThreadDbPath = null;
    },
  };
}

const defaultCounter = createPageViewHealthCounter({
  offThreadUsable: offThreadStatsUsable,
  // Not wrapped in trackJob() for the same reason as traffic-stats.ts: it never
  // blocks the loop and must not show up as a stall suspect.
  runOffThread: (dbPath, nowMs) =>
    runStatsTaskOffThread<PageViewCounts>(dbPath, { kind: "pageViewCounts", nowMs }),
  computeSync: computePageViewCounts,
  now: Date.now,
  offThreadTtlMs: HEALTH_COUNTS_TTL_MS,
  retryAfterMs: HEALTH_COUNTS_RETRY_MS,
  log: (msg) => console.warn(msg),
});

/**
 * `nowMs`/`ttlMs` drive the synchronous path (and the one first fill on the
 * off-thread path). Once the off-thread path is serving, freshness follows
 * HEALTH_COUNTS_TTL_MS and the wall clock; `cachedAgeMs` reports the real age.
 */
export function getPageViewHealthCounts(
  db: Database.Database,
  nowMs: number = Date.now(),
  ttlMs: number = HEALTH_COUNTS_TTL_MS
): PageViewHealthCounts {
  return defaultCounter.get(db, nowMs, ttlMs);
}

export function __resetHealthCountsCacheForTesting(): void {
  defaultCounter.reset();
}
