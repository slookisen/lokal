/**
 * a2a-stats-vertical.test.ts — orchestrator-pr-1 (dev-request: RFB
 * visibility-growth routine's "known, out of scope" flag, 2026-08-19..22).
 *
 * GET /api/stats (src/routes/a2a.ts) is mounted ONCE, globally, at root
 * (app.use("/", a2aRoutes) in index.ts), and the finn-tannlege.com /
 * opplevagent.no host-routing gates in index.ts both pass /api/* through to
 * this SAME shared router — so before this fix, EVERY host (including
 * dental and experiences) got marketplaceRegistry.getStats()'s RFB `agents`
 * table numbers back under `data.registry`.
 *
 * Covers:
 *   1. A dental-hostname (finn-tannlege.com) request returns
 *      dental_agents-derived numbers (getDentalMarketplaceStats(),
 *      src/services/dental-store.ts) — asserted against the ACTUAL filtered
 *      value computed from the seeded fixture, not just "not equal to
 *      RFB's number" (avoids a flaky/coincidental pass).
 *   2. An experiences-hostname (opplevagent.no) request returns
 *      experience_providers/experiences-derived numbers
 *      (getExperiencesMarketplaceStats(), src/services/experience-store.ts),
 *      same discipline.
 *   3. The default/RFB hostname (rettfrabonden.com, and no Host header at
 *      all) is BYTE-IDENTICAL to marketplaceRegistry.getStats() called
 *      directly — the regression guard, since /health shares that same
 *      cached call and must never regress.
 *
 * Same harness convention as analytics-adminkey.test.ts / rfb-homepage-
 * category-chips.test.ts: own in-memory DB(s) via __setDbForTesting (rfb)
 * and the DENTAL_DB_PATH / EXPERIENCES_DB_PATH ":memory:" + db-factory
 * reset convention (experience-store.test.ts), the REAL router pulled off
 * require() fresh and driven via router.handle(req, res, next) with a fake
 * req/res — no HTTP server, no port.
 *
 * Exported runA2aStatsVerticalTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/a2a-stats-vertical.test.ts
 */

import Database from "better-sqlite3";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.header = () => r;
  r.setHeader = () => {};
  return r;
}

function fakeReq(url: string, hostname: string) {
  return {
    method: "GET",
    url,
    query: {},
    headers: {},
    hostname,
    get(_name: string) { return undefined; },
  };
}

