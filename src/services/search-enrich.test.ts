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
