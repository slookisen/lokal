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
  aboutPageContentWindow,
  aboutPageWindows,
  aboutPageTextLooksLikeScript,
  ABOUT_PAGE_SCAN_CAP,
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
      assertEq(producerNameTokens("Tverås Gårdsmat"), ["tverås"], "name-1: generic words dropped, the word kept as written (lower-case)");
      assertEq(producerNameTokens("Tverås Gårdsmat — Gol"), ["tverås"], "name-2: the place suffix after « — » is dropped");
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
      assertTrue(aboutPageNamesProducer("", "<html><body><h1>Om Tveråsgarden</h1></body></html>", ["tverås"]), "name-11: a compound in <h1> counts");
      assertTrue(!aboutPageNamesProducer("Gol og Hallingdal", "<html><body><h1>Om bygda</h1></body></html>", ["tverås"]), "name-12: absent -> false");
      assertTrue(!aboutPageNamesProducer("btveras", "<html></html>", ["tverås"]), "name-13: must start a word");
      const noToken = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: weOnly }], producerName: "Gården AS" });
      assertEq(noToken.chosen, null, "name-14: a name with no distinctive word cannot be checked -> fail closed");
      assertTrue(String(noToken.refused).startsWith(ABOUT_PAGE_NOT_ABOUT_PRODUCER), "name-15: … refused as about_page_not_about_producer");
      assertEq(noToken.evaluated.map((e) => e.verdict), ["not_evaluated"], "name-16: … nothing evaluated");
    }

    // ── 7c. Round-2 review: short words, fallback, 2 letters, genitive ─────
    {
      const names = (name: string, text: string, html = "<html></html>") => aboutPageNamesProducer(text, html, producerNameTokens(name));
      // Finding 2: a word shorter than 5 letters must be a whole word.
      assertTrue(!names("Nes Gård", "Vi sees neste uke på markedet, og nesten alle varene er klare."), "short-1: «Nes» does not match «neste»/«nesten»");
      assertTrue(names("Nes Gård", "Nes gård ligger ved fjorden og har sau og geit."), "short-2: «Nes gård ligger …» matches");
      assertTrue(names("Nes Gård", "Velkommen til Nes' egen gårdsbutikk og til Ness gamle låve."), "short-3: whole word with a genitive «s»");
      assertTrue(!names("Vik Gård", "Det er viktig for oss å drive økologisk."), "short-4: «Vik» does not match «viktig»");
      assertTrue(!names("Hov Gård", "Vi driver hovedsakelig med sau."), "short-5: «Hov» does not match «hovedsakelig»");
      assertTrue(names("Tverås Gårdsmat", "Om Tveråsgarden og folka her."), "short-6: 5+ letters still match the start of a compound");
      // Finding 3: fallback to the whole name when the head has no distinctive word.
      assertEq(producerNameTokens("Gården AS — Hovland"), ["hovland"], "fallback-1: nothing before « — » -> the whole name's words");
      assertEq(producerNameTokens("Gårdsbutikken (Hovland)"), ["hovland"], "fallback-2: … also for a bracketed suffix");
      assertEq(producerNameTokens("Gården AS"), [], "fallback-3: still none when the whole name is generic");
      // Finding 3: 2-letter words, whole-word only.
      assertEq(producerNameTokens("Ås Gård"), ["ås"], "two-1: «Ås» is a word (only the company form «AS» is generic)");
      assertEq(producerNameTokens("Bø Gardsbutikk"), ["bø"], "two-2: «Bø»");
      assertEq(producerNameTokens("Li Gård — Vinje"), ["li"], "two-3: «Li» (place suffix still dropped)");
      assertTrue(names("Ås Gård", "Ås gård ligger like ved Ås sentrum."), "two-4: «Ås» matches «Ås gård»");
      assertTrue(!names("Ås Gård", "Fellessiden AS er en portal for matprodusenter."), "two-5: «Ås» does not match the company form «AS»");
      assertTrue(names("Bø Gardsbutikk", "Butikken vår i Bø er åpen for alle."), "two-6: «Bø» matches as a whole word");
      assertTrue(names("Li Gård — Vinje", "Li gård ligger i Vinje i Telemark."), "two-7: «Li» matches «Li gård»");
      assertTrue(!names("Li Gård — Vinje", "Gården ligger fint til i lia over vatnet, og vi liker det."), "two-8: … but not «ligger»/«lia»/«liker»");
      // Finding 3: genitive «s».
      assertTrue(names("Hovlands Gårdsbutikk", "Hovland gård har drevet med frukt i fire generasjoner."), "gen-1: «Hovlands» matches «Hovland gård»");
      assertTrue(!names("Grans Gård", "Skogen her er full av gran og furu."), "gen-2: a short word is not stripped («Grans» never becomes «gran»)");
      // The village page for «Nes Gård» (finding 2's repro) is refused.
      const nesVillage = aboutPageHtml([
        "Bygda har lange tradisjoner for jordbruk, og neste uke er det marked på torget. Nesten alle gårdene i dalen er med.",
        "Kirken ble bygd på slutten av attenhundretallet og er fortsatt i bruk, og bygdetunet er åpent for besøkende hele sommeren.",
      ]).replace("<title>Om oss – Tverås Gårdsmat</title>", "<title>Historie</title>").replace("<h1>Om oss</h1>", "<h1>Historien</h1>");
      const nesPick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url: "https://nes.no/historie", html: nesVillage }], producerName: "Nes Gård" });
      assertEq([nesPick.chosen, nesPick.evaluated[0]?.verdict, nesPick.refused], [null, "not_about_producer", ABOUT_PAGE_NOT_ABOUT_PRODUCER], "short-7: «Nes Gård» vs a page saying «neste uke» -> refused");
      const nesOwn = aboutPageHtml([
        "Nes gård ligger ved fjorden og har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite om sommeren.",
        LONG_PROSE_2,
      ]).replace("<title>Om oss – Tverås Gårdsmat</title>", "<title>Om oss</title>");
      const nesOk = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url: "https://nes.no/om-oss", html: nesOwn }], producerName: "Nes Gård" });
      assertEq(nesOk.evaluated[0]?.verdict, "chosen", "short-8: «Nes gård ligger …» -> accepted");
    }

    // ── 7d. Round-2 review finding 1: bounded scans on a pathological page ─
    {
      pickAboutPageCandidate({ homepageCandidate: "kort", aboutPages: [{ url, html: "<p>x</p>" }], producerName: "Tverås" }); // warm-up
      const prose = `<p>${LONG_PROSE_1}</p><p>${LONG_PROSE_2}</p>`;
      const time = (html: string): number => {
        const t0 = performance.now();
        pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html }], producerName: "Tverås Gårdsmat" });
        aboutPageTextIncluded(html, "x");
        return performance.now() - t0;
      };
      const titles = `<html><body>${prose}${"<title>x ".repeat(50_000)}</body></html>`;
      const h1s = `<html><body>${prose}${"<h1>x ".repeat(50_000)}</body></html>`;
      const metas = `<html><head>${"<meta content='x' ".repeat(50_000)}</head><body>${prose}</body></html>`;
      assertTrue(titles.length > 450_000, "patho-0: the unclosed-<title> page is ~450 kB");
      const tTitle = time(titles);
      assertTrue(tTitle < 200, `patho-1: 50k unclosed <title> (450 kB) evaluated in < 200 ms (got ${tTitle.toFixed(0)} ms; was ~39 s)`);
      const tH1 = time(h1s);
      assertTrue(tH1 < 200, `patho-2: 50k unclosed <h1> evaluated in < 200 ms (got ${tH1.toFixed(0)} ms; was ~5 s)`);
      const tMeta = time(metas);
      assertTrue(tMeta < 2000, `patho-3: 50k unclosed <meta> (900 kB) evaluated in < 2 s (got ${tMeta.toFixed(0)} ms; was ~47 s)`);
      // Bounded, but the guards still work on a normal page.
      const spam =
        "<html><head><title>Beste casino på nett i 2026</title></head><body><main><p>" + LONG_PROSE_1 + "</p><p>" + LONG_PROSE_2 + "</p></main></body></html>";
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: spam }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "theme_spam_page", "patho-4: a spam <title> is still caught");
      const ogSpam =
        `<html><head><meta property="og:description" content="Beste casino på nett 2026 — gratisspinn og velkomstbonus uten innskudd."></head><body><main><p>${LONG_PROSE_1}</p><p>${LONG_PROSE_2}</p></main></body></html>`;
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: ogSpam }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "theme_spam_page", "patho-5: a spam meta description is still caught");
      const ogTitle = `<html><head><meta property="og:title" content="Tverås Gårdsmat"><title>Om oss</title></head><body><main><p>Vi er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.</p><p>${LONG_PROSE_2}</p></main></body></html>`;
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: ogTitle }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "chosen", "patho-6: og:title still names the producer");
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
    // ── 10. The content window (AC2 preview 2026-11-01) ─────────────────────
    // Measured on 8 real «Om oss» pages: <body> started at 26–377 kB, behind
    // inline CSS and scripts, so a scan of the first ABOUT_PAGE_SCAN_CAP chars
    // of the RAW page saw only <head> (7 of 9 pages: no_prose), and a
    // <script> crossing that cut leaked into the candidate as «prose».
    {
      const url = "https://tveras.no/om-oss";
      const bigHead = (n: number): string =>
        `<head><title>Om oss – Tverås Gårdsmat</title><style>${".a{color:red}\n".repeat(Math.ceil(n / 13))}</style></head>`;
      const page = (head: string, body: string): string => `<!doctype html><html>${head}<body>${body}</body></html>`;
      const main = `<main><h1>Om oss</h1><p>${LONG_PROSE_1}</p><p>${LONG_PROSE_2}</p></main>`;

      // A real CMS shape: 60 kB of inline CSS in <head>, the prose in <main>.
      const cms = page(bigHead(60_000), `<header><nav><a href="/">Hjem</a></nav></header>${main}`);
      assertTrue(cms.indexOf("<body") > ABOUT_PAGE_SCAN_CAP, "win-0: fixture's <body> starts beyond ABOUT_PAGE_SCAN_CAP");
      const cmsPick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: cms }], producerName: "Tverås Gårdsmat" });
      assertEq(cmsPick.evaluated[0]?.verdict, "chosen", "win-1: prose behind a 60 kB <head> is read (was no_prose)");
      assertTrue((cmsPick.chosen?.text ?? "").startsWith("Tverås er en familiegård"), "win-2: the candidate is the page's own first paragraph");
      assertTrue(aboutPageTextIncluded(cms, `x ${LONG_PROSE_1} y`), "win-3: aboutPageTextIncluded reads the same window");

      // The Granum shape: a <script> that starts inside the first 25 000
      // chars and ends after them, then the prose.
      const js = "(function () { 'use strict'; var path = window.location.pathname; var seoMap = { '/': { title: 'Om oss', description: 'Håndbakte brød og kaker fra bakeriet vårt siden 1991.' } }; })();";
      const crossing = page(
        `<head><title>Om oss – Tverås Gårdsmat</title><style>${"x".repeat(22_000)}</style><script>${js}${" ".repeat(8_000)}</script></head>`,
        main,
      );
      const crossPick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: crossing }], producerName: "Tverås Gårdsmat" });
      assertEq(crossPick.evaluated[0]?.verdict, "chosen", "win-4: a <script> crossing the old cut is dropped whole; the prose after it is chosen");
      assertTrue(!/function|use strict|window\./.test(crossPick.chosen?.text ?? ""), "win-5: no script text in the candidate");

      // An unterminated <script> ends the page there: never read as text.
      const unterminated = page(bigHead(100), `<main><p>${LONG_PROSE_1}</p><script>${js} var a = 1; var b = 2;`);
      const w6 = aboutPageContentWindow(unterminated);
      assertTrue(w6.includes(LONG_PROSE_1) && !w6.includes("use strict"), "win-6: prose before an unterminated <script> kept, the script text dropped");
      // An HTML comment hiding markup is dropped whole, its <script> too.
      const commented = page(bigHead(100), `<main><!-- <script>${js}</script> <p>Gammel tekst om gården som ikke lenger stemmer, fra den gangen vi hadde kyr og melkeproduksjon.</p> --><p>${LONG_PROSE_1}</p></main>`);
      const w7 = aboutPageContentWindow(commented);
      assertTrue(!w7.includes("Gammel tekst") && !w7.includes("use strict") && w7.includes(LONG_PROSE_1), "win-7: commented-out markup inside <main> is dropped");
      // <header> is not <head>; a missing </head> ends at <body>.
      const header = `<html><body><header><p>${LONG_PROSE_3}</p></header><main><p>${LONG_PROSE_1}</p></main></body></html>`;
      assertTrue(aboutPageContentWindow(header).includes(LONG_PROSE_1), "win-8: <header> is not dropped as <head> (the window starts at <main>)");
      const noHeadClose = `<html><head><title>Om oss</title><style>.a{}</style><body><main><p>${LONG_PROSE_1}</p></main></body></html>`;
      assertTrue(aboutPageContentWindow(noHeadClose).includes(LONG_PROSE_1), "win-9: an unclosed <head> ends at <body>");
      // Start at <main> when there is one, else <body>; at most ABOUT_PAGE_SCAN_CAP chars.
      const longNav = page(bigHead(100), `<div>${"<span>meny</span>".repeat(3_000)}</div>${main}`);
      assertTrue(aboutPageContentWindow(longNav).startsWith("<main"), "win-10: the window starts at <main>");
      assertTrue(aboutPageContentWindow(page(bigHead(100), `<p>${"a".repeat(60_000)}</p>`)).length <= ABOUT_PAGE_SCAN_CAP, "win-11: the window is capped at ABOUT_PAGE_SCAN_CAP");
      assertEq(aboutPageContentWindow(""), "", "win-12: empty in, empty out");

      // A hidden login/«forgot password» popup in a <fieldset> before the
      // prose (measured on a real page) is not the about text.
      const popup = page(
        bigHead(100),
        `<main><form class="mfp-hide"><h2>Logg inn</h2><fieldset><p>Skriv inn epostadressen din (må være den som er registrert hos leverandøren), og trykk på «Send meg passord» for å bli tilsendt nytt passord på epost.</p><input type="text"></fieldset></form><h1>Om oss</h1><p>${LONG_PROSE_1}</p><p>${LONG_PROSE_2}</p></main>`,
      );
      const popupPick = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: popup }], producerName: "Tverås Gårdsmat" });
      assertTrue((popupPick.chosen?.text ?? "").startsWith("Tverås er en familiegård"), "win-13: popup text in a <fieldset> inside <main> is skipped");

      // Review round 1 (f0eed1d4): what lies before <main> still counts for
      // the page-level checks, and is read when <main> has no prose.
      const hiddenSpam = page(
        "<head><title>Om oss – Tverås Gårdsmat</title></head>",
        `<div style="display:none">Beste nettcasino 2026: free spins, casino bonus og spilleautomater med gratis spinn</div>${main}`,
      );
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: hiddenSpam }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "theme_spam_page", "win-16: spam text before <main> still makes a theme_spam_page");
      const anonProse = "Vi er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.";
      const h1InHeader = page("<head><title>Om oss</title></head>", `<header><h1>Tverås Gårdsmat</h1></header><main><p>${anonProse}</p><p>${LONG_PROSE_2}</p></main>`);
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: h1InHeader }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "chosen", "win-17: an <h1> in a <header> before <main> names the producer");
      const proseBeforeMain = page(bigHead(100), `<section><p>${LONG_PROSE_1}</p><p>${LONG_PROSE_2}</p></section><main><p>Kontakt oss.</p></main>`);
      const pbm = pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: proseBeforeMain }], producerName: "Tverås Gårdsmat" });
      assertTrue(pbm.evaluated[0]?.verdict === "chosen" && (pbm.chosen?.text ?? "").startsWith("Tverås er en familiegård"), "win-18: prose before a <main> without prose is read from <body>");
      const w19 = aboutPageWindows(page(bigHead(100), `<div><p>${LONG_PROSE_3}</p></div>${main}`));
      assertTrue(w19.body.includes(LONG_PROSE_3) && !w19.main.includes(LONG_PROSE_3) && w19.main.startsWith("<main"), "win-19: two windows — body from <body>, main from <main>");
      const w25 = aboutPageWindows(`<html><title>Sidetittel som ikke er tekst</title><body><main><p>${LONG_PROSE_1}</p></main></body></html>`);
      assertTrue(w25.body.startsWith("<body") && !w25.body.includes("Sidetittel"), "win-25: the body window starts at <body>, not at the page start");
      assertTrue(aboutPageTextIncluded(proseBeforeMain, `x ${LONG_PROSE_1} y`), "win-26: aboutPageTextIncluded falls back to <body> when <main> has no prose");

      // Shapes that must not drop the rest of the page.
      const sprite = page(bigHead(100), `<svg class="sprite"/><main><p>${LONG_PROSE_1}</p></main><svg><path d="M0"/></svg>`);
      assertTrue(aboutPageContentWindow(sprite).includes(LONG_PROSE_1), "win-20: a self-closing <svg/> is just that tag");
      const emptyComment = page(bigHead(100), `<!--><main><p>${LONG_PROSE_1}</p></main><!--->`);
      assertTrue(aboutPageContentWindow(emptyComment).includes(LONG_PROSE_1), "win-21: «<!-->» and «<!--->» are complete empty comments");
      const openFieldset = page(bigHead(100), `<main><fieldset><input type="text"><p>${LONG_PROSE_1}</p></main>`);
      assertTrue(aboutPageContentWindow(openFieldset).includes(LONG_PROSE_1), "win-22: an unclosed <fieldset> drops only its start tag");
      const endTagAttr = page(bigHead(100), `<script>${js}</script type="x"><main><p>${LONG_PROSE_1}</p></main>`);
      const w23 = aboutPageContentWindow(endTagAttr);
      assertTrue(w23.includes(LONG_PROSE_1) && !w23.includes("use strict"), "win-23: an end tag with attributes («</script x>») closes the block");
      const bodyInScript = `<html><head><title>Om oss</title><script>var tpl = '<body class="x">'; ${js}</script><body><main><p>${LONG_PROSE_1}</p></main></body></html>`;
      const w24 = aboutPageWindows(bodyInScript);
      assertTrue(!w24.body.includes("use strict") && !w24.body.includes("tpl") && w24.main.includes(LONG_PROSE_1), "win-24: an unclosed <head> with a «<body» inside a <script>: the script is dropped whole");

      // The <h1> naming the producer counts even when it sits beyond the
      // first ABOUT_PAGE_SCAN_CAP chars of the raw page.
      const anon = "Vi er en familiegård som har vært drevet av samme slekt siden 1850. Vi driver med sau og storfe på utmarksbeite i fjellet om sommeren.";
      const h1Far = page(`<head><title>Om oss</title><style>${"x".repeat(40_000)}</style></head>`, `<main><h1>Tverås Gårdsmat</h1><p>${anon}</p><p>${LONG_PROSE_2}</p></main>`);
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: h1Far }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "chosen", "win-14: an <h1> beyond the raw cap names the producer");
      assertTrue(aboutPageNamesProducer(anon, h1Far, producerNameTokens("Tverås Gårdsmat")), "win-15: aboutPageNamesProducer computes the window itself when not given");

      // Script-shaped text is a code artifact for an about-page candidate.
      assertTrue(aboutPageTextLooksLikeScript(js), "js-1: the measured Granum script text reads as script");
      for (const t of [
        LONG_PROSE_1,
        LONG_PROSE_2,
        LONG_PROSE_3,
        "Vi bruker råvarer fra egen gård; alt lages for hånd.",
        "Les mer om oss på nettsiden – vi har åpent alle dager.",
        "Gården har en viktig sosial function (som samlingssted) i bygda.",
        "Se www.gard.no/document.html for åpningstider.",
        "Fra window.The view over fjorden er fantastisk.",
      ]) {
        assertTrue(!aboutPageTextLooksLikeScript(t), `js-2: prose is not script: ${t.slice(0, 30)}`);
      }
      for (const t of [
        "window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag('js', new Date());",
        "gtag('config', 'G-XXXX');",
        "fbq('init', '123'); fbq('track', 'PageView');",
        "_paq.push(['trackPageView']);",
        "dataLayer.push({ event: 'view' });",
        "async function load() { await x(); }",
        "items.forEach(x => { console.log(x); });",
        '{ "@context": "https://schema.org", "@type": "LocalBusiness" }',
        "document.addEventListener('DOMContentLoaded', init);",
      ]) {
        assertTrue(aboutPageTextLooksLikeScript(t), `js-4: script shape caught: ${t.slice(0, 40)}`);
      }
      const jsProse = `<main><p>${LONG_PROSE_1} var a = window.x;</p><p>${LONG_PROSE_2}</p></main>`;
      assertEq(pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html: page(bigHead(100), jsProse) }], producerName: "Tverås Gårdsmat" }).evaluated[0]?.verdict, "code_artifact", "js-3: a script-shaped candidate is refused as code_artifact");

      // Linear on hostile markup.
      const t = (html: string): number => {
        const t0 = performance.now();
        aboutPageContentWindow(html);
        pickAboutPageCandidate({ homepageCandidate: HOME_SHORT_META, aboutPages: [{ url, html }], producerName: "Tverås Gårdsmat" });
        return performance.now() - t0;
      };
      for (const [label, html] of [
        ["100k «<head><body>» (unclosed <head> each time)", "<head><body>".repeat(100_000)],
        ["100k «<head <body »", "<head <body ".repeat(100_000)],
        ["3k «<head><body>» + 500 kB tail", "<head><body>".repeat(3_000) + "x".repeat(500_000)],
        ["100k unclosed <fieldset> with prose", `<fieldset><p>${LONG_PROSE_1}</p>`.repeat(12_000)],
        ["100k unclosed <script", "<script ".repeat(100_000)],
        ["100k unclosed <!--", `<p>${LONG_PROSE_1}</p>` + "<!-- x ".repeat(100_000)],
        ["100k closed <script>", "<script>x</script>".repeat(100_000) + `<main><p>${LONG_PROSE_1}</p></main>`],
        ["100k unclosed <head", "<head ".repeat(100_000)],
        ["100k unclosed <fieldset", "<fieldset>".repeat(100_000)],
        ["2.5 MB of prose", `<main>${`<p>${LONG_PROSE_1}</p>`.repeat(17_000)}</main>`],
      ] as const) {
        const ms = t(html);
        // Linear inputs of this size take ~10–200 ms; the quadratic shape
        // review round 1 found took 4.6 s at 400 kB and 47 s at 1.2 MB.
        assertTrue(ms < 1500, `win-patho: ${label} (${(html.length / 1000).toFixed(0)} kB) in < 1.5 s (got ${ms.toFixed(0)} ms)`);
      }
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
