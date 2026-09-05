/**
 * admin-run-dental-verifier.test.ts — tests the admin-key-gated canary
 * trigger route added for the dental verifier (src/services/dental-
 * verifier.ts's runDentalVerifierBatch, PR #795), which otherwise has no
 * way to be triggered in production.
 *
 * This route is a THIN wrapper: requireAdmin gate, batchSize clamp
 * ([1,50], default 20), call runDentalVerifierBatch({batchSize}), aggregate
 * the returned results[] into summary counts. The service's own internals
 * (Brreg check, website-ownership check, DB writes) were already covered by
 * PR #795's own test suite — this suite must NOT re-test those; it mocks
 * runDentalVerifierBatch entirely via this route's own
 * __setRunDentalVerifierBatchForTesting seam (mirrors this codebase's
 * existing convention of an injectable module-level seam — e.g. admin-
 * dental-hjemmeside-discovery.ts's __setDentalWdFetchForTesting, admin-
 * agents.ts's __setAgentsOrgNrBackfillFetchForTesting — rather than monkey-
 * patching the required service module's exports object directly), so no
 * real DB/network is ever touched.
 *
 * Router is exercised directly via router.handle() (no HTTP server /
 * supertest), same technique as admin-run-verifier-drain-observability.
 * test.ts (its POST handler is async too, so callRoute() below resolves on
 * res.json()/res.end() rather than assuming a synchronous return).
 *
 * Wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-run-dental-verifier.test.ts
 */

