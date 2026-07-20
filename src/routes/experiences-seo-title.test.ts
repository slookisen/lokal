/**
 * experiences-seo-title.test.ts — unit tests for seoPageTitle() (dev-request
 * 2026-07-12-opplevagent-serp-innholdsberikelse, item 2: "Title-fiks: ingen
 * «…»-avkutting inne i <title> ... ren trunkering ved behov").
 *
 * Root cause fixed here: seoPageTitle() used to truncate `main` to
 * MAX_TITLE - BRAND.length - 1 chars and append a literal "…" before the
 * " | Opplevagent" brand suffix. Confirmed live in prod 2026-07-20:
 * opplevagent.no/opplevelse/lofoten-explorer-trollfjord-rib-cruise-sea-eagle-
 * safari-from-svolvaer--1d9f48ba rendered
 * `<title>Lofoten Explorer — Trollfjord RIB Cruise &amp; Sea Eagle Sa… | Opplevagent</title>`
 * — an ellipsis truncation mid-word inside the actual <title> tag. The spec
 * requires clean truncation instead: no "…" character anywhere in the
 * result, and (where reasonably possible without discarding too much of the
 * available budget) a cut at a word boundary rather than mid-word.
 *
 * seoPageTitle() is a pure function of its `main: string` argument (BRAND/
 * MAX_TITLE are its own module-scope constants, not request/DB state), and
 * was moved from a closure nested inside renderOpplevelseDetail to a plain
 * exported module-scope function specifically so it's directly unit-testable
 * — the same pattern this file already uses for buildSortToggleUrl (see
 * experiences-seo-sok-geo.test.ts / experiences-seo-place-geo.test.ts) rather
 * than driving it indirectly through an HTTP fixture.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-title.test.ts
 * Wired into the gate: tests/test.ts imports runExperiencesSeoTitleTests()
 * (pure, sync) and folds its pass/fail counts into the `npm test` summary.
 */

import { seoPageTitle } from "./experiences-seo";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperiencesSeoTitleTests(opts: { log?: boolean } = {}): TestSummary {
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

  const BRAND = " | Opplevagent";

  // ── 1. Fits within budget: regression case, returns main + BRAND verbatim,
  //    completely untouched by the truncation path. ─────────────────────────
  const shortTitle = "Kajakktur i skjærgården";
  assertEq(
    seoPageTitle(shortTitle),
    shortTitle + BRAND,
    "1: a title that fits within the 70-char budget is returned unchanged (main + BRAND)"
  );

  // ── 2. The exact live-prod regression: a long title with real word
  //    boundaries must truncate WITHOUT an ellipsis, stay within budget, and
  //    actually engage the truncation logic (result is shorter than the
  //    untruncated main + BRAND would have been). ────────────────────────────
  const lofotenTitle = "Lofoten Explorer — Trollfjord RIB Cruise & Sea Eagle Safari from Svolvær";
  const lofotenResult = seoPageTitle(lofotenTitle);
  assertTrue(!lofotenResult.includes("…"), "2a: long title truncation contains no ellipsis character");
  assertTrue(lofotenResult.length <= 70, `2b: long title result length (${lofotenResult.length}) is <= 70`);
  assertTrue(lofotenResult.endsWith(BRAND), "2c: long title result still ends with the brand suffix");
  assertTrue(
    lofotenResult.length < lofotenTitle.length + BRAND.length,
    "2d: truncation logic actually ran (result shorter than untruncated main + BRAND)"
  );
  // The truncated main-part must not end with dangling whitespace or
  // punctuation (dash/comma/ampersand leftover) — trimEnd + punctuation strip
  // must have run.
  const lofotenMainPart = lofotenResult.slice(0, lofotenResult.length - BRAND.length);
  assertTrue(
    !/[\s\-–—,.&/]$/.test(lofotenMainPart),
    "2e: truncated main-part has no dangling trailing whitespace/dash/comma/ampersand"
  );
  // This specific input has plenty of word-boundary room within the 60%
  // threshold, so the cut should land on a full word, not mid-word: the
  // main-part must be a prefix of the original title (i.e. every char kept
  // matches the source, meaning no partial word was invented/altered) and
  // must not itself be a substring that splits the last kept word from the
  // full original title's tokens.
  assertTrue(lofotenTitle.startsWith(lofotenMainPart), "2f: truncated main-part is a clean prefix of the original title");
  const keptWords = lofotenMainPart.split(" ");
  const lastKeptWord = keptWords[keptWords.length - 1];
  const originalWords = lofotenTitle.split(" ");
  assertTrue(
    originalWords.includes(lastKeptWord),
    `2g: last kept word ("${lastKeptWord}") is a whole word from the original title, not a mid-word fragment`
  );

  // ── 3. No-whitespace edge case: one very long unbroken token. Must still
  //    produce a valid <=70-char result with no ellipsis, and must not
  //    crash/throw. ───────────────────────────────────────────────────────
  const unbrokenToken = "A".repeat(120);
  let unbrokenResult = "";
  let threw = false;
  try {
    unbrokenResult = seoPageTitle(unbrokenToken);
  } catch {
    threw = true;
  }
  assertTrue(!threw, "3a: an unbroken 120-char token does not throw");
  assertTrue(!unbrokenResult.includes("…"), "3b: unbroken-token result contains no ellipsis character");
  assertTrue(unbrokenResult.length <= 70, `3c: unbroken-token result length (${unbrokenResult.length}) is <= 70`);
  assertTrue(unbrokenResult.endsWith(BRAND), "3d: unbroken-token result still ends with the brand suffix");
  assertTrue(unbrokenResult.length > BRAND.length, "3e: unbroken-token result kept some of the main text (not just the brand)");

  // ── 4. Boundary regression: exactly at the 70-char cutoff (main + BRAND ===
  //    70) must NOT be truncated (the <= comparison in seoPageTitle must stay
  //    inclusive). ─────────────────────────────────────────────────────────
  const BRAND_LEN = BRAND.length;
  const exactFitMain = "X".repeat(70 - BRAND_LEN);
  assertEq(
    seoPageTitle(exactFitMain),
    exactFitMain + BRAND,
    "4: a title whose length is exactly at the 70-char budget is returned unchanged"
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runExperiencesSeoTitleTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
