// ─── Admin: DB Table-Size Diagnostic (read-only) ────────────────
//
// GET /admin/db/table-sizes
//
// Filed 2026-07-03 as Step 1 of dev-requests/2026-06-30-platform-housekeeping-audit.md:
// prod SQLite DB is 476.2MB, growing ~4.7MB/day, ~5 days from a 500MB
// threshold. The existing page-view retention job finds 0 rows to prune at
// any window, so the bloat is NOT page-views — the real consumer is
// unidentified. This endpoint answers "what is actually big" so a pruning
// decision can be made with data instead of guesses.
//
// Strictly read-only / additive: SELECT-only against sqlite_master and the
// SQLite built-in `dbstat` virtual table. No DELETE/DROP/ALTER anywhere in
// this file — diagnostic only.
//
// Auth follows the same convention as admin-runs.ts: X-Admin-Key header,
// checked against ADMIN_KEY (falling back to ANALYTICS_ADMIN_KEY).
//
// ─── Safety guard (PR-124 follow-up, 2026-07-03) ─────────────────
// An adversarial review flagged that the dbstat scan below runs fully
// synchronously on Node's single event-loop thread — the same thread
// serving ALL customer traffic (search/cart/booking/checkout) across every
// vertical on this Fly instance — with no rate limit, no caching, and no
// off-peak restriction (measured ~1.25s against the current 476MB prod DB,
// growing as the DB grows). This is deliberately NOT rewritten into an
// async-job architecture (too large a change for a quick production
// remediation); instead:
//   1. Successful results are cached in-memory for TABLE_SIZES_CACHE_TTL_MS
//      (default 5 min). A cache hit skips the scan entirely.
//   2. Concurrent cache-miss requests de-dupe onto a single in-flight
//      Promise: a request that arrives while a scan is already running (the
//      request/response plumbing here is Promise-based, so this can happen
//      even though the scan itself is still one synchronous, blocking call)
//      shares that in-flight Promise instead of starting its own scan. This
//      bounds worst-case concurrent blocking to ONE scan no matter how many
//      requests arrive during the window — the real DoS protection.

import { Router, Request, Response } from "express";
import { getDb } from "../database/init";

const router = Router();

function getAdminKey(): string {
  return process.env.ADMIN_KEY || process.env.ANALYTICS_ADMIN_KEY || "";
}

function requireAdmin(req: Request, res: Response): boolean {
  const expected = getAdminKey();
  if (!expected) {
    res.status(503).json({ error: "Admin not configured" });
    return false;
  }
  const provided = (req.headers["x-admin-key"] as string) || "";
  if (provided !== expected) {
    res.status(403).json({ error: "Krever X-Admin-Key header" });
    return false;
  }
  return true;
}

interface DbStatRow {
  name: string;
  bytes: number;
  pages: number;
}

