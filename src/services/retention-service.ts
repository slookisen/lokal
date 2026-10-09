import { getDb, LEGACY_AGENT_VIEW_SOURCE } from "../database/init";
import { isAnalyticsRollupReadEnabled, rollupBoundaryDateOn, type RollupRawTable } from "./analytics-rollup-boundary";
import fs from "fs";

export interface RetentionResult {
  rollup: {
    rowsRolledUp: number;
    rowsDeleted: number;
    daysProcessed: number;
  };
  runLedger: {
    runsSummarized: number;
    runsDeleted: number;
  };
  vacuum: {
    ran: boolean;
    sizeBefore: string;
    sizeAfter: string;
    freedMb: string;
  };
  dryRun: boolean;
}

// Bot-type classification using SQL CASE on session_id column
// session_id format: "${ipHash}:${userAgent}"
const BOT_TYPE_CASE = `
  CASE
    WHEN session_id LIKE '%GPTBot%' OR session_id LIKE '%ChatGPT%' OR session_id LIKE '%OAI-SearchBot%' THEN 'chatgpt'
    WHEN session_id LIKE '%ClaudeBot%' OR session_id LIKE '%Claude-User%' OR session_id LIKE '%Anthropic%' THEN 'claude'
    WHEN session_id LIKE '%bot%' OR session_id LIKE '%Bot%' OR session_id LIKE '%spider%' OR session_id LIKE '%Spider%' OR session_id LIKE '%crawl%' OR session_id LIKE '%Crawl%' THEN 'other_bot'
    WHEN session_id LIKE '%curl/%' OR session_id LIKE '%Python/%' OR session_id LIKE '%aiohttp%' OR session_id LIKE '%node-fetch%' OR session_id LIKE '%axios/%' THEN 'dev'
    ELSE 'human'
  END
`;

/** B4: true iff analytics_page_views has utm_source AND page_view_utm_daily exists. */
function hasUtmRollupSchema(db: ReturnType<typeof getDb>): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(analytics_page_views)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "utm_source")) return false;
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_view_utm_daily'").get();
  } catch {
    return false;
  }
}

// ─── Chunked, index-friendly rollup+prune core ───────────────────────────
// dev-request 2026-10-01-prod-auto-prune-skansom. The nightly auto-prune used
// to filter with `substr(created_at,1,10) >= ? AND substr(created_at,1,10) < ?`
// (the function wrapper defeats idx_analytics_*_created, so every statement
// read the whole table) and deleted a whole 7-day batch in ONE synchronous
// transaction — 47 s of frozen event loop in prod on 2026-10-01. Now:
//
//  1. Direct range filter `created_at >= ? AND created_at < ?`. This selects
//     EXACTLY the rows the substr() filter selected, for every stored shape
//     (full 'YYYY-MM-DD HH:MM:SS', 'YYYY-MM-DDTHH:MM:SS', bare 'YYYY-MM-DD',
//     '', non-dates): with p = substr(c,1,10) and a boundary B of <=10 chars,
//     `p >= B` <=> `c >= B` (c extends p, so they first differ inside the
//     shared prefix, or p == c when c is short) and, for a 10-char B,
//     `p < B` <=> `c < B` (p == B means c starts with B and is >= B, so both
//     sides are false). NULL fails both forms. Boundaries are the verbatim
//     oldest-prefix (<=10 chars) and 'YYYY-MM-DD' strings (exactly 10 chars).
//  2. Work is split per calendar day (`day` is part of every rollup GROUP BY,
//     so per-day rollups are identical to the per-batch ones).
//  3. A day with <= chunkSize rows is rolled up AND deleted in one transaction
//     exactly as before. A bigger day is crash-safe like this: one transaction
//     rolls the whole day up (indexed range) and records a "rolled up, delete
//     pending" marker for that [lo,hi) range in boot_job_state; the rows are
//     then deleted in chunkSize-row transactions (rowid IN (... LIMIT ?)),
//     the last of which clears the marker. A crash/throw anywhere leaves the
//     marker, and the next run (any caller) FIRST finishes deleting the
//     marked range WITHOUT rolling it up again, so nothing is double-counted
//     (rollup rows are additive: ON CONFLICT ... + excluded). Rollup cannot
//     be chunked per row batch: session_count is COUNT(DISTINCT session_id)
//     per group, which is not additive across chunks.
//  4. The generator yields after every transaction; the async wrapper awaits
//     setImmediate there so request handlers run between chunks. The sync
//     wrappers just drain the generator (manual routes, tests: old behaviour).
// Residual: a row inserted into an already-rolled-up, marked day (older than
// the retention window, so effectively never) is deleted without rollup.
const PRUNE_CHUNK_ROWS = 2000;

