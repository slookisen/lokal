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
  summarizeVisit,
  // dev-request 2026-07-20 gårdssalg-kvalitetsgate-redesign, criterion 1:
  // structure-aware prose extraction (PURE).
  extractProseText,
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

  // ── dev-request 2026-07-20-gardssalg-kvalitetsgate-redesign, criterion 1 ──
  // extractProseText(): structure-aware fallback used by summarizeAbout()/
  // summarizeVisit() only — reproduces the Draopar production bug (nav-menu
  // chrome glued to the one real prose sentence, which slipped past the old
  // "contains a prose signal word ⇒ trust the whole block" quality-gate
  // loophole because that loophole isn't touched by this slice).

  // Draopar-shaped fixture: <header><nav><ul> menu + <footer><ul> menu around
  // ONE real sentence (contains "er", the classic loophole trigger word).
  const draoparHtml =
    "<html><head><title>Draopar</title></head><body>" +
    "<header><nav><ul>" +
    "<li><a href='/'>Hjem</a></li><li><a href='/om'>Om oss</a></li>" +
    "<li><a href='/produkter'>Produkter</a></li><li><a href='/kontakt'>Kontakt</a></li>" +
    "<li><a href='/nyheter'>Nyheter</a></li>" +
    "</ul></nav></header>" +
    "<main><p>Draopar er en liten gård som selger friske grønnsaker rett fra jordet.</p></main>" +
    "<footer><ul>" +
    "<li><a href='/personvern'>Personvern</a></li><li><a href='/vilkar'>Vilkår</a></li>" +
    "<li><a href='/facebook'>Facebook</a></li>" +
    "</ul><p>&copy; 2026 Draopar Gård</p></footer>" +
    "</body></html>";
  {
    const prose = extractProseText(draoparHtml);
    assertTrue(prose.includes("Draopar er en liten gård"), "extractProseText/Draopar: keeps the real sentence");
    for (const junk of ["Hjem", "Om oss", "Produkter", "Nyheter", "Personvern", "Vilkår", "Facebook"]) {
      assertTrue(!prose.includes(junk), `extractProseText/Draopar: excludes nav/footer menu item '${junk}'`);
    }
    // Contrast: the pre-existing extractVisibleText (unchanged, still used
    // elsewhere) does NOT filter nav/footer chrome — proves the fixture
    // actually reproduces the bug rather than being vacuously nav-free.
    const blind = extractVisibleText(draoparHtml);
    assertTrue(blind.includes("Hjem") && blind.includes("Personvern"), "extractProseText/Draopar: extractVisibleText (unchanged) still leaks the nav/footer junk on the same input");
  }

  // Nested chrome: <nav> wrapped inside <header><div>...</div></header> — the
  // depth-aware remover must track the SHARED nav/header/footer/aside family
  // across nesting, not just a single non-greedy tag pair.
  {
    const nested =
      "<body><header><div><nav><ul><li><a href='/'>Hjem</a></li>" +
      "<li><a href='/butikk'>Butikk</a></li></ul></nav></div></header>" +
      "<p>Gården vår er kjent for økologisk frukt og bær.</p></body>";
    const prose = extractProseText(nested);
    assertTrue(!prose.includes("Hjem") && !prose.includes("Butikk"), "extractProseText: nested <header><div><nav> chrome excluded");
    assertTrue(prose.includes("økologisk frukt"), "extractProseText: real sentence after nested chrome survives");
  }

  // Bare high-link-density <ul> menu with NO <nav>/<header> wrapper at all —
  // the classic "nav-menu-disguised-as-a-list" pattern (link-density signal).
  {
    const bareMenu =
      "<body><ul><li><a href='/'>Hjem</a></li><li><a href='/butikk'>Butikk</a></li>" +
      "<li><a href='/om'>Om</a></li><li><a href='/kontakt'>Kontakt</a></li></ul>" +
      "<p>Vi er en liten gård som selger egne grønnsaker og bær.</p></body>";
    const prose = extractProseText(bareMenu);
    assertTrue(!prose.includes("Hjem") && !prose.includes("Butikk"), "extractProseText: bare high-link-density <ul> menu (no nav/header wrapper) excluded");
    assertTrue(prose.includes("grønnsaker"), "extractProseText: real sentence after bare menu <ul> survives");
  }

  // Normal, non-nav-polluted fixture: prose still comes through unchanged.
  {
    const html = "<body><header><nav>Meny</nav></header><p>Vi er et lite familiebakeri som baker surdeigsbrød hver morgen.</p></body>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("familiebakeri"), "extractProseText: normal page — real prose still extracted");
    assertTrue(!prose.includes("Meny"), "extractProseText: normal page — <nav> text still excluded");
  }
  // A real product <ul> (low link density — mostly plain text, no <a> tags)
  // must NOT be treated as a nav menu and dropped.
  {
    const html = "<body><p>Vi selger følgende produkter:</p><ul><li>Poteter fra egen åker</li><li>Gulrøtter, høstet i går</li><li>Rødbeter i sesong</li></ul></body>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("Poteter fra egen åker"), "extractProseText: genuine low-link-density product <ul> is kept, not treated as a nav menu");
  }

  // ── review finding 1 — false-positive on a realistic "shop our products"
  // <ul> where EACH <li> wraps its full descriptive sentence in a single <a>
  // linking to a detail page: 3 anchors + ~100% of the block's text inside
  // them trips the old anchors>=3 + ratio>=0.6 nav-menu thresholds, but the
  // anchor text is full sentences, not short nav labels — must survive.
  {
    const html =
      "<ul><li><a href='/potet'>Poteter fra egen åker, høstet i går</a></li>" +
      "<li><a href='/gulrot'>gulrøtter i sesong fra hagen</a></li>" +
      "<li><a href='/rodbet'>Rødbeter dyrket økologisk her hjemme</a></li></ul>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("Poteter fra egen åker"), "extractProseText: product-<ul> with per-item detail-page <a> sentences survives (finding 1)");
    assertTrue(prose.includes("gulrøtter i sesong"), "extractProseText: product-<ul> second item survives (finding 1)");
    assertTrue(prose.includes("Rødbeter dyrket økologisk"), "extractProseText: product-<ul> third item survives (finding 1)");
  }
  // Contrast: genuine short-label nav <ul>s (the shape isHighLinkDensityBlock
  // exists to catch) must still be excluded after the finding-1 fix.
  {
    const html =
      "<p>Vi er en liten gård.</p>" +
      "<ul><li><a href='/'>Hjem</a></li><li><a href='/om'>Om oss</a></li>" +
      "<li><a href='/kontakt'>Kontakt oss</a></li><li><a href='/tider'>Åpningstider</a></li></ul>";
    const prose = extractProseText(html);
    for (const junk of ["Hjem", "Om oss", "Kontakt oss", "Åpningstider"]) {
      assertTrue(!prose.includes(junk), `extractProseText: short-label nav <ul> item '${junk}' still excluded after finding-1 fix`);
    }
    assertTrue(prose.includes("liten gård"), "extractProseText: real sentence around short-label nav <ul> still survives");
  }

  // ── review round 2 — an average-based nav-label-length gate is trivially
  // defeated by a realistic per-row shape: a long descriptive title-link
  // PLUS a separate short call-to-action link ("Kjøp"/"Se her") per <li>.
  // 2 long product-sentence anchors (49 and 51 chars) + 2 short 4/6-char CTA
  // anchors average (49+51+4+6)/4 = 27.5, under a naive "<30 average" nav
  // gate, which would wrongly classify this whole block as a nav menu and
  // delete the product text. Must survive.
  {
    const html =
      "<ul>" +
      "<li><a href='/potet'>Poteter fra egen åker, høstet i går på gården vår</a> <a href='/potet'>Kjøp</a></li>" +
      "<li><a href='/rodbet'>Rødbeter dyrket økologisk i egen hage på gården vår</a> <a href='/rodbet'>Se her</a></li>" +
      "</ul>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("Poteter fra egen åker"), "extractProseText: mixed long-title + short-CTA-link product <ul> survives (finding 3, round 2)");
    assertTrue(prose.includes("Rødbeter dyrket økologisk"), "extractProseText: mixed long-title + short-CTA-link product <ul> second item survives (finding 3, round 2)");
  }

  // ── review round 3 — requiring only ONE anchor at/above LONG_ANCHOR_LEN to
  // disqualify nav classification over-corrects: a genuine nav menu with 3
  // short chrome labels ("Hjem"/"Om oss"/"Kontakt") plus a single longer
  // "view all products"-style link (~35 chars) is not a product list — it's
  // still a nav menu that happens to glue on one long link. Must be stripped;
  // requires >=2 long anchors to count as content (round 3 / round 4 fix).
  {
    const html =
      "<p>Vi er en liten gård.</p>" +
      "<ul><li><a href='/'>Hjem</a></li><li><a href='/om'>Om oss</a></li>" +
      "<li><a href='/kontakt'>Kontakt</a></li>" +
      "<li><a href='/produkter'>Se alle våre produkter og tjenester</a></li></ul>";
    const prose = extractProseText(html);
    for (const junk of ["Hjem", "Om oss", "Kontakt", "Se alle våre produkter"]) {
      assertTrue(!prose.includes(junk), `extractProseText: nav <ul> with single long "view all" link item '${junk}' still excluded (round 3/4 fix, >=2 long anchors required)`);
    }
    assertTrue(prose.includes("liten gård"), "extractProseText: real sentence around single-long-link nav <ul> still survives (round 3/4 fix)");
  }

  // ── review finding 2 — hyphenated custom elements (<header-widget>,
  // <nav-carousel>) must NOT be mistaken for <header>/<nav> and stripped; the
  // old trailing `\b` treats `-` as a non-word-boundary, so it matched into
  // the custom element name and silently dropped its real content.
  {
    const html =
      "<header-widget class='x'>Dette er faktisk ekte produktinnhold fra gården vår.</header-widget>" +
      "<p>Ekte setning nummer to om gårdens historie.</p>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("ekte produktinnhold"), "extractProseText: <header-widget> custom element content survives (finding 2)");
    assertTrue(prose.includes("Ekte setning nummer to"), "extractProseText: sibling paragraph after <header-widget> survives (finding 2)");
  }
  {
    const html =
      "<nav-carousel>Ekte innhold i en nav-carousel, ikke en faktisk meny.</nav-carousel>" +
      "<p>En annen ekte setning her.</p>";
    const prose = extractProseText(html);
    assertTrue(prose.includes("Ekte innhold i en nav-carousel"), "extractProseText: <nav-carousel> custom element content survives (finding 2)");
  }
  // A real <nav> (no hyphen) must still be excluded — the fix must not
  // over-correct and stop matching plain semantic tags.
  {
    const html = "<nav><a href='/'>Hjem</a></nav><p>Gården vår selger egg og honning.</p>";
    const prose = extractProseText(html);
    assertTrue(!prose.includes("Hjem"), "extractProseText: plain <nav> (no hyphen) still excluded after finding-2 fix");
    assertTrue(prose.includes("egg og honning"), "extractProseText: prose after plain <nav> still survives after finding-2 fix");
  }

  // ── review finding 3 — perf safety cap: a pathological block with many
  // thousands of unclosed <a> tags inside a <ul> must not blow up processing
  // time (the anchor-counting regex's backtracking search for `</a>` is
  // quadratic in unclosed-anchor count without a size cap). Not a timing
  // assertion (this suite doesn't do those) — just confirms the capped input
  // is handled at all and real content around it still survives.
  {
    const manyUnclosedAnchors = "<ul>" + "<a href='/x'>x".repeat(20_000) + "</ul>";
    const html = `<p>Ekte innledende setning.</p>${manyUnclosedAnchors}<p>Ekte avsluttende setning.</p>`;
    const prose = extractProseText(html);
    assertTrue(prose.includes("Ekte innledende setning"), "extractProseText: pathological unclosed-<a> block — leading prose survives (finding 3)");
    assertTrue(prose.length <= 20000, "extractProseText: pathological unclosed-<a> block — still respects the ~20k output cap (finding 3)");
  }

  // ── (low-priority) documents the intentional "unclosed <nav> swallows to
  // end of string" tradeoff called out in stripBlocksByTagNames' doc comment,
  // so it's visible/pinned rather than incidental.
  {
    const html = "<nav><a href='/'>Hjem</a><p>Ekte setning som aldri skal overleve, siden nav aldri lukkes.</p>";
    const prose = extractProseText(html);
    assertEq(prose, "", "extractProseText: unclosed <nav> conservatively swallows everything to end-of-string (documented tradeoff)");
  }

  // Empty/no-html edge case — same empty-string contract as extractVisibleText.
  assertEq(extractProseText(""), "", "extractProseText: empty in → empty out");
  assertEq(extractProseText(null as unknown as string), "", "extractProseText: null-ish in → empty out");

  // ~20k-char cap, same contract as extractVisibleText.
  {
    const big = "ord ".repeat(20000);
    assertTrue(extractProseText(`<body>${big}</body>`).length <= 20000, "extractProseText: caps at ~20k chars");
  }

  // End-to-end: summarizeAbout()/summarizeVisit() on the Draopar fixture must
  // NOT surface the nav/footer junk (this is the actual about_text/visit_text
  // write-path fix — extractProseText alone proves the extractor works, this
  // proves it's actually wired in).
  {
    const about = summarizeAbout(draoparHtml);
    assertTrue(about.includes("Draopar er en liten gård"), "summarizeAbout: Draopar fixture — real sentence surfaced");
    assertTrue(!about.includes("Hjem") && !about.includes("Personvern"), "summarizeAbout: Draopar fixture — nav/footer junk NOT in about_text (regression guard for the production bug)");
  }
  {
    const visitHtml =
      "<html><body><header><nav><ul><li><a href='/'>Hjem</a></li><li><a href='/om'>Om</a></li>" +
      "<li><a href='/kontakt'>Kontakt</a></li></ul></nav></header>" +
      "<main><p>Velkommen til omvisning og smaking på gården vår hver lørdag.</p></main>" +
      "<footer><ul><li><a href='/vilkar'>Vilkår</a></li><li><a href='/personvern'>Personvern</a></li>" +
      "<li><a href='/fb'>Facebook</a></li></ul></footer></body></html>";
    const visit = summarizeVisit(visitHtml);
    assertTrue(visit.includes("omvisning"), "summarizeVisit: Draopar-shaped fixture — real visit sentence surfaced");
    assertTrue(!visit.includes("Hjem") && !visit.includes("Vilkår"), "summarizeVisit: Draopar-shaped fixture — nav/footer junk NOT in visit_text");
  }
  assertEq(summarizeVisit(""), "", "summarizeVisit: empty → empty");

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