interface TableSizeEntry {
  name: string;
  type: "table" | "index";
  bytes: number;
  mb: number;
  pages: number;
  row_count: number | null;
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

// Shape of a freshly-computed (or cached) result, before the `cached` flag
// is stitched on for the HTTP response.
interface TableSizesPayload {
  success: true;
  total_bytes: number;
  total_mb: number;
  dbstat_total_bytes: number;
  generated_at: string;
  tables: TableSizeEntry[];
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function getCacheTtlMs(): number {
  const raw = process.env.TABLE_SIZES_CACHE_TTL_MS;
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_TTL_MS;
}

// ─── Module-level cache + in-flight de-dup state ─────────────────
let _cache: { value: TableSizesPayload; expires: number } | null = null;
let _inFlight: Promise<TableSizesPayload> | null = null;

/**
 * Test-only: reset cache/in-flight state. Production code never calls this.
 */
export function __resetTableSizesCacheForTesting(): void {
  _cache = null;
  _inFlight = null;
}

// Per-table/index byte breakdown via SQLite's built-in `dbstat` virtual
// table, joined against sqlite_master to label rows as "table" vs "index"
// and to attach a live row count for real tables. Sorted descending by
// bytes so the biggest consumer is first. This is the actual synchronous,
// potentially ~1s+ scan — callers must go through getTableSizes() below,
// never call this directly, so the cache/in-flight guard always applies.
function computeTableSizesSync(): TableSizesPayload {
  const db = getDb();

  // dbstat gives us per-name (table or index btree) page/byte totals.
  const statRows = db
    .prepare(`SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name`)
    .all() as DbStatRow[];

  // sqlite_master tells us which names are real, user-created tables (as
  // opposed to indexes, or internal sqlite-owned tables/btrees like
  // sqlite_sequence / sqlite_autoindex_* / sqlite_stat1). Everything in
  // dbstat that isn't one of these "real tables" is reported as an index —
  // that includes actual CREATE INDEX rows and any internal sqlite_%
  // btrees, both of which we deliberately don't COUNT(*) on.
  const realTableNames = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r: any) => r.name as string),
  );

  // One COUNT(*) per real table. There are only a few dozen tables and
  // this endpoint is admin-only / infrequently called, so N small queries
  // is fine — no need to optimize this into a single statement.
  const rowCountByTable = new Map<string, number>();
  for (const tableName of realTableNames) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get() as { c: number };
      rowCountByTable.set(tableName, row.c);
    } catch {
      // Should not happen (name came straight from sqlite_master), but
      // don't let one bad table sink the whole diagnostic.
      rowCountByTable.set(tableName, -1);
    }
  }

  const tables: TableSizeEntry[] = statRows.map((r) => {
    const type: "table" | "index" = realTableNames.has(r.name) ? "table" : "index";
    const bytes = Number(r.bytes) || 0;
    return {
      name: r.name,
      type,
      bytes,
      mb: toMb(bytes),
      pages: Number(r.pages) || 0,
      row_count: type === "table" ? (rowCountByTable.get(r.name) ?? null) : null,
    };
  });

  tables.sort((a, b) => b.bytes - a.bytes);

  const dbstatTotalBytes = tables.reduce((sum, t) => sum + t.bytes, 0);

  // Cross-check against PRAGMA page_count * page_size, which reflects the
  // full file size including free pages / overhead that dbstat's per-name
  // grouping may not fully account for. These two numbers are NOT
  // guaranteed to be identical — dbstat sums pages attributed to named
  // btrees, while page_count*page_size is the raw file size (can include
  // freelist pages not attributed to any table/index). We report the
  // pragma-derived total as `total_bytes` (the more authoritative "actual
  // file size" figure) and keep dbstat's sum implicitly reflected in the
  // per-row breakdown.
  const pageCount = (db.pragma("page_count", { simple: true }) as number) || 0;
  const pageSize = (db.pragma("page_size", { simple: true }) as number) || 0;
  const pragmaTotalBytes = pageCount * pageSize;

  const totalBytes = pragmaTotalBytes || dbstatTotalBytes;

  return {
    success: true,
    total_bytes: totalBytes,
    total_mb: toMb(totalBytes),
    // Surfaced for transparency: if this differs meaningfully from
    // total_bytes, the gap is free/unattributed pages (e.g. after a large
    // DELETE without VACUUM) — itself a useful diagnostic signal.
    dbstat_total_bytes: dbstatTotalBytes,
    generated_at: new Date().toISOString(),
    tables,
  };
}

// Runs the fresh computation and wraps it as a Promise. Deliberately NOT
// deferred via setImmediate/setTimeout: the scan itself stays exactly as
// synchronous/blocking as before (no added latency), and `.then()`
// callbacks are always scheduled as microtasks regardless — which is
// already enough for getTableSizes() below to register `_inFlight` (and
// only later, asynchronously, write `_cache`) before a second concurrent
// caller gets a chance to check it.
function computeFresh(): Promise<TableSizesPayload> {
  return new Promise((resolve, reject) => {
    try {
      resolve(computeTableSizesSync());
    } catch (err) {
      reject(err);
    }
  });
}

// Single entry point for handlers: cache hit -> instant, no scan. Cache
// miss + nothing in flight -> starts (and caches) one fresh computation.
// Cache miss + already in flight -> awaits and shares that same computation
// instead of starting a second one.
function getTableSizes(): Promise<{ payload: TableSizesPayload; cached: boolean }> {
  const now = Date.now();
  if (_cache && now < _cache.expires) {
    return Promise.resolve({ payload: _cache.value, cached: true });
  }

  if (_inFlight) {
    return _inFlight.then((payload) => ({ payload, cached: false }));
  }

  const ttlMs = getCacheTtlMs();
  const promise = computeFresh().then((payload) => {
    _cache = { value: payload, expires: Date.now() + ttlMs };
    return payload;
  });
  _inFlight = promise;
  // Always clear in-flight state once settled (success or failure) so the
  // next request can retry. Both branches are handled here (rather than
  // .finally) so this internal bookkeeping branch never becomes an
  // unhandled rejection — the real rejection still propagates to callers
  // via the `promise.then(...)` returned below.
  promise.then(
    () => {
      _inFlight = null;
    },
    () => {
      _inFlight = null;
    },
  );

  return promise.then((payload) => ({ payload, cached: false }));
}

// ─── GET /table-sizes ─────────────────────────────────────────
router.get("/table-sizes", (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  getTableSizes()
    .then(({ payload, cached }) => {
      res.json({ ...payload, cached });
    })
    .catch((err: any) => {
      // dbstat is a compile-time-optional SQLite virtual table. If this
      // particular better-sqlite3 build somehow lacks it, fail loud with a
      // clear message instead of crashing the process.
      res.status(500).json({
        error: "Table-size diagnostic failed",
        detail: err?.message || String(err),
      });
    });
});

export default router;
