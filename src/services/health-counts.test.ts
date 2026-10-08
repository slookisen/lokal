/**
 * health-counts.test.ts — dev-request 2026-09-19-prod-event-loop-stall-mcp-
 * unhealthy (A2A). Unit tests for src/services/health-counts.ts: the 60 s
 * cache that keeps GET /health from running a full COUNT(*) over
 * analytics_page_views on every probe. In-memory DB, injected clock.
 * Also covers computePageViewPruneLag (health-counts-compute.ts), the
 * prune-lag warning that replaced /health's static size/row-count thresholds.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getPageViewHealthCounts, __resetHealthCountsCacheForTesting, HEALTH_COUNTS_TTL_MS, createPageViewHealthCounter } from "./health-counts";
import { computePageViewPruneLag, PRUNE_LAG_GRACE_DAYS } from "./health-counts-compute";

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


    // ── Slice 2 (2026-10-08): off-thread first call returns null, never counts on the main thread ──
    {
      let syncCalls = 0;
      let resolveRefresh: (v: { pageViews: number; lastHourPageViews: number }) => void = () => {};
      let clock = now;
      const counter = createPageViewHealthCounter({
        offThreadUsable: () => true,
        runOffThread: () => new Promise((res) => { resolveRefresh = res as any; }),
        computeSync: () => { syncCalls++; return { pageViews: -1, lastHourPageViews: -1 }; },
        now: () => clock, offThreadTtlMs: 60_000, retryAfterMs: 60_000, log: () => {},
      });
      const fdb: any = { name: "/tmp/fake.db" };
      const first = counter.get(fdb, clock, 60_000);
      assertTrue(first.pageViews === null && first.lastHourPageViews === null && first.cachedAgeMs === null && syncCalls === 0,
        "S1: first off-thread call returns null counts and does NOT run the synchronous count");
      const again = counter.get(fdb, clock, 60_000);
      assertTrue(again.pageViews === null && syncCalls === 0, "S2: still null while the background count is in flight");
      resolveRefresh({ pageViews: 1234, lastHourPageViews: 56 });
      await counter.settled();
      clock += 5_000;
      const ready = counter.get(fdb, clock, 60_000);
      assertTrue(ready.pageViews === 1234 && ready.lastHourPageViews === 56 && ready.cachedAgeMs === 5_000 && syncCalls === 0,
        "S3: once the background count lands the numbers are served with their age");
    }

    // ── Prune-lag (2026-10-04): replaces the static "DB large >400MB" / ">500k rows"
    //    warnings that the 60-day steady state tripped permanently. ──
    const DAY = 86_400_000;
    const pdb = new Database(":memory:");
    try {
      pdb.exec(`CREATE TABLE analytics_page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')))`);
      const empty = computePageViewPruneLag(pdb, now, 60);
      assertTrue(empty.oldestPageViewAt === null && empty.lagging === false,
        "PL1: empty table → no oldest row, not lagging");

      const pins = pdb.prepare("INSERT INTO analytics_page_views (path, created_at) VALUES (?, ?)");
      pins.run("/recent", sqliteUtc(now - 3_600_000));
      pins.run("/steady", sqliteUtc(now - 61 * DAY)); // normal steady state: prune runs daily
      const steady = computePageViewPruneLag(pdb, now, 60);
      assertTrue(steady.lagging === false && steady.oldestPageViewAgeDays === 61 && steady.retentionDays === 60,
        "PL2: oldest row at retention + 1 day (normal daily-prune steady state) is NOT lagging");

      pins.run("/edge", sqliteUtc(now - 62 * DAY));
      assertTrue(computePageViewPruneLag(pdb, now, 60).lagging === false,
        "PL3: exactly retention + grace (62d) is still not lagging (strict >)");

      pins.run("/stuck", sqliteUtc(now - 63 * DAY));
      const lag = computePageViewPruneLag(pdb, now, 60);
      assertTrue(lag.lagging === true && lag.oldestPageViewAgeDays === 63 && lag.oldestPageViewAt === sqliteUtc(now - 63 * DAY),
        "PL4: oldest row past retention + grace → lagging, reports the oldest row and its age");
      assertTrue(PRUNE_LAG_GRACE_DAYS === 2, "PL5: grace is 2 days (one late/missed daily prune pass)");
      assertTrue(computePageViewPruneLag(pdb, now, 90).lagging === false,
        "PL6: threshold follows the configured retention window (RFB_AUTO_PRUNE_DAYS)");

      pdb.exec("DELETE FROM analytics_page_views");
      pins.run("/iso", new Date(now - 70 * DAY).toISOString());
      assertTrue(computePageViewPruneLag(pdb, now, 60).lagging === true,
        "PL7: ISO-formatted created_at is parsed too (UTC)");
    } finally {
      pdb.close();
    }

    // Wiring guard: /health no longer emits the static size/row-count warnings and
    // does use the prune-lag signal (index.ts can't be booted in a unit test).
    const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    assertTrue(!/warnings\.push\(`DB large/.test(indexSrc) && !/consider pruning/.test(indexSrc),
      "PL8: /health no longer pushes the static 'DB large' / 'consider pruning' warnings");
    assertTrue(/computePageViewPruneLag\(db, Date\.now\(\), getRetentionWindowDays\(\)\)/.test(indexSrc) &&
      /if \(pruneLag\.lagging\)/.test(indexSrc),
      "PL9: /health derives its analytics warning from the prune-lag signal on the auto-prune retention window");
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