export async function runA2aStatsVerticalTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");

  const prevRfbDb = __peekDbForTesting();
  const prevDentalDbPath = process.env.DENTAL_DB_PATH;
  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;

  const rfbTestDb = new Database(":memory:");
  rfbTestDb.pragma("journal_mode = DELETE");
  rfbTestDb.pragma("foreign_keys = OFF");

  process.env.DENTAL_DB_PATH = ":memory:";
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const dentalStorePath = require.resolve("../services/dental-store");
  const experienceStorePath = require.resolve("../services/experience-store");
  const a2aRoutePath = require.resolve("./a2a");
  const cachePaths = [dbFactoryPath, dentalStorePath, experienceStorePath, a2aRoutePath];
  for (const p of cachePaths) delete require.cache[p];

  try {
    // ── RFB fixtures (in-memory, via __setDbForTesting) ────────────────
    __setDbForTesting(rfbTestDb as any);
    __initSchemaForTesting(rfbTestDb as any);

    function seedRfbAgent(row: { id: string; city: string | null; umbrellaType?: string | null }): void {
      rfbTestDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          city, is_active, umbrella_type, created_at, last_seen_at
        ) VALUES (?, ?, 'En beskrivelse', ?, ?, ?, 'producer', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
      ).run(
        row.id, `Testgård ${row.id}`, `Testgård ${row.id}`, `${row.id}@example.no`,
        `https://${row.id}.example.no`, `key-${row.id}`, row.city, row.umbrellaType ?? null,
      );
    }
    // 3 real producers (Oslo, Oslo, Bergen) + 1 umbrella agent (excluded
    // from activeProducers/cities by marketplaceRegistry.getStats(), same
    // as production) — gives RFB a distinctive fixture-derived number set.
    seedRfbAgent({ id: "rfb-1", city: "Oslo" });
    seedRfbAgent({ id: "rfb-2", city: "Oslo" });
    seedRfbAgent({ id: "rfb-3", city: "Bergen" });
    seedRfbAgent({ id: "rfb-umbrella", city: "Oslo", umbrellaType: "venue" });

    // marketplaceRegistry caches getStats() for 60s (module-level
    // singleton) — reset before every read so it doesn't answer from a
    // stale cache left by an earlier suite. Established pattern, see e.g.
    // rfb-homepage-category-chips.test.ts.
    const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
    regMod.marketplaceRegistry._statsCache = null;
    regMod.marketplaceRegistry._agentsCache = null;

    // ── Dental fixtures (in-memory, via DENTAL_DB_PATH) ─────────────────
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const dentalDb = dbFactory.getDb("dental");
    const insertDental = dentalDb.prepare(
      `INSERT INTO dental_agents (id, navn, poststed, fylke, verification_status, is_inactive)
       VALUES (@id, @navn, @poststed, @fylke, @verification_status, @is_inactive)`
    );
    // 3 real, visible clinics (2x Oslo, 1x Bergen) + 1 rejected + 1
    // permanently-closed (is_inactive=1) — rejected/inactive rows must
    // never inflate activeProducers/cities but DO count toward the raw
    // totalAgents COUNT(*).
    insertDental.run({ id: "d-1", navn: "Tannlege 1", poststed: "Oslo", fylke: "Oslo", verification_status: "verified", is_inactive: 0 });
    insertDental.run({ id: "d-2", navn: "Tannlege 2", poststed: "Oslo", fylke: "Oslo", verification_status: "pending_verify", is_inactive: 0 });
    insertDental.run({ id: "d-3", navn: "Tannlege 3", poststed: "Bergen", fylke: "Vestland", verification_status: "verified", is_inactive: 0 });
    insertDental.run({ id: "d-rejected", navn: "Tannlege Avvist", poststed: "Trondheim", fylke: "Trøndelag", verification_status: "rejected", is_inactive: 0 });
    insertDental.run({ id: "d-closed", navn: "Tannlege Nedlagt", poststed: "Stavanger", fylke: "Rogaland", verification_status: "verified", is_inactive: 1 });

    // ── Experiences fixtures (in-memory, via EXPERIENCES_DB_PATH) ───────
    const experiencesDb = dbFactory.getDb("experiences");
    const insertProvider = experiencesDb.prepare(
      `INSERT INTO experience_providers
         (id, navn, vertical, kommune, fylke, producer_type, rfb_seed_source, catalog_hidden, brreg_active)
       VALUES (@id, @navn, 'experiences', @kommune, @fylke, @producer_type, @rfb_seed_source, @catalog_hidden, @brreg_active)`
    );
    // 2 real, visible gårdssalg providers (Bergen, Oslo), Brreg-active (so
    // their experiences pass countPublishedExperiences()'s
    // p.brreg_active = 1 join gate) + 1 catalog_hidden (must never count as
    // active/visible) + 1 with no producer_type/rfb_seed_source at all (not
    // yet a real gårdssalg row -> excluded).
    insertProvider.run({ id: "e-1", navn: "Sidergård", kommune: "Bergen", fylke: "Vestland", producer_type: "cideri", rfb_seed_source: null, catalog_hidden: null, brreg_active: 1 });
    insertProvider.run({ id: "e-2", navn: "Bryggeri Oslo", kommune: "Oslo", fylke: "Oslo", producer_type: "bryggeri", rfb_seed_source: null, catalog_hidden: null, brreg_active: 1 });
    insertProvider.run({ id: "e-hidden", navn: "Skjult Gård", kommune: "Bergen", fylke: "Vestland", producer_type: "cideri", rfb_seed_source: null, catalog_hidden: 1, brreg_active: 1 });
    insertProvider.run({ id: "e-not-visible", navn: "Ikke gårdssalg", kommune: "Trondheim", fylke: "Trøndelag", producer_type: null, rfb_seed_source: null, catalog_hidden: null, brreg_active: 1 });

    const insertExperience = experiencesDb.prepare(
      `INSERT INTO experiences (id, provider_id, title, slug, verification_status, confidence, canonical_id)
       VALUES (@id, @provider_id, @title, @slug, @verification_status, @confidence, NULL)`
    );
    // 2 published (verified + high/medium confidence + real slug) + 1 not
    // yet verified — only the 2 published rows count toward totalListings.
    insertExperience.run({ id: "x-1", provider_id: "e-1", title: "Sidersmaking", slug: "sidersmaking", verification_status: "verified", confidence: "high" });
    insertExperience.run({ id: "x-2", provider_id: "e-2", title: "Bryggeribesøk", slug: "bryggeribesok", verification_status: "verified", confidence: "medium" });
    insertExperience.run({ id: "x-3", provider_id: "e-1", title: "Ikke publisert", slug: "ikke-publisert", verification_status: "pending_verify", confidence: null });

    // ── Load the router fresh (post-fixtures, so module-level requires
    //    pick up the DB env overrides) and drive it directly. Deliberately
    //    does NOT re-delete db-factory's cache entry here — dental-store.ts/
    //    experience-store.ts must resolve to the SAME db-factory module
    //    instance (and its cached :memory: handles) that the fixtures above
    //    were inserted through, not a brand-new empty one. ───────────────
    delete require.cache[dentalStorePath];
    delete require.cache[experienceStorePath];
    delete require.cache[a2aRoutePath];
    const a2aRouter = require("./a2a").default as any;

    async function call(hostname: string): Promise<{ status: number; body: any }> {
      const res = fakeRes();
      const req = fakeReq("/api/stats", hostname);
      await new Promise<void>((resolve) => {
        res.json = function (b: any) { this.body = b; resolve(); return this; };
        a2aRouter.handle(req, res, () => resolve());
      });
      return { status: res.statusCode, body: res.body };
    }

    // ── Independently computed expected values (same formulas the
    //    production functions use) — the seeded fixture is small/explicit
    //    enough to hand-derive, so this doesn't just re-run the function
    //    under test against itself. ───────────────────────────────────────
    const expectedDental = {
      totalAgents: 5,          // all 5 rows, including rejected + closed
      activeProducers: 3,      // d-1, d-2, d-3 (d-rejected, d-closed excluded)
      cities: ["Oslo", "Bergen"].sort(),
      totalListings: 3,        // same as activeProducers, no listings concept
    };
    const expectedExperiences = {
      totalAgents: 4,          // all 4 provider rows
      activeProducers: 2,      // e-1, e-2 (e-hidden + e-not-visible excluded)
      cities: ["Bergen", "Oslo"].sort(),
      totalListings: 2,        // x-1, x-2 published; x-3 not verified
    };

    // ── 1. Dental hostname -> dental-table-derived numbers ──────────────
    {
      const res = await call("finn-tannlege.com");
      assertEq(res.status, 200, "dental-1: GET /api/stats on finn-tannlege.com -> 200");
      const registry = res.body?.data?.registry;
      assertEq(registry?.totalAgents, expectedDental.totalAgents, "dental-2: totalAgents = COUNT(*) FROM dental_agents (5, incl. rejected/closed)");
      assertEq(registry?.activeProducers, expectedDental.activeProducers, "dental-3: activeProducers excludes rejected + is_inactive rows (3)");
      assertEq([...(registry?.cities ?? [])].sort(), expectedDental.cities, "dental-4: cities = distinct poststed of ACTIVE rows only (Trondheim/Stavanger excluded)");
      assertEq(registry?.totalListings, expectedDental.totalListings, "dental-5: totalListings honestly mirrors activeProducers (no dental listings concept)");
    }

    // ── 2. Experiences hostname -> experience_providers-derived numbers ──
    {
      const res = await call("opplevagent.no");
      assertEq(res.status, 200, "exp-1: GET /api/stats on opplevagent.no -> 200");
      const registry = res.body?.data?.registry;
      assertEq(registry?.totalAgents, expectedExperiences.totalAgents, "exp-2: totalAgents = COUNT(*) FROM experience_providers (4, all rows)");
      assertEq(registry?.activeProducers, expectedExperiences.activeProducers, "exp-3: activeProducers = countGardssalgProviders() gate (2; hidden + non-gårdssalg row excluded)");
      assertEq([...(registry?.cities ?? [])].sort(), expectedExperiences.cities, "exp-4: cities = distinct kommune of visible gårdssalg providers only");
      assertEq(registry?.totalListings, expectedExperiences.totalListings, "exp-5: totalListings = countPublishedExperiences() (2 published, 1 pending excluded)");
    }

    // ── 3. Default/RFB hostname -> byte-identical to
    //    marketplaceRegistry.getStats() called directly (regression guard;
    //    /health shares this exact cached call). Reset the cache first so
    //    both reads see the same freshly-computed value regardless of call
    //    order. ─────────────────────────────────────────────────────────
    for (const hostname of ["rettfrabonden.com", "lokal.fly.dev", "localhost", ""]) {
      regMod.marketplaceRegistry._statsCache = null;
      const direct = regMod.marketplaceRegistry.getStats();
      regMod.marketplaceRegistry._statsCache = null;
      const res = await call(hostname);
      assertEq(res.status, 200, `rfb-${hostname || "empty"}-1: GET /api/stats on '${hostname}' -> 200`);
      assertEq(res.body?.data?.registry, direct, `rfb-${hostname || "empty"}-2: data.registry is BYTE-IDENTICAL to marketplaceRegistry.getStats() (unchanged RFB behavior)`);
      assertTrue(res.body?.data?.registry?.activeProducers >= 3, `rfb-${hostname || "empty"}-3: sanity — RFB fixture rows (3 non-umbrella) are actually reflected`);
    }

    // ── Cross-check: RFB's own numbers differ from dental's/experiences'
    //    seeded numbers (proves the dental/experiences assertions above
    //    aren't coincidentally equal to RFB's answer). ────────────────────
    {
      const rfbRes = await call("rettfrabonden.com");
      const rfbRegistry = rfbRes.body?.data?.registry;
      assertTrue(
        rfbRegistry?.activeProducers !== expectedDental.activeProducers || rfbRegistry?.totalAgents !== expectedDental.totalAgents,
        "cross-1: RFB's registry stats are NOT the same numbers as dental's (fixtures deliberately diverge)"
      );
      assertTrue(
        rfbRegistry?.activeProducers !== expectedExperiences.activeProducers || rfbRegistry?.totalAgents !== expectedExperiences.totalAgents,
        "cross-2: RFB's registry stats are NOT the same numbers as experiences' (fixtures deliberately diverge)"
      );
    }
  } catch (err: any) {
    failed++;
    failures.push("a2a-stats-vertical: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    // Restore RFB DB singleton.
    if (prevRfbDb) __setDbForTesting(prevRfbDb);
    // Restore dental/experiences DB path env vars + reset the factory so
    // later suites don't inherit this suite's in-memory handles.
    if (prevDentalDbPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalDbPath;
    if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
    else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch { /* best-effort */ }
    try {
      const regMod = require("../services/marketplace-registry") as typeof import("../services/marketplace-registry");
      regMod.marketplaceRegistry._statsCache = null;
      regMod.marketplaceRegistry._agentsCache = null;
    } catch { /* best-effort */ }
    for (const p of cachePaths) delete require.cache[p];
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runA2aStatsVerticalTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log(f);
    if (s.failed > 0) process.exit(1);
  });
}
