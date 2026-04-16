"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const init_1 = require("../database/init");
const analytics_service_1 = require("../services/analytics-service");
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
const router = (0, express_1.Router)();
// ─── Simple auth check ──────────────────────────────────────────
// In production, replace with proper JWT or session auth
function requireAdminAuth(req, res, next) {
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
// Apply auth to all analytics routes
router.use(requireAdminAuth);
/**
 * GET /admin/analytics/summary
 * High-level analytics for the last 24 hours
 */
router.get("/summary", (_req, res) => {
    const summary = analytics_service_1.analyticsService.getSummary(24);
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
router.get("/summary/:hours", (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.params.hours) || 24));
    const summary = analytics_service_1.analyticsService.getSummary(hours);
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
router.get("/producers", (req, res) => {
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 24));
    const producers = analytics_service_1.analyticsService.getTopProducers(limit, hours);
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
router.get("/cities", (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 24));
    const cities = analytics_service_1.analyticsService.getCityStats(hours);
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
router.get("/export/:table", (req, res) => {
    const table = req.params.table;
    if (!["page_views", "queries", "agent_views"].includes(table)) {
        res.status(400).json({ error: "Invalid table. Must be one of: page_views, queries, agent_views" });
        return;
    }
    const limit = Math.min(10000, parseInt(req.query.limit) || 1000);
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const result = analytics_service_1.analyticsService.exportData(table, limit, offset);
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
router.post("/prune", (req, res) => {
    const olderThanDays = req.body.olderThanDays || 90;
    if (olderThanDays < 7) {
        res.status(400).json({ error: "Cannot prune data newer than 7 days (privacy/audit trail)" });
        return;
    }
    const pruned = analytics_service_1.analyticsService.pruneOldData(olderThanDays);
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
router.get("/health", (_req, res) => {
    try {
        // Try to get a summary — if it succeeds, the DB is working
        const summary = analytics_service_1.analyticsService.getSummary(1);
        res.json({
            status: "healthy",
            analytics_tables: ["analytics_page_views", "analytics_queries", "analytics_agent_views"],
            records_24h: summary.pageViews + summary.totalQueries,
            timestamp: new Date().toISOString(),
        });
    }
    catch (err) {
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
router.get("/visitors", (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 24));
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    try {
        const db = (0, init_1.getDb)();
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
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
    `).all(cutoff, limit);
        res.json({ visitors });
    }
    catch (err) {
        console.error("[analytics] visitors error:", err);
        res.json({ visitors: [] });
    }
});
/**
 * GET /admin/analytics/hourly
 * Hourly traffic breakdown for chart
 */
router.get("/hourly", (req, res) => {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
    try {
        const db = (0, init_1.getDb)();
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const hourly = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', created_at) as hour,
        COUNT(*) as views,
        COUNT(DISTINCT session_id) as visitors
      FROM analytics_page_views
      WHERE created_at > ?
      GROUP BY hour
      ORDER BY hour ASC
    `).all(cutoff);
        res.json({ hourly });
    }
    catch (err) {
        console.error("[analytics] hourly error:", err);
        res.json({ hourly: [] });
    }
});
/**
 * GET /admin/analytics/pages
 * Top pages by view count
 */
router.get("/pages", (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 24));
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    try {
        const db = (0, init_1.getDb)();
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
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
    `).all(cutoff, limit);
        res.json({ pages });
    }
    catch (err) {
        console.error("[analytics] pages error:", err);
        res.json({ pages: [] });
    }
});
/**
 * GET /admin/analytics/devices
 * Device type breakdown
 */
router.get("/devices", (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours) || 24));
    try {
        const db = (0, init_1.getDb)();
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
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
    `).all(cutoff);
        // Re-map as device-like categories
        res.json({ devices });
    }
    catch (err) {
        console.error("[analytics] devices error:", err);
        res.json({ devices: [] });
    }
});
exports.default = router;
//# sourceMappingURL=analytics.js.map