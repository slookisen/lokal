/**
 * experience-store-lock-split.test.ts — unit/integration tests for the
 * owner-lock / published-lock SPLIT (dev-request 2026-09-02-experiences-
 * laas-todeling-fyll-tomme-felt-publiserte-rader).
 *
 * Background: before this dev-request, isExperienceContentLocked(row) was a
 * single boolean — `verification_status === 'verified' OR content_source IN
 * ('manual','claim')` — and every content writer treated a PUBLISHED
 * (verified) row exactly as locked as a human-authored one. Since
 * PUBLISH_GATE_SQL requires verification_status='verified', this meant NO
 * published row could ever receive homepage content from the enrichment
 * pipeline (measured: 0 of 160 sampled published rows enriched). This
 * dev-request splits the lock into isExperienceOwnerLocked (manual/claim —
 * full lock, unchanged) and isExperiencePublished (verified — now
 * "fill-blank-only": a genuinely EMPTY field may be filled from the
 * ownership-verified homepage; a NON-empty field is never overwritten).
 *
 * The PURE per-field-provenance classifier itself (isContentFieldHomepageSourced
 * etc.) is unit tested with hand-built rows in experience-store.test.ts, same
 * split as opplevelser-content-refresh-aggregator-thin.test.ts's own doc
 * comment describes. This file proves the lock split end-to-end through the
 * REAL writer/selector paths, mirroring that file's setup exactly
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store per run).
 *
 * Covers:
 *   (a) published row + blank description + verified homepage sourceUrl ->
 *       applyExperienceContent writes description, stamps
 *       content_field_evidence[description]=sourceUrl,
 *       content_source='provider_site'
 *   (b) published row + NON-blank description -> applyExperienceContent
 *       leaves description untouched byte-for-byte, but a blank SIBLING
 *       field (category) on the same row still gets filled
 *       (locked_overwrite_rate=0 — AC2)
 *   (c) content_source='claim' + verified (both halves of the OLD lock) ->
 *       applyExperienceContent returns [], nothing touched
 *   (d) content_source='manual' + verified -> same as (c)
 *   (e) isExperienceContentGenuinelyThin: published+blank -> true (now
 *       "enrichable", not permanently "done"); claim+blank -> false (still
 *       fully out of scope)
 *   (f) selectProvidersForContentRefresh now returns a provider whose ONLY
 *       live experience is published+blank — before this dev-request this
 *       returned empty (the SQL pre-filter itself excluded verified rows)
 *   (g) isExperienceOwnerLocked / isExperiencePublished /
 *       isExperienceContentLocked — direct predicate sanity across the four
 *       content_source x verification_status combinations that matter
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceStoreLockSplitTests(
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
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, expStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      const HOMEPAGE_URL = "https://www.laasetun.no/om-oss";

      // ── (a) published + blank description -> filled, evidence stamped ──
      const provA = expStore.createProvider({
        navn: "Laasetun Opplevelser AS", org_nr: "900111222",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.laasetun.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expA = expStore.createExperience({
        title: "Fjelltur med guide", provider_id: provA, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high",
        verification_status: "verified", // PUBLISHED
        content_source: null,
      });
      const writtenA = expStore.applyExperienceContent(
        expA,
        { description: "En fin fjelltur med lokal guide og kaffepause på toppen." },
        HOMEPAGE_URL,
      );
      assertEq(writtenA, ["description"], "a1: published row with blank description -> applyExperienceContent writes description");
      const rowA = db.prepare(
        "SELECT description, content_source, content_field_evidence, verification_status FROM experiences WHERE id = ?",
      ).get(expA) as { description: string; content_source: string; content_field_evidence: string | null; verification_status: string };
      assertEq(rowA.description, "En fin fjelltur med lokal guide og kaffepause på toppen.", "a2: description was actually persisted");
      assertEq(rowA.content_source, "provider_site", "a3: content_source stamped 'provider_site' (row was not owner-locked)");
      assertEq(rowA.verification_status, "verified", "a4: verification_status untouched — still published");
      const evidenceA = expStore.parseContentFieldEvidence(rowA.content_field_evidence);
      assertEq(evidenceA.description, HOMEPAGE_URL, "a5: content_field_evidence.description stamped with the homepage URL");

      // ── (b) published + NON-blank description -> untouched byte-for-byte;
      //     a blank SIBLING field (category) on the SAME row still fills ──
      const provB = expStore.createProvider({
        navn: "Blank Sibling AS", org_nr: "900111333",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.blanksibling.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const ORIGINAL_DESCRIPTION = "Original, allerede skrevet beskrivelse som ALDRI skal overskrives.";
      const expB = expStore.createExperience({
        title: "Kajakktur i fjorden", provider_id: provB, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high",
        verification_status: "verified", // PUBLISHED
        content_source: null,
        description: ORIGINAL_DESCRIPTION,
      });
      const writtenB = expStore.applyExperienceContent(
        expB,
        {
          description: "Forsøk på å overskrive — skal IKKE skje (locked_overwrite_rate=0).",
          category: "vann_aktiviteter",
        },
        "https://www.blanksibling.no/om-oss",
      );
      assertEq(writtenB, ["category"], "b1: only the blank sibling field (category) is reported as written");
      const rowB = db.prepare(
        "SELECT description, category, content_source, content_field_evidence FROM experiences WHERE id = ?",
      ).get(expB) as { description: string; category: string; content_source: string; content_field_evidence: string | null };
      assertEq(rowB.description, ORIGINAL_DESCRIPTION, "b2: description is BYTE-FOR-BYTE unchanged (locked_overwrite_rate=0, AC2)");
      assertEq(rowB.category, "vann_aktiviteter", "b3: category (blank sibling field) WAS filled");
      assertEq(rowB.content_source, "provider_site", "b4: content_source still stamped for the row (a genuine write happened)");
      const evidenceB = expStore.parseContentFieldEvidence(rowB.content_field_evidence);
      // createExperience() itself stamps a provenance entry for any non-blank
      // field at INSERT time (harvestProvenanceOf(evidence_url) — here the
      // sentinel, since no evidence_url was given): this row's description
      // ALREADY carried that entry before applyExperienceContent ever ran.
      // The point of this assertion is that applyExperienceContent did not
      // touch it — it must be exactly the pre-existing insert-time value.
      assertEq(evidenceB.description, "harvest:no-evidence-url", "b5: the description's content_field_evidence entry is the ORIGINAL insert-time stamp, untouched by applyExperienceContent (no new entry invented, old one not overwritten either)");
      assertEq(evidenceB.category, "https://www.blanksibling.no/om-oss", "b6: content_field_evidence.category stamped for the field that WAS written");

      // ── (c) content_source='claim' + verified -> [] nothing touched ────
      const provC = expStore.createProvider({
        navn: "Claim Gard AS", org_nr: "900111444",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.claimgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expC = expStore.createExperience({
        title: "Gardsbesøk", provider_id: provC, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high",
        verification_status: "verified", content_source: "claim",
      });
      const writtenC = expStore.applyExperienceContent(
        expC, { description: "Skal aldri skrives — claim-eid rad." }, "https://www.claimgard.no/om-oss",
      );
      assertEq(writtenC, [], "c1: content_source='claim' (owner-locked) + published -> [] regardless of published-ness");
      const rowC = db.prepare("SELECT description, content_source FROM experiences WHERE id = ?").get(expC) as { description: string | null; content_source: string };
      assertEq(rowC.description, null, "c2: description remains blank — nothing written");
      assertEq(rowC.content_source, "claim", "c3: content_source untouched — still 'claim'");

      // ── (d) content_source='manual' + verified -> same as (c) ──────────
      const provD = expStore.createProvider({
        navn: "Manual Gard AS", org_nr: "900111555",
        fylke: "Vestland", kommune: "Bergen", hjemmeside: "https://www.manualgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expD = expStore.createExperience({
        title: "Gardsbesøk", provider_id: provD, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high",
        verification_status: "verified", content_source: "manual",
      });
      const writtenD = expStore.applyExperienceContent(
        expD, { description: "Skal aldri skrives — manuelt eid rad." }, "https://www.manualgard.no/om-oss",
      );
      assertEq(writtenD, [], "d1: content_source='manual' (owner-locked) + published -> [] regardless of published-ness");
      const rowD = db.prepare("SELECT description, content_source FROM experiences WHERE id = ?").get(expD) as { description: string | null; content_source: string };
      assertEq(rowD.description, null, "d2: description remains blank — nothing written");
      assertEq(rowD.content_source, "manual", "d3: content_source untouched — still 'manual'");

      // ── (e) isExperienceContentGenuinelyThin: published+blank -> true;
      //     claim+blank -> false ──────────────────────────────────────────
      const publishedBlank = { content_source: null, verification_status: "verified", description: null, category: null, content_field_evidence: null };
      assertTrue(
        expStore.isExperienceContentGenuinelyThin(publishedBlank, "laasetun.no"),
        "e1: a PUBLISHED row with blank description/category IS genuinely thin (enrichable, not permanently done)",
      );
      const claimBlank = { content_source: "claim", verification_status: "pending_verify", description: null, category: null, content_field_evidence: null };
      assertTrue(
        !expStore.isExperienceContentGenuinelyThin(claimBlank, "laasetun.no"),
        "e2: a CLAIM-authored row with blank description/category is NOT thin — owner-locked rows stay fully out of scope",
      );
      const manualBlank = { content_source: "manual", verification_status: "pending_verify", description: null, category: null, content_field_evidence: null };
      assertTrue(
        !expStore.isExperienceContentGenuinelyThin(manualBlank, "laasetun.no"),
        "e3: a MANUAL-authored row with blank description/category is NOT thin either",
      );

      // ── (f) selectProvidersForContentRefresh selects a provider whose ONLY
      //     live experience is PUBLISHED + blank (previously: empty result,
      //     because the old SQL pre-filter excluded verification_status=
      //     'verified' unconditionally) ───────────────────────────────────
      const provF = expStore.createProvider({
        navn: "Publisert Uten Innhold AS", org_nr: "900111666",
        fylke: "Troms", kommune: "Tromsø", hjemmeside: "https://www.publisertutennhold.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Snøscooter-safari", provider_id: provF, provider_match_status: "matched",
        fylke: "Troms", kommune: "Tromsø", confidence: "high",
        verification_status: "verified", // PUBLISHED
        content_source: null,
        // description/category both left blank
      });
      const selectionF = expStore.selectProvidersForContentRefresh(25);
      assertTrue(
        selectionF.targets.some((t) => t.id === provF),
        "f1: a provider whose ONLY live experience is published+blank IS now selected (was empty before this dev-request's SQL fix)",
      );

      // ── (g) predicate sanity — the four combinations that matter ───────
      assertTrue(expStore.isExperienceOwnerLocked({ content_source: "manual" }), "g1: isExperienceOwnerLocked('manual') -> true");
      assertTrue(expStore.isExperienceOwnerLocked({ content_source: "claim" }), "g2: isExperienceOwnerLocked('claim') -> true");
      assertTrue(!expStore.isExperienceOwnerLocked({ content_source: "provider_site" }), "g3: isExperienceOwnerLocked('provider_site') -> false");
      assertTrue(!expStore.isExperienceOwnerLocked({ content_source: null }), "g4: isExperienceOwnerLocked(null) -> false");
      assertTrue(expStore.isExperiencePublished({ verification_status: "verified" }), "g5: isExperiencePublished('verified') -> true");
      assertTrue(!expStore.isExperiencePublished({ verification_status: "pending_verify" }), "g6: isExperiencePublished('pending_verify') -> false");
      assertTrue(!expStore.isExperiencePublished({ verification_status: null }), "g7: isExperiencePublished(null) -> false");
      // isExperienceContentLocked stays the OR of both — unchanged semantics,
      // still used by the OVERWRITE callers (price-freshness).
      assertTrue(expStore.isExperienceContentLocked({ content_source: "manual", verification_status: "pending_verify" }), "g8: isExperienceContentLocked still true for owner-locked-only");
      assertTrue(expStore.isExperienceContentLocked({ content_source: null, verification_status: "verified" }), "g9: isExperienceContentLocked still true for published-only");
      assertTrue(!expStore.isExperienceContentLocked({ content_source: null, verification_status: "pending_verify" }), "g10: isExperienceContentLocked false when neither owner-locked nor published");
    } catch (err: any) {
      failed++;
      failures.push("experience-store-lock-split: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperienceStoreLockSplitTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
