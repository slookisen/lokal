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

import { formatDistanceLabel, gardssalgRewriteEligible, gardssalgProductsEligible } from "./experience-store";

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

  // ── gardssalgRewriteEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5a) — the "passing-bar-but-short"
  //    cohort gardssalgReplaceableFieldAction() never touches. ──────────────
  const PASSING_BAR_SHORT_86 =
    "Familiedrevet gård på Toten som dyrker grønnsaker og bær, og selger dem i egen butikk.";
  const SUB_80_63 = "Liten gård med noen dyr og en pen have full av epletrær og bær.";
  const PASSING_BAR_LONG_215 =
    "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger dem direkte fra gårdsbutikken. Vi holder også sauer og høns, og inviterer besøkende til å oppleve gårdslivet på nært hold hele sommeren.";

  assertTrue(PASSING_BAR_SHORT_86.length >= 80 && PASSING_BAR_SHORT_86.length < 200, "sanity: PASSING_BAR_SHORT_86 is in the [80,200) window");
  assertTrue(SUB_80_63.length < 80, "sanity: SUB_80_63 is under the 80-char quality bar");
  assertTrue(PASSING_BAR_LONG_215.length >= 200, "sanity: PASSING_BAR_LONG_215 is >= 200 chars");

  assertEq(gardssalgRewriteEligible(PASSING_BAR_SHORT_86), true, "gardssalgRewriteEligible: 86-char value passing the quality bar and <200 chars → true");
  assertEq(gardssalgRewriteEligible(SUB_80_63), false, "gardssalgRewriteEligible: 63-char value (fails the 80-char quality bar) → false");
  assertEq(gardssalgRewriteEligible(PASSING_BAR_LONG_215), false, "gardssalgRewriteEligible: 215-char value (passes bar but already >=200 chars) → false, not a rewrite candidate");
  assertEq(gardssalgRewriteEligible(""), false, "gardssalgRewriteEligible: blank string → false");
  assertEq(gardssalgRewriteEligible("   "), false, "gardssalgRewriteEligible: whitespace-only string → false");
  assertEq(gardssalgRewriteEligible(null), false, "gardssalgRewriteEligible: null → false");
  assertEq(gardssalgRewriteEligible(undefined), false, "gardssalgRewriteEligible: undefined → false");

  // ── gardssalgProductsEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5c) — fill-only gate for the
  //    "products" JSON-array column. ────────────────────────────────────────
  assertEq(gardssalgProductsEligible(null), true, "gardssalgProductsEligible: null → true (blank column, eligible)");
  assertEq(gardssalgProductsEligible(undefined), true, "gardssalgProductsEligible: undefined → true");
  assertEq(gardssalgProductsEligible(""), true, "gardssalgProductsEligible: empty string → true");
  assertEq(gardssalgProductsEligible("   "), true, "gardssalgProductsEligible: whitespace-only string → true");
  assertEq(gardssalgProductsEligible("[]"), true, "gardssalgProductsEligible: literal '[]' → true (empty array)");
  assertEq(gardssalgProductsEligible("  []  "), true, "gardssalgProductsEligible: '[]' with surrounding whitespace → true");
  assertEq(gardssalgProductsEligible(JSON.stringify([])), true, "gardssalgProductsEligible: JSON.stringify([]) round-trip → true");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider"])), false, "gardssalgProductsEligible: non-empty array (one product) → false, never overwritten");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider", "Eplemost"])), false, "gardssalgProductsEligible: non-empty array (two products) → false");
  assertEq(gardssalgProductsEligible("not valid json"), false, "gardssalgProductsEligible: malformed non-JSON value → false, conservative (never silently overwritten)");
  assertEq(gardssalgProductsEligible('{"not":"an array"}'), false, "gardssalgProductsEligible: valid JSON but not an array (an object) → false");
  assertEq(gardssalgProductsEligible("[1,2,3]"), false, "gardssalgProductsEligible: valid non-empty JSON array (even of non-strings) → false, only an EMPTY array is eligible");

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runExperienceStoreTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
