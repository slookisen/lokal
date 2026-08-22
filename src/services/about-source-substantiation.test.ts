/**
 * about-source-substantiation.test.ts — unit tests for
 * checkAboutCandidateSubstantiatedBySource (dev-request
 * 2026-08-22-rfbweb-about-guard), the deterministic (no LLM) check that an
 * about/description candidate actually appears in — or is closely
 * substantiated by — the raw source text it was purportedly extracted from.
 * Reference incident: the "Li Lynghonning" agent showed a stale/mismatched
 * about-text that did not match its actual current source page.
 *
 * Pure function, no mocks, no DB, no network. The route-level integration
 * (POST /admin/homepage-content-refresh, admin-knowledge.ts) is covered
 * separately in admin-knowledge-about-substantiation.test.ts — see that
 * file's header comment for why a genuine REJECTION cannot be constructed
 * through that route's real fetch-then-extract pipeline (the candidate is
 * always derived directly from the exact page text checked against it) and
 * why this pure-function file is where the accept/reject contract itself is
 * actually exercised.
 *
 * Sections:
 *   A. Fail-closed edge cases — empty candidate, empty/missing source, a
 *      candidate with no significant words.
 *   B. Verbatim (normalised) substring match — the common case: an exact
 *      excerpt, one differing only in whitespace/case, one embedded inside
 *      HTML markup (e.g. a `<meta content="...">` attribute value, which is
 *      exactly summarizeAbout()'s og:description/meta-description shape),
 *      and one requiring HTML-entity decoding to line up.
 *   C. Close-paraphrase word-overlap bar — a genuine paraphrase clearing the
 *      70%/3-word bar accepted; an unrelated candidate sharing only a couple
 *      of generic words rejected; a boundary case just under the bar
 *      rejected.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAboutSourceSubstantiationTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
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
    const { checkAboutCandidateSubstantiatedBySource } =
      require("./about-source-substantiation") as typeof import("./about-source-substantiation");

    // ═══════════════════════════════════════════════════════════════════
    // Section A — fail-closed edge cases.
    // ═══════════════════════════════════════════════════════════════════
    try {
      let v = checkAboutCandidateSubstantiatedBySource("", "Vi produserer ekte gårdshonning fra egne bikuber.");
      assertEq(v.substantiated, false, "a-1: empty candidate -> not substantiated");
      assertTrue(/empty/i.test(v.reason), "a-2: reason explains the candidate was empty");

      v = checkAboutCandidateSubstantiatedBySource("Vi produserer ekte gårdshonning.", "");
      assertEq(v.substantiated, false, "a-3: empty source text -> not substantiated (cannot verify, fail-closed)");
      assertTrue(/fail-closed|cannot verify/i.test(v.reason), "a-4: reason names the fail-closed contract");

      v = checkAboutCandidateSubstantiatedBySource(null, "some source text");
      assertEq(v.substantiated, false, "a-5: null candidate -> not substantiated, never throws");
      v = checkAboutCandidateSubstantiatedBySource("candidate", undefined);
      assertEq(v.substantiated, false, "a-6: undefined source -> not substantiated, never throws");

      // A candidate with no significant (>=4-letter, non-stopword) words at
      // all can never be verified by the word-overlap fallback either — and
      // if it also isn't a verbatim substring, it must fail closed, not
      // vacuously pass a 0-word "100% overlap".
      v = checkAboutCandidateSubstantiatedBySource("é å øy", "en helt annen tekst om noe helt annet enn dette");
      assertEq(v.substantiated, false, "a-7: candidate with no significant words and no verbatim match -> not substantiated");
    } catch (err: any) {
      failed++;
      failures.push("about-source-substantiation (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — verbatim (normalised) substring match.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const source =
        "<html><head><title>Ekte Gård AS</title>" +
        '<meta property="og:description" content="Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal.">' +
        "</head><body><h1>Ekte Gård</h1><p>Velkommen til garden vår.</p></body></html>";

      let v = checkAboutCandidateSubstantiatedBySource(
        "Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal.",
        source,
      );
      assertEq(v.substantiated, true, "b-1: candidate matching an og:description META ATTRIBUTE VALUE verbatim -> substantiated (this is exactly summarizeAbout()'s case-1 shape — never present in tag-stripped visible text, only in raw markup)");
      assertTrue(/verbatim/i.test(v.reason), "b-2: reason names the verbatim match");

      // Whitespace/case differences must not defeat the match — the real
      // pipeline collapses whitespace and this function must be equally
      // tolerant, not accidentally stricter than upstream normalisation.
      v = checkAboutCandidateSubstantiatedBySource(
        "  VI PRODUSERER   ekte gårdshonning\nfra egne bikuber i Hallingdal.  ",
        source,
      );
      assertEq(v.substantiated, true, "b-3: whitespace-run/case differences do not defeat the verbatim match");

      // A candidate broken across an inline tag in the RAW markup (e.g.
      // "<strong>") is not a literal substring of the raw HTML, but IS
      // contiguous once tags are stripped — proving why callers must pass
      // BOTH raw html and tag-stripped visible text as the source.
      const inlineTagHtml =
        "<html><body><p>Vi produserer <strong>ekte</strong> gårdshonning fra egne bikuber.</p></body></html>";
      const strippedVisible = "Ekte Gård Vi produserer ekte gårdshonning fra egne bikuber.";
      v = checkAboutCandidateSubstantiatedBySource(
        "Vi produserer ekte gårdshonning fra egne bikuber.",
        `${inlineTagHtml}\n${strippedVisible}`,
      );
      assertEq(v.substantiated, true, "b-4: candidate whose raw-html rendering is broken by an inline tag still matches via the concatenated tag-stripped visible-text half of the source");

      // HTML-entity decoding: the candidate is already decoded (as
      // summarizeAbout()'s own decode(og) call produces), the raw source
      // still carries the literal entity.
      const entitySource = '<meta name="description" content="Gård &amp; Bryggeri i Valdres.">';
      v = checkAboutCandidateSubstantiatedBySource("Gård & Bryggeri i Valdres.", entitySource);
      assertEq(v.substantiated, true, "b-5: candidate matches after the source's HTML entity (&amp;) is decoded");

      // Negative: a candidate genuinely NOT present in the source, and not a
      // close paraphrase either (word overlap far under the bar).
      v = checkAboutCandidateSubstantiatedBySource(
        "Vi selger håndlagede stoler av gjenbruksmateriale fra vårt verksted i Bergen.",
        source,
      );
      assertEq(v.substantiated, false, "b-6: an unrelated candidate about a completely different business -> NOT substantiated");
      assertTrue(/not found|overlap/i.test(v.reason), "b-7: reason explains it was not found and names the overlap");
    } catch (err: any) {
      failed++;
      failures.push("about-source-substantiation (section B): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — close-paraphrase word-overlap bar.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const source =
        "Ekte Gård ligger i Hallingdal og produserer gårdshonning, ost og syltetøy fra egne råvarer. " +
        "Garden har vore i familiens eige sidan 1920 og selger produkter i egen gårdsbutikk.";

      // A genuine paraphrase: same content words, different sentence
      // structure/connectives — should clear the 70%/3-word bar easily.
      let v = checkAboutCandidateSubstantiatedBySource(
        "Gårdshonning, ost og syltetøy produseres på Ekte Gård i Hallingdal fra egne råvarer.",
        source,
      );
      assertEq(v.substantiated, true, "c-1: a genuine paraphrase sharing most significant words -> substantiated (close paraphrase)");
      assertTrue(/paraphrase/i.test(v.reason), "c-2: reason names the close-paraphrase branch");

      // A candidate sharing only a couple of generic/short words with the
      // source (below MIN_SIGNIFICANT_WORD_MATCHES) must NOT pass — proves
      // the 3-word floor, not just the ratio, is enforced.
      v = checkAboutCandidateSubstantiatedBySource(
        "Vi tilbyr rask levering av elektronikk til hele landet.",
        source,
      );
      assertEq(v.substantiated, false, "c-3: a candidate sharing at most one or two incidental words -> NOT substantiated");

      // A candidate that is MOSTLY unrelated but happens to reuse a handful
      // of the source's words is still rejected once the ratio drops well
      // under 70%, even though it clears the raw 3-word floor.
      v = checkAboutCandidateSubstantiatedBySource(
        "Ekte Gård i Hallingdal tilbyr også fjellklatring, rafting, sykkelutleie, museum, konserter og kunstutstilling hver helg gjennom hele sommersesongen for hele familien.",
        source,
      );
      assertEq(v.substantiated, false, "c-4: a candidate with many unrelated significant words diluting the ratio below 70% -> NOT substantiated, even though a few words (Ekte/Gård/Hallingdal) do overlap");
    } catch (err: any) {
      failed++;
      failures.push("about-source-substantiation (section C): unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAboutSourceSubstantiationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
