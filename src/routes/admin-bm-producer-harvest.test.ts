/**
 * admin-bm-producer-harvest.test.ts — dev-request
 * 2026-08-14-bm-fullhoest-katalogbred, slice 2.
 *
 * Covers AC5-AC6 from the slice spec:
 *   AC5 — GET /admin/bm-producer-harvest?dry_run=false → 501, and NOTHING
 *         else happens: zero fetch calls, zero DB queries. Proven by
 *         installing a trap fetchImpl and a trap db (both throw if called)
 *         and asserting the route still returns 501 cleanly.
 *   AC6 — this file itself only reaches the route via router.handle()
 *         against injected req/res (mirrors admin-runs-lock.test.ts /
 *         admin-run-verifier-drain-observability.test.ts) — no real network,
 *         no real DB file.
 *
 * Wired into tests/test.ts.
 * Standalone: npx tsx src/routes/admin-bm-producer-harvest.test.ts
 */

import * as initMod from "../database/init";
import router from "./admin-bm-producer-harvest";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
  ended: boolean;
}

function callRoute(
  routerInstance: any,
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
        resolve({ status: this.statusCode, body: payload, ended: true });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined, ended: true });
        return this;
      },
    };
    routerInstance.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) }, ended: true });
      else resolve({ status: 0, body: undefined, ended: false });
    });
  });
}

const ADMIN_KEY = "test-admin-key-bm-producer-harvest";

export function runAdminBmProducerHarvestTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevFetch = globalThis.fetch;
    // getDb() (not __peekDbForTesting()) so prevDb is always a real handle
    // to restore in `finally` — mirrors admin-run-verifier-drain-
    // observability.test.ts's isolation contract for the shared singleton.
    const prevDb = initMod.getDb();

    let fetchCalls = 0;
    let dbPrepareCalls = 0;

    try {
      process.env.ADMIN_KEY = ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;

      // Trap fetch: any call at all is a failure of the "zero work" claim.
      (globalThis as any).fetch = async (...args: any[]) => {
        fetchCalls++;
        throw new Error("dry_run=false must not perform any fetch");
      };

      // Trap DB: any db.prepare() call at all is a failure of the
      // "zero DB access" claim (stricter than "zero writes" — the route
      // must not even READ in this branch).
      const trapDb: any = {
        prepare() {
          dbPrepareCalls++;
          throw new Error("dry_run=false must not touch the database");
        },
      };
      initMod.__setDbForTesting(trapDb);

      // ── AC5: dry_run=false → 501, and truly nothing else happened ──────
      const res = await callRoute(router, {
        method: "GET",
        url: "/",
        query: { dry_run: "false" },
        headers: { "x-admin-key": ADMIN_KEY },
      });

      assertEq(res.status, 501, "ac5: dry_run=false returns 501");
      assertEq(
        res.body?.error,
        "apply mode not yet implemented — see dev-request 2026-08-14-bm-fullhoest-katalogbred slice 3",
        "ac5: exact stub error message",
      );
      assertEq(fetchCalls, 0, "ac5: zero fetch calls in the dry_run=false branch");
      assertEq(dbPrepareCalls, 0, "ac5: zero db.prepare calls in the dry_run=false branch");

      // ── AC5b: the 501 stub still requires a valid admin key first ──────
      fetchCalls = 0;
      dbPrepareCalls = 0;
      const resNoKey = await callRoute(router, {
        method: "GET",
        url: "/",
        query: { dry_run: "false" },
        headers: {},
      });
      assertEq(resNoKey.status, 403, "ac5b: dry_run=false with a missing/wrong X-Admin-Key still 403s (auth gate runs first)");
      assertEq(fetchCalls, 0, "ac5b: still zero fetch calls when auth fails");
      assertEq(dbPrepareCalls, 0, "ac5b: still zero db calls when auth fails");

      // ── AC5c: admin key unconfigured entirely → 503, before the stub ───
      delete process.env.ADMIN_KEY;
      delete process.env.ANALYTICS_ADMIN_KEY;
      const resUnconfigured = await callRoute(router, {
        method: "GET",
        url: "/",
        query: { dry_run: "false" },
      });
      assertEq(resUnconfigured.status, 503, "ac5c: admin key unconfigured yields 503, not the 501 stub");
    } finally {
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      (globalThis as any).fetch = prevFetch;
      initMod.__setDbForTesting(prevDb);
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/admin-bm-producer-harvest.test.ts`
if (require.main === module) {
  (async () => {
    console.log("── admin-bm-producer-harvest ──");
    const r = await runAdminBmProducerHarvestTests({ log: true });
    console.log(`\n${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })();
}
