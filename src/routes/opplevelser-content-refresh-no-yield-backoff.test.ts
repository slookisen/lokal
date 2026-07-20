/**
 * opplevelser-content-refresh-no-yield-backoff.test.ts — unit tests for the
 * experiences vertical's content-no-yield-backoff (dev-request
 * 2026-07-20-experiences-no-yield-backoff).
 *
 * Ports the RFB/marketplace.ts no_yield_streak idea
 * (dev-request 2026-07-19-enrichment-selector-rotasjon-no-yield-backoff,
 * see homepage-provenance-selector-rotation.test.ts) to
 * selectProvidersForContentRefresh() / POST /admin/content-refresh
 * (src/services/experience-store.ts, src/routes/opplevelser.ts): a provider
 * whose homepage fetch succeeds but yields no extractable fields 3 times
 * running rests NO_YIELD_BACKOFF_DAYS days (env var, default 14 — the SAME
 * env var name marketplace.ts already reads) before being reselected; any
 * successful field-write resets content_no_yield_streak to 0.
 *
 * Setup mirrors the existing content-refresh-attempt-tracking block in
 * tests/test.ts and opplevelser-providers-recently-enriched.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store per run — direct store-function calls, no HTTP layer
 * needed since the acceptance criteria are all about
 * selectProvidersForContentRefresh()/recordProviderContentYield() behavior.
 *
 * Covers:
 *   (a) content_no_yield_streak=3 + recent last_content_attempt_at -> excluded
 *       from selectProvidersForContentRefresh()
 *   (b) same provider, last_content_attempt_at backdated past
 *       NO_YIELD_BACKOFF_DAYS (15+ days) -> reappears
 *   (c) recordProviderContentYield(id, false) called 3x -> streak reaches 3
 *       and the provider is now excluded
 *   (d) a provider with an existing streak (2) that gets a yielded=true call
 *       -> streak resets to 0 (and the provider stays/becomes selectable)
 *   (e) default content_no_yield_streak (0, the existing-row default) never
 *       excludes a provider that is otherwise eligible — zero behavior change
 *       for the existing/default cohort
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function runOpplevelserContentRefreshNoYieldBackoffTests(
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
    const prevNoYieldBackoffDays = process.env.NO_YIELD_BACKOFF_DAYS;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.NO_YIELD_BACKOFF_DAYS; // exercise the default-14 path

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const cachePaths = [dbFactoryPath, expStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences");

      function seedProvider(id: string, opts2: { hjemmeside: string }): string {
        const providerId = expStore.createProvider({
          navn: `Test Provider ${id}`,
          org_nr: `9000${id.padStart(5, "0")}`,
          fylke: "Troms", kommune: "Tromsø",
          hjemmeside: opts2.hjemmeside,
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        });
        expStore.createExperience({
          title: `Test Provider ${id} opplevelse`, provider_id: providerId, provider_match_status: "matched",
          fylke: "Troms", kommune: "Tromsø", confidence: "high", verification_status: "pending_verify",
        });
        return providerId;
      }

      // ── (a) streak=3 + recent attempt -> excluded ─────────────────────────
      const provA = seedProvider("a", { hjemmeside: "https://no-yield-a.example" });
      db.prepare(
        "UPDATE experience_providers SET content_no_yield_streak = 3, last_content_attempt_at = ? WHERE id = ?"
      ).run(daysAgoIso(1), provA);

      const afterA = expStore.selectProvidersForContentRefresh(50).map((r) => r.id);
      assertTrue(!afterA.includes(provA), "a1: streak=3 + recent last_content_attempt_at -> excluded from selectProvidersForContentRefresh");

      // ── (b) same provider, backdated past NO_YIELD_BACKOFF_DAYS -> reappears ──
      db.prepare(
        "UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?"
      ).run(daysAgoIso(15), provA);
      const afterB = expStore.selectProvidersForContentRefresh(50).map((r) => r.id);
      assertTrue(afterB.includes(provA), "b1: streak=3 but last_content_attempt_at 15 days ago (past default 14-day backoff) -> reappears");

      // ── (c) recordProviderContentYield(id, false) x3 -> streak reaches 3 ──
      const provC = seedProvider("c", { hjemmeside: "https://no-yield-c.example" });
      const beforeC = expStore.selectProvidersForContentRefresh(50).map((r) => r.id);
      assertTrue(beforeC.includes(provC), "c0: provC starts eligible (streak defaults to 0)");

      let lastChanged = false;
      for (let i = 0; i < 3; i++) {
        lastChanged = expStore.recordProviderContentYield(provC, false);
      }
      assertTrue(lastChanged, "c1: recordProviderContentYield(id, false) returns true (row changed)");
      const rowC = db.prepare("SELECT content_no_yield_streak FROM experience_providers WHERE id = ?").get(provC) as { content_no_yield_streak: number };
      assertEq(rowC.content_no_yield_streak, 3, "c2: content_no_yield_streak reaches 3 after 3 consecutive no-yield calls");

      // last_content_attempt_at is still NULL for provC (recordProviderContentYield
      // deliberately does not touch it — markProviderContentAttempted does), so the
      // NULL branch of noYieldBackoffExclusionSql keeps it selectable; stamp a
      // recent attempt (as processOne() would have, right before the no-yield
      // outcome) to exercise the actual exclusion.
      db.prepare("UPDATE experience_providers SET last_content_attempt_at = ? WHERE id = ?").run(daysAgoIso(1), provC);
      const afterC = expStore.selectProvidersForContentRefresh(50).map((r) => r.id);
      assertTrue(!afterC.includes(provC), "c3: after streak=3 + recent attempt, provC is excluded");

      // ── (d) existing streak=2, then yielded=true -> resets to 0 ───────────
      const provD = seedProvider("d", { hjemmeside: "https://no-yield-d.example" });
      db.prepare(
        "UPDATE experience_providers SET content_no_yield_streak = 2, last_content_attempt_at = ? WHERE id = ?"
      ).run(daysAgoIso(1), provD);
      const resetChanged = expStore.recordProviderContentYield(provD, true);
      assertTrue(resetChanged, "d1: recordProviderContentYield(id, true) returns true (row changed)");
      const rowD = db.prepare("SELECT content_no_yield_streak FROM experience_providers WHERE id = ?").get(provD) as { content_no_yield_streak: number };
      assertEq(rowD.content_no_yield_streak, 0, "d2: content_no_yield_streak resets to 0 after a yielded=true call");

      // ── (e) default streak (0) never excludes an otherwise-eligible provider ──
      const provE = seedProvider("e", { hjemmeside: "https://no-yield-e.example" });
      const rowE = db.prepare("SELECT content_no_yield_streak FROM experience_providers WHERE id = ?").get(provE) as { content_no_yield_streak: number };
      assertEq(rowE.content_no_yield_streak, 0, "e1: new provider defaults to content_no_yield_streak = 0");
      const afterE = expStore.selectProvidersForContentRefresh(50).map((r) => r.id);
      assertTrue(afterE.includes(provE), "e2: default streak=0 provider is selectable (zero behavior change for the default cohort)");

      // recordProviderContentYield on a nonexistent id -> false, no throw.
      assertTrue(
        expStore.recordProviderContentYield("does-not-exist", false) === false,
        "e3: recordProviderContentYield on a nonexistent provider id returns false without throwing",
      );
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-content-refresh-no-yield-backoff: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevNoYieldBackoffDays === undefined) {
        delete process.env.NO_YIELD_BACKOFF_DAYS;
      } else {
        process.env.NO_YIELD_BACKOFF_DAYS = prevNoYieldBackoffDays;
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

// Standalone runner: `npx tsx src/routes/opplevelser-content-refresh-no-yield-backoff.test.ts`
if (require.main === module) {
  runOpplevelserContentRefreshNoYieldBackoffTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
