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
// manager marks itself broken and callers fall back to the old synchronous
// code path, so the worst case is exactly the pre-fix behaviour.
// Kill switch: OFFTHREAD_STATS_DISABLED=1 (the test suite sets it). In-memory
// DBs never use the worker (a worker cannot open another thread's :memory:
// DB), and neither do DBs outside WAL mode (a long read there would hold a
// SHARED lock and make the main thread's writes wait or fail with BUSY).
//
// Known interaction: a manual/weekly `wal_checkpoint(TRUNCATE)` waits (up to
// the 5 s busy timeout) for a worker read in progress to finish.

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

type Pending = {
  key: string;
  postedAt: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: Worker | null = null;
let workerDbPath: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const failuresByTask = new Map<string, number>();
const lastRuns = new Map<string, { at: string; durationMs: number; ok: boolean; error?: string }>();
let broken = false;
let brokenReason: string | null = null;
let workerScriptOverride: string | null = null;
const walModeByDb = new WeakMap<object, boolean>();

/** Stable per-task key used for failure accounting and the admin report. */
export function statsTaskKey(task: StatsTask): string {
  return task.kind === "trafficStats" ? `trafficStats:${task.vertical ?? "all"}` : task.kind;
}

function workerScriptPath(): string {
  if (workerScriptOverride) return workerScriptOverride;
  // Same extension as this module: .ts under tsx (prod runs `tsx src/index.ts`),
  // .js under a compiled `node dist/index.js`.
  return path.join(__dirname, "offthread-stats-worker" + path.extname(__filename));
}

function isWalMode(db: Database.Database): boolean {
  const cached = walModeByDb.get(db);
  if (cached !== undefined) return cached;
  let wal = false;
  try {
    wal = String(db.pragma("journal_mode", { simple: true })).toLowerCase() === "wal";
  } catch {
    wal = false;
  }
  walModeByDb.set(db, wal);
  return wal;
}

/** True when the aggregations for this DB handle should run in the worker. */
export function offThreadStatsUsable(db: Database.Database): boolean {
  if (broken) return false;
  if (process.env.OFFTHREAD_STATS_DISABLED === "1") return false;
  if (db.memory) return false;
  const name = db.name;
  if (typeof name !== "string" || name === "" || name === ":memory:") return false;
  return isWalMode(db);
}

function recordFailure(key: string, err: Error, durationMs: number): void {
  const n = (failuresByTask.get(key) ?? 0) + 1;
  failuresByTask.set(key, n);
  lastRuns.set(key, { at: new Date().toISOString(), durationMs, ok: false, error: err.message });
  if (!broken && n >= OFFTHREAD_MAX_CONSECUTIVE_FAILURES) {
    broken = true;
    brokenReason = `${key}: ${err.message}`;
    console.error(
      `[offthread-stats] ${key} failed ${n} times in a row (last: ${err.message}); ` +
        `falling back to synchronous stats on the main thread`
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
function failAllPending(err: Error, countAsFailure: boolean): void {
  const now = Date.now();
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    if (countAsFailure) recordFailure(p.key, err, now - p.postedAt);
    p.reject(err);
  }
}

function dropWorker(): void {
  const w = worker;
  worker = null;
  workerDbPath = null;
  if (w) {
    w.removeAllListeners();
    // Keep a no-op error listener: terminate() on a worker that is still
    // starting can emit 'error', and an unhandled one would crash the process.
    w.on("error", () => {});
    void w.terminate().catch(() => {});
  }
}

function ensureWorker(dbPath: string): Worker {
  if (worker && workerDbPath === dbPath) return worker;
  if (worker) {
    failAllPending(new Error("stats worker replaced (DB path changed)"), false);
    dropWorker();
  }
  const script = workerScriptPath();
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
  w.unref();
  w.on("message", (res: StatsWorkerResponse) => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    const durationMs = Date.now() - p.postedAt;
    if (res.ok) {
      recordSuccess(p.key, durationMs);
      p.resolve(res.result);
    } else {
      const err = new Error(res.error);
      recordFailure(p.key, err, durationMs);
      p.reject(err);
    }
  });
  w.on("error", (e: Error) => {
    if (worker !== w) return;
    dropWorker();
    failAllPending(new Error(`stats worker error: ${e.message}`), true);
  });
  w.on("exit", (code) => {
    if (worker !== w) return;
    dropWorker();
    failAllPending(new Error(`stats worker exited (code ${code})`), true);
  });
  worker = w;
  workerDbPath = dbPath;
  return w;
}

/**
 * Runs one stats task in the worker against the DB file at `dbPath`.
 * Rejects on task error, worker crash, or timeout (the worker is then
 * replaced on the next call). Durations include time queued behind other
 * tasks in the worker.
 */
export function runStatsTaskOffThread<T>(
  dbPath: string,
  task: StatsTask,
  timeoutMs: number = OFFTHREAD_TASK_TIMEOUT_MS
): Promise<T> {
  const key = statsTaskKey(task);
  let w: Worker;
  try {
    w = ensureWorker(dbPath);
  } catch (e) {
    const err = new Error(`stats worker could not start: ${e instanceof Error ? e.message : String(e)}`);
    recordFailure(key, err, 0);
    return Promise.reject(err);
  }
  const id = nextId++;
  const postedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const err = new Error(`stats task ${key} timed out after ${timeoutMs} ms`);
      recordFailure(key, err, Date.now() - postedAt);
      // A task that overruns this long is stuck; replace the worker. Tasks
      // queued behind it are rejected without blame and retried on their
      // next read.
      dropWorker();
      failAllPending(new Error(`stats worker replaced after ${key} timed out`), false);
      reject(err);
    }, timeoutMs);
    timer.unref();
    pending.set(id, { key, postedAt, resolve: resolve as (v: unknown) => void, reject, timer });
    const req: StatsWorkerRequest = { id, task };
    w.postMessage(req);
  });
}

export interface OffThreadStatsState {
  workerRunning: boolean;
  pendingTasks: number;
  /** Highest current run of consecutive failures across tasks. */
  consecutiveFailures: number;
  failuresByTask: Record<string, number>;
  /** Last completion per task (duration includes queueing in the worker). */
  lastRuns: Record<string, { at: string; durationMs: number; ok: boolean; error?: string }>;
  broken: boolean;
  brokenReason: string | null;
}

export function getOffThreadStatsState(): OffThreadStatsState {
  let max = 0;
  for (const n of failuresByTask.values()) max = Math.max(max, n);
  return {
    workerRunning: worker !== null,
    pendingTasks: pending.size,
    consecutiveFailures: max,
    failuresByTask: Object.fromEntries(failuresByTask),
    lastRuns: Object.fromEntries(lastRuns),
    broken,
    brokenReason,
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
        entries.set(key, { value, at: now() });
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

  return {
    get(key) {
      const e = entries.get(key);
      const t = now();
      if (!e || t < e.at || t - e.at >= opts.ttlMs) void refresh(key);
      return e ? { value: e.value, ageMs: Math.max(0, t - e.at) } : undefined;
    },
    set(key, value) {
      entries.set(key, { value, at: now() });
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
  failAllPending(new Error("reset for testing"), false);
  dropWorker();
  failuresByTask.clear();
  lastRuns.clear();
  broken = false;
  brokenReason = null;
  workerScriptOverride = null;
}

/** Points the manager at a different worker script (e.g. one that fails to load). */
export function __setWorkerScriptForTesting(scriptPath: string | null): void {
  failAllPending(new Error("stats worker replaced for testing"), false);
  dropWorker();
  workerScriptOverride = scriptPath;
}
