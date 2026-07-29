/**
 * homepage-provenance-contact-extraction-fix.test.ts — pins two extraction
 * bugs reproduced against real live producer pages that caused the `rfb`
 * vertical's enrichment write path to be paused (2026-07-27,
 * controller/enrichment-write-pause.yaml) after a 20% field-mismatch rate:
 *
 *   1. extractAddress() let the poststed (town-name) capture swallow a
 *      trailing contact-block label word (e.g. "Osen Telefon" instead of
 *      "Osen") when the address is directly followed by a label with no
 *      punctuation boundary in between ("Valmsnes Gårdsysteri": address
 *      became "Valmen 54, 2460 Osen Telefon").
 *   2. extractPhone() accepted implausible 8-digit runs: a calendar-date
 *      shaped run (e.g. "20100101", stored for "Valmsnes Gårdsysteri") and
 *      an 8-digit substring of a longer 9-digit run such as a Norwegian
 *      org number (e.g. "927011840" leaking into "Dirdalstraen
 *      Gårdsutsalg"'s phone field).
 *
 * Two ways to run:
 *   1. Standalone: npx tsx src/routes/homepage-provenance-contact-extraction-fix.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runHomepageProvenanceContactExtractionFixTests() and folds its
 *      pass/fail counts into the `npm test` summary.
 *
 * extractPhone/extractAddress are pure functions of an html string (no DB,
 * no fetch), so this file mirrors the lightweight harness used by sibling
 * pure-helper test files (e.g. contact-normalizer.test.ts) rather than the
 * heavier in-memory-DB + router harness used by
 * homepage-provenance-selector-parking.test.ts.
 */

