import { getDb } from "../database/init";
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

/**
 * Roll up raw page_views older than windowDays into page_view_daily AND
 * sessions_daily, then DELETE the raw rows. Processes in weekly batches to
 * limit lock time.
 *
 * SAFETY: rollup INSERTs run BEFORE DELETE in the SAME transaction.
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
  dryRun: boolean = false
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  const db = getDb();

  // Find the oldest row date and cutoff date
  const oldest = (db.prepare(
    "SELECT MIN(substr(created_at, 1, 10)) as d FROM analytics_page_views"
  ).get() as { d: string | null })?.d;
  if (!oldest) return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

  if (oldest >= cutoffStr) {
    // All rows are within the retention window — nothing to do
    return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };
  }

  let totalRolledUp = 0;
  let totalDeleted = 0;
  let daysProcessed = 0;

  // Process in batchDays-wide windows from oldest to cutoff
  let batchStart = oldest;
  while (batchStart < cutoffStr) {
    const batchEndDate = new Date(batchStart);
    batchEndDate.setDate(batchEndDate.getDate() + batchDays);
    let batchEnd = batchEndDate.toISOString().slice(0, 10);
    if (batchEnd > cutoffStr) batchEnd = cutoffStr;

    if (!dryRun) {
      db.transaction(() => {
        // 1. Rollup: INSERT into page_view_daily (upsert to handle re-runs)
        db.prepare(`
          INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
          SELECT
            substr(created_at, 1, 10) as day,
            path,
            COALESCE(source, 'unknown') as source,
            ${BOT_TYPE_CASE} as bot_type,
            COALESCE(vertical_id, 'rfb') as vertical_id,
            COUNT(*) as view_count,
            COUNT(DISTINCT session_id) as session_count
          FROM analytics_page_views
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
            AND (is_owner IS NULL OR is_owner = 0)
          GROUP BY day, path, source, bot_type, vertical_id
          ON CONFLICT(day, path, source, bot_type, vertical_id) DO UPDATE SET
            view_count = view_count + excluded.view_count,
            session_count = session_count + excluded.session_count
        `).run(batchStart, batchEnd);

        // 1b. Rollup: sessions_daily — TRUE distinct sessions per day, across
        //     ALL paths. Same source rows, same is_owner exclusion, same
        //     transaction; must run before the DELETE below.
        db.prepare(`
          INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count)
          SELECT
            substr(created_at, 1, 10) as day,
            COALESCE(vertical_id, 'rfb') as vertical_id,
            ${BOT_TYPE_CASE} as bot_type,
            COUNT(DISTINCT session_id) as session_count
          FROM analytics_page_views
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
            AND (is_owner IS NULL OR is_owner = 0)
          GROUP BY day, vertical_id, bot_type
          ON CONFLICT(day, vertical_id, bot_type) DO UPDATE SET
            session_count = session_count + excluded.session_count
        `).run(batchStart, batchEnd);

        // 2. DELETE: remove ALL raw rows (including is_owner) for this batch
        const del = db.prepare(`
          DELETE FROM analytics_page_views
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
        `).run(batchStart, batchEnd);
        totalDeleted += del.changes;
      })();
    }

    // Count rows in batch for reporting (whether dry run or not)
    const counted = (db.prepare(`
      SELECT COUNT(*) as c FROM analytics_page_views
      WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ?
    `).get(batchStart, batchEnd) as { c: number }).c;
    if (dryRun) totalDeleted += counted;
    totalRolledUp += counted;
    daysProcessed += batchDays;

    // Advance to next batch
    batchStart = batchEnd;
  }

  return { rowsRolledUp: totalRolledUp, rowsDeleted: totalDeleted, daysProcessed };
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
  dryRun: boolean = false
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  const db = getDb();

  const oldest = (db.prepare(
    "SELECT MIN(substr(created_at, 1, 10)) as d FROM analytics_queries"
  ).get() as { d: string | null })?.d;
  if (!oldest) return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

  if (oldest >= cutoffStr) {
    // All rows are within the retention window — nothing to do
    return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };
  }

  let totalRolledUp = 0;
  let totalDeleted = 0;
  let daysProcessed = 0;

  let batchStart = oldest;
  while (batchStart < cutoffStr) {
    const batchEndDate = new Date(batchStart);
    batchEndDate.setDate(batchEndDate.getDate() + batchDays);
    let batchEnd = batchEndDate.toISOString().slice(0, 10);
    if (batchEnd > cutoffStr) batchEnd = cutoffStr;

    if (!dryRun) {
      db.transaction(() => {
        // 1a. Rollup: query_daily (protocol/agent/vertical/city dimensions)
        db.prepare(`
          INSERT INTO query_daily (
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
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
            AND (is_owner IS NULL OR is_owner = 0)
          GROUP BY day, protocol, agent_id, vertical_id, city
          ON CONFLICT(day, protocol, agent_id, vertical_id, city) DO UPDATE SET
            query_count = query_count + excluded.query_count,
            result_count_sum = result_count_sum + excluded.result_count_sum,
            response_time_ms_sum = response_time_ms_sum + excluded.response_time_ms_sum,
            response_time_ms_n = response_time_ms_n + excluded.response_time_ms_n
        `).run(batchStart, batchEnd);

        // 1b. Rollup: query_text_daily ("what did they actually search for")
        db.prepare(`
          INSERT INTO query_text_daily (day, query, vertical_id, query_count)
          SELECT
            substr(created_at, 1, 10) as day,
            query,
            COALESCE(vertical_id, 'rfb') as vertical_id,
            COUNT(*) as query_count
          FROM analytics_queries
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
            AND (is_owner IS NULL OR is_owner = 0)
          GROUP BY day, query, vertical_id
          ON CONFLICT(day, query, vertical_id) DO UPDATE SET
            query_count = query_count + excluded.query_count
        `).run(batchStart, batchEnd);

        // 2. DELETE: remove ALL raw rows (including is_owner) for this batch
        const del = db.prepare(`
          DELETE FROM analytics_queries
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
        `).run(batchStart, batchEnd);
        totalDeleted += del.changes;
      })();
    }

    const counted = (db.prepare(`
      SELECT COUNT(*) as c FROM analytics_queries
      WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ?
    `).get(batchStart, batchEnd) as { c: number }).c;
    if (dryRun) totalDeleted += counted;
    totalRolledUp += counted;
    daysProcessed += batchDays;

    batchStart = batchEnd;
  }

  return { rowsRolledUp: totalRolledUp, rowsDeleted: totalDeleted, daysProcessed };
}

/**
 * orch-pr-20260903-analytics-rollup-slice2.
 *
 * Roll up raw analytics_agent_views older than windowDays into agent_view_daily
 * (day×agent×view_source×city), then DELETE the raw rows. Same structure and
 * safety invariants as rollupAndPrunePageViews / rollupAndPruneQueries above.
 *
 * is_owner note: analytics_agent_views HAS an is_owner column (added by the
 * blanket ALTER-TABLE loop in database/init.ts that covered all three analytics
 * tables), but nothing in this codebase ever WRITES it — both insert sites
 * (analyticsService.trackAgentView and .recordAgentView) omit the column, so
 * every row is the DEFAULT 0 — and no reader filters on it (owner-stats-service
 * documents this explicitly). The exclusion below is therefore a no-op on real
 * data today; it is kept for consistency with the other two rollups, so that if
 * is_owner ever does start being written, this rollup already behaves like its
 * siblings instead of silently baking owner traffic into permanent history.
 * Rows are still DELETED regardless of is_owner, matching that same precedent.
 */
