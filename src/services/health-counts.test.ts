/**
 * health-counts.test.ts — dev-request 2026-09-19-prod-event-loop-stall-mcp-
 * unhealthy (A2A). Unit tests for src/services/health-counts.ts: the 60 s
 * cache that keeps GET /health from running a full COUNT(*) over
 * analytics_page_views on every probe. In-memory DB, injected clock.
 */

import Database from "better-sqlite3";
import { getPageViewHealthCounts, __resetHealthCountsCacheForTesting, HEALTH_COUNTS_TTL_MS } from "./health-counts";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export async function runHealthCountsTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }

  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE analytics_page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
             created_at TEXT DEFAULT (datetime('now')))`);
    const now = Date.parse("2026-09-25T12:00:00Z");
    const ins = db.prepare("INSERT INTO analytics_page_views (path, created_at) VALUES (?, ?)");
    ins.run("/old", sqliteUtc(now - 2 * 3_600_000));   // 2 h ago
    ins.run("/edge", sqliteUtc(now - 3_600_000));       // exactly 1 h ago → NOT "last hour" (strict >)
    ins.run("/recent", sqliteUtc(now - 59 * 60_000));   // 59 min ago
    ins.run("/now", sqliteUtc(now - 1000));             // 1 s ago

    __resetHealthCountsCacheForTesting();
    const a = getPageViewHealthCounts(db, now);
    assertTrue(a.pageViews === 4 && a.lastHourPageViews === 2 && a.cachedAgeMs === 0,
      "H1: first call counts all rows and the last hour (strictly newer than now − 1 h), age 0");

    ins.run("/later", sqliteUtc(now + 1000));
    const b = getPageViewHealthCounts(db, now + 30_000);
    assertTrue(b.pageViews === 4 && b.lastHourPageViews === 2 && b.cachedAgeMs === 30_000,
      "H2: within the TTL the cached values are returned (no new query) with their age");

    const c = getPageViewHealthCounts(db, now + HEALTH_COUNTS_TTL_MS);
    assertTrue(c.pageViews === 5 && c.cachedAgeMs === 0, "H3: at the TTL boundary the counts are refreshed");

    const d = getPageViewHealthCounts(db, now - 10_000);
    assertTrue(d.cachedAgeMs === 0, "H4: a clock that moved backwards forces a refresh instead of serving a 'future' cache");

    __resetHealthCountsCacheForTesting();
    const e = getPageViewHealthCounts(db, now + 5_000, 0);
    const f = getPageViewHealthCounts(db, now + 5_000, 0);
    assertTrue(e.cachedAgeMs === 0 && f.cachedAgeMs === 0, "H5: ttl 0 disables caching");
  } catch (err: any) {
    failed++;
    failures.push("health-counts: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    __resetHealthCountsCacheForTesting();
    db.close();
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runHealthCountsTests({ log: true }).then((r) => {
    console.log(`\nhealth-counts: ${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
