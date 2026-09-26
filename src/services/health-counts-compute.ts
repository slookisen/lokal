// ─── The two analytics_page_views counts GET /health reports ─────────
// Pure and stateless (takes the DB handle), so the off-thread stats worker
// can import it. health-counts.ts owns the caching and decides where it runs.
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).

import type Database from "better-sqlite3";

export interface PageViewCounts {
  pageViews: number;
  lastHourPageViews: number;
}

/** Same "YYYY-MM-DD HH:MM:SS" UTC shape /health always compared against. */
export function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function computePageViewCounts(db: Database.Database, nowMs: number): PageViewCounts {
  const pageViews = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c as number;
  const lastHourPageViews = (db
    .prepare("SELECT COUNT(*) as c FROM analytics_page_views WHERE created_at > ?")
    .get(sqliteUtc(nowMs - 3_600_000)) as any).c as number;
  return { pageViews, lastHourPageViews };
}