export function rollupAndPruneAgentViews(
  windowDays: number = 90,
  batchDays: number = 7,
  dryRun: boolean = false
): { rowsRolledUp: number; rowsDeleted: number; daysProcessed: number } {
  const db = getDb();

  const oldest = (db.prepare(
    "SELECT MIN(substr(created_at, 1, 10)) as d FROM analytics_agent_views"
  ).get() as { d: string | null })?.d;
  if (!oldest) return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - windowDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

  if (oldest >= cutoffStr) {
    // All rows are within the retention window — nothing to do
    return { rowsRolledUp: 0, rowsDeleted: 0, daysProcessed: 0 };
  }

  let totalRolledUp = 0;
  let totalDeleted = 0;
  let daysProcessed = 0;

  let batchStart = oldest;
  while (batchStart < cutoffStr) {
    const batchEndDate = new Date(batchStart);
    batchEndDate.setDate(batchEndDate.getDate() + batchDays);
    let batchEnd = batchEndDate.toISOString().slice(0, 10);
    if (batchEnd > cutoffStr) batchEnd = cutoffStr;

    if (!dryRun) {
      db.transaction(() => {
        // 1. Rollup: agent_view_daily (upsert to handle re-runs)
        db.prepare(`
          INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count)
          SELECT
            substr(created_at, 1, 10) as day,
            agent_id,
            COALESCE(view_source, 'unknown') as view_source,
            COALESCE(city, '') as city,
            COUNT(*) as view_count
          FROM analytics_agent_views
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
            AND (is_owner IS NULL OR is_owner = 0)
          GROUP BY day, agent_id, view_source, city
          ON CONFLICT(day, agent_id, view_source, city) DO UPDATE SET
            view_count = view_count + excluded.view_count
        `).run(batchStart, batchEnd);

        // 2. DELETE: remove ALL raw rows (including is_owner) for this batch
        const del = db.prepare(`
          DELETE FROM analytics_agent_views
          WHERE substr(created_at, 1, 10) >= ?
            AND substr(created_at, 1, 10) < ?
        `).run(batchStart, batchEnd);
        totalDeleted += del.changes;
      })();
    }

    const counted = (db.prepare(`
      SELECT COUNT(*) as c FROM analytics_agent_views
      WHERE substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) < ?
    `).get(batchStart, batchEnd) as { c: number }).c;
    if (dryRun) totalDeleted += counted;
    totalRolledUp += counted;
    daysProcessed += batchDays;

    batchStart = batchEnd;
  }

  return { rowsRolledUp: totalRolledUp, rowsDeleted: totalDeleted, daysProcessed };
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
