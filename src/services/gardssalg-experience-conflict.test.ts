/**
 * gardssalg-experience-conflict.test.ts — pure matching-logic tests for
 * dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-outreach,
 * Steg 2 (producer <-> experience/activity cross-table conflict diagnosis).
 *
 * Route-level tests for the two HTTP endpoints (GET .../gardssalg-experience-
 * conflict-audit, POST .../gardssalg-experience-conflict-remediation) and the
 * extended POST .../gardssalg-content-rollback (entity_type: "experience")
 * live in routes/opplevelser-gardssalg-experience-conflict.test.ts — this
 * file covers only the pure, DB-free matching function
 * (findGardssalgProducerExperienceMatches) and its summary helper.
 *
 * The Atlungstad case (dev-request Funn 2 — the confirmed concrete example
 * this whole slice exists for) is reproduced as a SYNTHETIC fixture here
 * (no live/seed DB with the real rows was available while building this):
 * producer id `atlungstad-brenneri--bbe4185d`, navn "Atlungstad Brenneri",
 * hjemmeside `atlungstadbrenneri.no`; experience id
 * `…norway-s-oldest-distillery-tours-tastings--68220487`, a realistic
 * marketing-style title that shares ZERO tokens with the producer's name
 * ("Norway's Oldest Distillery: Tours & Tastings") and booking_url
 * `atlungstad.no` — deliberately chosen so the pair can ONLY be matched via
 * the host_name signal (the experience's booking_url host resembling the
 * producer's name), not the name_token signal, proving that signal is load-
 * bearing rather than redundant.
 *
 * Run standalone: npx tsx src/services/gardssalg-experience-conflict.test.ts
 */