export interface PruneChunkOpts {
  /** Rows per delete transaction (default 2000). */
  chunkSize?: number;
  /** Called after each committed transaction; tests throw here to simulate a crash. */
  afterChunk?: (info: { table: string; phase: "rollup" | "delete"; rows: number }) => void;
}

type PruneResult = { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number };
type PruneSteps = Generator<void, PruneResult, void>;
type Db = ReturnType<typeof getDb>;

interface PruneSpec {
  table: "analytics_page_views" | "analytics_queries" | "analytics_agent_views";
  /** Rollup INSERT..SELECT statements; each takes (lo, hi) as its two params. */
  rollupSql: (db: Db) => string[];
}

const markerJob = (table: string) => `retention-rolled-delete-pending:${table}`;

function ensureMarkerTable(db: Db): void {
  // Same DDL as init.ts / services/boot-job-gate.ts.
  db.exec("CREATE TABLE IF NOT EXISTS boot_job_state (job TEXT PRIMARY KEY, last_completed_at TEXT NOT NULL)");
}

function readMarker(db: Db, table: string): string | null {
  try {
    const row = db.prepare("SELECT last_completed_at as v FROM boot_job_state WHERE job = ?")
      .get(markerJob(table)) as { v: string } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/** Delete [lo,hi) in chunkSize-row transactions; clears `marker` (if any) in the final one. */
function* deleteRangeInChunks(
  db: Db, table: string, lo: string, hi: string, chunk: number, marker: string | null, opts: PruneChunkOpts
): Generator<void, number, void> {
  const del = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE created_at >= ? AND created_at < ? LIMIT ?)`
  );
  const clear = marker
    ? db.prepare("DELETE FROM boot_job_state WHERE job = ? AND last_completed_at = ?")
    : null;
  let total = 0;
  for (;;) {
    let n = 0;
    db.transaction(() => {
      n = del.run(lo, hi, chunk).changes;
      if (n < chunk && clear) clear.run(markerJob(table), marker);
    })();
    total += n;
    opts.afterChunk?.({ table, phase: "delete", rows: n });
    if (n < chunk) return total;
    yield;
  }
}

function* pruneTableSteps(
  spec: PruneSpec, windowDays: number, batchDays: number, dryRun: boolean, opts: PruneChunkOpts
): PruneSteps {
  const db = getDb();
  const table = spec.table;
  const chunk = Math.max(1, Math.floor(opts.chunkSize ?? PRUNE_CHUNK_ROWS));
  let totalRolledUp = 0;
  let totalDeleted = 0;
  let daysProcessed = 0;

  // Finish an interrupted earlier run first (rows already rolled up, delete pending).
  if (!dryRun) {
    ensureMarkerTable(db);
    const pending = readMarker(db, table);
    if (pending) {
      const [lo, hi] = pending.split("|");
      totalDeleted += yield* deleteRangeInChunks(db, table, lo, hi, chunk, pending, opts);
      yield;
    }
  }

  // substr(MIN(col)) not MIN(substr(col)): same value (substr is monotone,
  // MIN skips NULLs) but answered from the index in O(log n) (as #950).
  const oldest = (db.prepare(
    `SELECT substr(MIN(created_at), 1, 10) as d FROM ${table}`
  ).get() as { d: string | null })?.d;
  if (!oldest) return { rowsRolledUp: 0, rowsDeleted: totalDeleted, daysProcessed: 0 };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

  if (oldest >= cutoffStr) {
    // All rows are within the retention window — nothing to do
    return { rowsRolledUp: 0, rowsDeleted: totalDeleted, daysProcessed: 0 };
  }

  const countRange = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE created_at >= ? AND created_at < ?`);
  const countCapped = db.prepare(
    `SELECT COUNT(*) as c FROM (SELECT 1 FROM ${table} WHERE created_at >= ? AND created_at < ? LIMIT ?)`
  );
  const delRange = db.prepare(`DELETE FROM ${table} WHERE created_at >= ? AND created_at < ?`);
  const setMarker = db.prepare(
    `INSERT INTO boot_job_state (job, last_completed_at) VALUES (?, ?)
     ON CONFLICT(job) DO UPDATE SET last_completed_at = excluded.last_completed_at`
  );
  const rollupStmts = dryRun ? [] : spec.rollupSql(db).map((s) => db.prepare(s));

  // Process in batchDays-wide windows from oldest to cutoff
  let batchStart = oldest;
  while (batchStart < cutoffStr) {
    const batchEndDate = new Date(batchStart);
    batchEndDate.setDate(batchEndDate.getDate() + batchDays);
    let batchEnd = batchEndDate.toISOString().slice(0, 10);
    if (batchEnd > cutoffStr) batchEnd = cutoffStr;

    if (!dryRun) {
      // Per-day sub-ranges [bounds[i], bounds[i+1]) covering [batchStart, batchEnd).
      const bounds = [batchStart];
      for (let k = 1; k <= batchDays; k++) {
        const d = new Date(batchStart);
        d.setDate(d.getDate() + k);
        const b = d.toISOString().slice(0, 10);
        if (b >= batchEnd) break;
        if (b > bounds[bounds.length - 1]) bounds.push(b);
      }
      bounds.push(batchEnd);

      for (let i = 0; i + 1 < bounds.length; i++) {
        const lo = bounds[i];
        const hi = bounds[i + 1];
        const rows = (countCapped.get(lo, hi, chunk + 1) as { c: number }).c;
        if (rows <= chunk) {
          // Small day: rollup + delete atomically (the pre-chunking invariant).
          db.transaction(() => {
            for (const st of rollupStmts) st.run(lo, hi);
            totalDeleted += delRange.run(lo, hi).changes;
          })();
          opts.afterChunk?.({ table, phase: "delete", rows });
        } else {
          // Big day: rollup + durable "delete pending" marker atomically, then chunked delete.
          const marker = `${lo}|${hi}`;
          db.transaction(() => {
            for (const st of rollupStmts) st.run(lo, hi);
            setMarker.run(markerJob(table), marker);
          })();
          opts.afterChunk?.({ table, phase: "rollup", rows });
          yield;
          totalDeleted += yield* deleteRangeInChunks(db, table, lo, hi, chunk, marker, opts);
        }
        yield;
      }
    }

    // Count rows in batch for reporting (whether dry run or not)
    const counted = (countRange.get(batchStart, batchEnd) as { c: number }).c;
    if (dryRun) totalDeleted += counted;
    totalRolledUp += counted;
    daysProcessed += batchDays;

    // Advance to next batch
    batchStart = batchEnd;
  }

  return { rowsRolledUp: totalRolledUp, rowsDeleted: totalDeleted, daysProcessed };
}

