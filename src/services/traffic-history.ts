// ─── Traffic history: the job that fills traffic_history ────────────────
// dev-request 2026-10-13-statistikk-riktig-for-investorer (A2A), S3.
// What is stored and why: traffic-history-compute.ts.
//
// Runs on the main thread, but the summaries are computed in the off-thread
// stats worker (background lane, task "trafficHistory") on its own read-only
// connection; this module only plans the work and writes the small result
// rows. Three triggers:
//   - boot (after a delay) and every hour: compute whatever is missing — after
//     a deploy that is the whole raw window (~60 days × 4 sites, plus the
//     finished weeks and months), afterwards yesterday and any finished week or
//     month;
//   - the nightly prune (index.ts) awaits one run before deleting anything;
//   - the prune itself (retention-service.ts) calls
//     ensureTrafficHistoryForDaySync() for each day it is about to delete, so
//     no raw day is deleted without its day summary even if the job failed.

import type Database from "better-sqlite3";
import {
  computeHistorySummary,
  HISTORY_VERTICALS,
  periodEnd,
  planHistoryItems,
  TRAFFIC_HISTORY_VERSION,
  type HistoryItem,
  type HistoryPeriod,
  type HistorySummary,
  type HistoryVertical,
  type StoredHistoryRow,
} from "./traffic-history-compute";

type Db = Database.Database;

function hasHistoryTable(db: Db): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'traffic_history'").get();
}

export function readStoredHistoryRows(db: Db): StoredHistoryRow[] {
  if (!hasHistoryTable(db)) return [];
  return (db.prepare("SELECT period, period_start, vertical, version, partial_from FROM traffic_history").all() as Array<{
    period: HistoryPeriod; period_start: string; vertical: HistoryVertical; version: number; partial_from: string | null;
  }>).map((r) => ({ period: r.period, start: r.period_start, vertical: r.vertical, version: r.version, partialFrom: r.partial_from }));
}

export function writeHistorySummary(db: Db, s: HistorySummary): void {
  db.prepare(`
    INSERT INTO traffic_history (period, period_start, period_end, vertical, version, partial_from, summary, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(period, period_start, vertical) DO UPDATE SET
      period_end = excluded.period_end,
      version = excluded.version,
      partial_from = excluded.partial_from,
      summary = excluded.summary,
      computed_at = excluded.computed_at
  `).run(s.period, s.start, s.end, s.vertical, s.version, s.partialFrom, JSON.stringify(s));
}

export interface TrafficHistoryRunResult {
  planned: number;
  computed: number;
  failed: number;
  errors: string[];
  ms: number;
}

export interface TrafficHistoryJobDeps {
  db: Db;
  nowMs?: number;
  /** Computes one summary; the default runs it in the stats worker when usable, else synchronously. */
  compute?: (item: HistoryItem, nowMs: number) => Promise<HistorySummary>;
  /** Stop after this many summaries (the rest is picked up by the next run). */
  maxItems?: number;
}

let running: Promise<TrafficHistoryRunResult> | null = null;
let lastRun: (TrafficHistoryRunResult & { at: string }) | null = null;

function defaultCompute(db: Db): (item: HistoryItem, nowMs: number) => Promise<HistorySummary> {
  return async (item, nowMs) => {
    // Lazy: keeps this module loadable in tests without the worker machinery.
    const off = require("./offthread-stats") as typeof import("./offthread-stats");
    if (off.offThreadStatsEnvUsable(db)) {
      return off.runStatsTaskOffThread<HistorySummary>(db.name, { kind: "trafficHistory", item, nowMs });
    }
    return computeHistorySummary(db, item, nowMs);
  };
}

/**
 * Computes and stores every missing summary, oldest first, one at a time (so
 * the worker's other tasks interleave). One run at a time: a second call while
 * one is running gets the running one's result.
 */
export function runTrafficHistoryJob(deps: TrafficHistoryJobDeps): Promise<TrafficHistoryRunResult> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const nowMs = deps.nowMs ?? Date.now();
    const compute = deps.compute ?? defaultCompute(deps.db);
    const result: TrafficHistoryRunResult = { planned: 0, computed: 0, failed: 0, errors: [], ms: 0 };
    try {
      if (!hasHistoryTable(deps.db)) return result;
      const items = planHistoryItems(deps.db, readStoredHistoryRows(deps.db), nowMs);
      result.planned = items.length;
      for (const item of items.slice(0, deps.maxItems ?? items.length)) {
        try {
          writeHistorySummary(deps.db, await compute(item, nowMs));
          result.computed += 1;
        } catch (err) {
          result.failed += 1;
          if (result.errors.length < 5) result.errors.push(`${item.period} ${item.start} ${item.vertical}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return result;
    } finally {
      result.ms = Date.now() - t0;
      lastRun = { ...result, at: new Date().toISOString() };
    }
  })().finally(() => { running = null; });
  return running;
}

export function getTrafficHistoryJobState(): { running: boolean; lastRun: typeof lastRun } {
  return { running: running !== null, lastRun };
}

/**
 * Safety net for the nightly prune: before raw day `day` is deleted, compute
 * (synchronously, on this thread) any of its day summaries that are missing.
 * One day is ~1/60 of the raw window, a few hundred ms at most. Throws when a
 * summary cannot be computed, so the prune stops before deleting the day
 * (retention-service.ts treats it like a failed rollup).
 */
export function ensureTrafficHistoryForDaySync(db: Db, day: string, nowMs: number = Date.now()): number {
  if (!hasHistoryTable(db) || process.env.TRAFFIC_HISTORY_DISABLED === "1") return 0;
  const have = new Set(
    (db.prepare("SELECT vertical FROM traffic_history WHERE period = 'day' AND period_start = ? AND version >= ?")
      .all(day, TRAFFIC_HISTORY_VERSION) as Array<{ vertical: string }>).map((r) => r.vertical),
  );
  let written = 0;
  for (const vertical of HISTORY_VERTICALS) {
    if (have.has(vertical)) continue;
    writeHistorySummary(db, computeHistorySummary(db, { period: "day", start: day, end: periodEnd("day", day), vertical }, nowMs));
    written += 1;
  }
  return written;
}

/** Boot + hourly runs (index.ts). Disabled with TRAFFIC_HISTORY_DISABLED=1. */
export function startTrafficHistoryScheduler(opts: {
  getDb: () => Db;
  bootDelayMs?: number;
  intervalMs?: number;
  log?: (msg: string) => void;
}): { stop: () => void } {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (process.env.TRAFFIC_HISTORY_DISABLED === "1") {
    log("[traffic-history] disabled (TRAFFIC_HISTORY_DISABLED=1)");
    return { stop: () => {} };
  }
  const tick = async () => {
    try {
      const r = await runTrafficHistoryJob({ db: opts.getDb() });
      if (r.planned > 0 || r.failed > 0) {
        log(`[traffic-history] planned=${r.planned} computed=${r.computed} failed=${r.failed} ms=${r.ms}` +
          (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""));
      }
    } catch (err) {
      console.error("[traffic-history] run failed (non-fatal):", err);
    }
  };
  const boot = setTimeout(() => { void tick(); }, opts.bootDelayMs ?? 3 * 60_000);
  const interval = setInterval(() => { void tick(); }, opts.intervalMs ?? 60 * 60_000);
  boot.unref?.();
  interval.unref?.();
  return { stop: () => { clearTimeout(boot); clearInterval(interval); } };
}
