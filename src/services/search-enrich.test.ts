/**
 * search-enrich.test.ts — unit tests for the PURE decision logic behind
 * POST /admin/search-enrich (services/search-enrich.ts).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/search-enrich.test.ts
 *   2. Wired into the main gate: tests/test.ts imports runSearchEnrichTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 *
 * These are anti-contamination tests — they pin the invariants that keep the
 * pipeline from ever writing a directory/coordinator email or guessing when
 * the evidence is ambiguous.
 */

import {
  nameStems,
  normalizePhone,
  confirmProducerPage,
  pickProducerEmail,
  rankCandidates,
  // PR-A: homepage CONTENT extraction (PURE).
  extractVisibleText,
  extractBusinessTypeTokens,
  extractProductMentions,
  summarizeAbout,
  // PR-24a: homepage CONTENT → platform write helpers (PURE).
  mapToPlatformCategories,
  meetsAboutQualityBar,
  PLATFORM_CATEGORIES,
  // orch-experiences-content-refresh: experiences-vertical category mapper (PURE).
  mapToExperienceCategories,
  EXPERIENCE_CATEGORIES,
  type PageEvidence,
  type StoredProducer,
  type BraveResult,
} from "./search-enrich";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runSearchEnrichTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── nameStems ──────────────────────────────────────────────────────────────
  assertEq(nameStems("Nalums Gårdsbutikk"), ["nalums", "nalum"], "nameStems: Nalums Gårdsbutikk → [nalums, nalum]");
  assertEq(nameStems("Stordalen Gård AS"), ["stordalen"], "nameStems: strips 'Gård' + 'AS' stopwords");
  assertEq(nameStems("Ås Gaard SA"), [], "nameStems: 'Ås'(<4 after accent) + stopwords → empty");
  assertTrue(nameStems("Bærum Økologiske").includes("baerum"), "nameStems: æ→ae (bærum→baerum)");
  assertTrue(nameStems("Bærum Økologiske").includes("okologiske"), "nameStems: ø→o, å→a (økologiske→okologiske)");
  assertEq(nameStems(""), [], "nameStems: empty string → []");

  // ── normalizePhone ───────────────────────────────────────────────────────────
  assertEq(normalizePhone("+47 92431142"), "92431142", "normalizePhone: +47 strip + spaces");
  assertEq(normalizePhone("0047 924 31 142"), "92431142", "normalizePhone: 0047 country code stripped");
  assertEq(normalizePhone("92431142"), "92431142", "normalizePhone: bare 8 digits");
  assertEq(normalizePhone("47 92 43 11 42"), "92431142", "normalizePhone: leading 47 + spaced");
  assertEq(normalizePhone(null), "", "normalizePhone: null → ''");
  assertEq(normalizePhone(undefined), "", "normalizePhone: undefined → ''");
  assertEq(normalizePhone("Ring oss!"), "", "normalizePhone: no digits → ''");

  // ── Nalums positive: STRONG confirm via phone, producer email picked ─────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "+47 92431142" };
    const page: PageEvidence = {
      url: "https://hanen.no/produsent/nalums-gardsbutikk",
      title: "Nalums Gårdsbutikk - Hanen",
      html: "Kontakt: Tlf 924 31 142. E-post: post@hanen.no / hk-nalum@online.no",
      emails: ["post@hanen.no", "hk-nalum@online.no"],
      phones: ["92431142"],
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.strength, "strong", "Nalums: strength === 'strong' (phone match)");
    assertTrue(conf.confirmed, "Nalums: confirmed === true");
    assertTrue(conf.signals.includes("phone_match:92431142"), "Nalums: phone_match signal present");

    const pick = pickProducerEmail(page.emails, stored.name);
    assertEq(pick.email, "hk-nalum@online.no", "Nalums: picks hk-nalum@online.no (NOT post@hanen.no)");
    assertTrue(pick.reason.startsWith("name_stem_match"), `Nalums: reason name_stem_match (got '${pick.reason}')`);
    assertEq(pick.reason, "name_stem_match:nalum", "Nalums: reason names the matched stem 'nalum'");
  }

  // ── Coordinator-only: only post@hanen.no on a confirmed page → null ──────────
  {
    const pick = pickProducerEmail(["post@hanen.no"], "Nalums Gårdsbutikk");
    assertEq(pick.email, null, "Coordinator-only: returns null");
    assertEq(pick.reason, "no_acceptable_email", "Coordinator-only: reason no_acceptable_email");
  }
  // Also confirm the other hub families are rejected.
  {
    const pick = pickProducerEmail(
      ["kontakt@bondensmarkedtroms.no", "post@rekonorge.no"],
      "Nalums Gårdsbutikk",
    );
    assertEq(pick.email, null, "Hub families (bondensmarked/rekonorge) rejected → null");
    assertEq(pick.reason, "no_acceptable_email", "Hub families: no_acceptable_email");
  }

  // ── Wrong page (no key match) → NOT confirmed ────────────────────────────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "92431142", postcode: "4365" };
    const page: PageEvidence = {
      url: "https://some-other-farm.no",
      title: "Helt Annen Gård",
      html: "Kontakt 99887766. Adresse: Annenveien 3, 1234 Annetsted",
      emails: ["post@some-other-farm.no"],
      phones: ["99887766"], // different phone
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.confirmed, false, "Wrong page: confirmed === false (no key/name/postcode match)");
    assertEq(conf.strength, "none", "Wrong page: strength === 'none'");
  }

  // ── Ambiguous emails: two free-mail, neither a name stem → null ──────────────
  {
    const pick = pickProducerEmail(
      ["random123@gmail.com", "other456@gmail.com"],
      "Nalums Gårdsbutikk",
    );
    assertEq(pick.email, null, "Ambiguous: two distinct free-mails, no stem → null");
    assertEq(pick.reason, "ambiguous_multiple", "Ambiguous: reason ambiguous_multiple");
  }

  // ── MEDIUM confirm: two soft signals (name_in_title + postcode) ──────────────
  {
    const stored: StoredProducer = { name: "Nalums Gårdsbutikk", phone: "92431142", postcode: "4365" };
    const page: PageEvidence = {
      url: "https://nalum.no",
      title: "Nalums Gårdsbutikk – Velkommen",
      html: "Vi holder til i 4365 Nærbø. Ring oss gjerne.",
      emails: ["post@nalum.no"],
      phones: ["55555555"], // wrong phone → not strong
    };
    const conf = confirmProducerPage(stored, page);
    assertEq(conf.strength, "medium", "Medium: strength === 'medium' (name_in_title + postcode)");
    assertTrue(conf.confirmed, "Medium: confirmed === true (2 soft signals)");
    assertTrue(conf.signals.includes("name_in_title"), "Medium: name_in_title signal");
    assertTrue(conf.signals.includes("postcode_on_page"), "Medium: postcode_on_page signal");
  }

  // ── site_domain_match priority: email on stored siteRoot wins ────────────────
  {
    const pick = pickProducerEmail(
      ["info@nalum.no", "someoneelse@gmail.com"],
      "Nalums Gårdsbutikk",
      "nalum.no",
    );
    assertEq(pick.email, "info@nalum.no", "siteRoot: own-domain email chosen first");
    assertEq(pick.reason, "site_domain_match", "siteRoot: reason site_domain_match");
  }

  // ── single free-mail (no stem) → accepted as free_mail ───────────────────────
  {
    const pick = pickProducerEmail(["lonely@gmail.com"], "Nalums Gårdsbutikk");
    assertEq(pick.email, "lonely@gmail.com", "free_mail: single free-mail accepted");
    assertEq(pick.reason, "free_mail", "free_mail: reason free_mail");
  }

  // ── rankCandidates: producer-named result beats unrelated ────────────────────
  {
    const results: BraveResult[] = [
      { title: "Totally Unrelated Blog", url: "https://unrelated.example.com/post", description: "nothing here" },
      { title: "Nalums Gårdsbutikk offisiell side", url: "https://nalum.no", description: "Nalums gårdsbutikk i Nærbø" },
      { title: "Random news", url: "https://news.example.com", description: "weather today" },
    ];
    const ranked = rankCandidates(results, "Nalums Gårdsbutikk");
    assertTrue(ranked.length >= 1, "rankCandidates: at least one match");
    assertEq(ranked[0], "https://nalum.no", "rankCandidates: producer result ranked first");
    assertTrue(!ranked.includes("https://news.example.com"), "rankCandidates: unrelated (score 0) excluded");
    assertTrue(ranked.length <= 2, "rankCandidates: returns at most 2 URLs");
  }

  // ── rankCandidates: no name → [] ─────────────────────────────────────────────
  {
    const ranked = rankCandidates(
      [{ title: "x", url: "https://x.no", description: "y" }],
      "AS SA OG", // all stopwords → no stems
    );
    assertEq(ranked, [], "rankCandidates: name with only stopwords → []");
  }

  // ── PR-A: homepage CONTENT extraction (PURE) ───────────────────────────────
  // These pin the 4 REAL wrong-business-type/products complaints that motivated
  // PR-A. Each builds a tiny homepage snippet and asserts the extractors surface
  // the producer's OWN business-type/products (and NOT the wrong google_places
  // ones). Table-driven so the next complaint is one row.

  // extractVisibleText: strips scripts/styles/tags, collapses ws, caps length.
  {
    const html =
      "<html><head><title>X</title><style>.a{color:red}</style>" +
      "<script>var x = 'kjøtt og fisk';</script></head>" +
      "<body><h1>Velkommen</h1><p>Vi har&nbsp;grønnsaker</p></body></html>";
    const txt = extractVisibleText(html);
    assertTrue(txt.includes("Velkommen"), "extractVisibleText: keeps visible heading");
    assertTrue(txt.includes("grønnsaker"), "extractVisibleText: decodes &nbsp; and keeps body text");
    assertTrue(!txt.includes("color:red"), "extractVisibleText: drops <style> contents");
    assertTrue(!txt.toLowerCase().includes("var x"), "extractVisibleText: drops <script> contents (no false 'kjøtt' leak)");
    assertTrue(!txt.includes("<"), "extractVisibleText: no residual tags");
  }
  {
    const big = "ord ".repeat(20000); // ~80k chars
    assertTrue(extractVisibleText(big).length <= 20000, "extractVisibleText: caps at ~20k chars");
    assertEq(extractVisibleText(""), "", "extractVisibleText: empty in → empty out");
  }

  // ── COMPLAINT 1 — Ingunnshage: besøkshage, NOT hagekonsulent ───────────────
  {
    const text = extractVisibleText(
      "<h1>Ingunns Hage</h1><p>Velkommen til vår besøkshage med stauder og roser. " +
      "Åpen for besøk i sommerhalvåret.</p>",
    );
    const tokens = extractBusinessTypeTokens(text);
    assertTrue(tokens.includes("besokshage"), "complaint/Ingunnshage: besøkshage detected as business-type");
    assertTrue(!tokens.includes("hagekonsulent"), "complaint/Ingunnshage: NOT mislabelled hagekonsulent");
  }
  // Counterpart: a real hagekonsulent page is distinguished from a besøkshage.
  {
    const text = "Vi tilbyr hagekonsulent-tjenester og hageplanlegging for private hager.";
    const tokens = extractBusinessTypeTokens(text);
    assertTrue(tokens.includes("hagekonsulent"), "complaint/Ingunnshage: hagekonsulent page detected when truly a consultancy");
    assertTrue(!tokens.includes("besokshage"), "complaint/Ingunnshage: consultancy not mislabelled besøkshage");
  }

  // ── COMPLAINT 2 — Grette: andelslandbruk/vegetables, NOT meat ──────────────
  {
    const text = extractVisibleText(
      "<h1>Grette Andelslandbruk</h1><p>Bli andelshaver og høst ferske grønnsaker, " +
      "poteter og kål gjennom hele sesongen.</p>",
    );
    const tokens = extractBusinessTypeTokens(text);
    const products = extractProductMentions(text);
    assertTrue(tokens.includes("andelslandbruk"), "complaint/Grette: andelslandbruk detected as business-type");
    assertTrue(products.includes("vegetables"), "complaint/Grette: vegetables detected from grønnsaker/poteter/kål");
    assertTrue(!products.includes("meat"), "complaint/Grette: NOT mislabelled as meat producer");
  }

  // ── COMPLAINT 3 — Fløy Bakeri: bakery, but NO lefser ───────────────────────
  {
    const text = extractVisibleText(
      "<h1>Fløy Bakeri</h1><p>Håndverksbakeri med surdeigsbrød, rundstykker og " +
      "kanelboller. Bakt ferskt hver dag.</p>",
    );
    const products = extractProductMentions(text);
    const tokens = extractBusinessTypeTokens(text);
    assertTrue(products.includes("bread"), "complaint/FløyBakeri: bread detected (surdeig/rundstykker/boller)");
    assertTrue(tokens.includes("bakeri"), "complaint/FløyBakeri: bakeri detected as business-type");
    // The page does NOT mention lefse, so 'lefse' must not appear in the text we
    // would summarize/extract — guards against fabricating a product they don't make.
    assertTrue(!text.toLowerCase().includes("lefse"), "complaint/FløyBakeri: no lefser fabricated (not on page)");
  }
  // Counterpart: a page that DOES sell lefse still maps to bread (lexicon has it),
  // proving the absence above is real, not a missing keyword.
  {
    const products = extractProductMentions("Tradisjonell lefse og flatbrød til salgs.");
    assertTrue(products.includes("bread"), "complaint/FløyBakeri: lefse IS in lexicon → bread (absence above is genuine)");
  }

  // ── COMPLAINT 4 — Bomstad: goat, NOT shrimp ───────────────────────────────
  {
    const text = extractVisibleText(
      "<h1>Bomstad Gård</h1><p>Vi driver med geit og selger geitekjøtt og geitost " +
      "fra egen besetning.</p>",
    );
    const products = extractProductMentions(text);
    assertTrue(products.includes("meat"), "complaint/Bomstad: meat detected from geit/geitekjøtt");
    assertTrue(products.includes("dairy"), "complaint/Bomstad: dairy detected from geitost");
    assertTrue(!products.includes("fish"), "complaint/Bomstad: NOT mislabelled fish/shrimp (no reker on page)");
  }
  // Counterpart: a page that genuinely sells reker maps to fish — proves the
  // Bomstad 'no fish' result is because the page has no shrimp, not a gap.
  {
    const products = extractProductMentions("Ferske reker og krabbe rett fra båten.");
    assertTrue(products.includes("fish"), "complaint/Bomstad: reker IS in lexicon → fish (Bomstad absence is genuine)");
  }

  // extractProductMentions: empty / no-hit cases.
  {
    assertEq(extractProductMentions(""), [], "extractProductMentions: empty → []");
    assertEq(extractProductMentions("Vi tilbyr overnatting og opplevelser."), [], "extractProductMentions: no food nouns → []");
  }
  // extractBusinessTypeTokens: empty / benign-only.
  {
    assertEq(extractBusinessTypeTokens(""), [], "extractBusinessTypeTokens: empty → []");
    const benign = extractBusinessTypeTokens("Velkommen til vår gård og gårdsbutikk.");
    assertTrue(benign.includes("gard"), "extractBusinessTypeTokens: benign gård-family token detected");
  }

  // summarizeAbout: prefers og:description, then meta description, then 1st para.
  {
    const html =
      '<html><head><meta property="og:description" content="Familiedrevet gård med økologiske grønnsaker siden 1998."></head>' +
      "<body><p>Noe annet helt nede på siden.</p></body></html>";
    const sum = summarizeAbout(html);
    assertEq(sum, "Familiedrevet gård med økologiske grønnsaker siden 1998.", "summarizeAbout: uses og:description");
  }
  {
    const html =
      '<html><head><meta name="description" content="Vårt andelslandbruk dyrker grønnsaker til lokalsamfunnet."></head><body></body></html>';
    assertEq(summarizeAbout(html), "Vårt andelslandbruk dyrker grønnsaker til lokalsamfunnet.", "summarizeAbout: falls back to meta description");
  }
  {
    const html = "<body><nav>Meny</nav><p>Vi er et lite familiebakeri som baker surdeigsbrød hver morgen.</p></body>";
    const sum = summarizeAbout(html);
    assertTrue(sum.includes("familiebakeri"), "summarizeAbout: falls back to first meaningful paragraph");
  }
  {
    // ~300-char cap, deterministic (no generative text).
    const long = "ord ".repeat(200); // 800 chars of visible text
    const html = `<body><p>${long}</p></body>`;
    const sum = summarizeAbout(html);
    assertTrue(sum.length <= 300, "summarizeAbout: caps at ~300 chars");
    assertEq(summarizeAbout(""), "", "summarizeAbout: empty → empty");
  }

  // ── PR-24a: mapToPlatformCategories — extractor output → platform vocab ─────
  // Built from the live profile-removal complaints. Each case runs the SAME
  // extractors the writer uses, then maps to the platform category vocabulary,
  // pinning that the producer's REAL category wins over the wrong google_places one.
  {
    // COMPLAINT — Grette Andelslandbruk: a CSA VEGETABLE farm, mislabelled meat.
    const text = extractVisibleText(
      "<h1>Grette Andelslandbruk</h1><p>Vi dyrker økologiske grønnsaker, poteter og " +
      "kål i vårt andelslandbruk. Bli andelshaver!</p>",
    );
    const cats = mapToPlatformCategories(
      extractProductMentions(text),
      extractBusinessTypeTokens(text),
    );
    assertEq(cats, ["vegetables"], "map/Grette: → ['vegetables'] (andelslandbruk + grønnsaker)");
    assertTrue(!cats.includes("meat"), "map/Grette: NOT meat");
  }
  {
    // COMPLAINT — Fløy Bakeri: a bakery → platform 'bakery' (NOT lexicon 'bread').
    const text = extractVisibleText(
      "<h1>Fløy Bakeri</h1><p>Håndverksbakeri med surdeigsbrød, rundstykker og " +
      "kanelboller. Bakt ferskt hver dag.</p>",
    );
    const cats = mapToPlatformCategories(
      extractProductMentions(text),
      extractBusinessTypeTokens(text),
    );
    assertEq(cats, ["bakery"], "map/Fløy: → ['bakery'] (bakeri + surdeig/boller; bread→bakery)");
    assertTrue(!text.toLowerCase().includes("lefse"), "map/Fløy: no fabricated lefser on page");
  }
  {
    // COMPLAINT — Bomstad: a goat farm (meat + dairy), mislabelled fish/shrimp.
    const text = extractVisibleText(
      "<h1>Bomstad Gård</h1><p>Vi driver med geit og selger geitekjøtt og geitost " +
      "fra egen besetning.</p>",
    );
    const cats = mapToPlatformCategories(
      extractProductMentions(text),
      extractBusinessTypeTokens(text),
    );
    assertEq(cats, ["meat", "dairy"], "map/Bomstad: → ['meat','dairy'] (geitekjøtt + geitost)");
    assertTrue(!cats.includes("fish"), "map/Bomstad: NOT fish/shrimp");
  }
  // mapToPlatformCategories: lexicon-key normalisation + ordering + dedupe.
  {
    // bread→bakery, berries→fruit; output is canonical PLATFORM_CATEGORIES order.
    assertEq(mapToPlatformCategories(["bread"]), ["bakery"], "map: lexicon 'bread' → platform 'bakery'");
    assertEq(mapToPlatformCategories(["berries"]), ["fruit"], "map: lexicon 'berries' → platform 'fruit'");
    assertEq(
      mapToPlatformCategories(["fish", "meat", "dairy"]),
      ["meat", "dairy", "fish"],
      "map: result is canonical platform order, not input order",
    );
    assertEq(
      mapToPlatformCategories(["fruit", "berries"]),
      ["fruit"],
      "map: berries+fruit dedupe to single 'fruit'",
    );
    // business-type tokens alone can yield a category (beverages from bryggeri).
    assertEq(mapToPlatformCategories([], ["bryggeri"]), ["beverages"], "map: bryggeri token → beverages");
    assertEq(mapToPlatformCategories([], ["ysteri"]), ["dairy"], "map: ysteri token → dairy");
    // no mappable signal → [] (writer leaves categories untouched, never guesses).
    assertEq(mapToPlatformCategories([], []), [], "map: empty in → []");
    assertEq(mapToPlatformCategories([], ["besokshage", "gard"]), [], "map: non-food business tokens → [] (never 'other')");
    assertTrue(!mapToPlatformCategories(["meat"]).includes("other"), "map: 'other' is never auto-inferred");
    // every emitted category is a real platform key.
    const allOut = mapToPlatformCategories(["vegetables", "fruit", "meat", "dairy", "fish", "honey", "eggs", "herbs", "bread"]);
    assertTrue(allOut.every((c) => PLATFORM_CATEGORIES.includes(c)), "map: every output is a platform category key");
  }

  // ── PR-24a: meetsAboutQualityBar — the writer's about/description gate ───────
  {
    // Substantive Norwegian prose (≥80 chars, æ/ø/å) → passes.
    const good = "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger direkte fra gårdsbutikken.";
    assertTrue(meetsAboutQualityBar(good), "quality: substantive Norwegian about passes");
    // Too short → fails (tagline/fragment).
    assertTrue(!meetsAboutQualityBar("Gårdsbutikk på Toten."), "quality: <80 chars fails");
    assertTrue(!meetsAboutQualityBar(""), "quality: empty fails");
    assertTrue(!meetsAboutQualityBar(null), "quality: null fails");
    // English snippet of sufficient length but not Norwegian → fails.
    const english = "Welcome to our family farm shop where we sell fresh produce, eggs and homemade jam every weekend.";
    assertTrue(!meetsAboutQualityBar(english), "quality: long English snippet fails (not Norwegian)");
    // Cookie/consent boilerplate (long, Norwegian-ish) → fails.
    const cookie = "Vi bruker informasjonskapsler (cookies) for å gi deg en bedre opplevelse. Ved å fortsette godtar du vår personvern.";
    assertTrue(!meetsAboutQualityBar(cookie), "quality: cookie/consent boilerplate fails");
    // Placeholder under-construction → fails.
    const placeholder = "Denne siden er under konstruksjon. Nettsiden kommer snart med mer informasjon om gården vår og produktene.";
    assertTrue(!meetsAboutQualityBar(placeholder), "quality: under-construction placeholder fails");
    // Norwegian without nordic letters but with function words → passes.
    const noLetters = "Vi driver en liten gard og selger ferske produkter fra egen produksjon til lokalsamfunnet her.";
    assertTrue(meetsAboutQualityBar(noLetters), "quality: Norwegian via function words (no æøå) passes");
    // minLen override is honoured.
    assertTrue(meetsAboutQualityBar("Kort tekst på gården.", 10), "quality: minLen override honoured");
  }

  // ── orch-experiences-content-refresh: mapToExperienceCategories (PURE) ──────
  // The experiences-vertical twin of mapToPlatformCategories — maps a provider's
  // homepage visible text onto the experiences-DB category SLUGS (activity-based,
  // NOT the food vocab). Pins the slug vocabulary + word-boundary matching the
  // content-refresh writer depends on.
  {
    // Single-activity pages → the right slug.
    assertEq(
      mapToExperienceCategories("Bli med på hvalsafari fra Tromsø — se hval på nært hold."),
      ["dyreliv_safari"],
      "exp-cat: hvalsafari → dyreliv_safari"
    );
    assertEq(
      mapToExperienceCategories("Brevandring på Folgefonna og guidet fjelltur i naturen."),
      ["natur_friluft"],
      "exp-cat: brevandring/fjelltur → natur_friluft"
    );
    assertEq(
      mapToExperienceCategories("Rafting i Sjoa — elvepadling og kajakk for hele familien."),
      ["vannaktivitet"],
      "exp-cat: rafting/kajakk → vannaktivitet"
    );
    assertEq(
      mapToExperienceCategories("Opplev hundekjøring under nordlyset en vinterkveld."),
      ["vinteraktivitet"],
      "exp-cat: hundekjøring/nordlys → vinteraktivitet"
    );
    assertEq(
      mapToExperienceCategories("Guidet byvandring i den historiske bydelen, besøk museet."),
      ["kultur_historie"],
      "exp-cat: byvandring/museum → kultur_historie"
    );
    assertEq(
      mapToExperienceCategories("Ølsmaking på vårt lokale bryggeri, med matkurs etterpå."),
      ["mat_drikke"],
      "exp-cat: ølsmaking/bryggeri → mat_drikke"
    );
    assertEq(
      mapToExperienceCategories("Gårdsbesøk: kos med dyra på garden og ponniridning for barna."),
      ["gardsbesok"],
      "exp-cat: gårdsbesøk/ridning → gardsbesok"
    );
    assertEq(
      mapToExperienceCategories("Slapp av i vår spa og badstu, prøv yoga og isbad."),
      ["wellness_spa"],
      "exp-cat: spa/sauna/yoga → wellness_spa"
    );
  }
  {
    // Multi-category page → canonical EXPERIENCE_CATEGORIES order, deduped.
    const cats = mapToExperienceCategories(
      "Vi tilbyr både hvalsafari og rafting, samt en avsluttende ølsmaking."
    );
    assertEq(
      cats,
      ["dyreliv_safari", "vannaktivitet", "mat_drikke"],
      "exp-cat: multi-category emitted in canonical order, deduped"
    );
    // Result order is independent of mention order.
    const cats2 = mapToExperienceCategories(
      "Først ølsmaking, så rafting, til slutt en hvalsafari."
    );
    assertEq(cats2, cats, "exp-cat: order-independent (same set regardless of input order)");
  }
  {
    // No activity nouns → [] (writer never guesses a category).
    assertEq(
      mapToExperienceCategories("Vi tilbyr overnatting og gratis parkering ved anlegget."),
      [],
      "exp-cat: no activity nouns → []"
    );
    assertEq(mapToExperienceCategories(""), [], "exp-cat: empty → []");
    assertEq(mapToExperienceCategories(null), [], "exp-cat: null → []");
    assertEq(mapToExperienceCategories(undefined), [], "exp-cat: undefined → []");
  }
  {
    // Vocabulary alignment with the experiences-DB slugs + no food-vocab leakage.
    assertTrue(
      EXPERIENCE_CATEGORIES.includes("dyreliv_safari") &&
        EXPERIENCE_CATEGORIES.includes("natur_friluft") &&
        EXPERIENCE_CATEGORIES.includes("kultur_historie"),
      "exp-cat: vocab includes the harvest/seed slugs"
    );
    // Every emitted slug is a member of the declared vocabulary.
    const out = mapToExperienceCategories(
      "hvalsafari, brevandring, rafting, hundekjøring, museum, ølsmaking, gårdsbesøk, spa"
    );
    assertTrue(
      out.every((c) => EXPERIENCE_CATEGORIES.includes(c)),
      "exp-cat: every emitted slug is in EXPERIENCE_CATEGORIES"
    );
    // The food vocab must NOT leak into experiences categories.
    assertTrue(
      !out.includes("meat") && !out.includes("dairy") && !out.includes("vegetables"),
      "exp-cat: food-vocab keys never appear in experiences categories"
    );
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/search-enrich.test.ts`
// (require.main === module is the CJS entrypoint check; tsconfig compiles to CJS.)
if (require.main === module) {
  console.log("── search-enrich unit tests ──");
  const r = runSearchEnrichTests({ log: true });
  console.log(`\nsearch-enrich: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