function runStepsSync(gen: PruneSteps): PruneResult {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

async function runStepsAsync(gen: PruneSteps): Promise<PruneResult> {
  let r = gen.next();
  while (!r.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    r = gen.next();
  }
  return r.value;
}

const PAGE_VIEWS_SPEC: PruneSpec = {
  table: "analytics_page_views",
  rollupSql: (db) => {
    const sql = [
      // 1. Rollup: INSERT into page_view_daily (upsert to handle re-runs)
      `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
       SELECT
         substr(created_at, 1, 10) as day,
         path,
         COALESCE(source, 'unknown') as source,
         ${BOT_TYPE_CASE} as bot_type,
         COALESCE(vertical_id, 'rfb') as vertical_id,
         COUNT(*) as view_count,
         COUNT(DISTINCT session_id) as session_count
       FROM analytics_page_views
       WHERE created_at >= ? AND created_at < ?
         AND (is_owner IS NULL OR is_owner = 0)
       GROUP BY day, path, source, bot_type, vertical_id
       ON CONFLICT(day, path, source, bot_type, vertical_id) DO UPDATE SET
         view_count = view_count + excluded.view_count,
         session_count = session_count + excluded.session_count`,
      // 1b. Rollup: sessions_daily — TRUE distinct sessions per day, across
      //     ALL paths. Same source rows, same is_owner exclusion, same
      //     transaction; must run before the DELETE.
      `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count)
       SELECT
         substr(created_at, 1, 10) as day,
         COALESCE(vertical_id, 'rfb') as vertical_id,
         ${BOT_TYPE_CASE} as bot_type,
         COUNT(DISTINCT session_id) as session_count
       FROM analytics_page_views
       WHERE created_at >= ? AND created_at < ?
         AND (is_owner IS NULL OR is_owner = 0)
       GROUP BY day, vertical_id, bot_type
       ON CONFLICT(day, vertical_id, bot_type) DO UPDATE SET
         session_count = session_count + excluded.session_count`,
    ];
    // 1c. B4: UTM-preserving rollup (additive; page_view_daily above is
    //     unchanged). Skipped when the raw table has no utm columns yet
    //     (older/mirrored schemas). Same window, same is_owner exclusion,
    //     same transaction, runs before the DELETE.
    if (hasUtmRollupSchema(db)) {
      sql.push(`INSERT INTO page_view_utm_daily
           (day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id, view_count, session_count)
         SELECT
           substr(created_at, 1, 10) as day,
           COALESCE(utm_source, '') as utm_source,
           COALESCE(utm_medium, '') as utm_medium,
           COALESCE(utm_campaign, '') as utm_campaign,
           ${BOT_TYPE_CASE} as bot_type,
           COALESCE(vertical_id, 'rfb') as vertical_id,
           COUNT(*) as view_count,
           COUNT(DISTINCT session_id) as session_count
         FROM analytics_page_views
         WHERE created_at >= ? AND created_at < ?
           AND (is_owner IS NULL OR is_owner = 0)
           AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL)
         GROUP BY day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id
         ON CONFLICT(day, utm_source, utm_medium, utm_campaign, bot_type, vertical_id) DO UPDATE SET
           view_count = view_count + excluded.view_count,
           session_count = session_count + excluded.session_count`);
    }
    return sql;
  },
};

const QUERIES_SPEC: PruneSpec = {
  table: "analytics_queries",
  rollupSql: () => [
    // 1a. Rollup: query_daily (protocol/agent/vertical/city dimensions)
    `INSERT INTO query_daily (
       day, protocol, agent_id, vertical_id, city,
       query_count, result_count_sum, response_time_ms_sum, response_time_ms_n
     )
     SELECT
       substr(created_at, 1, 10) as day,
       COALESCE(protocol, 'unknown') as protocol,
       COALESCE(agent_id, '') as agent_id,
       COALESCE(vertical_id, 'rfb') as vertical_id,
       COALESCE(city, '') as city,
       COUNT(*) as query_count,
       COALESCE(SUM(result_count), 0) as result_count_sum,
       COALESCE(SUM(response_time_ms), 0) as response_time_ms_sum,
       COUNT(response_time_ms) as response_time_ms_n
     FROM analytics_queries
     WHERE created_at >= ? AND created_at < ?
       AND (is_owner IS NULL OR is_owner = 0)
     GROUP BY day, protocol, agent_id, vertical_id, city
     ON CONFLICT(day, protocol, agent_id, vertical_id, city) DO UPDATE SET
       query_count = query_count + excluded.query_count,
       result_count_sum = result_count_sum + excluded.result_count_sum,
       response_time_ms_sum = response_time_ms_sum + excluded.response_time_ms_sum,
       response_time_ms_n = response_time_ms_n + excluded.response_time_ms_n`,
    // 1b. Rollup: query_text_daily ("what did they actually search for")
    `INSERT INTO query_text_daily (day, query, vertical_id, query_count)
     SELECT
       substr(created_at, 1, 10) as day,
       query,
       COALESCE(vertical_id, 'rfb') as vertical_id,
       COUNT(*) as query_count
     FROM analytics_queries
     WHERE created_at >= ? AND created_at < ?
       AND (is_owner IS NULL OR is_owner = 0)
     GROUP BY day, query, vertical_id
     ON CONFLICT(day, query, vertical_id) DO UPDATE SET
       query_count = query_count + excluded.query_count`,
  ],
};

const AGENT_VIEWS_SPEC: PruneSpec = {
  table: "analytics_agent_views",
  rollupSql: () => [
    // 1. Rollup: agent_view_daily (upsert to handle re-runs)
    // 2026-10-04 (view-stats honesty): only human rows enter permanent
    // history; classified non-human rows (bots, scanners, scrapers) are
    // deleted without rollup, like is_owner rows. Legacy rows written before
    // traffic_category existed (NULL) are still rolled up — nothing unknown is
    // silently dropped — but into the LEGACY_AGENT_VIEW_SOURCE bucket that
    // every agent_view_daily reader excludes (see database/init.ts).
    // GROUP BY is positional: the view_source result column is a CASE over
    // two input columns, and a bare `view_source` in GROUP BY would bind to
    // the INPUT column, merging legacy and human rows into one group.
    `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count)
     SELECT
       substr(created_at, 1, 10) as day,
       agent_id,
       CASE WHEN traffic_category IS NULL THEN '${LEGACY_AGENT_VIEW_SOURCE}'
            ELSE COALESCE(view_source, 'unknown') END as view_source,
       COALESCE(city, '') as city,
       COUNT(*) as view_count
     FROM analytics_agent_views
     WHERE created_at >= ? AND created_at < ?
       AND (is_owner IS NULL OR is_owner = 0)
       AND (traffic_category IS NULL OR traffic_category = 'human')
     GROUP BY 1, 2, 3, 4
     ON CONFLICT(day, agent_id, view_source, city) DO UPDATE SET
       view_count = view_count + excluded.view_count`,
  ],
};

/**
 * Roll up raw page_views older than windowDays into page_view_daily AND
 * sessions_daily, then DELETE the raw rows. Processes in weekly batches to
 * limit lock time.
 *
 * SAFETY: rollup INSERTs run BEFORE DELETE; atomic per small day, marker-guarded for big days (see core above).
 *         ON CONFLICT increments so re-runs are idempotent.
 *
 * orch-pr-20260903-analytics-rollup-slice2: additionally writes sessions_daily
 * from the same rows in the same per-batch transaction. sessions_daily is NOT
 * derivable afterwards from page_view_daily — page_view_daily.session_count is
 * per-PATH, so summing it overcounts a session that visited several paths on
 * the same day. It must be computed with COUNT(DISTINCT session_id) over the
 * raw rows while they still exist. Return shape and page_view_daily behaviour
 * are unchanged — this is purely additive.
 */
export function rollupAndPrunePageViews(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  return runStepsSync(pruneTableSteps(PAGE_VIEWS_SPEC, windowDays, batchDays, dryRun, opts));
}

/** Same as rollupAndPrunePageViews, but yields to the event loop (setImmediate) between transactions. */
export function rollupAndPrunePageViewsAsync(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): Promise<{ rowsRolledUp: number; rowsDeleted: number; daysProcessed: number }> {
  return runStepsAsync(pruneTableSteps(PAGE_VIEWS_SPEC, windowDays, batchDays, dryRun, opts));
}

/**
 * orch-pr-20260903-analytics-rollup-slice2.
 *
 * Roll up raw analytics_queries older than windowDays into query_daily
 * (day×protocol×agent×vertical×city) AND query_text_daily (day×query×vertical),
 * then DELETE the raw rows. Mirrors rollupAndPrunePageViews exactly:
 * batchDays-wide windows, both rollup INSERTs and the DELETE in ONE
 * transaction per batch, ON CONFLICT additive upsert so re-runs never
 * double-count, dryRun short-circuits before the transaction and only counts.
 *
 * response_time_ms_sum/_n only ever see rows with a non-NULL response_time_ms
 * (SUM/COUNT both skip NULLs in SQLite), so avg = sum/n stays honest and a NULL
 * latency is never counted as a 0ms request.
 *
 * is_owner rows are excluded from the AGGREGATE but still DELETED — the same
 * precedent rollupAndPrunePageViews set (owner/dev traffic must not pollute
 * permanent history, but it must not be retained forever either).
 */
export function rollupAndPruneQueries(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  return runStepsSync(pruneTableSteps(QUERIES_SPEC, windowDays, batchDays, dryRun, opts));
}

/** Same as rollupAndPruneQueries, but yields to the event loop (setImmediate) between transactions. */
export function rollupAndPruneQueriesAsync(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): Promise<{ rowsRolledUp: number; rowsDeleted: number; daysProcessed: number }> {
  return runStepsAsync(pruneTableSteps(QUERIES_SPEC, windowDays, batchDays, dryRun, opts));
}

/**
 * orch-pr-20260903-analytics-rollup-slice2.
 *
 * Roll up raw analytics_agent_views older than windowDays into agent_view_daily
 * (day×agent×view_source×city), then DELETE the raw rows. Same structure and
 * safety invariants as rollupAndPrunePageViews / rollupAndPruneQueries above.
 *
 * is_owner / traffic_category note: until 2026-10-04 nothing wrote either
 * column (is_owner was always the DEFAULT 0; traffic_category did not exist).
 * Since then analyticsService.trackAgentView stamps both, and this rollup
 * keeps only human, non-owner rows — plus legacy NULL-category rows, which go
 * into the LEGACY_AGENT_VIEW_SOURCE bucket readers exclude (see AGENT_VIEWS_SPEC
 * above). The unused .recordAgentView wrapper still writes neither, so its rows
 * would land in that legacy bucket too. Rows are still DELETED regardless of
 * is_owner / traffic_category, matching the precedent of the other rollups.
 */
export function rollupAndPruneAgentViews(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  return runStepsSync(pruneTableSteps(AGENT_VIEWS_SPEC, windowDays, batchDays, dryRun, opts));
}

/** Same as rollupAndPruneAgentViews, but yields to the event loop (setImmediate) between transactions. */
export function rollupAndPruneAgentViewsAsync(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false,
  opts: PruneChunkOpts = {}
): Promise<{ rowsRolledUp: number; rowsDeleted: number; daysProcessed: number }> {
  return runStepsAsync(pruneTableSteps(AGENT_VIEWS_SPEC, windowDays, batchDays, dryRun, opts));
}

/**
 * Skive 3 boundary helper (dev-request 2026-09-02-analytics-historikk-rollup-
 * lesere-foer-retention). The implementation and its full rationale live in
 * ./analytics-rollup-boundary (pure, no database/init import, so the
 * off-thread stats worker can use it on its own read-only connection); this
 * wrapper only supplies the getDb() singleton when no handle is passed.
 */
export function getRollupBoundaryDate(
  table: RollupRawTable,
  dbHandle?: ReturnType<typeof getDb>
): string {
  return rollupBoundaryDateOn(dbHandle ?? getDb(), table);
}

export { isAnalyticsRollupReadEnabled };

/**
 * dev-request 2026-09-24-mcp-rate-limit-og-personvern-sannhet, C3:
 * analytics_mcp_calls (MCP/A2A/agent-card usage logging — database/init.ts,
 * filled by services/mcp-usage-logger.ts) had NO retention/pruning at all —
 * the /personvern page now promises the same automatic retention window as
 * analytics_page_views (see seo.ts's "MCP/A2A tool-call log" row), so this
 * makes that literally true. Plain COUNT-then-DELETE, no rollup step —
 * mirrors pruneRunLedger's own delete-only shape below rather than the
 * rollup-then-delete shape rollupAndPrunePageViews/etc use above, since no
 * rollup destination exists for this table (this ledger's own aggregate
 * view, "which tools/who calls us", already lives separately in
 * consumer_usage_ledger for keyed callers — unaffected by this prune).
 */
export function pruneAnalyticsMcpCalls(
  daysToKeep: number = 60,
  dryRun: boolean = false
): { rowsDeleted: number } {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysToKeep);
  const cutoffStr = cutoff.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

  const toDelete = (db.prepare(
    "SELECT COUNT(*) as c FROM analytics_mcp_calls WHERE created_at < ?"
  ).get(cutoffStr) as { c: number }).c;

  if (toDelete === 0) return { rowsDeleted: 0 };

  if (!dryRun) {
    db.prepare("DELETE FROM analytics_mcp_calls WHERE created_at < ?").run(cutoffStr);
  }

  return { rowsDeleted: dryRun ? 0 : toDelete };
}

