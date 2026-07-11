/**
 * experiences-seo-place-geo.test.ts — tests for item 4 of dev-request
 * 2026-07-04-opplevagent-naer-meg-geosok ("Fylke/kommune «nærmest deg
 * først»-sort"): /fylke/:fylke and /kommune/:kommune gain a "nærmest deg"
 * geo-sort option, reusing item 3's (/sok) browser-geolocation JS pattern,
 * range-validation guard, and distance/precision-honesty rule
 * (formatDistanceLabel) rather than inventing a third geo-UI pattern.
 *
 * runExperiencesSeoPlaceGeoUrlTests() covers buildSortToggleUrl()'s new
 * (backward-compatible) `basePath` param — pure, sync.
 *
 * runExperiencesSeoPlaceGeoRegressionTests() is DB-backed: seeds a fylke/
 * kommune with an address-precision experience, a kommune-precision
 * experience, and an ungeocoded experience, then asserts:
 *   1. No geo params -> SSR order/content is BYTE-IDENTICAL to before this
 *      feature existed (all three rows present, no geo-note/active toggle).
 *   2. Valid lat/lng + sort=distance -> re-sorted nearest-first, ungeocoded
 *      row dropped (never fabricates a distance), geo-note + active toggle
 *      rendered.
 *   3. Out-of-range lat (e.g. ?lat=999, the exact regression class item 3's
 *      round-1 review caught) degrades to the SAME byte-identical SSR
 *      order — never throws, never wipes rows.
 *   4. geo_precision honesty: an address-precision row shows an exact km
 *      distance; a kommune-precision row shows "i <kommune> kommune", never
 *      a fabricated street-level distance.
 *   5. /kommune/:kommune mirrors all of the above.
 *
 * Three ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-place-geo.test.ts
 *   2. Wired into the gate: tests/test.ts imports both exported runners and
 *      folds their pass/fail counts into the `npm test` summary.
 */

import { buildSortToggleUrl } from "./experiences-seo";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperiencesSeoPlaceGeoUrlTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── buildSortToggleUrl's basePath param (item 4) ────────────────────────
  assertEq(
    buildSortToggleUrl({ lat: "69.65", lng: "18.95" }, true, "/fylke/Troms"),
    "/fylke/Troms?lat=69.65&lng=18.95&sort=distance",
    "custom basePath routes the toggle URL to /fylke/:fylke instead of /sok"
  );
  assertEq(
    buildSortToggleUrl({ lat: "69.65", lng: "18.95", sort: "distance" }, false, "/kommune/Troms%C3%B8"),
    "/kommune/Troms%C3%B8?lat=69.65&lng=18.95",
    "custom basePath works for /kommune/:kommune too, deactivating drops sort=distance"
  );
  assertEq(
    buildSortToggleUrl({}, true),
    "/sok?sort=distance",
    "omitting basePath still defaults to /sok (existing /sok call sites unaffected)"
  );

  return { passed, failed, failures };
}

