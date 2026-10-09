// ─── Cached catalog + query counts for GET /health ──────────────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler,
// slice 5. /health used to run `SELECT COUNT(*) FROM analytics_queries` and
// honestCatalogCounts() (three verticals, three DBs) on every probe, on the
// shared event loop. Both are informational gauges, so a value up to about a
// TTL old is fine.
//
// Same contract as the page-view counts (health-counts.ts, slice 2): the very
// first call after boot never computes inline — it schedules a background
// refresh (next macrotask) and reports null until it lands; afterwards the
// cached value is served and a stale one is refreshed in the background
// (stale-while-revalidate). The numbers themselves are unchanged. The refresh
// still runs on the main thread (these are two small queries, and the
// verticals live in separate DB handles), but never inside the probe.

import { createSwrCache } from "./offthread-stats";
import { honestCatalogCounts, type CatalogVertical } from "./honest-count";

export const HEALTH_CHEAP_COUNTS_TTL_MS = 60_000;
const RETRY_MS = 60_000;

type Counts = Record<CatalogVertical, number | null>;
const NULL_CATALOG: Counts = { rfb: null, dental: null, experiences: null };

function deferred<V>(fn: () => V): Promise<V> {
  return new Promise<V>((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    });
  });
}

export interface CheapCounters {
  /** analytics_queries row count; null until the first background count lands. */
  getQueryCount(db: { prepare(sql: string): { get(): unknown } }): number | null;
  /** honestCatalogCounts(); every vertical null until the first background fill lands. */
  getCatalog(): Counts;
  settled(): Promise<void>;
  reset(): void;
}

export function createCheapCounters(deps: {
  catalog?: () => Counts;
  ttlMs?: number;
  now?: () => number;
} = {}): CheapCounters {
  let queryDb: { prepare(sql: string): { get(): unknown } } | null = null;
  const common = {
    ttlMs: deps.ttlMs ?? HEALTH_CHEAP_COUNTS_TTL_MS,
    retryAfterMs: RETRY_MS,
    now: deps.now,
    onError: (key: string, err: unknown) =>
      console.warn(`[health-cheap-counts] ${key} refresh failed: ${err instanceof Error ? err.message : String(err)}`),
  };
  const queries = createSwrCache<number>({
    ...common,
    refresh: () =>
      deferred(() => {
        if (!queryDb) throw new Error("no DB handle for analytics_queries count");
        return (queryDb.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as { c: number }).c;
      }),
  });
  const catalogFn = deps.catalog ?? honestCatalogCounts;
  const catalog = createSwrCache<Counts>({ ...common, refresh: () => deferred(catalogFn) });
  return {
    getQueryCount(db) {
      queryDb = db;
      return queries.get("q")?.value ?? null;
    },
    getCatalog() {
      return catalog.get("c")?.value ?? NULL_CATALOG;
    },
    settled: async () => {
      await Promise.all([queries.settled("q"), catalog.settled("c")]);
    },
    reset() {
      queries.clear();
      catalog.clear();
    },
  };
}

const defaultCounters = createCheapCounters();

export function getHealthQueryCount(db: { prepare(sql: string): { get(): unknown } }): number | null {
  return defaultCounters.getQueryCount(db);
}
export function getHealthCatalog(): Counts {
  return defaultCounters.getCatalog();
}
export function __resetHealthCheapCountsForTesting(): void {
  defaultCounters.reset();
}
