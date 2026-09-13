/**
 * dental-any-failure-streak.test.ts — unit tests for the FOURTH, independent
 * any_failure_streak / any_failure_unreachable_since backoff added by
 * dev-request 2026-09-11-dental-completion-mode-filter-mangler-parkerings-
 * eksklusjon (2026-09-13).
 *
 * Background: dental_agents already had THREE independent 3-strike/30-day
 * parking mechanisms — homepage_fetch_attempts, extraction_attempts,
 * wrong_entity_streak (see dental-wrong-entity-streak.test.ts) — each of
 * which requires 3 CONSECUTIVE failures of its OWN specific kind before it
 * trips. The filed report (dental-enrichment-runs/2026-09-11.md's FUNN,
 * repeated 10x since 2026-08-31) claimed the completion-mode claim filter
 * was simply missing the `excludeParkedExtraction` clause. Reading the
 * actual code (dental-claim-service.ts's buildWhereClause()) shows that
 * claim is FALSE: the clause is applied unconditionally regardless of
 * `enrichment_state`. The REAL bug, confirmed against prod for the report's
 * own named clinics (Hareid Tannklinikk, Åmot Tannklinikk): their failure
 * classification varies cycle-to-cycle (insufficient_yield one day, dead
 * homepage the next, wrong_entity another day), so NONE of the three
 * existing counters ever individually reaches 3 — each stays at 1 or 2
 * forever, so none of them ever trips the exclusion.
 *
 * This file covers the new counter that fixes exactly that gap:
 *   (a) 3 consecutive failures of MIXED reason (ordinary extraction failure,
 *       then a homepage-fetch failure, then a wrong_entity failure) still
 *       reach any_failure_streak=3 and park via any_failure_unreachable_since
 *       — this is the Hareid/Åmot repro pattern.
 *   (b) the any-failure park excludes the row from the claim pool, gated by
 *       the SAME excludeParkedExtraction flag as the other three (no new
 *       flag).
 *   (c) proxy_blocked homepage-fetch failures do NOT bump any_failure_streak
 *       (mirrors the existing no-strike treatment for the other counters).
 *   (d) a success via EITHER recordDentalHomepageFetchResult(ok:true) or
 *       recordDentalExtractionResult(ok:true) resets any_failure_streak to 0
 *       and un-parks the row from this exclusion.
 *   (e) unknown id -> found:false, any_failure fields zeroed in the
 *       response, for both reporting functions.
 *   (f) RE-STAMP after an expired backoff (same fix as the other three).
 *   (g) this new counter does NOT change the existing three counters' own
 *       values or park thresholds (regression guard — full behavioural
 *       coverage for those three already lives in dental-wrong-entity-
 *       streak.test.ts and tests/test.ts's "item2a" block).
 *   (h) migration idempotency: re-running initDentalSchema() on an
 *       already-migrated DB handle doesn't throw and doesn't clobber an
 *       existing any_failure_streak value.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/dental-any-failure-streak.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runDentalAnyFailureStreakTests() and folds its pass/fail counts into
 *      the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runDentalAnyFailureStreakTests(opts: { log?: boolean } = {}): TestSummary {
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

    // ── (a) mixed-reason cycling reaches any_failure_streak=3 ───────────────
    // Reproduces the exact Hareid/Åmot pattern: a different specific counter
    // trips on each cycle, so none of the three reason-specific streaks ever
    // reaches 3, but any_failure_streak accumulates across all of them.
    const idA = dstore.createDentalAgent({ navn: "Hareid-Amot Repro Test AS", org_nr: "911500111" } as any);

    let r1 = dstore.recordDentalExtractionResult(idA, false, "insufficient_yield: PUTS_OK=2 < 3");
    assertEq(r1.any_failure_streak, 1, "afs-01: ordinary extraction failure -> any_failure_streak=1");
    assertEq(r1.any_failure_parked, false, "afs-02: not parked after 1 strike");
    assertEq(r1.attempts, 1, "afs-03: extraction_attempts (its own counter) also at 1, as before this dev-request");

    let r2 = dstore.recordDentalHomepageFetchResult(idA, false, "dead_homepage");
    assertEq(r2.any_failure_streak, 2, "afs-04: DIFFERENT failure kind (homepage) still accumulates -> any_failure_streak=2");
    assertEq(r2.any_failure_parked, false, "afs-05: still not parked before 3 strikes");
    assertEq(r2.attempts, 1, "afs-06: homepage_fetch_attempts (its own, separate counter) is 1, NOT 2 -- confirms no cross-contamination");

    let r3 = dstore.recordDentalExtractionResult(idA, false, "wrong_entity");
    assertEq(r3.any_failure_streak, 3, "afs-07: a THIRD, again-different failure kind (wrong_entity) crosses the threshold -> any_failure_streak=3");
    assertEq(r3.any_failure_parked, true, "afs-08: third mixed-reason failure -> any_failure parked");
    assertEq(r3.any_failure_parked_now, true, "afs-09: parked_now flagged on the crossing call");
    // None of the three reason-specific counters individually reached 3 --
    // this is exactly the bug this dev-request fixes.
    assertEq(r3.wrong_entity_streak, 1, "afs-10: wrong_entity_streak itself is only 1 (its first occurrence)");
    assertEq(r3.parked, false, "afs-11: the ordinary extraction-park exclusion (attempts=1) is NOT tripped");

    const rowA = dentalDb
      .prepare("SELECT extraction_attempts, homepage_fetch_attempts, wrong_entity_streak, any_failure_streak FROM dental_agents WHERE id = ?")
      .get(idA) as any;
    assertEq(rowA.extraction_attempts, 1, "afs-12: DB extraction_attempts=1 (never reached 3)");
    assertEq(rowA.homepage_fetch_attempts, 1, "afs-13: DB homepage_fetch_attempts=1 (never reached 3)");
    assertEq(rowA.wrong_entity_streak, 1, "afs-14: DB wrong_entity_streak=1 (never reached 3)");
    assertEq(rowA.any_failure_streak, 3, "afs-15: DB any_failure_streak=3 -- the new counter is the ONLY one that tripped");

    // ── (b) claim-pool exclusion ─────────────────────────────────────────
    const idB = dstore.createDentalAgent({ navn: "Ekte Tannlege Any Failure AS", org_nr: "911500222" } as any);
    const claimed1 = claimBatch("afs-worker1", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
    assertEq(claimed1.includes(idA), false, "afs-16: any-failure-parked row excluded by excludeParkedExtraction:true");
    assertEq(claimed1.includes(idB), true, "afs-17: never-parked row included by excludeParkedExtraction:true");
    releaseBatch("afs-worker1", [idA, idB]);

    // Same call shape the SKILL's completion-mode round (§4.1b) actually
    // sends -- no explicit excludeParkedExtraction key at all -- to prove the
    // default-ON gate really does cover the completion-mode call, contrary
    // to the filed report's (incorrect) premise.
    const completionModeFilter = { enrichment_state: "enriched" as const, has_hjemmeside: true };
    const claimedCompletionMode = claimBatch("afs-worker1b", 10, completionModeFilter).map((c: any) => c.id);
    assertEq(claimedCompletionMode.includes(idA), false, "afs-18: completion-mode-shaped filter (no explicit excludeParkedExtraction key) still excludes the any-failure-parked row by default");

    // explicit opt-out still works for the any-failure exclusion too.
    const claimedOptOut = claimBatch("afs-worker1c", 10, { excludeParkedExtraction: false }).map((c: any) => c.id);
    assertEq(claimedOptOut.includes(idA), true, "afs-19: excludeParkedExtraction:false opts out of the any-failure exclusion too");
    releaseBatch("afs-worker1c", [idA, idB]);

    // ── (c) proxy_blocked is a genuine no-op for any_failure_streak too ────
    const idC = dstore.createDentalAgent({ navn: "Proxy Blocked Test AS", org_nr: "911500333" } as any);
    dstore.recordDentalHomepageFetchResult(idC, false, "dead_homepage");
    const beforeProxy = (dentalDb.prepare("SELECT any_failure_streak FROM dental_agents WHERE id = ?").get(idC) as any).any_failure_streak;
    assertEq(beforeProxy, 1, "afs-20 setup: idC has any_failure_streak=1 before the proxy_blocked call");
    const proxyResult = dstore.recordDentalHomepageFetchResult(idC, false, "proxy_blocked");
    assertEq(proxyResult.any_failure_streak, 1, "afs-21: proxy_blocked does not increment any_failure_streak");
    assertEq(proxyResult.any_failure_parked_now, false, "afs-22: proxy_blocked never parks via any_failure");
    const afterProxy = (dentalDb.prepare("SELECT any_failure_streak FROM dental_agents WHERE id = ?").get(idC) as any).any_failure_streak;
    assertEq(afterProxy, 1, "afs-23: DB any_failure_streak unchanged by proxy_blocked");

    // ── (d) success resets any_failure_streak, via EITHER reporting fn ─────
    let r4 = dstore.recordDentalExtractionResult(idA, true);
    assertEq(r4.any_failure_streak, 0, "afs-24: recordDentalExtractionResult(ok:true) resets any_failure_streak to 0");
    assertEq(r4.any_failure_parked, false, "afs-25: success clears the any-failure park");
    const rowAAfterSuccess = dentalDb
      .prepare("SELECT any_failure_streak, any_failure_unreachable_since FROM dental_agents WHERE id = ?")
      .get(idA) as any;
    assertEq(rowAAfterSuccess.any_failure_streak, 0, "afs-26: DB any_failure_streak column is 0 after success");
    assertEq(rowAAfterSuccess.any_failure_unreachable_since, null, "afs-27: DB any_failure_unreachable_since column is NULL after success");

    const claimedAfterSuccess = claimBatch("afs-worker2", 10, { excludeParkedExtraction: true }).map((c: any) => c.id);
    assertEq(claimedAfterSuccess.includes(idA), true, "afs-28: success un-parks idA from the any-failure exclusion");
    releaseBatch("afs-worker2", [idA, idB, idC]);

    // recordDentalHomepageFetchResult(ok:true) also resets it.
    dstore.recordDentalExtractionResult(idC, false, "insufficient_yield: PUTS_OK=0 < 3");
    dstore.recordDentalExtractionResult(idC, false, "insufficient_yield: PUTS_OK=0 < 3");
    const r5 = dstore.recordDentalHomepageFetchResult(idC, true);
    assertEq(r5.any_failure_streak, 0, "afs-29: recordDentalHomepageFetchResult(ok:true) also resets any_failure_streak to 0");

    // ── (e) unknown id -> found:false, any_failure fields zeroed ────────────
    const rUnknownExtraction = dstore.recordDentalExtractionResult("no-such-id", false, "wrong_entity");
    assertEq(rUnknownExtraction.found, false, "afs-30: unknown id -> found=false (extraction)");
    assertEq(rUnknownExtraction.any_failure_streak, 0, "afs-31: unknown id -> any_failure_streak=0 in response (extraction)");
    assertEq(rUnknownExtraction.any_failure_parked, false, "afs-32: unknown id -> any_failure_parked=false in response (extraction)");

    const rUnknownHomepage = dstore.recordDentalHomepageFetchResult("no-such-id", false);
    assertEq(rUnknownHomepage.found, false, "afs-33: unknown id -> found=false (homepage)");
    assertEq(rUnknownHomepage.any_failure_streak, 0, "afs-34: unknown id -> any_failure_streak=0 in response (homepage)");

    // ── (f) RE-STAMP after expired backoff ──────────────────────────────────
    const idF = dstore.createDentalAgent({ navn: "Restamp Test AS", org_nr: "911500444" } as any);
    dstore.recordDentalExtractionResult(idF, false, "insufficient_yield: PUTS_OK=0 < 3");
    dstore.recordDentalHomepageFetchResult(idF, false, "dead_homepage");
    dstore.recordDentalExtractionResult(idF, false, "wrong_entity");
    dentalDb.prepare("UPDATE dental_agents SET any_failure_unreachable_since = ? WHERE id = ?")
      .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), idF);
    const rRestamp = dstore.recordDentalExtractionResult(idF, false, "insufficient_yield: PUTS_OK=0 < 3");
    assertEq(rRestamp.any_failure_parked_now, true, "afs-35: a failure after expired backoff RE-STAMPS the any-failure park");
    assertEq(rRestamp.any_failure_streak, 4, "afs-36: RE-STAMP re-stamps the timestamp only -- streak keeps incrementing since last success");

    // ── (g) the three existing counters are unaffected by this addition ────
    const idG = dstore.createDentalAgent({ navn: "Existing Counters Unaffected AS", org_nr: "911500555" } as any);
    dstore.recordDentalExtractionResult(idG, false, "insufficient_yield: PUTS_OK=0 < 3");
    dstore.recordDentalExtractionResult(idG, false, "insufficient_yield: PUTS_OK=0 < 3");
    const rG = dstore.recordDentalExtractionResult(idG, false, "insufficient_yield: PUTS_OK=0 < 3");
    assertEq(rG.parked, true, "afs-37: 3 consecutive SAME-reason failures still trip the ordinary extraction park exactly as before");
    assertEq(rG.any_failure_streak, 3, "afs-38: the new counter also reaches 3 in this same-reason case (both trip together, as expected)");

    // ── (h) migration idempotency ────────────────────────────────────────
    const streakBeforeRerun = (
      dentalDb.prepare("SELECT any_failure_streak FROM dental_agents WHERE id = ?").get(idF) as any
    ).any_failure_streak;
    let migrationRerunThrew = false;
    try {
      dbFactory.initDentalSchema(dentalDb);
    } catch {
      migrationRerunThrew = true;
    }
    assertTrue(!migrationRerunThrew, "afs-39: re-running initDentalSchema() on an already-migrated DB does not throw");
    const streakAfterRerun = (
      dentalDb.prepare("SELECT any_failure_streak FROM dental_agents WHERE id = ?").get(idF) as any
    ).any_failure_streak;
    assertEq(streakAfterRerun, streakBeforeRerun, "afs-40: re-running initDentalSchema() does not reset/clobber an existing any_failure_streak value");

    if (log) console.log(`  dental-any-failure-streak: OK (${passed} assertions)`);
  } catch (err) {
    failed++;
    failures.push(`dental-any-failure-streak: unexpected error: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
  } finally {
    if (prevPath === undefined) delete process.env.DENTAL_DB_PATH; else process.env.DENTAL_DB_PATH = prevPath;
    dbFactory.__resetDbFactoryForTesting();
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/services/dental-any-failure-streak.test.ts`
if (require.main === module) {
  const summary = runDentalAnyFailureStreakTests({ log: true });
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exit(summary.failed > 0 ? 1 : 0);
}