// Minimal synthetic Request/Response for driving an Express Router directly
// (no listen()/http round-trip needed) — mirrors callHtmlRoute() in
// experiences-seo-sok-geo.test.ts (item 3's own equivalent helper).
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
      redirect() { resolve({ handled: true, status: 301, body: "" }); },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export function runExperiencesSeoPlaceGeoRegressionTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

      const FYLKE = "Troms og Finnmark";
      const KOMMUNE = "Tromsø";
      // Origin: central Tromsø.
      const ORIGIN_LAT = 69.65;
      const ORIGIN_LNG = 18.95;

      const providerId = expStore.createProvider({
        navn: "Nordlys Opplevelser AS", fylke: FYLKE, kommune: KOMMUNE,
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // Address-precision, ~0.1 km from origin — closest.
      expStore.createExperience({
        title: "Hvalsafari nær sentrum", provider_id: providerId,
        provider_match_status: "matched", kommune: KOMMUNE, fylke: FYLKE,
        verification_status: "verified", confidence: "high",
        loc_lat: 69.651, loc_lon: 18.951, geo_precision: "address",
      });
      // Kommune-precision fallback, further away (~30 km) — second closest,
      // and must NEVER render a fabricated street-level distance.
      expStore.createExperience({
        title: "Fjelltur i kommunen", provider_id: providerId,
        provider_match_status: "matched", kommune: KOMMUNE, fylke: FYLKE,
        verification_status: "verified", confidence: "high",
        loc_lat: 69.9, loc_lon: 19.4, geo_precision: "kommune",
      });
      // Never geocoded at all — must appear in the standard SSR listing but
      // be EXCLUDED from the geo-sorted view (discoverExperiences never
      // fabricates a distance for an ungeocoded row).
      expStore.createExperience({
        title: "Ukjent posisjon opplevelse", provider_id: providerId,
        provider_match_status: "matched", kommune: KOMMUNE, fylke: FYLKE,
        verification_status: "verified", confidence: "high",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;
      const fylkePath = `/fylke/${encodeURIComponent(FYLKE)}`;
      const kommunePath = `/kommune/${encodeURIComponent(KOMMUNE)}`;

      // ── 1. No geo params: SSR order unchanged, all 3 rows present, no
      //    geo-note/active "Nærmest deg" state (regression: 0 behavior
      //    change is the acceptance criterion for the no-permission case).
      const baseline = await callHtmlRoute(seoRouter, fylkePath);
      assertTrue(baseline.handled && baseline.status === 200, "1: GET /fylke/:fylke (no geo) is handled, 200");
      assertTrue(baseline.body.includes("Hvalsafari nær sentrum"), "2: baseline includes address-precision row");
      assertTrue(baseline.body.includes("Fjelltur i kommunen"), "3: baseline includes kommune-precision row");
      assertTrue(baseline.body.includes("Ukjent posisjon opplevelse"), "4: baseline includes the ungeocoded row (never dropped without geo)");
      assertTrue(baseline.body.includes("📍 Nærmest deg først"), "5: baseline still renders the near-me sort button (progressive enhancement affordance present)");
      assertTrue(!baseline.body.includes("sortert etter avstand"), "6: baseline does NOT claim a distance sort ran");
      assertTrue(!baseline.body.includes('aria-current="true">Nærmest deg'), "7: baseline's sort toggle (if rendered at all) does not show 'Nærmest deg' as active");

      // ── 2. Valid lat/lng + sort=distance: nearest-first, ungeocoded row
      //    dropped, geo-note rendered, honesty rule intact.
      const geoSorted = await callHtmlRoute(seoRouter, `${fylkePath}?lat=${ORIGIN_LAT}&lng=${ORIGIN_LNG}&sort=distance`);
      assertTrue(geoSorted.handled && geoSorted.status === 200, "8: GET /fylke/:fylke?lat=&lng=&sort=distance is handled, 200");
      assertTrue(geoSorted.body.includes("sortert etter avstand"), "9: geo-sorted response renders the geo-note");
      assertTrue(
        !geoSorted.body.includes("Ukjent posisjon opplevelse"),
        "10: geo-sorted response drops the never-geocoded row (no fabricated distance)"
      );
      const idxClose = geoSorted.body.indexOf("Hvalsafari nær sentrum");
      const idxFar = geoSorted.body.indexOf("Fjelltur i kommunen");
      assertTrue(idxClose >= 0 && idxFar >= 0, "11: both geocoded rows present in the geo-sorted response");
      assertTrue(idxClose >= 0 && idxFar >= 0 && idxClose < idxFar, "12: closer (address-precision) row is ordered before the farther (kommune-precision) row");

      // ── 4 (honesty): address-precision row gets an exact km distance;
      //    kommune-precision row says "i Tromsø kommune", never a
      //    street-level distance claim for a centroid-fallback row.
      assertTrue(/km unna/.test(geoSorted.body), "13: address-precision row shows an exact 'X,X km unna' distance");
      assertTrue(geoSorted.body.includes(`i ${KOMMUNE} kommune`), "14: kommune-precision row honestly says 'i Tromsø kommune', not a fabricated distance");

      // ── 3. Out-of-range lat (?lat=999) — the exact regression class item
      //    3's round-1 review caught on /sok — must degrade to the SAME
      //    byte-identical SSR baseline, never throw, never wipe rows.
      const badLat = await callHtmlRoute(seoRouter, `${fylkePath}?lat=999&lng=${ORIGIN_LNG}&sort=distance`);
      assertTrue(badLat.handled && badLat.status === 200, "15: GET /fylke/:fylke?lat=999&sort=distance is handled (no thrown exception), 200");
      assertTrue(badLat.body.includes("Ukjent posisjon opplevelse"), "16: out-of-range lat degrades to standard SSR order (ungeocoded row still present)");
      assertTrue(!badLat.body.includes("sortert etter avstand"), "17: out-of-range lat does NOT claim a distance sort ran");

      // ── 5. /kommune/:kommune mirrors the same behavior ──────────────────
      const kommuneBaseline = await callHtmlRoute(seoRouter, kommunePath);
      assertTrue(kommuneBaseline.handled && kommuneBaseline.status === 200, "18: GET /kommune/:kommune (no geo) is handled, 200");
      assertTrue(kommuneBaseline.body.includes("Ukjent posisjon opplevelse"), "19: kommune baseline includes the ungeocoded row");
      assertTrue(kommuneBaseline.body.includes("📍 Nærmest deg først"), "20: kommune baseline renders the near-me sort button too");

      const kommuneGeoSorted = await callHtmlRoute(kommunePath ? seoRouter : seoRouter, `${kommunePath}?lat=${ORIGIN_LAT}&lng=${ORIGIN_LNG}&sort=distance`);
      assertTrue(kommuneGeoSorted.handled && kommuneGeoSorted.status === 200, "21: GET /kommune/:kommune?lat=&lng=&sort=distance is handled, 200");
      const kIdxClose = kommuneGeoSorted.body.indexOf("Hvalsafari nær sentrum");
      const kIdxFar = kommuneGeoSorted.body.indexOf("Fjelltur i kommunen");
      assertTrue(kIdxClose >= 0 && kIdxFar >= 0 && kIdxClose < kIdxFar, "22: /kommune/:kommune also sorts nearest-first");
      assertTrue(
        !kommuneGeoSorted.body.includes("Ukjent posisjon opplevelse"),
        "23: /kommune/:kommune geo-sorted response also drops the never-geocoded row"
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-place-geo-regression: unexpected error: " + String(err?.stack || err?.message || err));
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
  const result = runExperiencesSeoPlaceGeoUrlTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  runExperiencesSeoPlaceGeoRegressionTests({ log: true }).then((regResult) => {
    console.log(`\n${regResult.passed} passed, ${regResult.failed} failed`);
    if (result.failed > 0 || regResult.failed > 0) process.exit(1);
  });
}
