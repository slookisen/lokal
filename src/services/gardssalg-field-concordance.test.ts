/**
 * gardssalg-field-concordance.test.ts — pure logic tests for orchestrator
 * dev-request 2026-08-03-gardssalg-field-concordance.
 *
 * Route-level tests (the HTTP endpoint, cohort SQL, fetch mocking, zero-
 * writes DB proof) live in
 * routes/opplevelser-gardssalg-field-concordance-audit.test.ts — this file
 * covers only the pure, DB-free/network-free comparison functions in this
 * module: the ALL-matches email/phone extractors, each field's verdict
 * function, buildProviderConcordanceRow's fetch-failure fail-closed branch,
 * and summarizeGfc.
 *
 * Run standalone: npx tsx src/services/gardssalg-field-concordance.test.ts
 */

import {
  extractAllEmails,
  extractAllPhoneRuns,
  isGenericLocalEmail,
  checkEmailField,
  checkPhoneField,
  checkAdresseField,
  checkPostnummerField,
  checkPoststedField,
  checkOpeningHoursField,
  buildProviderConcordanceRow,
  summarizeGfc,
  summarizeGfcFetchStatus,
  type GfcProducerRow,
  type GfcProviderResult,
} from "./gardssalg-field-concordance";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function blankProducer(overrides: Partial<GfcProducerRow> & { id: string; navn: string }): GfcProducerRow {
  return {
    epost: null,
    telefon: null,
    mobil: null,
    adresse: null,
    postnummer: null,
    poststed: null,
    opening_hours_text: null,
    ...overrides,
  };
}

export function runGardssalgFieldConcordanceTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    try {
      // ── extractAllEmails ────────────────────────────────────────────────
      assertEq(
        extractAllEmails("Kontakt oss på post@gard.no eller salg@gard.no. Ring gjerne."),
        ["post@gard.no", "salg@gard.no"],
        "extractAllEmails: finds multiple distinct addresses, first-seen order",
      );
      assertEq(
        extractAllEmails("post@gard.no ... post@gard.no igjen"),
        ["post@gard.no"],
        "extractAllEmails: de-duplicates repeated addresses",
      );
      assertEq(extractAllEmails("Ingen epost her, bare tekst."), [], "extractAllEmails: no email-shaped text -> []");
      assertEq(
        extractAllEmails("KONTAKT@GARD.NO"),
        ["kontakt@gard.no"],
        "extractAllEmails: lower-cased",
      );

      // ── extractAllPhoneRuns ─────────────────────────────────────────────
      assertEq(
        extractAllPhoneRuns("Ring 912 34 567 eller 998 87 766."),
        ["91234567", "99887766"],
        "extractAllPhoneRuns: finds multiple distinct 8-digit runs, separators stripped",
      );
      assertEq(
        extractAllPhoneRuns("+47 912 34 567 og 0047 91234567 er samme nummer"),
        ["91234567"],
        "extractAllPhoneRuns: +47/0047-prefixed forms normalise to the SAME run and de-duplicate",
      );
      assertEq(
        extractAllPhoneRuns("Org.nr 912345678 er ni siffer, ikke et telefonnummer"),
        [],
        "extractAllPhoneRuns: an 8-digit run embedded in a longer 9-digit run is never extracted (not-embedded guard)",
      );
      assertEq(extractAllPhoneRuns("Ingen tall her."), [], "extractAllPhoneRuns: no digit runs -> []");

      // ── checkEmailField ─────────────────────────────────────────────────
      assertEq(
        checkEmailField("post@gard.no", "Kontakt: post@gard.no"),
        { verdict: "bekreftet", current: "post@gard.no", found: "post@gard.no" },
        "checkEmailField: stored value found verbatim -> bekreftet",
      );
      assertEq(
        checkEmailField("Post@Gard.NO", "Kontakt: post@gard.no"),
        { verdict: "bekreftet", current: "Post@Gard.NO", found: "Post@Gard.NO" },
        "checkEmailField: case-insensitive verbatim match still bekreftet, current preserves original casing",
      );
      assertEq(
        checkEmailField("gammel@gard.no", "Kontakt: ny@gard.no"),
        { verdict: "avvik", current: "gammel@gard.no", found: "ny@gard.no" },
        "checkEmailField: stored non-empty + a different email found -> avvik with current/found",
      );
      assertEq(
        checkEmailField("post@gard.no", "Ingen kontaktinfo på denne siden."),
        { verdict: "ikke_funnet_på_siden", current: "post@gard.no", found: null },
        "checkEmailField: nothing email-shaped on page at all -> ikke_funnet_på_siden, current still carried",
      );
      assertEq(
        checkEmailField(null, "Kontakt: post@gard.no"),
        { verdict: "ikke_funnet_på_siden", current: null, found: null },
        "checkEmailField: stored blank, page has an email -> ikke_funnet_på_siden (nothing stored to confirm)",
      );
      assertEq(
        checkEmailField(null, "Ingen kontaktinfo."),
        { verdict: "ikke_funnet_på_siden", current: null, found: null },
        "checkEmailField: stored blank, page has nothing -> ikke_funnet_på_siden",
      );

      // ── checkEmailField: policy priority (kriterium 2, "By Brenneri rule") ─
      // When several own-domain addresses are on the page, prefer the
      // generic/shared mailbox over a personal one as the reported found
      // value — regardless of scrape order. A lone personal address (no
      // generic candidate at all) must still be reported unchanged (the
      // "Graff case").
      assertTrue(isGenericLocalEmail("post@x.no"), "isGenericLocalEmail: post@ is generic");
      assertTrue(isGenericLocalEmail("KONTAKT@x.no"), "isGenericLocalEmail: case-insensitive match");
      assertTrue(!isGenericLocalEmail("martin@x.no"), "isGenericLocalEmail: a personal name is not generic");

      assertEq(
        checkEmailField("gammel@x.no", "Skriv til martin@x.no eller post@x.no for spørsmål."),
        { verdict: "avvik", current: "gammel@x.no", found: "post@x.no" },
        "checkEmailField: personal-first-in-page, generic-second -> generic wins over scrape order",
      );
      assertEq(
        checkEmailField("gammel@x.no", "Skriv til post@x.no eller martin@x.no for spørsmål."),
        { verdict: "avvik", current: "gammel@x.no", found: "post@x.no" },
        "checkEmailField: generic-first-in-page, personal-second -> generic still wins (matches scrape order here too)",
      );
      assertEq(
        checkEmailField("gammel@x.no", "Kontakt martin@x.no direkte, han svarer raskest."),
        { verdict: "avvik", current: "gammel@x.no", found: "martin@x.no" },
        "checkEmailField: only a personal address published (no generic candidate) -> personal reported unchanged (Graff case)",
      );
      assertEq(
        checkEmailField("gammel@x.no", "Skriv til kontakt@x.no eller post@x.no."),
        { verdict: "avvik", current: "gammel@x.no", found: "kontakt@x.no" },
        "checkEmailField: two generic candidates, no personal -> first-scraped generic wins (first-seen tie-break preserved among generics)",
      );

      // ── checkPhoneField (telefon/mobil share this function) ──────────────
      assertEq(
        checkPhoneField("91234567", "Ring 912 34 567 i dag"),
        { verdict: "bekreftet", current: "91234567", found: "91234567" },
        "checkPhoneField: stored number found (separators normalised away) -> bekreftet",
      );
      assertEq(
        checkPhoneField("90000001", "Ring 900 00 009 (dagtid)"),
        { verdict: "avvik", current: "90000001", found: "90000009" },
        "checkPhoneField: stored non-empty + a different phone run found -> avvik with current/found",
      );
      assertEq(
        checkPhoneField("91234567", "Ingen telefonnummer her."),
        { verdict: "ikke_funnet_på_siden", current: "91234567", found: null },
        "checkPhoneField: nothing phone-shaped on page -> ikke_funnet_på_siden",
      );
      assertEq(
        checkPhoneField(null, "Ring 912 34 567"),
        { verdict: "ikke_funnet_på_siden", current: null, found: null },
        "checkPhoneField: stored blank -> ikke_funnet_på_siden even if the page has a phone run",
      );

      // ── checkAdresseField (presence-only, no avvik) ──────────────────────
      assertEq(
        checkAdresseField("Gardsveien 12", "Besøksadresse: Gardsveien 12, velkommen innom."),
        { verdict: "bekreftet" },
        "checkAdresseField: stored address found at token boundary -> bekreftet",
      );
      assertEq(
        checkAdresseField("Gardsveien 12", "Vi holder til på Nyveien 4."),
        { verdict: "ikke_funnet_på_siden" },
        "checkAdresseField: a DIFFERENT address on the page never produces avvik — only bekreftet/ikke_funnet_på_siden exist",
      );
      assertEq(
        checkAdresseField(null, "Gardsveien 12 nevnes her."),
        { verdict: "ikke_funnet_på_siden" },
        "checkAdresseField: blank stored address -> ikke_funnet_på_siden",
      );
      assertEq(
        checkAdresseField("Berg", "Vi ligger i Berg sentrum."),
        { verdict: "ikke_funnet_på_siden" },
        "checkAdresseField: a too-short (<6 normalised chars) stored value never fires, even if literally present",
      );

      // ── checkPostnummerField ──────────────────────────────────────────────
      assertEq(
        checkPostnummerField("5750", "Postnummer 5750 Odda"),
        { verdict: "bekreftet" },
        "checkPostnummerField: exact 4-digit run found -> bekreftet",
      );
      assertEq(
        checkPostnummerField("5750", "Vårt org.nr er 912345750 — ni siffer"),
        { verdict: "ikke_funnet_på_siden" },
        "checkPostnummerField: the 4 digits embedded in a longer run never counts (not-embedded guard)",
      );
      assertEq(
        checkPostnummerField(null, "5750 nevnes her"),
        { verdict: "ikke_funnet_på_siden" },
        "checkPostnummerField: blank stored postnummer -> ikke_funnet_på_siden",
      );
      assertEq(
        checkPostnummerField("57X0", "5750 Odda"),
        { verdict: "ikke_funnet_på_siden" },
        "checkPostnummerField: a malformed (non-4-digit) stored value never matches",
      );

      // ── checkPoststedField ─────────────────────────────────────────────────
      assertEq(
        checkPoststedField("Odda", "5750 Odda er vår hjemby."),
        { verdict: "bekreftet" },
        "checkPoststedField: stored poststed found at token boundary -> bekreftet",
      );
      assertEq(
        checkPoststedField("Nes", "Vi ligger i Sandnes, ikke Nes."),
        { verdict: "bekreftet" },
        "checkPoststedField: token-boundary-safe match still finds a legitimately separate 'Nes' token",
      );
      assertEq(
        checkPoststedField("Nes", "Vi ligger i Sandnes kommune."),
        { verdict: "ikke_funnet_på_siden" },
        "checkPoststedField: 'Nes' must NOT match inside 'Sandnes' (word-boundary-safe, not naive includes())",
      );

      // ── checkOpeningHoursField ─────────────────────────────────────────────
      assertEq(
        checkOpeningHoursField("Ma-Fr 10-16", "Åpningstider: Ma-Fr 10-16 hele året."),
        { verdict: "bekreftet" },
        "checkOpeningHoursField: stored value found verbatim (token-boundary-safe) -> bekreftet",
      );
      assertEq(
        checkOpeningHoursField("Ma-Fr 10-16", "Åpent mandag til torsdag 09-15."),
        { verdict: "ikke_funnet_på_siden" },
        "checkOpeningHoursField: a differently-phrased opening-hours string on the page is NOT a match (presence-only, not semantic)",
      );
      assertEq(
        checkOpeningHoursField(null, "Ma-Fr 10-16 står her"),
        { verdict: "ikke_funnet_på_siden" },
        "checkOpeningHoursField: blank stored value -> ikke_funnet_på_siden",
      );

      // ── buildProviderConcordanceRow: fetch-failure fail-closed branch ────
      const producer = blankProducer({
        id: "prov-1",
        navn: "Test Gård",
        epost: "post@gard.no",
        telefon: "91234567",
        mobil: "99887766",
        adresse: "Gardsveien 12",
        postnummer: "5750",
        poststed: "Odda",
        opening_hours_text: "Ma-Fr 10-16",
      });
      const failedRow = buildProviderConcordanceRow(producer, null, "fetch_failed");
      assertEq(failedRow.provider_id, "prov-1", "buildProviderConcordanceRow: provider_id passthrough");
      assertEq(failedRow.provider_name, "Test Gård", "buildProviderConcordanceRow: provider_name passthrough");
      assertEq(
        failedRow.fetch_status,
        "fetch_failed",
        "buildProviderConcordanceRow: fetchStatus='fetch_failed' passed through onto fetch_status",
      );
      for (const f of ["epost", "telefon", "mobil", "adresse", "postnummer", "poststed", "opening_hours_text"] as const) {
        assertEq(
          (failedRow as any)[f].verdict,
          "ikke_funnet_på_siden",
          `buildProviderConcordanceRow: pageText=null (fetch failure) -> ${f} verdicts ikke_funnet_på_siden`,
        );
      }
      assertEq(
        failedRow.epost,
        { verdict: "ikke_funnet_på_siden", current: "post@gard.no", found: null },
        "buildProviderConcordanceRow: fetch failure still carries `current` for avvik-capable fields, `found` null",
      );
      assertEq(
        failedRow.adresse,
        { verdict: "ikke_funnet_på_siden" },
        "buildProviderConcordanceRow: fetch failure — presence-only field carries no current/found keys",
      );

      // ── buildProviderConcordanceRow: fetchStatus='no_hjemmeside' (no
      //     hjemmeside on file at all — distinct from a fetch that was
      //     attempted and failed) ─────────────────────────────────────────
      const noHjemmesideRow = buildProviderConcordanceRow(producer, null, "no_hjemmeside");
      assertEq(
        noHjemmesideRow.fetch_status,
        "no_hjemmeside",
        "buildProviderConcordanceRow: fetchStatus='no_hjemmeside' passed through onto fetch_status",
      );
      for (const f of ["epost", "telefon", "mobil", "adresse", "postnummer", "poststed", "opening_hours_text"] as const) {
        assertEq(
          (noHjemmesideRow as any)[f].verdict,
          "ikke_funnet_på_siden",
          `buildProviderConcordanceRow: fetchStatus='no_hjemmeside' -> ${f} still verdicts ikke_funnet_på_siden (fail-closed unchanged)`,
        );
      }

      // ── buildProviderConcordanceRow: real page text, mixed verdicts ──────
      const okRow = buildProviderConcordanceRow(
        producer,
        "Kontakt: post@gard.no, ring 912 34 567. Gardsveien 12, 5750 Odda. Ma-Fr 10-16.",
        "fetched",
      );
      assertEq(
        okRow.fetch_status,
        "fetched",
        "buildProviderConcordanceRow: fetchStatus='fetched' passed through onto fetch_status, field verdicts unaffected",
      );
      assertEq(okRow.epost.verdict, "bekreftet", "buildProviderConcordanceRow (ok): epost bekreftet");
      assertEq(okRow.telefon.verdict, "bekreftet", "buildProviderConcordanceRow (ok): telefon bekreftet");
      // mobil (99887766) itself is not on this page, but a DIFFERENT phone
      // run (telefon's own 91234567) is — per spec this is correctly avvik,
      // not ikke_funnet_på_siden: "if stored is non-empty and a different
      // valid-looking phone run was found -> avvik".
      assertEq(
        okRow.mobil,
        { verdict: "avvik", current: "99887766", found: "91234567" },
        "buildProviderConcordanceRow (ok): mobil itself absent but a DIFFERENT phone run present -> avvik, not ikke_funnet_på_siden",
      );
      assertEq(okRow.adresse.verdict, "bekreftet", "buildProviderConcordanceRow (ok): adresse bekreftet");
      assertEq(okRow.postnummer.verdict, "bekreftet", "buildProviderConcordanceRow (ok): postnummer bekreftet");
      assertEq(okRow.poststed.verdict, "bekreftet", "buildProviderConcordanceRow (ok): poststed bekreftet");
      assertEq(okRow.opening_hours_text.verdict, "bekreftet", "buildProviderConcordanceRow (ok): opening_hours_text bekreftet");

      // ── summarizeGfc ───────────────────────────────────────────────────────
      const summary = summarizeGfc([failedRow, okRow]);
      assertEq(
        summary.epost,
        { bekreftet: 1, avvik: 0, ikke_funnet_på_siden: 1 },
        "summarizeGfc: epost counts across both rows",
      );
      assertEq(
        summary.mobil,
        { bekreftet: 0, avvik: 1, ikke_funnet_på_siden: 1 },
        "summarizeGfc: mobil — failedRow ikke_funnet_på_siden (fetch failure), okRow avvik (different phone run present)",
      );
      assertEq(
        summary.adresse,
        { bekreftet: 1, avvik: 0, ikke_funnet_på_siden: 1 },
        "summarizeGfc: adresse counts across both rows",
      );

      // ── summarizeGfcFetchStatus ───────────────────────────────────────────
      const fetchStatusFixture: GfcProviderResult[] = [failedRow, okRow, noHjemmesideRow, okRow];
      assertEq(
        summarizeGfcFetchStatus(fetchStatusFixture),
        { fetched: 2, fetch_failed: 1, no_hjemmeside: 1 },
        "summarizeGfcFetchStatus: counts rows per fetch_status bucket correctly",
      );
      assertEq(
        summarizeGfcFetchStatus([]),
        { fetched: 0, fetch_failed: 0, no_hjemmeside: 0 },
        "summarizeGfcFetchStatus: empty rows -> all buckets present and zero, not undefined",
      );
      assertEq(
        summarizeGfcFetchStatus([okRow]),
        { fetched: 1, fetch_failed: 0, no_hjemmeside: 0 },
        "summarizeGfcFetchStatus: a single-status batch still reports every bucket (absent statuses are zero, not undefined)",
      );
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-field-concordance: unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner: `npx tsx src/services/gardssalg-field-concordance.test.ts`
if (require.main === module) {
  runGardssalgFieldConcordanceTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
