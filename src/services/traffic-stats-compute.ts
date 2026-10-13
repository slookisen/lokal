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
 * Why it must not run on the main thread in production: it reads every page
 * view of the window (about 60 days, hundreds of thousands of rows) and
 * classifies every visitor. The event-loop monitor (PR #922) measured the
 * previous version at 8–23 s per homepage render on the shared-cpu-1x machine,
 * freezing all three hosts each time the cache expired.
 */

import type Database from "better-sqlite3";
import type { VerticalId } from "./analytics-service";
import { computeTrafficReport } from "./traffic-report";
import { computeQueryStats } from "./admin-stats-compute";

export interface TrafficStats {
  pageViews: number;
  uniqueVisitors: number;
  /** Distinct human visitors (IP + browser) in the window — NOT views. */
  realVisitors: number;
  /** Page views from human sessions. */
  humanViews: number;
  /** Human visits (30-minute inactivity rule, traffic-report.ts). */
  humanVisits: number;
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
    humanVisits: 0,
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
 * undefined) over the last `windowDays` days. Throws on DB errors; callers
 * decide the fallback.
 *
 * dev-request 2026-10-13-statistikk-riktig-for-investorer, S1: built on the
 * dashboard's traffic report (traffic-report.ts), so the public counters and
 * the admin dashboard use one definition of a page view, a visitor and a bot.
 * Before, this counted every stored row with no date filter (the "siste 60
 * dager" label held only because the nightly prune deletes older rows), static
 * files and redirects included, and classified visitors without the scanner
 * UA and scraper rules.
 */
export function computeTrafficStats(
  db: Database.Database,
  vertical: VerticalId | undefined,
  windowDays: number = getRetentionWindowDays(),
  nowMs: number = Date.now()
): TrafficStats {
  const report = computeTrafficReport(db, windowDays * 24, vertical, nowMs, { detail: false });

  const humanViews = report.groups.human.views;
  const aiSearchViews = report.groups.ai_search.views;
  const aiCrawlerViews = report.groups.ai_crawler.views;
  // Everything that is neither a person nor human-initiated AI retrieval.
  const botViews = report.totals.views - humanViews - aiSearchViews;

  // Searches by AI assistants (their search tools over MCP/A2A, and assistants
  // fetching the search page or API for someone). Since S2 analytics_queries
  // also holds people's searches on the sites, so it is no longer all AI.
  const q = computeQueryStats(db, windowDays * 24, vertical, nowMs);
  const aiQueries = (q.byChannel?.mcp ?? 0) + (q.byChannel?.a2a ?? 0) + (q.byChannel?.ai ?? 0);

  return {
    pageViews: report.totals.views,
    uniqueVisitors: report.totals.visitors,
    realVisitors: report.groups.human.visitors,
    humanViews,
    humanVisits: report.groups.human.visits,
    aiSearchViews,
    aiCrawlerViews,
    botViews,
    windowDays,
    realHumans: humanViews,
    botAndAi: aiSearchViews + botViews + aiQueries,
    aiQueries,
  };
}
