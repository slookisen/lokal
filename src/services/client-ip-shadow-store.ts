// ─── Client-IP shadow windows: the AC2 counters that survive a deploy ──
// dev-request 2026-10-16-klient-ip-fra-fly-client-ip, trinn 1c.
//
// middleware/client-ip.ts counts, per process, what enforce would do, in
// 5-min windows (the client_ip_stats line). Its since-boot totals start over
// on every deploy (about ten on 2026-10-17), so the shadow gate AC2 (≥48 h,
// ≥5 000 requests) could not be read off any one process. This module keeps
// every closed window in `client_ip_shadow_windows` (database/init.ts), one
// row per machine per window, and sums the rows for `clientIp.cumulative` and
// `clientIp.ac2` in GET /admin/analytics/ops/event-loop.
//
// Request path: enqueue() only pushes the closed window's plain numbers onto
// a bounded array (O(1), never throws, never touches the DB). A short unref'd
// timer, started by the first enqueue, writes the queue in one transaction,
// one small INSERT per window, never retried; the same job deletes rows older
// than 14 days, at most once an hour. Window starts must strictly increase,
// so a process writes at most one row per 5-min window — at most 12 an hour
// per machine — whatever the clock does; UNIQUE (machine, window_start) is
// the DB-side guard.
//
// A row holds counters, the window's largest fanIn ratio (path class, fanIn
// and traffic-classifier family of that key), the mode and the machine name.
// No IP, no key, no hash.

import os from "os";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import type { ClientIpCounters, ClientIpMode, ClientIpWindowFanIn } from "../middleware/client-ip";

export const CLIENT_IP_WINDOW_RETENTION_DAYS = 14;
const FLUSH_EVERY_MS = 30_000;
const MAX_QUEUE = 12; // one hour of 5-min windows
const PRUNE_EVERY_MS = 3_600_000;
const MAX_MACHINE_CHARS = 64;

/** One closed stats window, as client-ip.ts hands it over. */
export interface ClientIpWindowRecord {
  /** Start of the window, ms since the epoch. */
  windowStart: number;
  mode: ClientIpMode;
  counters: ClientIpCounters;
  /** The window's largest fanIn ratio; null when no 15-min top key had fanIn > 1. */
  fanIn: ClientIpWindowFanIn | null;
}

/** Sums over every stored row: every deploy, every machine that wrote to this DB (one volume, so in practice one). */
export interface ClientIpStoredTotals {
  /** Stored rows (one per machine per window). */
  rows: number;
  /** Distinct window starts among them. */
  windows: number;
  machines: number;
  /** window_start of the oldest and newest row; null when the table is empty. */
  first: string | null;
  last: string | null;
  counters: ClientIpCounters;
  /** The row with the largest fanIn ratio; null when none had one. */
  fanInMax: (ClientIpWindowFanIn & { window_start: string }) | null;
}

/** This process's writer, so "no rows yet" and "writes failing" can be told apart. */
export interface ClientIpShadowWriterStats {
  persisted: number;
  queued: number;
  /** Queue full, or the batch of a failed write (never retried). */
  dropped: number;
  /** A window start not after the previous one (clock went back): not queued. */
  out_of_order: number;
  errors: number;
  pruned: number;
}

export interface ClientIpShadowStore {
  /** Request path: O(1), never throws, never touches the DB. */
  enqueue(rec: ClientIpWindowRecord): void;
  /** Timer (or a test): writes the queue, prunes when due. Never throws. Returns rows written. */
  flush(): number;
  /** Ops read; throws when the DB read fails (the caller reports it). */
  totals(): ClientIpStoredTotals;
  writerStats(): ClientIpShadowWriterStats;
  /** Stops the timer (tests). Queued windows stay queued. */
  stop(): void;
}

export interface ClientIpShadowStoreDeps {
  /** Default: the main DB (database/init.ts), resolved at flush/read time. */
  getDb?: () => Database.Database;
  /** Default: the host name, which on Fly is the machine id. */
  machine?: string;
  now?: () => number;
  /** Timer period; null = no timer (tests call flush()). Default 30 s. */
  flushEveryMs?: number | null;
}

// Every additive counter as [column, value]; the INSERT and the SUMs are both
// built from this list, and countersFromRow reads the SUMs back.
const COUNTER_COLUMNS: ReadonlyArray<readonly [string, (c: ClientIpCounters) => number]> = [
  ["n", (c) => c.n],
  ["fci_valid", (c) => c.fci_valid],
  ["fallback_missing", (c) => c.fallback.missing],
  ["fallback_invalid", (c) => c.fallback.invalid],
  ["fallback_non_public", (c) => c.fallback.non_public],
  ["fallback_hc", (c) => c.fallback_hc],
  ["errors", (c) => c.errors],
  ["xff_client_supplied", (c) => c.xff_client_supplied],
  ["agree_fci_edge_n", (c) => c.agree_fci_edge.n],
  ["agree_fci_edge_agree", (c) => c.agree_fci_edge.agree],
  ["agree_legacy_eq_fci_n", (c) => c.agree_legacy_eq_fci.n],
  ["agree_legacy_eq_fci_agree", (c) => c.agree_legacy_eq_fci.agree],
  ["would_trip", (c) => c.would_trip],
  ["top_overflow", (c) => c.top_overflow],
];

const INSERT_COLUMNS = [
  "window_start",
  "machine",
  "mode",
  ...COUNTER_COLUMNS.map(([col]) => col),
  "fanin_ratio",
  "fanin_class",
  "fanin_fan_in",
  "fanin_ua",
  "created_at",
];
const INSERT_SQL = `INSERT OR IGNORE INTO client_ip_shadow_windows (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`;

