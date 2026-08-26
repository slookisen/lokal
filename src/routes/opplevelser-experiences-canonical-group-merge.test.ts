/**
 * opplevelser-experiences-canonical-group-merge.test.ts — tests for
 * POST /admin/experiences-canonical-group-merge (src/routes/opplevelser.ts).
 *
 * dev-request 2026-08-25-experiences-retro-opprydding-boilerplate-innhold,
 * AC4 (Ringve, Trondheim). This route is the explicit, opt-in lever for
 * folding two ALREADY-ASSIGNED canonical_id groups into one, once a caller
 * already knows (e.g. from the provider-merge route) that they're the same
 * business — NO fuzzy title matching, NO change to titlesMatch()/
 * groupDuplicateCandidates()/runDedupPass(). Route wiring + the pure merge
 * logic in services/experience-canonical-group-merge.ts are both covered
 * here (that module has no DB access of its own to unit-test separately
 * from a real better-sqlite3 handle, unlike experience-provider-
 * canonicalize.ts's pure grouping function).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key
 *   (b) dry-run (apply omitted) -> zero DB writes, reports the exact
 *       rows_to_move (both the pre-existing dupe AND the remove group's own
 *       anchor row)
 *   (c) apply:true -> real write: all remove-group rows repointed onto
 *       keep_canonical_id (including the former remove anchor itself, which
 *       is no longer canonical afterward), keep's merged_from unions the
 *       moved ids
 *   (d) idempotent: a second apply call for the same pair reports
 *       rows_moved_count: 0 and writes nothing further
 *   (e) unknown remove_canonical_id -> 400
 *   (f) unknown keep_canonical_id (or a keep_canonical_id that is itself not
 *       currently canonical) -> 400
 *   (g) same id passed as both keep and remove -> 400
 *   (h) provider-mismatch guard: a row in either group with a provider_id
 *       different from expected_provider_id rejects the whole call (400),
 *       writes nothing
 *   (i) missing expected_provider_id -> 400
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
    const url = opts.url || "/admin/experiences-canonical-group-merge";
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

export function runOpplevelserExperiencesCanonicalGroupMergeTests(
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
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "experiences-canonical-group-merge-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
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
           (id, navn, vertical, kommune, content_source, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @kommune, NULL, 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "prov-ringve", navn: "Ringve Museum", kommune: "Trondheim" });
      insertProvider.run({ id: "prov-other", navn: "Unrelated Museum", kommune: "Trondheim" });

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences (id, provider_id, title, kommune, canonical_id, merged_from, enrichment_state, verification_status)
         VALUES (@id, @provider_id, @title, @kommune, @canonical_id, @merged_from, 'raw', 'pending_verify')`,
      );

      // ── (b)/(c)/(d) real production shape — the confirmed Ringve pair:
      // keep group = the ~14-row group (2 rows here for brevity: anchor +
      // 1 already-merged dupe); remove group = the ~3-row group (anchor +
      // 1 already-merged dupe), all sharing provider_id prov-ringve.
      insertExperience.run({ id: "exp-keep-anchor", provider_id: "prov-ringve", title: "Omvisning på Ringve Museum", kommune: "Trondheim", canonical_id: null, merged_from: null });
      insertExperience.run({ id: "exp-keep-dupe-1", provider_id: "prov-ringve", title: "Omvisning Ringve museum", kommune: "Trondheim", canonical_id: "exp-keep-anchor", merged_from: null });
      insertExperience.run({ id: "exp-remove-anchor", provider_id: "prov-ringve", title: "Konsert på Ringve", kommune: "Trondheim", canonical_id: null, merged_from: null });
      insertExperience.run({ id: "exp-remove-dupe-1", provider_id: "prov-ringve", title: "Konsert Ringve museum", kommune: "Trondheim", canonical_id: "exp-remove-anchor", merged_from: null });

      // ── (h) provider-mismatch fixtures — a distinct pair where the remove
      // group's anchor points at a DIFFERENT provider than expected.
      insertExperience.run({ id: "exp-mismatch-keep", provider_id: "prov-ringve", title: "Ringve sommerkonsert", kommune: "Trondheim", canonical_id: null, merged_from: null });
      insertExperience.run({ id: "exp-mismatch-remove", provider_id: "prov-other", title: "Ukjent aktivitet", kommune: "Trondheim", canonical_id: null, merged_from: null });

      // ── (f) keep_canonical_id that is itself a non-canonical (already
      // merged-away) row.
      insertExperience.run({ id: "exp-not-canonical-keep", provider_id: "prov-ringve", title: "Allerede sammenslått rad", kommune: "Trondheim", canonical_id: "exp-keep-anchor", merged_from: null });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) 403 without X-Admin-Key ─────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(noKey.status, 403, "a1: POST .../experiences-canonical-group-merge without X-Admin-Key -> 403");

      const snapshotBefore = expDb
        .prepare(`SELECT id, provider_id, canonical_id, merged_from FROM experiences ORDER BY id`)
        .all();

      // ── (b) dry-run (apply omitted) — zero writes ───────────────────────────
      const dry = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(dry.status, 200, "b1: dry-run call -> 200");
      assertEq(dry.body.dry_run, true, "b2: dry_run:true when apply is omitted");
      assertEq(dry.body.rows_to_move_count, 2, "b3: dry-run reports both remove-group rows (anchor + its dupe)");
      assertEq(
        (dry.body.rows_to_move ?? []).map((r: any) => r.id).sort(),
        ["exp-remove-anchor", "exp-remove-dupe-1"],
        "b4: dry-run rows_to_move lists exactly the remove group's live rows",
      );
      const afterDry = expDb
        .prepare(`SELECT id, provider_id, canonical_id, merged_from FROM experiences ORDER BY id`)
        .all();
      assertEq(afterDry, snapshotBefore, "b5: dry-run makes zero DB writes");

      // ── (g) same id passed twice -> 400 ─────────────────────────────────────
      const sameId = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-keep-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(sameId.status, 400, "g1: same id for keep and remove -> 400");

      // ── (e) unknown remove_canonical_id -> 400 ──────────────────────────────
      const unknownRemove = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "does-not-exist", expected_provider_id: "prov-ringve" },
      });
      assertEq(unknownRemove.status, 400, "e1: unknown remove_canonical_id -> 400");

      // ── (f) unknown / non-canonical keep_canonical_id -> 400 ───────────────
      const unknownKeep = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "does-not-exist", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(unknownKeep.status, 400, "f1: unknown keep_canonical_id -> 400");

      const notCanonicalKeep = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-not-canonical-keep", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(notCanonicalKeep.status, 400, "f2: keep_canonical_id that is itself already merged away (not canonical) -> 400");

      // ── (i) missing expected_provider_id -> 400 ─────────────────────────────
      const noExpectedProvider = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor" },
      });
      assertEq(noExpectedProvider.status, 400, "i1: missing expected_provider_id -> 400");

      // ── (h) provider-mismatch guard -> 400, zero writes ─────────────────────
      const mismatchSnapshotBefore = expDb
        .prepare(`SELECT id, provider_id, canonical_id FROM experiences WHERE id IN ('exp-mismatch-keep','exp-mismatch-remove') ORDER BY id`)
        .all();
      const mismatch = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-mismatch-keep", remove_canonical_id: "exp-mismatch-remove", expected_provider_id: "prov-ringve" },
      });
      assertEq(mismatch.status, 400, "h1: a row in the remove group with a different provider_id -> 400");
      assertTrue(
        typeof mismatch.body.error === "string" && mismatch.body.error.includes("provider_mismatch"),
        "h2: error message names the provider_mismatch guard",
      );
      const mismatchSnapshotAfter = expDb
        .prepare(`SELECT id, provider_id, canonical_id FROM experiences WHERE id IN ('exp-mismatch-keep','exp-mismatch-remove') ORDER BY id`)
        .all();
      assertEq(mismatchSnapshotAfter, mismatchSnapshotBefore, "h3: provider-mismatch rejection writes nothing");

      // ── (c) apply:true — real write ──────────────────────────────────────────
      const apply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve", apply: true },
      });
      assertEq(apply.status, 200, "c1: apply call -> 200");
      assertEq(apply.body.dry_run, false, "c2: dry_run:false when apply:true");
      assertEq(apply.body.rows_moved_count, 2, "c3: apply reports both rows moved");

      const rowsAfterApply = expDb
        .prepare(`SELECT id, provider_id, canonical_id FROM experiences WHERE id IN ('exp-remove-anchor','exp-remove-dupe-1','exp-keep-dupe-1','exp-keep-anchor') ORDER BY id`)
        .all();
      assertEq(
        rowsAfterApply,
        [
          { id: "exp-keep-anchor", provider_id: "prov-ringve", canonical_id: null },
          { id: "exp-keep-dupe-1", provider_id: "prov-ringve", canonical_id: "exp-keep-anchor" },
          { id: "exp-remove-anchor", provider_id: "prov-ringve", canonical_id: "exp-keep-anchor" },
          { id: "exp-remove-dupe-1", provider_id: "prov-ringve", canonical_id: "exp-keep-anchor" },
        ],
        "c4: both former remove-group rows (including its own former anchor) now point canonical_id at keep; keep's own row and its pre-existing dupe are untouched",
      );

      const keepMergedFromAfter = expDb.prepare(`SELECT merged_from FROM experiences WHERE id = ?`).get("exp-keep-anchor") as { merged_from: string };
      const mergedFromParsed = JSON.parse(keepMergedFromAfter.merged_from).sort();
      assertEq(mergedFromParsed, ["exp-remove-anchor", "exp-remove-dupe-1"], "c5: keep's merged_from now lists both moved ids");

      // ── (d) idempotent — a second apply for the same pair is a true no-op ──
      const applyAgain = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve", apply: true },
      });
      assertEq(applyAgain.status, 200, "d1: second apply call for the same pair -> 200 (not an error)");
      assertEq(applyAgain.body.rows_moved_count, 0, "d2: second apply moves zero rows (nothing left to move)");

      const dryAfterApply = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        body: { keep_canonical_id: "exp-keep-anchor", remove_canonical_id: "exp-remove-anchor", expected_provider_id: "prov-ringve" },
      });
      assertEq(dryAfterApply.status, 200, "d3: dry-run after apply -> 200");
      assertEq(dryAfterApply.body.rows_to_move_count, 0, "d4: dry-run after apply also reports zero rows to move");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-experiences-canonical-group-merge: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
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

// Standalone runner: `npx tsx src/routes/opplevelser-experiences-canonical-group-merge.test.ts`
if (require.main === module) {
  runOpplevelserExperiencesCanonicalGroupMergeTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
