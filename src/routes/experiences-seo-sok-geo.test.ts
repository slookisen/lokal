/**
 * experiences-seo-sok-geo.test.ts — unit tests for the PURE helper backing
 * /sok's distance-sort toggle (dev-request 2026-07-04-opplevagent-naer-meg-
 * geosok, item 3: «Nær meg» on /sok), plus a DB-backed regression test for
 * the out-of-range lat/lng bug fixed in this same file's /sok handler.
 *
 * buildSortToggleUrl() takes a plain string-keyed record (not a Request), so
 * it's testable without booting an Express app or a DB.
 *
 * runExperiencesSeoSokGeoRegressionTests() covers the bug: /sok used to run
 * the q/tag search and the geo (discoverExperiences()) lookup in ONE shared
 * try/catch. lat/lng were only finiteness-checked (Number.isFinite), never
 * range-validated against the -90..90 / -180..180 bounds discoverExperiences()
 * enforces via DiscoverFilterSchema (src/services/experience-store.ts). An
 * out-of-range lat/lng (e.g. ?lat=999) reached discoverExperiences(), which
 * threw a ZodError, and the shared catch discarded the ALREADY-successful
 * q/tag rows — turning a real search with matches into a false "no results"
 * page. The fix range-validates lat/lng up front (degrading silently to "no
 * geo origin" instead of throwing) and splits the try/catch so a geo-side
 * failure can never wipe rows already computed from q/tags.
 *
 * Three ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-sok-geo.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoSokGeoTests() (pure, sync) and
 *      runExperiencesSeoSokGeoRegressionTests() (DB-backed, async) and folds
 *      their pass/fail counts into the `npm test` summary.
 */

import { buildSortToggleUrl } from "./experiences-seo";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperiencesSeoSokGeoTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── buildSortToggleUrl: preserves every other param, adds/removes `sort` ─
  assertEq(
    buildSortToggleUrl({ lat: "69.65", lng: "18.95" }, true),
    "/sok?lat=69.65&lng=18.95&sort=distance",
    "activates sort=distance while preserving lat/lng"
  );
  assertEq(
    buildSortToggleUrl({ lat: "69.65", lng: "18.95", sort: "distance" }, false),
    "/sok?lat=69.65&lng=18.95",
    "deactivating drops sort=distance, keeps everything else"
  );
  assertEq(
    buildSortToggleUrl({ q: "hvalsafari", familievennlig: "1", lat: "69.65", lng: "18.95", radius_km: "50" }, true),
    "/sok?q=hvalsafari&familievennlig=1&lat=69.65&lng=18.95&radius_km=50&sort=distance",
    "preserves q, tag filters, lat/lng and radius_km together"
  );
  assertEq(buildSortToggleUrl({}, true), "/sok?sort=distance", "empty query + activate → just sort=distance");
  assertEq(buildSortToggleUrl({}, false), "/sok", "empty query + deactivate → bare /sok (no trailing '?')");
  assertEq(
    buildSortToggleUrl({ q: "", lat: "69.65" }, false),
    "/sok?lat=69.65",
    "drops empty-string params (e.g. an unused q='') rather than emitting q="
  );
  assertEq(
    buildSortToggleUrl({ sted: "Tromsø", radius_km: "50" }, true),
    "/sok?sted=" + encodeURIComponent("Tromsø") + "&radius_km=50&sort=distance",
    "preserves the typed-place fallback param (sted) too, not just lat/lng"
  );

  return { passed, failed, failures };
}

// Minimal synthetic Request/Response for driving an Express Router directly
// (no listen()/http round-trip needed) — mirrors the callRoute() helper in
// opplevelser-discover-geo.test.ts, adapted for a res.send() HTML handler
// (like /sok) rather than res.json().
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

// ── DB-backed regression test: out-of-range lat/lng must never wipe an
//    already-successful q search on /sok ────────────────────────────────
export function runExperiencesSeoSokGeoRegressionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      dbFactory.getDb("experiences");

      const providerId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: "Troms og Finnmark", kommune: "Tromsø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Hvalsafari i Tromsø", provider_id: providerId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
        verification_status: "verified", confidence: "high",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── Regression: ?q=hvalsafari&lat=999&lng=10 — lat=999 is way outside
      //    -90..90 and used to reach discoverExperiences(), which throws a
      //    ZodError; the (formerly) shared try/catch then discarded the
      //    already-successful "hvalsafari" search results.
      const res = await callHtmlRoute(seoRouter, "/sok?q=hvalsafari&lat=999&lng=10");
      assertTrue(res.handled, "1: GET /sok?q=hvalsafari&lat=999&lng=10 is handled (no thrown exception)");
      assertTrue(res.status === 200, `2: response status is 200 (got ${res.status})`);
      assertTrue(
        res.body.includes("Hvalsafari i Tromsø"),
        "3: the already-successful q=hvalsafari search result is present, NOT wiped by the invalid lat"
      );
      assertTrue(
        !res.body.includes("Ingen treff"),
        '4: page does NOT render the false "Ingen treff" (no results) empty state'
      );
      assertTrue(
        !res.body.includes("Viser opplevelser innenfor"),
        "5: page does NOT claim a geo search ran (hasGeo correctly stays false for out-of-range lat)"
      );

      // ── Sanity: a VALID lat/lng still works (near-me browse still functions
      //    after the range-validation change — not just the invalid path).
      const resValid = await callHtmlRoute(seoRouter, "/sok?lat=69.65&lng=18.95&radius_km=50");
      assertTrue(resValid.handled, "6: GET /sok with valid lat/lng is handled");
      assertTrue(resValid.status === 200, `7: valid-geo response status is 200 (got ${resValid.status})`);
      assertTrue(
        resValid.body.includes("Viser opplevelser innenfor"),
        "8: valid lat/lng still activates the geo note (range-validation doesn't break the happy path)"
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-sok-geo-regression: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
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

if (require.main === module) {
  const result = runExperiencesSeoSokGeoTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  runExperiencesSeoSokGeoRegressionTests({ log: true }).then((regResult) => {
    console.log(`\n${regResult.passed} passed, ${regResult.failed} failed`);
    if (result.failed > 0 || regResult.failed > 0) process.exit(1);
  });
}