import { extractPhone, extractAddress } from "./marketplace";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runHomepageProvenanceContactExtractionFixTests(
  opts: { log?: boolean } = {},
): TestSummary {
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

  // ── Bug 1: extractAddress — trailing contact-label swallow ──────────────

  // Reproduces the real "Valmsnes Gårdsysteri" contact block: address
  // immediately followed by "Telefon:" with no punctuation boundary.
  const htmlTelefonLabel =
    "<html><body><p>Valmen 54, 2460 Osen Telefon: 980 18 027</p></body></html>";
  assertEq(
    extractAddress(htmlTelefonLabel),
    "Valmen 54, 2460 Osen",
    "addr-01: poststed stops before a trailing 'Telefon' label (does not become 'Osen Telefon')",
  );

  // Proves the label gate isn't hard-coded to "Telefon" — try "Kontakt" too.
  const htmlKontaktLabel =
    "<html><body><p>Valmen 54, 2460 Osen Kontakt: post@example.no</p></body></html>";
  assertEq(
    extractAddress(htmlKontaktLabel),
    "Valmen 54, 2460 Osen",
    "addr-02: poststed also stops before a trailing 'Kontakt' label",
  );

  // Positive control: a genuine two-word poststed-shaped capture where the
  // second word is NOT a contact-block label must still be returned intact
  // — the fix must not regress the (already narrow) two-word case, only
  // gate it against known contact labels.
  const htmlTwoWordPoststed =
    "<html><body><p>Skolegata 12, 4370 Egersund Vest og fjord</p></body></html>";
  assertEq(
    extractAddress(htmlTwoWordPoststed),
    "Skolegata 12, 4370 Egersund Vest",
    "addr-03: a genuine (non-label) second poststed word is still captured — fix is label-gated, not a blanket single-word cap",
  );

  // Ordinary single-word poststed, no trailing label nearby at all.
  const htmlPlainAddress =
    "<html><body><p>Storgata 1, 1400 Ski</p></body></html>";
  assertEq(
    extractAddress(htmlPlainAddress),
    "Storgata 1, 1400 Ski",
    "addr-04: plain single-word poststed with no adjacent label extracts unchanged",
  );

  // ── Bug 2: extractPhone — implausible 8-digit runs ───────────────────────

  // Date-shaped run followed later by a real phone number -> must skip the
  // date and return the real number (reproduces "Valmsnes Gårdsysteri").
  const htmlDateThenPhone =
    "<html><body><p>Etablert 20100101. Ring oss på 91234567 i dag.</p></body></html>";
  assertEq(
    extractPhone(htmlDateThenPhone),
    "91234567",
    "phone-01: a calendar-date-shaped run (20100101) is skipped in favour of the real phone number later in the text",
  );

  // ONLY a date-shaped run, nothing else phone-like -> null (never fabricate).
  const htmlDateOnly = "<html><body><p>Etablert 20100101.</p></body></html>";
  assertEq(
    extractPhone(htmlDateOnly),
    null,
    "phone-02: text containing only a date-shaped run returns null, not the date",
  );

  // 9-digit org number only (no separately-present real phone) -> must NOT
  // return any 8-digit substring of it (reproduces "Dirdalstraen Gårdsutsalg").
  const htmlOrgNumberOnly =
    "<html><body><p>Org.nr: 927011840</p></body></html>";
  assertEq(
    extractPhone(htmlOrgNumberOnly),
    null,
    "phone-03: a lone 9-digit org-number-shaped run yields null, not an 8-digit slice of it",
  );

  // 9-digit org number PLUS a separately-present real phone elsewhere ->
  // must return the real phone, not a slice of the org number.
  const htmlOrgNumberAndPhone =
    "<html><body><p>Org.nr: 927011840. Telefon: 45678901.</p></body></html>";
  assertEq(
    extractPhone(htmlOrgNumberAndPhone),
    "45678901",
    "phone-04: with a 9-digit org number AND a real phone present, the real phone (not a slice of the org number) is returned",
  );

  // Positive control: an ordinary valid 8-digit Norwegian phone number in a
  // normal sentence, not adjacent to any other digits, must still work.
  const htmlOrdinaryPhone =
    "<html><body><p>Velkommen til gården! Ring 91234567 for bestilling.</p></body></html>";
  assertEq(
    extractPhone(htmlOrdinaryPhone),
    "91234567",
    "phone-05: an ordinary isolated 8-digit phone number still extracts correctly (fix doesn't break the common case)",
  );

  // ── Bug 3 (round-2 regression fix): extractPhone — prefix glued directly
  //    to the digits with no separator ─────────────────────────────────────

  // "+47" glued directly onto the 8 digits, zero separating characters —
  // this exact shape regressed to null in round 1 (the `before` neighbour
  // check was inspecting the prefix's own last digit instead of the
  // character before the whole match).
  const htmlPlusPrefixGlued = "<html><body><p>Ring +4791234567 na</p></body></html>";
  assertEq(
    extractPhone(htmlPlusPrefixGlued),
    "91234567",
    "phone-06: a '+47' prefix glued directly to the digits (no separator) still extracts the phone",
  );

  // "0047" glued directly onto the 8 digits — same shape, different prefix.
  const htmlZeroPrefixGlued = "<html><body><p>Ring 004791234567 na</p></body></html>";
  assertEq(
    extractPhone(htmlZeroPrefixGlued),
    "91234567",
    "phone-07: a '0047' prefix glued directly to the digits (no separator) still extracts the phone",
  );

  // "+47" glued prefix in a different sentence shape (label prefix, no
  // trailing text) — guards against the fix being overly narrow to one
  // surrounding context.
  const htmlPlusPrefixGluedLabel = "<html><body><p>Telefon: +4791234567</p></body></html>";
  assertEq(
    extractPhone(htmlPlusPrefixGluedLabel),
    "91234567",
    "phone-08: a '+47' prefix glued to the digits after a 'Telefon:' label still extracts the phone",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const summary = runHomepageProvenanceContactExtractionFixTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  if (summary.failed > 0) process.exit(1);
}
