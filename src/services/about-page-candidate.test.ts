/**
 * about-page-candidate.test.ts — pure unit tests for dev-request
 * 2026-10-27-rfb-berikelse-om-oss-sider-til-beskrivelse (RFB + gårdssalg):
 * the ENRICHMENT_ABOUT_PAGE_ENABLED switch, the about-page prose extractor
 * (search-enrich.ts summarizeAboutPageProse / extractProseParagraphs) and the
 * candidate choice (pickAboutPageCandidate and its helpers). No network, no
 * DB. The route wiring is covered in
 * src/routes/homepage-content-refresh-about-page.test.ts (RFB) and
 * src/routes/opplevelser-gardssalg-about-page-candidate.test.ts (gårdssalg);
 * the sub-page slot in src/services/fetch-page.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/about-page-candidate.test.ts
 *   2. Wired into the gate: tests/test.ts imports runAboutPageCandidateTests().
 */

import {
  ENRICHMENT_ABOUT_PAGE_FLAG,
  isEnrichmentAboutPageEnabled,
  resolveAboutPageMode,
  aboutPagePreviewRequested,
  isAboutFallbackPath,
  aboutPageCandidateIsMoreSubstantial,
  pickAboutPageCandidate,
  urlIsInSection,
  homepageSectionBase,
  aboutPageTextIncluded,
  producerNameTokens,
  aboutPageNamesProducer,
  ABOUT_PAGE_NOT_ABOUT_PRODUCER,
} from "./about-page-candidate";
import {
  summarizeAboutPageProse,
  extractProseParagraphs,
  extractProseText,
  summarizeAbout,
  meetsAboutQualityBar,
  extractVisibleText,
} from "./search-enrich";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Shared fixtures (also the shape the route tests use) ────────────────────
const LONG_PROSE_1 =
  "Tverås er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.";
const LONG_PROSE_2 =
  "Kjøttet foredler vi selv i vårt eget slakteri og pølsemakeri på gården, og vi selger spekemat, pølser og ferskt lammekjøtt direkte til kundene våre.";
const LONG_PROSE_3 =
  "Du finner oss på REKO-ringen i Gol og på bondens marked i Oslo, og vi tar gjerne imot bestillinger til selskap og høytider.";

function aboutPageHtml(paragraphs: string[]): string {
  return `<html><head><title>Om oss – Tverås Gårdsmat</title></head><body>
<header><nav><a href="/">Hjem</a><a href="/om-oss">Om oss</a><a href="/kontakt">Kontakt</a></nav></header>
<main><h1>Om oss</h1>${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}</main>
<footer><p>Tverås Gårdsmat, 3550 Gol. Telefon 900 00 000. Alle rettigheter reservert hos oss på gården.</p></footer>
</body></html>`;
}

const HOME_SHORT_META = "Tverås Gårdsmat – lokal mat fra gården i Hallingdal.";

