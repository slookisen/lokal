/**
 * experience-tags.test.ts — unit tests for the derived cross-cutting FILTER
 * TAGS (services/experience-tags.ts).
 *
 * Dev-request 2026-07: Daniel confirmed "tags/filters only, no new
 * categories" for experiences. These pin the derivation logic against the
 * actual `experiences` row fields (age_suitability, min_age, price_band,
 * price_from, indoor_outdoor, weather_dependent, accessibility, season,
 * seasonal_valid_from/to — see src/database/init-experiences.ts) so a future
 * change to the heuristics is a deliberate, reviewed decision rather than a
 * silent regression.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-tags.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperienceTagsTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import { deriveExperienceTags, type TaggableExperience } from "./experience-tags";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceTagsTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── Representative case #1: free, family-friendly, indoor experience ──────
  // Expect gratis + familievennlig + værsikker. No accessibility data given,
  // and season is year_round only, so no tilgjengelig/sesong.
  {
    const exp: TaggableExperience = {
      age_suitability: "family",
      min_age: null,
      price_band: "gratis",
      price_from: 0,
      indoor_outdoor: "indoor",
      weather_dependent: 0,
      accessibility: [],
      season: ["year_round"],
      seasonal_valid_from: null,
      seasonal_valid_to: null,
    };
    assertEq(
      deriveExperienceTags(exp),
      ["familievennlig", "gratis", "værsikker"],
      "free+family+indoor experience -> familievennlig, gratis, værsikker"
    );
  }

  // ── Representative case #2: expensive, outdoor, adults-only experience ────
  // Expect NONE of gratis/familievennlig/under-300/værsikker/tilgjengelig/sesong.
  {
    const exp: TaggableExperience = {
      age_suitability: "adults",
      min_age: 18,
      price_band: "premium",
      price_from: 2500,
      indoor_outdoor: "outdoor",
      weather_dependent: 1,
      accessibility: [],
      season: ["year_round"],
      seasonal_valid_from: null,
      seasonal_valid_to: null,
    };
    assertEq(deriveExperienceTags(exp), [], "expensive+outdoor+adults-only experience -> no tags");
  }

  // ── under-300: priced but affordable, not free ─────────────────────────────
  {
    const exp: TaggableExperience = {
      age_suitability: "all",
      price_band: "rimelig",
      price_from: 150,
      indoor_outdoor: "outdoor",
      weather_dependent: 1,
      season: ["summer"],
    };
    const tags = deriveExperienceTags(exp);
    assertTrue(tags.includes("under-300"), "price_from=150 (>0, <=300) -> under-300");
    assertTrue(!tags.includes("gratis"), "price_from=150 -> NOT gratis");
    assertTrue(tags.includes("familievennlig"), "age_suitability=all -> familievennlig");
    assertTrue(tags.includes("sesong"), "season=['summer'] -> sesong (not year_round)");
    assertTrue(!tags.includes("værsikker"), "outdoor + weather_dependent=1 -> NOT værsikker");
  }

  // ── under-300 boundary: exactly at threshold is included, just over is not ─
  {
    assertTrue(
      deriveExperienceTags({ price_from: 300 }).includes("under-300"),
      "price_from=300 (threshold, inclusive) -> under-300"
    );
    assertTrue(
      !deriveExperienceTags({ price_from: 301 }).includes("under-300"),
      "price_from=301 -> NOT under-300"
    );
  }

  // ── gratis via price_from=0 even without an explicit 'gratis' price_band ──
  {
    const tags = deriveExperienceTags({ price_band: "ukjent", price_from: 0 });
    assertTrue(tags.includes("gratis"), "price_from=0 with unrelated price_band -> gratis");
    assertTrue(!tags.includes("under-300"), "price_from=0 -> NOT under-300 (gratis covers it)");
  }

  // ── tilgjengelig: driven purely by non-empty accessibility array ──────────
  {
    assertTrue(
      deriveExperienceTags({ accessibility: ["rullestolvennlig"] }).includes("tilgjengelig"),
      "non-empty accessibility array -> tilgjengelig"
    );
    assertTrue(
      !deriveExperienceTags({ accessibility: [] }).includes("tilgjengelig"),
      "empty accessibility array -> NOT tilgjengelig"
    );
    assertTrue(
      !deriveExperienceTags({}).includes("tilgjengelig"),
      "missing accessibility field -> NOT tilgjengelig"
    );
  }

  // ── værsikker: indoor OR explicitly weather-independent, not 'both' ───────
  {
    assertTrue(
      deriveExperienceTags({ indoor_outdoor: "indoor" }).includes("værsikker"),
      "indoor_outdoor='indoor' -> værsikker"
    );
    assertTrue(
      deriveExperienceTags({ indoor_outdoor: "outdoor", weather_dependent: 0 }).includes("værsikker"),
      "outdoor but weather_dependent=0 -> værsikker"
    );
    assertTrue(
      !deriveExperienceTags({ indoor_outdoor: "both", weather_dependent: 1 }).includes("værsikker"),
      "indoor_outdoor='both' + weather_dependent=1 -> NOT værsikker (narrower than the discover rain/snow heuristic)"
    );
  }

  // ── sesong: year_round alone is not seasonal; a seasonal window is ────────
  {
    assertTrue(
      !deriveExperienceTags({ season: ["year_round"] }).includes("sesong"),
      "season=['year_round'] only -> NOT sesong"
    );
    assertTrue(
      !deriveExperienceTags({ season: [] }).includes("sesong"),
      "season=[] -> NOT sesong"
    );
    assertTrue(
      deriveExperienceTags({ season: ["winter"] }).includes("sesong"),
      "season=['winter'] -> sesong"
    );
    assertTrue(
      deriveExperienceTags({ season: ["year_round", "summer"] }).includes("sesong"),
      "season=['year_round','summer'] (mixed) -> sesong"
    );
    assertTrue(
      deriveExperienceTags({ season: [], seasonal_valid_from: "2026-06-01" }).includes("sesong"),
      "explicit seasonal_valid_from with no season array -> sesong"
    );
  }

  // ── familievennlig: min_age is a defensive override on bad harvest data ───
  {
    assertTrue(
      !deriveExperienceTags({ age_suitability: "family", min_age: 18 }).includes("familievennlig"),
      "age_suitability='family' but min_age=18 (contradictory harvest data) -> NOT familievennlig"
    );
    assertTrue(
      deriveExperienceTags({ age_suitability: "kids" }).includes("familievennlig"),
      "age_suitability='kids' -> familievennlig"
    );
    assertTrue(
      !deriveExperienceTags({ age_suitability: null }).includes("familievennlig"),
      "age_suitability=null (unknown) -> NOT familievennlig"
    );
  }

  // ── Missing/partial data never throws, and yields no false positives ──────
  {
    let threw = false;
    let tags: string[] = [];
    try {
      tags = deriveExperienceTags({});
    } catch {
      threw = true;
    }
    assertTrue(!threw, "empty input object does not throw");
    assertEq(tags, [], "empty input object -> no tags");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/experience-tags.test.ts`
if (require.main === module) {
  console.log("── experience-tags unit tests ──");
  const r = runExperienceTagsTests({ log: true });
  console.log(`\nexperience-tags: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
