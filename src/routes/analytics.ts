import { Router, Request, Response } from "express";
import path from "path";
import { getDb } from "../database/init";
import { analyticsService } from "../services/analytics-service";

// SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space-separated).
// JS .toISOString() uses "T" separator which breaks SQLite string comparison.
function sqliteDatetime(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/**
 * Analytics Admin Routes
 *
 * Endpoints for viewing aggregated analytics data.
 * These are intended for internal dashboards and monitoring.
 *
 * GET /admin/analytics/summary     — High-level stats (last 24h)
 * GET /admin/analytics/summary/:hours — Stats for last N hours
 * GET /admin/analytics/producers  — Top producers by views
 * GET /admin/analytics/cities     — City-level breakdowns
 * GET /admin/analytics/export/:table — Raw data export
 * POST /admin/analytics/prune     — Delete old data
 */

const router = Router();

// ─── Simple auth check ──────────────────────────────────────────
// In production, replace with proper JWT or session auth
function requireAdminAuth(req: Request, res: Response, next: Function): void {
  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
  if (!expectedKey) {
    res.status(503).json({ error: "Analytics not configured: ANALYTICS_ADMIN_KEY not set" });
    return;
  }

  const apiKey = req.get("X-Admin-Key");
  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

// ─── Owner cookie (set before auth middleware) ─────────────────
// Visit /admin/analytics/mark-owner?key=ADMIN_KEY to tag your browser.
// All subsequent page views and searches will be marked as owner traffic.
router.get("/mark-owner", (req: Request, res: Response) => {
  const expectedKey = process.env.ANALYTICS_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
  const key = req.query.key as string;
  if (!expectedKey || key !== expectedKey) {
    res.status(401).json({ error: "Ugyldig nøkkel" });
    return;
  }

  const remove = req.query.remove === "1";
  if (remove) {
    res.setHeader("Set-Cookie", "_rfb_owner=0; Path=/; Max-Age=0; SameSite=Lax");
    res.json({ success: true, message: "Eier-cookie fjernet. Trafikken din telles som vanlig nå." });
  } else {
    // Cookie lasts 1 year
    res.setHeader("Set-Cookie", "_rfb_owner=1; Path=/; Max-Age=31536000; SameSite=Lax");
    res.json({ success: true, message: "Eier-cookie satt. All din trafikk merkes nå som 'eier' i analytics." });
  }
});

// Apply auth to all analytics routes
router.use(requireAdminAuth);

/**
 * GET /admin/analytics/summary
 * High-level analytics for the last 24 hours
 */
router.get("/summary", (_req: Request, res: Response) => {
  const summary = analyticsService.getSummary(24);
  res.json({
    timeframe: "last 24 hours",
    timestamp: new Date().toISOString(),
    ...summary,
  });
});

/**
 * GET /admin/analytics/summary/:hours
 * High-level analytics for the last N hours
 */
router.get("/summary/:hours", (req: Request, res: Response) => {
  const hoursParam = req.params.hours as string;
  const hours = Math.max(1, Math.min(720, parseInt(hoursParam) || 24));
  const summary = analyticsService.getSummary(hours);
  res.json({
    timeframe: `last ${hours} hours`,
    timestamp: new Date().toISOString(),
    ...summary,
  });
});

/**
 * GET /admin/analytics/producers
 * Top producers by view count
 * Query params:
 *   limit=20 (default)
 *   hours=24 (default)
 */
router.get("/producers", (req: Request, res: Response) => {
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));

  const producers = analyticsService.getTopProducers(limit, hours);
  res.json({
    timeframe: `last ${hours} hours`,
    count: producers.length,
    limit,
    timestamp: new Date().toISOString(),
    producers,
  });
});

/**
 * GET /admin/analytics/cities
 * City-level analytics
 * Query params:
 *   hours=24 (default)
 */
router.get("/cities", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));

  const cities = analyticsService.getCityStats(hours);
  res.json({
    timeframe: `last ${hours} hours`,
    count: cities.length,
    timestamp: new Date().toISOString(),
    cities,
  });
});

/**
 * GET /admin/analytics/export/:table
 * Export raw analytics data
 * Params:
 *   table = "page_views" | "queries" | "agent_views"
 * Query params:
 *   limit=1000 (default)
 *   offset=0 (default)
 */
