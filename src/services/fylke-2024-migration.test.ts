/**
 * fylke-2024-migration.test.ts — unit tests for
 * src/services/fylke-2024-migration.ts's resolveFylke2024() (dev-request
 * 2026-08-07-orch-fylke-2024-migrasjon).
 *
 * Covers:
 *   1. kommunenummer exact hit (Oslo, 0301)
 *   2. kommunenummer not found -> needs_review with the exact
 *      "kommunenummer_not_found:<value>" reason string
 *   3. kommune-name hit (normalized, diacritic/case-insensitive)
 *   4. the two known vendored-table name collisions ("Herøy",
 *      "Våler") -> needs_review, never guessed
 *   5. unknown kommune name -> needs_review
 *      ("ambiguous_or_unknown_kommune:<value>")
 *   6. no input at all (neither field, or both blank) -> needs_review
 *      ("no_kommune_data")
 *   7. kommunenummer takes precedence over kommune when both are given
 *   8. Sami kommune-name aliases (Kåfjord/Karasjok/Kautokeino ->
 *      Gáivuotna/Kárášjohka/Guovdageaidnu), plus regression checks that the
 *      canonical Sami names and the kommunenummer-based path both still
 *      resolve unaffected
 *   9. resolveKommunenummerForName() (dev-request 2026-09-14-opplevagent-
 *      karantene-utgang-brreg-krav, Trinn B) — reuses the SAME loadRows()/
 *      kommuneKey()/KOMMUNE_NAME_ALIASES machinery as resolveFylke2024()
 *      above: unambiguous name -> {kommunenummer}, the Herøy/Våler
 *      collisions -> needs_review, unknown/blank name -> needs_review,
 *      Sami-name aliases resolve.
 *  10. isKnownKommunenummer() (Trinn B fix-up, independent-reviewer finding
 *      on experience-orgnr-from-name-kommune.ts's own-column kommunenummer
 *      branch going unvalidated) — a real vendored-table code -> true, an
 *      unknown/garbage code -> false, blank/whitespace-only -> false.
 *
 * Run standalone: npx tsx src/services/fylke-2024-migration.test.ts
 * Wired into tests/test.ts via runFylke2024MigrationTests().
 */

