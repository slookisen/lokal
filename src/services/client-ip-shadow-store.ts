// ─── Client-IP shadow windows: the AC2 counters that survive a deploy ──
// dev-request 2026-10-16-klient-ip-fra-fly-client-ip, trinn 1c.
//
// middleware/client-ip.ts counts, per process, what enforce would do, in
// 5-min windows (the client_ip_stats line). Its since-boot totals start over
// on every deploy (about ten on 2026-10-17), so the shadow gate AC2 (≥48 h,
// ≥5 000 requests) could not be read off any one process. This module keeps
// every closed window in `client_ip_shadow_windows` (database/init.ts), one
// row per machine per window, and sums the rows of one mode (the reader asks
// for shadow) for `clientIp.cumulative` and `clientIp.ac2` in
// GET /admin/analytics/ops/event-loop.
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
// A row holds counters, the window's largest fanIn ratio (limiter, fanIn and
// traffic-classifier family of that key), the mode, the machine name and,
// from trinn 1d, covered_ms: how much of the window the process measured (its
// first window only from its first request), so hours_covered no longer
// counts a restart's partial window as a full 5 min. Rows stored before 1d
// keep the column's default, a full window, as they were counted then.
// From trinn 1e, non_public_by_json: the window's non_public fallbacks per
// range code, path class and UA class (counters.non_public_by), as compact
// JSON of the non-zero counts. Rows stored before 1e have NULL there and are
// summed as `unknown` (see nonPublicByFromRows).
// No IP, no key, no hash.
//
// The timer's flush runs inside trackJob, as every other periodic DB job
// does, so the event-loop monitor can name it in a stall (trinn 1d).

import os from "os";
import type Database from "better-sqlite3";
import { getDb } from "../database/init";
import { trackJob } from "./event-loop-monitor";
// client-ip.ts imports this module too: NON_PUBLIC_RANGE_CODES is only read
// inside functions (never at load), so the require cycle is harmless.
import {
  NON_PUBLIC_RANGE_CODES,
  type ClientIpCounters,
  type ClientIpMode,
  type ClientIpNonPublicBy,
  type ClientIpWindowFanIn,
  type PathClass,
} from "../middleware/client-ip";

export const CLIENT_IP_WINDOW_RETENTION_DAYS = 14;
const FLUSH_EVERY_MS = 30_000;
const MAX_QUEUE = 12; // one hour of 5-min windows
const PRUNE_EVERY_MS = 3_600_000;
const MAX_MACHINE_CHARS = 64;
/** The timer's name in the event-loop monitor (stalls, [slow-job]). */
export const FLUSH_JOB_NAME = "client-ip-shadow-flush";

/** One closed stats window, as client-ip.ts hands it over. */
export interface ClientIpWindowRecord {
  /** Start of the window, ms since the epoch. */
  windowStart: number;
  mode: ClientIpMode;
  counters: ClientIpCounters;
  /** The window's largest fanIn ratio; null when no key had fanIn > 1 over the 20 min it is rated on. */
  fanIn: ClientIpWindowFanIn | null;
  /** How much of the window the process measured, ms (≤ 5 min): its first window only from its first request. */
  coveredMs: number;
}

/** Rows of one mode with a count > 0, and the newest such row's window_start (null when none). */
export interface ClientIpNonzeroWindows {
  windows: number;
  last: string | null;
}

/** Sums over every stored row of one mode: every deploy, every machine that wrote to this DB (one volume, so in practice one). */
export interface ClientIpStoredTotals {
  /** Stored rows (one per machine per window). */
  rows: number;
  /** Distinct window starts among them. */
  windows: number;
  /** Per distinct window start, the largest covered_ms of its rows, summed: the time measured, never a window twice. */
  coveredMs: number;
  machines: number;
  /** window_start of the oldest and newest row; null when the table is empty. */
  first: string | null;
  last: string | null;
  counters: ClientIpCounters;
  /** The row with the largest fanIn ratio; null when none had one. */
  fanInMax: (ClientIpWindowFanIn & { window_start: string }) | null;
  /** Rows with top_overflow > 0, and with fallback invalid + non_public > 0. */
  nonzero: { top_overflow: ClientIpNonzeroWindows; invalid_non_public: ClientIpNonzeroWindows };
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
  /** Ops read over the rows stored in `mode`; throws when the DB read fails (the caller reports it). */
  totals(mode: ClientIpMode): ClientIpStoredTotals;
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
  "covered_ms",
  "non_public_by_json",
];
const INSERT_SQL = `INSERT OR IGNORE INTO client_ip_shadow_windows (${INSERT_COLUMNS.join(", ")}) VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`;

