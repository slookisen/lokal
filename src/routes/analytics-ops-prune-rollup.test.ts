/**
 * analytics-ops-prune-rollup.test.ts — dev-request
 * 2026-09-02-analytics-historikk-rollup-lesere-foer-retention, follow-up to
 * lokal#782 (FUNN rfb-analytics-ops-prune-route-samme-blodning-annen-sti).
 *
 * lokal#782 fixed the nightly auto-prune tick, but two MANUAL prune paths
 * still carried their own copies of the raw, unconditional
 * `DELETE ... WHERE created_at < ?` against all three analytics tables:
 *
 *   - POST /admin/analytics/ops/prune  (route-local DELETEs)
 *   - POST /admin/analytics/prune      -> AnalyticsService.pruneOldData()
 *
 * Both now delegate to AnalyticsService.runAutoPrune(). This file proves,
 * per route, that:
 *   (a) old analytics_page_views rows are gone from the raw table AND
 *       rolled up into page_view_daily (rollup actually ran) — newer rows
 *       are left in place;
 *   (b) analytics_queries / analytics_agent_views are COMPLETELY untouched;
 *   (c) the response reports skippedPendingRollup / wouldDeleteIfPruned
 *       (ops/prune) and the old response fields still exist;
 *   (d) the 7-day floor still holds on both routes.
 *
 * Wired into tests/test.ts (same require()-into-npm-test pattern as
 * analytics-retention-rollup.test.ts). Standalone:
 *   npx tsx src/routes/analytics-ops-prune-rollup.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

export async function runOpsPruneRollupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    // Bust caches so both the service singleton and the router see the
    // injected in-memory DB.
    for (const m of ["../services/analytics-service", "../routes/analytics"]) {
      delete require.cache[require.resolve(m)];
    }
    const analyticsModule = require("../routes/analytics") as typeof import("../routes/analytics");
    const routerModule = analyticsModule.default as any;

    function getHandler(path: string) {
      const layer = routerModule.stack.find(
        (l: any) => l.route && l.route.path === path && l.route.methods && l.route.methods.post,
      );
      assertTrue(!!layer, `setup: POST ${path} handler is registered on the router`);
      return layer.route.stack[0].handle;
    }

    const postOpsPrune = getHandler("/ops/prune");
    const postPrune = getHandler("/prune");

    async function call(handler: any, body: any): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: {}, query: {}, body } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    const DAYS_TO_KEEP = 90;

    function isoDaysAgo(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }

    function seed(): { oldPv: number; newPv: number; oldQueries: number; oldAgentViews: number } {
      testDb.exec(
        "DELETE FROM analytics_page_views; DELETE FROM analytics_queries; " +
        "DELETE FROM analytics_agent_views; DELETE FROM page_view_daily;"
      );
      const oldCreated = isoDaysAgo(DAYS_TO_KEEP + 30);
      const newCreated = isoDaysAgo(1);

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

    const count = (t: string) => (testDb.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number }).c;
    const dailySum = () =>
      (testDb.prepare("SELECT COALESCE(SUM(view_count), 0) as s FROM page_view_daily").get() as { s: number }).s;

    // ── POST /ops/prune ──────────────────────────────────────────────────
    {
      const seeded = seed();
      const r = await call(postOpsPrune, { daysToKeep: DAYS_TO_KEEP });
      assertEq(r.status, 200, "ops/prune: 200");
      assertEq(r.body?.success, true, "ops/prune: success:true");
      assertEq(r.body?.action, "prune", "ops/prune: action field kept");
      assertEq(r.body?.daysKept, DAYS_TO_KEEP, "ops/prune: daysKept echoes request");
      assertTrue(typeof r.body?.cutoff === "string", "ops/prune: cutoff field kept");

      assertEq(count("analytics_page_views"), seeded.newPv, "ops/prune: only newer analytics_page_views rows remain");
      assertTrue(count("page_view_daily") > 0, "ops/prune: page_view_daily has rolled-up rows (rollup actually ran)");
      assertEq(dailySum(), seeded.oldPv, "ops/prune: page_view_daily view_count sums to the rolled-up old rows");
      assertEq(r.body?.deleted?.pageViews, seeded.oldPv, "ops/prune: deleted.pageViews reports rolled-up+deleted rows");

      assertEq(count("analytics_queries"), seeded.oldQueries, "ops/prune: analytics_queries untouched");
      assertEq(count("analytics_agent_views"), seeded.oldAgentViews, "ops/prune: analytics_agent_views untouched");
      assertEq(r.body?.deleted?.queries, 0, "ops/prune: deleted.queries is 0");
      assertEq(r.body?.deleted?.agentViews, 0, "ops/prune: deleted.agentViews is 0");

      assertEq(
        r.body?.skippedPendingRollup,
        ["analytics_queries", "analytics_agent_views"],
        "ops/prune: skippedPendingRollup names both tables without rollup coverage",
      );
      assertEq(r.body?.wouldDeleteIfPruned?.queries, seeded.oldQueries, "ops/prune: wouldDeleteIfPruned.queries sizing");
      assertEq(r.body?.wouldDeleteIfPruned?.agentViews, seeded.oldAgentViews, "ops/prune: wouldDeleteIfPruned.agentViews sizing");
      assertEq(
        r.body?.remaining,
        { pageViews: seeded.newPv, queries: seeded.oldQueries, agentViews: seeded.oldAgentViews },
        "ops/prune: remaining counts reflect the post-prune tables",
      );

      // idempotent second call
      const sumBefore = dailySum();
      const r2 = await call(postOpsPrune, { daysToKeep: DAYS_TO_KEEP });
      assertEq(r2.body?.deleted?.pageViews, 0, "ops/prune: second call has nothing left to roll up");
      assertEq(dailySum(), sumBefore, "ops/prune: page_view_daily not double-counted on second call");

      // 7-day floor + missing body
      seed();
      const r3 = await call(postOpsPrune, undefined);
      assertEq(r3.status, 200, "ops/prune: undefined body does not 500");
      assertEq(r3.body?.daysKept, 30, "ops/prune: default daysToKeep=30 when body missing");
      seed();
      const r4 = await call(postOpsPrune, { daysToKeep: 1 });
      assertEq(r4.body?.daysKept, 7, "ops/prune: daysToKeep floors at 7");
      assertEq(count("analytics_page_views"), 3, "ops/prune: 7-day floor keeps rows from yesterday");
    }

    // ── POST /prune (pruneOldData) ───────────────────────────────────────
    {
      const seeded = seed();
      const r = await call(postPrune, { olderThanDays: DAYS_TO_KEEP });
      assertEq(r.status, 200, "prune: 200");
      assertEq(r.body?.success, true, "prune: success:true");
      assertEq(r.body?.olderThanDays, DAYS_TO_KEEP, "prune: olderThanDays echoed");
      assertEq(r.body?.message, `Pruned ${seeded.oldPv} old analytics records`, "prune: message counts only rolled-up page views");

      assertEq(count("analytics_page_views"), seeded.newPv, "prune: only newer analytics_page_views rows remain");
      assertEq(dailySum(), seeded.oldPv, "prune: old page views rolled up into page_view_daily");
      assertEq(count("analytics_queries"), seeded.oldQueries, "prune: analytics_queries untouched");
      assertEq(count("analytics_agent_views"), seeded.oldAgentViews, "prune: analytics_agent_views untouched");

      seed();
      const r5 = await call(postPrune, { olderThanDays: 3 });
      assertEq(r5.status, 400, "prune: <7 days still rejected with 400");
      assertEq(count("analytics_page_views"), 8, "prune: rejected request deletes nothing");
    }
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runOpsPruneRollupTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
