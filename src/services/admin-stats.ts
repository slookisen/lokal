// ─── Admin-dashboard statistics: off-thread with stale-while-revalidate ──
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (A2A), skive 3.
//
// The event-loop ring showed GET /admin/analytics/summary/:hours, /visitors,
// /pages, /cities, /producers and /umbrella-traffic stalling every host for
// 1.5–4.6 s (24 h) and up to 8.6 s (720 h) — the dashboard fires them all at
// once. With a file-backed WAL DB these reads now run in the off-thread stats
// worker's "admin" lane (its own worker, so they never queue behind a
// traffic-stats refresh in the background lane) and the route only reads an
// in-memory cache:
//   - a value younger than ADMIN_STATS_TTL_MS is served as-is;
//   - an older one, up to ADMIN_STATS_MAX_STALE_MS, is served at once while a
//     background refresh runs;
//   - a missing or older value waits (asynchronously; the event loop stays
//     free) for the worker's answer;
//   - when the worker fails and there is no value young enough to serve, the
//     route answers 503 — never a synchronous main-thread fallback.
// Numbers on the dashboard can therefore be up to 10 minutes old (accepted in
// the dev-request's risk section).
//
// In-memory DBs, OFFTHREAD_STATS_DISABLED=1 (the test suite) and DBs outside
// WAL mode keep the original synchronous code path, exactly like
// traffic-stats.ts / health-counts.ts.

import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import type { AdminStatsQuery } from "./admin-stats-compute";
import { createSwrCache, offThreadStatsEnvUsable, runStatsTaskOffThread } from "./offthread-stats";

/** Age after which a read starts a background refresh. */
export const ADMIN_STATS_TTL_MS = 5 * 60_000;
/** Oldest value ever served; anything older waits for a fresh answer. */
export const ADMIN_STATS_MAX_STALE_MS = 10 * 60_000;
/** After a failed refresh, wait this long before asking the worker again for that key. */
export const ADMIN_STATS_RETRY_MS = 30_000;
/** Cached query results kept at most (keys carry caller-chosen windows/limits). */
export const ADMIN_STATS_MAX_ENTRIES = 200;
/**
 * Per-task timeout. Wide windows take seconds in prod; this only needs to
 * catch a hung admin worker without leaving the dashboard waiting forever.
 */
export const ADMIN_STATS_TASK_TIMEOUT_MS = 120_000;

export type AdminStatsRead<T> =
  | { ok: true; value: T; ageMs: number; offThread: boolean }
  | { ok: false; error: string };

export interface AdminStatsReaderDeps {
  getDb: () => Database.Database;
  /** Environment check only (kill switch, file DB, WAL); failures do not switch paths. */
  offThreadUsable: (db: Database.Database) => boolean;
  runOffThread: (dbPath: string, query: AdminStatsQuery, nowMs: number) => Promise<unknown>;
  now: () => number;
  ttlMs: number;
  maxStaleMs: number;
  retryAfterMs: number;
  maxEntries: number;
  log: (msg: string) => void;
}

export interface AdminStatsReader {
  /**
   * The query's result: from the worker-backed cache when the worker path is
   * in use, otherwise from `computeSync()` (the route's original code path).
   */
  read<T>(query: AdminStatsQuery, computeSync: () => T): Promise<AdminStatsRead<T>>;
  /** Test hook: resolves once the query's in-flight refresh settles. */
  settled(query: AdminStatsQuery): Promise<void>;
  reset(): void;
}

/** Stable cache key: same query → same key, whatever the property order. */
export function adminStatsKey(query: AdminStatsQuery): string {
  const q = query as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(q).sort().filter((k) => q[k] !== undefined).map((k) => [k, q[k]]));
}

function queryFromKey(key: string): AdminStatsQuery {
  return Object.fromEntries(JSON.parse(key) as Array<[string, unknown]>) as unknown as AdminStatsQuery;
}