import type { DentalVerifierResult } from "../services/dental-verifier";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: any;
  },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      originalUrl: opts.url,
      query: opts.query || {},
      headers,
      body: opts.body,
      ip: "127.0.0.1",
      get(name: string) {
        return headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

const ADMIN_KEY = "test-admin-key-dental-verifier-canary";

// pick — like `??` but treats an explicitly-passed `null` override as
// intentional (e.g. website_ownership: null in a fixture) rather than
// falling through to the default the way `??` would (null IS nullish).
function pick<T>(overrides: Record<string, unknown>, key: string, fallback: T): T {
  return key in overrides ? (overrides[key] as T) : fallback;
}

function makeResult(overrides: Partial<DentalVerifierResult> & { id: string; navn: string }): DentalVerifierResult {
  return {
    id: overrides.id,
    navn: overrides.navn,
    brreg_status: pick(overrides, "brreg_status", "active" as any),
    website_ownership: pick(overrides, "website_ownership", "verified" as any),
    website_ownership_checked_at: pick(overrides, "website_ownership_checked_at", null),
    website_ownership_streak: pick(overrides, "website_ownership_streak", 0),
    specialists_verified: pick(overrides, "specialists_verified", false),
    new_verification_status: pick(overrides, "new_verification_status", "verified"),
    verifier_review_reason: pick(overrides, "verifier_review_reason", null),
    new_is_inactive: pick(overrides, "new_is_inactive", false),
    inactive_reason: pick(overrides, "inactive_reason", null),
    rich_field_count: pick(overrides, "rich_field_count", 3),
  };
}

export function runAdminRunDentalVerifierTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

    try {
      // ── 1. No admin key configured -> 503 ─────────────────────────────
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      // Fresh require so the route module's own getAdminKey() re-reads the
      // now-unset env vars (module isn't stateful across this, but keeps
      // the test self-contained/order-independent).
      delete require.cache[require.resolve("./admin-run-dental-verifier")];
      const unconfiguredRouter = require("./admin-run-dental-verifier").default;

      const resUnconfigured = await callRoute(unconfiguredRouter, {
        method: "POST",
        url: "/",
        body: {},
      });
      assertEq(resUnconfigured.status, 503, "1: no admin key configured -> 503");
      assertEq(resUnconfigured.body, { error: "Admin not configured" }, "1b: 503 body shape");

      const resUnconfiguredGet = await callRoute(unconfiguredRouter, { method: "GET", url: "/" });
      assertEq(resUnconfiguredGet.status, 503, "1c: GET / also 503 when unconfigured");

      // ── From here on, admin key IS configured ─────────────────────────
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete require.cache[require.resolve("./admin-run-dental-verifier")];
      const routeModule = require("./admin-run-dental-verifier");
      const router = routeModule.default;
      const setMock: (fn?: any) => void = routeModule.__setRunDentalVerifierBatchForTesting;

      // ── 2. Wrong/missing X-Admin-Key -> 403 ───────────────────────────
      const resNoKey = await callRoute(router, { method: "POST", url: "/", body: {} });
      assertEq(resNoKey.status, 403, "2: missing X-Admin-Key -> 403");
      assertEq(resNoKey.body, { error: "Krever X-Admin-Key header" }, "2b: 403 body shape");

      const resWrongKey = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": "totally-wrong-key" },
        body: {},
      });
      assertEq(resWrongKey.status, 403, "2c: wrong X-Admin-Key -> 403");

      // ── 3-5. batchSize clamping — capture what runDentalVerifierBatch
      // was actually called with. ────────────────────────────────────────
      let lastCallOpts: any = null;
      setMock(async (o: any) => {
        lastCallOpts = o;
        return { run_id: "run-clamp-test", started_at: "t0", finished_at: "t1", results: [] };
      });

      await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        body: { batchSize: 500 },
      });
      assertEq(lastCallOpts, { batchSize: 50 }, "3: batchSize=500 clamped to upper bound 50");

      lastCallOpts = null;
      await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        body: { batchSize: 0 },
      });
      assertEq(lastCallOpts, { batchSize: 20 }, "4a: batchSize=0 (falsy/unparseable) -> default 20");

      lastCallOpts = null;
      await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        body: {},
      });
      assertEq(lastCallOpts, { batchSize: 20 }, "4b: no body at all -> default 20 (NOT the service's own 200 default)");

      lastCallOpts = null;
      await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        body: { batchSize: -5 },
      });
      assertEq(lastCallOpts, { batchSize: 1 }, "5: batchSize=-5 clamped to lower bound 1");

      // ── 6. Successful call with a hand-built results[] fixture — real,
      // non-tautological aggregation assertions. ────────────────────────
      const fixtureResults: DentalVerifierResult[] = [
        makeResult({ id: "d1", navn: "Klinikk A", website_ownership: "verified", new_verification_status: "verified", brreg_status: "active" }),
        makeResult({ id: "d2", navn: "Klinikk B", website_ownership: "verified", new_verification_status: "verified", brreg_status: "active" }),
        makeResult({ id: "d3", navn: "Klinikk C", website_ownership: "unverified", new_verification_status: "needs_review", verifier_review_reason: "website_ownership_streak", brreg_status: "active" }),
        makeResult({ id: "d4", navn: "Klinikk D", website_ownership: "n/a", new_verification_status: "pending_verify", brreg_status: "active" }),
        makeResult({
          id: "d5",
          navn: "Klinikk E (nedlagt)",
          website_ownership: null,
          new_verification_status: "needs_review",
          verifier_review_reason: "brreg_dissolved",
          brreg_status: "dissolved",
          new_is_inactive: true,
          inactive_reason: "brreg_dissolved",
        }),
        makeResult({ id: "d6", navn: "Klinikk F", website_ownership: "unverified", new_verification_status: "unverified", brreg_status: "orgnr_not_found_or_unreachable" }),
      ];
      setMock(async (o: any) => {
        lastCallOpts = o;
        return { run_id: "run-fixture-6", started_at: "t0", finished_at: "t1", results: fixtureResults };
      });

      const resFixture = await callRoute(router, {
        method: "POST",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
        body: { batchSize: 10 },
      });

      assertEq(resFixture.status, 200, "6a: successful call -> 200");
      assertEq(resFixture.body.success, true, "6b: success:true");
      assertEq(resFixture.body.run_id, "run-fixture-6", "6c: run_id passed through from runDentalVerifierBatch's return");
      assertEq(resFixture.body.processed, 6, "6d: processed = results.length (6)");
      assertEq(
        resFixture.body.by_new_verification_status,
        { verified: 2, needs_review: 2, pending_verify: 1, unverified: 1 },
        "6e: by_new_verification_status counts exactly (hand-computed from fixture)",
      );
      assertEq(
        resFixture.body.website_ownership_summary,
        { verified: 2, unverified: 2, "n/a": 1, null: 1 },
        "6f: website_ownership_summary counts exactly, null key stringified as 'null'",
      );
      assertEq(
        resFixture.body.brreg_status_summary,
        { active: 4, dissolved: 1, orgnr_not_found_or_unreachable: 1 },
        "6g: brreg_status_summary counts exactly",
      );
      assertEq(resFixture.body.newly_inactive_count, 1, "6h: newly_inactive_count = 1 (only d5 has new_is_inactive:true)");
      assertEq(
        resFixture.body.review_reason_summary,
        { website_ownership_streak: 1, brreg_dissolved: 1 },
        "6i: review_reason_summary counts exactly, skipping null entries (d1,d2,d4,d6 excluded)",
      );

      // ── 7. GET / -> 200 with documented endpoint field ────────────────
      const resGet = await callRoute(router, {
        method: "GET",
        url: "/",
        headers: { "x-admin-key": ADMIN_KEY },
      });
      assertEq(resGet.status, 200, "7a: GET / with correct key -> 200");
      assertEq(resGet.body, { success: true, endpoint: "POST /admin/run-dental-verifier" }, "7b: GET / body matches documented shape exactly");

      // Restore the real implementation so no mock leaks past this suite.
      setMock(undefined);
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      // Re-require with real env restored so a later test in the same
      // process that pulls this module fresh doesn't see the unconfigured
      // module instance left over from case 1.
      delete require.cache[require.resolve("./admin-run-dental-verifier")];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAdminRunDentalVerifierTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
