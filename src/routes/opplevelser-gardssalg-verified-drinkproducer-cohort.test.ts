/**
 * opplevelser-gardssalg-verified-drinkproducer-cohort.test.ts — tests for
 * GET /admin/gardssalg-verified-drinkproducer-cohort (src/routes/opplevelser.ts),
 * added for dev-request
 * 2026-08-02-drikkesteder-hjemmeside-verifisert-kohort-berikelse, Step A
 * prerequisite: a read-only cohort of drink-producer providers
 * (producer_type IN DRINK_PRODUCER_TYPES — services/route-corridor-service.ts)
 * whose hjemmeside has already been ownership-verified (isHjemmesideVerified()
 * on field_provenance.hjemmeside_verification — fails closed on anything
 * short of a literal verified === true).
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers — this repo's convention, no HTTP server /
 * supertest needed) and fixture style (raw SQL INSERT against the in-memory
 * experiences DB).
 *
 * Covers:
 *   1. one row per DRINK_PRODUCER_TYPES member, each with a valid verified
 *      stamp -> all appear in cohort.
 *   2. a NON_DRINK_PRODUCER_TYPES row (bakeri) with the same verified stamp
 *      -> excluded from cohort AND does not count toward
 *      total_drink_producer_rows.
 *   3. producer_type NULL + rfb_seed_source='rfb-seed' + verified stamp ->
 *      excluded (the WHERE clause here is narrower than the usual gårdssalg
 *      membership clause; this row would qualify there but must not appear
 *      here).
 *   4. drink-producer rows excluded from cohort but counted in
 *      total_drink_producer_rows: (a) field_provenance null, (b) malformed
 *      JSON, (c) verified:false, (d) hjemmeside_verification missing
 *      entirely, (e) classification unverified/aggregator/missing_source
 *      with verified absent or false.
 *   5. visible (catalog_hidden 0 and null) vs hidden (catalog_hidden 1)
 *      verified rows -> correct per-row `visible` and correct
 *      summary.verified_visible/verified_hidden.
 *   6. response shape — success, summary (4 sub-fields), cohort row shape
 *      (id/name/producer_type/visible only, no leaked raw fields).
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg-verified-drinkproducer-cohort",
      originalUrl: "/admin/gardssalg-verified-drinkproducer-cohort",
      path: "/admin/gardssalg-verified-drinkproducer-cohort",
      query: {},
      headers: opts.headers || {},
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

const VERIFIED_STAMP = JSON.stringify({
  hjemmeside_verification: { verified: true, classification: "verified" },
});

export function runOpplevelserGardssalgVerifiedDrinkproducerCohortTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-verified-drinkproducer-cohort-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const routeCorridorPath = require.resolve("../services/route-corridor-service");
    const cachePaths = [dbFactoryPath, opplevelserPath, routeCorridorPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const { DRINK_PRODUCER_TYPES } = require("../services/route-corridor-service") as
        typeof import("../services/route-corridor-service");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, rfb_seed_source, producer_type,
            catalog_hidden, field_provenance,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @rfb_seed_source, @producer_type,
            @catalog_hidden, @field_provenance,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── 1. one row per DRINK_PRODUCER_TYPES member, all verified ────────
      const drinkTypes = Array.from(DRINK_PRODUCER_TYPES);
      for (const t of drinkTypes) {
        insertProvider.run({
          id: `prov-drink-${t}`,
          navn: `Drink Producer ${t}`,
          rfb_seed_source: null,
          producer_type: t,
          catalog_hidden: 0,
          field_provenance: VERIFIED_STAMP,
        });
      }

      // ── 2. non-drink-producer type (bakeri) with the SAME verified stamp ─
      insertProvider.run({
        id: "prov-bakeri",
        navn: "Bakeri AS",
        rfb_seed_source: null,
        producer_type: "bakeri",
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── 3. producer_type NULL + rfb_seed_source='rfb-seed' + verified stamp
      insertProvider.run({
        id: "prov-rfbseed-null-type",
        navn: "RFB Seed Null Type AS",
        rfb_seed_source: "rfb-seed",
        producer_type: null,
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });

      // ── 4. drink-producer rows excluded from cohort but counted in total ─
      // (a) field_provenance null
      insertProvider.run({
        id: "prov-fp-null",
        navn: "FP Null Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: null,
      });
      // (b) malformed JSON
      insertProvider.run({
        id: "prov-fp-malformed",
        navn: "FP Malformed Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: "{not valid json",
      });
      // (c) verified:false
      insertProvider.run({
        id: "prov-fp-false",
        navn: "FP False Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: JSON.stringify({
          hjemmeside_verification: { verified: false, classification: "unverified" },
        }),
      });
      // (d) hjemmeside_verification missing entirely
      insertProvider.run({
        id: "prov-fp-missing-key",
        navn: "FP Missing Key Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: JSON.stringify({ some_other_key: true }),
      });
      // (e) classification unverified/aggregator/missing_source, verified
      // absent or false
      insertProvider.run({
        id: "prov-fp-unverified",
        navn: "FP Unverified Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: JSON.stringify({
          hjemmeside_verification: { classification: "unverified" },
        }),
      });
      insertProvider.run({
        id: "prov-fp-aggregator",
        navn: "FP Aggregator Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: JSON.stringify({
          hjemmeside_verification: { verified: false, classification: "aggregator" },
        }),
      });
      insertProvider.run({
        id: "prov-fp-missing-source",
        navn: "FP Missing Source Bryggeri",
        rfb_seed_source: null,
        producer_type: "bryggeri",
        catalog_hidden: 0,
        field_provenance: JSON.stringify({
          hjemmeside_verification: { classification: "missing_source" },
        }),
      });

      // ── 5. visible/hidden verified rows ─────────────────────────────────
      insertProvider.run({
        id: "prov-visible-zero",
        navn: "Visible Zero Cideri",
        rfb_seed_source: null,
        producer_type: "cideri",
        catalog_hidden: 0,
        field_provenance: VERIFIED_STAMP,
      });
      insertProvider.run({
        id: "prov-visible-null",
        navn: "Visible Null Cideri",
        rfb_seed_source: null,
        producer_type: "cideri",
        catalog_hidden: null,
        field_provenance: VERIFIED_STAMP,
      });
      insertProvider.run({
        id: "prov-hidden",
        navn: "Hidden Cideri",
        rfb_seed_source: null,
        producer_type: "cideri",
        catalog_hidden: 1,
        field_provenance: VERIFIED_STAMP,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── auth gate ────────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "auth1: GET .../gardssalg-verified-drinkproducer-cohort without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.cohort, "auth2: no-key response carries no cohort payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "auth3: GET .../gardssalg-verified-drinkproducer-cohort with wrong X-Admin-Key -> 403");

      // ── happy path ───────────────────────────────────────────────────────
      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "happy1: GET .../gardssalg-verified-drinkproducer-cohort (valid key) -> 200");
      assertEq(ok.body.success, true, "happy2: success is true");
      assertTrue(Array.isArray(ok.body.cohort), "happy3: cohort is an array");

      const byId = (id: string) => (ok.body.cohort as any[]).find((r) => r.id === id);

      // ── 1. every DRINK_PRODUCER_TYPES member present ────────────────────
      for (const t of drinkTypes) {
        const row = byId(`prov-drink-${t}`);
        assertTrue(!!row, `case1: verified drink-producer row for type '${t}' present in cohort`);
        assertEq(row?.producer_type, t, `case1: verified '${t}' row carries correct producer_type`);
      }

      // ── 2. bakeri (non-drink-producer type) excluded ────────────────────
      assertTrue(!byId("prov-bakeri"), "case2: bakeri (non-drink-producer type) excluded from cohort");

      // ── 3. rfb-seed row with NULL producer_type excluded ────────────────
      assertTrue(
        !byId("prov-rfbseed-null-type"),
        "case3: rfb-seed row with producer_type NULL excluded (WHERE clause narrower than usual gårdssalg clause)",
      );

      // ── 4. all field_provenance edge cases excluded from cohort ─────────
      const excludedFpIds = [
        "prov-fp-null",
        "prov-fp-malformed",
        "prov-fp-false",
        "prov-fp-missing-key",
        "prov-fp-unverified",
        "prov-fp-aggregator",
        "prov-fp-missing-source",
      ];
      for (const id of excludedFpIds) {
        assertTrue(!byId(id), `case4: ${id} excluded from cohort (not verified)`);
      }

      // ── 5. visible/hidden ────────────────────────────────────────────────
      const visZero = byId("prov-visible-zero");
      assertTrue(!!visZero, "case5: catalog_hidden=0 verified row present");
      assertEq(visZero?.visible, true, "case5: catalog_hidden=0 -> visible true");

      const visNull = byId("prov-visible-null");
      assertTrue(!!visNull, "case5: catalog_hidden=null verified row present");
      assertEq(visNull?.visible, true, "case5: catalog_hidden=null -> visible true");

      const hidden = byId("prov-hidden");
      assertTrue(!!hidden, "case5: catalog_hidden=1 verified row present");
      assertEq(hidden?.visible, false, "case5: catalog_hidden=1 -> visible false");

      // ── total_drink_producer_rows: all rows matching producer_type IN
      // clause, before the verified filter — drink types fixtures (8) +
      // 7 field_provenance-edge-case bryggeri rows + 3 visible/hidden cideri
      // rows. Excludes bakeri (2) and the rfb-seed/NULL-type row (3).
      const expectedTotalDrinkProducerRows = drinkTypes.length + excludedFpIds.length + 3;
      assertEq(
        ok.body.summary.total_drink_producer_rows,
        expectedTotalDrinkProducerRows,
        "summary1: total_drink_producer_rows counts every producer_type-matched row, verified or not, excluding bakeri and rfb-seed/null-type",
      );

      // verified_visible: all drink-type fixtures (catalog_hidden=0) + the
      // two visible cideri fixtures = drinkTypes.length + 2.
      const expectedVerifiedVisible = drinkTypes.length + 2;
      assertEq(
        ok.body.summary.verified_visible,
        expectedVerifiedVisible,
        "summary2: verified_visible counts every verified, non-hidden row",
      );
      assertEq(ok.body.summary.verified_hidden, 1, "summary3: verified_hidden counts the single hidden verified row");
      assertEq(
        ok.body.summary.verified_total,
        ok.body.summary.verified_visible + ok.body.summary.verified_hidden,
        "summary4: verified_total == verified_visible + verified_hidden",
      );
      assertEq(
        ok.body.cohort.length,
        ok.body.summary.verified_total,
        "summary5: cohort.length == summary.verified_total",
      );

      // ── 6. response shape ───────────────────────────────────────────────
      assertTrue("success" in ok.body, "shape1: response has success");
      assertTrue("summary" in ok.body, "shape2: response has summary");
      assertTrue("cohort" in ok.body, "shape3: response has cohort");
      const summaryKeys = Object.keys(ok.body.summary).sort();
      assertEq(
        summaryKeys,
        ["total_drink_producer_rows", "verified_hidden", "verified_total", "verified_visible"],
        "shape4: summary has exactly the 4 documented sub-fields",
      );
      for (const row of ok.body.cohort as any[]) {
        const keys = Object.keys(row).sort();
        assertEq(keys, ["id", "name", "producer_type", "visible"], `shape5: cohort row '${row.id}' has exactly id/name/producer_type/visible`);
        assertTrue(!("field_provenance" in row), `shape6: cohort row '${row.id}' does not leak raw field_provenance`);
        assertTrue(!("epost" in row), `shape7: cohort row '${row.id}' does not leak epost`);
        assertTrue(!("telefon" in row), `shape8: cohort row '${row.id}' does not leak telefon`);
      }
      // name comes from the navn column
      assertEq(
        byId(`prov-drink-${drinkTypes[0]}`)?.name,
        `Drink Producer ${drinkTypes[0]}`,
        "shape9: cohort row 'name' comes from the navn column",
      );

      // ── zero-provider edge case ──────────────────────────────────────────
      expDb.prepare("DELETE FROM experience_providers").run();
      const empty = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(empty.status, 200, "empty1: zero-provider case still returns 200");
      assertEq(empty.body.cohort, [], "empty2: cohort is an empty array");
      assertEq(empty.body.summary.total_drink_producer_rows, 0, "empty3: total_drink_producer_rows is 0");
      assertEq(empty.body.summary.verified_visible, 0, "empty4: verified_visible is 0");
      assertEq(empty.body.summary.verified_hidden, 0, "empty5: verified_hidden is 0");
      assertEq(empty.body.summary.verified_total, 0, "empty6: verified_total is 0");
    } catch (err: any) {
      failed++;
      failures.push(
        "opplevelser-gardssalg-verified-drinkproducer-cohort: unexpected error: " +
          String(err?.stack || err?.message || err),
      );
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
      }
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-verified-drinkproducer-cohort.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgVerifiedDrinkproducerCohortTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
