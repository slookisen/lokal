/**
 * experience-dedup.test.ts — unit tests for the PURE duplicate-matching /
 * canonical-picking logic in experience-dedup.ts.
 *
 * dev-request 2026-07-04-opplevagent-katalog-dedup, item 1 ("dedup pass").
 * Pins the matching rule against the real near-duplicate patterns verified
 * live on /fylke/Oslo (2026-07-04): "Kon-Tiki Museet" appearing 4x, "KOK
 * Oslo" 3x, "Astrup Fearnley" 2x, "RIB Oslo" 2x, "Klatreverket" 2x, "Teknisk
 * Museum" 2x — plus a clear negative case (two genuinely different venues in
 * the same kommune) that must NEVER match.
 *
 * No DB fixture needed — everything under test here is pure (see
 * experience-store.ts / opplevelser-dedup-backfill.test.ts for the
 * DB-touching wiring: listExperiencesForDedup/runDedupBackfill and the
 * PUBLISH_GATE_SQL exclusion + detail-page redirect).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-dedup.test.ts
 *   2. Wired into the gate: tests/test.ts imports runExperienceDedupTests()
 *      and folds its pass/fail counts into the `npm test` summary.
 */

import {
  normalizeTitleForMatch,
  titleJaccardSimilarity,
  TITLE_JACCARD_THRESHOLD,
  hostnameOf,
  isDuplicateCandidate,
  richnessScore,
  pickCanonical,
  findDuplicateClusters,
  buildMergePlans,
  dedupeResultRows,
  type DedupExperienceRow,
} from "./experience-dedup";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

/** Minimal DedupExperienceRow builder — fills every field with a safe
 *  default so each test only has to specify what it cares about. */
function row(overrides: Partial<DedupExperienceRow> & { id: string; title: string }): DedupExperienceRow {
  return {
    kommune: "Oslo",
    provider_id: null,
    evidence_url: null,
    slug: `${overrides.id}-slug`,
    canonical_experience_id: null,
    created_at: "2026-01-01 00:00:00",
    description: null,
    booking_url: null,
    price_band: null,
    price_from: null,
    duration_min: null,
    meeting_point: null,
    category: null,
    subcategory: null,
    activity_tags: null,
    season: null,
    indoor_outdoor: null,
    loc_lat: null,
    loc_lon: null,
    ...overrides,
  };
}

