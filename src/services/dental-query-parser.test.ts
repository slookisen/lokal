/**
 * dental-query-parser.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1).
 *
 * Table tests for the pure parser (no DB): a fixture gazetteer built with
 * buildNorwegianGazetteer() from a handful of stored poststed spellings, the
 * real kommune/fylke data, and the dental vocabulary.
 *   T   tokenize / normalize / placeKey / escapeLike / matchesAsWordPrefix
 *   Q   parseDentalQuery: place, specialty, akutt, Helfo, name words (Norwegian + English)
 *   K   the four agent-card examples give a non-empty filter
 *   V   the vocabulary mirrors SPECIALTY_PAGES (canonical names + slugs)
 *   S   planDentalSearch: explicit arguments win, 0-hit fallback, rollback switch
 *
 * Standalone: npx tsx src/services/dental-query-parser.test.ts
 * Wired into tests/test.ts via runDentalQueryParserTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalQueryParserTests(opts: { log?: boolean } = {}): TestSummary {
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
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDisabled = process.env.DENTAL_QUERY_PARSER_DISABLED;
  delete process.env.DENTAL_QUERY_PARSER_DISABLED;

  try {
    const nq = require("./search-intent/norwegian-query") as typeof import("./search-intent/norwegian-query");
    const parser = require("./dental-query-parser") as typeof import("./dental-query-parser");
    const { postnumreForKommune } = require("./norway-postnummer") as typeof import("./norway-postnummer");

    // ── T: primitives ─────────────────────────────────────────────────────
    assertEq(nq.tokenize("Finn tannlege med Helfo-avtale i Oslo!"), ["finn", "tannlege", "med", "helfo", "avtale", "i", "oslo"], "T1: tokenize lower-cases and splits on spaces, hyphens and punctuation");
    assertEq(nq.tokenize("Aurskog-Høland, «Mo i Rana»"), ["aurskog", "høland", "mo", "i", "rana"], "T2: tokenize splits hyphenated names and strips quotes");
    assertEq(nq.tokenize("50%_x"), ["50%_x"], "T3: % and _ stay inside a token");
    assertEq(nq.tokenize("   "), [], "T4: blank input -> no tokens");
    assertEq(nq.normalize("TROMSØ"), "tromsø", "T5: normalize folds Ø (Unicode lower case)");
    assertEq(nq.normalize("Tromsö"), nq.normalize("Tromsö"), "T6: normalize applies NFC");
    assertEq([nq.placeKey("Bodø"), nq.placeKey("BODØ"), nq.placeKey("Bodoe")], ["bodoe", "bodoe", "bodoe"], "T7: placeKey folds Bodø/BODØ/Bodoe together");
    assertEq(nq.placeKey("Aurskog-Høland"), nq.placeKey("Aurskog Hoeland"), "T8: placeKey ignores hyphens and spaces");
    assertEq(nq.escapeLike("50%_x\\y"), "50\\%\\_x\\\\y", "T9: escapeLike escapes %, _ and the escape character");
    assertTrue(!nq.matchesAsWordPrefix("hva kan vi finne på", "inne"), "T10: matchesAsWordPrefix: 'inne' inside 'finne' is no match");
    assertTrue(nq.matchesAsWordPrefix("innendørs", "inne"), "T11: matchesAsWordPrefix: inflected continuation matches");

    // ── fixture gazetteer ─────────────────────────────────────────────────
    // Stored spellings as listPoststeder() returns them (most common first),
    // including the case/ASCII variants and kommune names measured in prod.
    const gazetteer = nq.buildNorwegianGazetteer([
      "OSLO", "BERGEN", "TRONDHEIM", "STAVANGER", "Bergen", "TROMSØ", "BODØ", "SANDVIKA",
      "Bodoe", "KRISTIANSAND S", "MO I RANA", "Kristiansand", "Baerum", "1014BV AMSTERDAM",
    ]);
    const parse = (q: string) => parser.parseDentalQuery(q, gazetteer);
    const filterOf = (q: string) => parse(q).filter;

    assertEq(gazetteer.poststeder.get("bergen"), ["BERGEN", "Bergen"], "G1: every stored spelling of a poststed is kept, most common first");
    assertTrue(!gazetteer.poststeder.has("baerum") && !gazetteer.poststeder.has("kristiansand"), "G2: a kommune name stored as poststed is not a poststed");
    assertTrue(!gazetteer.poststeder.has(nq.placeKey("1014BV AMSTERDAM")), "G3: a foreign poststed is dropped");
    assertEq(gazetteer.maxWords, 3, "G4: longest place is three words (Møre og Romsdal, Mo i Rana)");

    // ── Q: acceptance cases from the dev-request ──────────────────────────
    assertEq(filterOf("tannlege i Bergen"), { poststed_in: ["BERGEN", "Bergen"] }, "Q1: «tannlege i Bergen» -> poststed BERGEN (all stored spellings)");
    assertEq(filterOf("kjeveortoped Bergen"), { specialty: "kjeveortopedi", poststed_in: ["BERGEN", "Bergen"] }, "Q2: «kjeveortoped Bergen» -> kjeveortopedi + BERGEN");
    assertEq(filterOf("find orthodontist in Bergen"), { specialty: "kjeveortopedi", poststed_in: ["BERGEN", "Bergen"] }, "Q3: «find orthodontist in Bergen» -> kjeveortopedi + BERGEN");
    assertEq(filterOf("akuttvakt tannlege Stavanger"), { acute_vakt: 1, poststed_in: ["STAVANGER"] }, "Q4: «akuttvakt tannlege Stavanger» -> akutt + STAVANGER");
    assertEq(filterOf("finn tannlege med helfo-avtale i Oslo"), { helfo_agreement: "true", poststed_in: ["OSLO"] }, "Q5: «finn tannlege med helfo-avtale i Oslo» -> helfo + OSLO");
    assertEq(filterOf("Tromsø"), { poststed_in: ["TROMSØ"] }, "Q6: «Tromsø» -> poststed TROMSØ");
    assertTrue(filterOf("Tromsø").fylke === undefined, "Q7: «Tromsø» never becomes fylke Troms");
    assertEq(filterOf("tannlege i Troms"), { fylke: "Troms" }, "Q8: «Troms» on its own is the fylke");
    assertEq(filterOf("Møre og Romsdal"), { fylke: "Møre og Romsdal" }, "Q9: «Møre og Romsdal» -> fylke (the three words win over the region Romsdal)");
    assertEq(filterOf("Hordaland"), { fylke: "Vestland" }, "Q10: «Hordaland» -> Vestland");
    assertEq(filterOf("tannlege vestland"), { fylke: "Vestland" }, "Q11: «vestland» -> Vestland");
    assertEq(filterOf("Sør-Trøndelag"), { fylke: "Trøndelag" }, "Q12: «Sør-Trøndelag» -> Trøndelag");
    {
      const r = parse("tannlege i Bærum");
      assertEq(r.filter.postnummer_in, postnumreForKommune("3201"), "Q13: «tannlege i Bærum» -> Bærum's postnumre");
      assertTrue((r.filter.postnummer_in ?? []).includes("1337") && (r.filter.postnummer_in ?? []).includes("1338"), "Q14: Bærum's postnumre include Sandvika (1337, 1338)");
      assertTrue(r.filter.poststed_in === undefined, "Q15: the stored non-poststed spelling 'Baerum' is not used");
      assertTrue(r.interpretation.some((s) => s.includes("Bærum kommune (etter postnummer)")), "Q16: interpretation mentions «Bærum kommune (etter postnummer)»");
    }
    assertEq(filterOf("tannlege bauge"), { name_terms: ["bauge"] }, "Q17: «tannlege bauge» -> name_terms [bauge]");
    assertEq(filterOf("50%_x"), { name_terms: ["50%_x"] }, "Q18: «50%_x» stays one literal name word (the store LIKE-escapes it)");
    assertEq(parse(""), { filter: {}, interpretation: [], residual_terms: [] }, "Q19: empty string -> {}");
    assertEq(parse("   "), { filter: {}, interpretation: [], residual_terms: [] }, "Q20: blank string -> {}");

    // ── Q: more places ────────────────────────────────────────────────────
    assertEq(filterOf("tannlege i Mo i Rana"), { poststed_in: ["MO I RANA"] }, "Q21: three-word poststed with a stopword inside");
    assertEq(filterOf("Kristiansand S"), { poststed_in: ["KRISTIANSAND S"] }, "Q22: «Kristiansand S» -> the poststed");
    assertEq(filterOf("tannlege Kristiansand").postnummer_in, postnumreForKommune("4204"), "Q23: «Kristiansand» -> the kommune (no poststed has that exact name)");
    assertEq(filterOf("Bodø"), { poststed_in: ["BODØ", "Bodoe"] }, "Q24: «Bodø» -> BODØ and the ASCII spelling Bodoe");
    assertEq(filterOf("emergency dentist Tromso"), { acute_vakt: 1, poststed_in: ["TROMSØ"] }, "Q25: ASCII «Tromso» -> TROMSØ");
    assertEq(filterOf("tannlege Lofoten"), { fylke: "Nordland" }, "Q26: region Lofoten -> its fylke");
    {
      const r = parse("Herøy");
      assertEq(r.filter, { name_terms: ["herøy"] }, "Q27: «Herøy» (two kommuner, no single fylke) -> name word");
      assertTrue(r.interpretation.some((s) => s.includes("flere kommuner")), "Q28: interpretation notes Herøy is several kommuner");
    }
    assertEq(filterOf("tannlege Våler"), { name_terms: ["våler"] }, "Q29: «Våler» likewise");
    assertEq(filterOf("tannlege i Trondheim"), { poststed_in: ["TRONDHEIM"] }, "Q30: «Trondheim» -> poststed");
    assertEq(filterOf("tannlege i Lillehammer").postnummer_in, postnumreForKommune("3405"), "Q31: a kommune not in the poststed list resolves by postnummer");
    {
      const r = parse("barnetannlege Oslo eller Bergen");
      assertEq(r.filter, { specialty: "pedodonti", poststed_in: ["OSLO"] }, "Q32: two places -> the first one is used");
      assertTrue(r.interpretation.some((s) => s.includes("flere steder")), "Q33: and the second one is noted");
    }
    assertEq(filterOf("en time hos tannlege i Oslo"), { poststed_in: ["OSLO"] }, "Q34: «time» (appointment) is not Time kommune");
    assertEq(filterOf("Oslo kommune"), { poststed_in: ["OSLO"] }, "Q35: «kommune» is a stopword");

    // ── Q: specialties ────────────────────────────────────────────────────
    const spec = (q: string) => filterOf(q).specialty;
    assertEq(spec("tannregulering"), "kjeveortopedi", "Q36: tannregulering -> kjeveortopedi");
    assertEq(spec("kjeveortopeden min"), "kjeveortopedi", "Q37: inflected «kjeveortopeden» -> kjeveortopedi");
    assertEq(spec("endodontist"), "endodonti", "Q38: endodontist -> endodonti");
    assertEq(spec("rotbehandling"), "endodonti", "Q39: rotbehandling -> endodonti");
    assertEq(spec("periodontist"), "periodonti", "Q40: periodontist -> periodonti");
    assertEq(spec("tannkjøtt"), "periodonti", "Q41: tannkjøtt -> periodonti");
    assertEq(spec("barnetannlege"), "pedodonti", "Q42: barnetannlege -> pedodonti");
    assertEq(spec("pedodontist"), "pedodonti", "Q43: pedodontist -> pedodonti");
    assertEq(spec("oralkirurg"), "oral kirurgi og oral medisin", "Q44: oralkirurg -> oral kirurgi og oral medisin");
    assertEq(spec("oral kirurgi Bergen"), "oral kirurgi og oral medisin", "Q45: «oral kirurgi» -> the stored name (A2A used to split it)");
    assertEq(spec("protetiker"), "oral protetikk", "Q46: protetiker -> oral protetikk");
    assertEq(spec("radiolog"), "kjeve- og ansiktsradiologi", "Q47: radiolog -> kjeve- og ansiktsradiologi");
    assertEq(spec("kjeve- og ansiktsradiologi"), "kjeve- og ansiktsradiologi", "Q48: the full stored name");
    assertEq(spec("root canal"), "endodonti", "Q49: English «root canal» -> endodonti");
    assertTrue(filterOf("kjeveortoped Bergen").name_terms === undefined, "Q50: a specialty word is not also a name word");

    // ── Q: triggers ───────────────────────────────────────────────────────
    assertEq(filterOf("tannlegevakt").acute_vakt, 1, "Q51: tannlegevakt -> akutt");
    assertEq(filterOf("urgent dentist").acute_vakt, 1, "Q52: urgent -> akutt");
    assertEq(filterOf("direkteoppgjør").helfo_agreement, "true", "Q53: direkteoppgjør -> Helfo");
    {
      const r = parse("tannlege uten helfo i Oslo");
      assertEq(r.filter, { poststed_in: ["OSLO"] }, "Q54: «uten helfo» does not set the Helfo filter");
      assertTrue(r.interpretation.some((s) => s.includes("«uten helfo»")), "Q55: and says so");
    }

    // ── Q: name words ─────────────────────────────────────────────────────
    {
      const r = parse("a b c d e f g h i j tannlege alfa beta gamma delta epsilon zeta eta");
      assertEq(r.filter.name_terms, ["alfa", "beta", "gamma", "delta", "epsilon", "zeta"], "Q56: at most 6 name words, single letters dropped");
      assertEq(r.residual_terms.length, 7, "Q57: residual_terms keeps all 7 leftover words");
      assertTrue(r.interpretation.some((s) => s.includes("6 første")), "Q58: the cut is noted");
    }
    assertEq(parse("tannlege i Bergen").interpretation, ["sted: Bergen (poststed)"], "Q59: interpretation for a plain place");
    assertEq(parse("Hordaland").interpretation, ["sted: Vestland (fylke; «Hordaland»)"], "Q60: interpretation shows the alias that was folded");

    // ── K: agent-card examples ────────────────────────────────────────────
    const { getDentalAgentCard } = require("./dental-agent-card") as typeof import("./dental-agent-card");
    const examples: string[] = (getDentalAgentCard() as any).skills.find((s: any) => s.id === "tannlege_search").examples;
    assertEq(examples.length, 4, "K0: the search skill has four examples");
    for (const ex of examples) {
      const f = filterOf(ex);
      assertTrue(Object.keys(f).length > 0 && f.name_terms === undefined, `K1: agent-card example «${ex}» -> a non-empty filter without leftover words (${JSON.stringify(f)})`);
    }

    // ── V: vocabulary mirrors SPECIALTY_PAGES ─────────────────────────────
    const { DENTAL_SEARCH_VOCABULARY, findSearchSpecialty } = require("../config/dental-search-vocabulary") as typeof import("../config/dental-search-vocabulary");
    const { SPECIALTY_PAGES } = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
    assertEq(
      DENTAL_SEARCH_VOCABULARY.specialties.map((s) => [s.canonical, s.slug]),
      SPECIALTY_PAGES.map((p) => [p.navn, p.slug]),
      "V1: vocabulary canonical names and slugs mirror SPECIALTY_PAGES"
    );
    assertTrue(DENTAL_SEARCH_VOCABULARY.specialties.every((s) => s.title_stems.length > 0 && s.title_stems.every((t) => t === t.toLowerCase())), "V2: every specialty has lower-case title stems");
    assertEq(findSearchSpecialty("oral-kirurgi-og-oral-medisin")?.canonical, "oral kirurgi og oral medisin", "V3: findSearchSpecialty reads a slug");
    assertEq(findSearchSpecialty("Kjeveortopedi")?.canonical, "kjeveortopedi", "V4: findSearchSpecialty ignores case");
    assertEq(findSearchSpecialty("implantologi"), null, "V5: an unknown specialty -> null");
    for (const s of DENTAL_SEARCH_VOCABULARY.specialties) {
      assertEq(spec(s.canonical), s.canonical, `V6: the stored name «${s.canonical}» parses to itself`);
    }

    // ── S: planDentalSearch ───────────────────────────────────────────────
    const calls: Array<Record<string, unknown>> = [];
    const counter = (hits: (f: Record<string, unknown>) => number) => (f: Record<string, unknown>) => {
      calls.push(f);
      return hits(f);
    };
    const g = () => gazetteer;
    {
      const p = parser.planDentalSearch({ query: "Hordaland", explicit: { fylke: "Rogaland" }, gazetteer: g, count: counter(() => 3) });
      assertEq(p.filter, { fylke: "Rogaland" }, "S1: an explicit field wins over the parsed one");
      assertEq(p.count, 3, "S2: the plan carries the count");
      assertEq(p.tolkning?.tolket_som, ["sted: Vestland (fylke; «Hordaland»)"], "S3: tolkning reports what the parser read");
      assertEq(p.tolkning?.fallback, false, "S4: no fallback when the filter has hits");
    }
    {
      const p = parser.planDentalSearch({ query: "helfo Oslo", explicit: { helfo_agreement: undefined }, gazetteer: g, count: counter(() => 1) });
      assertEq(p.filter, { poststed_in: ["OSLO"] }, "S5: an explicit undefined removes the parsed field (helfo: false)");
    }
    {
      calls.length = 0;
      const p = parser.planDentalSearch({
        query: "Bergen Akutten",
        explicit: { chain_brand: "X" },
        gazetteer: g,
        count: counter((f) => (f.q ? 4 : 0)),
      });
      assertEq(p.filter, { chain_brand: "X", q: "Bergen Akutten" }, "S6: 0 parsed hits + old whole-text hits -> the old filter");
      assertEq(p.tolkning?.fallback, true, "S7: tolkning.fallback is true");
      assertEq(p.count, 4, "S8: the count is the old filter's");
      assertEq(calls.length, 2, "S9: one count for the parsed filter, one for the old one");
    }
    {
      const p = parser.planDentalSearch({ query: "Bergen Akutten", explicit: {}, gazetteer: g, count: () => 0 });
      assertEq(p.filter, { acute_vakt: 1, poststed_in: ["BERGEN", "Bergen"] }, "S10: both empty -> the parsed filter stays");
      assertEq(p.tolkning?.fallback, false, "S11: no fallback when the old filter is empty too");
    }
    {
      const p = parser.planDentalSearch({ query: "  ", explicit: { fylke: "Oslo" }, gazetteer: () => { throw new Error("not needed"); }, count: () => 7 });
      assertEq([p.filter, p.tolkning, p.count], [{ fylke: "Oslo" }, null, 7], "S12: no query text -> explicit fields only, no tolkning, gazetteer untouched");
    }
    {
      const p = parser.planDentalSearch({
        query: "kjeveortoped Trondheim",
        explicit: {},
        gazetteer: g,
        count: (f) => (f.legacy ? 2 : 0),
        legacy: () => ({ legacy: true }),
      });
      assertEq(p.filter, { legacy: true }, "S13: a caller-supplied old behaviour is used for the fallback (A2A)");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      assertTrue(parser.isDentalQueryParserDisabled(), "S14: DENTAL_QUERY_PARSER_DISABLED=1 is read");
      const p = parser.planDentalSearch({ query: "tannlege i Bergen", explicit: { fylke: "Vestland" }, gazetteer: () => { throw new Error("not needed"); }, count: () => 0 });
      assertEq([p.filter, p.tolkning], [{ fylke: "Vestland", q: "tannlege i Bergen" }, null], "S15: switched off -> the old whole-text q, no tolkning, no parsing");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "true";
    assertTrue(parser.isDentalQueryParserDisabled(), "S16: «true» also switches it off");
    process.env.DENTAL_QUERY_PARSER_DISABLED = "0";
    assertTrue(!parser.isDentalQueryParserDisabled(), "S17: any other value leaves the parser on");
  } catch (err: any) {
    failed++;
    failures.push("dental-query-parser: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    if (prevDisabled === undefined) delete process.env.DENTAL_QUERY_PARSER_DISABLED;
    else process.env.DENTAL_QUERY_PARSER_DISABLED = prevDisabled;
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runDentalQueryParserTests({ log: true });
  console.log(`\ndental-query-parser: ${r.passed} passed, ${r.failed} failed`);
  process.exit(r.failed > 0 ? 1 : 0);
}
