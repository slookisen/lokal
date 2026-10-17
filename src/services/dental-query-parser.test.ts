/**
 * dental-query-parser.test.ts — dev-request 2026-10-16-tannlege-sok-naturlig-sprak (S1).
 *
 * Table tests for the pure parser (no DB): a fixture gazetteer built with
 * buildNorwegianGazetteer() from a handful of stored poststed spellings, the
 * real kommune/fylke data, and the dental vocabulary.
 *   T   tokenize / normalize / placeKey / escapeLike / matchesAsWordPrefix
 *   Q   parseDentalQuery: place, specialty, akutt, Helfo, name words (Norwegian + English)
 *   B   bounds: a 1 MB and a 16 kB query, too many words, a word over 100 characters;
 *       detectPlaces is one linear pass
 *   W   whole-word triggers, stopwords, an empty reading, merged 2020 fylker,
 *       an explicit fylke against the place in the text
 *   K   the four agent-card examples give a non-empty filter
 *   V   the vocabulary mirrors SPECIALTY_PAGES (canonical names + slugs);
 *       findSearchSpecialty reads a whole value (name, slug, synonym)
 *   S   planDentalSearch: explicit arguments win, the old reading is kept
 *       (union; A2A's keyword reading in full), fallback flag, rollback switch;
 *       tolkning shows a kommune's postnumre as {kommunenummer, antall}
 *       while the plan's filter keeps the list (D3c, tolkningFilter)
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
    // S3b: a poststed that is also the name of a kommune covers the whole
    // kommune (its stored spellings OR the kommune's postnumre).
    const withKommune = (poststed_in: string[], kommunenummer: string) =>
      ({ poststed_or_postnummer: { poststed_in, postnummer_in: postnumreForKommune(kommunenummer) } });
    const BERGEN = withKommune(["BERGEN", "Bergen"], "4601");
    const STAVANGER = withKommune(["STAVANGER"], "1103");
    const TROMSO = withKommune(["TROMSØ"], "5501");
    const TRONDHEIM = withKommune(["TRONDHEIM"], "5001");

    assertEq(gazetteer.poststeder.get("bergen"), ["BERGEN", "Bergen"], "G1: every stored spelling of a poststed is kept, most common first");
    assertTrue(!gazetteer.poststeder.has("baerum") && !gazetteer.poststeder.has("kristiansand"), "G2: a kommune name stored as poststed is not a poststed");
    assertTrue(!gazetteer.poststeder.has(nq.placeKey("1014BV AMSTERDAM")), "G3: a foreign poststed is dropped");
    assertEq(gazetteer.maxWords, 3, "G4: longest place is three words (Møre og Romsdal, Mo i Rana)");

    // ── Q: acceptance cases from the dev-request ──────────────────────────
    assertEq(filterOf("tannlege i Bergen"), BERGEN, "Q1: «tannlege i Bergen» -> poststed BERGEN (all stored spellings) or Bergen kommune (S3b)");
    assertEq(filterOf("kjeveortoped Bergen"), { specialty: "kjeveortopedi", ...BERGEN }, "Q2: «kjeveortoped Bergen» -> kjeveortopedi + BERGEN");
    assertEq(filterOf("find orthodontist in Bergen"), { specialty: "kjeveortopedi", ...BERGEN }, "Q3: «find orthodontist in Bergen» -> kjeveortopedi + BERGEN");
    assertEq(filterOf("akuttvakt tannlege Stavanger"), { acute_vakt: 1, ...STAVANGER }, "Q4: «akuttvakt tannlege Stavanger» -> akutt + STAVANGER");
    assertEq(filterOf("finn tannlege med helfo-avtale i Oslo"), { helfo_agreement: "true", poststed_in: ["OSLO"] }, "Q5: «finn tannlege med helfo-avtale i Oslo» -> helfo + OSLO");
    assertEq(filterOf("Tromsø"), TROMSO, "Q6: «Tromsø» -> poststed TROMSØ (or Tromsø kommune, S3b)");
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
    assertEq(filterOf("Bodø"), withKommune(["BODØ", "Bodoe"], "1804"), "Q24: «Bodø» -> BODØ and the ASCII spelling Bodoe");
    assertEq(filterOf("emergency dentist Tromso"), { acute_vakt: 1, ...TROMSO }, "Q25: ASCII «Tromso» -> TROMSØ");
    assertEq(filterOf("tannlege Lofoten"), { fylke: "Nordland" }, "Q26: region Lofoten -> its fylke");
    {
      const r = parse("Herøy");
      assertEq(r.filter, { name_terms: ["herøy"] }, "Q27: «Herøy» (two kommuner, no single fylke) -> name word");
      assertTrue(r.interpretation.some((s) => s.includes("flere kommuner")), "Q28: interpretation notes Herøy is several kommuner");
    }
    assertEq(filterOf("tannlege Våler"), { name_terms: ["våler"] }, "Q29: «Våler» likewise");
    assertEq(filterOf("tannlege i Trondheim"), TRONDHEIM, "Q30: «Trondheim» -> poststed (or Trondheim kommune, S3b)");
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
    assertEq(parse("tannlege i Bergen").interpretation, ["sted: Bergen (poststed + kommune)"], "Q59: interpretation for a plain place");
    assertEq(parse("Hordaland").interpretation, ["sted: Vestland (fylke; «Hordaland»)"], "Q60: interpretation shows the alias that was folded");

    // ── B: bounds ─────────────────────────────────────────────────────────
    {
      const t = Date.now();
      const r = parse("tannlege i Bergen " + "Oslo Stavanger ".repeat(70_000));
      const ms = Date.now() - t;
      assertTrue(ms < 200, "B1: a 1 MB query with thousands of places is parsed in well under a second");
      assertEq(r.filter, BERGEN, "B2: ... the first place is used, the rest is not read");
      assertTrue(r.interpretation.includes(`merknad: bare de første ${parser.MAX_QUERY_CHARS} tegnene brukes`), "B3: ... and the cut is noted");
      const t16 = Date.now();
      const k16 = parse("kjeveortoped " + "Bergen Oslo Herøy ".repeat(900));
      assertTrue(Date.now() - t16 < 200 && k16.filter.specialty === "kjeveortopedi", "B3b: a 16 kB query is parsed as fast, from its first words");
    }
    {
      const r = parse(Array.from({ length: 40 }, (_, i) => `ord${i}`).join(" "));
      assertEq(r.residual_terms.length, parser.MAX_QUERY_TOKENS, "B4: only the first MAX_QUERY_TOKENS words are read");
      assertTrue(r.interpretation.includes(`merknad: bare de første ${parser.MAX_QUERY_TOKENS} ordene brukes`), "B5: ... noted");
    }
    {
      const r = parse("tannlege i Oslo " + "x".repeat(150));
      assertEq(r.filter, { poststed_in: ["OSLO"], name_terms: ["x".repeat(parser.MAX_TERM_CHARS)] }, "B6: a word over 100 characters is cut to 100 (the store's limit)");
      assertTrue(r.interpretation.includes(`merknad: ord over ${parser.MAX_TERM_CHARS} tegn er kortet ned`), "B7: ... noted");
      const p = parser.planDentalSearch({ query: "x".repeat(150), explicit: {}, gazetteer: () => gazetteer, count: () => 0 });
      assertTrue(Object.keys(p.filter).length > 0, "B8: a single long word still gives a filter (no ZodError, not «every clinic»)");
    }
    {
      const many = Array.from({ length: 5000 }, (_, i) => (i % 2 ? "oslo" : "bergen"));
      const t = Date.now();
      const found = nq.detectPlaces(many, gazetteer);
      const ms = Date.now() - t;
      assertEq(found.length, 5000, "B9: detectPlaces finds every place in one pass");
      assertTrue(ms < 500, "B10: ... in linear time (5,000 tokens)");
      assertEq(found.slice(0, 2).map((m) => [m.name, m.start]), [["BERGEN", 0], ["OSLO", 1]], "B11: ... leftmost first for equal length");
    }

    // ── W: words and places (review round 1) ─────────────────────────────
    assertEq(filterOf("Akuttklinikken Oslo"), { poststed_in: ["OSLO"], name_terms: ["akuttklinikken"] }, "W1: «Akuttklinikken» is a name word, not the akutt filter");
    assertEq(filterOf("Helfotannlegen Bergen"), { ...BERGEN, name_terms: ["helfotannlegen"] }, "W2: «Helfotannlegen» is a name word, not the Helfo filter");
    assertEq(filterOf("akutthjelp tannlegevakten Oslo"), { acute_vakt: 1, poststed_in: ["OSLO"] }, "W3: listed akutt forms still apply");
    assertEq(filterOf("tannlege med helfoavtale"), { helfo_agreement: "true" }, "W4: «helfoavtale» -> Helfo");
    assertEq(filterOf("tannlege Bergen sentrum"), BERGEN, "W5: «sentrum» is a stopword");
    assertEq(filterOf("is there any dentist open in Oslo"), { poststed_in: ["OSLO"] }, "W6: English function words are stopwords");
    assertEq(filterOf("tannlege for barn i Oslo"), { poststed_in: ["OSLO"] }, "W7: «barn» is not a name search");
    assertEq(filterOf("Can you find me an emergency dentist near Oslo?"), { acute_vakt: 1, poststed_in: ["OSLO"] }, "W7b: an English request sentence leaves no name words");
    assertEq(filterOf("oral kirurg i Bergen").specialty, "oral kirurgi og oral medisin", "W7c: «oral kirurg» -> oral kirurgi og oral medisin");
    {
      const r = parse("tannlege Time");
      assertEq(r.filter, {}, "W8: «tannlege Time» -> no filter");
      assertEq(r.interpretation, ["merknad: fant ikke sted, spesialitet eller navneord i teksten"], "W9: ... and tolkning says so");
    }
    {
      const r = parse("tannlege i Viken");
      assertEq(r.filter, { fylke_in: ["Viken", "Akershus", "Buskerud", "Østfold"] }, "W10: «Viken» -> the three fylker it covered (and rows stored as Viken)");
      assertEq(r.interpretation, ["sted: Akershus, Buskerud og Østfold (fylker; «Viken»)"], "W11: ... named in tolkning");
    }
    assertEq(filterOf("Troms og Finnmark"), { fylke_in: ["Troms og Finnmark", "Troms", "Finnmark"] }, "W12: «Troms og Finnmark» -> both fylker, not Troms alone");
    assertEq(filterOf("Vestfold og Telemark"), { fylke_in: ["Vestfold og Telemark", "Vestfold", "Telemark"] }, "W13: «Vestfold og Telemark» likewise");
    {
      const within = (q: string, fylke: string) => parser.parseDentalQuery(q, gazetteer, { withinFylke: fylke });
      const r = within("tannlege i Bergen", "Rogaland");
      assertEq(r.filter, {}, "W14: «Bergen» with explicit fylke Rogaland -> the place in the text is not used");
      assertEq(r.interpretation, ["merknad: «Bergen» ligger ikke i Rogaland; stedet i teksten brukes ikke"], "W15: ... and tolkning says so");
      assertEq(within("tannlege i Bergen", "hordaland").filter, BERGEN, "W16: a place inside the explicit fylke (any spelling) is kept");
      assertEq(within("tannlege i Bærum", "Akershus").filter.postnummer_in?.length, postnumreForKommune("3201").length, "W17: a kommune inside the explicit fylke is kept");
      assertEq(within("tannlege i Bærum", "Oslo").filter, {}, "W18: a kommune outside it is not");
      assertEq(within("tannlege i Sandvika", "Viken").filter, { poststed_in: ["SANDVIKA"] }, "W19: an explicit merged fylke covers its parts");
      assertEq(within("Bergen eller Stavanger", "Rogaland").filter, STAVANGER, "W20: the next place inside the explicit fylke is used");
      assertEq(within("tannlege i Bergen", "Ukjent").filter, BERGEN, "W21: an unknown explicit fylke drops nothing");
    }
    assertEq(nq.fylkerForPoststed("Bergen"), ["Vestland"], "W22: fylkerForPoststed reads any stored spelling");
    assertEq(nq.fylkerForPoststed("Baerum"), [], "W23: ... and [] for a name that is not a poststed");

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
    assertEq(
      ["kjeveortoped", "Orthodontist", "root canal", "oral kirurgi", "kjeve-og-ansiktsradiologi", "kjeveortopeden", "bergen kjeveortoped", ""].map((v) => findSearchSpecialty(v)?.canonical ?? null),
      ["kjeveortopedi", "kjeveortopedi", "endodonti", "oral kirurgi og oral medisin", "kjeve- og ansiktsradiologi", null, null, null],
      "V5b: findSearchSpecialty reads a whole synonym (an explicit spesialitet argument), not a word inside a longer value"
    );
    for (const s of DENTAL_SEARCH_VOCABULARY.specialties) {
      assertEq(spec(s.canonical), s.canonical, `V6: the stored name «${s.canonical}» parses to itself`);
    }
    assertEq(
      [[...DENTAL_SEARCH_VOCABULARY.kommuneWords], [...DENTAL_SEARCH_VOCABULARY.kommuneWords].filter((w) => !DENTAL_SEARCH_VOCABULARY.stopwords.has(w))],
      [["kommune", "kommunen", "municipality"], []],
      "V7: the kommune words (D3c) are kommune, kommunen and municipality, and each is still a stopword"
    );

    // ── S: planDentalSearch ───────────────────────────────────────────────
    const calls: Array<Record<string, unknown>> = [];
    const counter = (hits: (f: Record<string, unknown>) => number) => (f: Record<string, unknown>) => {
      calls.push(f);
      return hits(f);
    };
    const g = () => gazetteer;
    {
      const p = parser.planDentalSearch({ query: "Hordaland", explicit: { fylke: "Rogaland" }, gazetteer: g, count: counter(() => 3) });
      assertEq(p.filter, { fylke: "Rogaland", natural: { parsed: {}, legacy: { q: "Hordaland" } } }, "S1: an explicit fylke wins; the place in the text is dropped, the whole text is kept as the old q");
      assertEq(p.count, 3, "S2: the plan carries the count");
      assertEq(p.tolkning?.tolket_som, ["merknad: «Hordaland» ligger ikke i Rogaland; stedet i teksten brukes ikke"], "S3: tolkning says the place in the text was not used");
      assertEq(p.tolkning?.fallback, false, "S4: no fallback when nothing was parsed");
    }
    {
      const p = parser.planDentalSearch({ query: "Hordaland", explicit: { fylke: "Vestland" }, gazetteer: g, count: () => 3 });
      assertEq([p.filter, p.tolkning?.tolket_som], [{ fylke: "Vestland", natural: { parsed: {}, legacy: { q: "Hordaland" } } }, ["sted: Vestland (fylke; «Hordaland»)"]], "S4b: a place inside the explicit fylke is still reported");
    }
    {
      const p = parser.planDentalSearch({ query: "helfo Oslo", explicit: { helfo_agreement: undefined }, gazetteer: g, count: counter(() => 1) });
      assertEq(p.filter, { natural: { parsed: { poststed_in: ["OSLO"] }, legacy: { q: "helfo Oslo" } } }, "S5: an explicit undefined removes the parsed field (helfo: false)");
    }
    {
      calls.length = 0;
      const p = parser.planDentalSearch({ query: "Bergen Tannhelse", explicit: { chain_brand: "X" }, gazetteer: g, count: counter(() => 5) });
      assertEq(
        p.filter,
        { chain_brand: "X", natural: { parsed: { ...BERGEN, name_terms: ["tannhelse"] }, legacy: { q: "Bergen Tannhelse" } } },
        "S6: explicit AND (parsed OR the old whole-text q) — the old hits are never lost"
      );
      assertEq([p.count, p.tolkning?.fallback], [5, false], "S7: parsed hits -> no fallback");
      assertEq(calls, [p.filter, { chain_brand: "X", ...BERGEN, name_terms: ["tannhelse"] }], "S8: one count for the result, one for the parsed reading alone");
    }
    {
      const p = parser.planDentalSearch({ query: "Bergen Akutten", explicit: {}, gazetteer: g, count: (f) => (f.natural ? 4 : 0) });
      assertEq([p.count, p.tolkning?.fallback], [4, true], "S9: the parsed reading alone finds nothing -> tolkning.fallback (all hits are old whole-text hits)");
    }
    {
      calls.length = 0;
      const p = parser.planDentalSearch({ query: "Bergen Akutten", explicit: {}, gazetteer: g, count: counter(() => 0) });
      assertEq([p.count, p.tolkning?.fallback, calls.length], [0, false, 1], "S10: no hits at all -> no fallback, one count");
    }
    {
      calls.length = 0;
      const p = parser.planDentalSearch({ query: "tannlege", explicit: {}, gazetteer: g, count: counter(() => 9) });
      assertEq(p.filter, { natural: { parsed: {}, legacy: { q: "tannlege" } } }, "S11: nothing parsed -> every clinic (whole-text matches first)");
      assertEq([p.tolkning?.fallback, calls.length], [false, 1], "S11b: ... no fallback, no second count");
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
        count: () => 2,
        legacy: () => ({ helfo_agreement: "true", q: "kjeveortoped trondheim" }),
      });
      assertEq(
        p.filter,
        { natural: { parsed: { specialty: "kjeveortopedi", ...TRONDHEIM }, legacy: { helfo_agreement: "true", q: "kjeveortoped trondheim" } } },
        "S13: a caller's old reading (A2A's keyword parser) is the legacy branch"
      );
    }
    {
      calls.length = 0;
      const p = parser.planDentalSearch({ query: "tannlege i Tromsø", explicit: {}, gazetteer: g, count: counter(() => 8), legacy: () => ({ fylke: "Troms", q: undefined }) });
      assertEq(
        [p.filter, p.count, p.tolkning?.tolket_som],
        [{ natural: { parsed: TROMSO, legacy: { fylke: "Troms" } } }, 8, ["sted: Tromsø (poststed + kommune)"]],
        "S14: an old reading without name words (A2A read fylke Troms) is kept in full, so nothing it found is lost; tolkning shows the parsed place"
      );
    }
    {
      const noFilter = (count: (f: Record<string, unknown>) => number) =>
        parser.planDentalSearch({ query: "tannlege i Tromsø", explicit: {}, gazetteer: g, count, legacy: () => ({}) });
      const a = noFilter((f) => (f.poststed_or_postnummer ? 2 : 20));
      assertEq([a.filter, a.count, a.tolkning?.fallback], [TROMSO, 2, false], "S15: an old reading with no filter (A2A listed the first clinics) is replaced by the parsed one");
      const z = noFilter((f) => (f.poststed_or_postnummer ? 0 : 20));
      assertEq([z.filter, z.count, z.tolkning?.fallback], [{}, 20, true], "S15b: ... unless that finds nothing: the old answer, tolkning.fallback");
      const n = parser.planDentalSearch({ query: "tannlege", explicit: {}, gazetteer: g, count: () => 20, legacy: () => ({}) });
      assertEq([n.filter, n.tolkning?.fallback], [{}, false], "S15c: ... and as is when neither reading found anything to filter on");
    }
    {
      const huge = "Bergen " + "x".repeat(1024 * 1024);
      const t = Date.now();
      const p = parser.planDentalSearch({ query: huge, explicit: {}, gazetteer: g, count: () => 0 });
      const ms = Date.now() - t;
      assertTrue(ms < 200, "S16: a 1 MB query is planned in well under a second");
      assertEq([p.tolkning?.sporring.length, ((p.filter.natural as any).legacy.q as string).length], [parser.MAX_QUERY_CHARS, parser.MAX_QUERY_CHARS], "S17: sporring and the old whole-text q are cut to MAX_QUERY_CHARS");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "1";
    {
      assertTrue(parser.isDentalQueryParserDisabled(), "S18: DENTAL_QUERY_PARSER_DISABLED=1 is read");
      const p = parser.planDentalSearch({ query: "tannlege i Bergen", explicit: { fylke: "Vestland" }, gazetteer: () => { throw new Error("not needed"); }, count: () => 0 });
      assertEq([p.filter, p.tolkning], [{ fylke: "Vestland", q: "tannlege i Bergen" }, null], "S19: switched off -> the old whole-text q, no tolkning, no parsing");
      const raw = parser.planDentalSearch({ query: " Bergen ", explicit: {}, gazetteer: g, count: () => 0, legacy: (text) => ({ seen: text }) });
      assertEq(raw.filter, { seen: " Bergen " }, "S20: switched off -> the caller's old reading gets the text exactly as before (untrimmed)");
    }
    process.env.DENTAL_QUERY_PARSER_DISABLED = "true";
    assertTrue(parser.isDentalQueryParserDisabled(), "S20b: «true» also switches it off");
    process.env.DENTAL_QUERY_PARSER_DISABLED = "0";
    assertTrue(!parser.isDentalQueryParserDisabled(), "S20c: any other value leaves the parser on");
    delete process.env.DENTAL_QUERY_PARSER_DISABLED;

    // ── S: tolkning.filter shows a kommune, not its postnummer list (D3c) ─
    {
      const plan = (query: string, explicit: Record<string, unknown> = {}) => parser.planDentalSearch({ query, explicit, gazetteer: g, count: () => 5 });
      const bergen = plan("tannlege i Bergen");
      assertEq(
        [bergen.filter, bergen.tolkning?.filter],
        [
          { natural: { parsed: BERGEN, legacy: { q: "tannlege i Bergen" } } },
          { natural: { parsed: { poststed_or_postnummer: { poststed_in: ["BERGEN", "Bergen"], postnummer_in: { kommunenummer: "4601", antall: 144 } } }, legacy: { q: "tannlege i Bergen" } } },
        ],
        "S21: Bergen: the plan's filter keeps the 144 postnumre; tolkning shows {kommunenummer: 4601, antall: 144}"
      );
      const baerum = plan("tannlege i Bærum");
      const baerumPnr = postnumreForKommune("3201");
      assertEq(
        [(baerum.filter.natural as any).parsed.postnummer_in, (baerum.tolkning?.filter.natural as any)?.parsed.postnummer_in],
        [baerumPnr, { kommunenummer: "3201", antall: baerumPnr.length }],
        "S22: Bærum (a kommune read by postnummer): the list in the plan's filter, {kommunenummer: 3201, antall} in tolkning"
      );
      const unchanged: Array<[string, Record<string, unknown>]> = [
        ["tannlege i Oslo", {}], ["tannlege i Vestland", {}], ["tannlege i Viken", {}], ["kjeveortoped", {}],
        ["Hordaland", { fylke: "Rogaland" }], ["helfo Oslo", { helfo_agreement: undefined, specialty: "periodonti" }],
      ];
      for (const [q, explicit] of unchanged) {
        const p = plan(q, explicit);
        assertEq(p.tolkning?.filter, p.filter, `S23: «${q}» ${JSON.stringify(explicit)}: no postnummer list, so tolkning.filter is the plan's filter`);
      }
    }
    {
      const bergenPnr = postnumreForKommune("4601");
      const shown = (list: unknown[]) => {
        try { return parser.tolkningFilter({ postnummer_in: list }).postnummer_in; } catch (err) { return `threw ${String(err)}`; }
      };
      assertEq(
        [shown(["0000"]), shown(["abcd", 5]), shown([]), shown(["5003", "5004"]), shown([...bergenPnr, "5003"]), shown([...bergenPnr].reverse())],
        [{ antall: 1 }, { antall: 2 }, { antall: 0 }, { antall: 2 }, { antall: 145 }, { kommunenummer: "4601", antall: 144 }],
        "S24: {antall} alone, never a throw, for an unknown or malformed postnummer, an empty list or one that is not exactly one whole kommune (any order counts)"
      );
      const input = { fylke: "Vestland", q: null, fylke_in: ["Viken", "Akershus"], natural: { parsed: { postnummer_in: ["5003", "5004"] }, legacy: { q: "x" } } };
      const before = JSON.stringify(input);
      const once = parser.tolkningFilter(input);
      assertEq(
        [once, JSON.stringify(input) === before, parser.tolkningFilter(once)],
        [{ fylke: "Vestland", q: null, fylke_in: ["Viken", "Akershus"], natural: { parsed: { postnummer_in: { antall: 2 } }, legacy: { q: "x" } } }, true, once],
        "S24b: other fields are kept as they are, the input is not changed, and a shown filter passes through unchanged"
      );
    }
    {
      // No postnummer list of any length is left anywhere in tolkning.
      const lists = (v: unknown, at = ""): string[] =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.entries(v).flatMap(([k, x]) => (k === "postnummer_in" && Array.isArray(x) ? [`${at}${k}`] : lists(x, `${at}${k}.`)))
          : [];
      for (const q of ["tannlege i Bergen", "tannlege i Trondheim", "tannlege i Stavanger", "tannlege i Tromsø", "tannlege i Bærum", "tannlege i Kvam kommune"]) {
        const p = parser.planDentalSearch({ query: q, explicit: {}, gazetteer: g, count: () => 1 });
        assertEq([lists(p.filter).length > 0, lists(p.tolkning?.filter)], [true, []], `S25: «${q}»: the plan's filter has a postnummer list, tolkning has none`);
      }
    }
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