// The "= 0 or explained" criteria (evaluateClientIpAc2), as [name, SQL condition on a row].
const NONZERO_CONDITIONS = [
  ["top_overflow", "top_overflow > 0"],
  ["invalid_non_public", "fallback_invalid + fallback_non_public > 0"],
] as const;

const TOTALS_SQL = `SELECT COUNT(*) AS rows_, COUNT(DISTINCT window_start) AS windows_, COUNT(DISTINCT machine) AS machines_,
  MIN(window_start) AS first_, MAX(window_start) AS last_,
  ${COUNTER_COLUMNS.map(([col]) => `COALESCE(SUM(${col}), 0) AS ${col}`).join(", ")},
  ${NONZERO_CONDITIONS.map(([name, cond]) => `COALESCE(SUM(${cond}), 0) AS nz_${name}_, MAX(CASE WHEN ${cond} THEN window_start END) AS nz_${name}_last_`).join(", ")}
  FROM client_ip_shadow_windows WHERE mode = ?`;

// Two machines in one window measured the same 5 min (at most), not 10: the
// largest of their covered_ms is a lower bound of the union.
const COVERED_SQL = `SELECT COALESCE(SUM(covered), 0) AS covered_ms FROM
  (SELECT MAX(covered_ms) AS covered FROM client_ip_shadow_windows WHERE mode = ? GROUP BY window_start)`;

// Trinn 1e: only rows with a non_public to explain (a few per day in prod).
const NON_PUBLIC_BY_SQL = `SELECT fallback_non_public AS np, non_public_by_json AS j FROM client_ip_shadow_windows
  WHERE mode = ? AND fallback_non_public > 0`;

const ROUTES: readonly PathClass[] = ["api", "a2a", "mcp", "other"];
// A uaFamily class: a traffic-classifier category, AI ones with ":<vendor>".
const UA_CLASS = /^[a-z_]{1,32}(:[a-z_]{1,32})?$/;

/** A row's breakdown as stored: only the non-zero counts, so a quiet window costs a few bytes. */
function nonPublicByJson(by: ClientIpNonPublicBy | undefined): string | null {
  if (!by) return null;
  const nonzero = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0));
  return JSON.stringify({ range: nonzero(by.range), route: nonzero(by.route), ua: nonzero(by.ua) });
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * One stored breakdown, or null when it cannot be trusted: not JSON, a key
 * outside the codes / path classes / UA classes, a count that is not a
 * whole number ≥ 0, or a split that does not sum to the row's non_public.
 */
function parseNonPublicBy(json: unknown, np: number): { range: Record<string, number>; route: Record<string, number>; ua: Record<string, number> } | null {
  if (typeof json !== "string") return null;
  let v: any;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const part = (o: unknown, ok: (k: string) => boolean): Record<string, number> | null => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const out: Record<string, number> = {};
    let sum = 0;
    for (const [k, n] of Object.entries(o)) {
      if (!ok(k) || !isCount(n)) return null;
      out[k] = n;
      sum += n;
    }
    return sum === np ? out : null;
  };
  const range = part(v.range, (k) => (NON_PUBLIC_RANGE_CODES as readonly string[]).includes(k));
  const route = part(v.route, (k) => (ROUTES as readonly string[]).includes(k));
  // "__proto__"/"constructor" match UA_CLASS but are Object.prototype's own
  // names: out["__proto__"] = n stores nothing, so the row would pass with
  // its ua count silently lost. uaFamily never makes them; reject the row.
  const ua = part(v.ua, (k) => UA_CLASS.test(k) && !Object.prototype.hasOwnProperty.call(Object.prototype, k));
  return range && route && ua ? { range, route, ua } : null;
}

