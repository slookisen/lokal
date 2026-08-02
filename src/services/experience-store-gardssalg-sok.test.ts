/**
 * experience-store-gardssalg-sok.test.ts — unit tests for
 * searchGardssalgProvidersByQuery() (src/services/experience-store.ts),
 * added by dev-request 2026-08-01-gardssalg-profilkomplett-og-soekbar-foer-
 * outreach, Steg 1.
 *
 * Background: gårdssalg producers (drink producers, e.g. bryggeri/sideri/
 * brenneri) live in `experience_providers`, NOT `experiences` — the only
 * table searchPublishedExperiences() (the existing /sok free-text search)
 * ever queries. Producers therefore had ZERO presence in search; a
 * producer's own name typed into /sok returned "Ingen treff" (measured
 * 2026-08-01: 12 of 13 outreach-candidate producers unsearchable on their
 * own name). searchGardssalgProvidersByQuery() is the fix's store-level
 * function — this file covers it directly, without booting the /sok route
 * (see experiences-seo-sok-gardssalg.test.ts for the route-level coverage).
 *
 * Covers:
 *   (a) matches by producer name (navn).
 *   (b) matches by kommune and by fylke.
 *   (c) a catalog_hidden=1 row is EXCLUDED (same gate as
 *       listGardssalgProviders()/searchGardssalgProviders()).
 *   (d) a row that fails the gårdssalg gate (producer_type IS NULL AND
 *       rfb_seed_source != 'rfb-seed') is EXCLUDED, even though its navn
 *       would otherwise match — proves this isn't just "any provider row".
 *   (e) æøå in the query works (both in the query string and in the matched
 *       field).
 *   (f) a row with no slug is EXCLUDED (no profile page to link to).
 *   (g) an empty/whitespace-only query returns [] without touching the DB
 *       query builder in a broken way.
 *
 * Same in-memory-DB + require.cache-reset pattern as
 * opplevelser-gardssalg-rest-discover.test.ts / experiences-seo-sok-geo.test.ts.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experience-store-gardssalg-sok.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperienceStoreGardssalgSokTests() and folds its pass/fail counts
 *      into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

export function runExperienceStoreGardssalgSokTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const cachePaths = [dbFactoryPath, expStorePath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const expStore = require("./experience-store") as typeof import("./experience-store");

      // ── Fixtures — same raw-insert pattern as
      // opplevelser-gardssalg-rest-discover.test.ts (createProvider() doesn't
      // support producer_type/slug/catalog_hidden). ──────────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );

      // gs-atlungstad: the dev-request's own concrete case — real, searchable.
      insertProvider.run({
        id: "gs-atlungstad", navn: "Atlungstad Brenneri", fylke: "Innlandet", kommune: "Stange",
        poststed: "Stange", producer_type: "brenneri", booking_live: null, catalog_hidden: null,
        lat: 60.73, lon: 11.15, geocode_confidence: "high", slug: "atlungstad-brenneri",
      });
      // gs-fjord: real, searchable by kommune ("Bergen") and fylke ("Vestland").
      insertProvider.run({
        id: "gs-fjord", navn: "Fjordgard Bryggeri", fylke: "Vestland", kommune: "Bergen",
        poststed: "Bergen", producer_type: "bryggeri", booking_live: 1, catalog_hidden: null,
        lat: 60.39, lon: 5.32, geocode_confidence: "high", slug: "fjordgard-bryggeri",
      });
      // gs-hidden: matches "Skjult" and every other predicate a live row
      // would, yet catalog_hidden=1 — must NEVER appear.
      insertProvider.run({
        id: "gs-hidden", navn: "Skjult Gardsmat AS", fylke: "Vestland", kommune: "Bergen",
        poststed: "Bergen", producer_type: "bryggeri", booking_live: 1, catalog_hidden: 1,
        lat: 60.40, lon: 5.33, geocode_confidence: "high", slug: "skjult-gardsmat",
      });
      // gs-notgate: navn matches "Ikkegard", but fails the gårdssalg gate
      // (producer_type NULL, rfb_seed_source not 'rfb-seed') — an ordinary
      // experience-only provider row that must never leak into producer
      // search results.
      insertProvider.run({
        id: "gs-notgate", navn: "Ikkegard Opplevelser AS", fylke: "Vestland", kommune: "Bergen",
        poststed: "Bergen", producer_type: null, booking_live: null, catalog_hidden: null,
        lat: 60.41, lon: 5.34, geocode_confidence: "high", slug: "ikkegard-opplevelser",
      });
      // gs-noslug: real, matches "Sagene", but has no slug — no profile page
      // to link to, so must be excluded (mirrors listGardssalgProviderMapPoints()'s
      // own slug predicate for the same reason).
      insertProvider.run({
        id: "gs-noslug", navn: "Sagene Bryggeri", fylke: "Oslo", kommune: "Oslo",
        poststed: "Oslo", producer_type: "bryggeri", booking_live: null, catalog_hidden: null,
        lat: 59.92, lon: 10.75, geocode_confidence: "high", slug: null,
      });
      // gs-aeoa: real, searchable — name AND poststed both carry æøå, proving
      // the query handles Norwegian characters on both sides of the match.
      insertProvider.run({
        id: "gs-aeoa", navn: "Ciderhuset Balestrand", fylke: "Vestland", kommune: "Sogndal",
        poststed: "Balestrand", producer_type: "cideri", booking_live: null, catalog_hidden: null,
        lat: 61.21, lon: 6.53, geocode_confidence: "high", slug: "ciderhuset-balestrand",
      });
      insertProvider.run({
        id: "gs-hebnes", navn: "Hebnes Vingård", fylke: "Rogaland", kommune: "Kvitsøy",
        poststed: "Hebnesøy", producer_type: "vingård", booking_live: null, catalog_hidden: null,
        lat: 59.06, lon: 5.42, geocode_confidence: "high", slug: "hebnes-vingaard",
      });

      // ── (a) matches by producer name ─────────────────────────────────
      const byName = expStore.searchGardssalgProvidersByQuery("Atlungstad");
      assertEq(byName.length, 1, "a1: 'Atlungstad' matches exactly 1 producer");
      assertEq(byName[0]?.navn, "Atlungstad Brenneri", "a2: matched row is Atlungstad Brenneri");
      assertEq(byName[0]?.slug, "atlungstad-brenneri", "a3: slug present on the result row");
      assertEq(byName[0]?.producer_type, "brenneri", "a4: producer_type present on the result row");

      // Daniel's own binding acceptance-criterion queries (dev-request
      // §"Akseptkriterier", #1) — each must hit its producer profile.
      assertTrue(
        expStore.searchGardssalgProvidersByQuery("Ciderhuset Balestrand").some((r) => r.slug === "ciderhuset-balestrand"),
        "a5: 'Ciderhuset Balestrand' (Daniel's own test query) matches its producer"
      );
      assertTrue(
        expStore.searchGardssalgProvidersByQuery("Hebnes Vingård").some((r) => r.slug === "hebnes-vingaard"),
        "a6: 'Hebnes Vingård' (Daniel's own test query) matches its producer"
      );

      // ── (b) matches by kommune / fylke ──────────────────────────────
      const byKommune = expStore.searchGardssalgProvidersByQuery("Bergen");
      const kommuneNames = byKommune.map((r) => r.navn);
      assertTrue(kommuneNames.includes("Fjordgard Bryggeri"), "b1: kommune='Bergen' query matches Fjordgard Bryggeri");
      assertTrue(!kommuneNames.includes("Skjult Gardsmat AS"), "b2: hidden row still excluded when matching by kommune");
      assertTrue(!kommuneNames.includes("Ikkegard Opplevelser AS"), "b3: non-gate row still excluded when matching by kommune");

      const byFylke = expStore.searchGardssalgProvidersByQuery("Vestland");
      const fylkeNames = byFylke.map((r) => r.navn);
      assertTrue(fylkeNames.includes("Fjordgard Bryggeri"), "b4: fylke='Vestland' query matches Fjordgard Bryggeri");
      assertTrue(fylkeNames.includes("Ciderhuset Balestrand"), "b5: fylke='Vestland' query also matches Ciderhuset Balestrand");

      // ── (c) catalog_hidden=1 row EXCLUDED under every query that would
      //     otherwise match it ────────────────────────────────────────
      const hiddenByName = expStore.searchGardssalgProvidersByQuery("Skjult");
      assertEq(hiddenByName.length, 0, "c1: 'Skjult' (matches only the hidden row's name) returns zero results");

      // ── (d) gate failure — producer_type NULL + not rfb-seed EXCLUDED ──
      const gateFail = expStore.searchGardssalgProvidersByQuery("Ikkegard");
      assertEq(gateFail.length, 0, "d1: 'Ikkegard' (matches only the non-gate row's name) returns zero results");

      // ── (e) æøå — query AND matched field both carry Norwegian chars ──
      const aeoaQuery = expStore.searchGardssalgProvidersByQuery("Balestrand");
      assertTrue(aeoaQuery.some((r) => r.navn === "Ciderhuset Balestrand"), "e1: 'Balestrand' (æøå-free query, æøå-adjacent) still matches");
      const aeoaField = expStore.searchGardssalgProvidersByQuery("Vingård");
      assertTrue(aeoaField.some((r) => r.navn === "Hebnes Vingård"), "e2: 'Vingård' (å in the query itself) matches Hebnes Vingård");
      const aeoaLower = expStore.searchGardssalgProvidersByQuery("vingård");
      assertTrue(aeoaLower.some((r) => r.navn === "Hebnes Vingård"), "e3: lowercase 'vingård' still matches (case-insensitive)");

      // ── (f) no-slug row EXCLUDED (nothing to link to) ─────────────────
      const noSlug = expStore.searchGardssalgProvidersByQuery("Sagene");
      assertEq(noSlug.length, 0, "f1: 'Sagene' (matches only the no-slug row's name) returns zero results");

      // ── (g) empty/whitespace query → [] ────────────────────────────
      assertEq(expStore.searchGardssalgProvidersByQuery(""), [], "g1: empty query returns []");
      assertEq(expStore.searchGardssalgProvidersByQuery("   "), [], "g2: whitespace-only query returns []");

      // ── sanity: a query with zero real-world matches returns [] cleanly ──
      assertEq(expStore.searchGardssalgProvidersByQuery("xyzzy-no-such-producer-anywhere"), [], "sanity: nonsense query returns []");
    } catch (err: any) {
      failed++;
      failures.push("experience-store-gardssalg-sok: unexpected error: " + String(err?.stack || err?.message || err));
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

if (require.main === module) {
  runExperienceStoreGardssalgSokTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    if (result.failed > 0) process.exit(1);
  });
}