/**
 * Summarize run-ledger rows older than keepDays into runs_daily_summary,
 * then DELETE the raw run rows.
 * SAFETY: summary INSERT runs BEFORE DELETE in a transaction.
 */
export function pruneRunLedger(
  keepDays: number = 30,
  dryRun: boolean = false
): { runsSummarized: number; runsDeleted: number } {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = cutoff.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

  const toDelete = (db.prepare(
    "SELECT COUNT(*) as c FROM runs WHERE started_at < ?"
  ).get(cutoffStr) as { c: number }).c;

  if (toDelete === 0) return { runsSummarized: 0, runsDeleted: 0 };

  if (!dryRun) {
    db.transaction(() => {
      // 1. Summarize
      db.prepare(`
        INSERT INTO runs_daily_summary (day, vertical, agent, run_count, completed_count, failed_count, partial_count)
        SELECT
          substr(started_at, 1, 10) as day,
          vertical,
          agent,
          COUNT(*) as run_count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial_count
        FROM runs
        WHERE started_at < ?
        GROUP BY day, vertical, agent
        ON CONFLICT(day, vertical, agent) DO UPDATE SET
          run_count = excluded.run_count,
          completed_count = excluded.completed_count,
          failed_count = excluded.failed_count,
          partial_count = excluded.partial_count
      `).run(cutoffStr);

      // 2. Delete old raw runs
      db.prepare("DELETE FROM runs WHERE started_at < ?").run(cutoffStr);
    })();
  }

  return { runsSummarized: toDelete, runsDeleted: dryRun ? 0 : toDelete };
}

