/**
 * experience-dedup.test.ts — dev-request 2026-07-04-opplevagent-dedup-og-
 * norske-titler, work item 1: candidate-key dedup + canonical merge.
 *
 * Covers: the fuzzy title-match function (pure, incl. the confirmed real
 * examples), the canonical-richness scoring function, groupDuplicateCandidates
 * (provider-identity + kommune bucketing incl. the org_nr provider-record
 * fallback), runDedupPass against a real in-memory DB (incl. idempotency —
 * running it twice is a no-op the second time), the re-harvest guard, and
 * the discover-query invariant (a seeded Kon-Tiki-style duplicate set returns
 * exactly one row per real-world experience after backfill).
 *
 * Run standalone: npx tsx src/services/experience-dedup.test.ts
 * Wired into the gate via tests/test.ts (see opplevelser-discover-relax.test.ts
 * for the precedent this follows — same in-memory-DB pattern).
 */

import {
  normalizeExperienceTitle,
  titleTokens,
  titlesMatch,
  levenshtein,
  scoreExperienceRichness,
  pickCanonical,
  groupDuplicateCandidates,
  buildProviderCorpusTokenCounts,
  type DedupCandidateRow,
} from "./experience-dedup";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceDedupTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    // ── 1. normalizeExperienceTitle / titleTokens: punctuation, diacritics, possessives ──
    assertEq(
      normalizeExperienceTitle("Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…"),
      "kontiki museet heyerdahl legendary pacific raft",
      "1a: compound hyphen joined (Kon-Tiki -> kontiki), em-dash/ellipsis/possessive stripped, lowercased"
    );
    assertEq(
      normalizeExperienceTitle("…Thor Heyerdahl Expedition Museum at Bygdøy Oslo"),
      "thor heyerdahl expedition museum at bygdoy oslo",
      "1b: leading ellipsis stripped, ø folded to o"
    );
    assertTrue(
      titleTokens("Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…").includes("heyerdahl"),
      "1c: possessive 's stripped down to the bare distinctive token"
    );

    // ── 2. levenshtein: sanity ──
    assertEq(levenshtein("kitten", "sitting"), 3, "2a: classic levenshtein example");
    assertEq(levenshtein("same", "same"), 0, "2b: identical strings -> distance 0");

    // ── 3. titlesMatch: confirmed real prod duplicate (Kon-Tiki Museet), wildly different wording ──
    // corpus where 'heyerdahl' is rare (few distinct providers) — mirrors
    // experience-dedup-audit.test.ts's rareCorpus/kontiki fixture (~line 167-181).
    assertTrue(
      titlesMatch(
        "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…",
        "…Thor Heyerdahl Expedition Museum at Bygdøy Oslo",
        new Map([["heyerdahl", 2]])
      ),
      "3a: Kon-Tiki / Thor Heyerdahl Expedition Museum — same real thing, shares distinctive RARE token 'heyerdahl'"
    );

    // Near-duplicate re-harvest of the exact same source (minor rewording/typo) —
    // whole-string closeness path, no single 5+ char shared token required
    // ("tour"/"tur"/"kok"/"oslo"/"food" are all under 5 chars), so the corpus
    // is never consulted — empty Map is fine.
    assertTrue(
      titlesMatch("KOK Oslo Food Tour", "KOK Oslo Food Tur", new Map()), // "Tour" vs "Tur" typo
      "3b: near-identical re-harvest wording matches via whole-string similarity"
    );

    // ── 4. titlesMatch: two genuinely different experiences from the same provider must NOT match ──
    // Neither pair shares a >=5-char significant token ("fjelltur"/"floyen"
    // vs "kajakkpadling"/"bergen"/"havn"; "klatrekurs"/"nybegynnere" vs
    // "bursdagsfeiring"/"klatreparken"), so both fall through to the
    // whole-string path regardless of corpus contents — empty Map is fine.
    assertTrue(
      !titlesMatch("Guidet fjelltur til Fløyen", "Kajakkpadling i Bergen havn", new Map()),
      "4a: two unrelated activities from the same provider/kommune do not match"
    );
    assertTrue(
      !titlesMatch("Klatrekurs for nybegynnere", "Bursdagsfeiring i klatreparken", new Map()),
      "4b: beginner climbing course vs. birthday party at the same climbing park do not match"
    );

    // ── 5. scoreExperienceRichness: more populated fields + longer description + verified wins ──
    const thin = { description: "Kort tekst.", confidence: "low" as const };
    const rich = {
      description:
        "En lang og grundig beskrivelse av opplevelsen, med mye nyttig informasjon for besøkende som vurderer å bestille.",
      subcategory: "kulturhistorie",
      activity_tags: ["familie", "innendors"],
      duration_min: 90,
      price_from: 250,
      booking_url: "https://example.no/book",
      verification_status: "verified",
      confidence: "high" as const,
    };
    assertTrue(
      scoreExperienceRichness(rich) > scoreExperienceRichness(thin),
      "5a: a row with more populated fields + longer description + verified scores higher"
    );
    assertEq(scoreExperienceRichness({}), 0, "5b: an entirely empty row scores 0");

    // ── 6. pickCanonical: richest wins; ties broken by earliest created_at, then id ──
    const groupA: Array<{ id: string; created_at: string; score: number }> = [
      { id: "b", created_at: "2026-01-01", score: 1 },
      { id: "a", created_at: "2026-01-02", score: 5 },
      { id: "c", created_at: "2026-01-03", score: 5 },
    ];
    const pickA = pickCanonical(groupA, (r) => r.score);
    assertEq(pickA.canonical.id, "a", "6a: highest score wins; among score ties, earliest created_at wins");
    assertEq(pickA.duplicates.map((d) => d.id).sort(), ["b", "c"], "6b: the rest are duplicates");

    const groupB: Array<{ id: string; created_at: string; score: number }> = [
      { id: "z", created_at: "2026-01-01", score: 3 },
      { id: "y", created_at: "2026-01-01", score: 3 },
    ];
    const pickB = pickCanonical(groupB, (r) => r.score);
    assertEq(pickB.canonical.id, "y", "6c: full tie (score + created_at) -> lowest id wins deterministically");

    // ── 7. groupDuplicateCandidates: bucket by provider identity + kommune, cluster by fuzzy title ──
    function row(partial: Partial<DedupCandidateRow> & { id: string; title: string }): DedupCandidateRow {
      return {
        provider_id: "prov-1",
        org_nr: null,
        kommune: "Oslo",
        created_at: "2026-01-01",
        ...partial,
      };
    }
    const rows7: DedupCandidateRow[] = [
      row({ id: "1", title: "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…" }),
      row({ id: "2", title: "…Thor Heyerdahl Expedition Museum at Bygdøy Oslo" }),
      row({ id: "3", title: "Kon-Tiki Museum Oslo — Official Site" }),
      row({ id: "4", title: "Astrup Fearnley Museet for moderne kunst" }),
      row({ id: "5", title: "Astrup Fearnley Museum of Modern Art" }),
      row({ id: "6", title: "Helt urelatert aktivitet uten faellestrekk" }),
    ];
    // Empty corpus: every shared significant token counts as absent (count 0,
    // maximally rare), which mirrors this test's pre-corpus-rarity intent —
    // clustering behavior, not corpus-rarity semantics, is what's under test.
    const groups7 = groupDuplicateCandidates(rows7, new Map());
    assertEq(groups7.length, 2, "7a: two duplicate groups found (Kon-Tiki x3, Astrup Fearnley x2)");
    const kontikiGroup = groups7.find((g) => g.some((r) => r.id === "1"));
    assertEq(
      kontikiGroup?.map((r) => r.id).sort(),
      ["1", "2", "3"],
      "7b: all three Kon-Tiki variants cluster together (transitively, via union-find)"
    );
    const fearnleyGroup = groups7.find((g) => g.some((r) => r.id === "4"));
    assertEq(fearnleyGroup?.map((r) => r.id).sort(), ["4", "5"], "7c: the two Astrup Fearnley rows cluster together");
    assertTrue(
      !groups7.some((g) => g.some((r) => r.id === "6")),
      "7d: the unrelated row is not folded into any group"
    );

    // ── 8. groupDuplicateCandidates: org_nr fallback bridges two DIFFERENT provider records ──
    const rows8: DedupCandidateRow[] = [
      row({ id: "p1", provider_id: "provider-A", org_nr: "999888777", title: "RIB-safari i Oslofjorden" }),
      row({ id: "p2", provider_id: "provider-B", org_nr: "999888777", title: "RIB safari Oslofjorden" }),
    ];
    const groups8 = groupDuplicateCandidates(rows8, new Map());
    assertEq(groups8.length, 1, "8a: two different provider_id rows sharing org_nr still bucket together");
    assertEq(groups8[0]?.map((r) => r.id).sort(), ["p1", "p2"], "8b: both rows are in the one group");

    // ── 9. groupDuplicateCandidates: no provider anchor / different kommune -> no group ──
    const rows9: DedupCandidateRow[] = [
      row({ id: "n1", provider_id: null, org_nr: null, title: "Samme opplevelse" }),
      row({ id: "n2", provider_id: null, org_nr: null, title: "Samme opplevelse" }),
    ];
    assertEq(groupDuplicateCandidates(rows9, new Map()).length, 0, "9a: rows with no provider anchor never bucket together");
    const rows9b: DedupCandidateRow[] = [
      row({ id: "k1", kommune: "Oslo", title: "Klatrekurs for nybegynnere" }),
      row({ id: "k2", kommune: "Bergen", title: "Klatrekurs for nybegynnere" }),
    ];
    assertEq(groupDuplicateCandidates(rows9b, new Map()).length, 0, "9b: identical title but different kommune -> not a duplicate group");

    // ── 9b (corpus-rarity regression). titlesMatch: shared GENERIC token alone
    //        must NOT match; shared RARE token still must — dev-request
    //        2026-07-11-dedup-false-positive-remediation, slice C. Reproduces
    //        the exact false-positive pairs from the prod failure report,
    //        using ONE shared corpus (mirrors experience-dedup-audit.test.ts's
    //        commonCorpus/rareCorpus fixtures, ~line 126-173, same numbers). ──
    const commonCorpus = new Map<string, number>([
      ["fjelltur", 12],
      ["brevandring", 9],
      ["rafting", 8],
      ["klatring", 11],
      ["galdhopiggen", 2],
      ["snohetta", 1],
      ["nigardsbreen", 2],
      ["briksdalsbreen", 2],
      ["sjoa", 1], // rare in the corpus, but only 4 chars — must NOT count as a rare-token link
      ["dagstur", 3],
      ["kveldstur", 2],
      ["barn", 4],
      ["voksne", 3],
      ["heyerdahl", 2],
      ["kontiki", 2],
    ]);

    assertTrue(
      !titlesMatch("Fjelltur til Galdhøpiggen", "Fjelltur til Snøhetta", commonCorpus),
      "9b-1: Galdhøpiggen vs Snøhetta — two different mountains sharing only the generic 'fjelltur' must NOT match"
    );
    assertTrue(
      !titlesMatch("Brevandring på Nigardsbreen", "Brevandring på Briksdalsbreen", commonCorpus),
      "9b-2: Nigardsbreen vs Briksdalsbreen — two different glaciers sharing only the generic 'brevandring' must NOT match"
    );
    assertTrue(
      !titlesMatch("Rafting i Sjoa - dagstur", "Rafting i Sjoa - kveldstur", commonCorpus),
      "9b-3: Sjoa dagstur vs kveldstur — day/evening tours sharing only the generic 'rafting' must NOT match"
    );
    assertTrue(
      !titlesMatch("Klatring for barn", "Klatring for voksne", commonCorpus),
      "9b-4: Klatring for barn vs voksne — different audiences sharing only the generic 'klatring' must NOT match"
    );
    assertTrue(
      titlesMatch(
        "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft",
        "Thor Heyerdahl Expedition Museum at Bygdøy Oslo",
        commonCorpus
      ),
      "9b-5: Kon-Tiki / Thor Heyerdahl — no regression: the SAME corpus still matches via the RARE token 'heyerdahl'"
    );

    // ── 9c. groupDuplicateCandidates: cross-language title_no bridge ────────
    // dev-request 2026-07-04-opplevagent-dedup-og-norske-titler follow-on:
    // title_no is a Norwegian display title populated on some canonical rows
    // (backfill still partial). Without bridging title<->title_no, a real-world
    // experience harvested once with only an English title and once with only
    // a Norwegian title_no could never cluster. groupDuplicateCandidates()
    // now checks title-vs-title (unchanged, first/existing check), title-vs-
    // title_no, title_no-vs-title, and title_no-vs-title_no.
    {
      // 9c-1 (crafted positive): row A has only an English title containing
      // the distinctive proper-noun-ish token "oslofjorden"; row B's OWN
      // title is deliberately unrelated wording (so title-vs-title alone —
      // the pre-title_no behavior — would NOT cluster them), but row B's
      // title_no shares "oslofjorden" with row A's title. Only the new
      // title-vs-title_no path can bridge this pair.
      const rareOslofjordenCorpus = new Map([["oslofjorden", 2]]); // rare = distinctive
      const rowsCrossLang: DedupCandidateRow[] = [
        row({
          id: "cl-1",
          provider_id: "prov-cl",
          kommune: "Oslo",
          title: "Floating Sauna Experience — KOK Oslo, Oslofjorden",
          title_no: null,
        }),
        row({
          id: "cl-2",
          provider_id: "prov-cl",
          kommune: "Oslo",
          title: "Relaxing Waterfront Wellness Break",
          title_no: "KOK Oslo Flytende badstue på Oslofjorden",
        }),
      ];
      // Sanity: confirm the OLD (title-vs-title-only) behavior would NOT have
      // clustered this pair — proves the new path is what's doing the work.
      assertTrue(
        !titlesMatch(rowsCrossLang[0].title, rowsCrossLang[1].title, rareOslofjordenCorpus),
        "9c-1a: sanity check — title-vs-title ALONE does not match (old pre-title_no behavior)"
      );
      const groupsCrossLang = groupDuplicateCandidates(rowsCrossLang, rareOslofjordenCorpus);
      assertEq(groupsCrossLang.length, 1, "9c-1b: the pair now clusters via title-vs-title_no");
      assertEq(
        groupsCrossLang[0]?.map((r) => r.id).sort(),
        ["cl-1", "cl-2"],
        "9c-1c: both rows are in the one cluster"
      );

      // 9c-2 (negative): two genuinely different activities from the SAME
      // provider/kommune, one with an (unrelated) title_no set — must still
      // NOT match. Proves the title_no bridge doesn't over-match.
      const rowsCrossLangNeg: DedupCandidateRow[] = [
        row({
          id: "cl-neg-1",
          provider_id: "prov-cl-neg",
          kommune: "Bergen",
          title: "Guidet fjelltur til Fløyen",
          title_no: null,
        }),
        row({
          id: "cl-neg-2",
          provider_id: "prov-cl-neg",
          kommune: "Bergen",
          title: "Mountain Hike Package Bergen",
          title_no: "Kajakkpadling i Bergen havn",
        }),
      ];
      const groupsCrossLangNeg = groupDuplicateCandidates(rowsCrossLangNeg, new Map());
      assertEq(
        groupsCrossLangNeg.length,
        0,
        "9c-2: a genuinely different activity (guided hike vs. kayaking) does NOT cluster, even with title_no present"
      );

      // 9c-3 (real prod shape, KOK Oslo): provider-hash 1bf4e65f, confirmed
      // live triplicate shape from the module header comment above ("KOK
      // Oslo 3x"). One row's title is the real English-leaning harvested
      // title; the OTHER row's title_no is the Norwegian variant. The two
      // titles are deliberately worded to share ZERO tokens with each other
      // directly (verified below via the sanity check) — the ONLY link is
      // row A's title against row B's title_no, via "Oslofjorden". Uses
      // "Oslofjorden" (not "Oslofjord") in row A's title so it token-matches
      // row B's title_no exactly — titlesMatch() does exact-token-string
      // comparison, not stemming/inflection normalization, so "Oslofjord"
      // and "Oslofjorden" would NOT count as the same token. This is a
      // FIXTURE proving the code path works — it does NOT by itself prove the
      // live KOK Oslo prod rows will merge, since that additionally depends
      // on whether BOTH real rows currently have title_no populated (the
      // title_no backfill is still partial).
      const kokCorpus = new Map([["oslofjorden", 2]]);
      const rowsKok: DedupCandidateRow[] = [
        row({
          id: "kok-1",
          provider_id: "1bf4e65f",
          kommune: "Oslo",
          title: "Floating Sauna on the Oslofjorden — KOK Oslo",
          title_no: null,
        }),
        row({
          id: "kok-2",
          provider_id: "1bf4e65f",
          kommune: "Oslo",
          title: "Riverside Wellness Deck Reservation Page",
          title_no: "KOK Oslo Flytende badstue på Oslofjorden",
        }),
      ];
      // Sanity: confirm title-vs-title ALONE does NOT match (unlike the old
      // "sauna"-worded fixture, which accidentally passed even with the new
      // cross-language logic disabled) — proves this test genuinely exercises
      // the title-vs-title_no bridge, not ordinary title×title matching.
      assertTrue(
        !titlesMatch(rowsKok[0].title, rowsKok[1].title, kokCorpus),
        "9c-3a: sanity check — title-vs-title ALONE does not match (old pre-title_no behavior)"
      );
      const groupsKok = groupDuplicateCandidates(rowsKok, kokCorpus);
      assertEq(groupsKok.length, 1, "9c-3b: KOK Oslo-shaped fixture clusters via title-vs-title_no (fixture only, not a prod-live claim)");
      assertEq(groupsKok[0]?.map((r) => r.id).sort(), ["kok-1", "kok-2"], "9c-3c: both KOK Oslo fixture rows are in the one cluster");
    }

    // ── 9d. Corpus fix regression: loadCorpusTokenCounts() must count title_no
    // tokens too, not just title. Without this, a Norwegian word that's
    // genuinely generic across many DIFFERENT businesses' title_no values but
    // never used in any English `title` reads as count=0/rare in a title-only
    // corpus — so titlesMatch()'s SHARED_TOKEN_GENERIC_MIN gate treats a
    // shared occurrence of that word as strong distinctive evidence instead
    // of generic noise, and two genuinely different activities (same
    // provider+kommune bucket, see providerIdentityKey()/groupDuplicateCandidates())
    // sharing only that one common word wrongly cluster.
    //
    // This builds the corpus the OLD (buggy) way — title column only, exactly
    // what loadCorpusTokenCounts() did before the fix — and the FIXED way —
    // title AND title_no both counted via buildProviderCorpusTokenCounts(),
    // exactly what loadCorpusTokenCounts() does now (each row with a non-null
    // title_no contributes a second synthetic {title: title_no, provider_id}
    // entry) — and shows the outcome flips from wrongly-clusters to
    // correctly-does-not-cluster.
    {
      // Four DIFFERENT providers each use "fjelltur" (the same generic
      // Norwegian word used as the canonical "generic token" example above,
      // 9b-1) ONLY in title_no — never in title — simulating a word that's
      // genuinely generic across the real business corpus but invisible to a
      // title-only corpus.
      const corpusSeedRows: Array<{ title: string; title_no: string; provider_id: string }> = [
        { title: "Historic Fortress Tour", title_no: "Fjelltur til fortet", provider_id: "seed-1" },
        { title: "Coastal Bike Rental", title_no: "Fjelltur langs kysten", provider_id: "seed-2" },
        { title: "City Food Walk", title_no: "Fjelltur i byen", provider_id: "seed-3" },
        { title: "River Kayak Rental", title_no: "Fjelltur ved elva", provider_id: "seed-4" },
      ];
      // The bucket-pair under test: two genuinely DIFFERENT activities from
      // the SAME provider+kommune (so they land in one groupDuplicateCandidates
      // bucket), sharing NO token via title-vs-title, title-vs-title_no, or
      // title_no-vs-title — the ONLY shared token anywhere is "fjelltur",
      // present in BOTH rows' title_no only.
      const candA = row({
        id: "corp-a",
        provider_id: "prov-corpus-fix",
        kommune: "Trondheim",
        title: "Guided Historical Walking Route",
        title_no: "Fjelltur i sentrum",
      });
      const candB = row({
        id: "corp-b",
        provider_id: "prov-corpus-fix",
        kommune: "Trondheim",
        title: "Family Adventure Package",
        title_no: "Fjelltur for hele familien",
      });
      const allSeedRows: Array<{ title: string; title_no: string | null; provider_id: string | null }> = [
        ...corpusSeedRows,
        { title: candA.title, title_no: candA.title_no ?? null, provider_id: candA.provider_id },
        { title: candB.title, title_no: candB.title_no ?? null, provider_id: candB.provider_id },
      ];

      // OLD (buggy) corpus: title column only.
      const oldCorpus = buildProviderCorpusTokenCounts(
        allSeedRows.map((r) => ({ title: r.title, provider_id: r.provider_id }))
      );
      assertEq(
        oldCorpus.get("fjelltur"),
        undefined,
        "9d-1: pre-fix corpus (title-only) never sees 'fjelltur' at all — reads as absent/rare"
      );
      assertEq(
        groupDuplicateCandidates([candA, candB], oldCorpus).length,
        1,
        "9d-2: with the pre-fix corpus, the two genuinely different Trondheim activities wrongly cluster on the falsely-rare 'fjelltur'"
      );

      // FIXED corpus: title AND title_no both counted.
      const expandedRows: Array<{ title: string; provider_id: string | null }> = [];
      for (const r of allSeedRows) {
        expandedRows.push({ title: r.title, provider_id: r.provider_id });
        if (r.title_no && r.title_no.trim()) expandedRows.push({ title: r.title_no, provider_id: r.provider_id });
      }
      const fixedCorpus = buildProviderCorpusTokenCounts(expandedRows);
      assertEq(
        fixedCorpus.get("fjelltur"),
        5,
        "9d-3: post-fix corpus counts 'fjelltur' across 5 distinct providers (4 seeds + the shared bucket-pair provider) via title_no"
      );
      assertEq(
        groupDuplicateCandidates([candA, candB], fixedCorpus).length,
        0,
        "9d-4: with the fixed corpus, 'fjelltur' reads as generic (>= SHARED_TOKEN_GENERIC_MIN) and the two different activities correctly do NOT cluster"
      );
    }

    // ── 10. runDedupPass + idempotency + re-harvest guard + discover-query invariant,
    //        against a real in-memory experiences DB ──
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const expDedupPath = require.resolve("./experience-dedup");
    for (const p of [dbFactoryPath, expStorePath, expDedupPath]) {
      delete require.cache[p];
    }

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const db = dbFactory.getDb("experiences");

      const providerId = expStore.createProvider({
        navn: "Kon-Tiki Museet AS",
        kommune: "Oslo",
        fylke: "Oslo",
        brreg_verified: 1,
        brreg_active: 1,
        verification_status: "verified",
      });

      // Three harvested rows for the SAME real-world museum — mirrors the
      // confirmed prod duplicate (Kon-Tiki Museet, 4x on /fylke/Oslo).
      const idThin = expStore.createExperience({
        title: "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…",
        provider_id: providerId,
        kommune: "Oslo",
        fylke: "Oslo",
        verification_status: "verified",
        confidence: "medium",
        description: "Kort.",
      });
      const idRich = expStore.createExperience({
        title: "Kon-Tiki Museum Oslo — Official Site",
        provider_id: providerId,
        kommune: "Oslo",
        fylke: "Oslo",
        verification_status: "verified",
        confidence: "high",
        description:
          "Kon-Tiki Museet viser Thor Heyerdahls originale flåter og fartøy, med utstillinger om ekspedisjonene hans over Stillehavet og en rik samling av gjenstander.",
        duration_min: 60,
        price_from: 150,
        booking_url: "https://kon-tiki.no/book",
      });
      const idOther = expStore.createExperience({
        title: "…Thor Heyerdahl Expedition Museum at Bygdøy Oslo",
        provider_id: providerId,
        kommune: "Oslo",
        fylke: "Oslo",
        verification_status: "verified",
        confidence: "medium",
      });
      // A genuinely unrelated experience from the SAME provider+kommune — must
      // survive the dedup pass untouched.
      const idUnrelated = expStore.createExperience({
        title: "Guidet fjelltur til Fløyen",
        provider_id: providerId,
        kommune: "Oslo",
        fylke: "Oslo",
        verification_status: "verified",
        confidence: "high",
      });

      const { runDedupPass } = require("./experience-dedup") as typeof import("./experience-dedup");
      const pass1 = runDedupPass(db);
      assertEq(pass1.groupsFound, 1, "10a: one duplicate group found (the 3 Kon-Tiki variants)");
      assertEq(pass1.rowsMerged, 2, "10b: two rows merged away, one survives as canonical");

      const canonicalRow = db.prepare("SELECT canonical_id, merged_from FROM experiences WHERE id = ?").get(idRich) as
        | { canonical_id: string | null; merged_from: string | null }
        | undefined;
      assertEq(canonicalRow?.canonical_id, null, "10c: the richest row (idRich) is the canonical — canonical_id stays NULL");
      const mergedIds = JSON.parse(canonicalRow?.merged_from || "[]").sort();
      assertEq(mergedIds, [idOther, idThin].sort(), "10d: merged_from lists exactly the two folded-away ids");

      const thinRow = db.prepare("SELECT canonical_id FROM experiences WHERE id = ?").get(idThin) as
        | { canonical_id: string | null }
        | undefined;
      assertEq(thinRow?.canonical_id, idRich, "10e: the thin duplicate now points at the canonical row");

      const unrelatedRow = db.prepare("SELECT canonical_id FROM experiences WHERE id = ?").get(idUnrelated) as
        | { canonical_id: string | null }
        | undefined;
      assertEq(unrelatedRow?.canonical_id, null, "10f: the unrelated same-provider experience is untouched");

      // ── Idempotency: running the pass again is a no-op ──
      const pass2 = runDedupPass(db);
      assertEq(pass2.groupsFound, 0, "10g: second run finds zero NEW groups (duplicates already excluded from the pool)");
      assertEq(pass2.rowsMerged, 0, "10h: second run merges zero rows — idempotent");

      // ── Discover-query invariant: exactly one row per real-world experience ──
      const discoverResults = expStore.discoverExperiences({ fylke: "Oslo" }, 50);
      const kontikiHits = discoverResults.filter((r) => r.id === idRich || r.id === idThin || r.id === idOther);
      assertEq(kontikiHits.length, 1, "10i: discoverExperiences returns exactly ONE Kon-Tiki row post-backfill");
      assertEq(kontikiHits[0]?.id, idRich, "10j: it's the canonical (richest) row");
      assertTrue(
        discoverResults.some((r) => r.id === idUnrelated),
        "10k: the unrelated experience still appears in discover results"
      );

      // ── Re-harvest guard: re-harvesting a near-duplicate never inserts a new row ──
      const beforeCount = (db.prepare("SELECT COUNT(*) AS c FROM experiences").get() as { c: number }).c;
      const guardResult = expStore.bulkInsertExperiences([
        {
          title: "Kon-Tiki Museum — Official Website",
          provider_id: providerId,
          kommune: "Oslo",
          fylke: "Oslo",
          confidence: "low",
        },
      ]);
      const afterCount = (db.prepare("SELECT COUNT(*) AS c FROM experiences").get() as { c: number }).c;
      assertEq(afterCount, beforeCount, "11a: re-harvesting a known duplicate inserts zero new rows");
      assertEq(guardResult.inserted, 0, "11b: bulkInsertExperiences reports 0 inserted for the guarded row");
      assertTrue(guardResult.skipped + guardResult.updated === 1, "11c: the row was either skipped or applied in-place, not inserted");

      // A genuinely new experience (different provider/kommune) still inserts normally.
      const freshResult = expStore.bulkInsertExperiences([
        { title: "Splitter ny opplevelse", provider_id: providerId, kommune: "Bergen", fylke: "Vestland" },
      ]);
      assertEq(freshResult.inserted, 1, "11d: a genuinely new (different-kommune) experience still inserts");

      // ── 12. Corpus fix regression, run through the REAL pipeline (round-2
      // review gap): section 9d proves the row-expansion MATH is right by
      // hand-reimplementing it and calling the exported buildProviderCorpusTokenCounts()
      // directly — it never actually calls loadCorpusTokenCounts(), which is
      // module-private and only reachable via runDedupPass()/
      // findExistingCandidateMatch(). Reverting loadCorpusTokenCounts() to its
      // pre-fix (title-only) body left 9d fully green. This block exercises
      // the real loadCorpusTokenCounts() by going through runDedupPass()
      // against the live DB, so a silent regression in the title_no expansion
      // itself (not just the row-expansion math) fails a test.
      //
      // Same shape as 9d: a Norwegian word ("fjelltur") that's genuinely
      // generic across many DIFFERENT businesses but appears ONLY in title_no
      // (never in title) must still read as GENERIC (corpus count >=
      // SHARED_TOKEN_GENERIC_MIN) once loadCorpusTokenCounts() folds title_no
      // into the corpus — otherwise two genuinely different Trondheim
      // activities from the same provider+kommune bucket, sharing no token
      // except "fjelltur" (only via title_no on both sides), wrongly cluster.
      //
      // createExperience() never writes title_no (see its schema comment —
      // title_no is only ever set later via the title-no-backfill admin
      // route), so it's patched in with a raw UPDATE after insert, same as
      // that real backfill path would leave it.
      const setTitleNo = db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?");

      // Four unrelated seed businesses using "fjelltur" ONLY in title_no.
      const corpusFixSeeds: Array<{ title: string; titleNo: string }> = [
        { title: "Historic Fortress Tour", titleNo: "Fjelltur til fortet" },
        { title: "Coastal Bike Rental", titleNo: "Fjelltur langs kysten" },
        { title: "City Food Walk", titleNo: "Fjelltur i byen" },
        { title: "River Kayak Rental", titleNo: "Fjelltur ved elva" },
      ];
      for (const seed of corpusFixSeeds) {
        const seedProviderId = expStore.createProvider({
          navn: `Corpus Fix Seed — ${seed.title}`,
          kommune: "Bergen",
          fylke: "Vestland",
          brreg_verified: 1,
          brreg_active: 1,
          verification_status: "verified",
        });
        const seedExpId = expStore.createExperience({
          title: seed.title,
          provider_id: seedProviderId,
          kommune: "Bergen",
          fylke: "Vestland",
          verification_status: "verified",
          confidence: "medium",
        });
        setTitleNo.run(seed.titleNo, seedExpId);
      }

      // The bucket-pair under test: two genuinely DIFFERENT activities from
      // the SAME provider+kommune, sharing no token via title-vs-title,
      // title-vs-title_no, or title_no-vs-title — only title_no-vs-title_no
      // shares anything, and only "fjelltur".
      const corpusFixProviderId = expStore.createProvider({
        navn: "Trondheim Opplevelser AS",
        kommune: "Trondheim",
        fylke: "Trøndelag",
        brreg_verified: 1,
        brreg_active: 1,
        verification_status: "verified",
      });
      const corpFixA = expStore.createExperience({
        title: "Guided Historical Walking Route",
        provider_id: corpusFixProviderId,
        kommune: "Trondheim",
        fylke: "Trøndelag",
        verification_status: "verified",
        confidence: "medium",
      });
      setTitleNo.run("Fjelltur i sentrum", corpFixA);
      const corpFixB = expStore.createExperience({
        title: "Family Adventure Package",
        provider_id: corpusFixProviderId,
        kommune: "Trondheim",
        fylke: "Trøndelag",
        verification_status: "verified",
        confidence: "medium",
      });
      setTitleNo.run("Fjelltur for hele familien", corpFixB);

      runDedupPass(db);
      const corpFixARow = db.prepare("SELECT canonical_id FROM experiences WHERE id = ?").get(corpFixA) as
        | { canonical_id: string | null }
        | undefined;
      const corpFixBRow = db.prepare("SELECT canonical_id FROM experiences WHERE id = ?").get(corpFixB) as
        | { canonical_id: string | null }
        | undefined;
      // Assert the pair was never merged WITH EACH OTHER, checked in a way
      // that can't coincidentally pass depending on which of the two
      // pickCanonical() happens to keep as canonical (tie-break order isn't
      // the thing under test here — the corpus classification is).
      assertTrue(
        corpFixARow?.canonical_id !== corpFixB && corpFixBRow?.canonical_id !== corpFixA,
        "12a: title_no corpus fix via the REAL pipeline — Trondheim activities A and B are never merged with EACH OTHER (checked both directions, independent of which one pickCanonical() would keep)"
      );
      assertEq(
        corpFixARow?.canonical_id,
        null,
        "12b: activity A specifically stays unmerged/canonical — 'fjelltur' correctly reads as GENERIC via the real loadCorpusTokenCounts()'s title_no expansion (not RARE, which would wrongly force a merge)"
      );
      assertEq(
        corpFixBRow?.canonical_id,
        null,
        "12c: ...and activity B too — neither folds into the other"
      );
    } catch (err: any) {
      failed++;
      failures.push("experience-dedup: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      for (const p of [dbFactoryPath, expStorePath, expDedupPath]) {
        delete require.cache[p];
      }
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceDedupTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