const TOTALS_SQL = `SELECT COUNT(*) AS rows_, COUNT(DISTINCT window_start) AS windows_, COUNT(DISTINCT machine) AS machines_,
  MIN(window_start) AS first_, MAX(window_start) AS last_,
  ${COUNTER_COLUMNS.map(([col]) => `COALESCE(SUM(${col}), 0) AS ${col}`).join(", ")}
  FROM client_ip_shadow_windows`;

const FANIN_MAX_SQL = `SELECT window_start, fanin_ratio, fanin_class, fanin_fan_in, fanin_ua FROM client_ip_shadow_windows
  WHERE fanin_ratio IS NOT NULL ORDER BY fanin_ratio DESC, window_start DESC LIMIT 1`;

function countersFromRow(r: Record<string, number>): ClientIpCounters {
  return {
    n: r.n,
    fci_valid: r.fci_valid,
    fallback: { missing: r.fallback_missing, invalid: r.fallback_invalid, non_public: r.fallback_non_public },
    fallback_hc: r.fallback_hc,
    errors: r.errors,
    xff_client_supplied: r.xff_client_supplied,
    agree_fci_edge: { n: r.agree_fci_edge_n, agree: r.agree_fci_edge_agree },
    agree_legacy_eq_fci: { n: r.agree_legacy_eq_fci_n, agree: r.agree_legacy_eq_fci_agree },
    would_trip: r.would_trip,
    top_overflow: r.top_overflow,
  };
}

export function createClientIpShadowStore(deps: ClientIpShadowStoreDeps = {}): ClientIpShadowStore {
  const resolveDb = deps.getDb ?? (() => getDb());
  const machine = (deps.machine ?? os.hostname()).slice(0, MAX_MACHINE_CHARS) || "unknown";
  const now = deps.now ?? Date.now;
  const flushEveryMs = deps.flushEveryMs === undefined ? FLUSH_EVERY_MS : deps.flushEveryMs;
  const stats = { persisted: 0, dropped: 0, out_of_order: 0, errors: 0, pruned: 0 };
  let queue: ClientIpWindowRecord[] = [];
  let lastStart = -Infinity;
  let lastPruneAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | null = null;

  function enqueue(rec: ClientIpWindowRecord): void {
    if (!(rec.windowStart > lastStart)) {
      stats.out_of_order++;
      return;
    }
    lastStart = rec.windowStart;
    if (queue.length >= MAX_QUEUE) {
      stats.dropped++;
      return;
    }
    queue.push(rec);
    if (!timer && flushEveryMs !== null) {
      timer = setInterval(flush, flushEveryMs);
      if (typeof (timer as any).unref === "function") (timer as any).unref();
    }
  }

  function flush(): number {
    try {
      return writeQueued();
    } catch {
      // Belt and braces: flush runs on a timer, where a throw would be an uncaught exception.
      stats.errors++;
      return 0;
    }
  }

  function writeQueued(): number {
    const t = now();
    const pruneDue = t - lastPruneAt >= PRUNE_EVERY_MS;
    if (queue.length === 0 && !pruneDue) return 0;
    // Once an hour whatever happens below: a failing prune is not retried every tick.
    if (pruneDue) lastPruneAt = t;
    const batch = queue;
    queue = [];
    let db: Database.Database;
    try {
      db = resolveDb();
    } catch {
      stats.errors++;
      stats.dropped += batch.length;
      return 0;
    }
    let written = 0;
    if (batch.length > 0) {
      try {
        const ins = db.prepare(INSERT_SQL);
        const createdAt = new Date(t).toISOString();
        db.transaction(() => {
          for (const r of batch) {
            const f = r.fanIn;
            written += ins.run(
              new Date(r.windowStart).toISOString(),
              machine,
              r.mode,
              ...COUNTER_COLUMNS.map(([, value]) => value(r.counters)),
              f ? f.ratio : null,
              f ? f.class : null,
              f ? f.fanIn : null,
              f ? f.ua : null,
              createdAt
            ).changes;
          }
        })();
        stats.persisted += written;
      } catch {
        stats.errors++;
        stats.dropped += batch.length;
        written = 0;
      }
    }
    if (pruneDue) {
      try {
        const cutoff = new Date(t - CLIENT_IP_WINDOW_RETENTION_DAYS * 86_400_000).toISOString();
        stats.pruned += db.prepare(`DELETE FROM client_ip_shadow_windows WHERE window_start < ?`).run(cutoff).changes;
      } catch {
        stats.errors++;
      }
    }
    return written;
  }

  function totals(): ClientIpStoredTotals {
    const db = resolveDb();
    const r = db.prepare(TOTALS_SQL).get() as Record<string, any>;
    const m = db.prepare(FANIN_MAX_SQL).get() as
      | { window_start: string; fanin_ratio: number; fanin_class: ClientIpWindowFanIn["class"]; fanin_fan_in: number; fanin_ua: string }
      | undefined;
    return {
      rows: r.rows_,
      windows: r.windows_,
      machines: r.machines_,
      first: r.first_ ?? null,
      last: r.last_ ?? null,
      counters: countersFromRow(r),
      fanInMax: m
        ? { ratio: m.fanin_ratio, class: m.fanin_class, fanIn: m.fanin_fan_in, ua: m.fanin_ua, window_start: m.window_start }
        : null,
    };
  }

  return {
    enqueue,
    flush,
    totals,
    writerStats: () => ({ ...stats, queued: queue.length }),
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
