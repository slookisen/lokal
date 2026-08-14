/**
 * analytics-adminkey.test.ts — regression test for the admin-key precedence
 * bug in src/routes/analytics.ts (dev-request
 * 2026-07-28-visibility-admin-key-naar-ikke-frem, re-scoped 2026-08-13 to
 * this file). Direct sibling of src/routes/crm.test.ts, which covers the
 * IDENTICAL bug/fix in crm.ts (fixed by PR #455's fleet-wide pattern) — this
 * file mirrors its structure and test-case coverage, adapted to analytics.ts.
 *
 * analytics.ts has TWO separate, textually-duplicated call sites that used
 * to compute `ANALYTICS_ADMIN_KEY || ADMIN_API_KEY`, never checking
 * ADMIN_KEY (the platform's real, actively-used admin secret) at all, with
 * ADMIN_API_KEY being a dead fallback (not set anywhere in production):
 *
 *   1. requireAdminAuth() — router.use()'d ahead of every route registered
 *      after it (GET /summary, /summary/:hours, /producers, /cities,
 *      /mcp-usage, /consumer-usage, /export/:table, POST /prune, /health,
 *      /visitors, /hourly, /pages, /devices, /conversations,
 *      /traffic-classification, /referrers, and the /ops/* endpoints).
 *      Exercised here via GET /summary as the representative route — same
 *      approach mcp-usage-logger.test.ts and analytics-retention-rollup.test.ts
 *      already take for other routes behind this same middleware.
 *   2. The inline check in GET /mark-owner — registered BEFORE
 *      router.use(requireAdminAuth), so it never runs through that
 *      middleware; it has its OWN independent auth check (key read from
 *      `?key=`, not the X-Admin-Key header) that had the identical bug and
 *      needed its own identical fix.
 *
 * Both are now `ADMIN_KEY || ANALYTICS_ADMIN_KEY` (ADMIN_KEY primary,
 * ANALYTICS_ADMIN_KEY legacy fallback, ADMIN_API_KEY dropped entirely) —
 * the same fleet-wide pattern as admin-affiliations.ts:44 and crm.ts.
 *
 * Covers, for EACH of the two call sites:
 *   1. A request with a valid ADMIN_KEY-sourced key succeeds — this is the
 *      bug: it used to fail (401 for /summary, 401 for /mark-owner) because
 *      ADMIN_KEY was never read.
 *   2. An invalid key still fails (401).
 *   3. ANALYTICS_ADMIN_KEY still works as the legacy fallback when ADMIN_KEY
 *      is unset.
 *   4. ADMIN_KEY takes precedence over a DIFFERENT, stale ANALYTICS_ADMIN_KEY
 *      (proves the precedence order, not just "either works").
 *   5. Neither key configured -> existing unchanged behavior, confirmed
 *      unchanged: 503 for requireAdminAuth (/summary), 401 for /mark-owner
 *      (the two call sites already had DIFFERENT "unconfigured" status codes
 *      before this fix, and that difference is preserved — this fix only
 *      touches key precedence, not the unconfigured-response shape).
 *   6. ADMIN_API_KEY alone (ADMIN_KEY/ANALYTICS_ADMIN_KEY both unset) no
 *      longer authenticates — the deliberate, in-scope behavior CHANGE
 *      (dropping the dead fallback).
 * Plus, for requireAdminAuth only (mirroring crm.test.ts's case 6): no
 * X-Admin-Key header at all -> 401.
 *
 * Run standalone: npx tsx src/routes/analytics-adminkey.test.ts
 * Wired into tests/test.ts via runAnalyticsAdminKeyTests().
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

export async function runAnalyticsAdminKeyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const Database = require("better-sqlite3");

  const prevDb = __peekDbForTesting();
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
  const prevAdminApiKey = process.env.ADMIN_API_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  try {
    __setDbForTesting(testDb);
    __initSchemaForTesting(testDb);

    // Fresh require each run so the module's env reads happen against this
    // test's own process.env mutations, not whatever ran before it.
    const routePath = require.resolve("./analytics");
    delete require.cache[routePath];

    async function call(
      url: string,
      headers: Record<string, string> = {},
      query: Record<string, string> = {},
    ): Promise<{ status: number; body: any }> {
      delete require.cache[routePath];
      const analyticsModule = require("./analytics") as typeof import("./analytics");
      const router = analyticsModule.default as any;
      const res = fakeRes();
      const req = fakeReq(url, { headers, query });
      // router.handle() runs the FULL stack — for /summary that's
      // requireAdminAuth (router.use()'d ahead of the route) then the
      // /summary handler; for /mark-owner it's just that route's own inline
      // check, since /mark-owner is registered BEFORE router.use(requireAdminAuth)
      // and never reaches it. Same pattern as crm.test.ts's direct
      // router.handle() calls.
      await new Promise<void>((resolve) => {
        res.json = function (b: any) { this.body = b; resolve(); return this; };
        router.handle(req, res, () => resolve()); // resolve on unmatched/fall-through too
      });
      return { status: res.statusCode, body: res.body };
    }

    // ═══════════════════════════════════════════════════════════════════
    // Call site 1: requireAdminAuth (router.use()'d middleware),
    // exercised via GET /summary. X-Admin-Key header.
    // ═══════════════════════════════════════════════════════════════════

    // ── (1) the bug itself: a valid ADMIN_KEY-sourced key must succeed ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_API_KEY;
      process.env.ADMIN_KEY = "analytics-auth-test-admin-key";
      const ok = await call("/summary", { "x-admin-key": "analytics-auth-test-admin-key" });
      assertEq(ok.status, 200, "1a: GET /summary with the real ADMIN_KEY -> 200 (was 401 before the fix)");
      assertEq(typeof ok.body?.timeframe, "string", "1b: …and returns a summary body shaped like getSummary()'s output");
    }

    // ── (2) an invalid key still gets 401 ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_KEY = "analytics-auth-test-admin-key";
      const wrong = await call("/summary", { "x-admin-key": "not-the-right-key" });
      assertEq(wrong.status, 401, "2a: GET /summary with a wrong X-Admin-Key -> 401");
      assertEq(wrong.body?.error, "Unauthorized", "2b: …with the Unauthorized error body");
    }

    // ── (3) ANALYTICS_ADMIN_KEY still works as the legacy fallback ──
    {
      delete process.env.ADMIN_KEY;
      process.env.ANALYTICS_ADMIN_KEY = "analytics-auth-legacy-key";
      const ok = await call("/summary", { "x-admin-key": "analytics-auth-legacy-key" });
      assertEq(ok.status, 200, "3a: GET /summary with ANALYTICS_ADMIN_KEY (ADMIN_KEY unset) -> 200, fallback preserved");
    }

    // ── (4) ADMIN_KEY takes PRECEDENCE over a different ANALYTICS_ADMIN_KEY ──
    {
      process.env.ADMIN_KEY = "analytics-auth-primary-key";
      process.env.ANALYTICS_ADMIN_KEY = "analytics-auth-stale-fallback-key";
      const withPrimary = await call("/summary", { "x-admin-key": "analytics-auth-primary-key" });
      assertEq(withPrimary.status, 200, "4a: the ADMIN_KEY value authenticates when both env vars are set");
      const withStaleFallback = await call("/summary", { "x-admin-key": "analytics-auth-stale-fallback-key" });
      assertEq(withStaleFallback.status, 401, "4b: …and the ANALYTICS_ADMIN_KEY value alone does NOT, once ADMIN_KEY is set — proves precedence, not just 'either works'");
    }

    // ── (5) neither key configured -> 503, unchanged ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const unconfigured = await call("/summary", { "x-admin-key": "anything" });
      assertEq(unconfigured.status, 503, "5a: no ADMIN_KEY/ANALYTICS_ADMIN_KEY configured at all -> 503 (requireAdminAuth's unconfigured response, unchanged)");
    }

    // ── (6) missing header entirely -> 401 ──
    {
      process.env.ADMIN_KEY = "analytics-auth-test-admin-key";
      delete process.env.ANALYTICS_ADMIN_KEY;
      const noHeader = await call("/summary", {});
      assertEq(noHeader.status, 401, "6a: GET /summary with no X-Admin-Key header at all -> 401");
    }

    // ── (7) ADMIN_API_KEY alone (dead fallback) no longer authenticates ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_API_KEY = "analytics-auth-old-admin-api-key";
      const withOldFallback = await call("/summary", { "x-admin-key": "analytics-auth-old-admin-api-key" });
      assertEq(withOldFallback.status, 503, "7a: GET /summary with only ADMIN_API_KEY set (dropped fallback) -> 503, same as fully unconfigured — the deliberate behavior change");
    }

    // ═══════════════════════════════════════════════════════════════════
    // Call site 2: GET /mark-owner's own inline check (never reaches
    // requireAdminAuth). Key read from ?key=, not the X-Admin-Key header.
    // ═══════════════════════════════════════════════════════════════════

    // ── (1) the bug itself: a valid ADMIN_KEY-sourced key must succeed ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      delete process.env.ADMIN_API_KEY;
      process.env.ADMIN_KEY = "analytics-markowner-test-admin-key";
      const ok = await call("/mark-owner", {}, { key: "analytics-markowner-test-admin-key" });
      assertEq(ok.status, 200, "8a: GET /mark-owner with the real ADMIN_KEY -> 200 (was 401 before the fix)");
      assertEq(ok.body?.success, true, "8b: …and returns the success body");
    }

    // ── (2) an invalid key still gets 401 ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_KEY = "analytics-markowner-test-admin-key";
      const wrong = await call("/mark-owner", {}, { key: "not-the-right-key" });
      assertEq(wrong.status, 401, "9a: GET /mark-owner with a wrong ?key= -> 401");
      assertEq(wrong.body?.error, "Ugyldig nøkkel", "9b: …with the Ugyldig nøkkel error body");
    }

    // ── (3) ANALYTICS_ADMIN_KEY still works as the legacy fallback ──
    {
      delete process.env.ADMIN_KEY;
      process.env.ANALYTICS_ADMIN_KEY = "analytics-markowner-legacy-key";
      const ok = await call("/mark-owner", {}, { key: "analytics-markowner-legacy-key" });
      assertEq(ok.status, 200, "10a: GET /mark-owner with ANALYTICS_ADMIN_KEY (ADMIN_KEY unset) -> 200, fallback preserved");
    }

    // ── (4) ADMIN_KEY takes PRECEDENCE over a different ANALYTICS_ADMIN_KEY ──
    {
      process.env.ADMIN_KEY = "analytics-markowner-primary-key";
      process.env.ANALYTICS_ADMIN_KEY = "analytics-markowner-stale-fallback-key";
      const withPrimary = await call("/mark-owner", {}, { key: "analytics-markowner-primary-key" });
      assertEq(withPrimary.status, 200, "11a: the ADMIN_KEY value authenticates when both env vars are set");
      const withStaleFallback = await call("/mark-owner", {}, { key: "analytics-markowner-stale-fallback-key" });
      assertEq(withStaleFallback.status, 401, "11b: …and the ANALYTICS_ADMIN_KEY value alone does NOT, once ADMIN_KEY is set — proves precedence, not just 'either works'");
    }

    // ── (5) neither key configured -> 401, unchanged (mark-owner's own
    //        pre-existing "unconfigured" status, DIFFERENT from
    //        requireAdminAuth's 503 — this fix doesn't touch that) ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const unconfigured = await call("/mark-owner", {}, { key: "anything" });
      assertEq(unconfigured.status, 401, "12a: no ADMIN_KEY/ANALYTICS_ADMIN_KEY configured at all -> 401 (mark-owner's unconfigured response, unchanged)");
    }

    // ── (6) ADMIN_API_KEY alone (dead fallback) no longer authenticates ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_API_KEY = "analytics-markowner-old-admin-api-key";
      const withOldFallback = await call("/mark-owner", {}, { key: "analytics-markowner-old-admin-api-key" });
      assertEq(withOldFallback.status, 401, "13a: GET /mark-owner with only ADMIN_API_KEY set (dropped fallback) -> 401 — the deliberate behavior change");
    }
  } catch (err) {
    failed++;
    failures.push(`analytics-auth: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevAdminApiKey === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = prevAdminApiKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./analytics")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── analytics (admin auth: ADMIN_KEY primary / ANALYTICS_ADMIN_KEY fallback, ADMIN_API_KEY dropped) unit tests ──");
  runAnalyticsAdminKeyTests({ log: true }).then((r) => {
    console.log(`\nanalytics-auth: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
