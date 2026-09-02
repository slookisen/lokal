/**
 * opplevelser-experiences-provider-dedup-merge.test.ts — tests for
 * POST /admin/experiences-provider-dedup-merge (src/routes/opplevelser.ts).
 *
 * dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
 * spec-punkt 2. This route is DELIBERATELY not a new merge implementation —
 * it wires the SAME previewGardssalgProviderMergePair() /
 * applyGardssalgProviderMergePair() (services/gardssalg-provider-merge.ts,
 * exhaustively covered by opplevelser-gardssalg-provider-dedup-merge.test.ts
 * — fill-only migration, org_nr move, owner-claim guard, already-merged
 * guard, org_nr-conflict guard, batch cap, chain-merge/rollback atomicity)
 * under a new route name for the non-gårdssalg (museum/attraction) scope.
 * This file therefore covers ROUTE WIRING only — auth, request validation,
 * dry-run-by-default, and that a real apply through THIS route is restorable
 * through the EXISTING POST /admin/gardssalg-content-rollback lever with no
 * new wiring — not a re-proof of every guard already covered there.
 *
 * Mirrors opplevelser-gardssalg-provider-dedup-merge.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory +
 * experience-store + opplevelser router per run).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) dry-run (apply omitted) -> zero DB writes, outcome "would_merge"
 *   (c) apply:true -> real write: fill-only field migrated onto keep,
 *       merged_into stamped on remove, outcome "merged"
 *   (d) missing/empty pairs array -> 400
 *   (e) batch cap exceeded -> 400
 *   (f) malformed pair item (missing remove_id) -> rejected "ugyldig_par",
 *       doesn't block a sibling pair in the same batch
 *   (g) rollback wiring proof: POST .../gardssalg-content-rollback with the
 *       batch_id this route returned restores the PROVIDER-content half of
 *       a merge made through THIS route (same table/audit-row shape as the
 *       gårdssalg route — no new entity_type branch needed). The repoint
 *       half (h/i below) has no audit row and is a documented, deliberate
 *       KNOWN LIMITATION not covered by this rollback call — see the
 *       route's own doc comment (routes/opplevelser.ts)
 *   (h) THE genuinely new piece: a real apply repoints every still-live
 *       experience row from remove_id onto keep_id (experiences_repointed
 *       count matches, provider_id actually changes on each live row), but
 *       an already-merged-away experience row (canonical_id set) is left
 *       untouched — merging the provider record alone would never have
 *       closed the actual gap (runDedupPass keys off each experience row's
 *       OWN provider_id, never a provider's merged_into pointer)
 *   (i) dry-run reports the would-be experiences_repointed count without
 *       touching any experience row
 *   (j) idempotent "finish the job" case: a pair whose PROVIDER side was
 *       already merged by an EARLIER call (e.g. through the plain gårdssalg
 *       twin route, before this repoint step existed) — calling this route
 *       for that exact pair again reports outcome "rejected"/
 *       "allerede_fjernet_i_tidligere_slaaing" (unchanged reused guard) but
 *       STILL performs the repoint; a dry-run for the same already-merged
 *       pair reports the correct would-be count without writing
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: {
    method?: "GET" | "POST";
    url?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const method = opts.method || "POST";
    const url = opts.url || "/admin/experiences-provider-dedup-merge";
    const req: any = {
      method,
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() {
        return undefined;
      },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserExperiencesProviderDedupMergeTests(
  opts: { log?: boolean } = {},
): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  // Main-db pin: the apply route under test reads enrichment_write_pause off
  // the MAIN db singleton (fail-closed) — see __pinInMemoryDbForTesting.
  let restoreMainDb: (() => void) | null = null;

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
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "experiences-provider-dedup-merge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    // experience-store.ts must ALSO be reloaded — it holds its own
    // module-level `getDb` binding used by the rollback plan/apply functions
    // (same reasoning as opplevelser-gardssalg-provider-dedup-merge.test.ts).
    const experienceStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, experienceStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, kommune, epost, telefon, hjemmeside, content_source,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @kommune, @epost, @telefon, @hjemmeside, @content_source,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      type FixtureRow = {
        id: string;
        navn: string;
        org_nr?: string | null;
        kommune?: string | null;
        epost?: string | null;
        telefon?: string | null;
        hjemmeside?: string | null;
        content_source?: string | null;
      };
      function seed(row: FixtureRow): void {
        insertProvider.run({
          org_nr: null, kommune: null, epost: null, telefon: null, hjemmeside: null, content_source: null,
          ...row,
        });
      }

      // ── (b)/(c) real production shape — the confirmed Vitensenteret pair ────
      seed({
        id: "prov-vit-remove", navn: "Vitensenteret Trondheim", kommune: "Trondheim",
        epost: "post@vitensenteret.no",
      });
      seed({
        id: "prov-vit-keep", navn: "Vitensenteret i Trondheim", kommune: "Trondheim",
        // telefon/hjemmeside blank -> fillable from remove's row
      });

      // ── (f) malformed-pair fixtures ───────────────────────────────────────────
      seed({ id: "prov-ok-remove", navn: "Ringve Musikkmuseum", kommune: "Trondheim" });
      seed({ id: "prov-ok-keep", navn: "Ringve Museum", kommune: "Trondheim" });

      // ── (j) idempotent "finish the job" fixtures — pair ALREADY merged by an
      // earlier call (simulated by seeding merged_into directly, standing in
      // for "the plain gårdssalg twin route already ran this pair"), plus a
      // still-live experience row under the remove side.
      seed({ id: "prov-preexisting-remove", navn: "Ringve nasjonale musikkmuseum", kommune: "Trondheim" });
      seed({ id: "prov-preexisting-keep", navn: "Ringve Musikkmuseum", kommune: "Trondheim" });

      // ── (h)/(i) child-experience repoint fixtures ────────────────────────────
      // Two still-live activity rows harvested under the REMOVE provider, plus
      // one already-merged-away (canonical_id set) row that must be left alone.
      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, kommune, canonical_id, enrichment_state, verification_status)
         VALUES (@id, @provider_id, @title, @kommune, @canonical_id, 'raw', 'pending_verify')`,
      );
      insertExperience.run({ id: "exp-vit-live-1", provider_id: "prov-vit-remove", title: "Omvisning på Vitensenteret", kommune: "Trondheim", canonical_id: null });
      insertExperience.run({ id: "exp-vit-live-2", provider_id: "prov-vit-remove", title: "Skoleprogram Vitensenteret", kommune: "Trondheim", canonical_id: null });
      insertExperience.run({ id: "exp-vit-already-merged", provider_id: "prov-vit-remove", title: "Duplikat allerede fjernet", kommune: "Trondheim", canonical_id: "exp-vit-live-1" });
      insertExperience.run({ id: "exp-preexisting-live", provider_id: "prov-preexisting-remove", title: "Konsert på Ringve", kommune: "Trondheim", canonical_id: null });
      // Simulates "the plain gårdssalg twin route already merged this pair,
      // before this repoint step existed" — merged_into set directly, no
      // repoint ever having happened.
      expDb.prepare(`UPDATE experience_providers SET merged_into = 'prov-preexisting-keep' WHERE id = 'prov-preexisting-remove'`).run();

      restoreMainDb = (require("../database/init") as typeof import("../database/init")).__pinInMemoryDbForTesting();
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {
        body: { pairs: [{ remove_id: "prov-vit-remove", keep_id: "prov-vit-keep" }] },
      });
      assertEq(noKey.status, 403, "a1: POST .../experiences-provider-dedup-merge without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.results, "a2: no-key response carries no results payload");

      const snapshotBefore = expDb
        .prepare(`SELECT * FROM experience_providers WHERE id IN ('prov-vit-remove','prov-vit-keep') ORDER BY id`)
        .all();

      // ── (b) dry-run (apply omitted) — zero writes ───────────────────────────
      const dry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-vit-remove", keep_id: "prov-vit-keep" }] },
      });
      assertEq(dry.status, 200, "b1: dry-run call -> 200");
      assertEq(dry.body.dry_run, true, "b2: dry_run:true when apply is omitted");
      assertEq(dry.body.results?.[0]?.outcome, "would_merge", "b3: dry-run outcome is would_merge");
      const afterDry = expDb
        .prepare(`SELECT * FROM experience_providers WHERE id IN ('prov-vit-remove','prov-vit-keep') ORDER BY id`)
        .all();
      assertEq(afterDry, snapshotBefore, "b4: dry-run makes zero DB writes");

      // ── (i) dry-run's experiences_repointed is a would-be count, zero writes ──
      assertEq(dry.body.results?.[0]?.experiences_repointed, 2, "i1: dry-run reports the would-be repoint count (2 live rows; the already-merged-away 3rd is excluded)");
      const expRowsAfterDry = expDb
        .prepare(`SELECT id, provider_id, canonical_id FROM experiences WHERE id LIKE 'exp-vit-%' ORDER BY id`)
        .all();
      assertEq(
        expRowsAfterDry,
        [
          { id: "exp-vit-already-merged", provider_id: "prov-vit-remove", canonical_id: "exp-vit-live-1" },
          { id: "exp-vit-live-1", provider_id: "prov-vit-remove", canonical_id: null },
          { id: "exp-vit-live-2", provider_id: "prov-vit-remove", canonical_id: null },
        ],
        "i2: dry-run touches zero experience rows",
      );

      // ── (d) missing/empty pairs array -> 400 ────────────────────────────────
      const noPairs = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: {} });
      assertEq(noPairs.status, 400, "d1: missing 'pairs' -> 400");
      const emptyPairs = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey }, body: { pairs: [] } });
      assertEq(emptyPairs.status, 400, "d2: empty 'pairs' array -> 400");

      // ── (e) batch cap exceeded -> 400 ───────────────────────────────────────
      const tooMany = Array.from({ length: 201 }, (_, i) => ({ remove_id: `x${i}`, keep_id: `y${i}` }));
      const capExceeded = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: tooMany },
      });
      assertEq(capExceeded.status, 400, "e1: batch above GARDSSALG_PROVIDER_MERGE_MAX_PAIRS (200) -> 400");

      // ── (f) malformed pair item doesn't block a sibling pair ────────────────
      const mixedBatch = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: {
          pairs: [
            { keep_id: "prov-ok-keep" }, // missing remove_id
            { remove_id: "prov-ok-remove", keep_id: "prov-ok-keep" },
          ],
        },
      });
      assertEq(mixedBatch.status, 200, "f1: mixed batch call -> 200 (malformed item never 500s the whole batch)");
      assertEq(mixedBatch.body.results?.[0]?.outcome, "rejected", "f2: malformed item outcome is 'rejected'");
      assertEq(mixedBatch.body.results?.[0]?.reason, "ugyldig_par", "f3: malformed item reason is 'ugyldig_par'");
      assertEq(mixedBatch.body.results?.[1]?.outcome, "would_merge", "f4: sibling well-formed pair in the same batch is still processed (dry-run)");

      // ── (c) apply:true — real write ──────────────────────────────────────────
      const apply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-vit-remove", keep_id: "prov-vit-keep" }], apply: true },
      });
      assertEq(apply.status, 200, "c1: apply call -> 200");
      assertEq(apply.body.dry_run, false, "c2: dry_run:false when apply:true");
      assertEq(apply.body.results?.[0]?.outcome, "merged", "c3: apply outcome is 'merged'");
      assertTrue(
        (apply.body.results?.[0]?.fields_filled ?? []).includes("epost"),
        "c4: fill-only field (epost) reported as filled",
      );
      const batchId = apply.body.batch_id as string;
      assertTrue(!!batchId, "c5: response carries a batch_id");

      const keepRowAfter = expDb.prepare(`SELECT epost, merged_into FROM experience_providers WHERE id = ?`).get("prov-vit-keep") as any;
      assertEq(keepRowAfter.epost, "post@vitensenteret.no", "c6: keep row's blank epost was filled from remove");
      const removeRowAfter = expDb.prepare(`SELECT merged_into FROM experience_providers WHERE id = ?`).get("prov-vit-remove") as any;
      assertEq(removeRowAfter.merged_into, "prov-vit-keep", "c7: remove row's merged_into now points at keep — soft-marked, never deleted");
      const stillExists = expDb.prepare(`SELECT COUNT(*) AS n FROM experience_providers WHERE id = 'prov-vit-remove'`).get() as { n: number };
      assertEq(stillExists.n, 1, "c8: remove row still exists in the table (no hard delete)");

      // ── (h) the genuinely new piece: child-experience repoint on real apply ──
      assertEq(apply.body.results?.[0]?.experiences_repointed, 2, "h1: apply reports experiences_repointed:2 (the two live rows)");
      const expRowsAfterApply = expDb
        .prepare(`SELECT id, provider_id, canonical_id FROM experiences WHERE id LIKE 'exp-vit-%' ORDER BY id`)
        .all();
      assertEq(
        expRowsAfterApply,
        [
          { id: "exp-vit-already-merged", provider_id: "prov-vit-remove", canonical_id: "exp-vit-live-1" },
          { id: "exp-vit-live-1", provider_id: "prov-vit-keep", canonical_id: null },
          { id: "exp-vit-live-2", provider_id: "prov-vit-keep", canonical_id: null },
        ],
        "h2: both live rows repointed onto keep; the already-merged-away row is left untouched (still pointing at remove)",
      );

      // ── (g) rollback wiring proof — via the EXISTING gårdssalg-content-rollback lever ──
      const rollbackDry = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: batchId },
      });
      assertEq(rollbackDry.status, 200, "g1: rollback dry-run call -> 200");
      assertTrue(
        (rollbackDry.body.restored ?? []).length > 0,
        "g2: the batch this NEW route wrote is recognized/restorable by the EXISTING rollback lever with zero new wiring",
      );

      const rollbackApply = await callRoute(opplevelserRouter, {
        url: "/admin/gardssalg-content-rollback",
        headers: { "x-admin-key": testKey },
        body: { batch_id: batchId, apply: true },
      });
      assertEq(rollbackApply.status, 200, "g3: rollback apply call -> 200");

      const keepRowRolledBack = expDb.prepare(`SELECT epost FROM experience_providers WHERE id = ?`).get("prov-vit-keep") as any;
      assertEq(keepRowRolledBack.epost, null, "g4: rollback restored keep row's epost to its pre-merge value (NULL)");
      const removeRowRolledBack = expDb.prepare(`SELECT merged_into FROM experience_providers WHERE id = ?`).get("prov-vit-remove") as any;
      assertEq(removeRowRolledBack.merged_into, null, "g5: rollback cleared merged_into on the remove row");

      // Documented KNOWN LIMITATION: the repoint has no audit row, so rolling
      // back the provider merge does NOT move the experience rows back.
      const expRowsAfterRollback = expDb
        .prepare(`SELECT provider_id FROM experiences WHERE id IN ('exp-vit-live-1','exp-vit-live-2')`)
        .all();
      assertTrue(
        expRowsAfterRollback.every((r: any) => r.provider_id === "prov-vit-keep"),
        "g6: KNOWN LIMITATION confirmed — the repoint is NOT reversed by the rollback lever (still pointing at keep after rollback)",
      );

      // ── (j) idempotent "finish the job" — pair already merged by an earlier call ──
      const preexistingDry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-preexisting-remove", keep_id: "prov-preexisting-keep" }] },
      });
      assertEq(preexistingDry.status, 200, "j1: dry-run on an already-merged pair -> 200");
      assertEq(preexistingDry.body.results?.[0]?.outcome, "rejected", "j2: outcome is still 'rejected' (unchanged reused guard)");
      assertEq(preexistingDry.body.results?.[0]?.reason, "allerede_fjernet_i_tidligere_slaaing", "j3: reason is the unchanged already-merged reason");
      assertEq(preexistingDry.body.results?.[0]?.experiences_repointed, 1, "j4: dry-run STILL reports the correct would-be repoint count (1 live row)");
      const preexistingExpBeforeApply = expDb.prepare(`SELECT provider_id FROM experiences WHERE id = 'exp-preexisting-live'`).get() as any;
      assertEq(preexistingExpBeforeApply.provider_id, "prov-preexisting-remove", "j5: dry-run makes zero writes to the experience row");

      const preexistingApply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-preexisting-remove", keep_id: "prov-preexisting-keep" }], apply: true },
      });
      assertEq(preexistingApply.status, 200, "j6: apply on an already-merged pair -> 200");
      assertEq(preexistingApply.body.results?.[0]?.outcome, "rejected", "j7: apply outcome is still 'rejected' — no provider fields are re-written");
      assertEq(preexistingApply.body.results?.[0]?.experiences_repointed, 1, "j8: apply STILL performs the repoint (finishes the job this pair was left half-done on)");
      const preexistingExpAfterApply = expDb.prepare(`SELECT provider_id FROM experiences WHERE id = 'exp-preexisting-live'`).get() as any;
      assertEq(preexistingExpAfterApply.provider_id, "prov-preexisting-keep", "j9: the live experience row is now repointed onto keep");

      // A second apply call for the same pair is a true no-op (idempotent).
      const preexistingApplyAgain = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { pairs: [{ remove_id: "prov-preexisting-remove", keep_id: "prov-preexisting-keep" }], apply: true },
      });
      assertEq(preexistingApplyAgain.body.results?.[0]?.experiences_repointed, 0, "j10: a THIRD call for the same pair repoints zero rows (nothing left to repoint)");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-provider-dedup-merge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (restoreMainDb) restoreMainDb();
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      if (prevAdminKey === undefined) {
        delete process.env.ADMIN_KEY;
      } else {
        process.env.ADMIN_KEY = prevAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-provider-dedup-merge.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesProviderDedupMergeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