router.get("/export/:table", (req: Request, res: Response) => {
  const table = req.params.table as "page_views" | "queries" | "agent_views";

  if (!["page_views", "queries", "agent_views"].includes(table)) {
    res.status(400).json({ error: "Invalid table. Must be one of: page_views, queries, agent_views" });
    return;
  }

  const limit = Math.min(10000, parseInt(req.query.limit as string) || 1000);
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

  const result = analyticsService.exportData(table, limit, offset);
  res.json({
    table,
    timestamp: new Date().toISOString(),
    ...result,
  });
});

/**
 * POST /admin/analytics/prune
 * Delete analytics data older than specified days
 * Body:
 *   {
 *     "olderThanDays": 90
 *   }
 */
router.post("/prune", (req: Request, res: Response) => {
  const olderThanDays = req.body.olderThanDays || 90;

  if (olderThanDays < 7) {
    res.status(400).json({ error: "Cannot prune data newer than 7 days (privacy/audit trail)" });
    return;
  }

  const pruned = analyticsService.pruneOldData(olderThanDays);
  res.json({
    success: true,
    message: `Pruned ${pruned} old analytics records`,
    olderThanDays,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /admin/analytics/health
 * Simple health check for analytics system
 */
router.get("/health", (_req: Request, res: Response) => {
  try {
    // Try to get a summary — if it succeeds, the DB is working
    const summary = analyticsService.getSummary(1);
    res.json({
      status: "healthy",
      analytics_tables: ["analytics_page_views", "analytics_queries", "analytics_agent_views"],
      records_24h: summary.pageViews + summary.totalQueries,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /admin/analytics/visitors
 * Detailed visitor list with session info
 */
router.get("/visitors", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));
  const limit = Math.min(200, parseInt(req.query.limit as string) || 50);

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const visitors = db.prepare(`
      SELECT
        session_id as ipHash,
        COUNT(*) as pageViews,
        COUNT(DISTINCT path) as uniquePages,
        MIN(created_at) as firstSeen,
        MAX(created_at) as lastSeen,
        source,
        CASE
          WHEN session_id LIKE '%mobile%' OR session_id LIKE '%iphone%' THEN 'mobile'
          WHEN session_id LIKE '%tablet%' OR session_id LIKE '%ipad%' THEN 'tablet'
          ELSE 'desktop'
        END as device
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY session_id
      ORDER BY pageViews DESC
      LIMIT ?
    `).all(cutoff, limit) as any[];

    res.json({ visitors });
  } catch (err) {
    console.error("[analytics] visitors error:", err);
    res.json({ visitors: [] });
  }
});

/**
 * GET /admin/analytics/hourly
 * Hourly traffic breakdown for chart
 */
router.get("/hourly", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const hourly = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', created_at) as hour,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY hour
      ORDER BY hour ASC
    `).all(cutoff) as any[];

    res.json({ hourly });
  } catch (err) {
    console.error("[analytics] hourly error:", err);
    res.json({ hourly: [] });
  }
});

/**
 * GET /admin/analytics/pages
 * Top pages by view count
 */
router.get("/pages", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const pages = db.prepare(`
      SELECT
        path,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY path
      ORDER BY views DESC
      LIMIT ?
    `).all(cutoff, limit) as any[];

    res.json({ pages });
  } catch (err) {
    console.error("[analytics] pages error:", err);
    res.json({ pages: [] });
  }
});

/**
 * GET /admin/analytics/devices
 * Device type breakdown
 */
router.get("/devices", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    // Infer device from user_agent_hash patterns
    // Since we hash UAs we can't parse them, but the page_views middleware
    // already tracks source. We'll infer from session patterns instead.
    const devices = db.prepare(`
      SELECT
        source as device,
        COUNT(*) as count,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY source
      ORDER BY count DESC
    `).all(cutoff) as any[];

    // Re-map as device-like categories
    res.json({ devices });
  } catch (err) {
    console.error("[analytics] devices error:", err);
    res.json({ devices: [] });
  }
});

/**
 * GET /admin/analytics/traffic-classification
 * Classifies visitors into: human, bot, dev, scanner
 * This is the key endpoint for understanding real vs artificial traffic
 */
router.get("/traffic-classification", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const visitors = db.prepare(`
      SELECT
        session_id,
        COUNT(*) as views,
        COUNT(DISTINCT path) as unique_pages,
        MIN(created_at) as first_seen,
        MAX(created_at) as last_seen
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY session_id
    `).all(cutoff) as any[];

    // Classification patterns
    const botPatterns = ['bot', 'Bot', 'spider', 'crawl', 'serpstat', 'GPTBot', 'ClaudeBot', 'Chiark', 'Go-http-client', 'Dataprovider', 'NotHumanSearch', 'DuckDuck', 'Googlebot', 'GoogleOther', 'Bytespider', 'Applebot', 'YandexBot', 'BingPreview', 'facebookexternal', 'Twitterbot'];
    const devPatterns = ['curl/', 'Python/', 'aiohttp', 'Lokal/', 'Lokal-Enricher', 'Claude-User', 'Python-urllib', 'node-fetch', 'axios/'];
    const scannerPatterns = ['Chrome/78.0', 'Chrome/89.0', 'Chrome/95.0', 'Chrome/58.0', 'Chrome/102.0'];
    const scannerPaths = ['wp-admin', 'wp-login', 'xmlrpc', 'wlwmanifest', '.env', '.git', 'wp-includes'];

    // Also get scanner paths
    const scannerHits = db.prepare(`
      SELECT session_id FROM analytics_page_views
      WHERE created_at > ? AND (${scannerPaths.map(() => 'path LIKE ?').join(' OR ')})
      GROUP BY session_id
    `).all(cutoff, ...scannerPaths.map(p => `%${p}%`)) as any[];
    const scannerSessionIds = new Set(scannerHits.map((r: any) => r.session_id));

    const classification = { human: { views: 0, sessions: 0 }, bot: { views: 0, sessions: 0 }, dev: { views: 0, sessions: 0 }, scanner: { views: 0, sessions: 0 } };
    const botDetails: Record<string, { name: string; views: number }> = {};
    const humanSessions: any[] = [];

    for (const v of visitors) {
      const ua = v.session_id.includes(':') ? v.session_id.split(':').slice(1).join(':') : '';
      const isBot = botPatterns.some(p => ua.includes(p));
      const isDev = devPatterns.some(p => ua.includes(p));
      const isScanner = scannerPatterns.some(p => ua.includes(p)) || scannerSessionIds.has(v.session_id);

      let type: string;
      if (isBot) {
        type = 'bot';
        // Extract bot name
        const botMatch = ua.match(/(ClaudeBot|GPTBot|MJ12bot|serpstatbot|Googlebot|GoogleOther|DuckDuckBot|Applebot|Chiark|Dataprovider|NotHumanSearch|BingPreview|facebookexternal|Twitterbot|YandexBot|Bytespider)/i);
        const botName = botMatch ? botMatch[1] : 'other';
        if (!botDetails[botName]) botDetails[botName] = { name: botName, views: 0 };
        botDetails[botName].views += v.views;
      } else if (isDev) {
        type = 'dev';
      } else if (isScanner) {
        type = 'scanner';
      } else {
        type = 'human';
        humanSessions.push({
          ua: ua.substring(0, 80),
          views: v.views,
          uniquePages: v.unique_pages,
          firstSeen: v.first_seen,
          lastSeen: v.last_seen,
        });
      }

      (classification as any)[type].views += v.views;
      (classification as any)[type].sessions += 1;
    }

    // Sort human sessions by views
    humanSessions.sort((a, b) => b.views - a.views);

    // Bot breakdown sorted by views
    const bots = Object.values(botDetails).sort((a, b) => b.views - a.views);

    res.json({
      timeframe: `last ${hours} hours`,
      timestamp: new Date().toISOString(),
      totalViews: visitors.reduce((s, v) => s + v.views, 0),
      totalSessions: visitors.length,
      classification,
      bots,
      humanSessions: humanSessions.slice(0, 30),
    });
  } catch (err) {
    console.error("[analytics] traffic-classification error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /admin/analytics/referrers
 * Shows actual referrer URLs for non-direct traffic
 */
router.get("/referrers", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours as string) || 24));

  try {
    const db = getDb();
    const cutoff = sqliteDatetime(new Date(Date.now() - hours * 60 * 60 * 1000));

    const referrers = db.prepare(`
      SELECT
        referrer,
        source,
        COUNT(*) as visits,
        COUNT(DISTINCT session_id) as unique_visitors,
        GROUP_CONCAT(DISTINCT path) as paths
      FROM analytics_page_views
      WHERE created_at > ? AND referrer IS NOT NULL AND referrer != ''
      GROUP BY referrer
      ORDER BY visits DESC
      LIMIT 30
    `).all(cutoff) as any[];

    res.json({
      timeframe: `last ${hours} hours`,
      timestamp: new Date().toISOString(),
      referrers,
    });
  } catch (err) {
    console.error("[analytics] referrers error:", err);
    res.json({ referrers: [] });
  }
});

export default router;