export function createAdminStatsReader(deps: AdminStatsReaderDeps): AdminStatsReader {
  let dbPath: string | null = null;
  const lastError = new Map<string, string>();
  const cache = createSwrCache<unknown>({
    ttlMs: deps.ttlMs,
    retryAfterMs: deps.retryAfterMs,
    maxEntries: deps.maxEntries,
    now: deps.now,
    refresh: (key) => {
      const path = dbPath;
      if (!path) return Promise.reject(new Error("no DB path for off-thread admin stats"));
      return deps.runOffThread(path, queryFromKey(key), deps.now()).then((v) => {
        lastError.delete(key);
        return v;
      });
    },
    onError: (key, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      lastError.set(key, msg);
      deps.log(`[admin-stats] off-thread refresh failed for ${key}: ${msg}`);
    },
  });

  function servable(key: string): { value: unknown; ageMs: number } | undefined {
    const hit = cache.get(key);
    return hit && hit.ageMs <= deps.maxStaleMs ? hit : undefined;
  }

  return {
    async read<T>(query: AdminStatsQuery, computeSync: () => T): Promise<AdminStatsRead<T>> {
      let db: Database.Database | null = null;
      try {
        db = deps.getDb();
      } catch {
        db = null;
      }
      if (!db || !deps.offThreadUsable(db)) {
        return { ok: true, value: computeSync(), ageMs: 0, offThread: false };
      }
      if (dbPath !== db.name) {
        cache.clear();
        lastError.clear();
        dbPath = db.name;
      }
      const key = adminStatsKey(query);
      if (lastError.size > deps.maxEntries) lastError.clear();

      const hit = servable(key);
      if (hit) return { ok: true, value: hit.value as T, ageMs: hit.ageMs, offThread: true };
      await cache.refresh(key);
      const fresh = servable(key);
      if (fresh) return { ok: true, value: fresh.value as T, ageMs: fresh.ageMs, offThread: true };
      return { ok: false, error: lastError.get(key) ?? "admin stats unavailable" };
    },
    settled(query) {
      return cache.settled(adminStatsKey(query));
    },
    reset() {
      cache.clear();
      lastError.clear();
      dbPath = null;
    },
  };
}

const defaultReader = createAdminStatsReader({
  getDb,
  offThreadUsable: offThreadStatsEnvUsable,
  // Not wrapped in trackJob(): the work never blocks the loop (same reasoning
  // as traffic-stats.ts). Durations/outcomes are in the offThreadStats section
  // of GET /admin/analytics/ops/event-loop (keys adminStats:<name>).
  runOffThread: (dbPath, query, nowMs) =>
    runStatsTaskOffThread(dbPath, { kind: "adminStats", query, nowMs }, ADMIN_STATS_TASK_TIMEOUT_MS),
  now: Date.now,
  ttlMs: ADMIN_STATS_TTL_MS,
  maxStaleMs: ADMIN_STATS_MAX_STALE_MS,
  retryAfterMs: ADMIN_STATS_RETRY_MS,
  maxEntries: ADMIN_STATS_MAX_ENTRIES,
  log: (msg) => console.warn(msg),
});

export function readAdminStats<T>(query: AdminStatsQuery, computeSync: () => T): Promise<AdminStatsRead<T>> {
  return defaultReader.read(query, computeSync);
}

/** Express app setting a test can use to give one app its own reader (no global swap). */
export const ADMIN_STATS_READER_APP_KEY = "adminStatsReader";

/** The reader for an Express app: its injected one, else the process-wide default. */
export function adminStatsReaderFor(app: { get(name: string): unknown } | undefined): AdminStatsReader {
  const injected = app?.get(ADMIN_STATS_READER_APP_KEY) as AdminStatsReader | undefined;
  return injected ?? defaultReader;
}

export function __resetAdminStatsCacheForTesting(): void {
  defaultReader.reset();
}
