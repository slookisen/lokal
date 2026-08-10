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

  // ── Bug 3 (W33 2026-08-10): leading-digit rule — 8-digit runs starting 0/1
  //    violate the Norwegian numbering plan and must never be extracted ─────

  // The exact live breach value: "02812441" was extracted from a producer
  // page and written as phone (Myrdal Gård Ysteri) — real number 40190940.
  const htmlLeadingZeroOnly = "<html><body><p>Ref 02812441</p></body></html>";
  assertEq(
    extractPhone(htmlLeadingZeroOnly),
    null,
    "phone-09: an 8-digit run starting with 0 (W33 breach value) is never extracted",
  );

  // Leading-0 junk first, real phone later — the scan must SKIP the junk and
  // keep going, not give up (mirrors phone-01's date-then-phone shape).
  const htmlLeadingZeroThenPhone =
    "<html><body><p>Ref 02812441</p><p>Ring eller SMS 40190940</p></body></html>";
  assertEq(
    extractPhone(htmlLeadingZeroThenPhone),
    "40190940",
    "phone-10: leading-0 junk is skipped and the real phone later in the page is extracted",
  );

  // Leading-1 variant (short-code range) — same rule, other invalid lead.
  const htmlLeadingOneOnly = "<html><body><p>Sak 12345678</p></body></html>";
  assertEq(
    extractPhone(htmlLeadingOneOnly),
    null,
    "phone-11: an 8-digit run starting with 1 is never extracted",
  );

  // ── Bug 4 (slice D, 2026-08-10): extractPhone — context-corroboration
  //    gate. Real repro: Austrått — a valid-SHAPED but WRONG number
  //    ("79656569") was written as phone because it passed every shape
  //    check (W33 leading digit, not a date, not a digit-run substring) yet
  //    was scraped from unrelated page content, nowhere near a contact
  //    label. ─────────────────────────────────────────────────────────────

  // The exact live breach shape: a syntactically valid 8-digit run sitting
  // in unrelated footer/widget text with no contact-context label anywhere
  // nearby -> must NOT be extracted.
  const htmlAustrattNoContext =
    "<html><body><footer>Levert av InfoWeb Solutions. Kundenr 79656569 for support hos leverandøren.</footer></body></html>";
  assertEq(
    extractPhone(htmlAustrattNoContext),
    null,
    "phone-12 (Austrått repro): a valid-shaped 8-digit run with no nearby contact-label context is NOT extracted",
  );

  // Same unrelated number PLUS a real, properly-labelled phone elsewhere on
  // the page -> the scan must skip the uncorroborated one and return the
  // labelled real number instead.
  const htmlAustrattWithRealPhoneElsewhere =
    "<html><body>" +
    "<footer>Levert av InfoWeb Solutions. Kundenr 79656569 for support hos leverandøren.</footer>" +
    "<p>Ring oss på Tlf: 91234567</p>" +
    "</body></html>";
  assertEq(
    extractPhone(htmlAustrattWithRealPhoneElsewhere),
    "91234567",
    "phone-13: uncorroborated valid-shaped run is skipped in favour of the properly-labelled real phone later on the page",
  );

  // Positive control: "Kontakt" as the nearby label (not just Tlf/Telefon/Ring).
  const htmlKontaktLabelPhone = "<html><body><p>Kontakt: 91234567</p></body></html>";
  assertEq(
    extractPhone(htmlKontaktLabelPhone),
    "91234567",
    "phone-14: a 'Kontakt:' label counts as valid contact context",
  );

  // ── Bug 4 code-review follow-up (2026-08-10): bare "ring"/"kontakt"
  //    anywhere in the window is TOO permissive — both are common generic
  //    Norwegian words unrelated to phones ("Ring 3" = a ring road;
  //    "kontakt" in an unrelated sense). The reviewer reproduced the exact
  //    Austrått bug class through this gap; these fixtures pin the fix. ────

  // The reviewer's exact repro: "Ring 3" (a road) sits within the window of
  // an unrelated 8-digit reference number ("Kundenr ...") — must NOT be
  // extracted. A bare "\bring\b" mention is no longer sufficient context.
  const htmlRingRoadFalsePositive =
    "<html><body><p>Kjør Ring 3 til avkjørsel. Kundenr 79656569 for support.</p></body></html>";
  assertEq(
    extractPhone(htmlRingRoadFalsePositive),
    null,
    "phone-15 (reviewer repro): 'Ring 3' (a road reference, not a call-to-action) does NOT corroborate an unrelated 8-digit reference number",
  );

  // Same road-reference false lead PLUS a real "Ring nå på <nummer>"
  // call-to-action elsewhere on the page -> the scan must skip the
  // uncorroborated one and return the real, properly-flagged number.
  const htmlRingRoadThenRealCta =
    "<html><body>" +
    "<p>Kjør Ring 3 til avkjørsel. Kundenr 79656569 for support.</p>" +
    "<p>Ring nå på 91234567.</p>" +
    "</body></html>";
  assertEq(
    extractPhone(htmlRingRoadThenRealCta),
    "91234567",
    "phone-16: 'Ring 3' road reference is skipped; the real 'Ring nå på <nummer>' call-to-action elsewhere is extracted",
  );

  // A bare "kontakt" mention with no colon and no direct adjacency to the
  // candidate digits must NOT corroborate an unrelated number either.
  const htmlBareKontaktFalsePositive =
    "<html><body><p>Vær forsiktig ved kontakt med strøm. Serienr 55667788 på enheten.</p></body></html>";
  assertEq(
    extractPhone(htmlBareKontaktFalsePositive),
    null,
    "phone-17: a bare 'kontakt' mention (no colon, not adjacent) does NOT corroborate an unrelated 8-digit serial number",
  );

  // Positive control: the long-form "Kontaktinformasjon:" heading (aligned
  // with stripLeadingContactLabel's label vocabulary) still counts as valid
  // context when used as an actual heading.
  const htmlKontaktinformasjonHeading =
    "<html><body><p>Kontaktinformasjon: 91234567</p></body></html>";
  assertEq(
    extractPhone(htmlKontaktinformasjonHeading),
    "91234567",
    "phone-18: 'Kontaktinformasjon:' (long-form heading) counts as valid contact context",
  );

  // Positive control: "Ring 91234567" — the direct call-to-action shape
  // (label immediately, adjacently attached to the real candidate) must
  // still work after narrowing the bare-"ring" window match to adjacency.
  const htmlRingDirectlyAdjacent = "<html><body><p>Ring 91234567 i dag!</p></body></html>";
  assertEq(
    extractPhone(htmlRingDirectlyAdjacent),
    "91234567",
    "phone-19: 'Ring <nummer>' direct adjacency still extracts (doesn't regress the common call-to-action shape)",
  );

  // ── Bug 4 code-review follow-up ROUND 2 (2026-08-10): round 1 narrowed
  //    "Kontakt"/"Ring" to require heading/CTA usage, but still tested that
  //    usage against the WHOLE 40/20-char WINDOW — so a real "Kontakt:"
  //    heading or "Ring oss" CTA sitting a whole unrelated clause away from
  //    an unrelated reference number still wrongly corroborated it. Fix:
  //    "Kontakt"/"Ring" now require DIRECT, IMMEDIATE adjacency to the
  //    candidate digits (see PHONE_CONTEXT_ADJACENT) — not "found somewhere
  //    in the window". These fixtures pin the round-2 fix. ─────────────────

  // The reviewer's exact repro 1: a real "Kontakt:" HEADING, but for a
  // DIFFERENT block — the digits that actually follow are a property/
  // matrikkel number ("Gårds- og bruksnr"), not a phone. Must NOT extract.
  const htmlKontaktHeadingWrongBlock =
    '<html><body><div class="kontakt-boks"><h3>Kontakt:</h3><p>Gårds- og bruksnr: 79656569. Se kart for veibeskrivelse.</p></div></body></html>';
  assertEq(
    extractPhone(htmlKontaktHeadingWrongBlock),
    null,
    "phone-20 (reviewer repro): a 'Kontakt:' heading elsewhere on the page does NOT corroborate an unrelated matrikkel-shaped number in a different block",
  );

  // The reviewer's exact repro 2: real "Ring oss" CTA text, but for a
  // DIFFERENT number entirely (an order/booking reference in the footer).
  // Must NOT extract.
  const htmlRingCtaWrongNumber =
    "<html><body><button>Ring oss for mer info</button><footer>Bestillingsref: 79656569</footer></body></html>";
  assertEq(
    extractPhone(htmlRingCtaWrongNumber),
    null,
    "phone-21 (reviewer repro): 'Ring oss' CTA text elsewhere on the page does NOT corroborate an unrelated order-reference number",
  );

  // Simpler variant of repro 1: "Kontakt:" heading followed by an unrelated
  // sentence, then an order number.
  const htmlKontaktThenUnrelatedOrderNr =
    "<html><body><p>Kontakt: se venstre meny. Ordrenr 79656569 registrert.</p></body></html>";
  assertEq(
    extractPhone(htmlKontaktThenUnrelatedOrderNr),
    null,
    "phone-22: 'Kontakt:' followed by an unrelated sentence and an order number does NOT extract the order number",
  );

  // Simpler variant of repro 2: "Ring oss" CTA followed by an unrelated
  // sentence, then an org-nr.
  const htmlRingOssThenUnrelatedOrgNr =
    "<html><body><p>Ring oss i dag. Org.nr 79656569 finner du i registeret.</p></body></html>";
  assertEq(
    extractPhone(htmlRingOssThenUnrelatedOrgNr),
    null,
    "phone-23: 'Ring oss' followed by an unrelated sentence and an org-nr does NOT extract the org-nr",
  );

  // ── Bug 5 (slice D, 2026-08-10): extractAddress — leading contact-label /
  //    company-name box glued onto the street. Real repro: Oceanfood AS —
  //    a flattened "Kontakt" heading immediately followed by the producer's
  //    own company name (ending in a legal-entity suffix), with no
  //    punctuation boundary before the real street, got swallowed into the
  //    street capture. ─────────────────────────────────────────────────────

  const htmlOceanfoodLeadingLabel =
    "<html><body><p>Kontakt Oceanfood AS Storhaugen 26, 5527 Haugesund</p></body></html>";
  assertEq(
    extractAddress(htmlOceanfoodLeadingLabel),
    "Storhaugen 26, 5527 Haugesund",
    "addr-05 (Oceanfood repro): leading 'Kontakt <Firmanavn> AS' box heading is stripped from the street, not written as part of the address",
  );

  // Bare leading label, no company name in between — the simpler shape.
  const htmlBareLeadingLabel =
    "<html><body><p>Kontakt Storhaugen 26, 5527 Haugesund</p></body></html>";
  assertEq(
    extractAddress(htmlBareLeadingLabel),
    "Storhaugen 26, 5527 Haugesund",
    "addr-06: a bare leading 'Kontakt' label (no company name) is also stripped",
  );

  // Positive control: a real street name is never mistaken for a leading
  // label — must extract unchanged.
  const htmlNoLeadingLabel =
    "<html><body><p>Storhaugen 26, 5527 Haugesund</p></body></html>";
  assertEq(
    extractAddress(htmlNoLeadingLabel),
    "Storhaugen 26, 5527 Haugesund",
    "addr-07: an address with no leading label at all extracts unchanged (fix doesn't regress the common case)",
  );

  return { passed, failed, failures };
}

if (require.main === module) {
  const summary = runHomepageProvenanceContactExtractionFixTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  if (summary.failed > 0) process.exit(1);
}
