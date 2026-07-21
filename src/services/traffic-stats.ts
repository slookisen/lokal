/**
 * traffic-stats.ts — Shared traffic statistics helper
 *
 * PR-121: Extracted from seo.ts and parameterized by vertical so that
 * rfb homepage shows only rfb traffic and dental homepage shows only
 * dental traffic. Both read from the main analytics DB (getDb()), filtered
 * by vertical_id when a vertical is specified.
 *
 * dev-request 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens,
 * slice A: the local BOT_PATTERNS/DEV_PATTERNS lists (one of THREE drifting
 * classifier copies) are gone — classification now goes through the shared
 * src/services/traffic-classifier.ts, and the stats expose the three honest
 * public buckets (human / ai_search / everything-else) plus the retention
 * window so the public strips can label their numbers truthfully. The old
 * field names (realHumans / botAndAi / aiQueries) are kept as aliases for the
 * public /api/traffic-stats consumers.
 */

import { getDb } from "../database/init";
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

const TRAFFIC_CACHE_TTL = 120_000; // 2 minutes

// Per-vertical cache: keyed by vertical ?? 'all'
const _trafficCache = new Map<string, { data: TrafficStats; time: number }>();

function emptyStats(): TrafficStats {
  return {
    pageViews: 0,
    uniqueVisitors: 0,
    realVisitors: 0,
    humanViews: 0,
    aiSearchViews: 0,
    aiCrawlerViews: 0,
    botViews: 0,
    windowDays: getRetentionWindowDays(),
    realHumans: 0,
    botAndAi: 0,
    aiQueries: 0,
  };
}

export function getTrafficStats(vertical?: VerticalId): TrafficStats {
  const cacheKey = vertical ?? 'all';
  const now = Date.now();
  const cached = _trafficCache.get(cacheKey);
  if (cached && (now - cached.time) < TRAFFIC_CACHE_TTL) {
    return cached.data;
  }
  try {
    const db = getDb();
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

    const data: TrafficStats = {
      pageViews,
      uniqueVisitors: sessions.length,
      realVisitors,
      humanViews,
      aiSearchViews,
      aiCrawlerViews,
      botViews,
      windowDays: getRetentionWindowDays(),
      // Back-compat aliases: realHumans was "views from sessions we didn't
      // flag as bot/dev"; humanViews is its honest successor. botAndAi was
      // "all bot/dev views + AI queries" — preserve that aggregate meaning.
      realHumans: humanViews,
      botAndAi: aiSearchViews + botViews + aiQueries,
      aiQueries,
    };
    _trafficCache.set(cacheKey, { data, time: Date.now() });
    return data;
  } catch {
    return emptyStats();
  }
}

/**
 * Test-only: clear the module-level cache so tests can observe freshly
 * seeded data immediately instead of waiting out the TTL. Mirrors the
 * __reset…ForTesting convention used elsewhere in this repo.
 */
export function __resetTrafficStatsCacheForTesting(): void {
  _trafficCache.clear();
}
