/**
 * admin-agents-category-sanity-report.test.ts — unit tests for
 * GET /admin/agents/category-sanity-report (src/routes/admin-agents.ts).
 *
 * Criterion 4 of dev-request 2026-07-25-rfb-kvalitetsgate-og-retroskann:
 * a read-only, report-only admin endpoint that flags RFB producer rows
 * whose `categories` set looks implausibly broad (default threshold: >=5
 * categories), modeled on the real Skakke Røykeri incident (a smoked-fish
 * producer auto-tagged with categories meat,vegetables,fruit,bakery,honey,
 * fish — six categories spanning unrelated product classes). This endpoint
 * NEVER writes; it only surfaces candidates for manual review.
 *
 * Mirrors admin-agents-brreg-catalog-sweep.test.ts's harness: a fresh
 * in-memory SQLite DB via __setDbForTesting/__initSchemaForTesting, the
 * route module re-required fresh, and the handler grabbed straight off the
 * router's internal stack so it can be invoked directly — no real HTTP
 * server / socket round-trip.
 *
 * Covers:
 *   1. A row with 6 categories including bakery+fish (Skakke shape) ->
 *      flagged, includes_bakery_and_fish: true.
 *   2. A row with 3 categories -> NOT flagged.
 *   3. Boundary: exactly min_categories (default 5) -> flagged (>=, not >).
 *   4. Malformed/non-JSON categories text -> excluded from flagged, 200,
 *      no throw.
 *   5. includes_bakery_and_fish is false when a flagged row has neither
 *      bakery nor fish.
 *   6. vertical_id = 'dental' / 'experiences' with otherwise-qualifying
 *      categories -> excluded (RFB-only scope).
 *   7. role != 'producer' with otherwise-qualifying categories -> excluded.
 *   8. is_active = 0 with otherwise-qualifying categories -> excluded.
 *   9. ?min_categories=3 lowers the threshold and changes what's flagged.
 *   10. min_categories=0 or min_categories=abc -> 400 with documented shape.
 *   11. Missing/wrong X-Admin-Key -> 403 (requireAdmin gate).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/admin-agents-category-sanity-report.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runAdminAgentsCategorySanityReportTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

import Database from "better-sqlite3";

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

export async function runAdminAgentsCategorySanityReportTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
  const prevAdminKey = process.env.ADMIN_KEY;
  const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;

  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");

  const ADMIN_KEY = "category-sanity-test-key";

  function insertAgent(opts: {
    id: string;
    name: string;
    orgNr?: string | null;
    verticalId?: string | null;
    role?: string;
    isActive?: number;
    categories?: string | null;
  }): void {
    testDb.prepare(
      `INSERT INTO agents (
        id, name, description, provider, contact_email, url, role, api_key,
        org_nr, vertical_id, is_active, categories
      ) VALUES (?, ?, 't', 't', 'x@example.com', 'https://example.com', ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.name,
      opts.role ?? "producer",
      `key-${opts.id}`,
      opts.orgNr ?? null,
      opts.verticalId ?? "rfb",
      opts.isActive ?? 1,
      opts.categories === undefined ? "[]" : opts.categories,
    );
  }

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    process.env.ADMIN_KEY = ADMIN_KEY;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const routePath = require.resolve("../routes/admin-agents");
    delete require.cache[routePath];
    const adminAgentsModule = require("../routes/admin-agents") as typeof import("../routes/admin-agents");
    const routerModule = adminAgentsModule.default;

    const layer = routerModule.stack.find(
      (l: any) => l.route && l.route.path === "/category-sanity-report" && l.route.methods && l.route.methods.get,
    );
    assertTrue(!!layer, "setup: GET /category-sanity-report handler is registered on the router");
    const handler = layer.route.stack[0].handle;

    async function callEndpoint(opts: {
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {}): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      await handler({ headers: opts.headers || {}, query: opts.query || {} } as any, res as any);
      return { status: res.statusCode, body: res.body };
    }

    // ── (11) 403 without / with wrong X-Admin-Key ───────────────────────
    {
      const noKey = await callEndpoint({});
      assertEq(noKey.status, 403, "auth: GET without X-Admin-Key -> 403");
      const wrongKey = await callEndpoint({ headers: { "x-admin-key": "wrong" } });
      assertEq(wrongKey.status, 403, "auth: GET with wrong X-Admin-Key -> 403");
    }

    // ── Fixtures for (1)/(2)/(3)/(5)/(6)/(7)/(8)/(9) ────────────────────
    // (1) Skakke-shaped row: 6 categories incl. bakery + fish.
    insertAgent({
      id: "skakke-shaped",
      name: "Skakke Røykeri-lignende",
      orgNr: "910000001",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "bakery", "honey", "fish"]),
    });

    // (2) 3 categories -> not flagged.
    insertAgent({
      id: "three-cats",
      name: "Tre Kategorier Gård",
      orgNr: "910000002",
      categories: JSON.stringify(["meat", "vegetables", "fruit"]),
    });

    // (3) exactly 5 categories (default threshold) -> flagged (>=, not >).
    insertAgent({
      id: "exactly-five",
      name: "Fem Kategorier Gård",
      orgNr: "910000003",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "honey", "eggs"]),
    });

    // (4) malformed categories text -> excluded, no throw.
    insertAgent({
      id: "malformed-cats",
      name: "Rar Kategori Gård",
      orgNr: "910000004",
      categories: "{not valid json[",
    });

    // (5) flagged on count alone, neither bakery nor fish present.
    insertAgent({
      id: "flagged-no-pair",
      name: "Ingen Bakeri Fisk Gård",
      orgNr: "910000005",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "honey", "eggs", "dairy"]),
    });

    // (6) dental / experiences vertical, otherwise-qualifying categories.
    insertAgent({
      id: "dental-scope",
      name: "Tannlege Kategori",
      orgNr: "910000006",
      verticalId: "dental",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "bakery", "honey", "fish"]),
    });
    insertAgent({
      id: "experiences-scope",
      name: "Opplevelse Kategori",
      orgNr: "910000007",
      verticalId: "experiences",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "bakery", "honey", "fish"]),
    });

    // (7) role != 'producer', otherwise-qualifying categories.
    insertAgent({
      id: "non-producer",
      name: "Ikke Produsent",
      orgNr: "910000008",
      role: "consumer",
      categories: JSON.stringify(["meat", "vegetables", "fruit", "bakery", "honey", "fish"]),
    });

    // (8) is_active = 0, otherwise-qualifying categories.
    insertAgent({
      id: "inactive-row",
      name: "Inaktiv Gård",
      orgNr: "910000009",
      isActive: 0,
      categories: JSON.stringify(["meat", "vegetables", "fruit", "bakery", "honey", "fish"]),
    });

    // ── default threshold (min_categories=5) run ────────────────────────
    const r = await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY } });
    assertEq(r.status, 200, "default: GET with valid key -> 200");
    assertEq(r.body?.success, true, "default: success=true");
    assertEq(r.body?.min_categories, 5, "default: min_categories defaults to 5");

    const flaggedIds: string[] = (r.body?.flagged ?? []).map((f: any) => f.id);

    // (1)
    assertTrue(flaggedIds.includes("skakke-shaped"), "1: Skakke-shaped 6-category row is flagged");
    const skakkeRow = (r.body.flagged as any[]).find((f) => f.id === "skakke-shaped");
    assertEq(skakkeRow?.includes_bakery_and_fish, true, "1: Skakke-shaped row has includes_bakery_and_fish=true");
    assertEq(skakkeRow?.category_count, 6, "1: Skakke-shaped row reports category_count=6");
    assertEq(skakkeRow?.categories, ["meat", "vegetables", "fruit", "bakery", "honey", "fish"], "1: categories array passed through");

    // (2)
    assertTrue(!flaggedIds.includes("three-cats"), "2: 3-category row is NOT flagged");

    // (3) boundary
    assertTrue(flaggedIds.includes("exactly-five"), "3: exactly 5 categories IS flagged (>=, not >)");

    // (4) malformed -> excluded, no throw, request still 200.
    assertTrue(!flaggedIds.includes("malformed-cats"), "4: malformed categories row excluded from flagged");

    // (5) flagged on count alone, pair-flag false.
    assertTrue(flaggedIds.includes("flagged-no-pair"), "5a: flagged-no-pair row is flagged on count alone");
    const noPairRow = (r.body.flagged as any[]).find((f) => f.id === "flagged-no-pair");
    assertEq(noPairRow?.includes_bakery_and_fish, false, "5b: includes_bakery_and_fish=false when neither bakery nor fish present");

    // (6) vertical scoping
    assertTrue(!flaggedIds.includes("dental-scope"), "6a: dental-vertical row excluded (RFB-only scope)");
    assertTrue(!flaggedIds.includes("experiences-scope"), "6b: experiences-vertical row excluded (RFB-only scope)");

    // (7) role scoping
    assertTrue(!flaggedIds.includes("non-producer"), "7: non-producer role row excluded");

    // (8) is_active scoping
    assertTrue(!flaggedIds.includes("inactive-row"), "8: is_active=0 row excluded");

    // ordering: flagged should be ordered by category_count DESC
    const counts: number[] = (r.body.flagged as any[]).map((f) => f.category_count);
    const sortedDesc = [...counts].sort((a, b) => b - a);
    assertEq(counts, sortedDesc, "ordering: flagged is ordered by category_count DESC");

    // ── (9) custom ?min_categories=3 lowers the threshold ───────────────
    {
      const r3 = await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY }, query: { min_categories: "3" } });
      assertEq(r3.status, 200, "9a: min_categories=3 -> 200");
      assertEq(r3.body?.min_categories, 3, "9b: effective min_categories reported as 3");
      const ids3: string[] = (r3.body?.flagged ?? []).map((f: any) => f.id);
      assertTrue(ids3.includes("three-cats"), "9c: min_categories=3 flags the previously-excluded 3-category row");
    }

    // ── (10) invalid min_categories -> 400 ──────────────────────────────
    {
      const rZero = await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY }, query: { min_categories: "0" } });
      assertEq(rZero.status, 400, "10a: min_categories=0 -> 400");
      assertEq(rZero.body?.error, "invalid min_categories", "10b: min_categories=0 error shape");
      assertEq(rZero.body?.detail, "min_categories must be >= 1", "10c: min_categories=0 detail shape");

      const rAbc = await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY }, query: { min_categories: "abc" } });
      assertEq(rAbc.status, 400, "10d: min_categories=abc -> 400");
      assertEq(rAbc.body?.error, "invalid min_categories", "10e: min_categories=abc error shape");
    }

    // ── scanned_count sanity: equals rows examined (all RFB/producer/active
    //    rows inserted above, i.e. everything except dental/experiences/
    //    non-producer/inactive) ────────────────────────────────────────
    assertEq(r.body?.scanned_count, 5, "scanned_count: counts exactly the RFB-producer-active rows (skakke, three-cats, exactly-five, malformed, flagged-no-pair)");
    assertEq(r.body?.flagged_count, (r.body?.flagged ?? []).length, "flagged_count matches flagged.length");

    // ── read-only: this endpoint must never write ───────────────────────
    const beforeAll = testDb.prepare("SELECT id, categories, is_active FROM agents ORDER BY id").all();
    await callEndpoint({ headers: { "x-admin-key": ADMIN_KEY } });
    const afterAll = testDb.prepare("SELECT id, categories, is_active FROM agents ORDER BY id").all();
    assertEq(afterAll, beforeAll, "read-only: repeated GET calls make zero DB writes");
  } catch (err) {
    failed++;
    failures.push(`category-sanity-report: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
    if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
    if (prevDb) __setDbForTesting(prevDb);
    try { delete require.cache[require.resolve("../routes/admin-agents")]; } catch { /* ignore */ }
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/admin-agents-category-sanity-report.test.ts`
if (require.main === module) {
  console.log("── admin-agents category-sanity-report (dev-request 2026-07-25-rfb-kvalitetsgate-og-retroskann, criterion 4) unit tests ──");
  runAdminAgentsCategorySanityReportTests({ log: true }).then((r) => {
    console.log(`\ncategory-sanity-report: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
