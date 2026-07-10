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
    assertTrue(
      titlesMatch(
        "Kon-Tiki Museet — Heyerdahl's Legendary Pacific Raft…",
        "…Thor Heyerdahl Expedition Museum at Bygdøy Oslo"
      ),
      "3a: Kon-Tiki / Thor Heyerdahl Expedition Museum — same real thing, shares distinctive token 'heyerdahl'"
    );

    // Near-duplicate re-harvest of the exact same source (minor rewording/typo) —
    // whole-string closeness path, no single 5+ char shared token required.
    assertTrue(
      titlesMatch("KOK Oslo Food Tour", "KOK Oslo Food Tur"), // "Tour" vs "Tur" typo
      "3b: near-identical re-harvest wording matches via whole-string similarity"
    );

    // ── 4. titlesMatch: two genuinely different experiences from the same provider must NOT match ──
    assertTrue(
      !titlesMatch("Guidet fjelltur til Fløyen", "Kajakkpadling i Bergen havn"),
      "4a: two unrelated activities from the same provider/kommune do not match"
    );
    assertTrue(
      !titlesMatch("Klatrekurs for nybegynnere", "Bursdagsfeiring i klatreparken"),
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
    const groups7 = groupDuplicateCandidates(rows7);
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
    const groups8 = groupDuplicateCandidates(rows8);
    assertEq(groups8.length, 1, "8a: two different provider_id rows sharing org_nr still bucket together");
    assertEq(groups8[0]?.map((r) => r.id).sort(), ["p1", "p2"], "8b: both rows are in the one group");

    // ── 9. groupDuplicateCandidates: no provider anchor / different kommune -> no group ──
    const rows9: DedupCandidateRow[] = [
      row({ id: "n1", provider_id: null, org_nr: null, title: "Samme opplevelse" }),
      row({ id: "n2", provider_id: null, org_nr: null, title: "Samme opplevelse" }),
    ];
    assertEq(groupDuplicateCandidates(rows9).length, 0, "9a: rows with no provider anchor never bucket together");
    const rows9b: DedupCandidateRow[] = [
      row({ id: "k1", kommune: "Oslo", title: "Klatrekurs for nybegynnere" }),
      row({ id: "k2", kommune: "Bergen", title: "Klatrekurs for nybegynnere" }),
    ];
    assertEq(groupDuplicateCandidates(rows9b).length, 0, "9b: identical title but different kommune -> not a duplicate group");

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
