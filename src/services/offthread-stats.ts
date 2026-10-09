// ─── Off-thread analytics stats: worker manager + stale-while-revalidate ──
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
//
// Problem (named by the event-loop monitor, PR #922, 2026-09-26): the
// homepage traffic strip on all three hosts called getTrafficStats(), which
// runs full scans of analytics_page_views (~1.2 M rows) synchronously on the
// one main thread every time its 2-minute cache expired. Each refresh froze
// every host for 8–23 s, so Glama's hourly MCP check and Fly's own health
// check intermittently timed out. /health's COUNT(*) did the same for ~1.8 s.
//
// Fix: those aggregations now run in ONE long-lived worker thread
// (offthread-stats-worker.ts) with its own read-only DB connection, and the
// request path only ever reads an in-memory cache (createSwrCache below):
// a fresh value is returned as-is, a stale one is returned immediately while
// a background refresh runs, and a missing one kicks off the first refresh.
//
// Safety valve: failures are counted per task (e.g. trafficStats:rfb) — a
// task error, a timeout, or a worker crash/start failure while the task was
// queued. When any one task fails OFFTHREAD_MAX_CONSECUTIVE_FAILURES times in
// a row (its own successes reset it; other tasks' successes do not), the
// manager marks that task key broken and its callers (only) fall back to the old synchronous
// code path, so the worst case is exactly the pre-fix behaviour.
// Kill switch: OFFTHREAD_STATS_DISABLED=1 (the test suite sets it). In-memory
// DBs never use the worker (a worker cannot open another thread's :memory:
// DB), and neither do DBs outside WAL mode (a long read there would hold a
// SHARED lock and make the main thread's writes wait or fail with BUSY).
//
// Known interaction: a manual/weekly `wal_checkpoint(TRUNCATE)` waits (up to
// the 5 s busy timeout) for a worker read in progress to finish.
//
// Lanes (dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-
// samtaler, skive 3): tasks run in one of two workers. The "background" lane
// carries the periodic refreshes (trafficStats, pageViewCounts) exactly as
// before; the "admin" lane carries the admin-dashboard statistics
// (kind "adminStats", see admin-stats.ts) in its own worker with its own
// read-only connection, so an admin request never queues behind an 8–23 s
// traffic-stats refresh. Admin tasks are never marked broken: their callers
// have no synchronous fallback to switch to (a failure is a 503 there).

import { Worker } from "worker_threads";
import * as path from "path";
import type Database from "better-sqlite3";
import type { StatsTask, StatsWorkerRequest, StatsWorkerResponse } from "./offthread-stats-worker";

export const OFFTHREAD_MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Generous on purpose: prod computations take 8–23 s, tasks queue behind each
 * other (three at boot), and three timeouts in a row switch the stats back to
 * the synchronous path. This only needs to catch a genuinely hung worker.
 */
export const OFFTHREAD_TASK_TIMEOUT_MS = 300_000;
/** V8 old-space cap for the worker, so a runaway query cannot eat the 1 GB machine. */
const WORKER_MAX_OLD_GEN_MB = 256;

export type StatsLane = "background" | "admin";
const LANES: StatsLane[] = ["background", "admin"];

