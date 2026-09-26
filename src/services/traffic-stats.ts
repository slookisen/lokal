/**
 * traffic-stats.ts — Shared traffic statistics helper
 *
 * PR-121: Extracted from seo.ts and parameterized by vertical so that
 * rfb homepage shows only rfb traffic and dental homepage shows only
 * dental traffic. Both read from the main analytics DB (getDb()), filtered
 * by vertical_id when a vertical is specified.
 *
 * dev-request 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens,
 * slice A: the local BOT_PATTERNS/DEV_PATTERNS lists (one of THREE drifting
 * classifier copies) are gone — classification now goes through the shared
 * src/services/traffic-classifier.ts, and the stats expose the three honest
 * public buckets (human / ai_search / everything-else) plus the retention
 * window so the public strips can label their numbers truthfully. The old
 * field names (realHumans / botAndAi / aiQueries) are kept as aliases for the
 * public /api/traffic-stats consumers.
 *
 * dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A): the
 * computation (now traffic-stats-compute.ts) takes 8–23 s in prod and used to
 * run synchronously inside the homepage request whenever the 2-minute cache
 * had expired, freezing all three hosts. With a file-backed DB it now runs in
 * the off-thread stats worker (offthread-stats.ts) and the request path only
 * reads the cache: stale values are served while a background refresh runs.
 * Until the first refresh after boot completes, callers get zeros and
 * `ready: false` from getTrafficStatsSnapshot(). In-memory DBs, the kill
 * switch OFFTHREAD_STATS_DISABLED=1, and a worker that keeps failing all use
 * the original synchronous path with its 2-minute cache.
 */

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import type { VerticalId } from "./analytics-service";
import {
  computeTrafficStats,
  emptyTrafficStats,
  getRetentionWindowDays,
  type TrafficStats,
} from "./traffic-stats-compute";
import { createSwrCache, offThreadStatsUsable, runStatsTaskOffThread } from "./offthread-stats";

export type { TrafficStats } from "./traffic-stats-compute";
export { getRetentionWindowDays } from "./traffic-stats-compute";

/** Cache TTL on the synchronous (fallback) path — unchanged from before. */
export const TRAFFIC_CACHE_TTL_MS = 120_000;
/**
 * Refresh interval on the off-thread path. The numbers are 60-day totals, so
 * 10 minutes of staleness is invisible, and it keeps the worker's full scans
 * to a few per hour instead of one per vertical every 2 minutes.
 */
export const TRAFFIC_OFFTHREAD_TTL_MS = 10 * 60_000;
/** After a failed off-thread refresh, wait this long before retrying that key. */
const TRAFFIC_OFFTHREAD_RETRY_MS = 60_000;

export interface TrafficStatsSnapshot {
  stats: TrafficStats;
  /** False only while the first off-thread computation after boot is running. */
  ready: boolean;
}

export interface TrafficStatsReaderDeps {
  getDb: () => Database.Database;
  offThreadUsable: (db: Database.Database) => boolean;
  runOffThread: (dbPath: string, vertical: VerticalId | undefined, windowDays: number) => Promise<TrafficStats>;
  computeSync: (db: Database.Database, vertical: VerticalId | undefined) => TrafficStats;
  now: () => number;
  syncTtlMs: number;
  offThreadTtlMs: number;
  retryAfterMs: number;
  log: (msg: string) => void;
}

export interface TrafficStatsReader {
  snapshot(vertical?: VerticalId): TrafficStatsSnapshot;
  /** Schedules an off-thread refresh when the worker path is in use; never computes synchronously. */
  prewarm(vertical?: VerticalId): void;
  /** Test hook: resolves once the key's in-flight off-thread refresh settles. */
  settled(vertical?: VerticalId): Promise<void>;
  reset(): void;
}

function keyOf(vertical?: VerticalId): string {
  return vertical ?? "all";
}

function verticalOf(key: string): VerticalId | undefined {
  return key === "all" ? undefined : (key as VerticalId);
}

