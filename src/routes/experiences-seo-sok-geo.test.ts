/**
 * experiences-seo-sok-geo.test.ts — unit tests for the PURE helper backing
 * /sok's distance-sort toggle (dev-request 2026-07-04-opplevagent-naer-meg-
 * geosok, item 3: «Nær meg» on /sok).
 *
 * buildSortToggleUrl() takes a plain string-keyed record (not a Request), so
 * it's testable without booting an Express app or a DB.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-sok-geo.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoSokGeoTests() and folds its pass/fail counts into
 *      the `npm test` summary.
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

if (require.main === module) {
  const result = runExperiencesSeoSokGeoTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