export function runExperienceDedupTests(opts: { log?: boolean } = {}): TestSummary {
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

  // ── normalizeTitleForMatch / titleJaccardSimilarity ────────────────────
  {
    assertEq(normalizeTitleForMatch("Kon-Tiki Museet"), "kon tiki museet", "n1: hyphen -> space, lowercased");
    assertEq(normalizeTitleForMatch("KON-TIKI MUSEUM!"), "kon tiki museum", "n2: punctuation stripped, uppercase folded");
    assertEq(normalizeTitleForMatch("Ålesund Akvarium"), "alesund akvarium", "n3: å-folding");

    // Verified live near-duplicates (/fylke/Oslo, 2026-07-04) — all must
    // clear TITLE_JACCARD_THRESHOLD (0.5).
    const kontiki = titleJaccardSimilarity("Kon-Tiki Museet", "Kon-Tiki Museum");
    assertEq(kontiki, 0.5, "j1: Kon-Tiki Museet vs Kon-Tiki Museum -> 0.5 (2/4)");
    assertTrue(kontiki >= TITLE_JACCARD_THRESHOLD, "j1b: clears the match threshold");

    const astrup = titleJaccardSimilarity("Astrup Fearnley", "Astrup Fearnley Museum");
    assertTrue(Math.abs(astrup - 2 / 3) < 1e-9, "j2: Astrup Fearnley vs +Museum -> 2/3");
    assertTrue(astrup >= TITLE_JACCARD_THRESHOLD, "j2b: clears the match threshold");

    const klatreverket = titleJaccardSimilarity("Klatreverket", "Klatreverket Oslo");
    assertEq(klatreverket, 0.5, "j3: Klatreverket vs Klatreverket Oslo -> 0.5 (1/2)");
    assertTrue(klatreverket >= TITLE_JACCARD_THRESHOLD, "j3b: clears the match threshold");

    const kok = titleJaccardSimilarity("KOK Oslo", "KOK restaurant Oslo");
    assertTrue(Math.abs(kok - 2 / 3) < 1e-9, "j4: KOK Oslo vs KOK restaurant Oslo -> 2/3");
    assertTrue(kok >= TITLE_JACCARD_THRESHOLD, "j4b: clears the match threshold");

    // Negative control: two genuinely DIFFERENT venues in the same kommune
    // must NOT be flagged similar by the title matcher alone.
    const different1 = titleJaccardSimilarity("Kon-Tiki Museet", "Norsk Folkemuseum");
    assertEq(different1, 0, "j5: Kon-Tiki Museet vs Norsk Folkemuseum -> 0 (disjoint)");
    assertTrue(different1 < TITLE_JACCARD_THRESHOLD, "j5b: well under the match threshold");

    const different2 = titleJaccardSimilarity("Oslo Skatehall", "Oslo Ishall");
    assertTrue(Math.abs(different2 - 1 / 3) < 1e-9, "j6: Oslo Skatehall vs Oslo Ishall -> 1/3 (shared 'oslo' only)");
    assertTrue(different2 < TITLE_JACCARD_THRESHOLD, "j6b: under the match threshold despite shared city token");

    assertEq(titleJaccardSimilarity("", "Kon-Tiki Museet"), 0, "j7: empty title never matches");
    assertEq(titleJaccardSimilarity("Kon-Tiki Museet", "Kon-Tiki Museet"), 1, "j8: identical titles -> 1.0");
  }

  // ── hostnameOf ───────────────────────────────────────────────────────
  {
    assertEq(hostnameOf("https://www.kon-tiki.no/besok"), "kon-tiki.no", "h1: strips scheme + www + path");
    assertEq(hostnameOf("kon-tiki.no"), "kon-tiki.no", "h2: bare host (no scheme) resolves");
    assertEq(hostnameOf(null), null, "h3: null -> null");
    assertEq(hostnameOf(""), null, "h4: empty string -> null");
    assertEq(hostnameOf("not a url at all !!"), null, "h5: unparseable -> null");
  }

  // ── isDuplicateCandidate ─────────────────────────────────────────────
  {
    // Same provider, same kommune, near-duplicate titles -> match.
    assertTrue(
      isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "Oslo", provider_id: "p1", evidence_url: null },
        { title: "Kon-Tiki Museum", kommune: "Oslo", provider_id: "p1", evidence_url: null }
      ),
      "d1: same provider + same kommune + near-dup titles -> duplicate"
    );

    // Different providers, but same evidence_url hostname -> match.
    assertTrue(
      isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "Oslo", provider_id: "p1", evidence_url: "https://www.visitoslo.com/kon-tiki" },
        { title: "Kon-Tiki Museum", kommune: "Oslo", provider_id: "p2", evidence_url: "https://visitoslo.com/attraksjoner/kon-tiki" }
      ),
      "d2: different provider, same evidence_url host -> duplicate"
    );

    // Different providers, different hosts -> no match even with matching titles/kommune.
    assertTrue(
      !isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "Oslo", provider_id: "p1", evidence_url: "https://a.no/x" },
        { title: "Kon-Tiki Museum", kommune: "Oslo", provider_id: "p2", evidence_url: "https://b.no/y" }
      ),
      "d3: different provider + different host -> NOT duplicate"
    );

    // DELIBERATE FALSE-POSITIVE GUARD: same provider, same near-dup titles,
    // but DIFFERENT kommune -> must never merge.
    assertTrue(
      !isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "Oslo", provider_id: "p1", evidence_url: null },
        { title: "Kon-Tiki Museum", kommune: "Bergen", provider_id: "p1", evidence_url: null }
      ),
      "d4: same provider + matching titles but DIFFERENT kommune -> NOT duplicate (false-positive guard)"
    );

    // Missing kommune on either side -> no match (can't prove same-place).
    assertTrue(
      !isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: null, provider_id: "p1", evidence_url: null },
        { title: "Kon-Tiki Museum", kommune: "Oslo", provider_id: "p1", evidence_url: null }
      ),
      "d5: missing kommune -> NOT duplicate"
    );

    // Clear negative case: two genuinely different venues, same kommune, same provider.
    assertTrue(
      !isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "Oslo", provider_id: "p1", evidence_url: null },
        { title: "Norsk Folkemuseum", kommune: "Oslo", provider_id: "p1", evidence_url: null }
      ),
      "d6: two genuinely different venues in same kommune -> NOT duplicate"
    );

    // kommune comparison is case/whitespace-insensitive.
    assertTrue(
      isDuplicateCandidate(
        { title: "Kon-Tiki Museet", kommune: "  oslo ", provider_id: "p1", evidence_url: null },
        { title: "Kon-Tiki Museum", kommune: "Oslo", provider_id: "p1", evidence_url: null }
      ),
      "d7: kommune comparison is case/whitespace-insensitive"
    );
  }

  // ── richnessScore / pickCanonical ────────────────────────────────────
  {
    const thin = row({ id: "thin", title: "Kon-Tiki Museet" });
    const rich = row({
      id: "rich",
      title: "Kon-Tiki Museum",
      description: "Et av Norges mest besøkte museer.",
      booking_url: "https://kon-tiki.no/billetter",
      price_band: "standard",
      price_from: 150,
      duration_min: 60,
      meeting_point: "Bygdøynesveien 36",
      category: "museum",
      loc_lat: 59.9,
      loc_lon: 10.7,
    });
    assertTrue(richnessScore(rich) > richnessScore(thin), "r1: richer row scores higher");
    assertEq(pickCanonical([thin, rich]).id, "rich", "r2: pickCanonical picks the richer row regardless of input order");
    assertEq(pickCanonical([rich, thin]).id, "rich", "r3: pickCanonical is order-independent");

    // Tie-break: equal richness -> earlier created_at wins.
    const older = row({ id: "b-older", title: "X", created_at: "2026-01-01 00:00:00" });
    const newer = row({ id: "a-newer", title: "X", created_at: "2026-02-01 00:00:00" });
    assertEq(pickCanonical([newer, older]).id, "b-older", "r4: tie -> earliest created_at wins (not lexicographic id)");

    // Full tie (same richness, same created_at) -> deterministic by id.
    const sameA = row({ id: "aaa", title: "X", created_at: "2026-01-01" });
    const sameB = row({ id: "bbb", title: "X", created_at: "2026-01-01" });
    assertEq(pickCanonical([sameB, sameA]).id, "aaa", "r5: full tie -> lexicographically smallest id wins, deterministic");
  }

  // ── findDuplicateClusters / buildMergePlans ──────────────────────────
  {
    // The verified live cluster shape: 4 near-duplicate "Kon-Tiki" rows in
    // Oslo (transitively chained via pairwise Jaccard matches), plus one
    // unrelated Oslo row that must NOT be swept in.
    const rows: DedupExperienceRow[] = [
      row({ id: "kt1", title: "Kon-Tiki Museet", provider_id: "p1", description: "kort" }),
      row({ id: "kt2", title: "Kon-Tiki Museum", provider_id: "p1" }),
      row({ id: "kt3", title: "Kon Tiki museet Oslo", provider_id: "p1", description: "En lengre og mer utfyllende beskrivelse av museet.", booking_url: "https://kon-tiki.no/tickets", price_band: "standard" }),
      row({ id: "kt4", title: "Kon-Tiki museet (Bygdøy)", provider_id: "p1" }),
      row({ id: "other", title: "Norsk Folkemuseum", provider_id: "p1" }),
    ];
    const clusters = findDuplicateClusters(rows);
    assertEq(clusters.length, 1, "c1: exactly one cluster found");
    const clusterIds = (clusters[0] ?? []).map((r) => r.id).sort();
    assertEq(clusterIds, ["kt1", "kt2", "kt3", "kt4"], "c2: cluster contains all 4 Kon-Tiki rows, transitively chained");

    const plans = buildMergePlans(clusters);
    assertEq(plans.length, 1, "c3: one merge plan");
    assertEq(plans[0]?.canonical.id, "kt3", "c4: richest row (kt3: description+booking_url+price_band) picked as canonical");
    assertEq(
      (plans[0]?.duplicates ?? []).map((d) => d.id).sort(),
      ["kt1", "kt2", "kt4"],
      "c5: the other 3 rows are the duplicates pointing at kt3"
    );

    // Cross-kommune rows never cluster together, even with identical titles.
    const crossKommune: DedupExperienceRow[] = [
      row({ id: "x1", title: "Klatreverket", kommune: "Oslo", provider_id: "p1" }),
      row({ id: "x2", title: "Klatreverket", kommune: "Bergen", provider_id: "p1" }),
    ];
    assertEq(findDuplicateClusters(crossKommune).length, 0, "c6: cross-kommune same-title rows never cluster");

    // Idempotency: a row already merged (canonical_experience_id set) is
    // excluded from clustering, so a re-run over the same data set finds
    // nothing new for it.
    const alreadyMerged: DedupExperienceRow[] = [
      row({ id: "m1", title: "Kon-Tiki Museet", provider_id: "p1" }),
      row({ id: "m2", title: "Kon-Tiki Museum", provider_id: "p1", canonical_experience_id: "m1" }),
    ];
    assertEq(findDuplicateClusters(alreadyMerged).length, 0, "c7: already-merged row excluded -> no re-cluster (idempotent)");
  }

  // ── dedupeResultRows (discover-API belt-and-suspenders invariant) ────
  {
    const rows = [
      { provider_id: "p1", title: "Kon-Tiki Museet" },
      { provider_id: "p1", title: "kon-tiki museet" }, // same provider, same normalized title -> collapses
      { provider_id: "p1", title: "Norsk Folkemuseum" },
      { provider_id: "p2", title: "Kon-Tiki Museet" }, // different provider -> kept
    ];
    const out = dedupeResultRows(rows);
    assertEq(out.length, 3, "e1: exact-normalized-title dupe within same provider collapses to 1");
    assertEq(out.map((r) => r.title), ["Kon-Tiki Museet", "Norsk Folkemuseum", "Kon-Tiki Museet"], "e2: first-seen order preserved, cross-provider row kept");
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/experience-dedup.test.ts`
if (require.main === module) {
  const summary = runExperienceDedupTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
