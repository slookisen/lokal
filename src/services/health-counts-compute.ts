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

// ─── Prune-lag signal for GET /health (2026-10-04) ───────────────────
// Replaces the static "DB large >400MB" / "analytics_page_views >500k rows"
// warnings, which the normal 60-day-retention steady state trips permanently
// (status was 'warning' every day = noise). What actually signals trouble is
// the daily auto-prune falling behind: the oldest page view outliving the
// retention window. The prune runs once a day (03:xx UTC), so the oldest row is
// normally <= retention + 1 day old; the grace allows one late/missed pass.
// MIN(created_at) is an index seek (idx_analytics_page_views_created), so this
// is cheap enough to run on every /health call, uncached.
export const PRUNE_LAG_GRACE_DAYS = 2;

export interface PageViewPruneLag {
  oldestPageViewAt: string | null;
  oldestPageViewAgeDays: number | null;
  retentionDays: number;
  lagging: boolean;
}

export function computePageViewPruneLag(
  db: Database.Database,
  nowMs: number,
  retentionDays: number,
): PageViewPruneLag {
  const oldest = (db.prepare("SELECT MIN(created_at) AS m FROM analytics_page_views").get() as any)?.m as
    | string
    | null
    | undefined;
  if (!oldest) return { oldestPageViewAt: null, oldestPageViewAgeDays: null, retentionDays, lagging: false };
  // Stored as SQLite "YYYY-MM-DD HH:MM:SS" (UTC); tolerate ISO rows too.
  const ms = Date.parse(oldest.includes("T") ? oldest : oldest.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return { oldestPageViewAt: oldest, oldestPageViewAgeDays: null, retentionDays, lagging: false };
  const ageDays = (nowMs - ms) / 86_400_000;
  return {
    oldestPageViewAt: oldest,
    oldestPageViewAgeDays: Math.round(ageDays * 10) / 10,
    retentionDays,
    lagging: ageDays > retentionDays + PRUNE_LAG_GRACE_DAYS,
  };
}
