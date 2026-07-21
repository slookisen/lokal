/**
 * traffic-stats.test.ts — tests for the rewritten getTrafficStats()
 * (src/services/traffic-stats.ts), dev-request
 * 2026-07-21-analytics-tre-boetter-mcp-logging-a2a-transparens slice A.
 *
 * Mirrors oa-home-counters.test.ts's shape: the main DB is injected via
 * __setDbForTesting + __initSchemaForTesting (previous handle saved/
 * restored), fresh require-cache for traffic-stats so its TTL cache never
 * leaks between runs.
 *
 * Covers:
 *   (a) The public-strip sum identity:
 *       humanViews + aiSearchViews + botViews === pageViews
 *   (b) realVisitors (unique HUMAN sessions) ≤ uniqueVisitors, and counts
 *       sessions, not views
 *   (c) Bucket membership: *-User UAs → aiSearchViews; GPTBot/Googlebot/
 *       SemrushBot/curl/scanner traffic → botViews (with ai_crawler split
 *       out in aiCrawlerViews); scanner-path sessions with browser-like UAs
 *       fold into botViews, not humanViews
 *   (d) Back-compat aliases: realHumans === humanViews and
 *       botAndAi === aiSearchViews + botViews + aiQueries
 *   (e) windowDays comes from the runtime RFB_AUTO_PRUNE_DAYS value
 *       (default 60, Math.max(7, …) clamp — same as the auto-prune job)
 *   (f) Vertical scoping still holds (rfb rows never leak into experiences)
 *
 * Exported runTrafficStatsTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/traffic-stats.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runTrafficStatsTests(opts: { log?: boolean } = {}): TestSummary {
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

  const prevDb = initMod.getDb();
  const memDb = new Database(":memory:");
  const prevPruneDays = process.env.RFB_AUTO_PRUNE_DAYS;

  // Fresh require-cache so traffic-stats' module-level TTL cache from any
  // earlier test block never leaks in (same discipline as oa-home-counters).
  const trafficStatsPath = require.resolve("./traffic-stats");
  delete require.cache[trafficStatsPath];

  try {
    initMod.__setDbForTesting(memDb as any);
    initMod.__initSchemaForTesting(memDb as any);

    const trafficStats = require("./traffic-stats") as typeof import("./traffic-stats");

    const insertPv = memDb.prepare(
      `INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id) VALUES (?, ?, ?, ?)`
    );

    const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

    // 3 human views over 2 human sessions
    insertPv.run("/", `h1:${CHROME}`, 0, "rfb");
    insertPv.run("/sok", `h1:${CHROME}`, 0, "rfb");
    insertPv.run("/", `h2:${IPHONE}`, 0, "rfb");
    // 2 ai_search views (ChatGPT-User + Claude-User) — human-initiated
    insertPv.run("/", "ai1:Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", 0, "rfb");
    insertPv.run("/", "ai2:Mozilla/5.0 (compatible; Claude-User/1.0)", 0, "rfb");
    // 2 ai_crawler views (GPTBot ×2)
    insertPv.run("/", "c1:Mozilla/5.0 (compatible; GPTBot/1.4)", 0, "rfb");
    insertPv.run("/om", "c1:Mozilla/5.0 (compatible; GPTBot/1.4)", 0, "rfb");
    // 1 search_engine + 1 seo_bot + 1 dev view
    insertPv.run("/", "g1:Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", 0, "rfb");
    insertPv.run("/", "s1:Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", 0, "rfb");
    insertPv.run("/", "d1:curl/8.4.0", 0, "rfb");
    // 1 scanner session: browser-like UA probing wp-admin (path-based fold)
    insertPv.run("/wp-admin/setup.php", `sc1:${CHROME}`, 0, "rfb");
    // owner traffic — excluded from everything
    insertPv.run("/", "own1:Lokal-Enricher/1.0", 1, "rfb");
    // a different vertical — must not leak into rfb numbers
    insertPv.run("/", `oa1:${CHROME}`, 0, "experiences");

    // 2 AI queries in analytics_queries (rfb)
    const insertQ = memDb.prepare(
      `INSERT INTO analytics_queries (protocol, query, is_owner, vertical_id) VALUES ('api', ?, 0, 'rfb')`
    );
    insertQ.run("egg oslo");
    insertQ.run("honning bergen");

    const s = trafficStats.getTrafficStats("rfb");

    // ── (a) Sum identity ────────────────────────────────────────────────
    assertEq(s.pageViews, 11, "a1: pageViews = 11 non-owner rfb rows");
    assertEq(s.humanViews + s.aiSearchViews + s.botViews, s.pageViews,
      "a2: humanViews + aiSearchViews + botViews === pageViews (public-strip invariant)");
    assertEq(s.humanViews, 3, "a3: humanViews = 3");
    assertEq(s.aiSearchViews, 2, "a4: aiSearchViews = 2 (*-User only)");
    assertEq(s.botViews, 6, "a5: botViews = 6 (2 ai_crawler + 1 search + 1 seo + 1 dev + 1 scanner)");
    assertEq(s.aiCrawlerViews, 2, "a6: aiCrawlerViews = 2 (GPTBot), split out of botViews");

    // ── (b) realVisitors semantics ──────────────────────────────────────
    assertEq(s.uniqueVisitors, 9, "b1: uniqueVisitors = 9 distinct non-owner rfb sessions");
    assertEq(s.realVisitors, 2, "b2: realVisitors = 2 unique HUMAN sessions (not views, scanner excluded)");
    assertTrue(s.realVisitors <= s.uniqueVisitors, "b3: realVisitors ≤ uniqueVisitors");

    // ── (c) scanner fold ────────────────────────────────────────────────
    // The browser-like session that probed /wp-admin is in botViews (checked
    // via a5) and NOT counted as a human visitor (checked via b2's 2).

    // ── (d) Back-compat aliases ─────────────────────────────────────────
    assertEq(s.realHumans, s.humanViews, "d1: realHumans aliases humanViews");
    assertEq(s.aiQueries, 2, "d2: aiQueries = 2");
    assertEq(s.botAndAi, s.aiSearchViews + s.botViews + s.aiQueries,
      "d3: botAndAi keeps the old aggregate meaning (all non-human views + AI queries)");

    // ── (e) windowDays from runtime retention ───────────────────────────
    assertEq(s.windowDays, 60, "e1: windowDays defaults to 60 (RFB_AUTO_PRUNE_DAYS unset)");
    process.env.RFB_AUTO_PRUNE_DAYS = "30";
    trafficStats.__resetTrafficStatsCacheForTesting();
    assertEq(trafficStats.getTrafficStats("rfb").windowDays, 30,
      "e2: windowDays follows RFB_AUTO_PRUNE_DAYS at runtime (30)");
    process.env.RFB_AUTO_PRUNE_DAYS = "3";
    trafficStats.__resetTrafficStatsCacheForTesting();
    assertEq(trafficStats.getTrafficStats("rfb").windowDays, 7,
      "e3: windowDays clamps to the prune job's 7-day minimum");
    delete process.env.RFB_AUTO_PRUNE_DAYS;
    trafficStats.__resetTrafficStatsCacheForTesting();

    // ── (f) Vertical scoping ────────────────────────────────────────────
    const oa = trafficStats.getTrafficStats("experiences");
    assertEq(oa.pageViews, 1, "f1: experiences vertical sees only its own 1 row");
    assertEq(oa.realVisitors, 1, "f2: experiences realVisitors = 1");
    assertEq(oa.humanViews + oa.aiSearchViews + oa.botViews, oa.pageViews,
      "f3: sum identity holds per-vertical too");
  } catch (err: any) {
    failed++;
    failures.push("traffic-stats: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    initMod.__setDbForTesting(prevDb);
    if (prevPruneDays === undefined) delete process.env.RFB_AUTO_PRUNE_DAYS;
    else process.env.RFB_AUTO_PRUNE_DAYS = prevPruneDays;
    delete require.cache[trafficStatsPath];
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/traffic-stats.test.ts`
if (require.main === module) {
  const summary = runTrafficStatsTests({ log: true });
  for (const f of summary.failures) console.log(f);
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
