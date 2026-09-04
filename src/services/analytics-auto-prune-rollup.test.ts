/**
 * analytics-auto-prune-rollup.test.ts — tests for
 * orch-pr-20260903-analytics-rollup-slice1.
 *
 * Nightly auto-prune (AnalyticsService.runAutoPrune(), called from
 * src/index.ts's autoPruneTick at 03:00 UTC) used to run a raw,
 * unconditional `DELETE FROM ... WHERE created_at < ?` against
 * analytics_page_views, analytics_queries and analytics_agent_views, with
 * no rollup step first — silently destroying analytics history for months
 * (oldest page view in prod dropped to 2026-07-04). This slice:
 *
 *   (1) wires analytics_page_views through the already-tested
 *       rollupAndPrunePageViews() (rollup-before-delete into
 *       page_view_daily) instead of a raw DELETE.
 *   (2) stopped deleting analytics_queries / analytics_agent_views entirely
 *       (neither had a rollup table yet) — read-only COUNT(*) sizing only,
 *       reported via wouldDeleteIfPruned.
 *   (3) reported skippedPendingRollup: ["analytics_queries",
 *       "analytics_agent_views"] on every call.
 *
 * UPDATED for orch-pr-20260903-analytics-rollup-slice2: those rollup tables
 * now exist (query_daily / query_text_daily / agent_view_daily), so
 * runAutoPrune rolls up and deletes all three tables again. The assertions
 * below that encoded slice 1's deliberate "never delete these two" stop-gap
 * have been flipped to their slice-2 meaning — this is an intended behaviour
 * change, not a regression. Deeper coverage of the new rollups lives in
 * src/services/analytics-rollup-slice2.test.ts.
 *
 * Covers AnalyticsService.runAutoPrune() (src/services/analytics-service.ts):
 *   (a) old analytics_page_views rows are gone from the raw table AND
 *       matching rows now exist in page_view_daily (proves rollup actually
 *       ran, not just deletion) — newer rows are left in place.
 *   (b) old analytics_queries / analytics_agent_views rows are deleted, and
 *       their aggregates landed in query_daily / query_text_daily /
 *       agent_view_daily first (rollup-before-delete, no history lost).
 *   (c) skippedPendingRollup is now [] — every source table has coverage.
 *   (d) wouldDeleteIfPruned.queries / .agentViews still match the seeded
 *       old-row counts (measured BEFORE the deletes).
 *   (e) a second runAutoPrune call is idempotent for every rollup table —
 *       row/aggregate counts do not double.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/analytics-auto-prune-rollup.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAutoPruneRollupTests() and folds its pass/fail counts into the
 *      `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export async function runAutoPruneRollupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
      passed++;
      if (log) console.log(`  ok ${label}`);
    } else {
      failed++;
      const msg = `✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`;
      failures.push(msg);
      if (log) console.log("  " + msg);
    }
  }
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

  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");

  const prevDb = (() => {
    try { return getDb(); } catch { return undefined; }
  })();

  const testDb = new Database(":memory:");

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    // Bust the require cache so analytics-service picks up the injected DB
    // via getDb() rather than any cached module-level handle.
    const servicePath = require.resolve("../services/analytics-service");
    delete require.cache[servicePath];
    const { analyticsService } = require("../services/analytics-service") as
      typeof import("../services/analytics-service");

    const DAYS_TO_KEEP = 90;

    function isoDaysAgo(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }

    function seed(): { oldPv: number; newPv: number; oldQueries: number; oldAgentViews: number } {
      testDb.exec(
        "DELETE FROM analytics_page_views; DELETE FROM analytics_queries; " +
        "DELETE FROM analytics_agent_views; DELETE FROM page_view_daily; " +
        "DELETE FROM query_daily; DELETE FROM query_text_daily; " +
        "DELETE FROM agent_view_daily; DELETE FROM sessions_daily;"
      );

      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30); // well past the cutoff
      const newCreated = isoDaysAgo(1); // within the retention window

      const insertPv = testDb.prepare(
        `INSERT INTO analytics_page_views (path, referrer, source, user_agent_hash, session_id, status_code, created_at)
         VALUES (?, NULL, 'direct', 'h1', 'sess1:UA', 200, ?)`,
      );
      let oldPv = 0;
      for (let i = 0; i < 5; i++) { insertPv.run("/old-" + i, oldCreated); oldPv++; }
      let newPv = 0;
      for (let i = 0; i < 3; i++) { insertPv.run("/new-" + i, newCreated); newPv++; }

      const insertQuery = testDb.prepare(
        `INSERT INTO analytics_queries (protocol, query, agent_id, created_at)
         VALUES ('a2a', 'egg', 'test-agent', ?)`,
      );
      let oldQueries = 0;
      for (let i = 0; i < 4; i++) { insertQuery.run(oldCreated); oldQueries++; }

      const insertAgentView = testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, created_at)
         VALUES ('agent-1', 'Test Gård', 'Oslo', 'search', ?)`,
      );
      let oldAgentViews = 0;
      for (let i = 0; i < 6; i++) { insertAgentView.run(oldCreated); oldAgentViews++; }

      return { oldPv, newPv, oldQueries, oldAgentViews };
    }

    function pvCount(): number {
      return (testDb.prepare("SELECT COUNT(*) as c FROM analytics_page_views").get() as { c: number }).c;
    }
    function queriesCount(): number {
      return (testDb.prepare("SELECT COUNT(*) as c FROM analytics_queries").get() as { c: number }).c;
    }
    function agentViewsCount(): number {
      return (testDb.prepare("SELECT COUNT(*) as c FROM analytics_agent_views").get() as { c: number }).c;
    }
    function sumOf(table: string, col: string): number {
      return (testDb.prepare(`SELECT COALESCE(SUM(${col}), 0) as s FROM ${table}`).get() as { s: number }).s;
    }
    function pageViewDailyRows(): { rows: number; totalViewCount: number } {
      const rows = (testDb.prepare("SELECT COUNT(*) as c FROM page_view_daily").get() as { c: number }).c;
      const totalViewCount = (testDb.prepare("SELECT COALESCE(SUM(view_count), 0) as s FROM page_view_daily").get() as { s: number }).s;
      return { rows, totalViewCount };
    }

    // ── (a) analytics_page_views: old rows rolled up + gone, new rows kept ──
    {
      const seeded = seed();
      const before = { pv: pvCount(), queries: queriesCount(), agentViews: agentViewsCount() };
      assertEq(before.pv, seeded.oldPv + seeded.newPv, "setup: seeded page-view rows present");

      const result = analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });

      assertEq(pvCount(), seeded.newPv, "rollup: only the newer analytics_page_views rows remain in the raw table");
      const daily = pageViewDailyRows();
      assertTrue(daily.rows > 0, "rollup: page_view_daily now has rolled-up rows");
      assertEq(daily.totalViewCount, seeded.oldPv, "rollup: page_view_daily view_count sums to the old page-view rows that were rolled up");
      assertEq(result.deleted.pageViews, seeded.oldPv, "runAutoPrune: deleted.pageViews reports rollupAndPrunePageViews' rowsDeleted");

      // ── (b) slice 2: analytics_queries / analytics_agent_views rolled up, THEN deleted ──
      assertEq(queriesCount(), 0, "slice2: old analytics_queries rows deleted after rollup");
      assertEq(agentViewsCount(), 0, "slice2: old analytics_agent_views rows deleted after rollup");
      assertEq(result.deleted.queries, before.queries, "runAutoPrune: deleted.queries reports rollupAndPruneQueries' rowsDeleted");
      assertEq(result.deleted.agentViews, before.agentViews, "runAutoPrune: deleted.agentViews reports rollupAndPruneAgentViews' rowsDeleted");
      assertEq(sumOf("query_daily", "query_count"), seeded.oldQueries, "slice2: query_daily query_count sums to the rolled-up analytics_queries rows");
      assertEq(sumOf("query_text_daily", "query_count"), seeded.oldQueries, "slice2: query_text_daily query_count sums to the rolled-up analytics_queries rows");
      assertEq(sumOf("agent_view_daily", "view_count"), seeded.oldAgentViews, "slice2: agent_view_daily view_count sums to the rolled-up analytics_agent_views rows");
      assertTrue(sumOf("sessions_daily", "session_count") > 0, "slice2: sessions_daily written from the same page-view scan");

      // ── (c) skippedPendingRollup — every source table now has coverage ──
      assertEq(result.skippedPendingRollup, [], "skippedPendingRollup: empty — all three analytics tables have rollup coverage");

      // ── (d) wouldDeleteIfPruned matches seeded old-row counts ──
      assertEq(result.wouldDeleteIfPruned.queries, seeded.oldQueries, "wouldDeleteIfPruned.queries matches seeded old analytics_queries rows");
      assertEq(result.wouldDeleteIfPruned.agentViews, seeded.oldAgentViews, "wouldDeleteIfPruned.agentViews matches seeded old analytics_agent_views rows");

      // ── (e) idempotent second call: no double-counting in ANY rollup table ──
      const dailyAfterFirst = pageViewDailyRows();
      const rollupSumsAfterFirst = {
        query: sumOf("query_daily", "query_count"),
        queryText: sumOf("query_text_daily", "query_count"),
        agentView: sumOf("agent_view_daily", "view_count"),
        sessions: sumOf("sessions_daily", "session_count"),
      };
      const result2 = analyticsService.runAutoPrune({ daysToKeep: DAYS_TO_KEEP });
      const dailyAfterSecond = pageViewDailyRows();

      assertEq(dailyAfterSecond.rows, dailyAfterFirst.rows, "idempotent: page_view_daily row count unchanged on second runAutoPrune call");
      assertEq(dailyAfterSecond.totalViewCount, dailyAfterFirst.totalViewCount, "idempotent: page_view_daily view_count sum unchanged on second runAutoPrune call (no double-counting)");
      assertEq(result2.deleted.pageViews, 0, "idempotent: second call has nothing left to roll up/delete");
      assertEq(result2.deleted.queries, 0, "idempotent: second call deletes no analytics_queries rows");
      assertEq(result2.deleted.agentViews, 0, "idempotent: second call deletes no analytics_agent_views rows");
      assertEq(pvCount(), seeded.newPv, "idempotent: raw analytics_page_views count still just the newer rows after second call");
      assertEq(queriesCount(), 0, "idempotent: analytics_queries still empty after second call");
      assertEq(agentViewsCount(), 0, "idempotent: analytics_agent_views still empty after second call");
      assertEq(
        {
          query: sumOf("query_daily", "query_count"),
          queryText: sumOf("query_text_daily", "query_count"),
          agentView: sumOf("agent_view_daily", "view_count"),
          sessions: sumOf("sessions_daily", "session_count"),
        },
        rollupSumsAfterFirst,
        "idempotent: no rollup table is ever double-counted or deleted from on a second runAutoPrune call",
      );
    }
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runAutoPruneRollupTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
