/**
 * utm-capture.test.ts — slice B4 of dev-request 2026-09-24-ai-sok-bli-svaret-rfb.
 * Covers: sanitiser, trackPageView storing utm, rollup preserving utm
 * (page_view_daily untouched), breakdown blending raw + rolled-up days, and
 * contact_clicks.utm_source. Standalone: npx tsx src/services/utm-capture.test.ts
 */
import Database from "better-sqlite3";

export interface TestSummary { passed: number; failed: number; failures: string[] }

export async function runUtmCaptureTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      failures.push(`✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
    }
  }

  const { sanitizeUtmValue, extractUtmFromQuery, extractUtmFromUrl, UTM_MAX_LEN } =
    require("../utils/utm-capture") as typeof import("../utils/utm-capture");

  // ── pure helpers ──
  assertEq(sanitizeUtmValue("chatgpt"), "chatgpt", "sanitise: plain value kept");
  assertEq(sanitizeUtmValue("  a\u0000b\nc\t d "), "a b c d", "sanitise: control chars -> space, collapsed, trimmed");
  assertEq(sanitizeUtmValue("x".repeat(500))?.length, UTM_MAX_LEN, "sanitise: truncated to max length");
  assertEq(sanitizeUtmValue(""), null, "sanitise: empty -> null");
  assertEq(sanitizeUtmValue("\u0001\u0002"), null, "sanitise: only control chars -> null");
  assertEq(sanitizeUtmValue({ a: 1 }), null, "sanitise: object -> null");
  assertEq(sanitizeUtmValue(["mcp", "x"]), "mcp", "sanitise: array -> first element");
  assertEq(extractUtmFromQuery({ utm_source: "chatgpt", utm_medium: "mcp", foo: "bar" }),
    { utm_source: "chatgpt", utm_medium: "mcp", utm_campaign: null }, "extract: query object");
  assertEq(extractUtmFromQuery(undefined).utm_source, null, "extract: undefined query");
  assertEq(extractUtmFromUrl("https://rettfrabonden.com/produsent/x?utm_source=claude&utm_campaign=c1").utm_source,
    "claude", "extract: from referer URL");
  assertEq(extractUtmFromUrl("not a url ::").utm_source, null, "extract: garbage URL -> null");

  // ── DB-backed ──
  const { __setDbForTesting, __initSchemaForTesting, getDb } = require("../database/init") as
    typeof import("../database/init");
  const prevDb = (() => { try { return getDb(); } catch { return undefined; } })();
  const testDb = new Database(":memory:");
  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);

    const cols = (t: string) => (testDb.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    assertEq(["utm_source", "utm_medium", "utm_campaign"].every((c) => cols("analytics_page_views").includes(c)), true,
      "schema: analytics_page_views has utm columns");
    assertEq(cols("contact_clicks").includes("utm_source"), true, "schema: contact_clicks.utm_source");
    // Re-running schema init is idempotent (ALTER caught)
    __initSchemaForTesting(testDb as any);
    assertEq(cols("analytics_page_views").filter((c) => c === "utm_source").length, 1, "schema: re-init idempotent");

    const servicePath = require.resolve("../services/analytics-service");
    delete require.cache[servicePath];
    const { analyticsService } = require("../services/analytics-service") as typeof import("../services/analytics-service");

    const fakeReq = (query: any) => ({
      path: "/produsent/test-gard", query, hostname: "rettfrabonden.com", ip: "1.2.3.4",
      get: (h: string) => (h.toLowerCase() === "user-agent" ? "Mozilla/5.0 test" : undefined),
    }) as any;

    analyticsService.trackPageView(fakeReq({ utm_source: "chatgpt", utm_medium: "mcp", utm_campaign: "producer_profile\u0000" + "z".repeat(200) }));
    analyticsService.trackPageView(fakeReq({}));
    const rows = testDb.prepare("SELECT utm_source, utm_medium, utm_campaign FROM analytics_page_views ORDER BY id").all() as any[];
    assertEq(rows.length, 2, "trackPageView: two rows stored");
    assertEq(rows[0].utm_source, "chatgpt", "trackPageView: utm_source stored");
    assertEq(rows[0].utm_medium, "mcp", "trackPageView: utm_medium stored");
    assertEq(rows[0].utm_campaign.length <= UTM_MAX_LEN && !rows[0].utm_campaign.includes("\u0000"), true,
      "trackPageView: utm_campaign sanitised + truncated");
    assertEq(rows[1], { utm_source: null, utm_medium: null, utm_campaign: null }, "trackPageView: no utm -> NULLs");

    const bd = analyticsService.getUtmBreakdown(24);
    assertEq(bd.length, 1, "breakdown: only utm-tagged landings");
    assertEq(bd[0].utm_source + "/" + bd[0].utm_medium + "/" + bd[0].views, "chatgpt/mcp/1", "breakdown: values");

    // ── rollup ──
    const old = (d: number) => { const t = new Date(); t.setDate(t.getDate() - d); return t.toISOString().replace("T", " ").slice(0, 19); };
    testDb.exec("DELETE FROM analytics_page_views; DELETE FROM page_view_daily; DELETE FROM page_view_utm_daily;");
    const ins = testDb.prepare(
      `INSERT INTO analytics_page_views (path, source, session_id, created_at, utm_source, utm_medium, utm_campaign)
       VALUES (?, 'direct', ?, ?, ?, ?, ?)`);
    const oldTs = old(200);
    ins.run("/a", "s1:UA", oldTs, "chatgpt", "mcp", null);
    ins.run("/b", "s1:UA", oldTs, "chatgpt", "mcp", null);
    ins.run("/a", "s2:UA", oldTs, "chatgpt", "mcp", null);
    ins.run("/a", "s3:UA", oldTs, null, null, null);
    ins.run("/a", "s4:UA", oldTs, "claude", null, "c1");
    ins.run("/new", "s5:UA", old(1), "chatgpt", "mcp", null);
    const { rollupAndPrunePageViews } = require("../services/retention-service") as typeof import("../services/retention-service");
    const r = rollupAndPrunePageViews(90, 7, false);
    assertEq(r.rowsDeleted, 5, "rollup: old rows deleted");
    const pvd = (testDb.prepare("SELECT SUM(view_count) AS v FROM page_view_daily").get() as any).v;
    assertEq(pvd, 5, "rollup: page_view_daily totals unchanged by utm (all 5 rows counted)");
    const utmRows = testDb.prepare(
      "SELECT utm_source, utm_medium, utm_campaign, view_count, session_count FROM page_view_utm_daily ORDER BY utm_source").all() as any[];
    assertEq(utmRows, [
      { utm_source: "chatgpt", utm_medium: "mcp", utm_campaign: "", view_count: 3, session_count: 2 },
      { utm_source: "claude", utm_medium: "", utm_campaign: "c1", view_count: 1, session_count: 1 },
    ], "rollup: utm preserved per group, untagged rows excluded");
    // idempotent
    rollupAndPrunePageViews(90, 7, false);
    assertEq((testDb.prepare("SELECT SUM(view_count) AS v FROM page_view_utm_daily").get() as any).v, 4,
      "rollup: second run does not double-count");
    // breakdown over a long window blends rolled-up + raw without double counting
    const bd2 = analyticsService.getUtmBreakdown(24 * 400);
    const chat = bd2.find((x) => x.utm_source === "chatgpt" && x.utm_medium === "mcp");
    assertEq(chat?.views, 4, "breakdown: rolled-up (3) + raw (1) blended");

    // ── contact_clicks ──
    const { default: _unused } = { default: 0 }; void _unused;
    testDb.exec("INSERT INTO contact_clicks (agent_id, kind, utm_source) VALUES ('a1','email','chatgpt')");
    assertEq((testDb.prepare("SELECT utm_source FROM contact_clicks").get() as any).utm_source, "chatgpt",
      "contact_clicks: utm_source column writable");
  } finally {
    if (prevDb) __setDbForTesting(prevDb);
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  runUtmCaptureTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    if (s.failures.length) console.log(s.failures.join("\n"));
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
