/**
 * experiences-seo-stedsetikett-opplevelse.test.ts — dev-request
 * 2026-09-09-opplevagent-stedsetikett-poststed-og-kommunesentroide-kart,
 * Skive 2: GET /opplevelse/:slug's three-way map presentation.
 *
 * Skive 1 made this page a two-way choice — geo_precision==='kommune' (no
 * point, renderApproxPlacementCard()) vs everything else (a point,
 * renderMiniMapSection()). Skive 2 adds a real middle tier, geo_precision===
 * 'sted' (a Stedsnavn-in-kommune point — approximate, but a REAL point), so
 * the choice is now three-way via experiencesMapPresentation():
 *   - 'address'            → "exact": a point, approx:false, JSON-LD geo present
 *   - 'sted'                → "approx-point": a point, approx:true,  JSON-LD geo present
 *   - 'kommune' / null      → "no-point": NO point (the AC2 no-point card), JSON-LD geo ABSENT
 *
 * The 'kommune'/null case is a direct regression test against Skive 1's own
 * AC2 test (a kommune-precision row must still draw no point and omit `geo`
 * from JSON-LD) — this file proves Skive 2 didn't loosen that.
 *
 * geo_precision='sted' is never written by createExperience() (its zod
 * schema only allows 'address'/'kommune' — no production write path sets it
 * on the `experiences` table in this slice; see experiences-geocode-worker.ts
 * Step B/E's exclusion list), so that row is seeded via a direct SQL UPDATE
 * after a normal createExperience() call, exactly like
 * experiences-address-upgrade.test.ts already does for 'kommune'.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-stedsetikett-opplevelse.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoStedsetikettOpplevelseTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut used across this route's sibling
// .test.ts files (experiences-seo-place-geo.test.ts,
// experiences-seo-produsent-render-guards.test.ts, …).
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

export function runExperiencesSeoStedsetikettOpplevelseTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences");

      const providerId = expStore.createProvider({
        navn: "Innset Gårdsutsalg AS", fylke: "Trøndelag", kommune: "Rennebu",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // ── (1) geo_precision='sted' — a real, approximate point ────────────
      const stedId = expStore.createExperience({
        title: "Bærplukking på Innset", provider_id: providerId, provider_match_status: "matched",
        category: "mat_drikke_host", fylke: "Trøndelag", kommune: "Rennebu",
        verification_status: "verified", confidence: "high",
        loc_lat: 62.72083, loc_lon: 10.04259, geo_precision: "kommune", // placeholder valid enum value
      });
      db.prepare(`UPDATE experiences SET geo_precision = 'sted' WHERE id = ?`).run(stedId);
      const stedSlug = (expStore.getExperienceById(stedId) as any).slug as string;

      // ── (2) geo_precision='kommune' — regression against Skive 1's AC2 ──
      const kommuneId = expStore.createExperience({
        title: "Fjelltur i Rennebu kommune", provider_id: providerId, provider_match_status: "matched",
        category: "sightseeing_transport", fylke: "Trøndelag", kommune: "Rennebu",
        verification_status: "verified", confidence: "high",
        loc_lat: 62.766, loc_lon: 9.888, geo_precision: "kommune",
      });
      const kommuneSlug = (expStore.getExperienceById(kommuneId) as any).slug as string;

      // ── (3) geo_precision='address' — exact, unchanged ──────────────────
      const addressId = expStore.createExperience({
        title: "Omvisning på gårdstunet", provider_id: providerId, provider_match_status: "matched",
        category: "mat_drikke_host", fylke: "Trøndelag", kommune: "Rennebu",
        verification_status: "verified", confidence: "high",
        loc_lat: 62.73, loc_lon: 10.05, geo_precision: "address",
      });
      const addressSlug = (expStore.getExperienceById(addressId) as any).slug as string;

      const seoRouter = (require("./experiences-seo") as typeof import("./experiences-seo")).default as any;

      // ── (1) 'sted' assertions ───────────────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, `/opplevelse/${stedSlug}`);
        assertTrue(r.handled && r.status === 200, `sted-1: 'sted' experience renders (status ${r.status})`);
        assertTrue(r.body.includes('"lat":62.72083') && r.body.includes('"lon":10.04259'),
          "sted-2: mini-map data island carries the real 'sted' coordinates");
        assertTrue(r.body.includes('"approx":true'), "sted-3: 'sted' draws a mini-map point with approx:true");
        assertTrue(!r.body.includes("Omtrentlig plassering"), "sted-4: 'sted' does NOT render the no-point AC2 card");
        assertTrue(/"latitude":62\.72083,"longitude":10\.04259/.test(r.body),
          "sted-5: 'sted' JSON-LD `geo` node IS present with the real coordinates");
      }

      // ── (2) 'kommune' — regression against Skive 1's own AC2 test ───────
      {
        const r = await callHtmlRoute(seoRouter, `/opplevelse/${kommuneSlug}`);
        assertTrue(r.handled && r.status === 200, `komm-1: 'kommune' experience renders (status ${r.status})`);
        assertTrue(r.body.includes("Omtrentlig plassering"), "komm-2: 'kommune' still renders the AC2 no-point card");
        assertTrue(!r.body.includes('"lat":62.766'), "komm-3: 'kommune' does NOT draw a mini-map point");
        assertTrue(!/"latitude":62\.766/.test(r.body), "komm-4: 'kommune' JSON-LD `geo` node is ABSENT (no fabricated precision)");
      }

      // ── (3) 'address' — unchanged, exact ────────────────────────────────
      {
        const r = await callHtmlRoute(seoRouter, `/opplevelse/${addressSlug}`);
        assertTrue(r.handled && r.status === 200, `addr-1: 'address' experience renders (status ${r.status})`);
        assertTrue(r.body.includes('"lat":62.73') && r.body.includes('"lon":10.05'),
          "addr-2: 'address' mini-map data island carries the coordinates");
        assertTrue(r.body.includes('"approx":false'), "addr-3: 'address' draws a mini-map point with approx:false");
        assertTrue(/"latitude":62\.73,"longitude":10\.05/.test(r.body), "addr-4: 'address' JSON-LD `geo` node IS present");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-stedsetikett-opplevelse: unexpected error: " + String(err?.stack || err?.message || err));
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
  runExperiencesSeoStedsetikettOpplevelseTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
