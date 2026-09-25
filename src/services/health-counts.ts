// ─── Cached analytics counts for GET /health ────────────────────────
// dev-request 2026-09-19-prod-event-loop-stall-mcp-unhealthy (A2A).
//
// /health used to run `SELECT COUNT(*) FROM analytics_page_views` (~1.19 M
// rows, 757 MB DB, 64 MB page cache) plus a last-hour count on EVERY call.
// better-sqlite3 is synchronous, so each probe blocked the one event loop
// every host shares — measured live 2026-09-21/25 at 2.2–2.6 s time-to-first-
// byte on a cold cache. /health is polled by fleet routines and external
// monitors. With the cache the counts run at most once per TTL instead of on
// every probe (the one refresh per minute still runs in the request path).
//
// Both numbers are informational (a pruning hint and a traffic gauge), so a
// value up to HEALTH_COUNTS_TTL_MS old is fine. `cachedAgeMs` says how old.

import type Database from "better-sqlite3";

export const HEALTH_COUNTS_TTL_MS = 60_000;

export interface PageViewHealthCounts {
  pageViews: number;
  lastHourPageViews: number;
  cachedAgeMs: number;
}

let cache: { at: number; pageViews: number; lastHourPageViews: number } | null = null;

/** Same "YYYY-MM-DD HH:MM:SS" UTC shape /health always compared against. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function getPageViewHealthCounts(
  db: Database.Database,
  nowMs: number = Date.now(),
  ttlMs: number = HEALTH_COUNTS_TTL_MS
): PageViewHealthCounts {
  if (cache && nowMs >= cache.at && nowMs - cache.at < ttlMs) {
    return { pageViews: cache.pageViews, lastHourPageViews: cache.lastHourPageViews, cachedAgeMs: nowMs - cache.at };
  }
  const pageViews = (db.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as any).c as number;
  const lastHourPageViews = (db
    .prepare("SELECT COUNT(*) as c FROM analytics_page_views WHERE created_at > ?")
    .get(sqliteUtc(nowMs - 3_600_000)) as any).c as number;
  cache = { at: nowMs, pageViews, lastHourPageViews };
  return { pageViews, lastHourPageViews, cachedAgeMs: 0 };
}

export function __resetHealthCountsCacheForTesting(): void {
  cache = null;
}