/**
 * Run SQLite VACUUM to reclaim disk space after deletes.
 * Checkpoints WAL first to maximise space reclaimed.
 */
export function runVacuum(dbPath: string): { sizeBefore: string; sizeAfter: string; freedMb: string } {
  const db = getDb();

  let sizeBefore = 0;
  try { sizeBefore = fs.statSync(dbPath).size; } catch { /* file not found */ }

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");

  let sizeAfter = 0;
  try { sizeAfter = fs.statSync(dbPath).size; } catch { /* file not found */ }

  return {
    sizeBefore: `${(sizeBefore / 1024 / 1024).toFixed(1)}MB`,
    sizeAfter: `${(sizeAfter / 1024 / 1024).toFixed(1)}MB`,
    freedMb: `${((sizeBefore - sizeAfter) / 1024 / 1024).toFixed(1)}`,
  };
}

/**
 * Full retention pass: rollup + prune page views, prune run ledger, optionally VACUUM.
 */
export function runRetentionPass(opts: {
  windowDays?: number;
  runLedgerKeepDays?: number;
  vacuum?: boolean;
  dbPath?: string;
  dryRun?: boolean;
}): RetentionResult {
  const {
    windowDays = 90,
    runLedgerKeepDays = 30,
    vacuum = true,
    dbPath = process.env.DB_PATH || "./data/lokal.db",
    dryRun = false,
  } = opts;

  const rollup = rollupAndPrunePageViews(windowDays, 7, dryRun);
  const runLedger = pruneRunLedger(runLedgerKeepDays, dryRun);

  let vacuumResult = { ran: false, sizeBefore: "n/a", sizeAfter: "n/a", freedMb: "0" };
  if (vacuum && !dryRun && (rollup.rowsDeleted > 0 || runLedger.runsDeleted > 0)) {
    const v = runVacuum(dbPath);
    vacuumResult = { ran: true, ...v };
  }

  return { rollup, runLedger, vacuum: vacuumResult, dryRun };
}