import {
  findGardssalgProducerExperienceMatches,
  summarizeGardssalgExperienceConflicts,
  type GsExpProducerRow,
  type GsExpExperienceRow,
} from "./gardssalg-experience-conflict";
// Imported ONLY for the boundary-guard assertions (block (x) below), which
// pin that the shared harvest-dedup matcher is not normalizing away spelling
// differences on this module's behalf. They were written when this file had
// its own digraph fold and had to prove the fold stayed local; the fold is
// gone now, but the guards are kept — they are the cheapest tripwire against
// anyone "helpfully" adding such a fold to the SHARED helper, which is what
// round 3 did and what the 2026-07-11 over-merge remediation exists to stop.
import { normalizeExperienceTitle, titlesMatch } from "./experience-dedup";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runGardssalgExperienceConflictTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── (a) the Atlungstad case — host_name signal, conflict ────────────────
    const atlungstadProducer: GsExpProducerRow = {
      id: "atlungstad-brenneri--bbe4185d",
      navn: "Atlungstad Brenneri",
      hjemmeside: "https://atlungstadbrenneri.no",
      catalog_hidden: 0,
    };
    const atlungstadExperience: GsExpExperienceRow = {
      id: "norway-s-oldest-distillery-tours-tastings--68220487",
      title: "Norway's Oldest Distillery: Tours & Tastings",
      title_no: null,
      booking_url: "https://atlungstad.no",
      provider_id: null,
    };

    const pairsA = findGardssalgProducerExperienceMatches([atlungstadProducer], [atlungstadExperience]);
    assertEq(pairsA.length, 1, "a1: Atlungstad producer x experience — exactly one matched pair");
    assertEq(pairsA[0]?.match_basis, "host_name", "a2: matched via host_name (title shares no token with the producer name)");
    assertEq(pairsA[0]?.status, "conflict", "a3: atlungstad.no vs atlungstadbrenneri.no — conflict");
    assertEq(pairsA[0]?.producer_id, "atlungstad-brenneri--bbe4185d", "a4: producer_id echoed correctly");
    assertEq(
      pairsA[0]?.experience_id,
      "norway-s-oldest-distillery-tours-tastings--68220487",
      "a5: experience_id echoed correctly"
    );
    assertEq(pairsA[0]?.producer_hjemmeside, "https://atlungstadbrenneri.no", "a6: producer_hjemmeside carried through");
    assertEq(pairsA[0]?.experience_booking_url, "https://atlungstad.no", "a7: experience_booking_url carried through");

    const summaryA = summarizeGardssalgExperienceConflicts(pairsA);
    assertEq(
      summaryA,
      { matched_pairs: 1, conflicting: 1, agreeing: 0, unknown: 0, ambiguous: 0 },
      "a8: summary counts"
    );

    // ── (b) a match that AGREES (same registrable domain) ───────────────────
    const agreeProducer: GsExpProducerRow = {
      id: "prod-agree",
      navn: "Ciderhuset Balestrand",
      hjemmeside: "https://ciderhusetbalestrand.no",
      catalog_hidden: 0,
    };
    const agreeExperience: GsExpExperienceRow = {
      id: "exp-agree",
      title: "Ciderhuset Balestrand — smaking og omvisning",
      title_no: null,
      booking_url: "https://www.ciderhusetbalestrand.no/besok",
      provider_id: null,
    };
    const pairsB = findGardssalgProducerExperienceMatches([agreeProducer], [agreeExperience]);
    assertEq(pairsB.length, 1, "b1: Ciderhuset — one matched pair");
    assertEq(pairsB[0]?.match_basis, "name_token", "b2: matched via shared distinctive name token");
    assertEq(pairsB[0]?.status, "agree", "b3: same registrable domain (www. stripped) -> agree");

    // ── (c) provider_link — strongest signal, trusted even with an unrelated
    //     title ──────────────────────────────────────────────────────────────
    const linkedProducer: GsExpProducerRow = {
      id: "prod-linked",
      navn: "Fossmoen Frukt",
      hjemmeside: "https://fossmoenfrukt.no",
      catalog_hidden: 0,
    };
    const linkedExperience: GsExpExperienceRow = {
      id: "exp-linked",
      title: "Completely unrelated wording with zero shared tokens",
      title_no: null,
      booking_url: "https://booking.fossmoenfrukt.no/omvisning",
      provider_id: "prod-linked",
    };
    const pairsC = findGardssalgProducerExperienceMatches([linkedProducer], [linkedExperience]);
    assertEq(pairsC.length, 1, "c1: provider_id-linked row always matches regardless of title text");
    assertEq(pairsC[0]?.match_basis, "provider_link", "c2: matched via provider_link");
    assertEq(pairsC[0]?.status, "agree", "c3: booking.fossmoenfrukt.no's registrable domain agrees with fossmoenfrukt.no");

    // ── (d) unknown — producer has no hjemmeside to compare against ─────────
    const noHomepageProducer: GsExpProducerRow = {
      id: "prod-nohome",
      navn: "Norumbryggeriet",
      hjemmeside: null,
      catalog_hidden: 0,
    };
    const noHomepageExperience: GsExpExperienceRow = {
      id: "exp-nohome",
      title: "Norumbryggeriet — ølsmaking",
      title_no: null,
      booking_url: "https://some-aggregator.example/norumbryggeriet",
      provider_id: null,
    };
    const pairsD = findGardssalgProducerExperienceMatches([noHomepageProducer], [noHomepageExperience]);
    assertEq(pairsD.length, 1, "d1: still matched (name_token) despite missing producer hjemmeside");
    assertEq(pairsD[0]?.status, "unknown", "d2: no producer hjemmeside to compare against -> unknown, not conflict");

    // ── (e) unknown — experience has no booking_url at all ──────────────────
    const blankUrlExperience: GsExpExperienceRow = {
      id: "exp-blank-url",
      title: "Fossmoen Frukt — gårdsbesøk",
      title_no: null,
      booking_url: null,
      provider_id: null,
    };
    const pairsE = findGardssalgProducerExperienceMatches([linkedProducer], [blankUrlExperience]);
    assertEq(pairsE.length, 1, "e1: matched via name_token even with a blank booking_url");
    assertEq(pairsE[0]?.status, "unknown", "e2: blank booking_url -> unknown, never conflict");

    // ── (f) negative control — genuinely unrelated producer/experience never
    //     match on any signal ───────────────────────────────────────────────
    const unrelatedProducer: GsExpProducerRow = {
      id: "prod-unrelated",
      navn: "Hebnes Vingård",
      hjemmeside: "https://hebnesvingard.no",
      catalog_hidden: 0,
    };
    const unrelatedExperience: GsExpExperienceRow = {
      id: "exp-unrelated",
      title: "Fjelltur til Galdhøpiggen med guide",
      title_no: null,
      booking_url: "https://turoperator.example/galdhopiggen",
      provider_id: null,
    };
    const pairsF = findGardssalgProducerExperienceMatches([unrelatedProducer], [unrelatedExperience]);
    assertEq(pairsF.length, 0, "f1: no shared token, no host-label match, no provider_id link -> not matched at all (round-8: no mutation in the sweep kills this one — it documents the negative case rather than guarding a mechanism)");

    // ── (g) catalog_hidden producers are STILL scanned, never excluded ──────
    const hiddenProducer: GsExpProducerRow = {
      id: "prod-hidden",
      navn: "Sagene Bryggeri",
      hjemmeside: "https://sagenebryggeri.no",
      catalog_hidden: 1,
    };
    const hiddenExperience: GsExpExperienceRow = {
      id: "exp-hidden",
      title: "Sagene Bryggeri — bryggeribesøk",
      title_no: null,
      booking_url: "https://wrong-host.example/sagene",
      provider_id: null,
    };
    const pairsG = findGardssalgProducerExperienceMatches([hiddenProducer], [hiddenExperience]);
    assertEq(pairsG.length, 1, "g1: a catalog_hidden producer is still scanned/matched");
    assertEq(pairsG[0]?.producer_hidden, true, "g2: producer_hidden is surfaced true on the pair, not used to exclude it");
    assertEq(pairsG[0]?.status, "conflict", "g3: still correctly judged conflict");

    // ── (h) title_no bridges a match when the plain title doesn't ───────────
    const titleNoProducer: GsExpProducerRow = {
      id: "prod-titleno",
      navn: "Klostergården Håndbryggeri",
      hjemmeside: "https://klostergarden.no",
      catalog_hidden: 0,
    };
    const titleNoExperience: GsExpExperienceRow = {
      id: "exp-titleno",
      title: "Craft Beer Tasting Experience",
      title_no: "Klostergården håndbryggeri — smaking",
      booking_url: "https://klostergarden.no/smaking",
      provider_id: null,
    };
    const pairsH = findGardssalgProducerExperienceMatches([titleNoProducer], [titleNoExperience]);
    assertEq(pairsH.length, 1, "h1: matched via title_no even though the (English) title shares nothing. NOTE (round-8): the fixture ALSO matches via host_name, so h1/h3 survive breaking title_no entirely — only h2 pins the signal this block is named for.");
    assertEq(pairsH[0]?.match_basis, "name_token", "h2: name_token signal via title_no");
    assertEq(pairsH[0]?.status, "agree", "h3: same registrable domain -> agree");

    // ── (i) multiple producers x multiple experiences — only genuine pairs
    //     surface, each producer/experience judged independently ───────────
    const multi = findGardssalgProducerExperienceMatches(
      [atlungstadProducer, unrelatedProducer],
      [atlungstadExperience, unrelatedExperience]
    );
    assertTrue(
      multi.some((p) => p.producer_id === atlungstadProducer.id && p.experience_id === atlungstadExperience.id),
      "i1: Atlungstad pair present in a mixed multi-producer/multi-experience scan"
    );
    assertEq(multi.length, 1, "i2: cross pairs (Atlungstad x unrelated experience, etc.) never spuriously match");

    // ── (j) Finding 1 — the reproduced Bryggeri false positive: two UNRELATED
    //     producers and a generic unrelated experience must NOT all match each
    //     other purely on the shared category word "bryggeri" (a
    //     `producer_type` enum value). Confirms the genericity gate: a bare
    //     shared token that is a generic vocabulary word, with no second
    //     corroborating signal (no host-label match, no whole-title
    //     similarity), is never trusted alone. ────────────────────────────────
    const nordfjordBryggeri: GsExpProducerRow = {
      id: "prod-nordfjord-bryggeri",
      navn: "Nordfjord Bryggeri",
      hjemmeside: "https://nordfjordbryggeri.no",
      catalog_hidden: 0,
    };
    const sorlandetBryggeri: GsExpProducerRow = {
      id: "prod-sorlandet-bryggeri",
      navn: "Sørlandet Bryggeri",
      hjemmeside: "https://sorlandetbryggeri.no",
      catalog_hidden: 0,
    };
    const genericBryggeriExperience: GsExpExperienceRow = {
      id: "exp-generic-bryggeri-omvisning",
      title: "Norsk Bryggeri Omvisning Sommer",
      title_no: null,
      booking_url: "https://visitvestlandet.example/bryggeri",
      provider_id: null,
    };
    const pairsJ = findGardssalgProducerExperienceMatches(
      [nordfjordBryggeri, sorlandetBryggeri],
      [genericBryggeriExperience]
    );
    assertEq(
      pairsJ.length,
      0,
      "j1: two unrelated Bryggeri producers + a generic Bryggeri experience -> NOT matched at all (Finding 1 fixed)"
    );
    const summaryJ = summarizeGardssalgExperienceConflicts(pairsJ);
    assertEq(
      summaryJ,
      { matched_pairs: 0, conflicting: 0, agreeing: 0, unknown: 0, ambiguous: 0 },
      "j2: zero conflicting pairs produced from the generic-word-only collision — nothing remediable, nothing corrupted"
    );

    // ── (k) generic-token gate is corroboration-aware, not a blanket veto: a
    //     shared GENERIC token still counts when corroborated by
    //     near-identical whole-title wording (mirrors titlesMatch's own
    //     GENERIC_TOKEN_CORROBORATION_MIN branch). ─────────────────────────────
    const bareBryggeriProducer: GsExpProducerRow = {
      id: "prod-bare-bryggeri",
      navn: "Bryggeri",
      hjemmeside: "https://barebryggeri.no",
      catalog_hidden: 0,
    };
    const corroboratedExperience: GsExpExperienceRow = {
      id: "exp-corroborated-bryggeri",
      title: "Bryggeri",
      title_no: null,
      booking_url: "https://wrong-host.example/bryggeri",
      provider_id: null,
    };
    const pairsK = findGardssalgProducerExperienceMatches([bareBryggeriProducer], [corroboratedExperience]);
    assertEq(pairsK.length, 1, "k1: a generic shared token IS trusted once whole-title similarity corroborates it");
    assertEq(pairsK[0]?.match_basis, "name_token", "k2: matched via name_token (corroborated)");
    assertEq(pairsK[0]?.status, "conflict", "k3: still correctly judged conflict once corroborated");

    // ── (l) Finding 2 — same-experience/multiple-producer collision: when one
    //     experience_id legitimately conflict-matches TWO different
    //     producer_ids (e.g. a data-quality duplicate producer record, or any
    //     other genuine ambiguity that survives the Finding-1 gate), BOTH
    //     pairs are reclassified "ambiguous" — visible in the full pairs list
    //     (diagnosis), but excluded once a caller filters to
    //     status==="conflict" (exactly what the remediation route does). ─────
    const fjellroA: GsExpProducerRow = {
      id: "prod-fjellro-a",
      navn: "Fjellro Gård",
      hjemmeside: "https://fjellro-a.example",
      catalog_hidden: 0,
    };
    const fjellroB: GsExpProducerRow = {
      id: "prod-fjellro-b",
      navn: "Fjellro Gård",
      hjemmeside: "https://fjellro-b.example",
      catalog_hidden: 0,
    };
    const fjellroExperience: GsExpExperienceRow = {
      id: "exp-fjellro-omvisning",
      title: "Fjellro Gård — omvisning og smaking",
      title_no: null,
      booking_url: "https://neither-of-them.example/fjellro",
      provider_id: null,
    };
    const pairsL = findGardssalgProducerExperienceMatches([fjellroA, fjellroB], [fjellroExperience]);
    assertEq(pairsL.length, 2, "l1: both producers match the same experience (a genuine collision, not a Finding-1 false positive)");
    assertTrue(
      pairsL.every((p) => p.status === "ambiguous"),
      "l2: both colliding pairs are reclassified 'ambiguous', not left as 'conflict'"
    );
    assertTrue(
      pairsL.some((p) => p.producer_id === "prod-fjellro-a") && pairsL.some((p) => p.producer_id === "prod-fjellro-b"),
      "l3: both producer_ids are still represented in the diagnosis output"
    );
    const remediableL = pairsL.filter((p) => p.status === "conflict");
    assertEq(remediableL.length, 0, "l4: zero pairs left with status==='conflict' -> remediation (which filters on that) touches neither");
    const summaryL = summarizeGardssalgExperienceConflicts(pairsL);
    assertEq(
      summaryL,
      { matched_pairs: 2, conflicting: 0, agreeing: 0, unknown: 0, ambiguous: 2 },
      "l5: summary counts both pairs under 'ambiguous', zero under 'conflicting'"
    );

    // ── (m) collision guard does not over-trigger: an unrelated third producer
    //     matching a DIFFERENT experience is unaffected, and a single
    //     producer/experience conflict pair (no collision) still reports
    //     plain 'conflict', not 'ambiguous' — regression guard against a
    //     blanket "any repeated experience_id" bug. ───────────────────────────
    const pairsM = findGardssalgProducerExperienceMatches(
      [fjellroA, fjellroB, atlungstadProducer],
      [fjellroExperience, atlungstadExperience]
    );
    const atlungstadInMixed = pairsM.find((p) => p.producer_id === atlungstadProducer.id);
    assertEq(atlungstadInMixed?.status, "conflict", "m1: an unrelated single-producer conflict pair is untouched by the collision guard");
    assertTrue(
      pairsM.filter((p) => p.experience_id === "exp-fjellro-omvisning").every((p) => p.status === "ambiguous"),
      "m2: the colliding experience is still reclassified correctly inside a larger mixed scan"
    );

    // ── (n) Round-2 review finding — host_name genericity gate: the
    //     reviewer's exact reproduction. "Fjellheim Gård" (hjemmeside
    //     fjellheimgard.no) is one of several gårdssalg producers whose name
    //     contains the ordinary word "gård"/"gard" (>=5 DISTINCT producers in
    //     this scan's own corpus use it, same corpus-frequency mechanism
    //     isGenericNameToken() already uses for name_token — "gard" is not in
    //     the producer_type enum. Round-9 measurement: the STOPLIST and the
    //     corpus-frequency mechanism each gate "gard" INDEPENDENTLY here —
    //     disabling either alone still yields 0 pairs; only disabling both
    //     yields 5 (all ambiguous). This text predates the stoplist and used
    //     to credit corpus frequency alone.) An unrelated experience
    //     ("Kajakktur i Lofoten med guide" — zero shared title tokens with
    //     "Fjellheim Gård") whose booking_url happens to resolve to
    //     "gard.no" must NOT be flagged as conflict purely because "gard" is
    //     a token both share — that would silently overwrite an unrelated
    //     business's booking_url on apply. ───────────────────────────────────
    const fjellheimGard: GsExpProducerRow = {
      id: "prod-fjellheim-gard",
      navn: "Fjellheim Gård",
      hjemmeside: "https://fjellheimgard.no",
      catalog_hidden: 0,
    };
    const gardCorpusFillers: GsExpProducerRow[] = [
      { id: "prod-gard-2", navn: "Nordbø Gård", hjemmeside: "https://nordbogard.no", catalog_hidden: 0 },
      { id: "prod-gard-3", navn: "Solheim Gård", hjemmeside: "https://solheimgard.no", catalog_hidden: 0 },
      { id: "prod-gard-4", navn: "Vika Gård", hjemmeside: "https://vikagard.no", catalog_hidden: 0 },
      { id: "prod-gard-5", navn: "Åsen Gård", hjemmeside: "https://asengard.no", catalog_hidden: 0 },
    ];
    const lofotenKajakkExperience: GsExpExperienceRow = {
      id: "exp-lofoten-kajakktur",
      title: "Kajakktur i Lofoten med guide",
      title_no: null,
      booking_url: "https://gard.no/aktiviteter/123",
      provider_id: null,
    };
    const pairsN = findGardssalgProducerExperienceMatches(
      [fjellheimGard, ...gardCorpusFillers],
      [lofotenKajakkExperience]
    );
    assertTrue(
      !pairsN.some((p) => p.producer_id === fjellheimGard.id && p.status === "conflict"),
      "n1: Fjellheim Gård x unrelated Lofoten-kayak experience via generic host label 'gard' -> NOT flagged conflict. NOTE (round-8 mutation testing): this assertion alone is MASKED — disable the host genericity gate and the 5 resulting false matches all collide into ambiguous, so 'no conflict' still holds. n2 is the one that actually catches it; keep them together."
    );
    assertEq(
      pairsN.filter((p) => p.producer_id === fjellheimGard.id).length,
      0,
      "n2: the pair is excluded from matches entirely (no shared title tokens, and the generic host label 'gard' is not trustworthy evidence)"
    );

    // ── (o) Round-2 review finding, re-confirmed — the Atlungstad true
    //     positive MUST still be detected as conflict: its host label
    //     ("atlungstad") is distinctive (not a producer_type vocabulary word,
    //     and used by only this ONE producer in the scan's corpus), so the
    //     new genericity gate must not reject it. Re-run of test (a)'s
    //     assertions, pinned explicitly here for this finding. ─────────────────
    const pairsO = findGardssalgProducerExperienceMatches([atlungstadProducer], [atlungstadExperience]);
    assertEq(pairsO.length, 1, "o1: Atlungstad still matches exactly one pair post-fix");
    assertEq(pairsO[0]?.match_basis, "host_name", "o2: still matched via host_name — distinctive host label 'atlungstad' is not gated out");
    assertEq(pairsO[0]?.status, "conflict", "o3: still correctly judged conflict — the true positive is not regressed by the round-2 fix");

    // ── (p) Round-2 review finding — corroboration-path false positive: a
    //     GENERIC host label must not be allowed to corroborate an
    //     all-generic shared name_token set either (the same Bryggeri-class
    //     false positive as Finding 1/test (j), but reached via the
    //     nameTokenMatches() corroboration branch this time, since hostMatch
    //     used to be passed through ungated there too). "Vestfjord Bryggeri"
    //     shares only the generic category word "bryggeri" with "Lokalt
    //     Bryggeri" (no whole-title similarity corroboration either — the
    //     two titles are not near-identical), and its booking_url host label
    //     is ALSO just "bryggeri" (itself a producer_type enum word, hence
    //     generic) — pre-fix, that ungated hostMatch alone corroborated the
    //     generic name_token into a false 'conflict'. ─────────────────────────
    const vestfjordBryggeri: GsExpProducerRow = {
      id: "prod-vestfjord-bryggeri",
      navn: "Vestfjord Bryggeri",
      hjemmeside: "https://vestfjordbryggeri.no",
      catalog_hidden: 0,
    };
    const genericHostBryggeriExperience: GsExpExperienceRow = {
      id: "exp-lokalt-bryggeri",
      title: "Lokalt Bryggeri",
      title_no: null,
      booking_url: "https://bryggeri.no/info",
      provider_id: null,
    };
    const pairsP = findGardssalgProducerExperienceMatches([vestfjordBryggeri], [genericHostBryggeriExperience]);
    assertEq(
      pairsP.length,
      0,
      "p1: a generic host label ('bryggeri') can no longer corroborate a generic shared name_token ('bryggeri') into a false conflict"
    );

    // ── (q) Round-3 review finding — the curated stoplist, host_name path,
    //     reproduced with the REVIEWER'S EXACT minimal corpus: only 2
    //     producers total ("Fjellheim Gård" + one unrelated filler), far
    //     below SHARED_TOKEN_GENERIC_MIN (5) — so the corpus-frequency
    //     mechanism alone (round-2's fix) does NOT catch "gard", and pre-
    //     this-fix the exact round-2 false positive reappears. The new
    //     corpus-size-independent stoplist (GENERIC_FARM_PLACE_WORD_STOPLIST)
    //     must catch it regardless of how few producers are in the scan. ────
    const fjellheimGardMinimal: GsExpProducerRow = {
      id: "prod-fjellheim-gard-minimal",
      navn: "Fjellheim Gård",
      hjemmeside: "https://fjellheimgard.no",
      catalog_hidden: 0,
    };
    const unrelatedFillerMinimal: GsExpProducerRow = {
      id: "prod-unrelated-filler-minimal",
      navn: "Nordkyst Sjømat",
      hjemmeside: "https://nordkystsjomat.no",
      catalog_hidden: 0,
    };
    const gardHostExperienceMinimal: GsExpExperienceRow = {
      id: "exp-gard-host-minimal",
      title: "Kajakktur i Lofoten med guide",
      title_no: null,
      booking_url: "https://gard.no/aktiviteter/123",
      provider_id: null,
    };
    const pairsQ = findGardssalgProducerExperienceMatches(
      [fjellheimGardMinimal, unrelatedFillerMinimal],
      [gardHostExperienceMinimal]
    );
    assertEq(
      pairsQ.filter((p) => p.producer_id === fjellheimGardMinimal.id).length,
      0,
      "q1: 2-producer corpus (well below the frequency threshold) — 'gard' host label still gated out by the stoplist, no false conflict"
    );

    // ── (r) Round-3 review finding — the symmetric name_token case: a
    //     2-producer corpus sharing a stoplisted word ("tunet") must not be
    //     trusted as standalone name_token evidence either, at any corpus
    //     size. No host_name signal and no near-identical whole-title
    //     wording is present here, so this isolates the name_token path
    //     specifically. ───────────────────────────────────────────────────────
    const bakkelyTunet: GsExpProducerRow = {
      id: "prod-bakkely-tunet",
      navn: "Bakkely Tunet",
      hjemmeside: "https://bakkelytunet.no",
      catalog_hidden: 0,
    };
    const tunetFiller: GsExpProducerRow = {
      id: "prod-tunet-filler",
      navn: "Nordkyst Sjømat",
      hjemmeside: "https://nordkystsjomat.no",
      catalog_hidden: 0,
    };
    const tunetExperience: GsExpExperienceRow = {
      id: "exp-tunet-aktiviteter",
      title: "Tunet Aktiviteter for hele Familien",
      title_no: null,
      booking_url: "https://booking-portal.example/aktivitet",
      provider_id: null,
    };
    const pairsR = findGardssalgProducerExperienceMatches([bakkelyTunet, tunetFiller], [tunetExperience]);
    assertEq(
      pairsR.length,
      0,
      "r1: 2-producer corpus sharing only the stoplisted word 'tunet' -> NOT matched at all (symmetric name_token case fixed)"
    );

    // ── (s) The historical "gaard" spelling must be gated exactly like the
    //     "gård" spelling in test (q). The booking_url host is deliberately
    //     "gaard.no" (NOT "gard.no" as in (q)), so the host label token is
    //     literally "gaard" and hostMatch against the producer's own "gaard"
    //     name token is genuinely TRUE — the pair is rejected by the
    //     genericity gate, not by raw token inequality.
    //
    //     WHAT ACTUALLY GATES IT: the "gaard" literal in
    //     GENERIC_FARM_PLACE_WORD_STOPLIST. Not a digraph fold. Rounds 5-7
    //     carried a comment here claiming this test proved the fold was
    //     load-bearing; it never did — measured, (s) returns 0 pairs with the
    //     fold enabled AND disabled. That false claim is a large part of why
    //     two independent reviewers believed the fold was doing work, and it
    //     survived three review rounds. The fold is deleted; this test is
    //     unchanged and still passes, which is the point. ────────────────────
    const fjellheimGaardSpelling: GsExpProducerRow = {
      id: "prod-fjellheim-gaard-spelling",
      navn: "Fjellheim Gaard",
      hjemmeside: "https://fjellheimgaard.no",
      catalog_hidden: 0,
    };
    const gaardHostExperienceMinimal: GsExpExperienceRow = {
      id: "exp-gaard-host-minimal",
      title: "Kajakktur i Lofoten med guide",
      title_no: null,
      booking_url: "https://gaard.no/aktiviteter/123",
      provider_id: null,
    };
    const pairsS = findGardssalgProducerExperienceMatches(
      [fjellheimGaardSpelling, unrelatedFillerMinimal],
      [gaardHostExperienceMinimal]
    );
    assertEq(
      pairsS.filter((p) => p.producer_id === fjellheimGaardSpelling.id).length,
      0,
      "s1: a REAL hostMatch on the historical 'gaard' spelling is still gated — by the 'gaard' stoplist literal (NOT by any fold; see the block comment)"
    );

    // ── (t) Round-3 review finding — Atlungstad true positive re-confirmed
    //     at a MINIMAL corpus size (Atlungstad + 2 unrelated fillers, not a
    //     large fixture list), proving the true-positive match is not itself
    //     accidentally corpus-size-dependent after the round-3 stoplist/
    //     digraph changes. ───────────────────────────────────────────────────
    const atlungstadFiller1: GsExpProducerRow = {
      id: "prod-atlungstad-filler-1",
      navn: "Nordkyst Sjømat",
      hjemmeside: "https://nordkystsjomat.no",
      catalog_hidden: 0,
    };
    const atlungstadFiller2: GsExpProducerRow = {
      id: "prod-atlungstad-filler-2",
      navn: "Bakkely Tunet",
      hjemmeside: "https://bakkelytunet.no",
      catalog_hidden: 0,
    };
    const pairsT = findGardssalgProducerExperienceMatches(
      [atlungstadProducer, atlungstadFiller1, atlungstadFiller2],
      [atlungstadExperience]
    );
    const atlungstadPairT = pairsT.find((p) => p.producer_id === atlungstadProducer.id);
    assertTrue(!!atlungstadPairT, "t1: Atlungstad still matches in a minimal (non-large) 3-producer corpus");
    assertEq(atlungstadPairT?.match_basis, "host_name", "t2: still matched via host_name at minimal corpus size");
    assertEq(atlungstadPairT?.status, "conflict", "t3: still correctly judged conflict at minimal corpus size — not corpus-size-dependent");
    assertEq(pairsT.length, 1, "t4: no spurious matches introduced by the unrelated fillers");


    // ── (v)(w) Round-4 review finding — the fold must NOT reach the MATCH
    //     path. "aa" is not always the historical digraph, so folding it
    //     where match evidence is read collapses genuinely different names
    //     onto one shared token and MANUFACTURES a conflict — which on
    //     `apply=true` overwrites a real business's booking_url. These are
    //     the round-4 reviewer's own two counterexamples, run end-to-end
    //     through this module's matcher. Both must produce NO match. ─────────
    const haanesetProducer: GsExpProducerRow = {
      id: "prod-haaneset-gard",
      navn: "Haaneset Gård",
      hjemmeside: "https://haaneset.no",
      catalog_hidden: 0,
    };
    const hanesetExperience: GsExpExperienceRow = {
      id: "exp-haneset-fjelltur",
      title: "Haneset Fjelltur med Guide",
      title_no: null,
      booking_url: "https://haneset.no/tur",
      provider_id: null,
    };
    assertEq(
      findGardssalgProducerExperienceMatches([haanesetProducer], [hanesetExperience]).length,
      0,
      "v1: 'Haaneset' (producer) and 'Haneset' (unrelated experience, incl. its booking_url host) stay DISTINCT — no manufactured conflict"
    );
    const isaacProducer: GsExpProducerRow = {
      id: "prod-isaacpollen-sjomat",
      navn: "Isaacpollen Sjømat",
      hjemmeside: "https://isaacpollen.no",
      catalog_hidden: 0,
    };
    const isacExperience: GsExpExperienceRow = {
      id: "exp-isacpollen-havsafari",
      title: "Isacpollen Havsafari",
      title_no: null,
      booking_url: "https://isacpollen.no/booking",
      provider_id: null,
    };
    assertEq(
      findGardssalgProducerExperienceMatches([isaacProducer], [isacExperience]).length,
      0,
      "w1: 'Isaacpollen' and 'Isacpollen' stay DISTINCT — a foreign 'aa' is not the Norwegian digraph"
    );

    // ── (x) Round-4 boundary guard — the shared harvest-dedup matcher in
    //     experience-dedup.ts must be untouched by this PR. The fold was
    //     originally written into its stripDiacritics(), widening the
    //     false-merge surface of a matcher whose own history includes a
    //     production over-merge incident (418 groups / 1361 rows, dev-request
    //     2026-07-11-dedup-false-positive-remediation). These assertions fail
    //     the moment anyone moves the fold back into the shared helper. ──────
    assertTrue(
      normalizeExperienceTitle("Gaard") !== normalizeExperienceTitle("Gård"),
      "x1: the SHARED normalizeExperienceTitle() does NOT fold the digraph — no fold exists ANYWHERE any more; this pins the shared helper against ever growing one"
    );
    const emptyCorpus = new Map<string, number>();
    assertEq(
      titlesMatch("Haaneset Kajakkutleie ved fjorden", "Haneset Vinterfestival i sentrum", emptyCorpus),
      false,
      "x2: shared titlesMatch() still separates 'Haaneset'/'Haneset' — harvest-dedup false-merge surface not widened"
    );
    assertEq(
      titlesMatch("Isaacpollen Havsafari om morgenen", "Isacpollen Skiskole for nybegynnere", emptyCorpus),
      false,
      "x3: shared titlesMatch() still separates 'Isaacpollen'/'Isacpollen'"
    );

    // ── (y) The regression that shipped to production in `79adbad`. The
    //     corpus map was keyed by folding the raw producer name BEFORE
    //     tokenizing; the gate looked up AFTER normalization and stemming.
    //     Since fold∘normalize ≠ normalize∘fold, the gate looked up keys the
    //     corpus map never contained, read `?? 0`, and judged a token that 5
    //     distinct producers share as DISTINCTIVE — reopening the rounds-1-3
    //     false-positive class, and on apply=true overwriting a real
    //     business's booking_url.
    //
    //     The fold that caused it is now deleted, so these cases pass for the
    //     simplest possible reason: nothing derives a key on either side any
    //     more. They are KEPT as a tripwire for the SHIPPED asymmetry —
    //     verified: reintroducing `6dbcad1`'s shape (fold the raw name on the
    //     corpus side, fold after normalize+stem on the gate side) breaks
    //     them.
    //
    //     They are NOT a general proof of safety, and an earlier version of
    //     this comment wrongly claimed they were ("any future transform ...
    //     will break at least one of them"). Measured counter-example:
    //     reintroducing `a72f3a5`'s shape — the SAME derivation applied to
    //     both sides — passes all of these. A transform can be symmetric and
    //     still land on the wrong key. Do not read a green run here as
    //     licence to add one.
    //
    //     Three independent ways such a transform diverges, one case each:
    //       y1 "Storåa"     — diacritic-stripping itself CREATES "aa" ("åa")
    //                          that the raw string never contained.
    //       y2 "Sanda-Aker" — the compound-hyphen join (a-A) creates it.
    //       y3 "Aaros"      — trailing-"s" stemming lands on a different
    //                          length depending on whether a fold ran first.
    //
    //     Shape: 5 distinct producers share exactly ONE word, so its corpus
    //     count is 5 == SHARED_TOKEN_GENERIC_MIN -> generic -> needs
    //     corroboration, of which there is none (neutral booking_url host, no
    //     near-identical whole-title wording). Only producer 0 carries a
    //     hjemmeside, so a `conflict` can be reached and the ambiguous-
    //     collision guard is NOT what produces the expected zero — the
    //     genericity gate is. Control (aa1) uses a spelling where both
    //     positions already agreed, and passed before this fix too. ──────────
    const sharedWordScenario = (word: string): number => {
      const producers: GsExpProducerRow[] = [0, 1, 2, 3, 4].map((n) => ({
        id: `prod-shared-${n}`,
        navn: `${["Vestre", "Østre", "Nordre", "Søndre", "Indre"][n]} ${word}`,
        hjemmeside: n === 0 ? `https://vestre-${n}.example` : null,
        catalog_hidden: 0,
      }));
      const exp: GsExpExperienceRow = {
        id: "exp-shared-word",
        title: `${word} Opplevelsesdag ved Sjøen`,
        title_no: null,
        booking_url: "https://en-helt-annen-bedrift.example/booking",
        provider_id: null,
      };
      return findGardssalgProducerExperienceMatches(producers, [exp]).length;
    };
    assertEq(sharedWordScenario("Aakerhus"), 0, "aa1: control — spelling where both fold positions already agreed");
    assertEq(
      sharedWordScenario("Storåa"),
      0,
      "y1: 'Storåa' — 'aa' created by diacritic-stripping; corpus key and gate key must still agree (was 5 pairs)"
    );
    assertEq(
      sharedWordScenario("Sanda-Aker"),
      0,
      "y2: 'Sanda-Aker' — 'aa' created by the compound-hyphen join (was 5 pairs)"
    );
    // y3: the trailing-"s" stemming divergence ("Aaros" -> corpus key "aros",
    //     gate key "aro"). It canNOT be reached through name_token — the
    //     stemmed token "aaro" is 4 chars and NAME_TOKEN_MIN_LEN is 5, so it
    //     is filtered out before it can ever be shared evidence. It IS
    //     reachable through host_name, whose HOST_TOKEN_MIN_LEN is 4: a
    //     booking_url on "aaro.no" exactly equals the producer's own 4-char
    //     stemmed token. Written against that path deliberately — the
    //     name_token spelling of this case passes even on the broken code and
    //     would have been a vacuous test.
    const aarosProducers: GsExpProducerRow[] = [0, 1, 2, 3, 4].map((n) => ({
      id: `prod-aaros-${n}`,
      navn: `${["Vestre", "Østre", "Nordre", "Søndre", "Indre"][n]} Aaros`,
      hjemmeside: n === 0 ? "https://vestre-aaros.example" : null,
      catalog_hidden: 0,
    }));
    const aaroHostExperience: GsExpExperienceRow = {
      id: "exp-aaro-host",
      title: "Kajakktur i Lofoten med guide",
      title_no: null,
      booking_url: "https://aaro.no/aktiviteter/123",
      provider_id: null,
    };
    assertEq(
      findGardssalgProducerExperienceMatches(aarosProducers, [aaroHostExperience]).length,
      0,
      "y3: 'Aaros' via host_name — trailing-'s' stemming interacts with fold order (was 5 pairs)"
    );


    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgExperienceConflictTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
