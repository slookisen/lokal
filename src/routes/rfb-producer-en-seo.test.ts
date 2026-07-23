/**
 * rfb-producer-en-seo.test.ts — unit tests for buildProducerPageTitle() and
 * buildProducerMetaDescription() (dev-request
 * 2026-07-19-en-produsentsider-engelsk-innhold).
 *
 * Root cause fixed here: /en/produsent/<slug> pages were reusing the NB
 * <title> and <meta name="description"> almost verbatim, so Google treated
 * them as thin duplicates of the /produsent/<slug> NB pages. Two bugs, both
 * in src/routes/seo.ts's `router.get("/produsent/:slug", ...)` handler:
 *
 *   1. Title: when cityName was empty, the title suffix was "" for BOTH nb
 *      and en, so the EN title was byte-identical to the NB title.
 *   2. Meta-description: the EN branch still interpolated the raw NB
 *      `agent.description` text (via safeMetaDescription(safeDescription)),
 *      leaking untranslated NB prose into an English <meta> tag.
 *
 * buildProducerPageTitle() and buildProducerMetaDescription() are pure
 * functions, extracted from the route handler specifically so they're
 * directly unit-testable — the same pattern this codebase already uses for
 * opplevagent's seoPageTitle() (see experiences-seo-title.test.ts). The
 * "no"/nb branch of each must remain byte-for-byte identical to the
 * pre-existing inline template-literal behavior (regression guard); only
 * the "en" branch is new.
 *
 * Run standalone: npx tsx src/routes/rfb-producer-en-seo.test.ts
 * Wired into the gate: tests/test.ts imports runRfbProducerEnSeoTests()
 * (pure, sync) and folds its pass/fail counts into the `npm test` summary.
 */

import { buildProducerPageTitle, buildProducerMetaDescription, formatCatEn, safeMetaDescription } from "./seo";
import { t } from "../i18n/t";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runRfbProducerEnSeoTests(opts: { log?: boolean } = {}): TestSummary {
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

  const rawNoDescription =
    "Vi driver et lite gårdsbruk med geiter og høner, og selger fersk melk, egg og hjemmelaget geitost rett fra tunet.";

  // ── (a) EN title differs from NB title when city is empty ─────────────
  {
    const nbTitle = buildProducerPageTitle("Solstad Gård", "", "no", null);
    const enTitle = buildProducerPageTitle("Solstad Gård", "", "en", null);
    assertTrue(nbTitle !== enTitle, "a1: EN title differs from NB title when cityName is empty");
    assertEq(nbTitle, "Solstad Gård", "a2: NB title with no city is exactly agent.name (unchanged pre-existing behavior)");
    assertEq(
      enTitle,
      `Solstad Gård${t("en", "producer.title_suffix_no_city")}`,
      "a3: EN title with no city renders agent.name + the new title_suffix_no_city i18n key"
    );
    assertTrue(enTitle.includes("Norway"), "a4: EN no-city title fallback mentions Norway");
  }

  // ── (b) EN meta-description never contains the raw NB description text ─
  {
    const enDescWithCity = buildProducerMetaDescription(
      "Solstad Gård",
      "Lillehammer",
      "en",
      rawNoDescription,
      "dairy",
      3
    );
    const enDescNoCity = buildProducerMetaDescription("Solstad Gård", "", "en", rawNoDescription, "", 0);
    assertTrue(
      !enDescWithCity.includes(rawNoDescription),
      "b1: EN meta-description (with city) does not contain the raw NB description text"
    );
    assertTrue(
      !enDescWithCity.toLowerCase().includes("geiter") && !enDescWithCity.toLowerCase().includes("gårdsbruk"),
      "b2: EN meta-description (with city) contains no fragment of the NB prose"
    );
    assertTrue(
      !enDescNoCity.includes(rawNoDescription),
      "b3: EN meta-description (no city, no category, no products) does not contain the raw NB description text"
    );
    assertTrue(enDescWithCity.includes("Solstad Gård"), "b4: EN meta-description includes the agent name");
    assertTrue(enDescWithCity.includes("Lillehammer"), "b5: EN meta-description includes the city when present");
    assertTrue(enDescWithCity.includes(formatCatEn("dairy")), "b6: EN meta-description includes the capitalized English category label");
    assertTrue(enDescWithCity.includes("3"), "b7: EN meta-description includes the product count when > 0");
    assertTrue(!enDescNoCity.includes("Norway,"), "b8: EN meta-description with no city does not append a dangling ', Norway' city fragment");
    assertTrue(enDescNoCity.includes("Norway"), "b9: EN meta-description with no city still mentions Norway");
  }

  // ── (c) NB title/meta-description output is byte-identical to a snapshot
  //    of current (pre-fix) behavior — regression guard, with and without
  //    a city. ──────────────────────────────────────────────────────────
  {
    // With city.
    const nbTitleWithCity = buildProducerPageTitle("Nordfjord Bakeri", "Ålesund", "no", null);
    assertEq(
      nbTitleWithCity,
      `Nordfjord Bakeri${t("no", "producer.title_suffix", { city: "Ålesund" })}`,
      "c1: NB title with city matches the pre-existing template-literal snapshot"
    );
    const nbDescWithCity = buildProducerMetaDescription("Nordfjord Bakeri", "Ålesund", "no", rawNoDescription, "bakery", 5);
    assertEq(
      nbDescWithCity,
      `Nordfjord Bakeri i Ålesund. ${safeMetaDescription(rawNoDescription)}`,
      "c2: NB meta-description with city matches the pre-existing template-literal snapshot (raw NB description, untouched)"
    );

    // Without city.
    const nbTitleNoCity = buildProducerPageTitle("Nordfjord Bakeri", "", "no", null);
    assertEq(nbTitleNoCity, "Nordfjord Bakeri", "c3: NB title with no city matches the pre-existing template-literal snapshot (just agent.name)");
    const nbDescNoCity = buildProducerMetaDescription("Nordfjord Bakeri", "", "no", "", "bakery", 0);
    assertEq(
      nbDescNoCity,
      "Nordfjord Bakeri. Lokalprodusert mat i Norge.",
      "c4: NB meta-description with no city and no description falls back to 'Lokalprodusert mat i Norge.' unchanged"
    );
  }

  // ── formatCatEn() sanity — sibling helper used by the EN meta-description
  //    builder above; must capitalize, not translate. ────────────────────
  {
    assertEq(formatCatEn("vegetables"), "Vegetables", "d1: formatCatEn capitalizes a category key");
    assertEq(formatCatEn("dairy"), "Dairy", "d2: formatCatEn capitalizes 'dairy'");
    assertEq(formatCatEn(""), "", "d3: formatCatEn on empty string returns empty string, no throw");
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runRfbProducerEnSeoTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
