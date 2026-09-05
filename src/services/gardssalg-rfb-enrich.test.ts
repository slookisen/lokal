/**
 * gardssalg-rfb-enrich.test.ts — unit tests for the RFB→gårdssalg knowledge
 * enrichment module (src/services/gardssalg-rfb-enrich.ts), specifically the
 * root-cause fix for dev-request 2026-09-05-outreach-navnelik-kontaktkobling
 * (the "Moland Gård" Bø-vs-Drangedal incident, 2026-09-03): a real person's
 * email (the genuine owner of a farm-sale business in Bø, org.nr 927532778)
 * was auto-copied onto a DIFFERENT, unrelated agent record that merely
 * shared the trading name "Moland Gård" and was actually located in
 * Drangedal (org.nr 933527484) — because pickEnrichmentFields' byName
 * fallback matched purely on normalized name, with no org.nr/municipality
 * confirmation, even though both sides of the match carry exactly that
 * disambiguating data (agents.org_nr/.city, experience_providers.org_nr/
 * .kommune).
 *
 * Sections:
 *   A. nameMatchDisambiguation — pure, no DB. org.nr agree/disagree,
 *      municipality agree/disagree, org.nr-takes-precedence-over-municipality,
 *      and the "no disambiguating data on either/both sides" pass-through
 *      that keeps this fix additive.
 *   B. pickEnrichmentFields — the actual write-gating integration:
 *      (a) two same-name agents in different municipalities/org.nr -> the
 *          email assignment does NOT collide: status 'ambiguous_name_match',
 *          copy {} (nothing written, in particular no `epost`).
 *      (b) a uniquely-named agent (no RFB-side collision, no disambiguating
 *          conflict) -> unchanged 'would_enrich' behavior, copy includes
 *          epost/telefon/etc — the pre-fix behavior, preserved.
 *      (c) the concrete "Moland Gård" scenario, built from the two real
 *          org.nrs named in the incident (927532778 Bø / 933527484
 *          Drangedal): the Drangedal provider must never receive the Bø
 *          agent's (Peter's) real contact email.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgRfbEnrichTests(opts: { log?: boolean } = {}): TestSummary {
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

  const {
    nameMatchDisambiguation,
    indexRfbByDomain,
    indexRfbByName,
    pickEnrichmentFields,
  } = require("./gardssalg-rfb-enrich") as typeof import("./gardssalg-rfb-enrich");

  // ═══════════════════════════════════════════════════════════════════════
  // Section A — nameMatchDisambiguation (pure).
  // ═══════════════════════════════════════════════════════════════════════
  try {
    // a-1: both sides carry org.nr and they AGREE -> confirmed.
    assertEq(
      nameMatchDisambiguation({ org_nr: "927532778", kommune: null }, { org_nr: "927532778", city: null }),
      { confirmed: true },
      "a-1: matching org.nr on both sides -> confirmed",
    );

    // a-2: both sides carry org.nr and they DISAGREE -> refused, with a reason.
    const a2 = nameMatchDisambiguation({ org_nr: "927532778", kommune: null }, { org_nr: "933527484", city: null });
    assertEq(a2.confirmed, false, "a-2: differing org.nr on both sides -> NOT confirmed");
    assertTrue(/org\.nr/i.test(a2.reason ?? "") && a2.reason!.includes("927532778") && a2.reason!.includes("933527484"), "a-2b: reason names both conflicting org.nrs");

    // a-3: org.nr formatting differences (whitespace) still compare equal —
    // mirrors blocklist-service.ts's normalizeOrgNr (whitespace-only fold).
    assertEq(
      nameMatchDisambiguation({ org_nr: "927 532 778", kommune: null }, { org_nr: "927532778", city: null }),
      { confirmed: true },
      "a-3: org.nr with incidental whitespace still matches after normalization",
    );

    // a-4: no org.nr on either side, municipality AGREES (case/diacritic-insensitive) -> confirmed.
    assertEq(
      nameMatchDisambiguation({ org_nr: null, kommune: "Bø" }, { org_nr: null, city: "bø" }),
      { confirmed: true },
      "a-4: municipality fallback, case-insensitive match -> confirmed",
    );

    // a-5: no org.nr on either side, municipality DISAGREES -> refused.
    const a5 = nameMatchDisambiguation({ org_nr: null, kommune: "Bø" }, { org_nr: null, city: "Drangedal" });
    assertEq(a5.confirmed, false, "a-5: differing municipality (no org.nr available) -> NOT confirmed");
    assertTrue(/municipality/i.test(a5.reason ?? "") && a5.reason!.includes("Bø") && a5.reason!.includes("Drangedal"), "a-5b: reason names both conflicting municipalities");

    // a-6: org.nr present+AGREEING on both sides takes precedence over a
    // conflicting municipality — org.nr is the stronger signal and must win.
    assertEq(
      nameMatchDisambiguation({ org_nr: "927532778", kommune: "Bø" }, { org_nr: "927532778", city: "Drangedal" }),
      { confirmed: true },
      "a-6: agreeing org.nr overrides a conflicting municipality (org.nr is authoritative)",
    );

    // a-7: org.nr present+DISAGREEING on both sides is refused even though
    // municipality happens to agree — org.nr disagreement is decisive.
    const a7 = nameMatchDisambiguation({ org_nr: "927532778", kommune: "Bø" }, { org_nr: "933527484", city: "Bø" });
    assertEq(a7.confirmed, false, "a-7: disagreeing org.nr refuses the match even when municipality happens to agree");

    // a-8: org.nr present on only ONE side, municipality available+agreeing
    // on both -> falls back to municipality -> confirmed.
    assertEq(
      nameMatchDisambiguation({ org_nr: "927532778", kommune: "Bø" }, { org_nr: null, city: "Bø" }),
      { confirmed: true },
      "a-8: org.nr on only one side -> falls back to municipality, which agrees -> confirmed",
    );

    // a-9: NEITHER side carries org.nr NOR municipality -> nothing to
    // disagree with -> confirmed (this is the additive/no-regression case:
    // a genuinely unique name with no disambiguating data at all behaves
    // exactly as it did before this fix).
    assertEq(
      nameMatchDisambiguation({ org_nr: null, kommune: null }, { org_nr: null, city: null }),
      { confirmed: true },
      "a-9: no disambiguating data anywhere -> confirmed (pre-fix behavior preserved)",
    );

    // a-10: blank-string org.nr/municipality values are treated as absent, not as an empty-string mismatch.
    assertEq(
      nameMatchDisambiguation({ org_nr: "", kommune: "  " }, { org_nr: "", city: "" }),
      { confirmed: true },
      "a-10: blank-string values are treated as absent data, not a conflict",
    );
  } catch (err: any) {
    failed++;
    failures.push("gardssalg-rfb-enrich (section A): unexpected error: " + String(err?.stack || err?.message || err));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Section B — pickEnrichmentFields integration (the actual write gate).
  // ═══════════════════════════════════════════════════════════════════════
  try {
    function makeProvider(overrides: Partial<import("./gardssalg-rfb-enrich").EnrichProviderRow>): import("./gardssalg-rfb-enrich").EnrichProviderRow {
      return {
        id: "prov-1",
        navn: "Moland Gård",
        hjemmeside: null,
        adresse: null,
        telefon: null,
        epost: null,
        lat: null,
        lon: null,
        about_text: null,
        products: null,
        content_source: null,
        field_provenance: null,
        ...overrides,
      };
    }

    function makeSource(overrides: Partial<import("./gardssalg-rfb-enrich").RfbSource>): import("./gardssalg-rfb-enrich").RfbSource {
      return {
        agent_id: "agent-1",
        name: "Moland Gård",
        url: null,
        lat: null,
        lng: null,
        about: null,
        address: null,
        phone: null,
        email: null,
        products: null,
        verification_review_reason: null,
        ...overrides,
      };
    }

    // ── (a) Two same-name agents in different municipalities/org.nr: the
    //        email assignment must NOT collide — held back as ambiguous. ──
    {
      const provider = makeProvider({
        id: "prov-drangedal",
        navn: "Moland Gård",
        org_nr: "933527484",
        kommune: "Drangedal",
      });
      const bøAgent = makeSource({
        agent_id: "agent-bo-peter",
        name: "Moland Gård",
        org_nr: "927532778",
        city: "Bø",
        email: "ende01@online.no",
        phone: "99887766",
        address: "Moland 4, 3830 Bø",
      });
      const byDomain = indexRfbByDomain([bøAgent]);
      const byName = indexRfbByName([bøAgent]);
      const result = pickEnrichmentFields(provider, byDomain, byName);

      assertEq(result.status, "ambiguous_name_match", "b-a1: differing org.nr AND municipality behind an identical name -> status 'ambiguous_name_match', never 'would_enrich'");
      assertEq(result.copy, {}, "b-a2: nothing is copied — in particular, epost is never written");
      assertEq(result.matched_by, undefined, "b-a3: matched_by is left unset — this was never accepted as a confirmed match");
      assertTrue(!!result.ambiguous_reason && result.ambiguous_reason.includes("933527484") && result.ambiguous_reason.includes("927532778"), "b-a4: ambiguous_reason names the two conflicting org.nrs so a human reviewer can act on it");
      assertTrue(result.matched_rfb?.agent_id === "agent-bo-peter", "b-a5: the (refused) candidate match is still reported for manual review, not silently dropped");
    }

    // ── (b) A uniquely-named agent: assignment behavior UNCHANGED from
    //        before this fix (regression guard) — no org.nr/kommune data at
    //        all on either side, so there is nothing to disagree with, and
    //        the pre-fix name-fallback copy still happens exactly as before. ──
    {
      const provider = makeProvider({
        id: "prov-unique",
        navn: "Solbakken Gård",
        // No org_nr/kommune supplied at all here — mirrors a provider row
        // seeded before those columns existed, or one Brreg has no data for.
      });
      const uniqueAgent = makeSource({
        agent_id: "agent-unique",
        name: "Solbakken Gård",
        email: "post@solbakken.no",
        phone: "92345678",
        address: "Solbakkveien 3, 2400 Elverum",
        about: "Gårdsbutikk med lokale varer.",
      });
      const byDomain = indexRfbByDomain([uniqueAgent]);
      const byName = indexRfbByName([uniqueAgent]);
      const result = pickEnrichmentFields(provider, byDomain, byName);

      assertEq(result.status, "would_enrich", "b-b1: a uniquely-named agent with no disambiguating conflict -> still 'would_enrich' (unchanged regression behavior)");
      assertEq(result.matched_by, "name", "b-b2: matched via the name fallback, as before");
      assertEq(result.copy.epost, "post@solbakken.no", "b-b3: epost is still copied for a genuinely unique name (no false negative introduced by this fix)");
      assertEq(result.copy.telefon, "92345678", "b-b4: telefon is still copied too");
    }

    // Also confirm the SAME uniquely-named case is unaffected when BOTH
    // sides happen to agree on org.nr/kommune (the ordinary, fully-corroborated
    // case) — still would_enrich, still copies.
    {
      const provider = makeProvider({
        id: "prov-unique-corroborated",
        navn: "Fjellro Gård",
        org_nr: "911222333",
        kommune: "Voss",
      });
      const agent = makeSource({
        agent_id: "agent-fjellro",
        name: "Fjellro Gård",
        org_nr: "911222333",
        city: "Voss",
        email: "kontakt@fjellro.no",
      });
      const byDomain = indexRfbByDomain([agent]);
      const byName = indexRfbByName([agent]);
      const result = pickEnrichmentFields(provider, byDomain, byName);
      assertEq(result.status, "would_enrich", "b-b5: agreeing org.nr+kommune on both sides -> would_enrich, as expected");
      assertEq(result.copy.epost, "kontakt@fjellro.no", "b-b6: epost copied when fully corroborated");
    }

    // ── (c) The concrete "Moland Gård" incident, mirrored end-to-end: the
    //        Drangedal provider (the bad record CS deleted/blocklisted) must
    //        never receive Peter's (Bø) real email through this path,
    //        confirming the fix actually closes the reported incident. ──
    {
      const drangedalProvider = makeProvider({
        id: "prov-moland-drangedal",
        navn: "Moland Gård",
        hjemmeside: null, // no domain on file -> falls through to the name fallback, exactly like the real incident
        epost: null,
        org_nr: "933527484",
        kommune: "Drangedal",
      });
      const petersBøAgent = makeSource({
        agent_id: "agent-peter-bo",
        name: "Moland Gård",
        org_nr: "927532778",
        city: "Bø",
        email: "ende01@online.no", // Peter's real, genuine address
      });
      const byDomain = indexRfbByDomain([petersBøAgent]);
      const byName = indexRfbByName([petersBøAgent]);
      const result = pickEnrichmentFields(drangedalProvider, byDomain, byName);

      assertEq(result.status, "ambiguous_name_match", "b-c1: the exact incident shape reproduces as 'ambiguous_name_match'");
      assertTrue(result.copy.epost === undefined, "b-c2: Peter's email (ende01@online.no) is NEVER copied onto the Drangedal provider row");
      assertEq(Object.keys(result.copy).length, 0, "b-c3: nothing at all is copied for the ambiguous row");
    }
  } catch (err: any) {
    failed++;
    failures.push("gardssalg-rfb-enrich (section B): unexpected error: " + String(err?.stack || err?.message || err));
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const summary = runGardssalgRfbEnrichTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  if (summary.failed > 0) process.exit(1);
}
