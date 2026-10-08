// ─── Event-loop event persistence ───────────────────────────────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler,
// slice 1 ("Lagre frysene"). The monitor's ring buffers (event-loop-monitor.ts)
// live in memory and vanish on every deploy/restart — exactly when the
// interesting boot-time stalls happen. This module persists every stall, slow
// request and slow job to the `event_loop_events` table (database/init.ts).
//
// Hot-path safety: the monitor's sink only pushes onto an in-memory array
// (O(1), never throws). A short unref'd timer drains the buffer in ONE
// transaction. Rate is capped: at most MAX_PER_FLUSH rows per flush and
// MAX_BUFFER queued; the overflow is dropped and counted (stats.dropped).
// A failed flush (table missing, DB busy) drops that batch — it never retries
// in a tight loop and never throws.
//
// Retention: pruneEventLoopEvents() deletes rows older than 14 days in
// LIMITed batches with a macrotask yield between them.

import type Database from "better-sqlite3";
import type { EventLoopEvent } from "./event-loop-monitor";
import { setEventLoopEventSink } from "./event-loop-monitor";

export const EVENT_LOOP_RETENTION_DAYS = 14;
const FLUSH_MS = 5_000;
const MAX_PER_FLUSH = 100;
const MAX_BUFFER = 500;
const MAX_EXTRA_CHARS = 8_000;
const MAX_LABEL_CHARS = 300;
const PRUNE_BATCH = 500;
const DEFAULT_READ_LIMIT = 500;
const MAX_READ_LIMIT = 2_000;
export const MAX_SINCE_HOURS = EVENT_LOOP_RETENTION_DAYS * 24;

export interface PersistDeps {
  getDb: () => Database.Database;
  gitSha: string;
  bootedAt: string;
  flushMs?: number;
  maxPerFlush?: number;
  maxBuffer?: number;
}

export interface PersistedEventRow {
  id: number;
  ts: string;
  kind: "stall" | "request" | "job";
  duration_ms: number;
  label: string | null;
  git_sha: string | null;
  booted_at: string | null;
  extra: unknown;
}

let buffer: EventLoopEvent[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let pdeps: PersistDeps | null = null;
const stats = { persisted: 0, dropped: 0, flushErrors: 0 };

export function getEventLoopPersistStats() {
  return { ...stats, buffered: buffer.length, active: pdeps !== null };
}

function enqueue(e: EventLoopEvent): void {
  const max = pdeps?.maxBuffer ?? MAX_BUFFER;
  if (buffer.length >= max) {
    stats.dropped++;
    return;
  }
  buffer.push(e);
}

/** Drain the buffer into the table now. Never throws. Returns rows written. */
export function flushEventLoopEvents(): number {
  if (!pdeps || buffer.length === 0) return 0;
  const cap = pdeps.maxPerFlush ?? MAX_PER_FLUSH;
  const batch = buffer.splice(0, cap);
  // Whatever did not fit this window is beyond the rate cap: drop and count.
  if (buffer.length > 0) {
    stats.dropped += buffer.length;
    buffer = [];
  }
  try {
    const db = pdeps.getDb();
    const ins = db.prepare(
      `INSERT INTO event_loop_events (ts, kind, duration_ms, label, git_sha, booted_at, extra) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction((rows: EventLoopEvent[]) => {
      for (const r of rows) {
        let extra: string | null = null;
        if (r.extra) {
          try {
            extra = JSON.stringify(r.extra);
            if (extra.length > MAX_EXTRA_CHARS) extra = JSON.stringify({ truncated: true, head: extra.slice(0, MAX_EXTRA_CHARS) });
          } catch {
            extra = null;
          }
        }
        ins.run(
          new Date(r.ts).toISOString(),
          r.kind,
          Math.round(r.durationMs),
          String(r.label).slice(0, MAX_LABEL_CHARS),
          pdeps!.gitSha,
          pdeps!.bootedAt,
          extra
        );
      }
    });
    tx(batch);
    stats.persisted += batch.length;
    return batch.length;
  } catch {
    stats.flushErrors++;
    stats.dropped += batch.length;
    return 0;
  }
}

/** Start persisting monitor events. Idempotent; replaces deps if called again. */
export function startEventLoopPersistence(d: PersistDeps): void {
  stopEventLoopPersistence();
  pdeps = d;
  setEventLoopEventSink(enqueue);
  timer = setInterval(flushEventLoopEvents, d.flushMs ?? FLUSH_MS);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}

/** Stop, flushing what is buffered first (best effort). */
export function stopEventLoopPersistence(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (pdeps) flushEventLoopEvents();
  setEventLoopEventSink(null);
  pdeps = null;
  buffer = [];
}

export function __resetEventLoopPersistForTesting(): void {
  stopEventLoopPersistence();
  stats.persisted = 0;
  stats.dropped = 0;
  stats.flushErrors = 0;
}

/** Test hook: enqueue directly (bypasses the monitor). */
export function __enqueueForTesting(e: EventLoopEvent): void {
  enqueue(e);
}

/**
 * Persisted rows from the last `sinceHours` hours (newest first). Flushes the
 * in-memory buffer first so the very latest events are included.
 */
export function readPersistedEventLoopEvents(
  db: Database.Database,
  sinceHours: number,
  opts: { now?: number; limit?: number } = {}
): PersistedEventRow[] {
  flushEventLoopEvents();
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
  const since = new Date(now - sinceHours * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, ts, kind, duration_ms, label, git_sha, booted_at, extra
         FROM event_loop_events WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ?`
    )
    .all(since, limit) as Array<Omit<PersistedEventRow, "extra"> & { extra: string | null }>;
  return rows.map((r) => {
    let extra: unknown = null;
    if (r.extra) {
      try {
        extra = JSON.parse(r.extra);
      } catch {
        extra = r.extra;
      }
    }
    return { ...r, extra };
  });
}

/**
 * Delete rows older than `retentionDays` in LIMITed batches, yielding to the
 * event loop between batches. Returns total rows deleted.
 */
export async function pruneEventLoopEvents(
  db: Database.Database,
  opts: { now?: number; retentionDays?: number; batch?: number } = {}
): Promise<number> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - (opts.retentionDays ?? EVENT_LOOP_RETENTION_DAYS) * 86_400_000).toISOString();
  const batch = opts.batch ?? PRUNE_BATCH;
  const del = db.prepare(
    `DELETE FROM event_loop_events WHERE id IN (SELECT id FROM event_loop_events WHERE ts < ? ORDER BY id LIMIT ?)`
  );
  let total = 0;
  for (;;) {
    const n = del.run(cutoff, batch).changes;
    total += n;
    if (n < batch) break;
    await new Promise<void>((r) => setImmediate(r));
  }
  return total;
}
