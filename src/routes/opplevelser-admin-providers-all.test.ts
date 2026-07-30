/**
 * opplevelser-admin-providers-all.test.ts — unit tests for the full-catalog
 * enumeration route on src/routes/opplevelser.ts:
 *
 *   - GET /api/opplevelser/admin/providers/all
 *
 * dev-request 2026-07-30-experience-providers-enumerate: the routine's
 * persistent, git-committed blacklist ledger needs to be able to enumerate
 * EVERY experience_providers row — including rows with no hjemmeside at all,
 * which the existing GET .../providers/by-hjemmeside route (requires a
 * non-blank `pattern` and only matches rows with a hjemmeside) cannot
 * surface. This route is a plain, paginated, catalog_hidden-excluded SELECT
 * over the whole table.
 *
 * Setup mirrors opplevelser-admin-providers-hjemmeside.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercised directly against router.handle()
 * (X-Admin-Key via headers) — no real HTTP server / supertest needed.
 *
 * Covers:
 *   (1) basic enumeration across pages via limit+offset, total reflects the
 *       full (catalog_hidden-excluded) count
 *   (2) a catalog_hidden=1 row is present in the fixture but never appears
 *       in any page and never counts toward total
 *   (3) a row with hjemmeside=NULL IS included (the entire reason this
 *       route exists)
 *   (4) limit/offset clamping: out-of-range/negative/non-numeric values are
 *       clamped/defaulted rather than erroring or crashing
 *   (5) unauthenticated request -> 403 (requireAdmin)
 *   (6) response shape exactly matches the spec (field names, types)
 */

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
    path?: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    params?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "GET";
    const query = opts.query || {};
    const basePath = opts.path || "/";
    const qs = Object.keys(query).length
      ? "?" + Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req: any = {
      method,
      url: basePath + qs,
      originalUrl: basePath + qs,
      path: basePath,
      query,
      params: opts.params || {},
      headers: opts.headers || {},
      body: opts.body,
      get() { return undefined; },
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
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserAdminProvidersAllTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "admin-providers-all-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, catalog_hidden, updated_at,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @catalog_hidden, @updated_at,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // 5 ordinary visible providers, ids chosen so ORDER BY id ASC is
      // deterministic and distinct from insertion / navn order.
      insertProvider.run({ id: "p-01", navn: "Zulu Opplevelser AS", hjemmeside: "https://zulu.example.no", catalog_hidden: 0, updated_at: "2026-01-01T00:00:00.000Z" });
      insertProvider.run({ id: "p-02", navn: "Alpha Gård AS", hjemmeside: "https://alpha.example.no", catalog_hidden: 0, updated_at: "2026-01-01T00:00:00.000Z" });
      insertProvider.run({ id: "p-03", navn: "Uten Hjemmeside AS", hjemmeside: null, catalog_hidden: 0, updated_at: "2026-01-01T00:00:00.000Z" });
      insertProvider.run({ id: "p-04", navn: "Bravo Turer AS", hjemmeside: "https://bravo.example.no", catalog_hidden: 0, updated_at: "2026-01-01T00:00:00.000Z" });
      insertProvider.run({ id: "p-05", navn: "Charlie Camp AS", hjemmeside: "https://charlie.example.no", catalog_hidden: 0, updated_at: "2026-01-01T00:00:00.000Z" });
      // The booking-flyt-v1-style hidden synthetic test provider.
      insertProvider.run({ id: "p-06-hidden", navn: "Skjult Testleverandør AS", hjemmeside: "https://hidden.example.no", catalog_hidden: 1, updated_at: "2026-01-01T00:00:00.000Z" });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (5) 403 without X-Admin-Key ─────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
      });
      assertEq(noKey.status, 403, "1: GET /admin/providers/all without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "2: no-key response carries no providers payload");

      // ── (1) basic enumeration across pages, total reflects full count ──
      const page1 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", offset: "0" },
      });
      assertEq(page1.status, 200, "3: page1 -> 200");
      assertEq(page1.body.success, true, "4: page1 success:true");
      assertEq(page1.body.count, 2, "5: page1 count == 2 (limit respected)");
      assertEq(page1.body.total, 5, "6: total == 5 (6 rows minus the 1 catalog_hidden row)");
      assertEq(page1.body.offset, 0, "7: page1 echoes offset:0");
      assertEq(page1.body.limit, 2, "8: page1 echoes limit:2");
      assertEq(
        (page1.body.providers as any[]).map((p) => p.id),
        ["p-01", "p-02"],
        "9: page1 rows ordered by id ASC",
      );

      const page2 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", offset: "2" },
      });
      assertEq(
        (page2.body.providers as any[]).map((p) => p.id),
        ["p-03", "p-04"],
        "10: page2 (offset=2) continues deterministically by id",
      );

      const page3 = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "2", offset: "4" },
      });
      assertEq(
        (page3.body.providers as any[]).map((p) => p.id),
        ["p-05"],
        "11: page3 (offset=4) returns the final remaining row",
      );
      assertTrue(
        page3.body.offset + page3.body.count >= page3.body.total,
        "12: offset + count >= total signals end-of-pagination on the last page",
      );

      // ── (2) catalog_hidden=1 row never appears, never counted ──────────
      const allAtOnce = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "1000", offset: "0" },
      });
      assertEq(allAtOnce.body.total, 5, "13: total excludes the catalog_hidden=1 row");
      assertTrue(
        !(allAtOnce.body.providers as any[]).some((p) => p.id === "p-06-hidden"),
        "14: catalog_hidden=1 row never appears in results",
      );
      assertEq(allAtOnce.body.count, 5, "15: full single-page fetch returns exactly the 5 visible rows");

      // ── (3) hjemmeside=NULL row IS included ─────────────────────────────
      const noWebsiteRow = (allAtOnce.body.providers as any[]).find((p) => p.id === "p-03");
      assertTrue(!!noWebsiteRow, "16: the NULL-hjemmeside row IS present in the enumeration");
      assertEq(noWebsiteRow?.hjemmeside, null, "17: its hjemmeside field is null in the response");

      // ── (4) limit/offset clamping ────────────────────────────────────────
      const overLimit = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "5000" },
      });
      assertEq(overLimit.body.limit, 1000, "18: limit above max (1000) clamps to 1000");
      assertTrue(overLimit.body.providers.length <= 1000, "19: never returns more than the clamped max");

      const zeroLimit = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "0" },
      });
      assertEq(zeroLimit.body.limit, 1, "20: limit=0 clamps up to 1 (min)");

      const negativeLimit = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "-5" },
      });
      assertEq(negativeLimit.body.limit, 1, "21: negative limit clamps to 1 (min)");

      const nonNumericLimit = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "abc" },
      });
      assertEq(nonNumericLimit.body.limit, 200, "22: non-numeric limit defaults to 200");

      const noQuery = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
      });
      assertEq(noQuery.body.limit, 200, "23: missing limit defaults to 200");
      assertEq(noQuery.body.offset, 0, "24: missing offset defaults to 0");

      const negativeOffset = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { offset: "-10" },
      });
      assertEq(negativeOffset.body.offset, 0, "25: negative offset clamps/defaults to 0");

      const nonNumericOffset = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { offset: "not-a-number" },
      });
      assertEq(nonNumericOffset.body.offset, 0, "26: non-numeric offset defaults to 0");
      assertTrue(nonNumericOffset.status === 200, "27: non-numeric offset does not error/crash -> still 200");

      // ── (6) response shape exactly matches the spec ─────────────────────
      const shapeCheck = await callRoute(opplevelserRouter, {
        path: "/admin/providers/all",
        headers: { "x-admin-key": testKey },
        query: { limit: "3", offset: "0" },
      });
      assertEq(
        Object.keys(shapeCheck.body).sort(),
        ["count", "limit", "offset", "providers", "success", "total"].sort(),
        "28: top-level response carries exactly success/count/total/offset/limit/providers",
      );
      assertEq(typeof shapeCheck.body.success, "boolean", "29: success is a boolean");
      assertEq(typeof shapeCheck.body.count, "number", "30: count is a number");
      assertEq(typeof shapeCheck.body.total, "number", "31: total is a number");
      assertEq(typeof shapeCheck.body.offset, "number", "32: offset is a number");
      assertEq(typeof shapeCheck.body.limit, "number", "33: limit is a number");
      assertTrue(Array.isArray(shapeCheck.body.providers), "34: providers is an array");
      assertEq(
        Object.keys(shapeCheck.body.providers[0]).sort(),
        ["hjemmeside", "id", "navn", "vertical"].sort(),
        "35: each row carries ONLY id/navn/hjemmeside/vertical — no telefon/epost/adresse",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-admin-providers-all: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY; else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY; else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/routes/opplevelser-admin-providers-all.test.ts`
if (require.main === module) {
  runOpplevelserAdminProvidersAllTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
