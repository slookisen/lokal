/**
 * experiences-seo-map-tiles.test.ts — pins the OpenStreetMap tile-source
 * contract every Leaflet map on opplevagent.no must honour.
 *
 * Background (2026-09-16, Daniel: «alle kart er ødelagt»): every tile on the
 * /kategori/gardssalg map and on every producer profile's mini-map rendered
 * OSM's "403 Access blocked — App is not following the tile usage policy"
 * image. tile.openstreetmap.org blocks browser requests that carry no
 * Referer header, and the site-wide Helmet `Referrer-Policy: no-referrer`
 * header made browsers strip it from every tile <img>. The fix lives in ONE
 * place — OSM_TILE_LAYER_JS in experiences-seo.ts — and these tests make sure
 * every map actually renders it:
 *
 *   1. /fylke/:fylke cluster map
 *   2. /kategori/gardssalg cluster map
 *   3. /opplevelse/:slug mini-map
 *   4. /kategori/gardssalg/produsent/:slug mini-map
 *
 * For each REAL rendered page: (a) the canonical
 * https://tile.openstreetmap.org/{z}/{x}/{y}.png URL is used — never the
 * deprecated {s}. a/b/c subdomains; (b) EVERY L.tileLayer( call on the page
 * carries referrerPolicy: 'strict-origin-when-cross-origin' (count equality,
 * so a future copy that forgets it fails here, not in production); (c) the
 * linked OSM attribution sits inside the tile-layer options. Plus: the
 * vendored Leaflet build actually implements the referrerPolicy option (it
 * is silently ignored by Leaflet < 1.8 — a downgrade would re-break every
 * map without any other test noticing), and a browse page without a map
 * still carries no tile layer at all (honest omission unchanged).
 *
 * Same in-memory experiences DB + router.handle() pattern as
 * experiences-seo-place-geo.test.ts. Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-map-tiles.test.ts
 *   2. Wired into the gate: tests/test.ts folds the exported runner's
 *      pass/fail counts into the `npm test` summary.
 */

