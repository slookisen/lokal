/**
 * analytics-devices.test.ts — regression test for the GET
 * /admin/analytics/devices device-classification bug found in the 2nd
 * review round of dev-request 2026-09-24-mcp-rate-limit-og-personvern-
 * sannhet.
 *
 * Commit 9550dda (this branch, C2 review finding 3) changed session_id for
 * HUMAN traffic from the bare `${ipHash}:${rawUserAgent}` to
 * `${ipHash}:${bucket}:${hash}` (bucket = mobile/tablet/desktop — see
 * humanDeviceBucket()/sessionIdFor() in analytics-service.ts, and the newly
 * exported HUMAN_DEVICE_BUCKETS list). This endpoint used to re-derive
 * device type by substring-matching browser names
 * (mozilla/chrome/safari/firefox/edg/) out of whatever followed the ipHash
 * prefix. With the new format that segment is just "desktop:<hash>",
 * "mobile:<hash>" or "tablet:<hash>" — "mobile"/"tablet" still happened to
 * match by substring coincidence, but "desktop" matches NONE of the browser
 * substrings, so every real desktop pageview silently became 'unknown'.
 *
 * Fix: deriveDeviceFromSessionId() (now exported from routes/analytics.ts)
 * checks for a literal HUMAN_DEVICE_BUCKETS token (mobile/tablet/desktop)
 * as the session_id's first segment before falling back to the original
 * substring match, which is kept unchanged for everything else (old-format
 * bot/crawler/dev-tool session_ids, and any pre-migration legacy raw-UA
 * human rows still sitting in the database).
 *
 * Covers, directly against the exported helper (unit-testable without a DB
 * or HTTP round-trip) AND against the live route (proves the SQL + grouping
 * wiring, not just the classifier in isolation):
 *   1. New-format human buckets: desktop/mobile/tablet all classify as
 *      themselves — (1a) is the actual bug: desktop used to fall through to
 *      'unknown'.
 *   2. Old-format (pre-migration) raw-UA human session_ids: desktop
 *      (Chrome/Safari UA), mobile (iPhone UA) and tablet (iPad UA) still
 *      classify correctly — unchanged behavior.
 *   3. A non-filtered crawler-ish UA that the endpoint's SQL WHERE clause
 *      does NOT exclude (no "bot"/"spider"/"crawl"/etc. substring) still
 *      lands in 'unknown', same as before this fix — proves the fix didn't
 *      touch non-human classification.
 *   4. End-to-end via GET /admin/analytics/devices with real DB rows: a mix
 *      of new-format desktop/mobile/tablet rows plus a legacy raw-UA
 *      desktop row aggregate into the correct buckets — desktop is not lost
 *      into 'unknown'.
 *
 * Run standalone: npx tsx src/routes/analytics-devices.test.ts
 * Wired into tests/test.ts via runAnalyticsDevicesTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.setHeader = () => {};
  return r;
}

function fakeReq(url: string, opts: { headers?: Record<string, string>; query?: Record<string, string> } = {}) {
  const headers = opts.headers || {};
  return {
    method: "GET",
    url,
    query: opts.query || {},
    headers,
    hostname: "",
    get(name: string) { return this.headers[name.toLowerCase()]; },
  };
}

export async function runAnalyticsDevicesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Unit coverage of the exported classifier — no DB/HTTP needed, and the
  //    most direct proof of the fix.
  // ═══════════════════════════════════════════════════════════════════════
  {
    const routePath = require.resolve("./analytics");
    delete require.cache[routePath];
    const { deriveDeviceFromSessionId } = require("./analytics") as typeof import("./analytics");

    // (the bug) new-format human buckets
    assertEq(deriveDeviceFromSessionId("abc123:desktop:0123456789abcdef"), "desktop",
      "1a: new-format 'desktop:<hash>' session_id classifies as desktop (was 'unknown' before the fix)");
    assertEq(deriveDeviceFromSessionId("abc123:mobile:0123456789abcdef"), "mobile",
      "1b: new-format 'mobile:<hash>' session_id classifies as mobile");
    assertEq(deriveDeviceFromSessionId("abc123:tablet:0123456789abcdef"), "tablet",
      "1c: new-format 'tablet:<hash>' session_id classifies as tablet");

    // old-format raw-UA human session_ids — unchanged behavior
    assertEq(
      deriveDeviceFromSessionId("abc123:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"),
      "desktop",
      "1d: old-format raw desktop-browser UA still classifies as desktop"
    );
    assertEq(
      deriveDeviceFromSessionId("abc123:Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"),
      "mobile",
      "1e: old-format raw iPhone UA still classifies as mobile"
    );
    assertEq(
      deriveDeviceFromSessionId("abc123:Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"),
      "tablet",
      "1f: old-format raw iPad UA still classifies as tablet (tablet checked before mobile, since iPads say 'Mobile' too)"
    );

    // A bot/crawler UA that the endpoint's SQL WHERE does NOT filter out (no
    // bot/spider/crawl/curl// etc. substring) — unchanged 'unknown'
    // fallback, proving the fix left non-human classification alone.
    assertEq(
      deriveDeviceFromSessionId("abc123:facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"),
      "unknown",
      "1g: a non-filtered crawler UA (facebookexternalhit) still classifies as 'unknown', unchanged"
    );

    // Edge cases — unchanged
    assertEq(deriveDeviceFromSessionId("noColonHere"), "unknown", "1h: a session_id with no ':' still classifies as 'unknown'");
    assertEq(deriveDeviceFromSessionId("abc123:"), "unknown", "1i: an empty UA/bucket segment still classifies as 'unknown'");
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2. End-to-end via the live route + a real (in-memory) DB — proves the
  //    SQL query + GROUP BY + bucket aggregation wiring, not just the
  //    classifier in isolation.
  // ═══════════════════════════════════════════════════════════════════════
  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const Database = require("better-sqlite3");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  try {
    __setDbForTesting(testDb);
    __initSchemaForTesting(testDb);

    delete process.env.ANALYTICS_ADMIN_KEY;
    process.env.ADMIN_KEY = "analytics-devices-test-admin-key";

    const insert = testDb.prepare(
      `INSERT INTO analytics_page_views (path, session_id, created_at, is_owner) VALUES (?, ?, datetime('now'), 0)`
    );
    // Two new-format desktop page views, same session -> 1 visitor, count 2.
    insert.run("/", "iph1:desktop:aaaaaaaaaaaaaaaa");
    insert.run("/sok", "iph1:desktop:aaaaaaaaaaaaaaaa");
    // One new-format mobile row, a different session.
    insert.run("/", "iph2:mobile:bbbbbbbbbbbbbbbb");
    // One new-format tablet row.
    insert.run("/", "iph3:tablet:cccccccccccccccc");
    // One legacy raw-UA desktop row (pre-migration data still in the DB).
    insert.run("/", "iph4:Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124 Safari/537.36");

    const routePath = require.resolve("./analytics");
    delete require.cache[routePath];
    const analyticsModule = require("./analytics") as typeof import("./analytics");
    const router = analyticsModule.default as any;

    const res = fakeRes();
    const req = fakeReq("/devices", { headers: { "x-admin-key": "analytics-devices-test-admin-key" } });
    await new Promise<void>((resolve) => {
      res.json = function (b: any) { this.body = b; resolve(); return this; };
      router.handle(req, res, () => resolve());
    });

    assertEq(res.statusCode, 200, "2a: GET /devices with a valid admin key -> 200");
    const devices: Array<{ device: string; count: number; visitors: number }> = res.body?.devices || [];
    const byDevice: Record<string, { count: number; visitors: number }> = Object.fromEntries(
      devices.map((d) => [d.device, { count: d.count, visitors: d.visitors }])
    );

    // The bug: desktop rows (both new-bucket-format AND legacy raw-UA) must
    // land under 'desktop', not silently disappear into 'unknown'.
    assertEq(byDevice.desktop?.visitors, 2, "2b: desktop bucket has both desktop sessions (1 new-format + 1 legacy raw-UA)");
    assertEq(byDevice.desktop?.count, 3, "2c: desktop bucket's page-view count is 2 (new-format session) + 1 (legacy session) = 3");
    assertEq(byDevice.mobile?.visitors, 1, "2d: mobile bucket has the one new-format mobile session");
    assertEq(byDevice.tablet?.visitors, 1, "2e: tablet bucket has the one new-format tablet session");
    assertEq(byDevice.unknown, undefined, "2f: 'unknown' is entirely absent (count 0, filtered out) — no row fell through to it");
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./analytics")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── analytics /devices endpoint (device classification: new bucketed format + legacy raw-UA) unit tests ──");
  runAnalyticsDevicesTests({ log: true }).then((r) => {
    console.log(`\nanalytics-devices: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
