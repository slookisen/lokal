/**
 * experiences-seo-stedsetikett-produsent.test.ts — dev-request
 * 2026-09-09-opplevagent-stedsetikett-poststed-og-kommunesentroide-kart,
 * Skive 2: GET /kategori/gardssalg/produsent/:providerSlug's three-way map
 * presentation.
 *
 * Skive 1 made this page a two-way choice — geocode_confidence==='approximate'
 * /'no_match'/null (no point, renderApproxPlacementCard()) vs 'high'/'medium'/
 * 'low' (a point, renderMiniMapSection()). Skive 2 adds a real middle tier,
 * geocode_confidence==='sted' (experiences-geocode-worker.ts Step D's new
 * Stedsnavn-in-kommune fallback — approximate, but a REAL point, distinct
 * from both a genuine street address and the coarser kommune centroid), so
 * the choice is now three-way via gardssalgMapPresentation():
 *   - 'high'/'medium'/'low' → "exact":       a point, approx:false, JSON-LD geo present
 *   - 'sted'                → "approx-point": a point, approx:true,  JSON-LD geo present,
 *                                              map-sub text "Ca. posisjon (sted) – åpne i kart"
 *   - 'approximate'/'no_match'/null → "no-point": NO point (the AC2 card), JSON-LD geo ABSENT
 *
 * The 'approximate' case is a direct regression test against Skive 1's own
 * AC2 test for THIS route (a kommune-centroid provider must still draw no
 * point and omit `geo` from JSON-LD) — this file proves Skive 2 didn't
 * loosen that.
 *
 * Same raw-SQL-insert-into-experience_providers + callHtmlRoute() harness as
 * experiences-seo-produsent-render-guards.test.ts (this route's own
 * established convention — geocode_confidence/lat/lon are plain columns with
 * no zod enum restriction on this table, so no schema change is needed to
 * write 'sted' here, unlike the `experiences` table's geo_precision).
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-stedsetikett-produsent.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoStedsetikettProdusentTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as the sibling .test.ts files.
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() {},
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export function runExperiencesSeoStedsetikettProdusentTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @poststed, @producer_type, 1, NULL, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'verified', 'test-fixture', 'medium')`,
      );

      // (1) 'sted' — Step D's new Stedsnavn-in-kommune tier.
      insertProvider.run({
        id: "gs-sted-1", navn: "Innset Gårdsutsalg", producer_type: "gardsutsalg",
        slug: "innset-gardsutsalg", fylke: "Trøndelag", kommune: "Rennebu", poststed: "Rennebu",
        lat: 62.72083, lon: 10.04259, geocode_confidence: "sted",
      });

      // (2) 'approximate' — Step D's pre-existing kommune-centroid tier
      // (regression against Skive 1's own AC2 test for this route).
      insertProvider.run({
        id: "gs-sted-2", navn: "Sentrumsgård Bryggeri", producer_type: "bryggeri",
        slug: "sentrumsgard-bryggeri", fylke: "Trøndelag", kommune: "Rennebu", poststed: "Rennebu",
        lat: 62.7661, lon: 9.8876, geocode_confidence: "approximate",
      });

      // (3) 'high' — Step A's real street-address geocode, unchanged.
      insertProvider.run({
        id: "gs-sted-3", navn: "Gårdstunet Sideri", producer_type: "sideri",
        slug: "gardstunet-sideri", fylke: "Trøndelag", kommune: "Rennebu", poststed: "Rennebu",
        lat: 62.73, lon: 10.05, geocode_confidence: "high",
      });

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (1) 'sted' assertions ───────────────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/innset-gardsutsalg");
        assertTrue(r.handled && r.status === 200, `sted-1: 'sted' provider renders (status ${r.status})`);
        assertTrue(r.body.includes('"lat":62.72083') && r.body.includes('"lon":10.04259'),
          "sted-2: mini-map data island carries the real 'sted' coordinates");
        assertTrue(r.body.includes('"approx":true'), "sted-3: 'sted' draws a mini-map point with approx:true");
        assertTrue(!r.body.includes("Omtrentlig plassering"), "sted-4: 'sted' does NOT render the no-point AC2 card");
        assertTrue(r.body.includes("Ca. posisjon (sted) – åpne i kart"),
          "sted-5: the OSM-link map-sub text is the new 'sted'-specific wording");
        assertTrue(/"latitude":62\.72083,"longitude":10\.04259/.test(r.body),
          "sted-6: 'sted' JSON-LD `geo` node IS present with the real coordinates");
      }

      // ── (2) 'approximate' — regression against Skive 1's own AC2 test ───
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/sentrumsgard-bryggeri");
        assertTrue(r.handled && r.status === 200, `approx-1: 'approximate' provider renders (status ${r.status})`);
        assertTrue(r.body.includes("Omtrentlig plassering"), "approx-2: 'approximate' still renders the AC2 no-point card");
        assertTrue(!r.body.includes('"lat":62.7661'), "approx-3: 'approximate' does NOT draw a mini-map point");
        assertTrue(r.body.includes("Ca. posisjon (kommune) – åpne i kart"),
          "approx-4: the OSM-link map-sub text is unchanged ('kommune' wording, not 'sted')");
        assertTrue(!/"latitude":62\.7661/.test(r.body), "approx-5: 'approximate' JSON-LD `geo` node is ABSENT (no fabricated precision)");
      }

      // ── (3) 'high' — unchanged, exact ───────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, "/kategori/gardssalg/produsent/gardstunet-sideri");
        assertTrue(r.handled && r.status === 200, `high-1: 'high' provider renders (status ${r.status})`);
        assertTrue(r.body.includes('"lat":62.73') && r.body.includes('"lon":10.05'),
          "high-2: 'high' mini-map data island carries the coordinates");
        assertTrue(r.body.includes('"approx":false'), "high-3: 'high' draws a mini-map point with approx:false");
        assertTrue(r.body.includes("Åpne i kart (OpenStreetMap)"), "high-4: the OSM-link map-sub text is the plain exact-case wording");
        assertTrue(/"latitude":62\.73,"longitude":10\.05/.test(r.body), "high-5: 'high' JSON-LD `geo` node IS present");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-stedsetikett-produsent: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort cleanup */ }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoStedsetikettProdusentTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