import fs from "fs";
import path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Minimal synthetic Request/Response for driving the Express Router directly
// (no listen()/http round-trip) — mirrors callHtmlRoute() in
// experiences-seo-place-geo.test.ts, with a few extra no-op response helpers
// so detail pages that set content-type/vary headers never throw here.
function callHtmlRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: { host: "opplevagent.no" },
      hostname: "opplevagent.no",
      protocol: "https",
      secure: true,
      ip: "127.0.0.1",
      get(name: string) { return String(name).toLowerCase() === "host" ? "opplevagent.no" : undefined; },
    };
    const res: any = {
      statusCode: 200,
      locals: {},
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      setHeader() { return this; },
      set() { return this; },
      type() { return this; },
      vary() { return this; },
      redirect() { resolve({ handled: true, status: 301, body: "" }); },
      send(body: unknown) {
        resolve({ handled: true, status: statusCode, body: String(body) });
      },
      json(payload: unknown) {
        resolve({ handled: true, status: statusCode, body: JSON.stringify(payload) });
      },
      end() { resolve({ handled: true, status: statusCode, body: "" }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export function runExperiencesSeoMapTilesTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    for (const p of [dbFactoryPath, expStorePath, seoPath]) delete require.cache[p];

    let dbFactory: typeof import("../database/db-factory") | null = null;
    try {
      dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences");
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const seoRouter = seo.default as any;

      const CANONICAL_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
      const REFERRER_POLICY = "strict-origin-when-cross-origin";

      // ── 0. The shared constants themselves ─────────────────────────────
      assertEq(seo.OSM_TILE_URL, CANONICAL_TILE_URL, "0a: OSM_TILE_URL is the policy's canonical tile.openstreetmap.org URL");
      assertTrue(!seo.OSM_TILE_URL.includes("{s}"), "0b: OSM_TILE_URL never uses the deprecated {s} a/b/c subdomain placeholder");
      assertEq(seo.OSM_TILE_REFERRER_POLICY, REFERRER_POLICY,
        "0c: OSM_TILE_REFERRER_POLICY is strict-origin-when-cross-origin (one of the values osm.wiki/Blocked lists as accepted)");
      assertTrue(seo.OSM_TILE_LAYER_JS.includes(`L.tileLayer('${CANONICAL_TILE_URL}'`), "0d: OSM_TILE_LAYER_JS opens the tile layer on the canonical URL");
      assertTrue(seo.OSM_TILE_LAYER_JS.includes(`referrerPolicy: '${REFERRER_POLICY}'`), "0e: OSM_TILE_LAYER_JS passes referrerPolicy to L.tileLayer");
      assertTrue(seo.OSM_TILE_LAYER_JS.includes(seo.OSM_TILE_ATTRIBUTION_HTML), "0f: OSM_TILE_LAYER_JS carries the linked OSM attribution");
      assertTrue(/openstreetmap\.org\/copyright/.test(seo.OSM_TILE_ATTRIBUTION_HTML) && /OpenStreetMap/.test(seo.OSM_TILE_ATTRIBUTION_HTML),
        "0g: attribution names OpenStreetMap and links its copyright page (tile usage policy requirement)");
      assertTrue(/\.addTo\(map\);\s*$/.test(seo.OSM_TILE_LAYER_JS), "0h: OSM_TILE_LAYER_JS is a complete statement that adds the layer to `map`");

      // ── 1. The vendored Leaflet build implements the option we rely on ──
      const leafletSrc = fs.readFileSync(path.join(__dirname, "..", "public", "leaflet", "leaflet.js"), "utf8");
      assertTrue(/options\.referrerPolicy/.test(leafletSrc),
        "1a: vendored /leaflet/leaflet.js reads options.referrerPolicy (Leaflet >= 1.8 — older builds silently ignore it and every map would break again)");
      assertTrue(/Leaflet 1\.(9|[1-9][0-9])\./.test(leafletSrc) || /Leaflet 1\.8\./.test(leafletSrc),
        "1b: vendored Leaflet is 1.8 or newer (referrerPolicy option first shipped in 1.8.0)");

      // ── Seed: one geocoded gårdssalg producer + one address-precision
      //    experience, so all four map-bearing pages actually render a map.
      const providerId = expStore.createProvider({
        navn: "Kartflis Sideri", org_nr: "912345690",
        fylke: "Vestland", kommune: "Bergen", poststed: "Bergen",
        lat: 60.39, lon: 5.32, brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      db.prepare("UPDATE experience_providers SET producer_type = ?, geocode_confidence = ? WHERE id = ?")
        .run("sideri", "high", providerId);
      expStore.backfillProviderSlugs();
      const providerRow = expStore.listGardssalgProviders(100, 0).find((p: any) => p.id === providerId) as any;
      const providerSlug = providerRow ? String(providerRow.slug) : "";
      assertTrue(providerSlug.length > 0, "seed: the gårdssalg producer got a slug");

      const expId = expStore.createExperience({
        title: "Fjordsafari fra Bergen", provider_id: providerId, provider_match_status: "matched",
        category: "sightseeing_transport", fylke: "Vestland", kommune: "Bergen", indoor_outdoor: "outdoor",
        loc_lat: 60.39, loc_lon: 5.32, geo_precision: "address",
        confidence: "high", verification_status: "verified",
      });
      const expSlug = String((expStore.getExperienceById(expId) as any).slug || "");
      assertTrue(expSlug.length > 0, "seed: the experience got a slug");

      // ── 2. Every map-bearing page renders the shared tile contract ──────
      const pages = [
        { label: "/fylke/:fylke", url: "/fylke/Vestland", mapId: 'id="fylke-map"' },
        { label: "/kategori/gardssalg", url: "/kategori/gardssalg", mapId: 'id="gardssalg-map"' },
        { label: "/opplevelse/:slug", url: `/opplevelse/${encodeURIComponent(expSlug)}`, mapId: 'id="mini-map"' },
        { label: "/kategori/gardssalg/produsent/:slug", url: `/kategori/gardssalg/produsent/${encodeURIComponent(providerSlug)}`, mapId: 'id="mini-map"' },
      ];
      for (const page of pages) {
        const r = await callHtmlRoute(seoRouter, page.url);
        assertTrue(r.handled && r.status === 200, `${page.label}: GET ${page.url} is handled, 200`);
        assertTrue(r.body.includes(page.mapId), `${page.label}: renders its map container (${page.mapId}) — the tile contract below is actually exercised, not vacuously true`);
        const tileCalls = (r.body.match(/L\.tileLayer\(/g) || []).length;
        assertTrue(tileCalls >= 1, `${page.label}: at least one L.tileLayer( call is inlined in the page`);
        const canonical = (r.body.match(/L\.tileLayer\('https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png'/g) || []).length;
        assertEq(canonical, tileCalls, `${page.label}: EVERY tile layer uses the canonical https://tile.openstreetmap.org/{z}/{x}/{y}.png URL`);
        assertTrue(!/\{s\}\.tile\.openstreetmap\.org/.test(r.body), `${page.label}: never the deprecated {s}.tile.openstreetmap.org a/b/c subdomain host`);
        const withPolicy = (r.body.match(/referrerPolicy: 'strict-origin-when-cross-origin'/g) || []).length;
        assertEq(withPolicy, tileCalls, `${page.label}: EVERY tile layer carries referrerPolicy: 'strict-origin-when-cross-origin' (overrides the site-wide no-referrer header for tile <img>s only)`);
        assertTrue(r.body.includes(seo.OSM_TILE_ATTRIBUTION_HTML), `${page.label}: the linked OSM attribution is inside the tile-layer options`);
        assertTrue(!/unpkg\.com/.test(r.body), `${page.label}: Leaflet stays self-hosted (no CDN) — the referrerPolicy option is only guaranteed for the vendored build`);
      }

      // ── 3. Honest omission unchanged: a browse page with no map carries
      //    no tile layer at all — the shared snippet is never sprayed onto
      //    pages that do not render a map.
      const noMap = await callHtmlRoute(seoRouter, "/opplevelser");
      assertTrue(noMap.handled && noMap.status === 200, "3a: GET /opplevelser is handled, 200");
      assertTrue(!/L\.tileLayer\(/.test(noMap.body) && !/tile\.openstreetmap\.org/.test(noMap.body),
        "3b: /opplevelser (no map) carries no tile layer and never names the tile host");
    } catch (err) {
      failed++;
      failures.push(`✗ experiences-seo-map-tiles threw: ${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (dbFactory) dbFactory.__resetDbFactoryForTesting();
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoMapTilesTests({ log: true }).then((r) => {
    console.log(`\nexperiences-seo-map-tiles: ${r.passed} passed, ${r.failed} failed`);
    for (const f of r.failures) console.log(f);
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
