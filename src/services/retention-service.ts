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
 * Roll up raw page_views older than windowDays into page_view_daily,
 * then DELETE the raw rows. Processes in weekly batches to limit lock time.
 *
 * SAFETY: rollup INSERT runs BEFORE DELETE in a transaction.
 *         ON CONFLICT increments so re-runs are idempotent.
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
