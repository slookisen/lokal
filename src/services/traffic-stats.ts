/**
 * traffic-stats.ts — Shared traffic statistics helper
 *
 * PR-121: Extracted from seo.ts and parameterized by vertical so that
 * rfb homepage shows only rfb traffic and dental homepage shows only
 * dental traffic. Both read from the main analytics DB (getDb()), filtered
 * by vertical_id when a vertical is specified.
 */

import { getDb } from "../database/init";
import type { VerticalId } from "./analytics-service";

export interface TrafficStats {
  pageViews: number;
  uniqueVisitors: number;
  realHumans: number;
  botAndAi: number;
  aiQueries: number;
}

// Bot detection patterns (same as analytics.ts traffic-classification)
const BOT_PATTERNS = ['bot', 'Bot', 'spider', 'crawl', 'serpstat', 'GPTBot', 'ClaudeBot', 'Chiark', 'Go-http-client', 'Dataprovider', 'NotHumanSearch', 'DuckDuck', 'Googlebot', 'GoogleOther', 'Bytespider', 'Applebot', 'YandexBot', 'BingPreview', 'facebookexternal', 'Twitterbot'];
const DEV_PATTERNS = ['curl/', 'Python/', 'aiohttp', 'Lokal/', 'Lokal-Enricher', 'Claude-User', 'Python-urllib', 'node-fetch', 'axios/'];

const TRAFFIC_CACHE_TTL = 120_000; // 2 minutes

// Per-vertical cache: keyed by vertical ?? 'all'
const _trafficCache = new Map<string, { data: TrafficStats; time: number }>();

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

    // Session-based classification: group by session_id, check UA for bots
    const sessions = db.prepare(`
      SELECT session_id, COUNT(*) as views
      FROM analytics_page_views
      WHERE ${notOwner}${vertSql}
      GROUP BY session_id
    `).all(...vertParams) as any[];

    let realHumans = 0;
    let botViews = 0;
    for (const s of sessions) {
      const ua = s.session_id.includes(':') ? s.session_id.split(':').slice(1).join(':') : '';
      const isBot = BOT_PATTERNS.some(p => ua.includes(p));
      const isDev = DEV_PATTERNS.some(p => ua.includes(p));
      if (isBot || isDev) {
        botViews += s.views;
      } else {
        realHumans += s.views;
      }
    }

    // AI queries from analytics_queries
    const aiQueries = (db.prepare(
      `SELECT COUNT(*) as n FROM analytics_queries WHERE ${notOwner}${vertSql}`
    ).get(...vertParams) as any)?.n ?? 0;

    const data: TrafficStats = {
      pageViews,
      uniqueVisitors: sessions.length,
      realHumans,
      botAndAi: botViews + aiQueries,
      aiQueries,
    };
    _trafficCache.set(cacheKey, { data, time: Date.now() });
    return data;
  } catch {
    return { pageViews: 0, uniqueVisitors: 0, realHumans: 0, botAndAi: 0, aiQueries: 0 };
  }
}
