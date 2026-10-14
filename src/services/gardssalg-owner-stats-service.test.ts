/**
 * gardssalg-owner-stats-service.test.ts — tests for
 * getGardssalgOwnerStats() (src/services/gardssalg-owner-stats-service.ts),
 * the minimal "Statistikk" tab data source for the opplevagent gårdssalg
 * owner-claim portal (dev-request 2026-07-21-opplevagent-claim-flyt-
 * drikkeprodusenter, acceptance criterion 3).
 *
 * Mirrors oa-home-counters.test.ts's DB setup for the shared
 * analytics_page_views table (__setDbForTesting + __initSchemaForTesting on
 * an in-memory RFB db, previous handle saved/restored).
 *
 * Covers:
 *   (a) path-scoping — only rows for the exact produsent-page path count.
 *   (b) vertical-scoping — an 'rfb' row on the SAME path string never leaks in.
 *   (c) people vs. AI search with the shared classifier (2026-10-14, S6):
 *       ChatGPT-User/Claude-User are AI search; AI crawlers (ClaudeBot) and
 *       search engines are neither; a 404 is not a page view.
 *   (d) owner/fleet-traffic exclusion (is_owner=1).
 *   (e) the honest "notAvailable" list is always present (never silently
 *       fabricated conversations/contact-click/AI-recommendation numbers).
 *
 * Exported runGardssalgOwnerStatsServiceTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone:
 *   npx tsx src/services/gardssalg-owner-stats-service.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgOwnerStatsServiceTests(opts: { log?: boolean } = {}): TestSummary {
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

  const initMod = require("../database/init") as typeof import("../database/init");
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const prevDb = initMod.getDb();
  const rfbDb = new Database(":memory:");

  try {
    initMod.__setDbForTesting(rfbDb as any);
    initMod.__initSchemaForTesting(rfbDb as any);

    const svcPath = require.resolve("./gardssalg-owner-stats-service");
    delete require.cache[svcPath];
    const svc = require("./gardssalg-owner-stats-service") as typeof import("./gardssalg-owner-stats-service");

    const path = "/kategori/gardssalg/produsent/route-test-gard";
    const insert = rfbDb.prepare(
      `INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id) VALUES (?, ?, ?, ?)`,
    );

    // 2 real human views on the produsent page (distinct sessions).
    insert.run(path, "human-1:Mozilla/5.0 (Macintosh) Chrome/120", 0, "experiences");
    insert.run(path, "human-2:Mozilla/5.0 (Windows) Firefox/119", 0, "experiences");
    // 1 AI search view (an assistant fetching the page for a person).
    insert.run(path, "ai-1:Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", 0, "experiences");
    // An AI crawler, a search engine and a 404 — neither people nor AI search.
    insert.run(path, "bot-1:Mozilla/5.0 (compatible; ClaudeBot/1.0)", 0, "experiences");
    insert.run(path, "bot-2:Mozilla/5.0 (compatible; Googlebot/2.1)", 0, "experiences");
    rfbDb.prepare(`INSERT INTO analytics_page_views (path, session_id, is_owner, vertical_id, status_code) VALUES (?, ?, 0, 'experiences', 404)`)
      .run(path, "human-404:Mozilla/5.0 (Macintosh) Chrome/120");
    // 1 fleet/internal view — must be excluded from BOTH counters.
    insert.run(path, "owner-1:Lokal-Enricher/1.0", 1, "experiences");
    // Same path, but on the 'rfb' vertical — must never leak in (vertical-scoping).
    insert.run(path, "rfb-leak:Mozilla/5.0 (Macintosh) Chrome/120", 0, "rfb");
    // A DIFFERENT gårdssalg produsent's page — must never leak in (path-scoping).
    insert.run("/kategori/gardssalg/produsent/en-annen-gard", "human-3:Mozilla/5.0 (Macintosh) Chrome/120", 0, "experiences");

    const stats = svc.getGardssalgOwnerStats(path);

    assertEq(stats.path, path, "a1: stats echo back the requested path");
    assertEq(stats.humanViews, 2, "a2: humanViews counts only the 2 real human views on THIS path");
    assertEq([stats.aiSearchViews, stats.aiBotViews], [1, 1], "a3: AI search counts the 1 Claude-User view on THIS path; the ClaudeBot crawl and Googlebot are not counted");
    assertEq(stats.humanViews + stats.aiSearchViews, 3, "b1: the rfb-vertical row, the fleet row, the bots and the 404 are all excluded (2 people + 1 AI search)");
    assertTrue(Array.isArray(stats.notAvailable) && stats.notAvailable.length > 0, "e1: notAvailable is a non-empty, honest list of what this tab does NOT show");
    assertTrue(stats.notAvailable.some((s) => /anbefaling/i.test(s)), "e2: notAvailable explicitly names AI-recommendation counts as unavailable (never fabricated)");
    assertEq(stats.windowDays, 60, "c1: windowDays is the 60-day raw retention, as on the RFB owner portal");

    // A path with zero rows -> zero, not an error.
    const emptyStats = svc.getGardssalgOwnerStats("/kategori/gardssalg/produsent/ingen-visninger");
    assertEq(emptyStats.humanViews, 0, "d1: a produsent page with no traffic yet returns 0, not an error");
    assertEq(emptyStats.aiBotViews, 0, "d2: same for aiBotViews");
  } catch (err: any) {
    failed++;
    failures.push("gardssalg-owner-stats-service: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    initMod.__setDbForTesting(prevDb);
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/gardssalg-owner-stats-service.test.ts`
if (require.main === module) {
  console.log("── gardssalg-owner-stats-service unit tests ──");
  const r = runGardssalgOwnerStatsServiceTests({ log: true });
  console.log(`\ngardssalg-owner-stats-service: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
