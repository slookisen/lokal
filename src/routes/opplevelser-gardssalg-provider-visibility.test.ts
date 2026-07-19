/**
 * opplevelser-gardssalg-provider-visibility.test.ts — tests for the NACE
 * triage lever (dev-request 2026-07-19-brreg-nace-drikkeprodusenter,
 * triage-oppfølging): POST /admin/gardssalg-provider-visibility sets/clears
 * catalog_hidden for EXPLICITLY listed rows (by provider id and/or org_nr),
 * dry-run by default, skipping manual/claim-locked rows, with no
 * wildcard/all mode. Hidden rows leave the public grid
 * (listGardssalgProviders) but remain slug-addressable — reversible, never
 * deleted.
 *
 * Same conventions as the other gårdssalg route test files: :memory: DB,
 * fresh requires, router.handle().
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
    const url = "/admin/gardssalg-provider-visibility";
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      query: {},
      headers: opts.headers || {},
      body: opts.body ?? {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

export function runOpplevelserGardssalgProviderVisibilityTests(
  log = false,
): Promise<TestSummary> {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual === expected) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else {
      failed++;
      failures.push(`✗ ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = "gardssalg-pv-test-key";
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
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;
      const adminHeaders = { "x-admin-key": testKey };

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, org_nr, catalog_hidden, content_source, products,
            producer_type, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @org_nr, @catalog_hidden, @content_source, '["x"]',
            'bryggeri', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );
      insertProvider.run({ id: "pv-a", navn: "Synlig Bryggeri A", org_nr: null, catalog_hidden: null, content_source: null });
      insertProvider.run({ id: "pv-b", navn: "Synlig Bryggeri B", org_nr: "966000001", catalog_hidden: null, content_source: null });
      insertProvider.run({ id: "pv-c", navn: "Claimet Bryggeri", org_nr: "966000002", catalog_hidden: null, content_source: "claim" });
      insertProvider.run({ id: "pv-d", navn: "Allerede Skjult", org_nr: null, catalog_hidden: 1, content_source: null });

      const hiddenFlag = (id: string): number | null =>
        (expDb.prepare(`SELECT catalog_hidden FROM experience_providers WHERE id = ?`).get(id) as any)
          .catalog_hidden;
      const publiclyListed = (navn: string): boolean =>
        expStore.listGardssalgProviders(100, 0).some((p: any) => p.navn === navn);

      // ── pv-1: auth + input validation. ──────────────────────────────────
      {
        const r = await callRoute(opplevelserRouter, { body: { hidden: true, providerIds: ["pv-a"] } });
        assertEq(r.status, 403, "pv-1a: no admin key → 403");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { providerIds: ["pv-a"] } });
        assertEq(r.status, 400, "pv-1b: missing 'hidden' boolean → 400");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { hidden: true } });
        assertEq(r.status, 400, "pv-1c: no targets at all → 400 (no wildcard mode exists)");
      }
      {
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { hidden: "true", providerIds: ["pv-a"] } });
        assertEq(r.status, 400, "pv-1d: non-boolean 'hidden' → 400");
      }
      {
        const ids = Array.from({ length: 501 }, (_, i) => `pv-cap-${i}`);
        const r = await callRoute(opplevelserRouter, { headers: adminHeaders, body: { hidden: true, providerIds: ids } });
        assertEq(r.status, 400, "pv-1e: more than 500 targets → 400 (cap enforced)");
      }

      // ── pv-2: dry-run default — reports, writes nothing. ────────────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, providerIds: ["pv-a"], orgNrs: ["966000001"] },
        });
        assertEq(r.status, 200, "pv-2a: dry-run 200");
        assertEq(r.body.dry_run, true, "pv-2b: dry-run is the default");
        assertEq(r.body.matched_count, 2, "pv-2c: both targets matched (id + org_nr)");
        assertEq(r.body.changed_count, 2, "pv-2d: both reported as would-change");
        assertEq(hiddenFlag("pv-a"), null, "pv-2e: dry-run wrote nothing (pv-a)");
        assertEq(hiddenFlag("pv-b"), null, "pv-2f: dry-run wrote nothing (pv-b)");
      }

      // ── pv-3: apply hide — by id and by org_nr, off the public grid. ────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, providerIds: ["pv-a"], orgNrs: ["966000001"], apply: true },
        });
        assertEq(r.body.dry_run, false, "pv-3a: apply mode");
        assertEq(r.body.changed_count, 2, "pv-3b: both rows changed");
        assertEq(hiddenFlag("pv-a"), 1, "pv-3c: pv-a hidden (via provider_id)");
        assertEq(hiddenFlag("pv-b"), 1, "pv-3d: pv-b hidden (via org_nr)");
        assertEq(publiclyListed("Synlig Bryggeri A"), false, "pv-3e: hidden row left the public grid");
        const rowA = (r.body.changed as any[]).find((c) => c.id === "pv-a");
        assertEq(rowA?.previous_hidden, false, "pv-3f: change row carries previous state");
        const still = expDb.prepare(`SELECT COUNT(*) c FROM experience_providers WHERE id='pv-a'`).get() as any;
        assertEq(still.c, 1, "pv-3g: hiding never deletes the row");
      }

      // ── pv-4: manual/claim-locked rows are skipped, reported. ───────────
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, orgNrs: ["966000002"], apply: true },
        });
        assertEq(r.body.changed_count, 0, "pv-4a: locked row not changed");
        assertEq((r.body.skipped_locked as any[])?.[0]?.id, "pv-c", "pv-4b: locked row reported as skipped");
        assertEq(hiddenFlag("pv-c"), null, "pv-4c: claimed provider stays visible");
      }

      // ── pv-5: unknown targets land in not_found (with which key missed). ─
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, providerIds: ["finnes-ikke"], orgNrs: ["999999998"], apply: true },
        });
        assertEq(r.body.matched_count, 0, "pv-5a: nothing matched");
        assertEq((r.body.not_found as any[]).length, 2, "pv-5b: both misses reported");
        const vias = (r.body.not_found as any[]).map((n) => n.via).sort();
        assertEq(JSON.stringify(vias), JSON.stringify(["org_nr", "provider_id"]), "pv-5c: miss carries which lookup failed");
      }

      // ── pv-6: idempotent — re-hiding an already-hidden row is unchanged. ─
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, providerIds: ["pv-a", "pv-d"], apply: true },
        });
        assertEq(r.body.changed_count, 0, "pv-6a: nothing to change on second hide");
        assertEq((r.body.unchanged as any[]).length, 2, "pv-6b: both reported as already in target state");
        assertEq(hiddenFlag("pv-a"), 1, "pv-6c: state intact");
      }

      // ── pv-7: unhide (hidden=false) clears the flag → NULL, back on grid. ─
      {
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: false, providerIds: ["pv-a"], apply: true },
        });
        assertEq(r.body.changed_count, 1, "pv-7a: unhide changed the row");
        assertEq(hiddenFlag("pv-a"), null, "pv-7b: catalog_hidden cleared to NULL (grid filter semantics)");
        assertEq(publiclyListed("Synlig Bryggeri A"), true, "pv-7c: row is publicly listed again");
      }

      // ── pv-8: gårdssalg scoping — a non-gårdssalg provider row (no
      //    producer_type, not rfb-seed) can NOT be flipped via the lever;
      //    the reference lands in not_found and the flag is untouched. ─────
      {
        expDb.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, org_nr, catalog_hidden, products, enrichment_state, verification_status, source, confidence)
           VALUES ('pv-x', 'Utenfor Vertikalen', 'experiences', '966000009', NULL, '["x"]', 'raw', 'pending_verify', 'test-fixture', 'medium')`
        ).run();
        const r = await callRoute(opplevelserRouter, {
          headers: adminHeaders,
          body: { hidden: true, providerIds: ["pv-x"], orgNrs: ["966000009"], apply: true },
        });
        assertEq(r.body.matched_count, 0, "pv-8a: non-gårdssalg row never matches the lever");
        assertEq((r.body.not_found as any[]).length, 2, "pv-8b: both references reported as not_found");
        assertEq(hiddenFlag("pv-x"), null, "pv-8c: catalog_hidden untouched outside the vertical");
      }
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-provider-visibility: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}
