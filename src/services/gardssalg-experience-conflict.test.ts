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
    assertEq(summaryA, { matched_pairs: 1, conflicting: 1, agreeing: 0, unknown: 0 }, "a8: summary counts");

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
    assertEq(pairsF.length, 0, "f1: no shared token, no host-label match, no provider_id link -> not matched at all");

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
    assertEq(pairsH.length, 1, "h1: matched via title_no even though the (English) title shares nothing");
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

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runGardssalgExperienceConflictTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    if (summary.failed > 0) process.exit(1);
  });
}