/**
 * dev-request 2026-09-02-analytics-historikk-rollup-lesere-foer-retention,
 * Skive 4, Part C: the five permanent rollup tables Skive 1-3 write into
 * (page_view_daily/sessions_daily/query_daily/query_text_daily/
 * agent_view_daily — schemas in database/init.ts) plus their exact column
 * lists, used both by GET /admin/analytics/export/:table's rollup branch
 * (Part A) and by a future separate monthly-archive scheduled job (out of
 * scope here — see the dev-request's Non-goals). Column order here IS the
 * CSV header order.
 *
 * agent_view_daily deliberately has no vertical_id column (see its
 * CREATE TABLE comment in database/init.ts) — the only one of the five where
 * that's true — so callers that scope by vertical (isolation-locked
 * secondary hosts) must skip that filter for this one table, same as every
 * other reader of it in this codebase (e.g. analytics-rollup-reads.ts).
 */
export const ROLLUP_TABLE_NAMES = [
  "page_view_daily",
  "sessions_daily",
  "query_daily",
  "query_text_daily",
  "agent_view_daily",
] as const;
export type RollupTableName = typeof ROLLUP_TABLE_NAMES[number];

const ROLLUP_TABLE_COLUMNS: Record<RollupTableName, readonly string[]> = {
  page_view_daily: ["day", "path", "source", "bot_type", "vertical_id", "view_count", "session_count"],
  sessions_daily: ["day", "vertical_id", "bot_type", "session_count"],
  query_daily: ["day", "protocol", "agent_id", "vertical_id", "city", "query_count", "result_count_sum", "response_time_ms_sum", "response_time_ms_n"],
  query_text_daily: ["day", "query", "vertical_id", "query_count"],
  agent_view_daily: ["day", "agent_id", "view_source", "city", "view_count"],
};

