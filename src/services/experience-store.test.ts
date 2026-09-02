/**
 * experience-store.test.ts — unit tests for the PURE helpers in
 * services/experience-store.ts.
 *
 * Currently covers formatDistanceLabel() (dev-request 2026-07-04-opplevagent-
 * naer-meg-geosok, item 3: «Nær meg» on /sok) — the honesty rule that a
 * 'kommune'-precision (centroid-fallback) row must NEVER render a street-
 * level distance claim, only an 'address'-precision row may.
 *
 * No DB access — getDb() is lazy (only called inside DB-touching functions),
 * so importing this module and calling formatDistanceLabel() directly is
 * safe without any EXPERIENCES_DB_PATH/in-memory-DB setup.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-store.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperienceStoreTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import {
  formatDistanceLabel,
  gardssalgRewriteEligible,
  gardssalgProductsEligible,
  gardssalgReplaceableFieldAction,
  // dev-request 2026-07-21-opplevagent-norske-tegn-encoding, criterion 3:
  // mojibake candidate-scan DETECTION (PURE — no DB, no network).
  scanGardssalgProviderRowForMojibake,
  // dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2 —
  // berikelsestriage: the shared per-field homepage-provenance classifier
  // (PURE — no DB, no network) that BOTH selectProvidersForContentRefresh
  // and GET /admin/providers/content-triage call.
  parseContentFieldEvidence,
  homepageRegistrableDomain,
  isContentFieldHomepageSourced,
  isExperienceContentGenuinelyThin,
  classifyProviderContentBucket,
  // Grep 4c: navnegjetting v3 — first-word-only, ø→oe-alone, and
  // punycode/IDN candidate sources added to the tier-1 domain-guess heuristic.
  gardssalgWebsiteCandidateHosts,
} from "./experience-store";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceStoreTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── formatDistanceLabel: address precision → exact "X,X km unna" ────────
  assertEq(formatDistanceLabel(2.4, "address", "Tromsø"), "2,4 km unna", "address precision: 2.4km → '2,4 km unna'");
  assertEq(formatDistanceLabel(0, "address", "Tromsø"), "0,0 km unna", "address precision: 0km → '0,0 km unna'");
  assertEq(formatDistanceLabel(63.9, "address", null), "63,9 km unna", "address precision: no kommune needed, still shows exact distance");
  assertEq(formatDistanceLabel(2, "address", "Oslo"), "2,0 km unna", "address precision: whole-number km still shows one decimal (2,0)");

  // ── formatDistanceLabel: kommune precision → NEVER a distance, only the
  //    kommune name — this is the honesty rule from the dev-request ────────
  assertEq(formatDistanceLabel(63.9, "kommune", "Tromsø"), "i Tromsø kommune", "kommune precision: never claims a distance, even though distance_km is present");
  assertEq(formatDistanceLabel(null, "kommune", "Bergen"), "i Bergen kommune", "kommune precision: works with null distance_km too");
  assertEq(formatDistanceLabel(5, "kommune", null), "omtrentlig posisjon (kommune)", "kommune precision with no kommune name: generic approximate label, still no fabricated distance");

  // ── formatDistanceLabel: nothing honest to say → null (render nothing) ──
  assertEq(formatDistanceLabel(null, null, "Oslo"), null, "no geo_precision at all → null (never geocoded)");
  assertEq(formatDistanceLabel(2.4, null, "Oslo"), null, "distance present but no geo_precision flag → null (don't guess)");
  assertEq(formatDistanceLabel(undefined, undefined, undefined), null, "all undefined → null");
  assertEq(formatDistanceLabel(NaN, "address", "Oslo"), null, "address precision but non-finite distance → null, not 'NaN km unna'");

  // ── gardssalgRewriteEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5a) — the "passing-bar-but-short"
  //    cohort gardssalgReplaceableFieldAction() never touches. ──────────────
  const PASSING_BAR_SHORT_86 =
    "Familiedrevet gård på Toten som dyrker grønnsaker og bær, og selger dem i egen butikk.";
  const SUB_80_63 = "Liten gård med noen dyr og en pen have full av epletrær og bær.";
  const PASSING_BAR_LONG_215 =
    "Familiedrevet gård på Toten som dyrker økologiske grønnsaker og bær, og selger dem direkte fra gårdsbutikken. Vi holder også sauer og høns, og inviterer besøkende til å oppleve gårdslivet på nært hold hele sommeren.";

  assertTrue(PASSING_BAR_SHORT_86.length >= 80 && PASSING_BAR_SHORT_86.length < 200, "sanity: PASSING_BAR_SHORT_86 is in the [80,200) window");
  assertTrue(SUB_80_63.length < 80, "sanity: SUB_80_63 is under the 80-char quality bar");
  assertTrue(PASSING_BAR_LONG_215.length >= 200, "sanity: PASSING_BAR_LONG_215 is >= 200 chars");

  assertEq(gardssalgRewriteEligible(PASSING_BAR_SHORT_86), true, "gardssalgRewriteEligible: 86-char value passing the quality bar and <200 chars → true");
  assertEq(gardssalgRewriteEligible(SUB_80_63), false, "gardssalgRewriteEligible: 63-char value (fails the 80-char quality bar) → false");
  assertEq(gardssalgRewriteEligible(PASSING_BAR_LONG_215), false, "gardssalgRewriteEligible: 215-char value (passes bar but already >=200 chars) → false, not a rewrite candidate");
  assertEq(gardssalgRewriteEligible(""), false, "gardssalgRewriteEligible: blank string → false");
  assertEq(gardssalgRewriteEligible("   "), false, "gardssalgRewriteEligible: whitespace-only string → false");
  assertEq(gardssalgRewriteEligible(null), false, "gardssalgRewriteEligible: null → false");
  assertEq(gardssalgRewriteEligible(undefined), false, "gardssalgRewriteEligible: undefined → false");

  // ── gardssalgReplaceableFieldAction's currentValueJudgedContaminated param
  //    (fix-up round, independent review's blocking finding): "current value
  //    passes the cheap bar" no longer means "never touch it" unconditionally
  //    — a cheap-bar-passing current value that the caller's LLM judge found
  //    contaminated (nav-menu chrome glued to one real sentence, the Draopar
  //    incident shape — see cal-1 in opplevelser-gardssalg-quality-judge.
  //    test.ts) must still be replaceable by a genuinely better candidate. ──
  const CAL1_CONTAMINATED =
    "Heim Sider Om oss Kontakt Sidersortar Alkoholfritt Draopar er ein liten sidergard i Hardanger.";
  const GOOD_LONGER_CANDIDATE =
    "Draopar Sideri held til i Hardanger og lagar sider av eigne eple frå gamle tre på garden, og tek imot gjester til smaking og omvising gjennom heile hausten.";
  assertTrue(CAL1_CONTAMINATED.length >= 80, "sanity: CAL1_CONTAMINATED clears the 80-char cheap-bar floor");
  assertTrue(GOOD_LONGER_CANDIDATE.length > CAL1_CONTAMINATED.length, "sanity: GOOD_LONGER_CANDIDATE is strictly longer than the contaminated current text");

  // Old (default/omitted third arg) behavior — UNCHANGED: a cheap-bar-passing
  // current value is never churned, regardless of the candidate.
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE),
    null,
    "gardssalgReplaceableFieldAction: third arg omitted (defaults false) → cheap-bar-passing current is still never churned (backward-compatible)",
  );
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE, false),
    null,
    "gardssalgReplaceableFieldAction: currentValueJudgedContaminated=false explicitly → cheap-bar-passing current still never churned",
  );

  // THE FIX: currentValueJudgedContaminated=true → the cheap-bar-passing but
  // contaminated current value IS replaced by the qualifying, longer
  // candidate (self-healing restored for already-landed contamination).
  assertEq(
    gardssalgReplaceableFieldAction(CAL1_CONTAMINATED, GOOD_LONGER_CANDIDATE, true),
    "replaced",
    "gardssalgReplaceableFieldAction: currentValueJudgedContaminated=true + qualifying longer candidate → 'replaced' (the self-healing path now works)",
  );

  // Control: a GENUINELY decent current value is still never churned even
  // when (hypothetically, by caller error) currentValueJudgedContaminated
  // were left false — proving the contamination flag is what drives the new
  // behavior, not some accidental loosening of the cheap-bar check itself.
  const GENUINELY_DECENT =
    "Gården vår har lange tradisjoner med sauehold og ullproduksjon, og vi selger garn og kjøtt direkte fra tunet.";
  assertEq(
    gardssalgReplaceableFieldAction(GENUINELY_DECENT, GOOD_LONGER_CANDIDATE, false),
    null,
    "gardssalgReplaceableFieldAction: genuinely decent current (not judged contaminated) → still never churned",
  );

  // Blank/thin-current and thin-candidate behavior is completely unaffected
  // by the new third param (it only matters when meetsAboutCheapBar(current)
  // is true) — regression-proofing the pre-existing contract.
  assertEq(
    gardssalgReplaceableFieldAction(null, GOOD_LONGER_CANDIDATE, true),
    "filled",
    "gardssalgReplaceableFieldAction: blank current + contaminated=true → still just 'filled' (blank-fill path unaffected by the new param)",
  );
  assertEq(
    gardssalgReplaceableFieldAction("Liten gård.", GOOD_LONGER_CANDIDATE, false),
    "replaced",
    "gardssalgReplaceableFieldAction: thin (cheap-bar-failing) current + contaminated=false → still 'replaced' via the pre-existing thin-content path, unaffected by the new param",
  );

  // ── gardssalgProductsEligible (dev-request 2026-07-18-gardssalg-
  //    profilkvalitet-foer-outreach, slice 5c) — fill-only gate for the
  //    "products" JSON-array column. ────────────────────────────────────────
  assertEq(gardssalgProductsEligible(null), true, "gardssalgProductsEligible: null → true (blank column, eligible)");
  assertEq(gardssalgProductsEligible(undefined), true, "gardssalgProductsEligible: undefined → true");
  assertEq(gardssalgProductsEligible(""), true, "gardssalgProductsEligible: empty string → true");
  assertEq(gardssalgProductsEligible("   "), true, "gardssalgProductsEligible: whitespace-only string → true");
  assertEq(gardssalgProductsEligible("[]"), true, "gardssalgProductsEligible: literal '[]' → true (empty array)");
  assertEq(gardssalgProductsEligible("  []  "), true, "gardssalgProductsEligible: '[]' with surrounding whitespace → true");
  assertEq(gardssalgProductsEligible(JSON.stringify([])), true, "gardssalgProductsEligible: JSON.stringify([]) round-trip → true");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider"])), false, "gardssalgProductsEligible: non-empty array (one product) → false, never overwritten");
  assertEq(gardssalgProductsEligible(JSON.stringify(["Eplesider", "Eplemost"])), false, "gardssalgProductsEligible: non-empty array (two products) → false");
  assertEq(gardssalgProductsEligible("not valid json"), false, "gardssalgProductsEligible: malformed non-JSON value → false, conservative (never silently overwritten)");
  assertEq(gardssalgProductsEligible('{"not":"an array"}'), false, "gardssalgProductsEligible: valid JSON but not an array (an object) → false");
  assertEq(gardssalgProductsEligible("[1,2,3]"), false, "gardssalgProductsEligible: valid non-empty JSON array (even of non-strings) → false, only an EMPTY array is eligible");

  // ── gardssalgWebsiteCandidateHosts v3 (Grep 4c: navnegjetting v3) — three
  //    new candidate sources appended AFTER the existing v1/v2 candidates:
  //    (a) first-word-only, (b) ø→oe-alone with å/æ left as raw diacritics,
  //    (c) one punycode/IDN guess. ────────────────────────────────────────
  {
    // (a) multi-word name → a first-word-only candidate appears (in addition
    // to the pre-existing all-tokens candidates).
    const torgersenHosts = gardssalgWebsiteCandidateHosts("Torgersen Gård");
    assertTrue(
      torgersenHosts.includes("torgersengard.no"),
      "gwch-1a: 'Torgersen Gård' still yields the pre-existing all-tokens v1 candidate torgersengard.no",
    );
    assertTrue(
      torgersenHosts.includes("torgersen.no"),
      "gwch-1b: 'Torgersen Gård' also yields the v3 first-word-only candidate torgersen.no",
    );

    // Single-token name: no first-word-only candidate distinct from the
    // existing all-tokens variant, so nothing new/duplicate is added for it.
    const singleTokenHosts = gardssalgWebsiteCandidateHosts("Einord");
    assertEq(
      singleTokenHosts.filter((h) => h === "einord.no").length,
      1,
      "gwch-1c: single-token name 'Einord' → einord.no appears exactly once (first-word-only variant skipped, not duplicated)",
    );

    // (b) ø→oe-alone variant differs from BOTH existing v1 (ø→o/å→a) and v2
    // (ø→oe/å→aa) outputs for a name containing å: å is dropped (not
    // translated), so the label is shorter than either existing variant.
    const blabaerHosts = gardssalgWebsiteCandidateHosts("Blåbær Gård");
    assertTrue(blabaerHosts.includes("blabaergard.no"), "gwch-2a: 'Blåbær Gård' still yields the v1 (å→a) candidate blabaergard.no");
    assertTrue(blabaerHosts.includes("blaabaergaard.no"), "gwch-2b: 'Blåbær Gård' still yields the v2 (å→aa) candidate blaabaergaard.no");
    assertTrue(
      blabaerHosts.includes("blbrgrd.no"),
      "gwch-2c: 'Blåbær Gård' yields the v3 ø→oe-alone candidate blbrgrd.no (å dropped, not translated) — distinct from both v1 and v2",
    );

    // (c) name WITH diacritics → a punycode/IDN candidate is present.
    const punycodeHosts = gardssalgWebsiteCandidateHosts("Torgersen Gård");
    assertTrue(
      punycodeHosts.some((h) => h.startsWith("xn--") && h.endsWith(".no")),
      "gwch-3a: 'Torgersen Gård' (has å) yields a punycode/IDN candidate (xn--...·.no)",
    );

    // name with NO diacritics → domainToASCII would just echo the ascii
    // label back, so no duplicate punycode candidate is added.
    const plainHosts = gardssalgWebsiteCandidateHosts("Ola Nordmann Gruppen AS");
    assertTrue(
      !plainHosts.some((h) => h.startsWith("xn--")),
      "gwch-3b: 'Ola Nordmann Gruppen AS' (no diacritics) → no punycode candidate (would just duplicate the plain label)",
    );

    // gwch-4: CHANGES-REQUESTED fix-up, bug 1 — a realistic 3+ token name
    // must NOT have its punycode candidate starved out by slice(0, 10).
    // Before the fix-up the punycode source was appended LAST (after
    // first-word and ø→oe-alone), so for 3-token names the first 10 slots
    // were already filled by v1/v2/first-word/ø-oe-alone before the
    // punycode push ever ran. It is now generated right after the base
    // v1/v2 sources instead.
    const blabaerBryggeriHosts = gardssalgWebsiteCandidateHosts("Blåbær Gård Bryggeri");
    assertTrue(
      blabaerBryggeriHosts.some((h) => h.startsWith("xn--") && h.endsWith(".no")),
      "gwch-4: 'Blåbær Gård Bryggeri' (3 tokens, has diacritics) still yields a punycode/IDN candidate — regression guard for the reorder fixing bug 1 (previously starved out by slice(0, 10))",
    );

    // gwch-5: CHANGES-REQUESTED fix-up, bugs 2/3 — the punycode source must
    // never leak a malformed "host" containing raw ASCII punctuation (bug 2)
    // or exceed the 63-octet DNS label limit once IDNA-encoded (bug 3). This
    // asserts the invariant for the WHOLE function's output, not just the
    // punycode source: nothing outside [a-z0-9.-] may ever appear anywhere
    // in the returned array. Also includes a literal "." in the raw name
    // (round-2 re-review bug): a stray "." in a raw token can make
    // domainToASCII split the result into MORE than the intended two labels
    // ("<label>.no"), and only the first label was ever validated — letting
    // a second, unvalidated label (with raw "&" etc.) leak through. Assert
    // both the whole-array [a-z0-9.-] invariant AND that no host has more
    // than 2 dots total (i.e. no spurious extra label ever appears) — the
    // dot-count check is the one that would actually have caught this exact
    // bug, since a malformed second label like "xn--nordmann&snngrd-tlb33a"
    // still only contains chars from [a-z0-9.-] plus "&", so it fails the
    // first invariant anyway, but a purely-legal-looking multi-label result
    // (e.g. from a name with "." but no other punctuation) would sail past
    // the [a-z0-9.-] check alone and only the dot-count check catches it.
    const punctuationNames = ["Nordmann & Sønn Gård", "O'Brien Gård", "Åse.Nordmann&Sønn Gård"];
    for (const name of punctuationNames) {
      const hosts = gardssalgWebsiteCandidateHosts(name);
      assertTrue(
        hosts.every((h) => /^[a-z0-9.-]+$/.test(h)),
        `gwch-5: '${name}' → no malformed host containing anything outside [a-z0-9.-] appears anywhere in the returned array (got: ${JSON.stringify(hosts)})`,
      );
      assertTrue(
        hosts.every((h) => (h.match(/\./g) || []).length <= 2),
        `gwch-5: '${name}' → no host has more than 2 dots total (no spurious extra DNS label from a stray "." in the raw name) (got: ${JSON.stringify(hosts)})`,
      );
    }

    // gwch-6: PR #682 round 4 (Daniel-authorized 4th iteration) — round 3's
    // finding: domainToASCII does NOT fail-closed on a WHATWG forbidden host
    // code point (/, \, ?, #, etc.) — it silently TRUNCATES the string at
    // that character instead of rejecting it. When a dot-like separator
    // precedes the truncating character, the truncated remainder can still
    // coincidentally split into exactly 2 labels, sailing past the old
    // `punycodeLabels.length === 2` check with a completely unvalidated
    // second "label". "Åse.Nordmann/Sønn Gård" is the exact repro from the
    // failure report: raw label "åse.nordmann/sønngård" → domainToASCII
    // truncates at "/" and yields "xn--se-xia.nordmann" — 2 labels, first
    // one a well-formed "xn--..." — which the old check let through even
    // though there is no ".no" (or any TLD) anywhere in the result. The new
    // anchored `/^xn--[a-z0-9-]+\.no$/i` check requires the literal ".no" to
    // be the entire remainder of the string, so no truncation can satisfy
    // it regardless of which forbidden character caused it.
    {
      const name = "Åse.Nordmann/Sønn Gård";
      const hosts = gardssalgWebsiteCandidateHosts(name);
      assertTrue(
        !hosts.some((h) => h.startsWith("xn--")),
        `gwch-6a: '${name}' (forbidden host code point "/" truncates domainToASCII's output before ".no") → the punycode candidate is correctly OMITTED, not just malformed (got: ${JSON.stringify(hosts)})`,
      );
      assertTrue(
        !hosts.includes("xn--se-xia.nordmann"),
        `gwch-6b: '${name}' → the specific round-3 repro malformed host "xn--se-xia.nordmann" (no .no TLD) never appears`,
      );
      // The other candidate sources (v1/v2, first-word-only, ø→oe-alone) for
      // this same input are unaffected by rejecting the punycode source.
      assertTrue(
        hosts.includes("asenordmannsonngard.no"),
        `gwch-6c: '${name}' → the v1 (å→a) all-tokens candidate asenordmannsonngard.no is still present`,
      );
      assertTrue(
        hosts.includes("aasenordmannsoenngaard.no"),
        `gwch-6d: '${name}' → the v2 (å→aa) all-tokens candidate aasenordmannsoenngaard.no is still present`,
      );
      assertTrue(
        hosts.includes("asenordmannsonn.no"),
        `gwch-6e: '${name}' → the v3 first-word-only candidate asenordmannsonn.no is still present`,
      );
      assertTrue(
        hosts.includes("senordmannsoenngrd.no"),
        `gwch-6f: '${name}' → the v3 ø→oe-alone candidate senordmannsoenngrd.no is still present`,
      );
    }

    // gwch-7: positive case for the round-4 anchored regex itself — a plain
    // diacritic name with no forbidden host code points must still produce a
    // valid, fully-anchored "xn--...·.no" candidate (not just "some xn--
    // candidate exists", gwch-3a already covers that loosely — this pins the
    // exact expected encoded value so the anchored regex isn't accidentally
    // over-strict and rejecting legitimate encodings).
    {
      const hosts = gardssalgWebsiteCandidateHosts("Torgersen Gård");
      assertTrue(
        hosts.includes("xn--torgersengrd-2cb.no"),
        `gwch-7: 'Torgersen Gård' → the exact punycode candidate xn--torgersengrd-2cb.no is present and matches /^xn--[a-z0-9-]+\\.no$/i in full (got: ${JSON.stringify(hosts)})`,
      );
    }
  }

  // ── scanGardssalgProviderRowForMojibake (dev-request 2026-07-21-
  //    opplevagent-norske-tegn-encoding, criterion 3) — DETECTION only, one
  //    match per flagged field, products checked element-by-element. ───────
  {
    const CLEAN_ABOUT = "Gården vår ligger idyllisk til ved fjorden, med egne grønnsaker og bær.";
    const CORRUPT_ABOUT = Buffer.from(CLEAN_ABOUT, "utf-8").toString("latin1"); // genuine Ã¦/Ã¸/Ã¥ mojibake

    assertEq(
      scanGardssalgProviderRowForMojibake({ about_text: null, visit_text: null, opening_hours_text: null, products: null }),
      [],
      "scan-1: an entirely blank row → no matches"
    );
    assertEq(
      scanGardssalgProviderRowForMojibake({ about_text: CLEAN_ABOUT, visit_text: CLEAN_ABOUT, opening_hours_text: null, products: null }),
      [],
      "scan-2: clean Norwegian text in every field → no matches"
    );
    {
      const r = scanGardssalgProviderRowForMojibake({ about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: null });
      assertEq(r.length, 1, "scan-3a: exactly one match for a single corrupted field");
      assertEq(r[0]?.field, "about_text", "scan-3b: match names the corrupted field");
      assertTrue(!!r[0]?.snippet && r[0].snippet.length > 0, "scan-3c: match carries a non-empty snippet");
    }
    {
      const r = scanGardssalgProviderRowForMojibake({
        about_text: CORRUPT_ABOUT, visit_text: CORRUPT_ABOUT, opening_hours_text: "Mandag-fredag 10-18",
        products: null,
      });
      assertEq(
        r.map((m) => m.field).sort(),
        ["about_text", "visit_text"],
        "scan-4: multiple corrupted fields on the same row are ALL reported, the clean field is not"
      );
    }
    // products: JSON-array-of-strings, one hit anywhere in the array flags
    // the whole column (a single field-level match, not one per element).
    {
      const r = scanGardssalgProviderRowForMojibake({
        about_text: null, visit_text: null, opening_hours_text: null,
        products: JSON.stringify(["Eplesider", CORRUPT_ABOUT, "Eplemost"]),
      });
      assertEq(r.length, 1, "scan-5a: a corrupted element anywhere in products[] → exactly one field-level match");
      assertEq(r[0]?.field, "products", "scan-5b: match names the products field");
    }
    assertEq(
      scanGardssalgProviderRowForMojibake({ about_text: null, visit_text: null, opening_hours_text: null, products: JSON.stringify(["Eplesider", "Eplemost"]) }),
      [],
      "scan-6: a clean products array → no matches"
    );
    // Malformed (non-JSON) products value — scanned as a raw string rather
    // than erroring or being silently skipped.
    assertEq(
      scanGardssalgProviderRowForMojibake({ about_text: null, visit_text: null, opening_hours_text: null, products: CORRUPT_ABOUT }).length,
      1,
      "scan-7: malformed non-JSON products value is still scanned (as a raw string), not silently skipped"
    );
    assertEq(
      scanGardssalgProviderRowForMojibake({ about_text: null, visit_text: null, opening_hours_text: null, products: "[]" }),
      [],
      "scan-8: empty products array literal → no matches"
    );
  }

  // ── berikelsestriage classification (dev-request 2026-07-29-blacklist-
  //    backfill-og-berikelsestriage, slice 2) — PURE, no DB. Covers the
  //    shared per-field homepage-provenance screen and the three-bucket
  //    classifier both selectProvidersForContentRefresh and
  //    GET /admin/providers/content-triage call. ──────────────────────────
  {
    // parseContentFieldEvidence: defensive parsing, never throws.
    assertEq(parseContentFieldEvidence(null), {}, "pce-1: null -> {}");
    assertEq(parseContentFieldEvidence(undefined), {}, "pce-2: undefined -> {}");
    assertEq(parseContentFieldEvidence("not json"), {}, "pce-3: malformed JSON -> {} (never throws)");
    assertEq(parseContentFieldEvidence("[]"), {}, "pce-4: a JSON array (wrong shape) -> {}");
    assertEq(
      parseContentFieldEvidence(JSON.stringify({ description: "https://x.no/y" })),
      { description: "https://x.no/y" },
      "pce-5: a valid JSON object round-trips"
    );

    // homepageRegistrableDomain
    assertEq(homepageRegistrableDomain(null), null, "hrd-1: null -> null");
    assertEq(homepageRegistrableDomain(""), null, "hrd-2: empty string -> null");
    assertEq(homepageRegistrableDomain("https://www.gardsbutikk.no/om-oss"), "gardsbutikk.no", "hrd-3: strips scheme/www/path");

    // isContentFieldHomepageSourced
    assertTrue(
      !isContentFieldHomepageSourced(null, "description", {}, "gard.no"),
      "icfhs-1: null value -> false (nothing to judge, not 'filled')"
    );
    assertTrue(
      !isContentFieldHomepageSourced("   ", "description", {}, "gard.no"),
      "icfhs-2: whitespace-only value -> false"
    );
    assertTrue(
      isContentFieldHomepageSourced("Ekte tekst", "description", {}, "gard.no"),
      "icfhs-3: non-blank value, NO evidence-map entry -> true (unknown provenance is KEPT, not invented as a gap)"
    );
    assertTrue(
      isContentFieldHomepageSourced("Ekte tekst", "description", { description: "https://www.gard.no/om" }, "gard.no"),
      "icfhs-4: evidence URL on the SAME registrable domain as the homepage -> true"
    );
    assertTrue(
      !isContentFieldHomepageSourced("Aggregert tekst", "description", { description: "https://visitnorway.com/x" }, "gard.no"),
      "icfhs-5: evidence URL on a DIFFERENT domain (aggregator) -> false — the core aggregator-leak case"
    );
    // A non-URL sentinel (e.g. HARVEST_PROVENANCE_SENTINEL, stamped when a
    // harvest row carries no evidence_url) is PRESENT evidence that does not
    // parse to the homepage's own host — a mismatch, not "unknown" — so it
    // must never be treated as homepage-sourced.
    assertTrue(
      !isContentFieldHomepageSourced("Aggregert tekst", "description", { description: "harvest:no-evidence-url" }, "gard.no"),
      "icfhs-6: the harvest-no-evidence-url sentinel is correctly treated as NOT the homepage (never accidentally matches)"
    );
    assertTrue(
      isContentFieldHomepageSourced("Ekte tekst", "description", { description: "not a url" }, null),
      "icfhs-7: no homepageDomain to compare against (provider has no usable hjemmeside) -> true (unknown, kept)"
    );

    // isExperienceContentGenuinelyThin
    assertTrue(
      !isExperienceContentGenuinelyThin(
        { content_source: "manual", verification_status: "pending_verify", description: null, category: null, content_field_evidence: null },
        "gard.no"
      ),
      "iecgt-1: LOCKED row (content_source='manual') -> never thin, even with blank content"
    );
    assertTrue(
      !isExperienceContentGenuinelyThin(
        { content_source: null, verification_status: "verified", description: null, category: null, content_field_evidence: null },
        "gard.no"
      ),
      "iecgt-2: LOCKED row (verification_status='verified') -> never thin"
    );
    assertTrue(
      isExperienceContentGenuinelyThin(
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null },
        "gard.no"
      ),
      "iecgt-3: unlocked, both fields blank -> thin"
    );
    assertTrue(
      !isExperienceContentGenuinelyThin(
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Ekte om-tekst.", category: "mat_drikke",
          content_field_evidence: JSON.stringify({ description: "https://www.gard.no/om", category: "https://www.gard.no/om" }),
        },
        "gard.no"
      ),
      "iecgt-4: unlocked, BOTH fields genuinely homepage-sourced -> NOT thin (done)"
    );
    // The core acceptance-criterion-3 case: non-blank content_source =
    // 'provider_site' (stamped unconditionally by applyExperienceContent
    // regardless of where the content really came from), but the recorded
    // per-field evidence is a THIRD-PARTY aggregator domain. Must still
    // count as thin so a real homepage value can eventually overwrite it.
    assertTrue(
      isExperienceContentGenuinelyThin(
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Aggregert beskrivelse.", category: "mat_drikke",
          content_field_evidence: JSON.stringify({ description: "https://visitnorway.com/found-here", category: "https://www.gard.no/om" }),
        },
        "gard.no"
      ),
      "iecgt-5: content_source='provider_site' + non-blank description, but description's OWN evidence is an aggregator domain -> STILL thin (the bug this fix closes)"
    );
    assertTrue(
      isExperienceContentGenuinelyThin(
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Ekte tekst.", category: null,
          content_field_evidence: JSON.stringify({ description: "https://www.gard.no/om" }),
        },
        "gard.no"
      ),
      "iecgt-6: description genuinely homepage-sourced but category still blank -> thin (ANY judged field counts)"
    );

    // classifyProviderContentBucket
    assertEq(
      classifyProviderContentBucket(null, []),
      "waiting",
      "cpcb-1: no hjemmeside, no experiences at all -> waiting"
    );
    assertEq(
      classifyProviderContentBucket("   ", [
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: null },
      ]),
      "waiting",
      "cpcb-2: blank hjemmeside, no experience carries an evidence_url fallback -> waiting"
    );
    assertEq(
      classifyProviderContentBucket(null, [
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: "https://kilde.example/x", canonical_id: null },
      ]),
      "enrichable",
      "cpcb-3: hjemmeside blank BUT an experience carries a usable evidence_url -> homepage derived from it, thin content -> enrichable (mirrors selectProvidersForContentRefresh's own COALESCE fallback)"
    );
    assertEq(
      classifyProviderContentBucket("https://gard.no", []),
      "done",
      "cpcb-4: usable hjemmeside but ZERO live experiences -> done (nothing to enrich, documented edge case)"
    );
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        { content_source: "manual", verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: null },
      ]),
      "done",
      "cpcb-5: usable hjemmeside, only a LOCKED experience with blank content -> done (permanently out of scope, documented edge case)"
    );
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: null },
      ]),
      "enrichable",
      "cpcb-6: usable hjemmeside, unlocked blank experience -> enrichable"
    );
    // The headline acceptance-criterion-3 scenario at the bucket level.
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Aggregert beskrivelse.", category: "mat_drikke",
          content_field_evidence: JSON.stringify({ description: "https://visitnorway.com/found-here", category: "https://www.gard.no/om" }),
          evidence_url: null, canonical_id: null,
        },
      ]),
      "enrichable",
      "cpcb-7: content_source='provider_site' non-blank description, but AGGREGATOR-sourced per content_field_evidence -> still enrichable, NOT done"
    );
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Ekte tekst.", category: "mat_drikke",
          content_field_evidence: JSON.stringify({ description: "https://www.gard.no/om", category: "https://www.gard.no/om" }),
          evidence_url: null, canonical_id: null,
        },
      ]),
      "done",
      "cpcb-8: both judged fields genuinely homepage-sourced -> done"
    );
    // Dedup-merged rows (canonical_id set) must never count either way.
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: "canon-1" },
      ]),
      "done",
      "cpcb-9: the ONLY experience is dedup-merged away (canonical_id set) -> excluded from 'live', so done (nothing left to check), not enrichable"
    );
    // Mixed multi-experience: ANY-thin-live-experience rule.
    assertEq(
      classifyProviderContentBucket("https://gard.no", [
        {
          content_source: "provider_site", verification_status: "pending_verify",
          description: "Ekte tekst.", category: "mat_drikke",
          content_field_evidence: JSON.stringify({ description: "https://www.gard.no/om", category: "https://www.gard.no/om" }),
          evidence_url: null, canonical_id: null,
        },
        { content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: null },
      ]),
      "enrichable",
      "cpcb-10: mixed — one experience fully done, another still blank -> enrichable (ANY-thin rule, matches selectProvidersForContentRefresh's own EXISTS semantics)"
    );
    // Idempotency: same inputs -> same bucket, always.
    const idemInput: Parameters<typeof classifyProviderContentBucket> = [
      "https://gard.no",
      [{ content_source: null, verification_status: "pending_verify", description: null, category: null, content_field_evidence: null, evidence_url: null, canonical_id: null }],
    ];
    assertEq(
      classifyProviderContentBucket(...idemInput),
      classifyProviderContentBucket(...idemInput),
      "cpcb-11: idempotent — calling twice with identical input yields identical bucket"
    );
  }

  // ── searchGardssalgProviders (dev-request 2026-07-20-gardssalg-mcp-
  //    discoverability) — backs the new discover_gardssalg MCP tool. Unlike
  //    the pure-function tests above, this needs a real (in-memory) DB, so
  //    it self-contains the same EXPERIENCES_DB_PATH=":memory:" + require-
  //    cache-reset + restore-in-finally convention used by the other
  //    gårdssalg route test files (e.g.
  //    opplevelser-gardssalg-provider-visibility.test.ts) — dynamically
  //    re-requiring db-factory/experience-store rather than relying on this
  //    file's own top-of-file static import, which resolved before any DB
  //    env override could take effect. ────────────────────────────────────
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, lat, lon, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @lat, @lon, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // gs-a: fully visible, booking live, geocoded near a Bergen origin.
      insertProvider.run({
        id: "gs-a", navn: "Sider A", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: null, lat: 60.39, lon: 5.32, slug: "sider-a",
      });
      // gs-b: fully visible, booking NOT live, different fylke/kommune/type.
      insertProvider.run({
        id: "gs-b", navn: "Bryggeri B", fylke: "Oslo", kommune: "Oslo", producer_type: "bryggeri",
        booking_live: 0, catalog_hidden: null, lat: 59.91, lon: 10.75, slug: "bryggeri-b",
      });
      // gs-c: catalog_hidden=1 — matches EVERY filter below (same fylke/
      // kommune/producer_type as gs-a, booking_live=1, geocoded right next
      // to gs-a) yet must NEVER appear in any result — the load-bearing
      // security/data-leak test.
      insertProvider.run({
        id: "gs-c", navn: "Skjult C", fylke: "Vestland", kommune: "Bergen", producer_type: "cideri",
        booking_live: 1, catalog_hidden: 1, lat: 60.40, lon: 5.33, slug: "skjult-c",
      });
      // gs-d: visible, but never geocoded (lat/lon NULL) — must be excluded
      // from any geo-filtered search, never assigned a fabricated distance.
      insertProvider.run({
        id: "gs-d", navn: "Ugeokodet D", fylke: "Vestland", kommune: "Bergen", producer_type: "vingård",
        booking_live: null, catalog_hidden: null, lat: null, lon: null, slug: "ugeokodet-d",
      });
      // 55 extra Nordland/seltzeri rows to prove the limit clamp actually
      // bites (needs >50 candidates to observe truncation at 50). A distinct
      // producer_type ('seltzeri') keeps this fixture set out of the
      // producer_type='bryggeri' assertion below.
      for (let i = 0; i < 55; i++) {
        insertProvider.run({
          id: `gs-limit-${i}`, navn: `Limitgård ${String(i).padStart(2, "0")}`, fylke: "Nordland", kommune: "Bodø",
          producer_type: "seltzeri", booking_live: 0, catalog_hidden: null, lat: null, lon: null, slug: `limitgard-${i}`,
        });
      }

      const names = (rows: Array<{ navn: string }>) => rows.map((r) => r.navn).sort();

      // ── fylke/kommune/producer_type exact-match filters ─────────────────
      assertEq(
        names(expStore.searchGardssalgProviders({ fylke: "Vestland" })),
        ["Sider A", "Ugeokodet D"],
        "sgp-1: fylke='Vestland' returns gs-a + gs-d, never the hidden gs-c, never Oslo's gs-b"
      );
      assertEq(
        names(expStore.searchGardssalgProviders({ kommune: "Bergen" })),
        ["Sider A", "Ugeokodet D"],
        "sgp-2: kommune='Bergen' returns gs-a + gs-d, never the hidden gs-c"
      );
      assertEq(
        names(expStore.searchGardssalgProviders({ producer_type: "bryggeri" }, 100)),
        ["Bryggeri B"],
        "sgp-3: producer_type='bryggeri' returns only the bryggeri row (gs-b), never the cideri/vingård/seltzeri fixtures"
      );

      // ── catalog_hidden=1 NEVER returned, under ANY filter combination ────
      const allNoFilter = expStore.searchGardssalgProviders({}, 100);
      assertTrue(!allNoFilter.some((r) => r.navn === "Skjult C"), "sgp-4: no filter at all — hidden row absent");
      const exactMatchFilter = expStore.searchGardssalgProviders(
        { fylke: "Vestland", kommune: "Bergen", producer_type: "cideri", booking_live: true }, 100
      );
      assertTrue(!exactMatchFilter.some((r) => r.navn === "Skjult C"),
        "sgp-5: filter combination matching every one of the hidden row's own columns still excludes it");
      assertTrue(exactMatchFilter.some((r) => r.navn === "Sider A"),
        "sgp-5b: sanity check — that same filter DOES return the real (non-hidden) matching row");

      // ── booking_live:true → only booking_live=1 rows ─────────────────────
      const liveOnly = expStore.searchGardssalgProviders({ booking_live: true }, 100);
      assertEq(names(liveOnly), ["Sider A"], "sgp-6: booking_live:true returns only gs-a (booking_live=1), not gs-b (0), gs-d (NULL), or the hidden gs-c (1 but catalog_hidden=1)");

      // ── geo near-me: correct distance_km for a geocoded row, exclusion of
      //    a non-geocoded row, exclusion of the hidden row even though it is
      //    geocoded right next to the origin. ──────────────────────────────
      const geoResults = expStore.searchGardssalgProviders({ lat: 60.39, lng: 5.32, radius_km: 50 }, 100);
      assertEq(names(geoResults), ["Sider A"], "sgp-7: geo search near Bergen returns only gs-a — gs-d (no lat/lon) and gs-c (hidden) excluded");
      const gsAGeo = geoResults.find((r) => r.navn === "Sider A");
      assertTrue(!!gsAGeo && typeof gsAGeo.distance_km === "number" && gsAGeo.distance_km >= 0 && gsAGeo.distance_km < 1,
        "sgp-8: gs-a queried from its own coordinates gets a real, near-zero distance_km");
      assertTrue(!geoResults.some((r) => r.navn === "Ugeokodet D"), "sgp-9: never-geocoded row excluded from a geo-filtered search (no fabricated distance)");

      // ── limit: default 20, clamp to [1,50] ───────────────────────────────
      assertEq(expStore.searchGardssalgProviders({}).length, 20, "sgp-10: default limit is 20");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, 1000).length, 50, "sgp-11: limit above 50 clamps down to 50");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, 0).length, 1, "sgp-12: limit of 0 clamps up to 1");
      assertEq(expStore.searchGardssalgProviders({ fylke: "Nordland" }, -5).length, 1, "sgp-13: a negative limit clamps up to 1");
    } catch (err: any) {
      failed++;
      failures.push("searchGardssalgProviders: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  // ── getGardssalgProviderBySlug (2026-08-17 P0 consent-bug fix) — a
  //    catalog_hidden=1 row must be UNREACHABLE by slug, same as it's
  //    already unreachable from the grid/count/search (see
  //    searchGardssalgProviders' sgp-4/sgp-5 above). Own isolated in-memory
  //    DB block, same convention as the searchGardssalgProviders block
  //    above. ───────────────────────────────────────────────────────────────
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, producer_type, catalog_hidden, slug,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @producer_type, @catalog_hidden, @slug,
            'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // gbs-visible: catalog_hidden NULL — the ordinary case, unaffected.
      insertProvider.run({ id: "gbs-visible", navn: "Synlig Gard", producer_type: "cideri", catalog_hidden: null, slug: "synlig-gard" });
      // gbs-zero: catalog_hidden=0 explicitly (not just NULL) — also unaffected.
      insertProvider.run({ id: "gbs-zero", navn: "Null Gard", producer_type: "cideri", catalog_hidden: 0, slug: "null-gard" });
      // gbs-hidden: catalog_hidden=1 — the real "Fjording" scenario this fix
      // closes: a producer who asked to be delisted must 404 by slug.
      insertProvider.run({ id: "gbs-hidden", navn: "Skjult Gard", producer_type: "cideri", catalog_hidden: 1, slug: "skjult-gard" });

      const visible = expStore.getGardssalgProviderBySlug("synlig-gard");
      assertTrue(!!visible && visible.id === "gbs-visible", "gbs-1: catalog_hidden=NULL row IS returned by slug");

      const zeroHidden = expStore.getGardssalgProviderBySlug("null-gard");
      assertTrue(!!zeroHidden && zeroHidden.id === "gbs-zero", "gbs-2: catalog_hidden=0 (explicit) row IS returned by slug");

      const hidden = expStore.getGardssalgProviderBySlug("skjult-gard");
      assertEq(hidden, null, "gbs-3: catalog_hidden=1 row returns null by slug (the P0 fix — was previously returned)");

      assertEq(expStore.getGardssalgProviderBySlug("does-not-exist"), null, "gbs-4: unknown slug still returns null (unrelated to this fix, sanity check)");
      assertEq(expStore.getGardssalgProviderBySlug(""), null, "gbs-5: empty slug still short-circuits to null without hitting the DB");
    } catch (err: any) {
      failed++;
      failures.push("getGardssalgProviderBySlug: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  // ── selectGardssalgMojibakeCandidates + applyGardssalgProviderContent's
  //    `forceFields` bypass (dev-request 2026-07-21-opplevagent-norske-tegn-
  //    encoding, criterion 3) — own isolated in-memory DB block, same
  //    convention as the searchGardssalgProviders block above. ─────────────
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const CLEAN_ABOUT = "Gården vår ligger idyllisk til ved fjorden, med egne grønnsaker og bær som selges hver helg.";
      const CORRUPT_ABOUT = Buffer.from(CLEAN_ABOUT, "utf-8").toString("latin1");
      const CLEAN_VISIT = "Kom innom for omvisning og smaking i gårdsbutikken vår hver lørdag om sommeren.";
      const CORRUPT_VISIT = Buffer.from(CLEAN_VISIT, "utf-8").toString("latin1");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, content_source, about_text, visit_text, opening_hours_text, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @content_source, @about_text, @visit_text, @opening_hours_text, @products,
            'cideri', 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // mb-a: corrupted about_text, unlocked, has hjemmeside → a candidate.
      insertProvider.run({
        id: "mb-a", navn: "Mojibake Gard A", hjemmeside: "https://mb-a.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });
      // mb-b: clean content throughout → never a candidate.
      insertProvider.run({
        id: "mb-b", navn: "Ren Gard B", hjemmeside: "https://mb-b.example.no",
        content_source: null, about_text: CLEAN_ABOUT, visit_text: CLEAN_VISIT, opening_hours_text: null, products: "[]",
      });
      // mb-c: corrupted about_text but LOCKED (content_source='manual') →
      // never a candidate, even though the text itself matches.
      insertProvider.run({
        id: "mb-c", navn: "Last Gard C", hjemmeside: "https://mb-c.example.no",
        content_source: "manual", about_text: CORRUPT_ABOUT, visit_text: null, opening_hours_text: null, products: "[]",
      });

      // ── selectGardssalgMojibakeCandidates ────────────────────────────────
      const candidates = expStore.selectGardssalgMojibakeCandidates(25);
      const candidateIds = candidates.map((c) => c.id).sort();
      assertTrue(candidateIds.includes("mb-a"), "mb-1a: corrupted+unlocked provider IS a candidate");
      assertTrue(!candidateIds.includes("mb-b"), "mb-1b: fully clean provider is NOT a candidate");
      assertTrue(!candidateIds.includes("mb-c"), "mb-1c: corrupted-but-LOCKED provider is NOT a candidate (never even scanned into the result)");
      const mbACandidate = candidates.find((c) => c.id === "mb-a");
      assertTrue(!!mbACandidate && mbACandidate.fields.some((f) => f.field === "about_text"), "mb-1d: mb-a's candidate entry names about_text as the corrupted field");

      // ── applyGardssalgProviderContent: forceFields bypasses
      //    gardssalgReplaceableFieldAction's "candidate must be strictly
      //    longer" veto — the exact case mojibake repair needs, since a
      //    corrected value is typically SHORTER than its corrupted original. ──
      assertTrue(CORRUPT_ABOUT.length > CLEAN_ABOUT.length, "sanity: the corrupted fixture is LONGER than its clean repair (the scenario forceFields exists for)");

      // Without forceFields: gardssalgReplaceableFieldAction refuses to
      // replace mb-a's about_text (CORRUPT_ABOUT passes the cheap bar — it's
      // >=80 chars, has no U+FFFD, and is otherwise well-formed prose — and
      // CLEAN_ABOUT is SHORTER, so the "candidate must be strictly longer"
      // rule blocks the write even though CLEAN_ABOUT is the correct value).
      const writtenNoForce = expStore.applyGardssalgProviderContent(
        "mb-a", { about_text: CLEAN_ABOUT }, "https://mb-a.example.no"
      );
      assertEq(writtenNoForce, [], "mb-2a: WITHOUT forceFields, the shorter (but correct) repair is refused — confirms the gap forceFields closes");
      const rowAfterNoForce = db.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-a") as { about_text: string };
      assertEq(rowAfterNoForce.about_text, CORRUPT_ABOUT, "mb-2b: about_text is unchanged (still corrupted) after the refused write");

      // WITH forceFields: the same shorter, correct candidate IS written.
      const writtenForced = expStore.applyGardssalgProviderContent(
        "mb-a", { about_text: CLEAN_ABOUT }, "https://mb-a.example.no",
        undefined, undefined, undefined, ["about_text"]
      );
      assertEq(writtenForced, ["about_text"], "mb-3a: WITH forceFields, the shorter correct candidate IS written");
      const rowAfterForce = db.prepare(
        "SELECT about_text, content_source, content_evidence_url, field_provenance FROM experience_providers WHERE id = ?"
      ).get("mb-a") as { about_text: string; content_source: string; content_evidence_url: string; field_provenance: string };
      assertEq(rowAfterForce.about_text, CLEAN_ABOUT, "mb-3b: about_text is now the correctly-decoded repair");
      assertEq(rowAfterForce.content_source, "provider_site", "mb-3c: content_source stamped provider_site, same as any other gårdssalg write");
      assertEq(rowAfterForce.content_evidence_url, "https://mb-a.example.no", "mb-3d: content_evidence_url stamped to the evidence URL passed in");
      const provenance = JSON.parse(rowAfterForce.field_provenance);
      assertTrue(!!provenance.about_text?.source_url, "mb-3e: field_provenance.about_text is stamped — the forced write goes through the SAME provenance machinery as any other write");

      const auditRows = db.prepare(
        "SELECT * FROM gardssalg_content_audit WHERE provider_id = ? AND field_name = 'about_text' ORDER BY rowid ASC"
      ).all("mb-a") as Array<{ old_value: string | null; new_value: string | null }>;
      assertTrue(auditRows.length > 0, "mb-3f: a gardssalg_content_audit row exists for the forced write (auditable/reversible, per the dev-request's own requirement)");
      const lastAudit = auditRows[auditRows.length - 1]!;
      assertEq(lastAudit.old_value, CORRUPT_ABOUT, "mb-3g: audit old_value is the pre-write (corrupted) text");
      assertEq(lastAudit.new_value, CLEAN_ABOUT, "mb-3h: audit new_value is the corrected text");

      // forceFields still respects the row-lock guard: a locked provider's
      // content_source is never touched, forced or not.
      const writtenLocked = expStore.applyGardssalgProviderContent(
        "mb-c", { about_text: CLEAN_ABOUT }, "https://mb-c.example.no",
        undefined, undefined, undefined, ["about_text"]
      );
      assertEq(writtenLocked, [], "mb-4a: forceFields does NOT bypass the lock guard — a manual/claim-locked provider is still never written");
      const rowLocked = db.prepare("SELECT about_text FROM experience_providers WHERE id = ?").get("mb-c") as { about_text: string };
      assertEq(rowLocked.about_text, CORRUPT_ABOUT, "mb-4b: locked provider's corrupted about_text is completely untouched");

      // forceFields is per-field: naming "about_text" must not also force an
      // untouched visit_text write when no visit_text candidate is passed at
      // all (candidate.visit_text undefined → falsy → no write, regardless
      // of forceFields' contents).
      insertProvider.run({
        id: "mb-e", navn: "Force Scope Gard E", hjemmeside: "https://mb-e.example.no",
        content_source: null, about_text: CORRUPT_ABOUT, visit_text: CORRUPT_VISIT, opening_hours_text: null, products: "[]",
      });
      const writtenScoped = expStore.applyGardssalgProviderContent(
        "mb-e", { about_text: CLEAN_ABOUT }, "https://mb-e.example.no",
        undefined, undefined, undefined, ["about_text", "visit_text"]
      );
      assertEq(writtenScoped, ["about_text"], "mb-5: forceFields names visit_text too, but with no visit_text candidate value passed, only about_text is actually written");
      const rowScoped = db.prepare("SELECT visit_text FROM experience_providers WHERE id = ?").get("mb-e") as { visit_text: string };
      assertEq(rowScoped.visit_text, CORRUPT_VISIT, "mb-5b: visit_text (no candidate passed for it) is completely untouched");
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-mojibake-backfill (experience-store): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  // ── applyGardssalgFieldConcordanceClear (dev-request 2026-08-09-epost-
  //    korrigering-paa-plass) — own isolated in-memory DB block, same
  //    convention as the mojibake block above. This function is the narrow,
  //    epost-only lever that nulls a stored epost once a CALLER has already
  //    proven genuine absence on a fresh homepage fetch — this unit test
  //    exercises only the store function's own guard chain/write recipe, not
  //    the fetch/verdict judgment (that's the route's job, tested at the
  //    route level in opplevelser-gardssalg-field-concordance-clear.test.ts). ──
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, epost, content_source, field_provenance,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @epost, @content_source, @field_provenance,
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // gfc-owner-locked: content_source='manual' -> always owner_locked for
      // epost (epost is never in GARDSSALG_OWNER_LOCK_ELIGIBLE_FIELDS).
      insertProvider.run({
        id: "gfc-owner-locked", navn: "Gard Owner Locked",
        hjemmeside: "https://gfc-owner-locked.example.no", epost: "gammel@ownerlocked.no",
        content_source: "manual", field_provenance: null,
      });

      // gfc-vetoed: a human rolled epost back (latest gardssalg_content_audit
      // row is the rollback marker) -> rollback_vetoed.
      insertProvider.run({
        id: "gfc-vetoed", navn: "Gard Vetoed",
        hjemmeside: "https://gfc-vetoed.example.no", epost: "fortsatt@vetoed.no",
        content_source: null, field_provenance: null,
      });
      db.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES ('gfc-vetoed-write', 'gfc-vetoed', 'epost', NULL, 'fortsatt@vetoed.no', 'https://gfc-vetoed.example.no', NULL, 'system', datetime('now'))`
      ).run();
      db.prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at)
         VALUES ('gfc-vetoed-rollback', 'gfc-vetoed', 'epost', 'fortsatt@vetoed.no', NULL, 'internal://rollback', NULL, 'system', datetime('now'))`
      ).run();
      // The rollback set epost back to NULL — reflect that on the row itself
      // so the fixture is internally consistent (the veto guard fires
      // regardless, but a stale row value would be a confusing fixture).
      db.prepare(`UPDATE experience_providers SET epost = NULL WHERE id = 'gfc-vetoed'`).run();

      // gfc-already-blank: stored epost is already NULL.
      insertProvider.run({
        id: "gfc-already-blank", navn: "Gard Already Blank",
        hjemmeside: "https://gfc-already-blank.example.no", epost: null,
        content_source: null, field_provenance: null,
      });

      // gfc-happy: non-blank epost, no lock/veto -> the clear should succeed.
      insertProvider.run({
        id: "gfc-happy", navn: "Gard Happy",
        hjemmeside: "https://gfc-happy.example.no", epost: "gammel@happy.no",
        content_source: null,
        field_provenance: JSON.stringify({ hjemmeside_verification: { verified: true } }),
      });

      const dumpProviders = () =>
        (db.prepare(`SELECT * FROM experience_providers ORDER BY id`).all() as unknown[]).map((r) => JSON.stringify(r));
      const dumpAudit = () =>
        (db.prepare(`SELECT * FROM gardssalg_content_audit ORDER BY rowid`).all() as unknown[]).map((r) => JSON.stringify(r));

      // ── owner_locked ──────────────────────────────────────────────────
      const beforeLocked = dumpProviders();
      const lockedResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-owner-locked", "https://gfc-owner-locked.example.no"
      );
      assertEq(
        lockedResult,
        { provider_id: "gfc-owner-locked", field_name: "epost", written: false, reason: "owner_locked" },
        "gfc-clear-1a: manual content_source -> owner_locked, zero writes",
      );
      assertEq(dumpProviders(), beforeLocked, "gfc-clear-1b: experience_providers byte-identical after owner_locked rejection");

      // ── rollback_vetoed ───────────────────────────────────────────────
      const beforeVetoed = dumpProviders();
      const beforeVetoedAudit = dumpAudit();
      const vetoedResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-vetoed", "https://gfc-vetoed.example.no"
      );
      assertEq(
        vetoedResult,
        { provider_id: "gfc-vetoed", field_name: "epost", written: false, reason: "rollback_vetoed" },
        "gfc-clear-2a: latest audit row is a rollback -> rollback_vetoed, zero writes",
      );
      assertEq(dumpProviders(), beforeVetoed, "gfc-clear-2b: experience_providers byte-identical after rollback_vetoed rejection");
      assertEq(dumpAudit(), beforeVetoedAudit, "gfc-clear-2c: no new gardssalg_content_audit row inserted");

      // ── already_blank ─────────────────────────────────────────────────
      const beforeBlank = dumpProviders();
      const blankResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-already-blank", "https://gfc-already-blank.example.no"
      );
      assertEq(
        blankResult,
        { provider_id: "gfc-already-blank", field_name: "epost", written: false, reason: "already_blank" },
        "gfc-clear-3a: already-blank stored epost -> already_blank, zero writes",
      );
      assertEq(dumpProviders(), beforeBlank, "gfc-clear-3b: experience_providers byte-identical after already_blank rejection");
      const blankRow = db.prepare(`SELECT field_provenance FROM experience_providers WHERE id = 'gfc-already-blank'`).get() as { field_provenance: string | null };
      assertEq(blankRow.field_provenance, null, "gfc-clear-3c: field_provenance untouched (still NULL) on the already_blank rejection");

      // ── not_found ─────────────────────────────────────────────────────
      const notFoundResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-does-not-exist", "https://nowhere.example.no"
      );
      assertEq(
        notFoundResult,
        { provider_id: "gfc-does-not-exist", field_name: "epost", written: false, reason: "not_found" },
        "gfc-clear-4a: unknown provider_id -> not_found, zero writes",
      );

      // ── happy path ────────────────────────────────────────────────────
      const beforeHappyAudit = dumpAudit();
      const happyResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-happy", "https://gfc-happy.example.no", "batch-gfc-clear-1"
      );
      assertEq(
        happyResult,
        { provider_id: "gfc-happy", field_name: "epost", written: true },
        "gfc-clear-5a: non-blank epost, no lock/veto -> written:true, no reason",
      );
      const happyRow = db.prepare(`SELECT epost, field_provenance FROM experience_providers WHERE id = 'gfc-happy'`).get() as { epost: string | null; field_provenance: string };
      assertEq(happyRow.epost, null, "gfc-clear-5b: epost column is now NULL");
      const happyProvenance = JSON.parse(happyRow.field_provenance);
      assertTrue(!!happyProvenance.epost?.fetched_at, "gfc-clear-5c: field_provenance.epost is stamped");
      assertEq(happyProvenance.epost.source_url, "https://gfc-happy.example.no", "gfc-clear-5d: field_provenance.epost.source_url is the evidence URL passed in");
      assertTrue(!!happyProvenance.hjemmeside_verification?.verified, "gfc-clear-5e: pre-existing field_provenance.hjemmeside_verification key is NOT clobbered");

      const afterHappyAudit = dumpAudit();
      assertEq(afterHappyAudit.length, beforeHappyAudit.length + 1, "gfc-clear-5f: exactly one new gardssalg_content_audit row");
      const happyAuditRow = db
        .prepare(`SELECT * FROM gardssalg_content_audit WHERE provider_id = 'gfc-happy' AND field_name = 'epost' ORDER BY rowid DESC LIMIT 1`)
        .get() as { old_value: string | null; new_value: string | null; source_url: string; batch_id: string | null };
      assertEq(happyAuditRow.old_value, "gammel@happy.no", "gfc-clear-5g: audit old_value is the true pre-write epost");
      assertEq(happyAuditRow.new_value, null, "gfc-clear-5h: audit new_value is NULL");
      assertEq(happyAuditRow.source_url, "https://gfc-happy.example.no", "gfc-clear-5i: audit source_url is the evidence URL");
      assertEq(happyAuditRow.batch_id, "batch-gfc-clear-1", "gfc-clear-5j: audit batch_id carried through");

      // Idempotency: clearing the same (now-blank) provider a second time
      // never double-clears or errors ambiguously — it's just already_blank.
      const secondClearResult = expStore.applyGardssalgFieldConcordanceClear(
        "gfc-happy", "https://gfc-happy.example.no"
      );
      assertEq(
        secondClearResult,
        { provider_id: "gfc-happy", field_name: "epost", written: false, reason: "already_blank" },
        "gfc-clear-6: a second clear of the same (now-blank) provider -> already_blank, never a double-clear/ambiguous error",
      );
    } catch (err: any) {
      failed++;
      failures.push("gardssalg-field-concordance-clear (experience-store): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  // ── getPublishedExperienceById() + stampExperienceAdmissionVerdict() ─────
  // (dev-request 2026-06-23-experiences-richer-profiles, faithfulness-inflow
  // slice, 2026-08-25). The publish-gated by-id read must apply the exact
  // same PUBLISH_GATE_SQL as /discover — a quarantined (needs_review),
  // dedup-merged-away (canonical_id set), or inactive-provider row is
  // indistinguishable from a missing id — while the RAW getExperienceById()
  // (internal/admin) still returns every one of them. Same in-memory-DB
  // scaffold as the gfc-clear block above.
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const activeProviderId = expStore.createProvider({
        navn: "Publisert Gard AS", kommune: "Tromsø", fylke: "Troms",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const publishedId = expStore.createExperience({
        title: "Publisert hvalsafari", provider_id: activeProviderId,
        kommune: "Tromsø", fylke: "Troms",
        verification_status: "verified", confidence: "high",
      } as any);
      const quarantinedId = expStore.createExperience({
        title: "Karantene nordlystur", provider_id: activeProviderId,
        kommune: "Tromsø", fylke: "Troms",
        verification_status: "needs_review", confidence: "high",
      } as any);
      const mergedId = expStore.createExperience({
        title: "Duplikat fjordcruise", provider_id: activeProviderId,
        kommune: "Tromsø", fylke: "Troms",
        verification_status: "verified", confidence: "high",
      } as any);
      db.prepare("UPDATE experiences SET canonical_id = ? WHERE id = ?").run(publishedId, mergedId);

      const inactiveProviderId = expStore.createProvider({
        navn: "Inaktiv Gard AS", kommune: "Bergen", fylke: "Vestland",
        brreg_verified: 1, brreg_active: 0, verification_status: "verified",
      });
      const inactiveProvExpId = expStore.createExperience({
        title: "Brevandring hos inaktiv", provider_id: inactiveProviderId,
        kommune: "Bergen", fylke: "Vestland",
        verification_status: "verified", confidence: "high",
      } as any);

      // ── published row passes the gate, same shape as the raw read ──────
      const published = expStore.getPublishedExperienceById(publishedId);
      assertTrue(!!published, "pub-id-1a: a verified/active/canonical row IS returned by the gated read");
      assertEq(published?.id, publishedId, "pub-id-1b: ...and it is the requested row");
      assertTrue(published !== null && "phone" in (published as object), "pub-id-1c: gated read keeps the hydrated shape (phone key present, like getExperienceById)");

      // ── every gate-failing shape -> null, exactly like a missing id ────
      assertEq(expStore.getPublishedExperienceById(quarantinedId), null, "pub-id-2: a needs_review (quarantined) row is NOT served by id");
      assertEq(expStore.getPublishedExperienceById(mergedId), null, "pub-id-3: a dedup-merged-away row (canonical_id set) is NOT served by id");
      assertEq(expStore.getPublishedExperienceById(inactiveProvExpId), null, "pub-id-4: a row whose provider is brreg_active=0 is NOT served by id");
      assertEq(expStore.getPublishedExperienceById("00000000-0000-0000-0000-000000000000"), null, "pub-id-5: a missing id is null — indistinguishable from the gated cases above");

      // ── the RAW read (internal/admin) still returns them all ───────────
      assertTrue(!!expStore.getExperienceById(quarantinedId), "pub-id-6a: raw getExperienceById still returns the quarantined row (admin/diagnostic path unchanged)");
      assertTrue(!!expStore.getExperienceById(mergedId), "pub-id-6b: raw getExperienceById still returns the merged-away row");
      assertTrue(!!expStore.getExperienceById(inactiveProvExpId), "pub-id-6c: raw getExperienceById still returns the inactive-provider row");

      // ── admission-verdict stamp roundtrip ──────────────────────────────
      expStore.stampExperienceAdmissionVerdict(quarantinedId, "mismatch: siden handler om noe helt annet");
      const stamped = db
        .prepare("SELECT admission_verdict, admission_checked_at FROM experiences WHERE id = ?")
        .get(quarantinedId) as { admission_verdict: string | null; admission_checked_at: string | null };
      assertEq(stamped.admission_verdict, "mismatch: siden handler om noe helt annet", "pub-id-7a: stampExperienceAdmissionVerdict writes the inspectable verdict text");
      assertTrue(!!stamped.admission_checked_at, "pub-id-7b: ...and stamps admission_checked_at");
      const unstamped = db
        .prepare("SELECT admission_verdict, admission_checked_at FROM experiences WHERE id = ?")
        .get(publishedId) as { admission_verdict: string | null; admission_checked_at: string | null };
      assertEq(unstamped, { admission_verdict: null, admission_checked_at: null }, "pub-id-7c: rows the gate never saw keep both columns NULL");
    } catch (err: any) {
      failed++;
      failures.push("published-experience-by-id (experience-store): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  // ── PUBLISH_GATE_SQL: provider catalog_hidden=1 hides its experiences ────
  // (dev-request 2026-09-02-experiences-skrivepause-catalog-hidden-og-
  // rapportspraak, del 2). A provider flagged catalog_hidden=1 carrying a
  // verified/high experience must be invisible on EVERY publish-gated
  // surface — /discover (which now reuses PUBLISH_GATE_SQL instead of an
  // inline copy), the by-slug and by-id detail reads, the sitemap slug list
  // and the FAQ/provider counts — while a visible provider (catalog_hidden
  // NULL or 0) is unaffected. Same in-memory-DB scaffold as the block above.
  {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const experienceStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, experienceStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      // Visible provider — catalog_hidden left at its NULL default.
      const visibleProviderId = expStore.createProvider({
        navn: "Synlig Gard AS", kommune: "Tromsø", fylke: "Troms",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      // Visible provider — catalog_hidden EXPLICITLY 0 (the "!= 1" half of the clause).
      const visibleZeroProviderId = expStore.createProvider({
        navn: "Synlig Null Gard AS", kommune: "Tromsø", fylke: "Troms",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET catalog_hidden = 0 WHERE id = ?").run(visibleZeroProviderId);
      // Hidden provider — identical in every other respect (brreg_active=1,
      // verified) so catalog_hidden is the ONLY thing separating it.
      const hiddenProviderId = expStore.createProvider({
        navn: "Skjult Gard AS", kommune: "Tromsø", fylke: "Troms",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET catalog_hidden = 1 WHERE id = ?").run(hiddenProviderId);

      const visibleExpId = expStore.createExperience({
        title: "Synlig hvalsafari", slug: "synlig-hvalsafari", provider_id: visibleProviderId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms", category: "safari",
        verification_status: "verified", confidence: "high",
      } as any);
      const visibleZeroExpId = expStore.createExperience({
        title: "Synlig null nordlystur", slug: "synlig-null-nordlystur", provider_id: visibleZeroProviderId,
        provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms", category: "safari",
        verification_status: "verified", confidence: "high",
      } as any);
      const hiddenExpId = expStore.createExperience({
        title: "Skjult fjordcruise", slug: "skjult-fjordcruise", provider_id: hiddenProviderId,
        provider_match_status: "matched", kommune: "Bergen", fylke: "Vestland", category: "safari",
        verification_status: "verified", confidence: "high",
      } as any);

      // Sanity: the hidden row passes every OTHER gate clause — only
      // catalog_hidden keeps it out. Proven via the RAW read.
      const rawHidden = expStore.getExperienceById(hiddenExpId);
      assertEq(rawHidden?.verification_status, "verified", "ch-0a: hidden fixture is verified (raw read)");
      assertEq(rawHidden?.confidence, "high", "ch-0b: hidden fixture is confidence=high (raw read)");

      // (1) discoverExperiences: only the visible rows.
      const discovered = expStore.discoverExperiences({}, 50).map((r) => r.id).sort();
      assertEq(discovered, [visibleExpId, visibleZeroExpId].sort(), "ch-1a: discoverExperiences returns ONLY the visible providers' rows");
      assertTrue(!discovered.includes(hiddenExpId), "ch-1b: ...and never the catalog_hidden=1 provider's row");
      // discoverExperiencesRelaxed inherits the same gate automatically.
      const relaxed = expStore.discoverExperiencesRelaxed({ fylke: "Vestland" }, 50);
      assertTrue(!relaxed.results.some((r) => r.id === hiddenExpId), "ch-1c: discoverExperiencesRelaxed never surfaces the hidden row either, even when relaxing towards its fylke");

      // (2) by-slug + by-id published getters: null for the hidden one.
      assertEq(expStore.getPublishedExperienceBySlug("skjult-fjordcruise"), null, "ch-2a: getPublishedExperienceBySlug -> null for the hidden provider's row");
      assertEq(expStore.getPublishedExperienceBySlug("synlig-hvalsafari")?.id, visibleExpId, "ch-2b: ...while the visible provider's row is still served by slug");
      assertEq(expStore.getPublishedExperienceById(hiddenExpId), null, "ch-2c: getPublishedExperienceById -> null for the hidden provider's row");
      assertEq(expStore.getPublishedExperienceById(visibleZeroExpId)?.id, visibleZeroExpId, "ch-2d: ...and catalog_hidden=0 is treated as visible by id");
      assertTrue(!!expStore.getExperienceById(hiddenExpId), "ch-2e: the RAW getExperienceById (admin/diagnostic) still returns the hidden row");

      // (3) sitemap + FAQ-style PUBLISH_GATE_SQL consumers exclude it.
      const sitemapSlugs = expStore.listPublishedExperienceSlugs().map((r) => r.slug).sort();
      assertEq(sitemapSlugs, ["synlig-hvalsafari", "synlig-null-nordlystur"], "ch-3a: listPublishedExperienceSlugs (sitemap) lists only the visible slugs");
      const faq = expStore.getCategoryFaqStats("safari");
      assertEq(faq.fylkeCount, 1, "ch-3b: getCategoryFaqStats counts only the visible providers' fylke (Vestland/hidden excluded)");
      assertEq(expStore.countPublishedProviders(), 2, "ch-3c: countPublishedProviders excludes the hidden provider");

      // (4) Grep-guard: the verified clause lives in PUBLISH_GATE_SQL and the
      // (out-of-scope, provider-join-less) listCategories() only — the inline
      // copy discoverExperiences() used to carry is gone.
      const storeSource = (require("fs") as typeof import("fs")).readFileSync(
        require.resolve("./experience-store").replace(/\.js$/, ".ts"),
        "utf8",
      );
      const verifiedClauseCount = (storeSource.match(/verification_status = 'verified'/g) ?? []).length;
      assertTrue(verifiedClauseCount <= 2, `ch-4: experience-store.ts spells the verified clause at most twice (PUBLISH_GATE_SQL + listCategories); found ${verifiedClauseCount}`);
      assertTrue(expStore.PUBLISH_GATE_SQL.includes("(p.catalog_hidden IS NULL OR p.catalog_hidden != 1)"), "ch-5: PUBLISH_GATE_SQL carries the LEFT-JOIN-safe catalog_hidden clause");
    } catch (err: any) {
      failed++;
      failures.push("publish-gate-catalog-hidden (experience-store): unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  const result = runExperienceStoreTests({ log: true });
  console.log(`\n${result.passed} passed, ${result.failed} failed`);
  if (result.failed > 0) process.exit(1);
}
