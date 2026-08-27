/**
 * contact-normalizer.test.ts — unit tests for the conservative address/phone
 * normalizer (services/contact-normalizer.ts) and its integration into the
 * cross-source agreement check (services/cross-source-validator.ts).
 *
 * orchestrator-pr-13 (2026-06-15).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/contact-normalizer.test.ts
 *   2. Wired into the gate: tests/test.ts imports runContactNormalizerTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 *
 * These pin the SAFETY invariant: formatting-only differences are recognised as
 * agreement, but genuinely different street/number/letter/postcode/phone values
 * must STILL conflict (so a wrong/duplicate producer can never be promoted).
 */

import {
  normalizeAddress,
  normalizePhone,
  addressesMatch,
  phonesMatch,
  splitAddress,
  isDisplayablePhone,
  national8,
  classifyPhoneForWrite,
} from "./contact-normalizer";
import { crossSourceAgreement, type ProvenanceRecord } from "./cross-source-validator";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runContactNormalizerTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── normalizePhone ───────────────────────────────────────────────────────────
  {
    assertEq(normalizePhone("+47 911 22 333"), "91122333", "normalizePhone strips +47 and spaces");
    assertEq(normalizePhone("0047 911 22 333"), "91122333", "normalizePhone strips 0047");
    assertEq(normalizePhone("911 22 333"), "91122333", "normalizePhone strips spaces");
    assertEq(normalizePhone("(91) 12-23.33"), "91122333", "normalizePhone strips parens/dash/dot");
  }

  // ── phonesMatch: formatting-equivalent + negatives ───────────────────────────
  {
    assertTrue(phonesMatch("+47 911 22 333", "91122333"), "phonesMatch: +47 spaced ≡ bare 8-digit");
    assertTrue(phonesMatch("0047 91122333", "91 12 23 33"), "phonesMatch: 0047 ≡ spaced national");
    assertTrue(phonesMatch("+4791122333", "91122333"), "phonesMatch: +47 glued ≡ national");
    assertTrue(!phonesMatch("91122333", "91122334"), "phonesMatch NEG: one differing digit ⇒ conflict");
    assertTrue(!phonesMatch("91122333", "9112233"), "phonesMatch NEG: 7-digit partial ⇒ no match");
    assertTrue(!phonesMatch("91122333", ""), "phonesMatch NEG: empty ⇒ no match");
  }

  // ── isDisplayablePhone: render-guard (wrong_contact_rate = 0) ────────────────
  {
    assertTrue(isDisplayablePhone("911 22 333"), "isDisplayablePhone: valid 8-digit local number");
    assertTrue(isDisplayablePhone("+47 911 22 333"), "isDisplayablePhone: valid +47-prefixed number");
    assertTrue(!isDisplayablePhone("+47 19 09 49"), "isDisplayablePhone NEG: real failing case (6 national digits)");
    assertTrue(!isDisplayablePhone(""), "isDisplayablePhone NEG: empty string");
    assertTrue(!isDisplayablePhone(null), "isDisplayablePhone NEG: null");
    assertTrue(!isDisplayablePhone(undefined), "isDisplayablePhone NEG: undefined");
    assertTrue(!isDisplayablePhone("ring oss i dag"), "isDisplayablePhone NEG: garbage text");
  }

  // ── national8: leading-digit rule (W33 2026-08-10 — Norwegian numbering plan:
  //    8-digit subscriber numbers start 2-9, never 0/1) ─────────────────────────
  {
    assertEq(national8("02812441"), null, "national8 NEG: W33 breach value 02812441 (leading 0) rejected");
    assertEq(national8("12345678"), null, "national8 NEG: leading 1 rejected (short-code range)");
    assertEq(national8("4702812441"), null, "national8 NEG: 47-prefixed value with leading-0 national part rejected");
    assertEq(national8("40190940"), "40190940", "national8 POS: Myrdal Gård's real number (leading 4) accepted");
    assertEq(national8("21234567"), "21234567", "national8 POS: leading 2 (geographic) accepted");
    assertEq(national8("80012345"), "80012345", "national8 POS: leading 8 (special services) accepted");
    assertEq(national8("4791122333"), "91122333", "national8 POS: 47-prefixed valid number still reduces");
    assertTrue(!isDisplayablePhone("02812441"), "isDisplayablePhone NEG: leading-0 value never rendered");
    const w33 = classifyPhoneForWrite("02812441", "912345678");
    assertTrue(w33.rejected && w33.failedRules.includes("shape"), "classifyPhoneForWrite: 02812441 rejected on shape rule");
    assertTrue(!phonesMatch("02812441", "02812441"), "phonesMatch NEG: two identical invalid values never vacuously agree");
  }

  // ── normalizeAddress ─────────────────────────────────────────────────────────
  {
    assertEq(normalizeAddress("Bjørkeveien 20B"), "bjørkeveien 20b", "normalizeAddress lowercases");
    assertEq(normalizeAddress("Storgata  1 ,  0150  Oslo"), "storgata 1, 0150 oslo", "normalizeAddress collapses ws + comma spacing");
    assertEq(normalizeAddress("Storgata 1."), "storgata 1", "normalizeAddress strips trailing punctuation");
  }

  // ── normalizeAddress: dev-request 2026-08-27-verifier-agree-false-adresse-
  //    normalisering (house-number-letter spacing + veien/vegen spelling) ──────
  {
    assertEq(normalizeAddress("Austreimslia 12 a"), "austreimslia 12a", "normalizeAddress collapses space before house-letter suffix");
    assertEq(normalizeAddress("Austreimslia 12a"), "austreimslia 12a", "normalizeAddress leaves glued house-letter suffix unchanged");
    assertEq(normalizeAddress("Liagrendveien 262"), "liagrendveien 262", "normalizeAddress leaves bokmål -veien unchanged");
    assertEq(normalizeAddress("Liagrendvegen 262"), "liagrendveien 262", "normalizeAddress canonicalizes -vegen to -veien");
    assertEq(normalizeAddress("Kirkeveg 3"), "kirkevei 3", "normalizeAddress canonicalizes bare -veg to -vei");
    // Regression guard: gate/gata is deliberately NOT touched (see
    // canonicalizeAddressVariants' comment) — must not regress this existing pin.
    assertEq(normalizeAddress("Storgata  1 ,  0150  Oslo"), "storgata 1, 0150 oslo", "normalizeAddress does not touch -gata (unevidenced, out of scope)");
  }

  // ── splitAddress: postal tail extraction ─────────────────────────────────────
  {
    assertEq(splitAddress("bjørkeveien 20b, 1940 bjørkelangen"), { street: "bjørkeveien 20b", postcode: "1940" }, "splitAddress separates street + postcode");
    assertEq(splitAddress("bjørkeveien 20b"), { street: "bjørkeveien 20b", postcode: null }, "splitAddress: street only → null postcode");
  }

  // ── addressesMatch: positives (formatting / prefix / postal-suffix) ───────────
  {
    assertTrue(addressesMatch("Bjørkeveien 20B", "bjørkeveien 20b"), "addressesMatch: case-only ⇒ match");
    assertTrue(addressesMatch("Bjørkeveien 20B", "Bjørkeveien 20B, 1940 Bjørkelangen"), "addressesMatch: postal-suffix appended ⇒ match");
    assertTrue(addressesMatch("Storgata 1, 0150 Oslo", "Storgata 1"), "addressesMatch: full vs street-only (prefix) ⇒ match");
    assertTrue(addressesMatch("Nygårdsveien 10", "Nygårdsveien 10, 7320 Fannrem"), "addressesMatch: street-only ⊂ street+postcode ⇒ match");
  }

  // ── addressesMatch: negatives (genuine conflicts MUST still flag) ─────────────
  {
    assertTrue(!addressesMatch("Storgata 1", "Storgata 10"), "addressesMatch NEG: different house number");
    assertTrue(!addressesMatch("Storgata 1A", "Storgata 1B"), "addressesMatch NEG: different house letter");
    assertTrue(!addressesMatch("Storgata 1", "Lillegata 1"), "addressesMatch NEG: different street name");
    assertTrue(!addressesMatch("Storgata 1, 0150 Oslo", "Storgata 1, 5003 Bergen"), "addressesMatch NEG: same street, conflicting postcode");
    assertTrue(!addressesMatch("Storgata 1", ""), "addressesMatch NEG: empty side");
  }

  // ── Integration: validator promotes formatting-only agreement ─────────────────
  // Two Tier-A sources (homepage + google_places). Pre-PR-13, exact-normalized
  // phone grouping would key "+47 911 22 333" and "91122333" differently and the
  // field would stay review_required. With the relaxation it agrees.
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      phone: [
        { value: "+47 911 22 333", source_type: "homepage", fetched_at: "2026-06-10T00:00:00Z" },
        { value: "91122333", source_type: "google_places", fetched_at: "2026-06-10T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "phone");
    assertEq(res.verdict, "pool_eligible", "integration: formatting-only phone ⇒ pool_eligible");
    assertTrue(res.agree === true, "integration: formatting-only phone ⇒ agree=true");
  }

  // ── Integration: genuinely different phone STILL conflicts ────────────────────
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      phone: [
        { value: "+47 911 22 333", source_type: "homepage", fetched_at: "2026-06-10T00:00:00Z" },
        { value: "+47 911 22 334", source_type: "google_places", fetched_at: "2026-06-10T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "phone");
    assertEq(res.verdict, "review_required", "integration: different phone ⇒ review_required");
    assertTrue(res.agree === false, "integration: different phone ⇒ agree=false");
  }

  // ── Integration: genuinely different street (no postcode) STILL conflicts ─────
  // Guards the prefix path: "Storgata 1" vs "Storgata 10" must NOT vacuously merge.
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      address: [
        { value: "Storgata 1", source_type: "homepage", fetched_at: "2026-06-10T00:00:00Z" },
        { value: "Storgata 10", source_type: "google_places", fetched_at: "2026-06-10T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "address");
    assertEq(res.verdict, "review_required", "integration: different house number ⇒ review_required");
  }

  // ── Integration: conflicting postcode (same street) STILL conflicts ───────────
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      address: [
        { value: "Storgata 1, 0150 Oslo", source_type: "homepage", fetched_at: "2026-06-10T00:00:00Z" },
        { value: "Storgata 1, 5003 Bergen", source_type: "google_places", fetched_at: "2026-06-10T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "address");
    assertEq(res.verdict, "review_required", "integration: conflicting postcode ⇒ review_required");
  }

  // ── Integration: house-number-letter spacing agreement ───────────────────────
  // Real pattern (Li Lynghonning, enrichment-reports/2026-08-27.md): two
  // homepage-provenance passes wrote "12 a" and "12a" for the same building.
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      address: [
        { value: "Austreimslia 12 a, 6995 Kyrkjebø", source_type: "homepage", fetched_at: "2026-08-27T00:00:00Z" },
        { value: "Austreimslia 12a, 6995 Kyrkjebø", source_type: "google_places", fetched_at: "2026-08-27T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "address");
    assertEq(res.verdict, "pool_eligible", "integration: house-number-letter spacing only ⇒ pool_eligible");
    assertTrue(res.agree === true, "integration: house-number-letter spacing only ⇒ agree=true");
  }

  // ── Integration: veien/vegen spelling agreement ───────────────────────────────
  // Real pattern (Lien Gård, enrichment-reports/2026-08-27.md): homepage wrote
  // the bokmål "-veien" form, google_places the dialectal "-vegen" form, same
  // street + house number + postcode.
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      address: [
        { value: "Liagrendveien 262, 3812 Akkerhaugen", source_type: "homepage", fetched_at: "2026-08-27T00:00:00Z" },
        { value: "Liagrendvegen 262, 3812 Akkerhaugen, Norge", source_type: "google_places", fetched_at: "2026-08-27T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "address");
    assertEq(res.verdict, "pool_eligible", "integration: veien/vegen spelling only ⇒ pool_eligible");
    assertTrue(res.agree === true, "integration: veien/vegen spelling only ⇒ agree=true");
  }

  // ── Integration: street-suffix ELISION still conflicts (known non-fix) ───────
  // Real pattern (Borgund Chili, enrichment-reports/2026-08-27.md): one source
  // drops the "-vegen" suffix entirely ("Vindhella" vs "Vindhellavegen"), which
  // is a materially different comparison problem (whole-token elision, not a
  // spelling/spacing variant) and is deliberately OUT of scope for this fix —
  // pins that it correctly still stays review_required rather than silently
  // starting to merge on a much weaker signal than the two cases above.
  {
    const fp: Record<string, ProvenanceRecord[]> = {
      address: [
        { value: "Vindhella 717, 6888 Borgund", source_type: "homepage", fetched_at: "2026-08-27T00:00:00Z" },
        { value: "Vindhellavegen 717, 6888 Borgund, Norge", source_type: "google_places", fetched_at: "2026-08-27T00:00:00Z" },
      ],
    };
    const res = crossSourceAgreement(fp, "address");
    assertEq(res.verdict, "review_required", "integration: street-suffix elision is NOT merged (out of scope) ⇒ review_required");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/contact-normalizer.test.ts`
// (require.main === module is the CJS entrypoint check; tsconfig compiles to CJS.)
if (require.main === module) {
  console.log("── contact-normalizer unit tests ──");
  const r = runContactNormalizerTests({ log: true });
  console.log(`\ncontact-normalizer: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
