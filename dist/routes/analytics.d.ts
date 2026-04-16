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
declare const router: import("express-serve-static-core").Router;
export default router;
//# sourceMappingURL=analytics.d.ts.map