export function isRollupTableName(table: string): table is RollupTableName {
  return (ROLLUP_TABLE_NAMES as readonly string[]).includes(table);
}

export function getRollupTableColumns(table: RollupTableName): readonly string[] {
  return ROLLUP_TABLE_COLUMNS[table];
}

// RFC-4180-ish escaping: quote a field only when it contains a comma,
// quote, or newline, doubling any embedded quotes. null/undefined -> "".
// CSV/formula-injection mitigation (OWASP): a value starting with =, +, -,
// @, tab, or CR is prefixed with a leading single quote so spreadsheet apps
// (Excel/Google Sheets) treat it as inert text instead of a live formula.
// Applied before the comma/quote/newline quoting so the two compose
// correctly (e.g. "=1+1,2" ends up both prefixed AND comma-quoted).
function csvEscapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).replace(/^[=+\-@\t\r]/, "'$&");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface RollupCsvOptions {
  /** Scope to one vertical (rfb|dental|experiences). No-op for agent_view_daily (no vertical_id column). */
  vertical?: string;
  /** Row cap — omitted means "all rows" (this is permanent, already-aggregated history, not the raw firehose the existing raw export caps by default). */
  limit?: number;
  offset?: number;
  /** Test-only seam, mirrors getRollupBoundaryDate's own dbHandle param. */
  dbHandle?: ReturnType<typeof getDb>;
}

/**
 * One rollup table -> CSV text (header row + one row per record, "\n"
 * line endings). Never throws on an empty table — returns just the header
 * line followed by a trailing newline.
 */
export function rollupTableToCsv(table: RollupTableName, opts: RollupCsvOptions = {}): string {
  const db = opts.dbHandle ?? getDb();
  const columns = ROLLUP_TABLE_COLUMNS[table];
  const hasVertical = (columns as readonly string[]).includes("vertical_id");

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (hasVertical && opts.vertical) {
    where.push("vertical_id = ?");
    params.push(opts.vertical);
  }

  let sql = `SELECT ${columns.join(", ")} FROM ${table}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY day DESC`;
  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
    if (opts.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }
  }

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  const lines: string[] = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscapeField(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * All five rollup tables -> CSV text, keyed by table name. Convenience
 * wrapper around rollupTableToCsv() for a caller that wants "all five" in
 * one call (e.g. the future monthly-archive job).
 */
export function allRollupTablesToCsv(
  opts: RollupCsvOptions = {},
): Record<RollupTableName, string> {
  const out = {} as Record<RollupTableName, string>;
  for (const table of ROLLUP_TABLE_NAMES) {
    out[table] = rollupTableToCsv(table, opts);
  }
  return out;
}
