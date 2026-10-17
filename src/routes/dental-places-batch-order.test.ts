/**
 * dental-places-batch-order.test.ts — selection ORDER of
 * POST /api/tannlege/admin/google-places-batch auto-select (src/routes/dental.ts).
 *
 * Bug: with the old ORDER BY (missing-homepage, missing-fields, navn) an
 * expired 90-day no-retry window let old A-named retries sort before
 * never-attempted rows with later names (e.g. 'Åsane'), starving them.
 * Fix: never-attempted rows (places_attempted_at IS NULL) come first; within
 * that class the old keys + navn; retries sort oldest places_attempted_at first.
 *
 * Setup mirrors dental-agents-recently-enriched.test.ts (in-memory dental DB,
 * router.handle()). global.fetch is mocked (no network); write:false so no DB
 * writes. adresse/telefon are filled on every row so the Brreg-first lookup
 * is skipped; opening_hours is NULL so rows stay in the auto-select pool.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callBatch(router: any, headers: Record<string, string>, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: "/admin/google-places-batch",
      originalUrl: "/admin/google-places-batch",
      path: "/admin/google-places-batch",
      query: {},
      body,
      headers,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runDentalPlacesBatchOrderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevDentalPath = process.env.DENTAL_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const prevPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
    const prevFetch = (globalThis as any).fetch;
    const testKey = process.env.ADMIN_KEY || "dental-places-order-test-key";
    process.env.DENTAL_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const dentalPath = require.resolve("./dental");
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules([dbFactoryPath, dentalPath]);

    try {
      // No network: Google answers "no places" for every query.
      (globalThis as any).fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ places: [] }),
        text: async () => "{}",
      });

      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("dental");

      const ins = db.prepare(
        `INSERT INTO dental_agents (id, navn, adresse, telefon, hjemmeside, places_attempted_at)
         VALUES (@id, @navn, 'Storgata 1', '12345678', @hjemmeside, @places_attempted_at)`
      );
      const HP = "https://x.example.no";
      ins.run({ id: "n-aasane", navn: "Åsane Tannklinikk", hjemmeside: HP, places_attempted_at: null });
      ins.run({ id: "n-bergen", navn: "Bergen Tann", hjemmeside: HP, places_attempted_at: null });
      ins.run({ id: "n-zeta-nohp", navn: "Zeta Tann", hjemmeside: "", places_attempted_at: null });
      ins.run({ id: "r-zz-old", navn: "Zz Retry Gammel", hjemmeside: HP, places_attempted_at: daysAgoIso(200) });
      ins.run({ id: "r-aa-new", navn: "Aa Retry Nyere", hjemmeside: HP, places_attempted_at: daysAgoIso(100) });
      ins.run({ id: "r-in-window", navn: "Aaa Innen Vindu", hjemmeside: "", places_attempted_at: daysAgoIso(10) });
      ins.run({ id: "r-nohp-old", navn: "Aaaa Retry Uten Hjemmeside", hjemmeside: "", places_attempted_at: daysAgoIso(150) });

      const router = (require("./dental") as typeof import("./dental")).default as any;
      const headers = { "x-admin-key": testKey };
      const idsOf = (r: { body: any }) => (r.body?.data?.results ?? []).map((x: any) => x.agentId);

      // a) full order: never-attempted first (missing homepage, then navn),
      //    then retries oldest places_attempted_at first; in-window row excluded.
      const all = await callBatch(router, headers, { limit: 10, write: false });
      assertEq(all.status, 200, "a1: auto-select dry-run -> 200");
      assertEq(
        idsOf(all),
        ["n-zeta-nohp", "n-bergen", "n-aasane", "r-nohp-old", "r-zz-old", "r-aa-new"],
        "a2: never-attempted (missing-homepage, then navn) before retries (oldest first); in-window row excluded",
      );

      // b) limit=1 with Å-name never-attempted vs 90+ day-old A-name retry
      db.prepare(`DELETE FROM dental_agents WHERE id IN ('n-zeta-nohp','n-bergen')`).run();
      const one = await callBatch(router, headers, { limit: 1, write: false });
      assertEq(idsOf(one), ["n-aasane"], "b1: limit=1 selects never-attempted 'Åsane' before 90+d-old 'Aa' retry");
    } catch (err: any) {
      failed++;
      failures.push("dental-places-batch-order: unexpected error: " + String(err?.stack || err));
    } finally {
      (globalThis as any).fetch = prevFetch;
      try { (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting(); } catch {}
      restoreModuleCache();
      const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      restore("DENTAL_DB_PATH", prevDentalPath);
      restore("ADMIN_KEY", prevAdminKey);
      restore("ANALYTICS_ADMIN_KEY", prevAnalyticsAdminKey);
      restore("GOOGLE_PLACES_API_KEY", prevPlacesKey);
    }
    return { passed, failed, failures };
  })();
}