export function createTrafficStatsReader(deps: TrafficStatsReaderDeps): TrafficStatsReader {
  const syncCache = new Map<string, { data: TrafficStats; time: number }>();
  // Path of the DB the off-thread cache was filled from. If getDb() starts
  // returning a different file, the cache belongs to the old one and is dropped.
  let offThreadDbPath: string | null = null;
  const offThread = createSwrCache<TrafficStats>({
    ttlMs: deps.offThreadTtlMs,
    retryAfterMs: deps.retryAfterMs,
    now: deps.now,
    refresh: (key) => {
      const dbPath = offThreadDbPath;
      if (!dbPath) return Promise.reject(new Error("no DB path for off-thread traffic stats"));
      return deps.runOffThread(dbPath, verticalOf(key), getRetentionWindowDays());
    },
    onError: (key, err) =>
      deps.log(`[traffic-stats] off-thread refresh failed for ${key}: ${err instanceof Error ? err.message : String(err)}`),
  });

  function bindOffThreadDb(db: Database.Database): void {
    if (offThreadDbPath !== db.name) {
      offThread.clear();
      offThreadDbPath = db.name;
    }
  }

  return {
    snapshot(vertical) {
      const cacheKey = keyOf(vertical);
      let db: Database.Database;
      try {
        db = deps.getDb();
      } catch {
        return { stats: emptyTrafficStats(), ready: false };
      }

      if (deps.offThreadUsable(db)) {
        bindOffThreadDb(db);
        const hit = offThread.get(cacheKey);
        return hit ? { stats: hit.value, ready: true } : { stats: emptyTrafficStats(), ready: false };
      }

      // Synchronous path (in-memory DB, kill switch, or worker broken).
      const now = deps.now();
      const cached = syncCache.get(cacheKey);
      if (cached && now >= cached.time && now - cached.time < deps.syncTtlMs) {
        return { stats: cached.data, ready: true };
      }
      try {
        const data = deps.computeSync(db, vertical);
        syncCache.set(cacheKey, { data, time: deps.now() });
        return { stats: data, ready: true };
      } catch {
        return { stats: emptyTrafficStats(), ready: false };
      }
    },
    prewarm(vertical) {
      let db: Database.Database;
      try {
        db = deps.getDb();
      } catch {
        return;
      }
      if (!deps.offThreadUsable(db)) return;
      bindOffThreadDb(db);
      offThread.get(keyOf(vertical));
    },
    settled(vertical) {
      return offThread.settled(keyOf(vertical));
    },
    reset() {
      syncCache.clear();
      offThread.clear();
      offThreadDbPath = null;
    },
  };
}

const defaultReader = createTrafficStatsReader({
  getDb,
  offThreadUsable: offThreadStatsUsable,
  // Deliberately NOT wrapped in the event-loop monitor's trackJob(): this work
  // never blocks the loop, and a tracked job finishing inside a stall window
  // would be listed as a stall suspect. Durations/outcomes are in the
  // offThreadStats section of GET /admin/analytics/ops/event-loop instead.
  runOffThread: (dbPath, vertical, windowDays) =>
    runStatsTaskOffThread<TrafficStats>(dbPath, { kind: "trafficStats", vertical, windowDays }),
  computeSync: (db, vertical) => computeTrafficStats(db, vertical),
  now: Date.now,
  syncTtlMs: TRAFFIC_CACHE_TTL_MS,
  offThreadTtlMs: TRAFFIC_OFFTHREAD_TTL_MS,
  retryAfterMs: TRAFFIC_OFFTHREAD_RETRY_MS,
  log: (msg) => console.warn(msg),
});

/** Stats plus whether they are real (false = placeholder zeros before the first refresh). */
export function getTrafficStatsSnapshot(vertical?: VerticalId): TrafficStatsSnapshot {
  return defaultReader.snapshot(vertical);
}

export function getTrafficStats(vertical?: VerticalId): TrafficStats {
  return defaultReader.snapshot(vertical).stats;
}

/**
 * Starts the first off-thread refresh for each vertical right after boot, so
 * the homepages have real numbers as early as possible. No-op on the
 * synchronous path (it never runs the full scans on the main thread).
 */
export function prewarmTrafficStats(verticals: VerticalId[]): void {
  for (const v of verticals) defaultReader.prewarm(v);
}

/**
 * Test-only: clear the module-level cache so tests can observe freshly
 * seeded data immediately instead of waiting out the TTL. Mirrors the
 * __reset…ForTesting convention used elsewhere in this repo.
 */
export function __resetTrafficStatsCacheForTesting(): void {
  defaultReader.reset();
}
