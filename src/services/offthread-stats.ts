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
// Safety valve: after OFFTHREAD_MAX_CONSECUTIVE_FAILURES failures in a row
// (worker cannot start, crashes, times out, or a task throws) the manager
// marks itself broken and callers fall back to the old synchronous code path,
// so the worst case is exactly the pre-fix behaviour. Kill switch:
// OFFTHREAD_STATS_DISABLED=1 (the test suite sets it; in-memory DBs never
// use the worker because a worker cannot open another thread's :memory: DB).

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
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

let worker: Worker | null = null;
let workerDbPath: string | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let consecutiveFailures = 0;
let broken = false;
let brokenReason: string | null = null;
let workerScriptOverride: string | null = null;

function workerScriptPath(): string {
  if (workerScriptOverride) return workerScriptOverride;
  // Same extension as this module: .ts under tsx (prod runs `tsx src/index.ts`),
  // .js under a compiled `node dist/index.js`.
  return path.join(__dirname, "offthread-stats-worker" + path.extname(__filename));
}

/** True when the aggregations for this DB handle should run in the worker. */
export function offThreadStatsUsable(db: Database.Database): boolean {
  if (broken) return false;
  if (process.env.OFFTHREAD_STATS_DISABLED === "1") return false;
  if (db.memory) return false;
  const name = db.name;
  return typeof name === "string" && name !== "" && name !== ":memory:";
}

function recordFailure(err: Error): void {
  consecutiveFailures += 1;
  if (!broken && consecutiveFailures >= OFFTHREAD_MAX_CONSECUTIVE_FAILURES) {
    broken = true;
    brokenReason = err.message;
    console.error(
      `[offthread-stats] disabled after ${consecutiveFailures} consecutive failures ` +
        `(last: ${err.message}); falling back to synchronous stats on the main thread`
    );
  }
}

function failAllPending(err: Error): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
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
  if (worker) dropWorker();
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
    if (res.ok) {
      consecutiveFailures = 0;
      p.resolve(res.result);
    } else {
      const err = new Error(res.error);
      recordFailure(err);
      p.reject(err);
    }
  });
  w.on("error", (e: Error) => {
    if (worker !== w) return;
    const err = new Error(`stats worker error: ${e.message}`);
    recordFailure(err);
    dropWorker();
    failAllPending(err);
  });
  w.on("exit", (code) => {
    if (worker !== w) return;
    const err = new Error(`stats worker exited (code ${code})`);
    recordFailure(err);
    dropWorker();
    failAllPending(err);
  });
  worker = w;
  workerDbPath = dbPath;
  return w;
}

/**
 * Runs one stats task in the worker against the DB file at `dbPath`.
 * Rejects on task error, worker crash, or timeout (the worker is then
 * replaced on the next call).
 */
export function runStatsTaskOffThread<T>(
  dbPath: string,
  task: StatsTask,
  timeoutMs: number = OFFTHREAD_TASK_TIMEOUT_MS
): Promise<T> {
  let w: Worker;
  try {
    w = ensureWorker(dbPath);
  } catch (e) {
    const err = new Error(`stats worker could not start: ${e instanceof Error ? e.message : String(e)}`);
    recordFailure(err);
    return Promise.reject(err);
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const err = new Error(`stats task ${task.kind} timed out after ${timeoutMs} ms`);
      recordFailure(err);
      // A task that overruns this long is stuck; replace the worker. Other
      // tasks queued behind it fail now and are retried on their next read.
      dropWorker();
      failAllPending(err);
      reject(err);
    }, timeoutMs);
    timer.unref();
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const req: StatsWorkerRequest = { id, task };
    w.postMessage(req);
  });
}

export interface OffThreadStatsState {
  workerRunning: boolean;
  pendingTasks: number;
  consecutiveFailures: number;
  broken: boolean;
  brokenReason: string | null;
}

export function getOffThreadStatsState(): OffThreadStatsState {
  return {
    workerRunning: worker !== null,
    pendingTasks: pending.size,
    consecutiveFailures,
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
  clear(): void;
}

export function createSwrCache<V>(opts: SwrCacheOptions<V>): SwrCache<V> {
  const now = opts.now ?? Date.now;
  const retryAfterMs = opts.retryAfterMs ?? 60_000;
  const entries = new Map<string, { value: V; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  const lastFailureAt = new Map<string, number>();

  function refresh(key: string): Promise<void> {
    const running = inflight.get(key);
    if (running) return running;
    const failedAt = lastFailureAt.get(key);
    const t = now();
    if (failedAt !== undefined && t >= failedAt && t - failedAt < retryAfterMs) return Promise.resolve();
    let p: Promise<V>;
    try {
      p = opts.refresh(key);
    } catch (err) {
      p = Promise.reject(err);
    }
    const tracked = p.then(
      (value) => {
        entries.set(key, { value, at: now() });
        lastFailureAt.delete(key);
      },
      (err) => {
        lastFailureAt.set(key, now());
        try {
          if (opts.onError) opts.onError(key, err);
        } catch {
          // a logging failure must never turn into an unhandled rejection
        }
      }
    ).finally(() => {
      inflight.delete(key);
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
      entries.clear();
      inflight.clear();
      lastFailureAt.clear();
    },
  };
}

// ── Test hooks ────────────────────────────────────────────────────────

export function __resetOffThreadStatsForTesting(): void {
  failAllPending(new Error("reset for testing"));
  dropWorker();
  consecutiveFailures = 0;
  broken = false;
  brokenReason = null;
  workerScriptOverride = null;
}

/** Points the manager at a different worker script (e.g. one that fails to load). */
export function __setWorkerScriptForTesting(scriptPath: string | null): void {
  dropWorker();
  workerScriptOverride = scriptPath;
}
