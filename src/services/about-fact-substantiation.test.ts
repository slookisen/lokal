/**
 * about-fact-substantiation.test.ts — unit tests for
 * checkAboutCandidateFactSubstantiated (dev-request
 * 2026-09-24-stikkproeve-undersider-og-faktanivaa-about, Del B).
 *
 * Pure function, no mocks, no DB, no network — HTML fixtures below are
 * hand-built to be representative of a real producer site (root page with
 * nav/body-paragraph/footer, following the same shape
 * `computeFieldSpotCheck` actually fetches and concatenates:
 * `${html}\n${visibleTextOf(html)}`), not literal captures of a live page.
 *
 * Sections:
 *   A. AC1 — the Vollan Gård positive fixture: a Nynorsk stored `about`
 *      value, a Bokmål page, same underlying facts (place name, founder
 *      surname, two years) spread across a normal-length (~700-char) real
 *      prose paragraph — must be a `match`.
 *   B. AC2 — the same page, a synthetic `about` with a fabricated name and
 *      year — must be a `mismatch`.
 *   C. This module's OWN adversarial cases, modeled on all three documented
 *      failure rounds (see the module's own header comment and
 *      protocols/orchestrator-failures/2026-09-24-stikkproeve-faktanivaa-about-delb.md
 *      in the A2A control repo), plus extra vocabulary-stuffing variants —
 *      every one of these must stay a `mismatch`.
 *   D. Fallback — a candidate with fewer than 2 qualifying facts must
 *      delegate, unchanged, to checkAboutCandidateSubstantiatedBySource's
 *      existing (a)/(b) rules (both a passing and a failing case).
 *   E. Fail-closed edge cases (empty/null candidate or source).
 *   F. 4th-attempt fix-up round 1 regression: a bare, legal '>' elsewhere in
 *      ordinary page text (a footer "shortcuts" menu line) must not throw
 *      off the raw-HTML/flattened-text boundary and let unrelated real
 *      article prose get glued to unrelated footer facts.
 *   G. The flattened `visibleTextOf()` half of sourceText is categorically
 *      excluded from fact-level blockification — a fact reachable only
 *      through it (no real HTML tag structure) must not be corroborated.
 *   H. Boundary-detection robustness: real HTML containing its own embedded
 *      newlines (pretty-printed markup, the normal case for a real fetched
 *      page) must not confuse the raw-HTML/flattened-text split.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runAboutFactSubstantiationTests(
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
    const { checkAboutCandidateFactSubstantiated } =
      require("./about-fact-substantiation") as typeof import("./about-fact-substantiation");

    // ═══════════════════════════════════════════════════════════════════
    // Shared fixture: a Vollan-Gård-shaped producer site. Root page HTML
    // with a nav, one real body paragraph (~700 chars — deliberately
    // NORMAL prose length, not artificially short, per round 2's own
    // failure: a fixed-length proximity window that only worked on a short
    // artificial paragraph is exactly the defect this fixture is chosen to
    // guard against), and a footer carrying the kind of compact
    // name/street/org-nr/year block every round's adversarial candidate
    // tried to loan from. `withSourceText` mirrors computeFieldSpotCheck's
    // own `${html}\n${visibleTextOf(html)}` concatenation exactly.
    // ═══════════════════════════════════════════════════════════════════
    const bodyParagraph =
      "Vollan Gård ligger vakkert til ved Rødvenfjorden i Rauma kommune, omgitt av bratte fjell og frodig kulturlandskap. " +
      "Gården har vært i samme slekt siden 1600-tallet, og har gjennom generasjoner vært et sentralt tun i bygda. " +
      "Området rundt gården har lang tradisjon for jordbruk og husdyrhold, og mange av de gamle steingjerdene fra den tiden står fortsatt i dag som et vitnesbyrd om slitet til tidligere generasjoner. " +
      "Historien forteller at oldefar Ole Dahle plantet eplehagen rundt 1932, og epletrærne han satte den gangen bærer fortsatt frukt hver høst. " +
      "Familien driver i dag et allsidig gårdsbruk med både frukt, bær og tradisjonelt jordbruk, og tar imot besøkende som ønsker å oppleve gårdslivet på nært hold.";

    const rootHtml =
      "<html><head><title>Vollan Gård</title></head><body>" +
      "<nav><a href='/'>Hjem</a><a href='/om-oss'>Om oss</a><a href='/produkter'>Produkter</a><a href='/kontakt'>Kontakt</a></nav>" +
      `<p>${bodyParagraph}</p>` +
      "<footer>" +
      "<address>Adresse: Vollanvegen 14, 6320 Isfjorden</address>" +
      "<p>Telefon: 71 23 45 67</p>" +
      "<p>E-post: post@vollangaard.no</p>" +
      "<p>Org.nr: 987654321</p>" +
      "<p>Åpningstider: Mandag til fredag 09:00-16:00</p>" +
      "<p>&copy; 2019 Vollan Gård</p>" +
      "</footer>" +
      "</body></html>";

    function withVisibleTextTail(rawHtml: string): string {
      const stripped = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z#0-9]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      return `${rawHtml}\n${stripped}`;
    }

    const sourceText = withVisibleTextTail(rootHtml);

    // ═══════════════════════════════════════════════════════════════════
    // Section A — AC1: Vollan Gård positive fixture (Nynorsk vs Bokmål).
    // ═══════════════════════════════════════════════════════════════════
    try {
      const nynorskAbout =
        "Vollan Gård ligg ved Rødvenfjorden i Rauma kommune og har vore i same slekt sidan 1600-talet. " +
        "Oldefar Ole Dahle planta eplehagen kring 1932, og familien driv framleis garden med tradisjonelt jordbruk og fruktdyrking.";

      const v = checkAboutCandidateFactSubstantiated(nynorskAbout, sourceText);
      assertEq(v.substantiated, true, "a-1 (AC1): Nynorsk about vs. Bokmål page, same facts -> substantiated (match)");
      assertTrue(/fact-level match/i.test(v.reason), "a-2: reason names the fact-level match branch");
      assertTrue(/6\/6/.test(v.reason), "a-3: all 6 distinct facts (gård, rødvenfjorden, rauma, dahle, 1600, 1932) confirmed");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section A): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section B — AC2: fabricated name + year negative fixture.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const fabricated = "Gården har vært i familien til Kari Nordmann siden 1450.";
      const v = checkAboutCandidateFactSubstantiated(fabricated, sourceText);
      assertEq(v.substantiated, false, "b-1 (AC2): fabricated name+year, none present on page -> NOT substantiated (mismatch)");
      assertTrue(/fact-level mismatch/i.test(v.reason), "b-2: reason names the fact-level mismatch branch");
      assertTrue(/0\/3/.test(v.reason), "b-3: 0 of the 3 fabricated facts (kari, nordmann, 1450) confirmed");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section B): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section C — this module's own adversarial cases, one per documented
    // failure round, plus extra vocabulary-stuffing variants.
    // ═══════════════════════════════════════════════════════════════════
    try {
      // Round 1 style: 2 facts scattered in nav/footer, unrelated to any
      // real narrative — a fabricated year nothing on the page has, plus
      // the nav's own "Kontakt" link word borrowed as a fake surname.
      let v = checkAboutCandidateFactSubstantiated(
        "Vollan Gård ble grunnlagt av familien Kontakt i 4567, og driver i dag med tradisjonelt landbruk langs fjorden.",
        sourceText,
      );
      assertEq(v.substantiated, false, "c-1 (round-1 style): isolated scattered nav-word + fabricated year -> NOT substantiated");

      // Round 2(a) style: an ordinary footer loan — street name, place
      // name and the footer's own copyright year — built into a fabricated
      // founding story, all three tokens genuinely present on the page but
      // ONLY in the compact, otherwise-unrelated footer block.
      v = checkAboutCandidateFactSubstantiated(
        "Historien til Vollanvegen gården starter i 2019, da familien Isfjorden overtok drifta og bygde opp gårdsbutikken fra bunnen.",
        sourceText,
      );
      assertEq(v.substantiated, false, "c-2 (round-2(a) style): footer-loaned street/place/year built into a fabricated founding story -> NOT substantiated");

      // Round 3 style: the exact defeat that beat round 3 — footer-loaned
      // facts (place name, year) PLUS two full sentences of real, correct
      // page prose spliced in from a DIFFERENT part of the page (the
      // actual shape a hallucinating LLM tends to produce). The spliced
      // sentences genuinely corroborate the 1600 fact they actually
      // discuss, but must NOT be allowed to corroborate the unrelated,
      // footer-loaned facts living in a different block.
      v = checkAboutCandidateFactSubstantiated(
        "Historien til Vollanvegen gården starter i 1987, da familien Isfjorden overtok drifta. " +
          "Gården har vært i samme slekt siden 1600-tallet, og har gjennom generasjoner vært et sentralt tun i bygda. " +
          "Området rundt gården har lang tradisjon for jordbruk og husdyrhold.",
        sourceText,
      );
      assertEq(v.substantiated, false, "c-3 (round-3 style): footer-loaned facts + spliced real prose from elsewhere -> NOT substantiated");

      // Extra: a determined adversary padding the candidate with the
      // footer's OWN generic vocabulary (address/telefon/org-nr/opening
      // hours words) to try to inflate that block's local overlap.
      v = checkAboutCandidateFactSubstantiated(
        "Vollan Gård AS ligger på adressen Vollanvegen 14 i Isfjorden. Bedriftens telefon og organisasjonsnummer finner du på nettsiden, " +
          "og åpningstider gjelder mandag til fredag som normalt. Selskapet ble registrert i 2019.",
        sourceText,
      );
      assertEq(v.substantiated, false, "c-4 (own adversarial: footer-vocabulary stuffing): -> NOT substantiated");

      // Extra: a terse, almost-all-facts candidate (tiny "other content"
      // word pool) — must not let a single lucky word match vacuously
      // satisfy the local-corroboration floor.
      v = checkAboutCandidateFactSubstantiated(
        "Vollan Gård i Isfjorden, Vollanvegen 14, etablert 2019, ifølge telefon.",
        sourceText,
      );
      assertEq(v.substantiated, false, "c-5 (own adversarial: terse near-all-facts candidate) -> NOT substantiated");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section C): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section D — fewer than 2 facts: falls back, unchanged, to
    // checkAboutCandidateSubstantiatedBySource's existing (a)/(b) rules.
    // ═══════════════════════════════════════════════════════════════════
    try {
      // Fallback case that the write-guard's own (b) close-paraphrase rule
      // accepts (no qualifying facts at all in this candidate).
      let v = checkAboutCandidateFactSubstantiated(
        "Vi produserer ekte gårdshonning fra egne bikuber.",
        "Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal.",
      );
      assertEq(v.substantiated, true, "d-1: <2 facts, write-guard's own rules would accept -> fact-level check delegates and also accepts");
      assertTrue(/paraphrase/i.test(v.reason), "d-2: reason comes from the delegated write-guard branch, not the fact-level branch");

      // Fallback case that the write-guard's own rules reject (unrelated
      // candidate, no qualifying facts either) — must still reject.
      v = checkAboutCandidateFactSubstantiated(
        "Vi selger håndlagede stoler av gjenbruksmateriale fra vårt verksted i Bergen.",
        "Vi produserer ekte gårdshonning fra egne bikuber i Hallingdal.",
      );
      assertEq(v.substantiated, false, "d-3: <2 facts, write-guard's own rules would reject -> fact-level check delegates and also rejects");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section D): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section E — fail-closed edge cases.
    // ═══════════════════════════════════════════════════════════════════
    try {
      let v = checkAboutCandidateFactSubstantiated("", sourceText);
      assertEq(v.substantiated, false, "e-1: empty candidate -> not substantiated");

      v = checkAboutCandidateFactSubstantiated(
        "Vollan Gård i Isfjorden, grunnlagt av Ole Dahle i 1932.",
        "",
      );
      assertEq(v.substantiated, false, "e-2: empty source text with >=2 facts in candidate -> not substantiated, fail-closed");
      assertTrue(/fail-closed|cannot verify/i.test(v.reason), "e-3: reason names the fail-closed contract");

      v = checkAboutCandidateFactSubstantiated(null, sourceText);
      assertEq(v.substantiated, false, "e-4: null candidate -> not substantiated, never throws");

      v = checkAboutCandidateFactSubstantiated("candidate", undefined);
      assertEq(v.substantiated, false, "e-5: undefined source -> not substantiated, never throws");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section E): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section F — 4th-attempt fix-up round 1 regression: the boundary
    // between the raw-HTML half and the flattened `visibleTextOf()` half of
    // `sourceText` must be found STRUCTURALLY (the literal "\n" join
    // separator, guaranteed absent from `visibleTextOf()`'s own output — see
    // `structuredPortion`'s doc comment), never by scanning for the LAST '>'
    // character in the combined string. A bare '>' is legal, ordinary page
    // text (a breadcrumb, a "read more" link, a menu) and can appear
    // anywhere, including inside the flattened tail itself; scanning for it
    // finds the wrong boundary and lets the sentence-window fallback glue a
    // real article's prose to an unrelated footer block.
    //
    // Different concrete fixture from the reviewer's own reproduction
    // (which used "Solheim Gartneri" / "Fjordvegen" / "Anna Berge") — this
    // one uses an unrelated farm ("Lindstad Gård"), an unrelated real
    // founder ("Sigrid Holme", 1954) and an unrelated footer
    // (address "Nordbygdvegen 8, 6210 Valldal", an org-nr, "© 2011", and a
    // footer "Snarveier" (shortcuts) menu line carrying a literal '>') — to
    // prove the FIX generalizes rather than patching one exact fixture.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const lindstadArticle =
        "Lindstad Gård ligger idyllisk til ved Storelva i Sunndal kommune, med utsikt over dalen og de bratte fjellsidene rundt. " +
        "Garden har vore i drift sidan 1954, då Sigrid Holme starta opp med sauehald og småskala grønsakdyrking. " +
        "Gjennom åra har garden utvikla seg til å bli ein viktig del av lokalsamfunnet, med eige gardsutsal og openheit for besøkande. " +
        "Jorda rundt garden er rik og veldyrka, og fleire av dei gamle løene frå den tida står framleis den dag i dag. " +
        "I dag driv familien eit variert gardsbruk med bær, grønsaker og dyrehald, og tek imot skuleklassar og turistar gjennom sommarsesongen.";

      const lindstadHtml =
        "<html><head><title>Lindstad Gård</title></head><body>" +
        "<nav><a href='/'>Hjem</a><a href='/om'>Om</a><a href='/kontakt'>Kontakt</a></nav>" +
        "<article>" + `<p>${lindstadArticle}</p>` + "</article>" +
        "<footer>" +
        "<address>Adresse: Nordbygdvegen 8, 6210 Valldal</address>" +
        "<p>Org.nr: 912345678</p>" +
        "<p>&copy; 2011 Lindstad Gård</p>" +
        // The bare, legal '>' that broke the old boundary scan — an
        // ordinary footer "shortcuts" line, not a data-bearing fact.
        "<p>Snarveier: Hjem > Om > Kontakt</p>" +
        "</footer>" +
        "</body></html>";

      const lindstadSourceText = withVisibleTextTail(lindstadHtml);

      // Fabricated candidate: borrows ONLY the footer's street-name-as-
      // surname ("Nordbygdvegen") and copyright year ("2011") as its two
      // "facts" — nothing about the real founder Sigrid Holme / 1954 — and
      // splices in, verbatim, the real article's own unrelated closing
      // sentence (today's farm activities, not the founding story).
      const lindstadFabricated =
        "Garden ved Nordbygdvegen vart skipa i 2011 av ein lokal familie. " +
        "I dag driv familien eit variert gardsbruk med bær, grønsaker og dyrehald, og tek imot skuleklassar og turistar gjennom sommarsesongen.";

      const v = checkAboutCandidateFactSubstantiated(lindstadFabricated, lindstadSourceText);
      assertEq(
        v.substantiated,
        false,
        "f-1: footer-loaned facts (street-as-surname + copyright year) spliced with a real-but-unrelated " +
          "article sentence, with a literal '>' elsewhere in ordinary page text -> NOT substantiated",
      );
      assertTrue(/fact-level mismatch/i.test(v.reason), "f-2: reason names the fact-level mismatch branch");
      assertTrue(/0\/2/.test(v.reason), "f-3: 0 of the 2 footer-loaned facts (nordbygdvegen, 2011) locally corroborated");

      // Sanity check that this fixture actually HAS a bare '>' positioned so
      // that a naive lastIndexOf('>') scan over the whole combined
      // sourceText lands inside the flattened tail (proving this is a real
      // reproduction of the boundary bug, not a fixture that happens not to
      // trigger it).
      const naiveLastGt = lindstadSourceText.lastIndexOf(">");
      assertTrue(
        naiveLastGt > lindstadHtml.length,
        "f-4 (fixture sanity): the fixture's last bare '>' sits inside the flattened tail, past the raw-HTML half " +
          "(html.length=" + lindstadHtml.length + ", found at=" + naiveLastGt + ") — confirms this fixture " +
          "exercises the exact boundary the old '>'-scan got wrong",
      );
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section F): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section G — the flattened `visibleTextOf()` half of sourceText is
    // ALWAYS excluded from fact-level blockification (see
    // `structuredPortion`): a fact that exists ONLY in a portion appended
    // after the raw-HTML/flattened-text join separator, with no
    // corresponding real HTML tag structure of its own, must fall through
    // to "not corroborated" rather than being silently picked up from that
    // appended tail. This is a deliberate, safety-favoring scope choice
    // (documented in `structuredPortion`'s comment): real HTML structure is
    // the only trusted signal for local corroboration.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const realHtmlNoFact =
        "<html><body><article><p>" +
        "Bakken Gård har drive med sauehald og fruktdyrking i mange tiår, og familien tek imot besøkande kvar sommar." +
        "</p></article></body></html>";
      // Simulates a corrupted/non-conforming combined string where a fact
      // and its surrounding "prose" exist ONLY after the join separator,
      // never in the real HTML at all — this can't arise from a genuine
      // `${html}\n${visibleTextOf(html)}` call (the tail is always a strict
      // flattening of the SAME html), but proves the exclusion is total and
      // doesn't accidentally leak a fact through the tail under any input.
      const tailOnlyFact =
        "Bakken Gård vart skipa i 1946 av Nils Bakken, som dreiv garden fram til han selde til naboen i 1970.";
      const sourceWithTailOnlyFact = `${realHtmlNoFact}\n${tailOnlyFact}`;

      const v = checkAboutCandidateFactSubstantiated(
        "Bakken Gård vart skipa i 1946 av Nils Bakken.",
        sourceWithTailOnlyFact,
      );
      assertEq(
        v.substantiated,
        false,
        "g-1: a fact present only in the appended tail (no corresponding real HTML block) " +
          "-> NOT corroborated, falls through safely rather than matching",
      );
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section G): unexpected error: " + String(err?.stack || err?.message || err));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Section H — boundary-detection robustness: real fetched HTML is
    // normally pretty-printed with its OWN embedded newlines throughout the
    // raw-HTML half. The fix relies on the flattened `visibleTextOf()` half
    // having ZERO newlines (guaranteed by its own whitespace-collapsing
    // regex) so that the LAST "\n" in the combined string is always the join
    // separator — this must hold even when the raw-HTML half is full of
    // newlines of its own, not just for the single-line HTML used in the
    // other fixtures above.
    // ═══════════════════════════════════════════════════════════════════
    try {
      const prettyPrintedHtml =
        "<html>\n" +
        "  <head>\n    <title>Vollan Gård</title>\n  </head>\n" +
        "  <body>\n" +
        "    <nav>\n      <a href='/'>Hjem</a>\n      <a href='/om-oss'>Om oss</a>\n    </nav>\n" +
        `    <p>\n      ${bodyParagraph}\n    </p>\n` +
        "    <footer>\n" +
        "      <address>Adresse: Vollanvegen 14, 6320 Isfjorden</address>\n" +
        "      <p>Org.nr: 987654321</p>\n" +
        "      <p>&copy; 2019 Vollan Gård</p>\n" +
        "    </footer>\n" +
        "  </body>\n" +
        "</html>\n";
      const prettySourceText = withVisibleTextTail(prettyPrintedHtml);

      let v = checkAboutCandidateFactSubstantiated(
        "Vollan Gård ligg ved Rødvenfjorden i Rauma kommune og har vore i same slekt sidan 1600-talet. " +
          "Oldefar Ole Dahle planta eplehagen kring 1932, og familien driv framleis garden med tradisjonelt jordbruk og fruktdyrking.",
        prettySourceText,
      );
      assertEq(v.substantiated, true, "h-1: pretty-printed HTML with embedded newlines — genuine facts still substantiated");

      v = checkAboutCandidateFactSubstantiated(
        "Gården har vært i familien til Kari Nordmann siden 1450.",
        prettySourceText,
      );
      assertEq(v.substantiated, false, "h-2: pretty-printed HTML with embedded newlines — fabricated facts still rejected");
    } catch (err: any) {
      failed++;
      failures.push("about-fact-substantiation (section H): unexpected error: " + String(err?.stack || err?.message || err));
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runAboutFactSubstantiationTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