type Pending = {
  key: string;
  /** False for admin-lane tasks: failures are counted but never trip the fallback. */
  breakable: boolean;
  postedAt: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type LaneState = {
  worker: Worker | null;
  workerDbPath: string | null;
  pending: Map<number, Pending>;
};

const lanes: Record<StatsLane, LaneState> = {
  background: { worker: null, workerDbPath: null, pending: new Map() },
  admin: { worker: null, workerDbPath: null, pending: new Map() },
};
let nextId = 1;
const failuresByTask = new Map<string, number>();
const lastRuns = new Map<string, { at: string; durationMs: number; ok: boolean; error?: string }>();
const brokenKeys = new Map<string, string>(); // task key -> reason
const workerScriptOverride: Record<StatsLane, string | null> = { background: null, admin: null };
const walModeByDb = new WeakMap<object, boolean>();
let lastWalMode: boolean | null = null;
let walErrorLogged = false;

/** Stable per-task key used for failure accounting and the admin report. */
export function statsTaskKey(task: StatsTask): string {
  if (task.kind === "trafficStats") return `trafficStats:${task.vertical ?? "all"}`;
  if (task.kind === "adminStats") return `adminStats:${task.query.name}`;
  return task.kind;
}

/** Which worker a task runs in. Unknown kinds stay on the background lane. */
export function statsTaskLane(task: StatsTask): StatsLane {
  return task.kind === "adminStats" ? "admin" : "background";
}

function workerScriptPath(lane: StatsLane): string {
  const override = workerScriptOverride[lane];
  if (override) return override;
  // Same extension as this module: .ts under tsx (prod runs `tsx src/index.ts`),
  // .js under a compiled `node dist/index.js`.
  return path.join(__dirname, "offthread-stats-worker" + path.extname(__filename));
}

function isWalMode(db: Database.Database): boolean {
  const cached = walModeByDb.get(db);
  if (cached !== undefined) return cached;
  try {
    const wal = String(db.pragma("journal_mode", { simple: true })).toLowerCase() === "wal";
    walModeByDb.set(db, wal);
    lastWalMode = wal;
    return wal;
  } catch (e) {
    // Do not cache a failed probe: a transient error must not pin this DB to
    // the synchronous path for the rest of the process.
    if (!walErrorLogged) {
      walErrorLogged = true;
      console.error(`[offthread-stats] journal_mode probe failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }
}

/**
 * True when the aggregations for this DB handle should run in the worker.
 * With a task `key` only that task's broken state matters; without one, any
 * broken task makes it false.
 */
export function offThreadStatsUsable(db: Database.Database, key?: string): boolean {
  if (key === undefined ? brokenKeys.size > 0 : brokenKeys.has(key)) return false;
  return offThreadStatsEnvUsable(db);
}

/**
 * The environment half of offThreadStatsUsable(), without the broken-task
 * check: kill switch off, file-backed DB, WAL mode. Used by the admin
 * statistics (admin-stats.ts), which keep using the worker after failures
 * and answer 503 instead of falling back to the main thread.
 */
export function offThreadStatsEnvUsable(db: Database.Database): boolean {
  if (process.env.OFFTHREAD_STATS_DISABLED === "1") return false;
  if (db.memory) return false;
  const name = db.name;
  if (typeof name !== "string" || name === "" || name === ":memory:") return false;
  return isWalMode(db);
}

function recordFailure(key: string, err: Error, durationMs: number, breakable: boolean): void {
  const n = (failuresByTask.get(key) ?? 0) + 1;
  failuresByTask.set(key, n);
  lastRuns.set(key, { at: new Date().toISOString(), durationMs, ok: false, error: err.message });
  if (breakable && !brokenKeys.has(key) && n >= OFFTHREAD_MAX_CONSECUTIVE_FAILURES) {
    brokenKeys.set(key, err.message);
    console.error(
      `[offthread-stats] ${key} failed ${n} times in a row (last: ${err.message}); ` +
        `falling back to synchronous stats on the main thread for this task`
    );
  }
}

function recordSuccess(key: string, durationMs: number): void {
  failuresByTask.set(key, 0);
  lastRuns.set(key, { at: new Date().toISOString(), durationMs, ok: true });
}

/**
 * Rejects every task still waiting on the current worker. `countAsFailure`
 * charges each task's key (worker crashed/exited while it was queued);
 * otherwise they are rejected without blame (worker deliberately replaced).
 */
function failAllPending(lane: StatsLane, err: Error, countAsFailure: boolean): void {
  const now = Date.now();
  const pending = lanes[lane].pending;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    if (countAsFailure) recordFailure(p.key, err, now - p.postedAt, p.breakable);
    p.reject(err);
  }
}

/** Keeps the process alive exactly while a task is pending (0->1 ref, back to 0 unref). */
function syncRef(lane: StatsLane): void {
  const st = lanes[lane];
  if (!st.worker) return;
  if (st.pending.size > 0) st.worker.ref();
  else st.worker.unref();
}

function dropWorker(lane: StatsLane): void {
  const st = lanes[lane];
  const w = st.worker;
  st.worker = null;
  st.workerDbPath = null;
  if (w) {
    w.removeAllListeners();
    // Keep a no-op error listener: terminate() on a worker that is still
    // starting can emit 'error', and an unhandled one would crash the process.
    w.on("error", () => {});
    void w.terminate().catch(() => {});
  }
}

function ensureWorker(lane: StatsLane, dbPath: string): Worker {
  const st = lanes[lane];
  if (st.worker && st.workerDbPath === dbPath) return st.worker;
  if (st.worker) {
    failAllPending(lane, new Error("stats worker replaced (DB path changed)"), false);
    dropWorker(lane);
  }
  const script = workerScriptPath(lane);
  const options = {
    workerData: { dbPath },
    resourceLimits: { maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB },
  };
  // tsx's loader hooks do not carry over into worker threads: on Node 20 (prod,
  // node:20-alpine) a .ts entry fails with "Unknown file extension .ts", and on
  // Node >= 22.18 Node's own type stripping takes over and cannot resolve the
  // extensionless relative imports. So a .ts entry is started through a tiny
  // CommonJS bootstrap that registers tsx's require hook inside the worker
  // first. A compiled .js entry (node dist/index.js) is started directly.
  const w = script.endsWith(".ts")
    ? new Worker(`require(${JSON.stringify(require.resolve("tsx/cjs"))});\nrequire(${JSON.stringify(script)});`, {
        ...options,
        eval: true,
      })
    : new Worker(script, options);
  w.unref(); // ref()ed only while tasks are pending (see syncRef)
  w.on("message", (res: StatsWorkerResponse) => {
    const p = st.pending.get(res.id);
    if (!p) return;
    st.pending.delete(res.id);
    syncRef(lane);
    clearTimeout(p.timer);
    const durationMs = Date.now() - p.postedAt;
    if (res.ok) {
      recordSuccess(p.key, durationMs);
      p.resolve(res.result);
    } else {
      const err = new Error(res.error);
      recordFailure(p.key, err, durationMs, p.breakable);
      p.reject(err);
    }
  });
  w.on("error", (e: Error) => {
    if (st.worker !== w) return;
    dropWorker(lane);
    failAllPending(lane, new Error(`stats worker error: ${e.message}`), true);
  });
  w.on("exit", (code) => {
    if (st.worker !== w) return;
    dropWorker(lane);
    failAllPending(lane, new Error(`stats worker exited (code ${code})`), true);
  });
  st.worker = w;
  st.workerDbPath = dbPath;
  return w;
}

/**
 * Runs one stats task in its lane's worker (statsTaskLane) against the DB
 * file at `dbPath`. Rejects on task error, worker crash, or timeout (the
 * worker is then replaced on the next call). Durations include time queued
 * behind other tasks in the same lane's worker.
 */
export function runStatsTaskOffThread<T>(
  dbPath: string,
  task: StatsTask,
  timeoutMs: number = OFFTHREAD_TASK_TIMEOUT_MS
): Promise<T> {
  const key = statsTaskKey(task);
  const lane = statsTaskLane(task);
  const breakable = lane !== "admin";
  const pending = lanes[lane].pending;
  let w: Worker;
  try {
    w = ensureWorker(lane, dbPath);
  } catch (e) {
    const err = new Error(`stats worker could not start: ${e instanceof Error ? e.message : String(e)}`);
    recordFailure(key, err, 0, breakable);
    return Promise.reject(err);
  }
  const id = nextId++;
  const postedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      syncRef(lane);
      const err = new Error(`stats task ${key} timed out after ${timeoutMs} ms`);
      recordFailure(key, err, Date.now() - postedAt, breakable);
      // A task that overruns this long is stuck; replace the worker. Tasks
      // queued behind it are rejected without blame and retried on their
      // next read.
      dropWorker(lane);
      failAllPending(lane, new Error(`stats worker replaced after ${key} timed out`), false);
      reject(err);
    }, timeoutMs);
    timer.unref();
    pending.set(id, { key, breakable, postedAt, resolve: resolve as (v: unknown) => void, reject, timer });
    if (pending.size === 1) w.ref();
    const req: StatsWorkerRequest = { id, task };
    w.postMessage(req);
  });
}

export interface OffThreadStatsState {
  /** True when any lane's worker is running. */
  workerRunning: boolean;
  /** Tasks pending across all lanes. */
  pendingTasks: number;
  /** Per-lane worker state (background = periodic refreshes, admin = admin dashboard). */
  lanes: Record<StatsLane, { workerRunning: boolean; pendingTasks: number }>;
  /** Highest current run of consecutive failures across tasks. */
  consecutiveFailures: number;
  failuresByTask: Record<string, number>;
  /** Last completion per task (duration includes queueing in the worker). */
  lastRuns: Record<string, { at: string; durationMs: number; ok: boolean; error?: string }>;
  /** True when at least one task is broken. */
  broken: boolean;
  /** First broken task's reason (kept for compatibility). */
  brokenReason: string | null;
  /** Task keys currently on the synchronous fallback, with reasons. */
  brokenKeys: string[];
  brokenReasons: Record<string, string>;
  /** Last successfully probed WAL state; null when never probed successfully. */
  walMode: boolean | null;
}

export function getOffThreadStatsState(): OffThreadStatsState {
  let max = 0;
  for (const n of failuresByTask.values()) max = Math.max(max, n);
  const laneState = {} as Record<StatsLane, { workerRunning: boolean; pendingTasks: number }>;
  for (const l of LANES) laneState[l] = { workerRunning: lanes[l].worker !== null, pendingTasks: lanes[l].pending.size };
  return {
    workerRunning: LANES.some((l) => lanes[l].worker !== null),
    pendingTasks: LANES.reduce((n, l) => n + lanes[l].pending.size, 0),
    lanes: laneState,
    consecutiveFailures: max,
    failuresByTask: Object.fromEntries(failuresByTask),
    lastRuns: Object.fromEntries(lastRuns),
    broken: brokenKeys.size > 0,
    brokenReason: brokenKeys.size > 0 ? `${[...brokenKeys][0][0]}: ${[...brokenKeys][0][1]}` : null,
    brokenKeys: [...brokenKeys.keys()],
    brokenReasons: Object.fromEntries(brokenKeys),
    walMode: lastWalMode,
  };
}

// ── Stale-while-revalidate cache ──────────────────────────────────────

export interface SwrCacheOptions<V> {
  /** Age after which a read triggers a background refresh. */
  ttlMs: number;
  /** Produces a fresh value for the key (runs off the request path). */
  refresh: (key: string) => Promise<V>;
  /** Minimum wait after a failed refresh before the next attempt for that key. */
  retryAfterMs?: number;
  now?: () => number;
  onError?: (key: string, err: unknown) => void;
  /**
   * Optional cap on stored values. When a new key would exceed it, the
   * least recently written key is dropped. Unset = unbounded (the fixed-key
   * caches); the admin statistics use it because their keys carry
   * caller-chosen window sizes.
   */
  maxEntries?: number;
}

export interface SwrHit<V> {
  value: V;
  ageMs: number;
}

export interface SwrCache<V> {
  /** Cached value (possibly stale) or undefined; schedules a refresh when stale/missing. */
  get(key: string): SwrHit<V> | undefined;
  /** Stores a value computed elsewhere (e.g. a one-off synchronous first fill). */
  set(key: string, value: V): void;
  has(key: string): boolean;
  /** Starts a refresh now unless one is running or the key is in its retry back-off. */
  refresh(key: string): Promise<void>;
  /** Resolves when the key's in-flight refresh (if any) has settled. */
  settled(key: string): Promise<void>;
  /** Drops all values; refreshes already in flight are ignored when they land. */
  clear(): void;
}

export function createSwrCache<V>(opts: SwrCacheOptions<V>): SwrCache<V> {
  const now = opts.now ?? Date.now;
  const retryAfterMs = opts.retryAfterMs ?? 60_000;
  const entries = new Map<string, { value: V; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  const lastFailureAt = new Map<string, number>();
  // Bumped by clear(): a refresh started before a clear() must not write its
  // (possibly other-DB) result into the cleared cache.
  let generation = 0;

  function refresh(key: string): Promise<void> {
    const running = inflight.get(key);
    if (running) return running;
    const failedAt = lastFailureAt.get(key);
    const t = now();
    if (failedAt !== undefined && t >= failedAt && t - failedAt < retryAfterMs) return Promise.resolve();
    const gen = generation;
    let p: Promise<V>;
    try {
      p = opts.refresh(key);
    } catch (err) {
      p = Promise.reject(err);
    }
    const tracked: Promise<void> = p.then(
      (value) => {
        if (gen !== generation) return;
        store(key, value);
        lastFailureAt.delete(key);
      },
      (err) => {
        if (gen !== generation) return;
        lastFailureAt.set(key, now());
        try {
          if (opts.onError) opts.onError(key, err);
        } catch {
          // a logging failure must never turn into an unhandled rejection
        }
      }
    ).finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
    inflight.set(key, tracked);
    return tracked;
  }

  function store(key: string, value: V): void {
    // Re-insert so Map order is "least recently written first".
    entries.delete(key);
    entries.set(key, { value, at: now() });
    if (opts.maxEntries !== undefined) {
      while (entries.size > Math.max(1, opts.maxEntries)) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
        lastFailureAt.delete(oldest);
      }
    }
  }

  return {
    get(key) {
      const e = entries.get(key);
      const t = now();
      if (!e || t < e.at || t - e.at >= opts.ttlMs) void refresh(key);
      return e ? { value: e.value, ageMs: Math.max(0, t - e.at) } : undefined;
    },
    set(key, value) {
      store(key, value);
    },
    has(key) {
      return entries.has(key);
    },
    refresh,
    settled(key) {
      return inflight.get(key) ?? Promise.resolve();
    },
    clear() {
      generation += 1;
      entries.clear();
      inflight.clear();
      lastFailureAt.clear();
    },
  };
}

// ── Test hooks ────────────────────────────────────────────────────────

export function __resetOffThreadStatsForTesting(): void {
  for (const l of LANES) {
    failAllPending(l, new Error("reset for testing"), false);
    dropWorker(l);
  }
  failuresByTask.clear();
  lastRuns.clear();
  brokenKeys.clear();
  lastWalMode = null;
  walErrorLogged = false;
  for (const l of LANES) workerScriptOverride[l] = null;
}

/**
 * Points the manager at a different worker script (e.g. one that fails to
 * load), for one lane or (no lane) for both.
 */
export function __setWorkerScriptForTesting(scriptPath: string | null, lane?: StatsLane): void {
  for (const l of lane ? [lane] : LANES) {
    failAllPending(l, new Error("stats worker replaced for testing"), false);
    dropWorker(l);
    workerScriptOverride[l] = scriptPath;
  }
}
