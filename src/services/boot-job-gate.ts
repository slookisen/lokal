/**
 * boot-job-gate.ts — dev-request 2026-10-02-boot-jobber-event-loop-stall-etter-deploy.
 *
 * Right after every deploy three heavy boot jobs (boot-trust-recalc,
 * url-backfill, postal-backfill) collided on the single Node thread and
 * stalled the event loop for up to 11 s. This module holds the small shared
 * pieces that spread them out:
 *
 *   - yieldToEventLoop() / runChunked(): process a list in short slices with
 *     a macrotask yield (and optional pause) between slices.
 *   - runExclusiveBootJob(): a FIFO gate so boot jobs never run concurrently.
 *   - persisted "last completed" timestamps (table boot_job_state, created in
 *     database/init.ts) + shouldSkipRecentRun(): lets url-backfill skip a
 *     restart that happens soon after its last completed run.
 *
 * Nothing here changes what a job computes — only when and in what slices.
 */

export const URL_BACKFILL_JOB = "url-backfill";
export const URL_BACKFILL_DEFAULT_MIN_INTERVAL_HOURS = 12;
/** url-backfill starts this long after boot (was 5 s). */
export const URL_BACKFILL_BOOT_DELAY_MS = 5 * 60 * 1000;

/** Resolve on the next macrotask so queued I/O and timers can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : yieldToEventLoop();
}

/**
 * Run `processSlice` over `items` in slices of at most `chunkSize` items,
 * yielding to the event loop (plus `pauseMs`, default 0 = setImmediate only)
 * between slices. `processSlice` is synchronous work and may be async.
 */
export async function runChunked<T>(
  items: readonly T[],
  processSlice: (slice: T[], startIndex: number) => void | Promise<void>,
  opts: { chunkSize: number; pauseMs?: number }
): Promise<{ chunks: number }> {
  const size = Math.max(1, Math.floor(opts.chunkSize));
  let chunks = 0;
  for (let i = 0; i < items.length; i += size) {
    if (i > 0) await pause(opts.pauseMs ?? 0);
    await processSlice(items.slice(i, i + size) as T[], i);
    chunks++;
  }
  return { chunks };
}

// ── Exclusive gate ───────────────────────────────────────────────────
let gateTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` only after every previously queued boot job has settled. A failing
 * job never blocks the queue; its error propagates to the caller only.
 */
export function runExclusiveBootJob<R>(fn: () => R | Promise<R>): Promise<R> {
  const run = gateTail.then(() => fn());
  gateTail = run.then(() => undefined, () => undefined);
  return run;
}

// ── Persisted last-completed timestamp ───────────────────────────────
function ensureTable(db: any): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS boot_job_state (
       job TEXT PRIMARY KEY,
       last_completed_at TEXT NOT NULL
     )`
  );
}

export function getJobLastCompletedAt(db: any, job: string): Date | null {
  try {
    ensureTable(db);
    const row = db.prepare("SELECT last_completed_at FROM boot_job_state WHERE job = ?").get(job) as
      | { last_completed_at: string }
      | undefined;
    if (!row) return null;
    const t = Date.parse(row.last_completed_at);
    return Number.isNaN(t) ? null : new Date(t);
  } catch {
    return null; // unknown state must never block a job from running
  }
}

export function markJobCompleted(db: any, job: string, at: Date = new Date()): void {
  try {
    ensureTable(db);
    db.prepare(
      `INSERT INTO boot_job_state (job, last_completed_at) VALUES (?, ?)
       ON CONFLICT(job) DO UPDATE SET last_completed_at = excluded.last_completed_at`
    ).run(job, at.toISOString());
  } catch (err) {
    console.error(`[boot-job-state] could not persist completion of ${job} (non-fatal):`, err);
  }
}

/** Parse the min-interval env value (hours); falls back to the default on junk. 0 disables skipping. */
export function resolveMinIntervalHours(raw: string | undefined, fallback = URL_BACKFILL_DEFAULT_MIN_INTERVAL_HOURS): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** True when the last completed run is younger than `minIntervalHours`. */
export function shouldSkipRecentRun(opts: { lastCompletedAt: Date | null; now: Date; minIntervalHours: number }): boolean {
  if (!opts.lastCompletedAt || opts.minIntervalHours <= 0) return false;
  const ageMs = opts.now.getTime() - opts.lastCompletedAt.getTime();
  if (ageMs < 0) return false; // clock skew / future stamp: do not trust it
  return ageMs < opts.minIntervalHours * 3600_000;
}
