/**
 * traffic-stats-compute.ts — the pure, synchronous traffic-stats computation.
 *
 * Split out of traffic-stats.ts (dev-request
 * 2026-09-19-prod-event-loop-stall-mcp-unhealthy, A2A) so the SAME code can
 * run in two places:
 *   - inside the off-thread stats worker (offthread-stats-worker.ts), on its
 *     own read-only DB connection, which is how production serves it; and
 *   - synchronously on the caller's connection, which is the fallback (and
 *     what the in-memory test DBs use).
 *
 * It takes the DB handle as an argument and keeps no state, so it is safe to
 * import from a worker thread. Do not import database/init or anything with
 * module-level side effects from here.
 *
 * Why it must not run on the main thread in production: every call is three
 * full scans of analytics_page_views (~1.2 M rows, no index on vertical_id or
 * session_id) plus a JS classification of every session. The event-loop
 * monitor (PR #922) measured it at 8–23 s per homepage render on the
 * shared-cpu-1x machine, freezing all three hosts each time the cache expired.
 */

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { classifySession, SCANNER_PATH_PATTERNS } from "./traffic-classifier";

export interface TrafficStats {
  pageViews: number;
  uniqueVisitors: number;
  /** Unique HUMAN sessions (NOT views) — the honest "ekte besøkende". */
  realVisitors: number;
  /** Page views from human sessions. */
  humanViews: number;
  /** Page views from human-initiated AI retrieval (`*-User` agents). */
  aiSearchViews: number;
  /** Page views from autonomous AI crawlers (GPTBot, ClaudeBot, …). */
  aiCrawlerViews: number;
  /**
   * Everything non-human and non-ai_search: ai_crawler + search_engine +
   * seo_bot + social + dev + other_bot + scanner views.
   * Invariant: humanViews + aiSearchViews + botViews === pageViews.
   */
  botViews: number;
  /** Effective data window in days = the auto-prune retention (runtime value). */
  windowDays: number;
  // ── Back-compat aliases (public /api/traffic-stats consumers) ──
  /** @deprecated alias of humanViews (old name, old semantics preserved). */
  realHumans: number;
  /** @deprecated old aggregate: aiSearchViews + botViews + aiQueries. */
  botAndAi: number;
  aiQueries: number;
}

/**
 * The runtime retention window — the SAME value the daily auto-prune job uses
 * (src/index.ts: RFB_AUTO_PRUNE_DAYS env, default 60, and runAutoPrune's
 * Math.max(7, …) clamp). Read at call time, not module load, so it always
 * reflects the running configuration.
 */
export function getRetentionWindowDays(): number {
  return Math.max(7, parseInt(process.env.RFB_AUTO_PRUNE_DAYS || "60", 10) || 60);
}

export function emptyTrafficStats(windowDays: number = getRetentionWindowDays()): TrafficStats {
  return {
    pageViews: 0,
    uniqueVisitors: 0,
    realVisitors: 0,
    humanViews: 0,
    aiSearchViews: 0,
    aiCrawlerViews: 0,
    botViews: 0,
    windowDays,
    realHumans: 0,
    botAndAi: 0,
    aiQueries: 0,
  };
}

/**
 * Computes the stats for one vertical (or all traffic when `vertical` is
 * undefined). Throws on DB errors; callers decide the fallback.
 */
export function computeTrafficStats(
  db: Database.Database,
  vertical: VerticalId | undefined,
  windowDays: number = getRetentionWindowDays()
): TrafficStats {
  const notOwner = "(is_owner IS NULL OR is_owner = 0)";
  const vertSql = vertical ? " AND vertical_id = ?" : "";
  const vertParams: string[] = vertical ? [vertical] : [];

  // Total page views (excluding owner)
  const pageViews = (db.prepare(
    `SELECT COUNT(*) as n FROM analytics_page_views WHERE ${notOwner}${vertSql}`
  ).get(...vertParams) as any)?.n ?? 0;

  // Session-based classification via the shared classifier
  const sessions = db.prepare(`
    SELECT session_id, COUNT(*) as views
    FROM analytics_page_views
    WHERE ${notOwner}${vertSql}
    GROUP BY session_id
  `).all(...vertParams) as any[];

  // Sessions that hit scanner probe paths (wp-admin/.env/…) — fold into
  // 'scanner' even when the UA looks like a plausible browser. Same rule
  // as /admin/analytics/traffic-classification.
  const scannerHits = db.prepare(`
    SELECT DISTINCT session_id FROM analytics_page_views
    WHERE ${notOwner}${vertSql} AND (${SCANNER_PATH_PATTERNS.map(() => 'path LIKE ?').join(' OR ')})
  `).all(...vertParams, ...SCANNER_PATH_PATTERNS.map(p => `%${p}%`)) as any[];
  const scannerSessionIds = new Set(scannerHits.map((r: any) => r.session_id));

  let realVisitors = 0;
  let humanViews = 0;
  let aiSearchViews = 0;
  let aiCrawlerViews = 0;
  let botViews = 0;
  for (const s of sessions) {
    const category = classifySession(s.session_id, {
      scannerPaths: scannerSessionIds.has(s.session_id),
    });
    if (category === 'human') {
      realVisitors += 1;
      humanViews += s.views;
    } else if (category === 'ai_search') {
      aiSearchViews += s.views;
    } else {
      // ai_crawler + search_engine + seo_bot + social + dev + other_bot + scanner
      if (category === 'ai_crawler') aiCrawlerViews += s.views;
      botViews += s.views;
    }
  }

  // AI queries from analytics_queries
  const aiQueries = (db.prepare(
    `SELECT COUNT(*) as n FROM analytics_queries WHERE ${notOwner}${vertSql}`
  ).get(...vertParams) as any)?.n ?? 0;

  return {
    pageViews,
    uniqueVisitors: sessions.length,
    realVisitors,
    humanViews,
    aiSearchViews,
    aiCrawlerViews,
    botViews,
    windowDays,
    // Back-compat aliases: realHumans was "views from sessions we didn't
    // flag as bot/dev"; humanViews is its honest successor. botAndAi was
    // "all bot/dev views + AI queries" — preserve that aggregate meaning.
    realHumans: humanViews,
    botAndAi: aiSearchViews + botViews + aiQueries,
    aiQueries,
  };
}
