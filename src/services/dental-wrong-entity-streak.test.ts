/**
 * dental-wrong-entity-streak.test.ts — unit tests for the independent
 * wrong_entity_streak / wrong_entity_unreachable_since backoff added by
 * dev-request 2026-08-23-dental-wrong-entity-streak-parking (2026-08-24).
 *
 * Background: dental_agents already had a 3-strike/30-day "dead-extraction
 * parking" mechanism (extraction_attempts / extraction_unreachable_since,
 * recordDentalExtractionResult() in dental-store.ts, wired into the tests/
 * test.ts "item2a" block). That mechanism tracks ONE failure mode: "fetched
 * fine but never yielded a committable field" (reason:"insufficient_yield
 * ..."). It does NOT track a SEPARATE failure mode: reason:"wrong_entity" —
 * the enrichment sub-agent flagging the fetched page as describing a
 * DIFFERENT clinic (directory listing, wrong chain branch, same-named-but-
 * different clinic). Before this dev-request, a wrong_entity result just
 * released the claim with no backoff, so those records got re-claimed and
 * re-flagged every single cycle forever (see dental-claim-service.ts's own
 * ClaimFilter.excludeParkedExtraction doc comment: "Jasleen Kaur Kainth"
 * (Sunntannhelse.no, wrong-entity) was re-claimed/re-flagged 5 separate
 * days before the sibling extraction-parking flag was even flipped
 * default-ON).
 *
 * This mirrors the RFB `agent_knowledge.wrong_entity_streak` twin (PR #309:
 * "independent wrong_entity_streak backoff for ownership-guard rejections")
 * at the concept level — an INDEPENDENT streak so the two failure kinds
 * never contaminate each other's counter — but reuses dental-store.ts's own
 * stamp-based idiom (DENTAL_PARK_AFTER_ATTEMPTS / DENTAL_PARK_BACKOFF_MS,
 * RE-STAMP-after-expired-backoff) rather than PR #309's rotation-based one.
 *
 * Covers:
 *   (a) 3 consecutive {ok:false, reason:"wrong_entity"} calls -> streak=3,
 *       parked, parked_now on the crossing call; extraction_attempts (the
 *       OTHER counter) stays untouched at 0.
 *   (b) the wrong-entity park excludes the row from the claim pool
 *       (buildWhereClause() / claimBatch), same as the extraction twin.
 *   (c) interaction case (PR #309's own reviewer-flagged, non-blocking
 *       follow-up for RFB — covered here instead of repeated as a gap):
 *       interleaving insufficient_yield and wrong_entity failures on ONE
 *       row does NOT let either counter contaminate the other in either
 *       direction — each only trips its OWN exclusion at its OWN 3rd
 *       strike.
 *   (d) a subsequent {ok:true} call resets BOTH streaks/stamps to 0/NULL
 *       and un-parks the row from BOTH exclusions.
 *   (e) unknown id -> found:false, all counters zeroed in the response.
 *   (f) migration idempotency: re-running initDentalSchema() on an already-
 *       migrated DB handle doesn't throw and doesn't clobber existing
 *       streak values (mirrors this file's idempotent-ALTER idiom).
 *
 * Existing extraction_attempts/insufficient_yield regression coverage
 * (3-strike park, success reset, RE-STAMP-after-expired-backoff) already
 * lives in tests/test.ts's "item2a" block, unmodified by this dev-request —
 * this file does not duplicate it, but running the full `npm test` suite
 * before/after this change confirms it stays green.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-wrong-entity-streak.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runDentalWrongEntityStreakTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalWrongEntityStreakTests(opts: { log?: boolean } = {}): TestSummary {
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

  const prevPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";

  const dbFacPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("./dental-store");
  const dentalClaimPath = require.resolve("./dental-claim-service");
  const cachePaths = [dbFacPath, dentalStorePath, dentalClaimPath];
  for (const p of cachePaths) delete require.cache[p];

  const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
  dbFactory.__resetDbFactoryForTesting();
  const dstore = require("./dental-store") as typeof import("./dental-store");
  const { claimBatch, releaseBatch } =
    require("./dental-claim-service") as typeof import("./dental-claim-service");

  try {
    const dentalDb = dbFactory.getDb("dental");

    // ── (a) 3-strike wrong_entity park; extraction_attempts untouched ──────
    const idA = dstore.createDentalAgent({ navn: "Jasleen Kaur Kainth Test AS", org_nr: "911400111" } as any);

    let r = dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    assertEq(r.wrong_entity_streak, 1, "wes-01: first wrong_entity failure -> wrong_entity_streak=1");
    assertEq(r.wrong_entity_parked, false, "wes-02: not parked after 1 strike");
    assertEq(r.attempts, 0, "wes-03: extraction_attempts (the OTHER counter) untouched by wrong_entity failures");

    r = dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    assertEq(r.wrong_entity_streak, 2, "wes-04: second wrong_entity failure -> wrong_entity_streak=2");
    assertEq(r.wrong_entity_parked, false, "wes-05: still not parked before 3 strikes");

    r = dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    assertEq(r.wrong_entity_streak, 3, "wes-06: third wrong_entity failure -> wrong_entity_streak=3");
    assertEq(r.wrong_entity_parked, true, "wes-07: third failure -> parked");
    assertEq(r.wrong_entity_parked_now, true, "wes-08: parked_now flagged on the crossing failure");
    assertEq(r.attempts, 0, "wes-09: extraction_attempts still 0 after 3 wrong_entity failures");
    assertEq(r.parked, false, "wes-10: extraction-parked flag (the OTHER exclusion) still false");

    // ── (b) claim-pool exclusion: wrong-entity park excludes the row ───────
    const idB = dstore.createDentalAgent({ navn: "Ekte Tannlege Wrong Entity AS", org_nr: "911400222" } as any);
    const claimed1 = claimBatch("wes-worker1", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
    assertEq(claimed1.includes(idA), false, "wes-11: wrong-entity-parked row excluded by excludeParkedExtraction:true");
    assertEq(claimed1.includes(idB), true, "wes-12: never-parked row included by excludeParkedExtraction:true");
    releaseBatch("wes-worker1", [idA, idB]);

    // default (omitted) also applies -- same flag gates both stamps.
    const claimedDefault = claimBatch("wes-worker1b", 10, {}).map((c: any) => c.id);
    assertEq(claimedDefault.includes(idA), false, "wes-13: omitted excludeParkedExtraction excludes wrong-entity-parked row by default (same flag as extraction twin)");
    releaseBatch("wes-worker1b", [idA, idB]);

    // explicit opt-out still works for wrong-entity parking too.
    const claimedOptOut = claimBatch("wes-worker1c", 10, { excludeParkedExtraction: false }).map((c: any) => c.id);
    assertEq(claimedOptOut.includes(idA), true, "wes-14: excludeParkedExtraction:false opts out of the wrong-entity exclusion too");
    releaseBatch("wes-worker1c", [idA, idB]);

    // ── (c) interaction: interleaved wrong_entity + insufficient_yield ─────
    // never contaminate each other's counter, in EITHER direction.
    const idC = dstore.createDentalAgent({ navn: "Interleaved Failure Test AS", org_nr: "911400333" } as any);
    dstore.recordDentalExtractionResult(idC, false, "wrong_entity");
    dstore.recordDentalExtractionResult(idC, false, "insufficient_yield: PUTS_OK=1 < 3");
    dstore.recordDentalExtractionResult(idC, false, "wrong_entity");
    dstore.recordDentalExtractionResult(idC, false, "insufficient_yield: PUTS_OK=0 < 3");
    r = dstore.recordDentalExtractionResult(idC, false, "wrong_entity");
    assertEq(r.wrong_entity_streak, 3, "wes-15: 3 wrong_entity failures interleaved with insufficient_yield still reach streak=3");
    assertEq(r.wrong_entity_parked, true, "wes-16: interleaved wrong_entity failures still trip the wrong-entity park at its 3rd strike");
    assertEq(r.attempts, 2, "wes-17: the 2 interleaved insufficient_yield failures land on extraction_attempts, untouched by the wrong_entity calls");
    assertEq(r.parked, false, "wes-18: only 2 insufficient_yield failures -> extraction park NOT tripped (no cross-contamination)");

    const idD = dstore.createDentalAgent({ navn: "Interleaved Reverse Test AS", org_nr: "911400444" } as any);
    dstore.recordDentalExtractionResult(idD, false, "insufficient_yield: PUTS_OK=2 < 3");
    dstore.recordDentalExtractionResult(idD, false, "wrong_entity");
    dstore.recordDentalExtractionResult(idD, false, "insufficient_yield: PUTS_OK=1 < 3");
    r = dstore.recordDentalExtractionResult(idD, false, "insufficient_yield: PUTS_OK=0 < 3");
    assertEq(r.attempts, 3, "wes-19: 3 insufficient_yield failures interleaved with wrong_entity still reach attempts=3");
    assertEq(r.parked, true, "wes-20: interleaved insufficient_yield failures still trip the extraction park at its 3rd strike");
    assertEq(r.wrong_entity_streak, 1, "wes-21: the 1 interleaved wrong_entity failure lands on wrong_entity_streak, untouched by the insufficient_yield calls");
    assertEq(r.wrong_entity_parked, false, "wes-22: only 1 wrong_entity failure -> wrong-entity park NOT tripped (no cross-contamination)");

    // idC and idD each excluded from the pool by exactly their OWN tripped exclusion.
    const claimedInteraction = claimBatch("wes-worker2", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
    assertEq(claimedInteraction.includes(idC), false, "wes-23: idC (wrong-entity-tripped) excluded from claim pool");
    assertEq(claimedInteraction.includes(idD), false, "wes-24: idD (extraction-tripped) excluded from claim pool");
    releaseBatch("wes-worker2", [idC, idD]);

    // ── (d) ok:true resets BOTH streaks/stamps and un-parks from BOTH ──────
    r = dstore.recordDentalExtractionResult(idA, true);
    assertEq(r.wrong_entity_streak, 0, "wes-25: success resets wrong_entity_streak to 0");
    assertEq(r.wrong_entity_parked, false, "wes-26: success clears the wrong-entity park");
    assertEq(r.attempts, 0, "wes-27: success also resets extraction_attempts to 0 (existing behaviour, unchanged)");
    assertEq(r.parked, false, "wes-28: success also clears the extraction park (existing behaviour, unchanged)");

    const rowA = dentalDb
      .prepare("SELECT wrong_entity_streak, wrong_entity_unreachable_since, extraction_attempts, extraction_unreachable_since FROM dental_agents WHERE id = ?")
      .get(idA) as any;
    assertEq(rowA.wrong_entity_streak, 0, "wes-29: DB row wrong_entity_streak column is 0 after success");
    assertEq(rowA.wrong_entity_unreachable_since, null, "wes-30: DB row wrong_entity_unreachable_since column is NULL after success");
    assertEq(rowA.extraction_attempts, 0, "wes-31: DB row extraction_attempts column is 0 after success");
    assertEq(rowA.extraction_unreachable_since, null, "wes-32: DB row extraction_unreachable_since column is NULL after success");

    const claimedAfterSuccess = claimBatch("wes-worker3", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
    assertEq(claimedAfterSuccess.includes(idA), true, "wes-33: success un-parks idA from the claim pool (both exclusions cleared)");
    releaseBatch("wes-worker3", [idA, idB, idC, idD]);

    // RE-STAMP after expired backoff applies to wrong_entity_unreachable_since too.
    dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    dentalDb.prepare("UPDATE dental_agents SET wrong_entity_unreachable_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), idA);
    r = dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    assertEq(r.wrong_entity_parked_now, true, "wes-34: wrong_entity failure after expired backoff RE-STAMPS the park (same fix as the extraction twin)");
    assertEq(r.wrong_entity_streak, 4, "wes-35: RE-STAMP re-stamps the timestamp only -- streak keeps incrementing since last success");

    // ── (e) unknown id -> found:false, all counters zeroed ─────────────────
    const rUnknown = dstore.recordDentalExtractionResult("no-such-id", false, "wrong_entity");
    assertEq(rUnknown.found, false, "wes-36: unknown id -> found=false");
    assertEq(rUnknown.wrong_entity_streak, 0, "wes-37: unknown id -> wrong_entity_streak=0 in response");
    assertEq(rUnknown.wrong_entity_parked, false, "wes-38: unknown id -> wrong_entity_parked=false in response");

    // ── (f) migration idempotency ───────────────────────────────────────────
    // Re-running initDentalSchema() against the already-migrated in-memory
    // handle must not throw (idempotent ALTER, caught) and must not clobber
    // the streak value already accumulated on idA above.
    const streakBeforeRerun = (
      dentalDb.prepare("SELECT wrong_entity_streak FROM dental_agents WHERE id = ?").get(idA) as any
    ).wrong_entity_streak;
    let migrationRerunThrew = false;
    try {
      dbFactory.initDentalSchema(dentalDb);
    } catch {
      migrationRerunThrew = true;
    }
    assertTrue(!migrationRerunThrew, "wes-39: re-running initDentalSchema() on an already-migrated DB does not throw");
    const streakAfterRerun = (
      dentalDb.prepare("SELECT wrong_entity_streak FROM dental_agents WHERE id = ?").get(idA) as any
    ).wrong_entity_streak;
    assertEq(streakAfterRerun, streakBeforeRerun, "wes-40: re-running initDentalSchema() does not reset/clobber an existing wrong_entity_streak value");

    if (log) console.log(`  dental-wrong-entity-streak: OK (${passed} assertions)`);
  } catch (err) {
    failed++;
    failures.push(`dental-wrong-entity-streak: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevPath;
    dbFactory.__resetDbFactoryForTesting();
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/dental-wrong-entity-streak.test.ts`
if (require.main === module) {
  const summary = runDentalWrongEntityStreakTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
