/**
 * experience-store.test.ts — unit tests for the PURE helpers in
 * services/experience-store.ts.
 *
 * Currently covers formatDistanceLabel() (dev-request 2026-07-04-opplevagent-
 * naer-meg-geosok, item 3: «Nær meg» on /sok) — the honesty rule that a
 * 'kommune'-precision (centroid-fallback) row must NEVER render a street-
 * level distance claim, only an 'address'-precision row may.
 *
 * No DB access — getDb() is lazy (only called inside DB-touching functions),
 * so importing this module and calling formatDistanceLabel() directly is
 * safe without any EXPERIENCES_DB_PATH/in-memory-DB setup.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-store.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperienceStoreTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { formatDistanceLabel } from "./experience-store";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceStoreTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── formatDistanceLabel: address precision → exact "X,X km unna" ────────
  assertEq(formatDistanceLabel(2.4, "address", "Tromsø"), "2,4 km unna", "address precision: 2.4km → '2,4 km unna'");
  assertEq(formatDistanceLabel(0, "address", "Tromsø"), "0,0 km unna", "address precision: 0km → '0,0 km unna'");
  assertEq(formatDistanceLabel(63.9, "address", null), "63,9 km unna", "address precision: no kommune needed, still shows exact distance");
  assertEq(formatDistanceLabel(2, "address", "Oslo"), "2,0 km unna", "address precision: whole-number km still shows one decimal (2,0)");

  // ── formatDistanceLabel: kommune precision → NEVER a distance, only the
  //    kommune name — this is the honesty rule from the dev-request ────────
  assertEq(formatDistanceLabel(63.9, "kommune", "Tromsø"), "i Tromsø kommune", "kommune precision: never claims a distance, even though distance_km is present");
  assertEq(formatDistanceLabel(null, "kommune", "Bergen"), "i Bergen kommune", "kommune precision: works with null distance_km too");
  assertEq(formatDistanceLabel(5, "kommune", null), "omtrentlig posisjon (kommune)", "kommune precision with no kommune name: generic approximate label, still no fabricated distance");

  // ── formatDistanceLabel: nothing honest to say → null (render nothing) ──
  assertEq(formatDistanceLabel(null, null, "Oslo"), null, "no geo_precision at all → null (never geocoded)");
  assertEq(formatDistanceLabel(2.4, null, "Oslo"), null, "distance present but no geo_precision flag → null (don't guess)");
  assertEq(formatDistanceLabel(undefined, undefined, undefined), null, "all undefined → null");
  assertEq(formatDistanceLabel(NaN, "address", "Oslo"), null, "address precision but non-finite distance → null, not 'NaN km unna'");

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runExperienceStoreTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