import { isKnownKommunenummer, resolveFylke2024, resolveKommunenummerForName } from "./fylke-2024-migration";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runFylke2024MigrationTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── 1. kommunenummer exact hit ───────────────────────────────────────
  assertEq(
    resolveFylke2024({ kommunenummer: "0301" }),
    { fylke: "Oslo" },
    "1: kommunenummer 0301 (Oslo) resolves to {fylke: 'Oslo'}"
  );
  assertEq(
    resolveFylke2024({ kommunenummer: "5001" }),
    { fylke: "Trøndelag" },
    "1b: kommunenummer 5001 (Trondheim) resolves to {fylke: 'Trøndelag'}"
  );

  // ── 2. kommunenummer not found -> needs_review, exact reason string ──
  assertEq(
    resolveFylke2024({ kommunenummer: "9999" }),
    { needs_review: "kommunenummer_not_found:9999" },
    "2: unknown kommunenummer -> needs_review:kommunenummer_not_found:9999"
  );

  // ── 3. kommune-name hit, normalized (case/diacritic-insensitive) ─────
  assertEq(
    resolveFylke2024({ kommune: "Tromsø" }),
    { fylke: "Troms" },
    "3a: kommune 'Tromsø' resolves to {fylke: 'Troms'}"
  );
  assertEq(
    resolveFylke2024({ kommune: "tromso" }),
    { fylke: "Troms" },
    "3b: kommune-name matching is case/diacritic-insensitive ('tromso' still resolves)"
  );
  assertEq(
    resolveFylke2024({ kommune: "  Bergen  " }),
    { fylke: "Vestland" },
    "3c: kommune-name matching trims surrounding whitespace"
  );
  assertEq(
    resolveFylke2024({ kommune: "Sortland" }),
    { fylke: "Nordland" },
    "3d: another unambiguous kommune-name hit (Sortland -> Nordland)"
  );

  // ── 4. the two known vendored-table name collisions -> needs_review ──
  const heroyResult = resolveFylke2024({ kommune: "Herøy" });
  assertTrue(
    "needs_review" in heroyResult && heroyResult.needs_review.startsWith("ambiguous_or_unknown_kommune:"),
    "4a: 'Herøy' (appears in both Møre og Romsdal and Nordland) -> needs_review, never guessed"
  );
  const valerResult = resolveFylke2024({ kommune: "Våler" });
  assertTrue(
    "needs_review" in valerResult && valerResult.needs_review.startsWith("ambiguous_or_unknown_kommune:"),
    "4b: 'Våler' (appears in both Østfold and Innlandet successors) -> needs_review, never guessed"
  );
  // Even the vendored table's own disambiguated form must not silently
  // resolve — this module's whole point is to never guess between the two.
  const heroyDisambiguatedResult = resolveFylke2024({ kommune: "Herøy (Møre og Romsdal)" });
  assertTrue(
    "needs_review" in heroyDisambiguatedResult,
    "4c: even the disambiguated vendored form 'Herøy (Møre og Romsdal)' still lands in needs_review (collision, never guessed)"
  );

  // ── 5. unknown kommune name -> needs_review ──────────────────────────
  assertEq(
    resolveFylke2024({ kommune: "Ikke-En-Ekte-Kommune-Xyz" }),
    { needs_review: "ambiguous_or_unknown_kommune:Ikke-En-Ekte-Kommune-Xyz" },
    "5: an unrecognised kommune name -> needs_review:ambiguous_or_unknown_kommune:<value>"
  );

  // ── 6. no input at all -> needs_review:no_kommune_data ───────────────
  assertEq(resolveFylke2024({}), { needs_review: "no_kommune_data" }, "6a: no fields at all -> needs_review:no_kommune_data");
  assertEq(
    resolveFylke2024({ kommunenummer: null, kommune: null }),
    { needs_review: "no_kommune_data" },
    "6b: both fields explicitly null -> needs_review:no_kommune_data"
  );
  assertEq(
    resolveFylke2024({ kommunenummer: "", kommune: "   " }),
    { needs_review: "no_kommune_data" },
    "6c: both fields blank/whitespace-only -> needs_review:no_kommune_data"
  );

  // ── 7. kommunenummer takes precedence over kommune when both given ───
  assertEq(
    resolveFylke2024({ kommunenummer: "0301", kommune: "Totally Wrong Name" }),
    { fylke: "Oslo" },
    "7a: a valid kommunenummer resolves correctly even with a garbage kommune name alongside it"
  );
  assertEq(
    resolveFylke2024({ kommunenummer: "9999", kommune: "Tromsø" }),
    { needs_review: "kommunenummer_not_found:9999" },
    "7b: an invalid kommunenummer reports needs_review even though a valid kommune was also given (kommunenummer takes precedence, never silently falls back)"
  );

  // ── 8. Sami kommune-name aliases ──────────────────────────────────────
  assertEq(
    resolveFylke2024({ kommune: "Kåfjord" }),
    { fylke: "Troms" },
    "8a: kommune 'Kåfjord' (Norwegian name, vendored table only has Sami 'Gáivuotna') resolves to {fylke: 'Troms'}"
  );
  assertEq(
    resolveFylke2024({ kommune: "Karasjok" }),
    { fylke: "Finnmark" },
    "8b: kommune 'Karasjok' (Norwegian name, vendored table only has Sami 'Kárášjohka') resolves to {fylke: 'Finnmark'}"
  );
  assertEq(
    resolveFylke2024({ kommune: "Kautokeino" }),
    { fylke: "Finnmark" },
    "8c: kommune 'Kautokeino' (Norwegian name, vendored table only has Sami 'Guovdageaidnu') resolves to {fylke: 'Finnmark'}"
  );
  assertEq(
    resolveFylke2024({ kommune: "kafjord" }),
    { fylke: "Troms" },
    "8d: the Norwegian-name alias is case/diacritic-insensitive ('kafjord' still resolves via kommuneKey's å->a fold)"
  );
  // Regression: the canonical Sami primary names must still resolve directly
  // and unaffected by the alias fold.
  assertEq(
    resolveFylke2024({ kommune: "Gáivuotna" }),
    { fylke: "Troms" },
    "8e: canonical Sami name 'Gáivuotna' still resolves directly to {fylke: 'Troms'} (unaffected by the alias)"
  );
  assertEq(
    resolveFylke2024({ kommune: "Kárášjohka" }),
    { fylke: "Finnmark" },
    "8f: canonical Sami name 'Kárášjohka' still resolves directly to {fylke: 'Finnmark'} (unaffected by the alias)"
  );
  assertEq(
    resolveFylke2024({ kommune: "Guovdageaidnu" }),
    { fylke: "Finnmark" },
    "8g: canonical Sami name 'Guovdageaidnu' still resolves directly to {fylke: 'Finnmark'} (unaffected by the alias)"
  );
  // Regression: the kommunenummer-based path (already working before this
  // change) must remain unaffected.
  assertEq(
    resolveFylke2024({ kommunenummer: "5540" }),
    { fylke: "Troms" },
    "8h: kommunenummer 5540 (Gáivuotna/Kåfjord) resolves to {fylke: 'Troms'} — kommunenummer path unaffected"
  );
  assertEq(
    resolveFylke2024({ kommunenummer: "5610" }),
    { fylke: "Finnmark" },
    "8i: kommunenummer 5610 (Kárášjohka/Karasjok) resolves to {fylke: 'Finnmark'} — kommunenummer path unaffected"
  );
  assertEq(
    resolveFylke2024({ kommunenummer: "5612" }),
    { fylke: "Finnmark" },
    "8j: kommunenummer 5612 (Guovdageaidnu/Kautokeino) resolves to {fylke: 'Finnmark'} — kommunenummer path unaffected"
  );

  // ── 9. resolveKommunenummerForName() (Trinn B) ───────────────────────
  assertEq(
    resolveKommunenummerForName("Oslo"),
    { kommunenummer: "0301" },
    "9a: unambiguous kommune name 'Oslo' resolves to {kommunenummer: '0301'}",
  );
  assertEq(
    resolveKommunenummerForName("tromso"),
    { kommunenummer: "5501" },
    "9b: case/diacritic-insensitive ('tromso' -> Tromsø's 5501)",
  );
  assertEq(
    resolveKommunenummerForName("  Oslo  "),
    { kommunenummer: "0301" },
    "9c: trims surrounding whitespace",
  );
  const heroyKnrResult = resolveKommunenummerForName("Herøy");
  assertTrue(
    "needs_review" in heroyKnrResult && heroyKnrResult.needs_review.startsWith("ambiguous_or_unknown_kommune:"),
    "9d: the same 'Herøy' name collision as resolveFylke2024() -> needs_review, never guessed",
  );
  const valerKnrResult = resolveKommunenummerForName("Våler");
  assertTrue(
    "needs_review" in valerKnrResult && valerKnrResult.needs_review.startsWith("ambiguous_or_unknown_kommune:"),
    "9e: the same 'Våler' name collision as resolveFylke2024() -> needs_review, never guessed",
  );
  assertEq(
    resolveKommunenummerForName("Ikke-En-Ekte-Kommune-Xyz"),
    { needs_review: "ambiguous_or_unknown_kommune:Ikke-En-Ekte-Kommune-Xyz" },
    "9f: an unrecognised kommune name -> needs_review:ambiguous_or_unknown_kommune:<value>",
  );
  assertEq(
    resolveKommunenummerForName(""),
    { needs_review: "ambiguous_or_unknown_kommune:" },
    "9g: blank name -> needs_review (never a guess)",
  );
  assertEq(
    resolveKommunenummerForName("   "),
    { needs_review: "ambiguous_or_unknown_kommune:" },
    "9h: whitespace-only name -> needs_review (never a guess)",
  );
  // Sami-name aliases, mirroring §8 above.
  assertEq(
    resolveKommunenummerForName("Kåfjord"),
    { kommunenummer: "5540" },
    "9i: Norwegian name 'Kåfjord' (vendored table only has Sami 'Gáivuotna') resolves to {kommunenummer: '5540'}",
  );
  assertEq(
    resolveKommunenummerForName("Karasjok"),
    { kommunenummer: "5610" },
    "9j: Norwegian name 'Karasjok' resolves to {kommunenummer: '5610'}",
  );
  assertEq(
    resolveKommunenummerForName("Kautokeino"),
    { kommunenummer: "5612" },
    "9k: Norwegian name 'Kautokeino' resolves to {kommunenummer: '5612'}",
  );
  assertEq(
    resolveKommunenummerForName("Gáivuotna"),
    { kommunenummer: "5540" },
    "9l: canonical Sami name 'Gáivuotna' still resolves directly, unaffected by the alias",
  );

  // ── 10. isKnownKommunenummer() (Trinn B fix-up) ──────────────────────
  assertTrue(
    isKnownKommunenummer("0301") === true,
    "10a: '0301' (Oslo, a real vendored-table code) -> true",
  );
  assertTrue(
    isKnownKommunenummer("5001") === true,
    "10b: '5001' (Trondheim, a real vendored-table code) -> true",
  );
  assertTrue(
    isKnownKommunenummer("9999") === false,
    "10c: '9999' (not in the vendored table) -> false",
  );
  assertTrue(
    isKnownKommunenummer("0000") === false,
    "10d: '0000' (garbage/placeholder code, not in the vendored table) -> false",
  );
  assertTrue(isKnownKommunenummer("") === false, "10e: blank string -> false (no lookup attempted)");
  assertTrue(isKnownKommunenummer("   ") === false, "10f: whitespace-only string -> false (no lookup attempted)");
  assertTrue(
    isKnownKommunenummer("  0301  ") === true,
    "10g: surrounding whitespace is trimmed before the lookup ('  0301  ' -> true)",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  console.log("── fylke-2024-migration: resolveFylke2024() unit tests ──");
  const r = runFylke2024MigrationTests({ log: true });
  console.log(`\nfylke-2024-migration: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