/**
 * cumulative.counters.non_public_by over the rows with non_public > 0: their
 * breakdowns summed; a row without one (NULL: stored before trinn 1e) or with
 * one parseNonPublicBy rejects adds its non_public to `unknown` in range,
 * route and ua alike, and counts once in unknown_rows. So range, route and
 * ua each sum to counters.fallback.non_public, and unknown_rows says how
 * many windows' non_public stays unexplained. Rows with non_public = 0 are
 * not read: they have nothing to explain.
 */
function nonPublicByFromRows(rows: Array<{ np: number; j: unknown }>): ClientIpNonPublicBy {
  const range = Object.fromEntries(NON_PUBLIC_RANGE_CODES.map((c) => [c, 0])) as ClientIpNonPublicBy["range"];
  const route: ClientIpNonPublicBy["route"] = { api: 0, a2a: 0, mcp: 0, other: 0 };
  const ua: Record<string, number> = {};
  let unknown = 0;
  let unknownRows = 0;
  for (const r of rows) {
    const by = parseNonPublicBy(r.j, r.np);
    if (!by) {
      unknown += r.np;
      unknownRows++;
      continue;
    }
    for (const [k, n] of Object.entries(by.range)) range[k as keyof typeof range] += n;
    for (const [k, n] of Object.entries(by.route)) route[k as PathClass] += n;
    for (const [k, n] of Object.entries(by.ua)) ua[k] = (ua[k] ?? 0) + n;
  }
  range.unknown = unknown;
  route.unknown = unknown;
  ua.unknown = unknown;
  return { range, route, ua, unknown_rows: unknownRows };
}

const FANIN_MAX_SQL = `SELECT window_start, fanin_ratio, fanin_class, fanin_fan_in, fanin_ua FROM client_ip_shadow_windows
  WHERE mode = ? AND fanin_ratio IS NOT NULL ORDER BY fanin_ratio DESC, window_start DESC LIMIT 1`;

function countersFromRow(r: Record<string, number>, nonPublicBy: ClientIpNonPublicBy): ClientIpCounters {
  return {
    n: r.n,
    fci_valid: r.fci_valid,
    fallback: { missing: r.fallback_missing, invalid: r.fallback_invalid, non_public: r.fallback_non_public },
    fallback_hc: r.fallback_hc,
    non_public_by: nonPublicBy,
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
      timer = setInterval(trackJob(FLUSH_JOB_NAME, flush), flushEveryMs);
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
              createdAt,
              Math.round(r.coveredMs),
              nonPublicByJson(r.counters.non_public_by)
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

  function totals(mode: ClientIpMode): ClientIpStoredTotals {
    const db = resolveDb();
    const r = db.prepare(TOTALS_SQL).get(mode) as Record<string, any>;
    const covered = db.prepare(COVERED_SQL).get(mode) as { covered_ms: number };
    const nonPublicBy = nonPublicByFromRows(db.prepare(NON_PUBLIC_BY_SQL).all(mode) as Array<{ np: number; j: unknown }>);
    const m = db.prepare(FANIN_MAX_SQL).get(mode) as
      | { window_start: string; fanin_ratio: number; fanin_class: ClientIpWindowFanIn["class"]; fanin_fan_in: number; fanin_ua: string }
      | undefined;
    return {
      rows: r.rows_,
      windows: r.windows_,
      coveredMs: covered.covered_ms,
      machines: r.machines_,
      first: r.first_ ?? null,
      last: r.last_ ?? null,
      counters: countersFromRow(r, nonPublicBy),
      fanInMax: m
        ? { ratio: m.fanin_ratio, class: m.fanin_class, fanIn: m.fanin_fan_in, ua: m.fanin_ua, window_start: m.window_start }
        : null,
      nonzero: {
        top_overflow: { windows: r.nz_top_overflow_, last: r.nz_top_overflow_last_ ?? null },
        invalid_non_public: { windows: r.nz_invalid_non_public_, last: r.nz_invalid_non_public_last_ ?? null },
      },
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
