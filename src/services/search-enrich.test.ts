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
    // Mangled text carrying the Unicode replacement char (a mid-character
    // byte-level truncation upstream, e.g. cutting "på" in half) must never
    // be written as a description — customer-reported bug: Olestølen
    // Mikroysteri's meta description ended "...opplevelser p�".
    const mangledTrailing = good.slice(0, 60) + " opplevelser p�";
    assertTrue(!meetsAboutQualityBar(mangledTrailing), "quality: trailing replacement-char (mid-word cut) fails");
    const mangledInterior = good.slice(0, 40) + "�" + good.slice(40);
    assertTrue(!meetsAboutQualityBar(mangledInterior), "quality: interior replacement-char fails");

    // ── nav-menu / boilerplate-menu leakage (data-quality bug found in a
    // gardssalg-content-refresh dry-run: ~40-50% of candidates passing this
    // gate were actually scraped <nav> chrome, not venue prose) ────────────
    // Real example 1: a numbered breadcrumb/nav list, no sentence structure.
    const navNumbered =
      "01 Hjem 02 Vingård 03 Sideri 04 Tjenester 05 Opplevelser 06 Servering, book bord og finn åpningstider her hos oss.";
    assertTrue(!meetsAboutQualityBar(navNumbered), "quality: numbered nav-menu list fails");
    // Real example 2: pipe/arrow-separated nav menu with a "top of page" anchor.
    const navPipeArrow =
      "--> HEIM | Lofthus sideri top of page HEIM JUICE SIDER OM OSS UTSALG KONTAKT Velkommen til vår gård i Hardanger.";
    assertTrue(!meetsAboutQualityBar(navPipeArrow), "quality: pipe/arrow nav-menu with 'top of page' marker fails");
    // Pure pipe-separated menu (no explicit marker) — many '|' separators, zero
    // sentence-ending punctuation.
    const navPipeOnly =
      "Hjem | Om oss | Produkter | Nettbutikk | Kontakt oss | Meny | Nyheter | Arrangementer for hele familien";
    assertTrue(!meetsAboutQualityBar(navPipeOnly), "quality: pure pipe-separated menu (no punctuation) fails");
    // Pure arrow-separated menu (no explicit marker) — same shape with '-->'.
    const navArrowOnly =
      "Forside --> Om gården --> Produkter --> Nettbutikk --> Kontakt --> Meny --> Åpningstider for besøkende";
    assertTrue(!meetsAboutQualityBar(navArrowOnly), "quality: pure arrow-separated menu (no punctuation) fails");
    // Norwegian skip-link marker alone, embedded in otherwise plausible prose.
    const navSkipLink =
      "Hopp til innhold. Velkommen til gårdsbutikken vår hvor du finner ferske grønnsaker, egg og kjøtt fra egen produksjon.";
    assertTrue(!meetsAboutQualityBar(navSkipLink), "quality: 'hopp til innhold' skip-link marker fails");

    // Near-miss REAL prose that must NOT be over-rejected by the new checks.
    // Mentions a number immediately followed by a capitalized word exactly
    // once (below the ≥3 numbered-menu-item threshold).
    const realWithNumber =
      "Vi holder åpent fra klokken 10 Alle dager i sommersesongen, og tilbyr ferske bær, grønnsaker og hjemmelaget saft fra egen gård i Hardanger.";
    assertTrue(meetsAboutQualityBar(realWithNumber), "quality: real prose mentioning one number+capital word still passes");
    // Mentions a food "meny" (menu) but is written as real sentences with
    // normal punctuation and no pipe/arrow separators.
    const realWithMenu =
      "Vår restaurant har en fast meny med lokale råvarer, og gjestene kan også besøke gårdsbutikken vår for å handle rett fra produksjonen.";
    assertTrue(meetsAboutQualityBar(realWithMenu), "quality: real prose mentioning a food 'meny' still passes");
    // Regression (review fix-up): genuine, fully-punctuated Norwegian prose
    // (three real sentences) that happens to contain an inline opening-hours
    // listing shaped like the numbered-menu-list pattern ("Man 10 Åpent, Tir
    // 10 Åpent, ..." — five "digit + capitalized word" hits, clearing the ≥3
    // threshold) must NOT be rejected just because rule 1 fired without a
    // punctuation escape hatch — it has real sentence structure, unlike a
    // scraped <nav> list.
    const realWithOpeningHoursList =
      "Vi holder åpent i sommersesongen. Kom innom gårdsbutikken vår for ferske varer. Åpningstider: Man 10 Åpent, Tir 10 Åpent, Ons 10 Åpent, Tor 10 Åpent, Fre 10 Åpent.";
    assertTrue(
      meetsAboutQualityBar(realWithOpeningHoursList),
      "quality: real prose with inline opening-hours numbered list still passes"
    );

    // ── round-2 (2026-07-11): found via a live production dry-run resample of
    // gardssalg-content-refresh — ~26% of candidates that passed round-1's
    // gate were still wrong (target ≤2%). Four concrete real examples that
    // must now be rejected, none caught by round-1's numbered/pipe-arrow-only
    // isLikelyNavMenuLeakage checks. ─────────────────────────────────────────

    // Real example 1: a flat, space-separated e-commerce nav bar (no numbers,
    // no pipes/arrows — round-1 has neither signal to catch this shape).
    const navFlatMenu =
      "Harstad Bryggeri Cart 0 Bryggeriet Ølet Omvisning & ølsmaking Nyheter Bryggeriutsalg Kontakt Ølsjappa Merch - Klær og så";
    assertTrue(!meetsAboutQualityBar(navFlatMenu), "quality: flat Title-Case nav bar (no numbers/pipes) fails");

    // Real example 2: nav chrome with a language-switcher token ("no en") and
    // a repeated tagline — only ONE "-->", under round-1's ≥3-separator bar.
    const navLangSwitchDup =
      "--> Mack – Verdens nordligste bryggeri Besøk oss Verdens nordligste bryggeri no en Om Mack Produkter Bærekraft Mik";
    assertTrue(!meetsAboutQualityBar(navLangSwitchDup), "quality: single-arrow nav chrome with duplicated tagline fails");

    // Real example 3: the same short breadcrumb phrase repeated back-to-back
    // by the scraper — only 2 pipes, under round-1's ≥3-separator threshold,
    // and round-1 never checked for literal duplication at all.
    const navDuplicatedBreadcrumb =
      "besøk | Ekeby Gårdsbryggeri besøk | Ekeby Gårdsbryggeri An immersive digital experience for a historic Swedish monastery";
    assertTrue(!meetsAboutQualityBar(navDuplicatedBreadcrumb), "quality: literally-duplicated breadcrumb phrase fails");

    // Real example 4: a NEW failure mode — genuine, grammatical, punctuated
    // Norwegian prose that passes every formatting check, but describes a
    // REGIONAL TOURISM-ASSOCIATION/UMBRELLA PORTAL's member businesses
    // collectively, not this one specific producer. A wrong-ENTITY bug, not a
    // formatting bug.
    const umbrellaAbout =
      "Opplev Norge Aktiviteter og opplevelser Overnatting Mat- og drikkeprodusenter Gårdsbutikker Servering Møter, kurs og selskaper Fiske og jakt Vandring";
    assertTrue(!meetsAboutQualityBar(umbrellaAbout), "quality: umbrella-portal dense category listing fails");
    const umbrellaVisit =
      "Våre medlemmer tilbyr alt fra sjarmerende gårdsbutikker med lokalprodusert mat, til koselig overnatting i landlige omgivelser og spennende aktiviteter for hele familien.";
    assertTrue(
      !meetsAboutQualityBar(umbrellaVisit),
      "quality: 'våre medlemmer' collective-membership language fails (real prose, wrong entity)"
    );

    // Regression: round-1's bad examples must STILL reject after the round-2
    // additions (navNumbered/navPipeArrow/navPipeOnly/navArrowOnly/navSkipLink
    // above are re-asserted here as an explicit no-regression pin).
    assertTrue(!meetsAboutQualityBar(navNumbered), "quality (regression): round-1 numbered nav-menu list still fails");
    assertTrue(
      !meetsAboutQualityBar(navPipeArrow),
      "quality (regression): round-1 pipe/arrow nav-menu with 'top of page' marker still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(navPipeOnly),
      "quality (regression): round-1 pure pipe-separated menu still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(navArrowOnly),
      "quality (regression): round-1 pure arrow-separated menu still fails"
    );

    // Regression: legitimate prose with a numeric inline list (opening-hours
    // style, written as real sentences) must NOT be over-rejected by the new
    // flat-menu-density / repeated-phrase checks either.
    assertTrue(
      meetsAboutQualityBar(realWithOpeningHoursList),
      "quality (regression): real prose with inline opening-hours list still passes after round-2 additions"
    );
    assertTrue(
      meetsAboutQualityBar(realWithMenu),
      "quality (regression): real prose mentioning a food 'meny' still passes after round-2 additions"
    );

    // ── round-2 fix-up (2026-07-11, review CHANGES-REQUESTED): signal 3's
    // flat-menu-density check over-rejected genuine, grammatical, single-
    // sentence Norwegian prose that (a) lists several proper-noun
    // products/places — common Norwegian farm/dairy producer marketing — and
    // (b) uses PASSIVE voice ("produseres"), which the old REAL_PROSE_SIGNAL_
    // WORDS allowlist had zero coverage for (only active "selger" was
    // present). Reviewer's exact reproduced failing example: ─────────────────
    const reviewerPassiveProductList =
      "Nordfjord Ost Sunnmøre Smør Stryn Rømme Geiranger Skyr Loen Youghurt Olden Kefir Briksdal Kremfløte og Hjørundfjord Cottage Cheese produseres her på garden hver eneste dag.";
    assertTrue(
      meetsAboutQualityBar(reviewerPassiveProductList),
      "quality: passive-voice sentence with Title-Case product-name list passes (round-2 fix-up)"
    );
    // Close variant: different Title-Case product/place list, different
    // passive verbs ("lages"/"selges" instead of "produseres") — confirms the
    // fix is a general passive-voice/preposition signal, not overfit to the
    // one exact reviewer string.
    const passiveProductListVariant =
      "Rørosost Fjellgeit Osterød Skinke Tydal Spekemat Selbu Rømmegrøt Aune Multer og Holtålen Tyttebær lages og selges her på garden hele året.";
    assertTrue(
      meetsAboutQualityBar(passiveProductListVariant),
      "quality: passive-voice product list with different verbs still passes (round-2 fix-up)"
    );
    // Close variant: passive voice + preposition, but NOT a Title-Case product
    // list (ordinary lowercase-heavy prose) — was already passing before the
    // fix (capRatio never crossed 0.5), pinned here so the fix's word-list
    // broadening doesn't regress the already-working case either.
    const passiveNoProductList =
      "Alle ostene på gården produseres for hånd av bonden selv hver eneste morgen før soloppgang med kjærlighet og omtanke fra hele familien.";
    assertTrue(
      meetsAboutQualityBar(passiveNoProductList),
      "quality: passive-voice prose without a product-name list still passes (round-2 fix-up)"
    );

    // Regression: round-2's four original bad examples must STILL be rejected
    // after the fix-up's REAL_PROSE_SIGNAL_WORDS broadening (none of them
    // contain the newly-added passive verbs or "på"/"fra"/"med").
    assertTrue(
      !meetsAboutQualityBar(navFlatMenu),
      "quality (regression): round-2 flat Title-Case nav bar still fails after fix-up"
    );
    assertTrue(
      !meetsAboutQualityBar(navLangSwitchDup),
      "quality (regression): round-2 lang-switcher/duplicated-tagline nav chrome still fails after fix-up"
    );
    assertTrue(
      !meetsAboutQualityBar(navDuplicatedBreadcrumb),
      "quality (regression): round-2 duplicated breadcrumb still fails after fix-up"
    );
    assertTrue(
      !meetsAboutQualityBar(umbrellaAbout),
      "quality (regression): round-2 umbrella-portal dense category listing still fails after fix-up"
    );
    assertTrue(
      !meetsAboutQualityBar(umbrellaVisit),
      "quality (regression): round-2 'våre medlemmer' collective-membership prose still fails after fix-up"
    );

    // ── round-2 fix-up-2 (2026-07-11, review CHANGES-REQUESTED): fix-up-1
    // added "på"/"fra"/"med" to REAL_PROSE_SIGNAL_WORDS as a broad "common
    // prepositions are near-universal in real sentences" signal — but those 3
    // short prepositions are JUST AS near-ubiquitous in scraped Norwegian
    // nav/footer CHROME, so a single incidental match silently defeated
    // signal 3 for genuine nav-menu leakage (the unsafe direction: nav chrome
    // would get written to a real producer's public profile). Fixed by
    // dropping the 3 bare prepositions and relying on the passive-voice verbs
    // alone. Reviewer's exact reproduced failing examples: ──────────────────
    const navPrepositionLeakage1 =
      "Hjem Om Oss Produkter Nyheter Kontakt Nettbutikk Bestill Levering Fra 49 Facebook Instagram Ølkart Meny Åpningstider";
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage1),
      "quality: flat nav bar with 'Fra' no longer false-passes via bare-preposition signal (fix-up-2)"
    );
    const navPrepositionLeakage2 =
      "Hjem Handlekurv Produkter Bestilling Levering Med Bud Kontakt Nyhetsbrev Facebook Instagram Ølkart Meny Åpning";
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage2),
      "quality: flat nav bar with 'Med' no longer false-passes via bare-preposition signal (fix-up-2)"
    );
    const navPrepositionLeakage3 =
      "Hjem Produkter Kontakt Følg Oss På Facebook Instagram Nyheter Bryggeriutsalg Ølkart Meny Åpningstider Handlekurv";
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage3),
      "quality: flat nav bar with 'På' no longer false-passes via bare-preposition signal (fix-up-2)"
    );

    // Regression: the passive-voice verbs alone (no prepositions) must still
    // be sufficient to pass genuine passive-voice product-list prose —
    // confirms the fix-up-1 examples don't silently depend on på/fra/med.
    assertTrue(
      meetsAboutQualityBar(reviewerPassiveProductList),
      "quality (regression): passive-voice product-list prose still passes without bare prepositions (fix-up-2)"
    );
    assertTrue(
      meetsAboutQualityBar(passiveProductListVariant),
      "quality (regression): passive-voice product-list variant still passes without bare prepositions (fix-up-2)"
    );
    assertTrue(
      meetsAboutQualityBar(passiveNoProductList),
      "quality (regression): passive-voice prose without product list still passes without bare prepositions (fix-up-2)"
    );

    // ── round-3 fix-up-3 (2026-07-11, Daniel-approved option A): round-3
    // review found UMBRELLA_MEMBERSHIP_MARKERS bypassable by differently-
    // worded collective/umbrella-portal prose that never uses the literal
    // "våre medlemmer" family of phrases. Fixed with two STRUCTURAL signals
    // (hasPluralPossessiveCollectiveFraming, hasMultiEntityMention) instead
    // of another keyword-list point-fix. Three independently-worded
    // collective/umbrella-portal examples below, none containing "medlem"
    // (or any other UMBRELLA_MEMBERSHIP_MARKERS phrase) at all. ─────────────

    // Example 1: plural-possessive collective framing via "produsenter"
    // (producers), not "medlemmer" — signal 1.
    const collectiveProdusenter =
      "Hos oss finner du et rikt utvalg av lokale opplevelser og gode smaker. Våre produsenter tilbyr alt fra nystekt bakverk til nykjernet smør, og du er alltid hjertelig velkommen til å besøke gårdsbutikkene i regionen.";
    assertTrue(
      !meetsAboutQualityBar(collectiveProdusenter),
      "quality: 'våre produsenter' collective framing fails without literal umbrella marker phrase (round-3 fix-up-3)"
    );

    // Example 2: plural-possessive collective framing via "aktører"
    // (operators/actors) — different noun, different sentence shape from
    // example 1, still signal 1.
    const collectiveAktorer =
      "Regionen har et yrende reiseliv med mange spennende steder å besøke. Blant våre aktører finner du alt fra tradisjonsrike gårder til moderne opplevelsessentre, og alle ønsker deg hjertelig velkommen innom.";
    assertTrue(
      !meetsAboutQualityBar(collectiveAktorer),
      "quality: 'våre aktører' collective framing fails without literal umbrella marker phrase (round-3 fix-up-3)"
    );

    // Example 3: no "vår"/"våre" possessive at all — instead enumerates 4
    // distinctly-named businesses in one blurb, real grammatical prose with
    // proper sentence-ending punctuation (so it clears every OTHER check),
    // caught purely by signal 2 (multi-entity mention).
    const collectiveMultiEntity =
      "Turen gjennom bygda byr på mange flotte stopp. Første stopp er Nordfjord Ysteri som ligger idyllisk til, videre kan du besøke Sunnmøre Bryggeri før du tar turen innom Stryn Sjokoladefabrikk, og aller sist stopper du hos Geiranger Vingård for en smak av lokal frukt.";
    assertTrue(
      !meetsAboutQualityBar(collectiveMultiEntity),
      "quality: prose enumerating 4 distinctly-named businesses fails via multi-entity signal (round-3 fix-up-3)"
    );

    // Legitimate single-producer prose that must still PASS — guards against
    // over-rejection from the two new structural signals. Uses "vår gård"
    // (SINGULAR self-reference, not the plural "våre gårder"/"gardene våre"
    // that signal 1 targets) and mentions its own village + a product name
    // but does not enumerate other distinctly-named businesses (0 distinct
    // ≥2-token Title-Case runs, well under the multi-entity threshold).
    const legitimateSingleProducer =
      "Vi er en liten familiegård i Hjartdal i Telemark. Her produserer vi gårdsost for hånd av melk fra egne geiter, og gården vår har vore i familien i fire generasjoner. Velkommen innom gårdsbutikken for å smake ostene våre.";
    assertTrue(
      meetsAboutQualityBar(legitimateSingleProducer),
      "quality: legitimate single-producer prose (own village + product, singular 'vår gård') still passes (round-3 fix-up-3)"
    );

    // Regression: all prior nav-menu, passive-voice-prose and original
    // literal-umbrella-marker pins must still hold after adding the two new
    // structural signals (no weakening/removal of any earlier assertion).
    assertTrue(!meetsAboutQualityBar(navFlatMenu), "quality (regression, fix-up-3): flat Title-Case nav bar still fails");
    assertTrue(
      !meetsAboutQualityBar(navLangSwitchDup),
      "quality (regression, fix-up-3): lang-switcher/duplicated-tagline nav chrome still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(navDuplicatedBreadcrumb),
      "quality (regression, fix-up-3): duplicated breadcrumb still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(umbrellaAbout),
      "quality (regression, fix-up-3): umbrella-portal dense category listing still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(umbrellaVisit),
      "quality (regression, fix-up-3): 'våre medlemmer' collective-membership prose still fails"
    );
    assertTrue(!meetsAboutQualityBar(navNumbered), "quality (regression, fix-up-3): round-1 numbered nav-menu list still fails");
    assertTrue(
      !meetsAboutQualityBar(navPipeArrow),
      "quality (regression, fix-up-3): round-1 pipe/arrow nav-menu with 'top of page' marker still fails"
    );
    assertTrue(!meetsAboutQualityBar(navPipeOnly), "quality (regression, fix-up-3): round-1 pure pipe-separated menu still fails");
    assertTrue(!meetsAboutQualityBar(navArrowOnly), "quality (regression, fix-up-3): round-1 pure arrow-separated menu still fails");
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage1),
      "quality (regression, fix-up-3): flat nav bar with 'Fra' still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage2),
      "quality (regression, fix-up-3): flat nav bar with 'Med' still fails"
    );
    assertTrue(
      !meetsAboutQualityBar(navPrepositionLeakage3),
      "quality (regression, fix-up-3): flat nav bar with 'På' still fails"
    );
    assertTrue(
      meetsAboutQualityBar(realWithOpeningHoursList),
      "quality (regression, fix-up-3): real prose with inline opening-hours list still passes"
    );
    assertTrue(meetsAboutQualityBar(realWithMenu), "quality (regression, fix-up-3): real prose mentioning a food 'meny' still passes");
    assertTrue(
      meetsAboutQualityBar(reviewerPassiveProductList),
      "quality (regression, fix-up-3): passive-voice product-list prose (2 distinct Title-Case runs) still passes — does not trip the new multi-entity threshold"
    );
    assertTrue(
      meetsAboutQualityBar(passiveProductListVariant),
      "quality (regression, fix-up-3): passive-voice product-list variant (2 distinct Title-Case runs) still passes — does not trip the new multi-entity threshold"
    );
    assertTrue(
      meetsAboutQualityBar(passiveNoProductList),
      "quality (regression, fix-up-3): passive-voice prose without product list still passes"
    );
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
