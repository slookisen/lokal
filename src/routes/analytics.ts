import { Router, Request, Response } from "express";
import { analyticsService } from "../services/analytics-service";

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
  const apiKey = req.get("X-Admin-Key") || req.query.key;
  const expectedKey = process.env.ADMIN_API_KEY || "lokal-admin-default";

  if (!apiKey || apiKey !== expectedKey) {
    res.status(401).json({ error: "Unauthorized: missing or invalid X-Admin-Key header" });
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
  const hours = Math.max(1, Math.min(720, parseInt(req.params.hours) || 24));
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

export default router;
