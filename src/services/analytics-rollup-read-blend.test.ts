/**
 * analytics-rollup-read-blend.test.ts — Skive 3 of dev-request
 * 2026-09-02-analytics-historikk-rollup-lesere-foer-retention.
 *
 * Skive 1/2 rolled analytics_page_views / analytics_queries /
 * analytics_agent_views up into page_view_daily / sessions_daily /
 * query_daily / query_text_daily / agent_view_daily BEFORE deleting old raw
 * rows. This slice makes the stats readers actually fall back to those
 * rollup tables for the part of a requested window that's already been
 * pruned from raw — see src/services/analytics-rollup-reads.ts (the shared
 * blend layer) and src/services/retention-service.ts's getRollupBoundaryDate
 * / isAnalyticsRollupReadEnabled (the two building blocks it's built on).
 *
 * Covered here:
 *   (1) getRollupBoundaryDate / isAnalyticsRollupReadEnabled: the flag's
 *       default-true-unless-"false" behaviour, and the boundary's "empty raw
 *       table -> tomorrow" / "earliest day present in raw" behaviour.
 *   (2) Boundary no-double-count fixtures, one per rollup table family:
 *       page_view_daily+sessions_daily (AnalyticsService.getPageViewCount /
 *       getSummary), query_daily+query_text_daily (getSummary.totalQueries /
 *       .topSearchTerms), agent_view_daily (getTopProducers / getCityStats).
 *       Each seeds BOTH a raw row on the boundary day and a rollup row on an
 *       adjacent pruned day, and asserts the blended total is exactly
 *       raw + rollup — the boundary day is counted once, not zero or twice.
 *   (3) GET /api/agents/:id/stats (the mandated AC1-lite): byte-identical
 *       response for a period entirely within the raw table's current
 *       coverage, ANALYTICS_ROLLUP_READ on vs off.
 *   (4) ANALYTICS_ROLLUP_READ=false reproduces the EXACT pre-Skive-3
 *       raw-only (incomplete) behaviour for a period spanning the boundary —
 *       both via AnalyticsService.getPageViewCount and via the public
 *       /api/agents/:id/stats route.
 *
 * Harness mirrors analytics-rollup-slice2.test.ts: in-memory better-sqlite3
 * with the full prod schema injected via __setDbForTesting +
 * __initSchemaForTesting, previous global handle saved/restored.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/analytics-rollup-read-blend.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAnalyticsRollupReadBlendTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.header = () => r;
  r.set = () => r;
  r.type = () => r;
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
  return r;
}

function findRouteHandler(router: any, routePath: string, method: string): any {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.[method],
  );
  return layer?.route?.stack[0]?.handle;
}

export async function runAnalyticsRollupReadBlendTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevFlag = process.env.ANALYTICS_ROLLUP_READ;
  const prevAdminKey = process.env.ADMIN_KEY;

  const testDb = new Database(":memory:");

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    function isoDaysAgo(days: number): string {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    }
    const dayOf = (iso: string) => iso.slice(0, 10);

    function clearAll(): void {
      testDb.exec(
        "DELETE FROM analytics_page_views; DELETE FROM analytics_queries; " +
        "DELETE FROM analytics_agent_views; DELETE FROM page_view_daily; " +
        "DELETE FROM query_daily; DELETE FROM query_text_daily; " +
        "DELETE FROM agent_view_daily; DELETE FROM sessions_daily; DELETE FROM agents;"
      );
    }

    function freshAnalyticsService() {
      const p = require.resolve("./analytics-service");
      delete require.cache[p];
      const { analyticsService } = require("./analytics-service") as typeof import("./analytics-service");
      return analyticsService;
    }

    // ════════════════════════════════════════════════════════════════════
    // (1) getRollupBoundaryDate / isAnalyticsRollupReadEnabled
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      const retention = require("./retention-service") as typeof import("./retention-service");

      delete process.env.ANALYTICS_ROLLUP_READ;
      assertEq(retention.isAnalyticsRollupReadEnabled(), true, "flag: default true when ANALYTICS_ROLLUP_READ is unset");
      process.env.ANALYTICS_ROLLUP_READ = "true";
      assertEq(retention.isAnalyticsRollupReadEnabled(), true, "flag: true when explicitly \"true\"");
      process.env.ANALYTICS_ROLLUP_READ = "false";
      assertEq(retention.isAnalyticsRollupReadEnabled(), false, "flag: false ONLY when explicitly \"false\"");
      process.env.ANALYTICS_ROLLUP_READ = "garbage";
      assertEq(retention.isAnalyticsRollupReadEnabled(), true, "flag: any other value (garbage) counts as enabled, same permissive-default spirit as RFB_AUTO_PRUNE_DAYS");
      delete process.env.ANALYTICS_ROLLUP_READ;

      // Empty raw table -> boundary is tomorrow (route every day to rollup).
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      assertEq(
        retention.getRollupBoundaryDate("analytics_page_views"),
        tomorrow.toISOString().slice(0, 10),
        "boundary: empty raw table -> tomorrow's UTC date",
      );

      // Non-empty raw table -> boundary is the earliest day present.
      const oldest = isoDaysAgo(42);
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-a:Mozilla', 200, 'rfb', ?)`,
      ).run(oldest);
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-b:Mozilla', 200, 'rfb', ?)`,
      ).run(isoDaysAgo(1));
      assertEq(
        retention.getRollupBoundaryDate("analytics_page_views"),
        dayOf(oldest),
        "boundary: earliest day present in raw (ignores later rows)",
      );
    }

    // ════════════════════════════════════════════════════════════════════
    // (2a) page_view_daily + sessions_daily boundary no-double-count fixture
    //      via AnalyticsService.getPageViewCount / getSummary
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      delete process.env.ANALYTICS_ROLLUP_READ; // default true

      // boundary day = earliest day still in raw = -10 days.
      const boundaryDay = dayOf(isoDaysAgo(10));
      const prunedDayFar = dayOf(isoDaysAgo(20));   // pruned, adjacent-ish
      const prunedDayNear = dayOf(isoDaysAgo(11));  // pruned, ADJACENT to the boundary day

      // Rollup rows for the two pruned days (as if rollupAndPrunePageViews
      // already ran and deleted their raw rows).
      testDb.prepare(
        `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
         VALUES (?, '/a', 'direct', 'human', 'rfb', 10, 4)`,
      ).run(prunedDayFar);
      testDb.prepare(
        `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
         VALUES (?, '/a', 'direct', 'human', 'rfb', 7, 3)`,
      ).run(prunedDayNear);
      testDb.prepare(
        `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count) VALUES (?, 'rfb', 'human', 4)`,
      ).run(prunedDayFar);
      testDb.prepare(
        `INSERT INTO sessions_daily (day, vertical_id, bot_type, session_count) VALUES (?, 'rfb', 'human', 3)`,
      ).run(prunedDayNear);

      // Raw row EXACTLY on the boundary day — must be counted once, as raw,
      // never also picked up by the rollup-side query (which is < boundary).
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-boundary:Mozilla', 200, 'rfb', ?)`,
      ).run(`${boundaryDay} 12:00:00`);
      // A second, more recent raw row (well inside the window) too.
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES ('/a', 'direct', 'h1', 'sess-recent:Mozilla', 200, 'rfb', ?)`,
      ).run(isoDaysAgo(1));

      const analyticsService = freshAnalyticsService();
      analyticsService._summaryCache.clear();

      const hoursBack = 24 * 25; // reaches back past both pruned days
      const count = analyticsService.getPageViewCount(hoursBack);
      assertEq(count, 2 + 10 + 7, "no-double-count (page_view_daily): raw(2) + rollup(10+7) = 19, boundary day counted once as raw");

      // Flip the flag off: must reproduce the OLD raw-only number (2), not 19.
      process.env.ANALYTICS_ROLLUP_READ = "false";
      analyticsService._summaryCache.clear();
      const rawOnlyCount = analyticsService.getPageViewCount(hoursBack);
      assertEq(rawOnlyCount, 2, "flag=false: getPageViewCount reproduces the exact pre-Skive-3 raw-only count (2), missing the 17 pruned views");
      delete process.env.ANALYTICS_ROLLUP_READ;

      // uniqueVisitors (sessions_daily blend) via getSummary, same fixture.
      analyticsService._summaryCache.clear();
      const summary = analyticsService.getSummary(hoursBack);
      // raw: 2 distinct sessions (sess-boundary, sess-recent); rollup: 4+3 = 7.
      assertEq(summary.uniqueVisitors, 2 + 7, "no-double-count (sessions_daily): raw(2) + rollup(4+3) = 9 via getSummary.uniqueVisitors");
      assertEq(summary.pageViews, 2 + 10 + 7, "getSummary.pageViews blends the same way as getPageViewCount");
    }

    // ════════════════════════════════════════════════════════════════════
    // (2b) query_daily + query_text_daily boundary no-double-count fixture
    //      via AnalyticsService.getSummary (totalQueries / topSearchTerms)
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      delete process.env.ANALYTICS_ROLLUP_READ;

      const boundaryDay = dayOf(isoDaysAgo(10));
      const prunedDay = dayOf(isoDaysAgo(15));

      testDb.prepare(
        `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
         VALUES (?, 'a2a', '', 'rfb', '', 5, 0, 0, 0)`,
      ).run(prunedDay);
      testDb.prepare(
        `INSERT INTO query_text_daily (day, query, vertical_id, query_count) VALUES (?, 'egg', 'rfb', 5)`,
      ).run(prunedDay);

      testDb.prepare(
        `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', 'egg', 'Oslo', 1, 100, NULL, 'rfb', ?)`,
      ).run(`${boundaryDay} 12:00:00`);
      testDb.prepare(
        `INSERT INTO analytics_queries (protocol, query, city, result_count, response_time_ms, agent_id, vertical_id, created_at)
         VALUES ('a2a', 'melk', 'Oslo', 1, 100, NULL, 'rfb', ?)`,
      ).run(isoDaysAgo(1));

      const analyticsService = freshAnalyticsService();
      analyticsService._summaryCache.clear();
      const summary = analyticsService.getSummary(24 * 20);

      assertEq(summary.totalQueries, 2 + 5, "no-double-count (query_daily): raw(2) + rollup(5) = 7 via getSummary.totalQueries");
      const eggTerm = summary.topSearchTerms.find((t: any) => t.query === "egg");
      assertEq(eggTerm?.count, 1 + 5, "no-double-count (query_text_daily): 'egg' = raw(1) + rollup(5) = 6 via getSummary.topSearchTerms");

      process.env.ANALYTICS_ROLLUP_READ = "false";
      analyticsService._summaryCache.clear();
      const rawOnlySummary = analyticsService.getSummary(24 * 20);
      assertEq(rawOnlySummary.totalQueries, 2, "flag=false: totalQueries reproduces the exact pre-Skive-3 raw-only count (2)");
      delete process.env.ANALYTICS_ROLLUP_READ;
    }

    // ════════════════════════════════════════════════════════════════════
    // (2c) agent_view_daily boundary no-double-count fixture via
    //      getTopProducers / getCityStats — includes a rollup-ONLY agent
    //      (no surviving raw row at all) to exercise the agents-table name
    //      resolution fallback.
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      delete process.env.ANALYTICS_ROLLUP_READ;

      const boundaryDay = dayOf(isoDaysAgo(10));
      const prunedDay = dayOf(isoDaysAgo(20));

      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES ('agent-a', 'Gard A', 'd', 'test', 'a@x.invalid', 'https://x.invalid', 'producer', 'key-a', 'Oslo', NULL)`,
      ).run();
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES ('agent-b', 'Gard B (rollup only)', 'd', 'test', 'b@x.invalid', 'https://x.invalid', 'producer', 'key-b', 'Bergen', NULL)`,
      ).run();

      // agent-a: raw row on the boundary day (city Oslo) + rollup row on a
      // pruned day (SAME city) — must sum to one merged entry.
      testDb.prepare(
        `INSERT INTO analytics_agent_views (agent_id, agent_name, city, view_source, vertical_id, created_at)
         VALUES ('agent-a', 'Gard A', 'Oslo', 'seo', 'rfb', ?)`,
      ).run(`${boundaryDay} 12:00:00`);
      testDb.prepare(
        `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, 'agent-a', 'seo', 'Oslo', 6)`,
      ).run(prunedDay);

      // agent-b: ONLY a rollup row — no surviving raw row in this window at
      // all (fully pruned agent). Must still appear (name resolved from
      // `agents`), not silently dropped.
      testDb.prepare(
        `INSERT INTO agent_view_daily (day, agent_id, view_source, city, view_count) VALUES (?, 'agent-b', 'direct', 'Bergen', 9)`,
      ).run(prunedDay);

      // A query_daily row too, for getCityStats' searchQueries blend.
      testDb.prepare(
        `INSERT INTO query_daily (day, protocol, agent_id, vertical_id, city, query_count, result_count_sum, response_time_ms_sum, response_time_ms_n)
         VALUES (?, 'a2a', '', 'rfb', 'Oslo', 3, 0, 0, 0)`,
      ).run(prunedDay);

      const analyticsService = freshAnalyticsService();
      const hoursBack = 24 * 25;

      const producers = analyticsService.getTopProducers(20, hoursBack);
      const a = producers.find((p: any) => p.agentId === "agent-a");
      const b = producers.find((p: any) => p.agentId === "agent-b");
      assertEq(a?.viewCount, 1 + 6, "no-double-count (agent_view_daily): agent-a = raw(1) + rollup(6) = 7");
      assertTrue(!!b, "rollup-only agent (agent-b, no surviving raw row) still appears in getTopProducers");
      assertEq(b?.viewCount, 9, "rollup-only agent-b's viewCount comes entirely from agent_view_daily");
      assertEq(b?.agentName, "Gard B (rollup only)", "rollup-only agent-b's name is resolved from the `agents` table (agent_view_daily has no agent_name column)");

      const cities = analyticsService.getCityStats(hoursBack);
      const oslo = cities.find((c: any) => c.city === "Oslo");
      assertEq(oslo?.viewCount, 1 + 6, "no-double-count (agent_view_daily by city): Oslo viewCount = raw(1) + rollup(6) = 7");
      assertEq(oslo?.searchQueries, 0 + 3, "no-double-count (query_daily by city): Oslo searchQueries = raw(0) + rollup(3) = 3");
      const bergen = cities.find((c: any) => c.city === "Bergen");
      assertTrue(!!bergen, "rollup-only city (Bergen, only reachable via agent-b's pruned view) still appears in getCityStats");
      assertEq(bergen?.viewCount, 9, "rollup-only Bergen viewCount comes entirely from agent_view_daily");

      // flag=false: exact pre-Skive-3 raw-only reproduction.
      process.env.ANALYTICS_ROLLUP_READ = "false";
      const rawOnlyProducers = analyticsService.getTopProducers(20, hoursBack);
      assertEq(rawOnlyProducers.length, 1, "flag=false: only agent-a's raw row survives — agent-b (rollup-only) is invisible again, exactly like pre-Skive-3");
      assertEq(rawOnlyProducers[0]?.viewCount, 1, "flag=false: agent-a's viewCount reverts to the raw-only count (1)");
      delete process.env.ANALYTICS_ROLLUP_READ;
    }

    // ════════════════════════════════════════════════════════════════════
    // (3) + (4) GET /api/agents/:id/stats — AC1-lite + flag=false reproduces
    //     the exact pre-Skive-3 raw-only (incomplete) behaviour
    // ════════════════════════════════════════════════════════════════════
    {
      clearAll();
      delete process.env.ANALYTICS_ROLLUP_READ;
      const testKey = "analytics-rollup-read-blend-test-key";
      process.env.ADMIN_KEY = testKey;

      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES ('agent-stats-target', 'Stats Target Gard', 'd', 'test', 's@x.invalid', 'https://x.invalid', 'producer', 'key-s', 'Oslo', NULL)`,
      ).run();

      const agentStatsPath = require.resolve("../routes/agent-stats");
      delete require.cache[agentStatsPath];
      const agentStatsRouter = (require("../routes/agent-stats") as any).default;
      const statsHandler = findRouteHandler(agentStatsRouter, "/api/agents/:id/stats", "get");
      assertTrue(typeof statsHandler === "function", "agent-stats: GET /api/agents/:id/stats handler resolved");

      const { marketplaceRegistry } = require("../services/marketplace-registry") as
        typeof import("../services/marketplace-registry");
      marketplaceRegistry._agentsCache = null;

      const path = "/produsent/stats-target-gard";

      async function callStats(): Promise<any> {
        const res = fakeRes();
        await statsHandler({ params: { id: "agent-stats-target" }, headers: {}, query: {} } as any, res as any);
        assertTrue(res.statusCode === 200, "agent-stats: 200 from GET /api/agents/:id/stats");
        return res.body;
      }

      // ── (3) AC1-lite: period ENTIRELY within raw's current coverage ────
      // Push the raw table's floor (boundary) to before the 90-day window's
      // start by seeding one row well past 90 days back — so
      // getPrunedChatgptClaudeCounts has nothing to add regardless of the
      // flag, and the two runs must be byte-identical.
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', 'sess-old:Mozilla', 200, 'rfb', ?)`,
      ).run(path, isoDaysAgo(100));
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', 'sess-human:Mozilla', 200, 'rfb', ?)`,
      ).run(path, isoDaysAgo(5));
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', 'sess-gpt:GPTBot/1.0', 200, 'rfb', ?)`,
      ).run(path, isoDaysAgo(3));

      delete process.env.ANALYTICS_ROLLUP_READ; // on (default true)
      const allRawOn = await callStats();
      process.env.ANALYTICS_ROLLUP_READ = "false";
      const allRawOff = await callStats();
      delete process.env.ANALYTICS_ROLLUP_READ;

      assertEq(allRawOn, allRawOff, "AC1-lite: /api/agents/:id/stats is byte-identical, flag on vs off, for a period entirely within raw's current coverage");
      assertEq(allRawOn.aiBreakdown, { chatgpt: 1, claude: 0, other: 0 }, "AC1-lite sanity: the seeded GPTBot view is counted");
      assertEq(allRawOn.humanViews, 1, "AC1-lite sanity: the seeded human view is counted");

      // ── (4) flag=false reproduces the exact pre-Skive-3 raw-only
      //        (incomplete) behaviour for a period SPANNING the boundary ──
      clearAll();
      testDb.prepare(
        `INSERT INTO agents (id, name, description, provider, contact_email, url, role, api_key, city, umbrella_type)
         VALUES ('agent-stats-target', 'Stats Target Gard', 'd', 'test', 's@x.invalid', 'https://x.invalid', 'producer', 'key-s', 'Oslo', NULL)`,
      ).run();
      marketplaceRegistry._agentsCache = null;

      // Raw floor (boundary) = -10 days: only rows from -10 days on survive
      // in raw. A GPTBot view from -30 days (well past the 90-day window's
      // NEED, but within it) is PRUNED — it lives only in page_view_daily.
      testDb.prepare(
        `INSERT INTO analytics_page_views (path, source, user_agent_hash, session_id, status_code, vertical_id, created_at)
         VALUES (?, 'direct', 'h1', 'sess-recent:Mozilla', 200, 'rfb', ?)`,
      ).run(path, isoDaysAgo(1));
      testDb.prepare(
        `INSERT INTO page_view_daily (day, path, source, bot_type, vertical_id, view_count, session_count)
         VALUES (?, ?, 'direct', 'chatgpt', 'rfb', 4, 4)`,
      ).run(dayOf(isoDaysAgo(30)), path);

      delete process.env.ANALYTICS_ROLLUP_READ; // on
      const spanningOn = await callStats();
      process.env.ANALYTICS_ROLLUP_READ = "false";
      const spanningOff = await callStats();
      delete process.env.ANALYTICS_ROLLUP_READ;

      assertEq(spanningOff.aiBreakdown.chatgpt, 0, "flag=false, boundary-spanning period: chatgpt views are MISSING (0) — reproduces the exact pre-Skive-3 wrongness, not a new different wrongness");
      assertEq(spanningOn.aiBreakdown.chatgpt, 4, "flag=true, same period: the 4 pruned chatgpt views are recovered from page_view_daily");
      assertTrue(spanningOn.aiBreakdown.chatgpt > spanningOff.aiBreakdown.chatgpt, "flag on strictly improves on flag off for a boundary-spanning period (never regresses to something worse or different-shaped)");
      // Everything else in the response is unaffected by the flag for this fixture.
      assertEq(spanningOn.humanViews, spanningOff.humanViews, "flag does not affect humanViews (documented raw-only known gap, unrelated to this assertion)");
      assertEq(spanningOn.conversationCount, spanningOff.conversationCount, "flag does not affect conversationCount (unrelated table)");
    }

    if (log) console.log(`\nanalytics-rollup-read-blend: ${passed} passed, ${failed} failed`);
  } finally {
    if (prevFlag === undefined) delete process.env.ANALYTICS_ROLLUP_READ;
    else process.env.ANALYTICS_ROLLUP_READ = prevFlag;
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = prevAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/agent-stats")]; } catch { /* ignore */ }
    try { delete require.cache[require.resolve("./analytics-service")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/analytics-rollup-read-blend.test.ts`
if (require.main === module) {
  console.log("── dev-request 2026-09-02-analytics-historikk-rollup-lesere-foer-retention, Skive 3: rollup read blend ──");
  runAnalyticsRollupReadBlendTests({ log: true }).then((r) => {
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
