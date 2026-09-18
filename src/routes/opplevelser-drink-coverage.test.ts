/**
 * opplevelser-drink-coverage.test.ts — tests for
 * GET /api/opplevelser/admin/drink-coverage (src/routes/opplevelser.ts),
 * dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok,
 * Fase 5c: «Datadekning måles og rapporteres (hvor mange drikkesteder
 * finnes faktisk per fylke).»
 *
 * Harness mirrors opplevelser-gardssalg-contact-coverage.test.ts: fresh
 * require of db-factory + opplevelser per run (EXPERIENCES_DB_PATH=
 * ":memory:"), fixtures inserted with direct SQL INSERTs against
 * experience_providers (gårdssalg) and experiences (the food/drink
 * experience-category bucket), handler invoked directly via
 * router.handle() — no HTTP server / supertest.
 *
 * Exported runOpplevelserDrinkCoverageTests({log}) -> TestSummary; wired
 * into tests/test.ts.
 * Standalone: npx tsx src/routes/opplevelser-drink-coverage.test.ts
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
  opts: { headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/drink-coverage",
      originalUrl: "/admin/drink-coverage",
      path: "/admin/drink-coverage",
      query: {},
      headers: opts.headers || {},
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

export function runOpplevelserDrinkCoverageTests(
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
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    const prevAdminKey = process.env.ADMIN_KEY;
    const testKey = process.env.ADMIN_KEY || "drink-coverage-oa-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    for (const p of [dbFactoryPath, opplevelserPath]) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, rfb_seed_source, catalog_hidden)
         VALUES (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @rfb_seed_source, @catalog_hidden)`,
      );

      // Two real mead spellings — same case admin-drink-coverage's OpplevAgent
      // sibling test proves at the searchGardssalgProviders() layer; here they
      // must both land under by_subcategory.mjød, not split or dropped.
      insertProvider.run({
        id: "gs-mjoderi", navn: "Fjellmjød Gård", fylke: "Innlandet", kommune: "Lillehammer",
        producer_type: "mjøderi", rfb_seed_source: null, catalog_hidden: null,
      });
      insertProvider.run({
        id: "gs-mjoderi-alt", navn: "Vidde Mjoderi", fylke: "Innlandet", kommune: "Ringebu",
        producer_type: "mjoderi", rfb_seed_source: null, catalog_hidden: null,
      });
      insertProvider.run({
        id: "gs-bryggeri", navn: "Fjellbekk Bryggeri", fylke: "Vestland", kommune: "Voss",
        producer_type: "bryggeri", rfb_seed_source: null, catalog_hidden: null,
      });
      // A KNOWN non-drink type — must be excluded entirely (isGardssalgDrinkType
      // believes a recognised non-drink type, unlike NULL/unknown).
      insertProvider.run({
        id: "gs-butikk", navn: "Vanlig Gårdsbutikk", fylke: "Vestland", kommune: "Voss",
        producer_type: "gardsbutikk", rfb_seed_source: null, catalog_hidden: null,
      });
      // NULL producer_type + rfb_seed_source='rfb-seed' — the documented
      // "unknown counts as drink" cohort (86% of production rows historically).
      insertProvider.run({
        id: "gs-unknown", navn: "Ukjent Type Gård", fylke: "Trøndelag", kommune: "Trondheim",
        producer_type: null, rfb_seed_source: "rfb-seed", catalog_hidden: null,
      });
      // catalog_hidden=1 — excluded regardless of producer_type.
      insertProvider.run({
        id: "gs-hidden", navn: "Skjult Bryggeri", fylke: "Vestland", kommune: "Bergen",
        producer_type: "bryggeri", rfb_seed_source: null, catalog_hidden: 1,
      });

      const insertExperience = expDb.prepare(
        `INSERT INTO experiences
           (id, title, slug, category, fylke, kommune, verification_status, confidence, canonical_id)
         VALUES (@id, @title, @slug, @category, @fylke, @kommune, @verification_status, @confidence, @canonical_id)`,
      );
      insertExperience.run({
        id: "exp-matdrikke1", title: "Gårdsmat og lokalt øl", slug: "gardsmat-og-lokalt-ol",
        category: "mat_drikke", fylke: "Innlandet", kommune: "Lillehammer",
        verification_status: "verified", confidence: "high", canonical_id: null,
      });
      insertExperience.run({
        id: "exp-matdrikke2", title: "Smak av Vestland", slug: "smak-av-vestland",
        category: "mat_drikke", fylke: "Vestland", kommune: "Voss",
        verification_status: "verified", confidence: "medium", canonical_id: null,
      });
      // Wrong category — must be excluded.
      insertExperience.run({
        id: "exp-natur", title: "Fjelltur", slug: "fjelltur",
        category: "natur_friluft", fylke: "Innlandet", kommune: "Lillehammer",
        verification_status: "verified", confidence: "high", canonical_id: null,
      });
      // Right category but not verified — must be excluded.
      insertExperience.run({
        id: "exp-pending", title: "Ny Matopplevelse", slug: "ny-matopplevelse",
        category: "mat_drikke", fylke: "Innlandet", kommune: "Lillehammer",
        verification_status: "pending_verify", confidence: "high", canonical_id: null,
      });
      // Right category, verified, but a dedup loser — must be excluded.
      insertExperience.run({
        id: "exp-dup", title: "Duplikat Matopplevelse", slug: "duplikat-matopplevelse",
        category: "mat_drikke", fylke: "Innlandet", kommune: "Lillehammer",
        verification_status: "verified", confidence: "high", canonical_id: "exp-matdrikke1",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── 403 without key ─────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: without X-Admin-Key -> 403");

      // ── happy path ───────────────────────────────────────────────────────
      const ok = await callRoute(opplevelserRouter, { headers: { "x-admin-key": testKey } });
      assertEq(ok.status, 200, "b1: with valid key -> 200");
      assertEq(ok.body.grouped_by, "fylke", "b2: grouped_by is \"fylke\" — a real column on this vertical's tables");

      // gårdssalg section
      const gs = ok.body.gardssalg;
      assertEq(gs.scanned, 5,
        "b3: gardssalg.scanned counts 5 rows (excludes gs-hidden via catalog_hidden gate)");
      assertEq(gs.drink_total, 4,
        "b4: gardssalg.drink_total = 4 (2 mead spellings + bryggeri + the NULL/unknown row) — excludes gardsbutikk + hidden");
      assertEq(gs.by_subcategory.mjød, 2, "b5: by_subcategory.mjød = 2 (both 'mjøderi' AND 'mjoderi' spellings counted together)");
      assertEq(gs.by_subcategory.bryggeri, 1, "b6: by_subcategory.bryggeri = 1");
      assertEq(gs.by_subcategory.unclassified_but_drink, 1,
        "b7: the NULL-producer_type row is counted as drink but unclassified — the documented 'unknown counts as drink' rule");

      const innlandet = gs.by_fylke.find((f: any) => f.fylke === "Innlandet");
      assertEq(innlandet?.total, 2, "b8: Innlandet carries 2 gårdssalg drink rows (both mead spellings)");
      assertEq(innlandet?.counts?.mjød, 2, "b9: …both classified mjød within that fylke bucket");
      const vestland = gs.by_fylke.find((f: any) => f.fylke === "Vestland");
      assertEq(vestland?.total, 1, "b10: Vestland carries only 1 (bryggeri) — gardsbutikk + hidden bryggeri excluded");
      const trondelag = gs.by_fylke.find((f: any) => f.fylke === "Trøndelag");
      assertEq(trondelag?.total, 1, "b11: Trøndelag carries the unclassified-but-drink row");

      // experiences section
      const ex = ok.body.experiences;
      assertEq(ex.total, 2,
        "b12: experiences.total = 2 (both verified mat_drikke rows) — excludes wrong-category, pending, and dedup-loser rows");
      assertEq(ex.by_category.mat_drikke, 2, "b13: by_category.mat_drikke = 2");
      assertTrue(!("natur_friluft" in ex.by_category), "b14: a non-drink category never appears in by_category");
      const exInnlandet = ex.by_fylke.find((f: any) => f.fylke === "Innlandet");
      assertEq(exInnlandet?.total, 1, "b15: experiences by_fylke Innlandet = 1");
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevAdminKey === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prevAdminKey;
      for (const p of [dbFactoryPath, opplevelserPath]) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runOpplevelserDrinkCoverageTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