export function runAboutPageCandidateTests(opts: { log?: boolean } = {}): TestSummary {
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

  const prevFlag = process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
  try {
    // ── 1. The switch: OFF by default, only "1"/"true", read at call time ──
    delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
    assertEq(ENRICHMENT_ABOUT_PAGE_FLAG, "ENRICHMENT_ABOUT_PAGE_ENABLED", "flag-0: the env flag's name");
    assertEq(isEnrichmentAboutPageEnabled(), false, "flag-1: unset -> OFF (default)");
    for (const v of ["0", "false", "TRUE", "yes", "on", " 1", ""]) {
      process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = v;
      assertEq(isEnrichmentAboutPageEnabled(), false, `flag-2: ${JSON.stringify(v)} -> OFF`);
    }
    for (const v of ["1", "true"]) {
      process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = v;
      assertEq(isEnrichmentAboutPageEnabled(), true, `flag-3: ${JSON.stringify(v)} -> ON`);
    }

    // ── 2. Mode: env flag anywhere; preview ONLY in a dry run ──────────────
    delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
    assertEq(resolveAboutPageMode({ dryRun: true, previewRequested: false }), null, "mode-1: flag off, dry run, no preview -> off");
    assertEq(resolveAboutPageMode({ dryRun: true, previewRequested: true }), "dry_run_preview", "mode-2: flag off, dry run + preview -> dry_run_preview");
    assertEq(resolveAboutPageMode({ dryRun: false, previewRequested: true }), null, "mode-3: flag off, APPLY + preview -> off (a preview never writes)");
    assertEq(resolveAboutPageMode({ dryRun: false, previewRequested: false }), null, "mode-4: flag off, apply -> off");
    process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = "true";
    assertEq(resolveAboutPageMode({ dryRun: false, previewRequested: false }), "env_flag", "mode-5: flag on, apply -> env_flag");
    assertEq(resolveAboutPageMode({ dryRun: true, previewRequested: true }), "env_flag", "mode-6: flag on wins over preview");
    delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
    for (const v of [true, 1, "1", "true"]) assertEq(aboutPagePreviewRequested(v), true, `preview-1: ${JSON.stringify(v)} requests a preview`);
    for (const v of [false, 0, "0", "false", "yes", undefined, null, {}]) {
      assertEq(aboutPagePreviewRequested(v), false, `preview-2: ${JSON.stringify(v)} does not`);
    }

    // ── 3. Fallback about paths ─────────────────────────────────────────
    for (const p of ["/om-oss", "/om", "/about", "/om-garden", "/historie", "/omoss/"]) {
      assertTrue(isAboutFallbackPath(p), `path-1: ${p} is an about path`);
    }
    for (const p of ["/kontakt", "/produkter", "/besok", "/omvisning", "/ol", "/smak", "/om-oss/kontakt"]) {
      assertTrue(!isAboutFallbackPath(p), `path-2: ${p} is not an about path`);
    }

    // ── 4. extractProseText unchanged; extractProseParagraphs splits it ─────
    {
      const html =
        "<html><body><nav><a href='/'>Hjem</a></nav><h1>Om oss</h1><p>Første <strong>avsnitt</strong> her.</p>" +
        "<div>Andre &amp; siste.</div><footer>Bunntekst</footer><script>var x=1</script></body></html>";
      assertEq(extractProseText(html), "Om oss Første avsnitt her. Andre & siste.", "prose-1: extractProseText output is what it always was");
      assertEq(extractProseParagraphs(html), ["Om oss", "Første avsnitt her.", "Andre & siste."], "prose-2: paragraphs in page order, nav/footer/script removed, inline tags flattened");
      assertEq(extractProseParagraphs(""), [], "prose-3: empty HTML -> no paragraphs");
    }

    // ── 5. summarizeAboutPageProse ─────────────────────────────────────────
    {
      const four = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2, LONG_PROSE_3, "Et fjerde avsnitt som ikke skal være med fordi vi tar høyst tre avsnitt."]);
      const s = summarizeAboutPageProse(four);
      assertEq(s, `${LONG_PROSE_1} ${LONG_PROSE_2} ${LONG_PROSE_3}`, "sum-1: the first three substantial paragraphs, joined, heading/nav/footer excluded");
      assertTrue(s.length <= 500, "sum-2: within the 500-char cap");
      const withMeta = four.replace("<head>", `<head><meta property="og:description" content="${HOME_SHORT_META}">`);
      assertEq(summarizeAboutPageProse(withMeta), s, "sum-3: og/meta description ignored (site-wide text is not the about page's own prose)");
      const cookie = aboutPageHtml([
        "Vi bruker informasjonskapsler (cookies) for å gi deg en bedre opplevelse på nettsiden vår, les mer i personvernerklæringen.",
        LONG_PROSE_1,
      ]);
      assertEq(summarizeAboutPageProse(cookie), LONG_PROSE_1, "sum-4: a cookie/consent paragraph is skipped");
      const dup = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_1, LONG_PROSE_2]);
      assertEq(summarizeAboutPageProse(dup), `${LONG_PROSE_1} ${LONG_PROSE_2}`, "sum-5: an exact repeat is skipped");
      assertEq(summarizeAboutPageProse(aboutPageHtml(["Kort.", "Ingen setning her bare ord og ord og ord og ord og ord og ord og ord"])), "", "sum-6: no qualifying paragraph -> \"\"");
      const longPara = Array.from({ length: 12 }, (_, i) => `Setning nummer ${i + 1} forteller litt om gården og dyrene våre i fjellet.`).join(" ");
      const capped = summarizeAboutPageProse(aboutPageHtml([longPara]));
      assertTrue(capped.length <= 500 && capped.length >= 200, `sum-7: a long paragraph is cut to <= 500 chars (got ${capped.length})`);
      assertTrue(capped.endsWith("."), "sum-8: … at a sentence end");
      assertTrue(longPara.startsWith(capped), "sum-9: … and is a verbatim prefix of the page text");
      assertEq(summarizeAboutPageProse(""), "", "sum-10: empty HTML -> \"\"");
    }

    // ── 6. More substantial ───────────────────────────────────────────────
    {
      const about = `${LONG_PROSE_1} ${LONG_PROSE_2}`;
      assertTrue(aboutPageCandidateIsMoreSubstantial(about, HOME_SHORT_META, "Tverås Gårdsmat"), "subst-1: long prose vs a short meta -> more substantial");
      assertTrue(aboutPageCandidateIsMoreSubstantial(about, "", "Tverås Gårdsmat"), "subst-2: vs no homepage candidate -> more substantial");
      assertTrue(!aboutPageCandidateIsMoreSubstantial(about, about.slice(0, about.length - 30), "Tverås Gårdsmat"), "subst-3: only 30 chars longer -> NOT clearly more substantial");
      const nameAndPlace = "Tverås Gårdsmat Tverås Gårdsmat Tverås Gårdsmat i Gol, Hallingdal, Buskerud, Norge. Tverås Gårdsmat i Gol, Hallingdal.";
      assertTrue(!aboutPageCandidateIsMoreSubstantial(nameAndPlace, "", "Tverås Gårdsmat"), "subst-4: just name + place -> NOT more substantial");
    }

    // ── 7. pickAboutPageCandidate ────────────────────────────────────────
    const url = "https://tveras.no/om-oss";
    {
      const html = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2]);
      const pick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html }], producerName: "Tverås Gårdsmat" });
      assertEq(pick.chosen, { url, text: `${LONG_PROSE_1} ${LONG_PROSE_2}` }, "pick-1: short homepage meta + long about prose -> the about page, with its URL");
      assertEq(pick.evaluated.map((e) => e.verdict), ["chosen"], "pick-2: verdict chosen");
      assertTrue(meetsAboutQualityBar(pick.chosen!.text), "pick-3: the chosen text clears meetsAboutQualityBar");
    }
    {
      // Code artifact: the live Helios Trondheim Squarespace bootstrap text
      // (description-quality.ts's own fixture) rendered as a paragraph. It
      // clears meetsAboutQualityBar and is verbatim on the page, so only the
      // code-artifact guard stops it.
      const helios =
        'Grønn Guide Trondheim Static = window.Static || {}; Static.SQUARESPACE_CONTEXT = {"betaFeatureFlags":["supports_versioned_template_assets",' +
        '"campaigns_merch_state","marketing_landing_page","enable_form_submission_trigger","campaigns_table_v2","contacts_and_campaigns_redesign",' +
        '"marketing_automations"]}; Vi er en gård i Trondheim.';
      const html = `<html><body><main><p>${helios}</p></main></body></html>`;
      const pick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html }], producerName: "Tverås Gårdsmat" });
      assertEq(pick.chosen, null, "pick-4: an about page whose prose is a code artifact -> homepage candidate kept");
      assertEq(pick.evaluated[0]!.verdict, "code_artifact", "pick-5: verdict code_artifact");
    }
    {
      // Theme spam (hijacked domain): the page itself reads as gambling copy.
      const spam =
        "<html><head><title>Beste casino på nett i 2026</title></head><body><main><p>Spill på nettcasino med gratisspinn og velkomstbonus hos de beste norske casinoene. Vi har testet alle casino uten innskudd.</p><p>" +
        LONG_PROSE_1 + "</p></main></body></html>";
      const pick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: spam }], producerName: "Tverås Gårdsmat" });
      assertEq(pick.chosen, null, "pick-6: a theme-spam about page -> homepage candidate kept");
      assertEq(pick.evaluated[0]!.verdict, "theme_spam_page", "pick-7: verdict theme_spam_page");
    }
    {
      // Another business: an umbrella/directory page describing its members.
      const umbrella = aboutPageHtml([
        "Hallingdal Matforum er et samarbeid mellom lokale produsenter i regionen. Våre medlemmer leverer kjøtt, ost og grønnsaker til butikker og restauranter.",
        "Vi arrangerer markeder og kurs for medlemmene våre gjennom hele året, og hjelper nye produsenter i gang med salg.",
      ]);
      const pick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: umbrella }], producerName: "Tverås Gårdsmat" });
      assertEq(pick.chosen, null, "pick-8: an about page describing another business (umbrella «våre medlemmer») -> homepage candidate kept");
      assertEq(pick.evaluated[0]!.verdict, "below_quality_bar", "pick-9: rejected by meetsAboutQualityBar's wrong-entity markers");
    }
    {
      // Not more substantial than the homepage candidate.
      const home = `${LONG_PROSE_1} ${LONG_PROSE_2}`.slice(0, 280);
      const html = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2]);
      const pick = pickAboutPageCandidate({ homepageCandidate: home, aboutPages: [{ url, html }], producerName: "Tverås Gårdsmat" });
      assertEq(pick.chosen, null, "pick-10: about text barely longer than a good homepage candidate -> homepage kept");
      assertEq(pick.evaluated[0]!.verdict, "not_more_substantial", "pick-11: verdict not_more_substantial");
    }
    {
      // Caller's refusal / spam homepage: nothing considered.
      const html = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2]);
      const refused = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html }], refusal: "directory/social host" });
      assertEq(refused.chosen, null, "pick-12: a caller refusal -> no about page considered");
      assertEq(refused.refused, "directory/social host", "pick-13: … and the refusal is reported");
      assertEq(refused.evaluated.map((e) => e.verdict), ["not_evaluated"], "pick-14: … each page reported not_evaluated");
      const spamHome = pickAboutPageCandidate({
        homepageCandidate: "Beste casino på nett 2026 — gratisspinn, velkomstbonus og casino uten innskudd hos oss.",
        aboutPages: [{ url, html }],
      });
      assertEq(spamHome.chosen, null, "pick-15: a homepage candidate that reads as theme spam -> no about page considered");
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [] }), { chosen: null, evaluated: [] }, "pick-16: no about page -> nothing chosen");
    }
    {
      // First passing page wins; later pages are not evaluated.
      const bad = aboutPageHtml(["Kort."]);
      const good = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2]);
      const pick = pickAboutPageCandidate({
        homepageCandidate: HOME_SHORT_META,
        aboutPages: [
          { url: "https://tveras.no/historie", html: bad },
          { url, html: good },
          { url: "https://tveras.no/om-garden", html: good },
        ],
        producerName: "Tverås Gårdsmat",
      });
      assertEq(pick.chosen?.url, url, "pick-17: the first page that passes every guard is chosen");
      assertEq(pick.evaluated.map((e) => e.verdict), ["no_prose", "chosen", "not_evaluated"], "pick-18: verdict per page, in order");
    }
    {
      // The homepage candidate itself, from a short-meta homepage, does not clear the bar (the AC1 fixture shape).
      const home = `<html><head><meta name="description" content="${HOME_SHORT_META}"></head><body><p>Velkommen!</p></body></html>`;
      assertEq(summarizeAbout(home), HOME_SHORT_META, "pick-19: fixture homepage candidate is its short meta");
      assertTrue(!meetsAboutQualityBar(HOME_SHORT_META), "pick-20: … which is below the quality bar on its own");
    }

    // ── 7b. Is the page about THIS producer? ───────────────────────────────
    {
      assertEq(producerNameTokens("Tverås Gårdsmat"), ["tveras"], "name-1: generic words dropped, accents folded");
      assertEq(producerNameTokens("Tverås Gårdsmat — Gol"), ["tveras"], "name-2: the place suffix after « — » is dropped");
      assertEq(producerNameTokens("Hjortehagen Gård AS (Stokke)"), ["hjortehagen"], "name-3: AS and a parenthesised place dropped");
      assertEq(producerNameTokens("Gården AS"), [], "name-4: only generic words -> no distinctive token");
      assertEq(producerNameTokens("Voss Fellesbryggeri"), ["voss", "fellesbryggeri"], "name-5: every distinctive word kept");
      assertEq(producerNameTokens(null), [], "name-6: no name -> none");
      const village = aboutPageHtml([
        "Gol er en bygd i Hallingdal med lange tradisjoner for jordbruk og husdyrhold. Stavkirken herfra står i dag på Bygdøy i Oslo.",
        "Bygda vokste fram rundt jernbanen på begynnelsen av nittenhundretallet, og mange gamle gardsbygninger står fortsatt på hver side av elva.",
      ]).replace("<title>Om oss – Tverås Gårdsmat</title>", "<title>Historie</title>").replace("<h1>Om oss</h1>", "<h1>Historien om Gol</h1>");
      const vPick = pickAboutPageCandidate({
        homepageCandidate: HOME_SHORT_META,
        aboutPages: [{ url: "https://tveras.no/historie", html: village }],
        producerName: "Tverås Gårdsmat",
      });
      assertEq(vPick.chosen, null, "name-7: a «Historie» page about the village -> homepage candidate kept");
      assertEq(vPick.evaluated[0]?.verdict, "not_about_producer", "name-8: verdict not_about_producer");
      assertEq(vPick.refused, ABOUT_PAGE_NOT_ABOUT_PRODUCER, "name-9: reported as about_page_not_about_producer");
      // Named only in <h1>/<title>, not in the prose ("Vi …"): still about the producer.
      const weOnly = aboutPageHtml([
        "Vi er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.",
        LONG_PROSE_2,
      ]);
      const hPick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: weOnly }], producerName: "Tverås Gårdsmat" });
      assertEq(hPick.chosen?.url, url, "name-10: the producer named in the page title -> about candidate");
      assertTrue(aboutPageNamesProducer("", "<html><body><h1>Om Tveråsgarden</h1></body></html>", ["tveras"]), "name-11: a compound in <h1> counts");
      assertTrue(!aboutPageNamesProducer("Gol og Hallingdal", "<html><body><h1>Om bygda</h1></body></html>", ["tveras"]), "name-12: absent -> false");
      assertTrue(!aboutPageNamesProducer("btveras", "<html></html>", ["tveras"]), "name-13: must start a word");
      const noToken = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: weOnly }], producerName: "Gården AS" });
      assertEq(noToken.chosen, null, "name-14: a name with no distinctive word cannot be checked -> fail closed");
      assertTrue(String(noToken.refused).startsWith(ABOUT_PAGE_NOT_ABOUT_PRODUCER), "name-15: … refused as about_page_not_about_producer");
      assertEq(noToken.evaluated.map((e) => e.verdict), ["not_evaluated"], "name-16: … nothing evaluated");
    }

    // ── 8. Section scope ───────────────────────────────────────────────────
    assertEq(homepageSectionBase("https://gard.no/"), "https://gard.no", "sect-1: root homepage -> host root");
    assertEq(homepageSectionBase("https://hanen.no/medlem/gard-x"), "https://hanen.no/medlem/gard-x", "sect-2: extensionless last segment is its own section");
    assertEq(homepageSectionBase("https://x.no/a/index.html"), "https://x.no/a", "sect-3: an explicit file falls back to its directory");
    assertEq(homepageSectionBase("not a url"), null, "sect-4: unparseable -> null");
    assertTrue(urlIsInSection("https://gard.no/om-oss", "https://gard.no"), "sect-5: same host, root section");
    assertTrue(!urlIsInSection("https://www.gard.no/om-oss", "https://gard.no"), "sect-6: another host is outside");
    assertTrue(urlIsInSection("https://hanen.no/medlem/gard-x/om-oss", "https://hanen.no/medlem/gard-x"), "sect-7: inside a deep section");
    assertTrue(!urlIsInSection("https://hanen.no/om-oss", "https://hanen.no/medlem/gard-x"), "sect-8: the host's root «Om oss» is outside a deep section (hanen.no)");
    assertTrue(!urlIsInSection("https://hanen.no/medlem/gard-xyz/om", "https://hanen.no/medlem/gard-x"), "sect-9: a sibling section with a shared prefix is outside");

    // ── 9. Did the about page reach contentText? ─────────────────────────────
    {
      const html = aboutPageHtml([LONG_PROSE_1, LONG_PROSE_2]);
      const home = "<html><body><nav><a href='/'>Hjem</a><a href='/om-oss'>Om oss</a></nav><p>Velkommen til gården.</p></body></html>";
      assertTrue(aboutPageTextIncluded(html, extractVisibleText(`${home}\n${html}`)), "incl-1: about prose present in the combined text");
      assertTrue(!aboutPageTextIncluded(html, extractVisibleText(home)), "incl-2: only the shared nav present -> false");
      assertTrue(!aboutPageTextIncluded("", "x"), "incl-3: empty page -> false");
    }
  } catch (err: unknown) {
    failed++;
    failures.push("about-page-candidate: unexpected error: " + String((err as Error)?.stack || (err as Error)?.message || err));
  } finally {
    if (prevFlag === undefined) delete process.env[ENRICHMENT_ABOUT_PAGE_FLAG];
    else process.env[ENRICHMENT_ABOUT_PAGE_FLAG] = prevFlag;
  }
  return { passed, failed, failures };
}

if (require.main === module) {
  const r = runAboutPageCandidateTests({ log: true });
  console.log(`\nabout-page-candidate: ${r.passed} passed, ${r.failed} failed`);
  if (r.failed > 0) {
    console.log(r.failures.join("\n"));
    process.exit(1);
  }
}
