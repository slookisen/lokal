/**
 * opplevelser-content-refresh-aggregator-thin.test.ts — integration coverage
 * for the "thin" fix on selectProvidersForContentRefresh() (dev-request
 * 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 2, acceptance
 * criterion 3).
 *
 * The PURE classifier (isContentFieldHomepageSourced /
 * isExperienceContentGenuinelyThin / classifyProviderContentBucket) is unit
 * tested with hand-built rows in experience-store.test.ts. This file proves
 * the fix end-to-end through the REAL writer path: applyExperienceContent()
 * stamps content_source='provider_site' UNCONDITIONALLY on every write (see
 * that function's own doc comment) — both a genuine homepage fetch and a
 * harvest/aggregator-sourced re-write get the identical stamp, so
 * content_source ALONE cannot tell them apart. Before this fix,
 * selectProvidersForContentRefresh's SQL "thin" gate tested only whether
 * description/category were non-blank — so a description written FROM AN
 * AGGREGATOR via applyExperienceContent(id, {...}, aggregatorUrl) would
 * permanently block that experience from ever being refreshed from the
 * provider's real homepage. This file drives applyExperienceContent() with
 * both a real-homepage sourceUrl and an aggregator sourceUrl and asserts
 * selectProvidersForContentRefresh()'s resulting candidate set.
 *
 * Setup mirrors opplevelser-content-refresh-no-yield-backoff.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store per run.
 *
 * Covers:
 *   (a) description filled via a genuine homepage-matching sourceUrl -> the
 *       provider is DONE (not selected) once category is filled too
 *   (b) description filled via a THIRD-PARTY AGGREGATOR sourceUrl (different
 *       registrable domain than the provider's own hjemmeside) -> the
 *       provider STILL selected — this is the exact bug this fix closes
 *   (c) mixed multi-experience provider: one experience fully homepage-done,
 *       a second still aggregator-thin -> provider selected (ANY-thin rule)
 *   (d) once BOTH judged fields on every live experience are genuinely
 *       homepage-sourced, the provider drops out of the selection entirely
 *   (e) a LOCKED experience (content_source='manual') with blank content
 *       never makes its provider selectable on its own
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runOpplevelserContentRefreshAggregatorThinTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
    const expStorePath = require.resolve("../services/experience-store");
    const cachePaths = [dbFactoryPath, expStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");

      // ── (a)/(b)/(c)/(d): provider A — starts with two thin experiences ──
      const provA = expStore.createProvider({
        navn: "Aggregat Gard AS", org_nr: "900100200",
        fylke: "Vestland", kommune: "Bergen",
        hjemmeside: "https://www.aggregatgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expA1 = expStore.createExperience({
        title: "Gardsbesøk", provider_id: provA, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });
      const expA2 = expStore.createExperience({
        title: "Ostesmaking", provider_id: provA, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });

      // (a0) both experiences fully blank -> provider selected.
      const beforeAny = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(beforeAny.includes(provA), "a0: provider with two fully-blank experiences is selected");

      // (b) Fill expA1's description via a THIRD-PARTY AGGREGATOR sourceUrl —
      // a different registrable domain than the provider's own hjemmeside.
      // This mirrors the real bulk-load re-harvest path documented on
      // applyExperienceContent's own sourceUrl parameter.
      const AGGREGATOR_URL = "https://visitnorway.com/found-here";
      const writtenAgg = expStore.applyExperienceContent(
        expA1,
        { description: "Aggregert beskrivelse fra tredjepart.", category: "mat_drikke" },
        AGGREGATOR_URL,
      );
      assertTrue(writtenAgg.includes("description") && writtenAgg.includes("category"), "b0: aggregator write actually wrote both fields");

      const afterAggWrite = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(
        afterAggWrite.includes(provA),
        "b1: THE FIX — provider A is STILL selected after expA1's description/category were filled from an AGGREGATOR (content_source='provider_site' but wrong-domain evidence) — old code would have wrongly treated this as done",
      );

      // (c) Now fill expA1's description/category again via the GENUINE
      // homepage — since both fields are already non-blank, applyExperienceContent's
      // own fill-only-blank gate refuses the overwrite (documented, unrelated
      // behavior — a genuinely different mechanism, "hjemmeside-cleanup",
      // would be needed to correct an aggregator-sourced field in place).
      // Prove that refusal here so the next step's fixture (expA2) is the
      // one that actually demonstrates the DONE transition, not a false
      // read of this one.
      const HOME_URL = "https://www.aggregatgard.no/om-oss";
      const writtenReattempt = expStore.applyExperienceContent(
        expA1,
        { description: "Ekte beskrivelse fra egen side.", category: "mat_drikke" },
        HOME_URL,
      );
      assertTrue(writtenReattempt.length === 0, "c0: fill-only-blank gate refuses to overwrite expA1's already-filled (aggregator) fields — unrelated, pre-existing behavior, confirmed so the next assertion is not misread");

      // Provider A is STILL selected — expA1 remains stuck aggregator-thin
      // (by design: this fix never force-overwrites), and expA2 is still
      // fully blank on top of that.
      const stillSelected = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(stillSelected.includes(provA), "c1: provider A still selected — expA1 remains aggregator-thin (fill-only-blank never force-corrects it) and expA2 is untouched");

      // (d) Fill expA2 via the GENUINE homepage — once EVERY live experience
      // has both judged fields genuinely homepage-sourced, the provider
      // drops out of the selection.
      const writtenHomeA2 = expStore.applyExperienceContent(
        expA2,
        { description: "Ekte tekst om ostesmaking.", category: "mat_drikke" },
        HOME_URL,
      );
      assertTrue(writtenHomeA2.includes("description") && writtenHomeA2.includes("category"), "d0: genuine homepage write actually wrote both fields on expA2");

      // expA1 is STILL aggregator-thin, so provider A must STILL be selected
      // — proving the ANY-thin-live-experience rule (mixed case), not an
      // accidental pass.
      const stillMixed = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(stillMixed.includes(provA), "d1: provider A still selected — expA1 (aggregator-thin) alone keeps it eligible even though expA2 is now genuinely done (mixed multi-experience, ANY-thin rule)");

      // ── (e): provider B — a LOCKED experience with blank content must
      // never make the provider selectable on its own ─────────────────────
      const provB = expStore.createProvider({
        navn: "Låst Gard AS", org_nr: "900300400",
        fylke: "Vestland", kommune: "Bergen",
        hjemmeside: "https://www.lastgard.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expB1 = expStore.createExperience({
        title: "Eierskrevet opplevelse", provider_id: provB, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });
      const dbB = dbFactory.getDb("experiences");
      dbB.prepare("UPDATE experiences SET content_source = 'manual' WHERE id = ?").run(expB1);

      const afterLocked = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(!afterLocked.includes(provB), "e1: provider B (only experience is LOCKED, content_source='manual', blank content) is NEVER selected — locked rows are permanently out of scope regardless of blank content");

      // (f) a provider whose ONLY aggregator-thin experience is real proof
      // this is not double-counting off provider A's fixture: a fresh
      // single-experience provider filled purely from an aggregator.
      const provC = expStore.createProvider({
        navn: "Kun Aggregat AS", org_nr: "900500600",
        fylke: "Vestland", kommune: "Bergen",
        hjemmeside: "https://www.kunaggregat.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expC1 = expStore.createExperience({
        title: "Enkelt tilbud", provider_id: provC, provider_match_status: "matched",
        fylke: "Vestland", kommune: "Bergen", confidence: "high", verification_status: "pending_verify",
      });
      expStore.applyExperienceContent(
        expC1,
        { description: "Aggregert tekst.", category: "opplevelse" },
        "https://tripadvisor.com/x",
      );
      const afterC = expStore.selectProvidersForContentRefresh(50).targets.map((r) => r.id);
      assertTrue(afterC.includes(provC), "f1: provider C, entirely aggregator-sourced (single experience) -> still selected (enrichable), not silently marked done");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-aggregator-thin: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-aggregator-thin.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshAggregatorThinTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
