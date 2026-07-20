/**
 * opplevelser-hjemmeside-listing-sweep.test.ts — unit tests for
 * POST /api/opplevelser/admin/hjemmeside-cleanup-sweep
 * (src/routes/opplevelser.ts), dev-request 2026-07-12-experiences-
 * enrichment-supply-and-aggregator-hygiene, Daniel's 2026-07-19 decision,
 * step 1 (classify + move aggregator/DMO URLs out of
 * experience_providers.hjemmeside into the new listing_url column).
 *
 * Setup mirrors opplevelser-admin-providers-hjemmeside.test.ts /
 * opplevelser-gardssalg-provider-visibility.test.ts exactly:
 * EXPERIENCES_DB_PATH=":memory:" + db-factory.__resetDbFactoryForTesting()
 * (so init-experiences.ts's real schema runs, including the new listing_url
 * column), fresh require of the opplevelser router per run, exercised via
 * router.handle() directly (X-Admin-Key via headers).
 *
 * Covers (per the build spec's acceptance criteria):
 *   (1) schema: listing_url column present; existing/legacy rows unaffected
 *       (NULL default).
 *   (2) dry-run over a known-aggregator hjemmeside reports a would-move
 *       candidate WITHOUT writing anything — hard read-only proof (re-fetch
 *       the row before/after and assert byte-identical).
 *   (3) apply moves hjemmeside -> listing_url, clears hjemmeside, and merges
 *       a field_provenance.hjemmeside entry WITHOUT clobbering a
 *       pre-existing entry for a different field (adresse).
 *   (4) a real (non-aggregator) domain is never touched, dry-run or apply
 *       (regression guard).
 *   (5) re-verify-before-write: hjemmeside (or listing_url) mutated
 *       directly via DB after a flag snapshot is taken -> the write is
 *       skipped rather than clobbered. The route's own scan-then-write path
 *       has no `await` between classify and write, so — same limitation
 *       admin-dental-hjemmeside-cleanup.test.ts's own comment documents —
 *       this is exercised by unit-testing the exported
 *       applyHjemmesideListingSweepToRow() directly with a manually
 *       constructed stale flag, not via two sequential HTTP calls.
 *   (6) 403 without X-Admin-Key.
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
  opts: { headers?: Record<string, string>; body?: any } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const url = "/admin/hjemmeside-cleanup-sweep";
    const headers = opts.headers || {};
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers,
      body: opts.body ?? {},
      get(name: string) {
        return headers[name.toLowerCase()];
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

export function runOpplevelserHjemmesideListingSweepTests(
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
    const prevAnalyticsAdminKey = process.env.ANALYTICS_ADMIN_KEY;
    const testKey = "hjemmeside-listing-sweep-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;
    delete process.env.ANALYTICS_ADMIN_KEY;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");
      const opplevelserModule = require("./opplevelser") as typeof import("./opplevelser");
      const opplevelserRouter = opplevelserModule.default as any;

      // ── (1) schema: listing_url column present, additive ────────────────
      const cols = expDb.prepare(`PRAGMA table_info(experience_providers)`).all() as Array<{ name: string }>;
      assertTrue(cols.some((c) => c.name === "listing_url"), "1a: experience_providers has a listing_url column");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, hjemmeside, listing_url, field_provenance, created_at, updated_at,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @hjemmeside, @listing_url, @field_provenance, @created_at, @created_at,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // Legacy row, seeded BEFORE this column existed conceptually — must be
      // unaffected (NULL default), never a candidate this sweep touches
      // (hjemmeside itself is NULL here, so it's excluded from the WHERE
      // clause entirely).
      insertProvider.run({
        id: "legacy-no-website", navn: "Legacy Uten Nettside AS",
        hjemmeside: null, listing_url: null, field_provenance: null,
        created_at: "2025-01-01T00:00:00.000Z",
      });
      const legacyRow = expDb.prepare("SELECT listing_url FROM experience_providers WHERE id = ?").get("legacy-no-website") as any;
      assertEq(legacyRow.listing_url, null, "1b: legacy row's listing_url is NULL by default");

      // A known-aggregator hjemmeside -> the dry-run/apply candidate.
      insertProvider.run({
        id: "prov-agg", navn: "Fjelltur Opplevelser AS",
        hjemmeside: "https://www.visitnorway.no/listings/fjelltur-opplevelser",
        listing_url: null, field_provenance: null,
        created_at: "2026-01-01T00:00:00.000Z",
      });

      // A known-aggregator hjemmeside on a row that ALREADY carries
      // provenance for a different field (adresse) — must survive the merge
      // byte-for-byte.
      const preExistingProvenance = JSON.stringify({
        adresse: { source_url: "https://data.brreg.no/enhetsregisteret", fetched_at: "2025-12-01T00:00:00.000Z" },
      });
      insertProvider.run({
        id: "prov-agg-with-prov", navn: "Kystvandring DA",
        hjemmeside: "https://www.visitinnlandet.no/listings/kystvandring",
        listing_url: null, field_provenance: preExistingProvenance,
        created_at: "2026-01-02T00:00:00.000Z",
      });

      // A real (non-aggregator) domain — regression guard, never touched.
      insertProvider.run({
        id: "prov-clean", navn: "Ren Gård AS",
        hjemmeside: "https://ren-gard.example.no",
        listing_url: null, field_provenance: null,
        created_at: "2026-01-03T00:00:00.000Z",
      });

      function post(body: any, key: string | false = testKey): Promise<RouteResult> {
        const headers: Record<string, string> = {};
        if (key !== false) headers["x-admin-key"] = key;
        return callRoute(opplevelserRouter, { headers, body });
      }

      function getRow(id: string): { hjemmeside: string | null; listing_url: string | null; field_provenance: string | null } | undefined {
        return expDb
          .prepare("SELECT hjemmeside, listing_url, field_provenance FROM experience_providers WHERE id = ?")
          .get(id) as any;
      }

      // ── (6) admin gate ────────────────────────────────────────────────
      let r = await post({}, false);
      assertEq(r.status, 403, "6a: missing X-Admin-Key -> 403");
      r = await post({}, "wrong-key");
      assertEq(r.status, 403, "6b: wrong X-Admin-Key -> 403");

      // ── (2) dry-run: reports flagged rows, ZERO writes ───────────────────
      const beforeDryRun = {
        agg: getRow("prov-agg"),
        aggWithProv: getRow("prov-agg-with-prov"),
        clean: getRow("prov-clean"),
      };

      const dryDefault = await post({}); // no dry_run key at all -> defaults to dry-run
      assertEq(dryDefault.status, 200, "2a: dry-run (default) -> 200");
      assertEq(dryDefault.body.dry_run, true, "2b: dry_run:true echoed back by default");
      {
        const ids = (dryDefault.body.would_move as any[]).map((x) => x.id).sort();
        assertEq(
          ids,
          ["prov-agg", "prov-agg-with-prov"].sort(),
          "2c: exactly the 2 aggregator-hjemmeside rows are reported as would-move candidates",
        );
      }
      assertEq(dryDefault.body.candidate_count, 3, "2d: candidate_count includes every hjemmeside-not-null/listing_url-null row (2 aggregator + 1 clean)");

      // dry_run:"false" (string, not the JSON boolean) must STILL be dry-run
      // (STRICT-FALSE parse) — same convention as every other sweep in this file.
      const dryStringFalse = await post({ dry_run: "false" });
      assertEq(dryStringFalse.body.dry_run, true, '2e: dry_run:"false" (string) is still dry-run (STRICT-FALSE parse)');
      const dryNull = await post({ dry_run: null });
      assertEq(dryNull.body.dry_run, true, "2f: dry_run:null is still dry-run");

      // Hard read-only proof: every touched row is BYTE-IDENTICAL before/after.
      const afterDryRun = {
        agg: getRow("prov-agg"),
        aggWithProv: getRow("prov-agg-with-prov"),
        clean: getRow("prov-clean"),
      };
      assertEq(JSON.stringify(afterDryRun.agg), JSON.stringify(beforeDryRun.agg), "2g: prov-agg byte-identical after dry-run");
      assertEq(JSON.stringify(afterDryRun.aggWithProv), JSON.stringify(beforeDryRun.aggWithProv), "2h: prov-agg-with-prov byte-identical after dry-run");
      assertEq(JSON.stringify(afterDryRun.clean), JSON.stringify(beforeDryRun.clean), "2i: prov-clean byte-identical after dry-run");

      // ── (3)+(4) apply: moves the flagged rows, leaves the clean row
      //    untouched. ─────────────────────────────────────────────────────
      const applied = await post({ dry_run: false });
      assertEq(applied.status, 200, "3a: apply -> 200");
      assertEq(applied.body.dry_run, false, "3b: dry_run:false echoed back");
      {
        const movedIds = (applied.body.moved as any[]).map((x) => x.id).sort();
        assertEq(movedIds, ["prov-agg", "prov-agg-with-prov"], "3c: exactly the 2 flagged rows were moved");
      }
      assertEq((applied.body.skipped as any[]).length, 0, "3c2: nothing to skip on a clean first apply run");

      // prov-agg: moved cleanly, no pre-existing provenance to preserve.
      const aggAfter = getRow("prov-agg")!;
      assertEq(aggAfter.hjemmeside, null, "3d: prov-agg hjemmeside cleared to NULL");
      assertEq(aggAfter.listing_url, "https://www.visitnorway.no/listings/fjelltur-opplevelser", "3e: prov-agg listing_url carries the original aggregator URL verbatim");
      {
        const prov = JSON.parse(aggAfter.field_provenance || "{}");
        assertTrue(!!prov.hjemmeside, "3f: prov-agg gains a field_provenance.hjemmeside entry");
        assertEq(prov.hjemmeside.source_url, "https://www.visitnorway.no/listings/fjelltur-opplevelser", "3g: provenance source_url is the original hjemmeside value");
        assertTrue(typeof prov.hjemmeside.fetched_at === "string" && prov.hjemmeside.fetched_at.length > 0, "3h: provenance carries a fetched_at timestamp");
      }

      // prov-agg-with-prov: moved AND the pre-existing 'adresse' provenance
      // entry survives byte-for-byte.
      const aggProvAfter = getRow("prov-agg-with-prov")!;
      assertEq(aggProvAfter.hjemmeside, null, "3i: prov-agg-with-prov hjemmeside cleared to NULL");
      assertEq(aggProvAfter.listing_url, "https://www.visitinnlandet.no/listings/kystvandring", "3j: prov-agg-with-prov listing_url carries the original aggregator URL verbatim");
      {
        const prov = JSON.parse(aggProvAfter.field_provenance || "{}");
        assertTrue(!!prov.adresse, "3k: pre-existing 'adresse' provenance survives the merge");
        assertEq(
          JSON.stringify(prov.adresse),
          JSON.stringify({ source_url: "https://data.brreg.no/enhetsregisteret", fetched_at: "2025-12-01T00:00:00.000Z" }),
          "3l: pre-existing 'adresse' provenance entry is byte-for-byte unchanged",
        );
        assertTrue(!!prov.hjemmeside, "3m: new 'hjemmeside' provenance entry also present");
        assertEq(prov.hjemmeside.source_url, "https://www.visitinnlandet.no/listings/kystvandring", "3n: new provenance entry's source_url is correct");
      }

      // ── (4) regression guard: the clean (real-domain) row is NEVER
      //    touched, dry-run or apply. ───────────────────────────────────────
      const cleanAfter = getRow("prov-clean")!;
      assertEq(cleanAfter.hjemmeside, "https://ren-gard.example.no", "4a: prov-clean hjemmeside untouched by apply");
      assertEq(cleanAfter.listing_url, null, "4b: prov-clean listing_url still NULL after apply");

      // Re-running apply now finds nothing left flagged among the moved rows
      // (listing_url IS NOT NULL excludes them from the candidate set); the
      // still-un-swept prov-clean remains a candidate but is never classified
      // bad.
      const secondApply = await post({ dry_run: false });
      assertEq(secondApply.body.moved.length, 0, "3o: second apply run moves nothing (already-moved rows excluded from candidate set)");

      // ── (5) re-verify-before-write: applyHjemmesideListingSweepToRow,
      //    unit-tested directly. The route's own scan-then-write path has no
      //    `await` between the initial classify and the transaction's
      //    per-row re-fetch, so a real "changed since an earlier scan" race
      //    cannot be reproduced through two ordinary sequential HTTP calls —
      //    same limitation the dental precedent's own test file documents.
      //    This exercises the exported function directly with a manually
      //    constructed stale `flag` snapshot, exactly like
      //    admin-dental-hjemmeside-cleanup.test.ts's case (f). ───────────────
      insertProvider.run({
        id: "prov-stale", navn: "Stale Opplevelser AS",
        hjemmeside: "https://www.tripadvisor.com/Attraction_Review-stale",
        listing_url: null, field_provenance: null,
        created_at: "2026-01-05T00:00:00.000Z",
      });
      const staleFlag = {
        id: "prov-stale",
        navn: "Stale Opplevelser AS",
        hjemmeside: "https://www.tripadvisor.com/Attraction_Review-stale",
      };
      // Mutate the row's hjemmeside directly, simulating "changed since an
      // earlier scan" — the snapshot in staleFlag is now stale.
      expDb.prepare("UPDATE experience_providers SET hjemmeside = ? WHERE id = ?")
        .run("https://a-completely-different-real-site.example.no", "prov-stale");
      const staleOutcome = opplevelserModule.applyHjemmesideListingSweepToRow(expDb, staleFlag, new Date().toISOString());
      assertEq(staleOutcome.applied, false, "5a: stale snapshot (hjemmeside changed since scan) is skipped, not applied");
      assertEq(staleOutcome.skip_reason, "hjemmeside_changed", "5b: skip_reason reports hjemmeside_changed");
      const staleRowAfter = getRow("prov-stale")!;
      assertEq(staleRowAfter.hjemmeside, "https://a-completely-different-real-site.example.no", "5c: prov-stale keeps its CURRENT (mutated) hjemmeside — never clobbered");
      assertEq(staleRowAfter.listing_url, null, "5d: prov-stale listing_url stays NULL (never moved)");

      // Same guard for the "already moved by a concurrent call" branch:
      // listing_url no longer NULL by the time the stale flag is applied.
      insertProvider.run({
        id: "prov-already-moved", navn: "Allerede Flyttet AS",
        hjemmeside: "https://www.tripadvisor.com/Attraction_Review-already-moved",
        listing_url: null, field_provenance: null,
        created_at: "2026-01-06T00:00:00.000Z",
      });
      const alreadyMovedFlag = {
        id: "prov-already-moved",
        navn: "Allerede Flyttet AS",
        hjemmeside: "https://www.tripadvisor.com/Attraction_Review-already-moved",
      };
      expDb.prepare("UPDATE experience_providers SET listing_url = ?, hjemmeside = NULL WHERE id = ?")
        .run("https://www.tripadvisor.com/Attraction_Review-already-moved", "prov-already-moved");
      const alreadyMovedOutcome = opplevelserModule.applyHjemmesideListingSweepToRow(expDb, alreadyMovedFlag, new Date().toISOString());
      assertEq(alreadyMovedOutcome.applied, false, "5e: row already moved by a concurrent call is skipped, not re-applied");
      assertEq(alreadyMovedOutcome.skip_reason, "already_moved", "5f: skip_reason reports already_moved");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-hjemmeside-listing-sweep: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      if (prevAnalyticsAdminKey === undefined) delete process.env.ANALYTICS_ADMIN_KEY;
      else process.env.ANALYTICS_ADMIN_KEY = prevAnalyticsAdminKey;
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

// Standalone runner: `npx tsx src/routes/opplevelser-hjemmeside-listing-sweep.test.ts`
if (require.main === module) {
  runOpplevelserHjemmesideListingSweepTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
