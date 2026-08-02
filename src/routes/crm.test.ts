/**
 * crm.test.ts — regression test for requireAdminAuth() in src/routes/crm.ts.
 *
 * dev-request 2026-08-02-crm-summary-401-auth. GET /admin/crm/summary (and
 * every other route behind this file's admin auth — it's mounted via
 * `router.use(requireAdminAuth)`) was returning 401 for the platform's real
 * $ADMIN_KEY, even though that exact key authenticates /health and
 * /admin/runs successfully in the same request cycle. Root cause: this
 * file's requireAdminAuth() checked `ANALYTICS_ADMIN_KEY || ADMIN_API_KEY`
 * instead of the fleet-wide `ADMIN_KEY || ANALYTICS_ADMIN_KEY` pattern every
 * other admin route uses (e.g. admin-affiliations.ts, admin-hanen.ts,
 * admin-dental-hjemmeside-cleanup.ts) — ADMIN_KEY was never checked at all,
 * and ADMIN_API_KEY does not appear to be set anywhere in production.
 *
 * Covers:
 *   1. A request with a valid ADMIN_KEY-sourced key succeeds (200) — this is
 *      the bug: it used to 401 because ADMIN_KEY was never read.
 *   2. A request with an invalid key still gets 401.
 *   3. ANALYTICS_ADMIN_KEY still works as the legacy fallback when ADMIN_KEY
 *      is unset (kept, matching the fleet-wide pattern's own fallback).
 *   4. ADMIN_KEY takes precedence over a DIFFERENT stale ANALYTICS_ADMIN_KEY
 *      (proves the precedence order, not just "either works").
 *   5. Neither key configured -> 503, unchanged behavior.
 *   6. No X-Admin-Key header at all -> 401, unchanged behavior.
 *
 * Run standalone: npx tsx src/routes/crm.test.ts
 * Wired into tests/test.ts via runCrmAuthTests().
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
  return r;
}

function fakeReq(headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url: "/summary",
    query: {},
    headers,
    get(name: string) { return this.headers[name.toLowerCase()]; },
  };
}

export async function runCrmAuthTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  try {
    __setDbForTesting(testDb);
    __initSchemaForTesting(testDb);

    // Fresh require each run so the module's env reads happen against this
    // test's own process.env mutations, not whatever ran before it.
    const routePath = require.resolve("./crm");
    delete require.cache[routePath];

    async function call(headers: Record<string, string>): Promise<{ status: number; body: any }> {
      delete require.cache[routePath];
      const crmModule = require("./crm") as typeof import("./crm");
      const router = crmModule.default as any;
      const res = fakeRes();
      const req: any = { method: "GET", url: "/summary", query: {}, headers, get(n: string) { return this.headers[n.toLowerCase()]; } };
      // router.handle() runs the FULL stack — requireAdminAuth (router.use()'d
      // ahead of the route), then the /summary handler — exactly as Express
      // would for a real request. Same pattern as crm-vertical.test.ts /
      // crm-platform-identity.test.ts's direct router.handle() calls.
      await new Promise<void>((resolve) => {
        res.json = function (b: any) { this.body = b; resolve(); return this; };
        router.handle(req, res, () => resolve()); // resolve on unmatched/fall-through too
      });
      return { status: res.statusCode, body: res.body };
    }

    // ── (1) the bug itself: a valid ADMIN_KEY-sourced key must succeed ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_KEY = "crm-auth-test-admin-key";
      const ok = await call({ "x-admin-key": "crm-auth-test-admin-key" });
      assertEq(ok.status, 200, "1a: GET /summary with the real ADMIN_KEY -> 200 (was 401 before the fix)");
      assertEq(typeof ok.body?.vertical, "string", "1b: …and returns a summary body shaped like getDashboardSummary()'s output");
    }

    // ── (2) an invalid key still gets 401 ──
    {
      delete process.env.ANALYTICS_ADMIN_KEY;
      process.env.ADMIN_KEY = "crm-auth-test-admin-key";
      const wrong = await call({ "x-admin-key": "not-the-right-key" });
      assertEq(wrong.status, 401, "2a: GET /summary with a wrong X-Admin-Key -> 401");
      assertEq(wrong.body?.error, "Unauthorized", "2b: …with the Unauthorized error body");
    }

    // ── (3) ANALYTICS_ADMIN_KEY still works as the legacy fallback ──
    {
      delete process.env.ADMIN_KEY;
      process.env.ANALYTICS_ADMIN_KEY = "crm-auth-legacy-key";
      const ok = await call({ "x-admin-key": "crm-auth-legacy-key" });
      assertEq(ok.status, 200, "3a: GET /summary with ANALYTICS_ADMIN_KEY (ADMIN_KEY unset) -> 200, fallback preserved");
    }

    // ── (4) ADMIN_KEY takes PRECEDENCE over a different ANALYTICS_ADMIN_KEY ──
    {
      process.env.ADMIN_KEY = "crm-auth-primary-key";
      process.env.ANALYTICS_ADMIN_KEY = "crm-auth-stale-fallback-key";
      const withPrimary = await call({ "x-admin-key": "crm-auth-primary-key" });
      assertEq(withPrimary.status, 200, "4a: the ADMIN_KEY value authenticates when both env vars are set");
      const withStaleFallback = await call({ "x-admin-key": "crm-auth-stale-fallback-key" });
      assertEq(withStaleFallback.status, 401, "4b: …and the ANALYTICS_ADMIN_KEY value alone does NOT, once ADMIN_KEY is set — proves precedence, not just 'either works'");
    }

    // ── (5) neither key configured -> 503 ──
    {
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const unconfigured = await call({ "x-admin-key": "anything" });
      assertEq(unconfigured.status, 503, "5a: no ADMIN_KEY/ANALYTICS_ADMIN_KEY configured at all -> 503");
    }

    // ── (6) missing header entirely -> 401 ──
    {
      process.env.ADMIN_KEY = "crm-auth-test-admin-key";
      delete process.env.ANALYTICS_ADMIN_KEY;
      const noHeader = await call({});
      assertEq(noHeader.status, 401, "6a: GET /summary with no X-Admin-Key header at all -> 401");
    }
  } catch (err) {
    failed++;
    failures.push(`crm-auth: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("./crm")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── crm (admin auth: ADMIN_KEY primary / ANALYTICS_ADMIN_KEY fallback) unit tests ──");
  runCrmAuthTests({ log: true }).then((r) => {
    console.log(`\ncrm-auth: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
