/**
 * dental-wrong-entity-retro.test.ts — unit tests for the pure planning
 * module (src/services/dental-wrong-entity-retro.ts), dev-request
 * 2026-09-09-dental-non-clinic-retro-sanitize.
 *
 * This is the regression pin for the "orto" substring trap described in the
 * module's own header comment: DREVELIN ORTOPEDI SØR AS's own om_oss text
 * says (verbatim, Norwegian) it is NOT a dental clinic, and that text
 * contains "orto" (ortoped/ortopediteknisk/ortopediske) several times — a
 * word that IS in dental-catalog-class.ts's DENTAL_NAME_WORDS (the NAME
 * classifier's list). If DENTAL_CONTENT_SIGNAL_WORDS were ever "simplified"
 * back to reusing that list, this file fails loudly (wes-retro-01/02 below).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-wrong-entity-retro.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runDentalWrongEntityRetroTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

import {
  NON_DENTAL_SWEPT_NACE_CODES,
  DENTAL_CONTENT_SIGNAL_WORDS,
  hasDentalContentSignal,
  planWrongEntityRetroSanitize,
  type WrongEntityRetroCandidateRow,
} from "./dental-wrong-entity-retro";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalWrongEntityRetroTests(opts: { log?: boolean } = {}): TestSummary {
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

  try {
    // ── NACE codes: exactly the Brreg sweep's 3, not a new guess ───────────
    assertEq(
      [...NON_DENTAL_SWEPT_NACE_CODES],
      ["86.230", "86.221", "32.500"],
      "retro-00: NON_DENTAL_SWEPT_NACE_CODES is exactly the 3 Brreg-sweep codes",
    );

    // ── the "orto" trap: DENTAL_CONTENT_SIGNAL_WORDS must NOT contain the
    // ambiguous words from DENTAL_NAME_WORDS that collide with genuine
    // non-dental (orthopedic/aesthetic) content ─────────────────────────────
    for (const ambiguous of ["orto", "implant", "protet", "klinikk", "smil"]) {
      assertTrue(
        !DENTAL_CONTENT_SIGNAL_WORDS.includes(ambiguous),
        `retro-01: DENTAL_CONTENT_SIGNAL_WORDS excludes ambiguous word "${ambiguous}"`,
      );
    }

    // ── (a) DREVELIN ORTOPEDI SØR AS — real production row, naeringskode
    // 32.500, enrichment_state='enriched'. Its own om_oss (written by
    // enrichment) explicitly DENIES being a dental clinic, but contains both
    // traps this module exists to survive: "orto" (a substring of
    // ortoped/ortopediteknisk/ortopediske, which IS in dental-catalog-
    // class.ts's DENTAL_NAME_WORDS) AND "ikke en tannklinikk" (whose own
    // "tannklinikk" contains "tann", a word THIS module's own
    // DENTAL_CONTENT_SIGNAL_WORDS correctly includes). REAL VERBATIM
    // production text, not an excerpt — this is the literal regression pin
    // for both traps at once. MUST be flagged. ─────────────────────────────
    const drevelinOmOss =
      "Drevelin Ortopedi sør AS, med avdeling i Kristiansand, ble etablert i 2018 og holder til i " +
      "lokaler på Lund. Dette er ikke en tannklinikk, men en ortopediteknisk virksomhet som " +
      "produserer og tilpasser ortopediske hjelpemidler. Selskapet er en del av Drevelin-konsernet... " +
      "Tilbudet omfatter ortoser, proteser (arm- og benproteser), ortopedisk sydd fottøy, " +
      "spesialsko, fotsenger, innleggssåler og konsultasjon hos ortoped...";
    const drevelinRow: WrongEntityRetroCandidateRow = {
      id: "drevelin-1",
      navn: "DREVELIN ORTOPEDI SØR AS",
      naeringskode: "32.500",
      om_oss: drevelinOmOss,
      treatments: null,
    };
    assertEq(
      hasDentalContentSignal(drevelinRow),
      false,
      "retro-02: DREVELIN's real verbatim 'orto'+'ikke en tannklinikk' denial text does NOT register a false dental signal",
    );
    const drevelinPlan = planWrongEntityRetroSanitize([drevelinRow]);
    assertEq(drevelinPlan.length, 1, "retro-03: DREVELIN (real verbatim text) is flagged by planWrongEntityRetroSanitize");
    assertEq(drevelinPlan[0].id, "drevelin-1", "retro-04: DREVELIN plan entry has the right id");

    // ── (a2) adversarial: negation-stripping must NOT overreach. A genuine
    // dental clinic whose om_oss also contains an UNRELATED "ikke" (not
    // attached to a dental-identity word) must still be detected normally —
    // the "tannklinikk" later in the same sentence is untouched. ───────────
    const adversarialNegationRow: WrongEntityRetroCandidateRow = {
      id: "adversarial-ikke-1",
      navn: "LØRDAGSTANN AS",
      naeringskode: "86.230",
      om_oss: "Vi tilbyr ikke akuttbehandling på lørdager, men er en fullverdig tannklinikk for hele familien.",
      treatments: null,
    };
    assertEq(
      hasDentalContentSignal(adversarialNegationRow),
      true,
      "retro-04b: an unrelated 'ikke' (not attached to a dental-identity word) does not suppress a real 'tannklinikk' elsewhere in the same text",
    );
    assertEq(
      planWrongEntityRetroSanitize([adversarialNegationRow]).length,
      0,
      "retro-04c: genuine dental clinic with an unrelated 'ikke' in its om_oss is NOT flagged",
    );
    assertEq(drevelinPlan[0].reason, "nace_32.500_no_dental_signal", "retro-05: DREVELIN plan reason cites its NACE code");

    // ── (b) KLINIKK FØRDE AS — naeringskode 86.221, aesthetic/cosmetic
    // medicine clinic, NAME contains "klinikk" but zero dental content ─────
    const klinikkFordeRow: WrongEntityRetroCandidateRow = {
      id: "klinikk-forde-1",
      navn: "KLINIKK FØRDE AS",
      naeringskode: "86.221",
      om_oss:
        "Klinikk Førde tilbyr Restylane, Profhilo, laser- og IPL-behandling, gynekologi, " +
        "plastikkirurgi og ortopedi. Våre spesialister gir deg et friskere og mer uthvilt utseende.",
      treatments: JSON.stringify(["Restylane", "Profhilo", "laser", "IPL", "plastikkirurgi", "ortopedi"]),
    };
    assertEq(
      hasDentalContentSignal(klinikkFordeRow),
      false,
      "retro-06: KLINIKK FØRDE's own name/content does NOT register a false dental signal",
    );
    const klinikkFordePlan = planWrongEntityRetroSanitize([klinikkFordeRow]);
    assertEq(klinikkFordePlan.length, 1, "retro-07: KLINIKK FØRDE is flagged by planWrongEntityRetroSanitize");
    assertEq(klinikkFordePlan[0].reason, "nace_86.221_no_dental_signal", "retro-08: KLINIKK FØRDE plan reason cites its NACE code");

    // ── (c) at least 10 real-dental-clinic-style fixtures across all 3 NACE
    // codes → NONE flagged (0 false positives, AC3) ────────────────────────
    const dentalFixtures: WrongEntityRetroCandidateRow[] = [
      { id: "d1", navn: "SENTRUM TANNLEGE AS", naeringskode: "86.230", om_oss: "Vi er en moderne tannklinikk i sentrum.", treatments: null },
      { id: "d2", navn: "NORDBY TANNHELSE AS", naeringskode: "86.230", om_oss: "Tannhelse for hele familien siden 1998.", treatments: null },
      { id: "d3", navn: "OSLO KJEVEORTOPED AS", naeringskode: "86.221", om_oss: "Spesialist i kjeveortopedi for barn og unge.", treatments: null },
      { id: "d4", navn: "BERGEN ODONTOLOGI AS", naeringskode: "86.230", om_oss: "Odontologisk klinikk med bred kompetanse.", treatments: null },
      { id: "d5", navn: "A. HANSEN AS", naeringskode: "86.230", om_oss: "Vi utfører endodonti og rotfyllingsbehandling.", treatments: null },
      { id: "d6", navn: "B. OLSEN AS", naeringskode: "86.230", om_oss: "Behandling av periodonti og tannkjøttsykdom.", treatments: null },
      { id: "d7", navn: "MUNNHELSE NORD AS", naeringskode: "86.230", om_oss: "Fokus på god munnhelse for hele familien.", treatments: null },
      { id: "d8", navn: "DR. SMITH DENTIST AS", naeringskode: "86.230", om_oss: "English-speaking dentist in Oslo.", treatments: null },
      { id: "d9", navn: "TANNTEKNISK LAB AS", naeringskode: "32.500", om_oss: "Tanntekniker-laboratorium som leverer proteser og kroner til tannklinikker.", treatments: null },
      { id: "d10", navn: "C. PEDERSEN AS", naeringskode: "86.230", om_oss: "Generell klinikk uten dental-ord i om oss, men se treatments.", treatments: JSON.stringify(["tannrens", "fylling"]) },
      { id: "d11", navn: "DENTAL CARE VEST AS", naeringskode: "86.221", om_oss: "Dental care and cosmetic dentistry.", treatments: null },
      { id: "d12", navn: "D. JOHANSEN DENT. AS", naeringskode: "86.230", om_oss: "Privatpraktiserende tannlegekontor.", treatments: null },
    ];
    assertTrue(dentalFixtures.length >= 10, "retro-09: at least 10 real-dental-clinic fixtures defined");
    const usedCodes = new Set(dentalFixtures.map((f) => f.naeringskode));
    for (const code of NON_DENTAL_SWEPT_NACE_CODES) {
      assertTrue(usedCodes.has(code), `retro-10: dental fixtures span NACE ${code}`);
    }
    for (const fixture of dentalFixtures) {
      assertEq(hasDentalContentSignal(fixture), true, `retro-11 (${fixture.id}): genuine dental fixture registers a dental content signal`);
    }
    const dentalPlan = planWrongEntityRetroSanitize(dentalFixtures);
    assertEq(dentalPlan.length, 0, "retro-12: zero false positives — no genuine dental-clinic fixture is flagged");

    // ── mixed batch: only the non-dental rows are flagged ──────────────────
    const mixedPlan = planWrongEntityRetroSanitize([drevelinRow, klinikkFordeRow, ...dentalFixtures]);
    assertEq(mixedPlan.length, 2, "retro-13: mixed batch flags exactly the 2 non-dental rows");
    assertEq(
      mixedPlan.map((p) => p.id).sort(),
      ["drevelin-1", "klinikk-forde-1"],
      "retro-14: mixed batch flags exactly DREVELIN + KLINIKK FØRDE, nothing else",
    );

    // ── null-safety ──────────────────────────────────────────────────────────
    assertEq(
      hasDentalContentSignal({ navn: "SOMETHING AS", om_oss: null, treatments: null }),
      false,
      "retro-15: null om_oss/treatments handled without throwing",
    );
    assertEq(
      hasDentalContentSignal({ navn: "TANNLEGE X AS", om_oss: null, treatments: null }),
      true,
      "retro-16: dental word in navn alone is enough, even with null om_oss/treatments",
    );

    if (log) console.log(`  dental-wrong-entity-retro: OK (${passed} assertions)`);
  } catch (err) {
    failed++;
    failures.push(
      `dental-wrong-entity-retro: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`,
    );
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/dental-wrong-entity-retro.test.ts`
if (require.main === module) {
  const summary = runDentalWrongEntityRetroTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
