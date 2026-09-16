/**
 * opplevelser-gardssalg-geo-marker-diagnostic.test.ts — tests for
 * GET /admin/gardssalg-geo-marker-diagnostic (src/routes/opplevelser.ts),
 * added for dev-request 2026-09-09-opplevagent-geo-batch-over-alle-profiler,
 * AC4 spot-check slice.
 *
 * AC4 needs a read-only way to confirm, per gårdssalg row: (a) no row at
 * kommune-centroid precision (geocode_confidence='approximate', 'no_match',
 * or null) ever renders a point-marker on any public map, and (b) the row's
 * `sted` place-label can be eyeballed against its own raw kommune/poststed
 * columns. This route is that surface. `would_render_point_marker` is
 * computed via the REAL `gardssalgMapPresentation()` predicate
 * (routes/experiences-seo.ts) — the same function the produsent-profil
 * mini-map calls — not a re-derived copy, so these tests also pin that the
 * diagnostic can never silently drift from the real render path.
 *
 * Mirrors opplevelser-gardssalg-outreach-readiness.test.ts's setup
 * (EXPERIENCES_DB_PATH=":memory:", fresh require of db-factory + opplevelser
 * router per run, callRoute() exercising router.handle() directly with
 * X-Admin-Key via headers, raw SQL INSERT fixtures).
 *
 * Covers:
 *   (a) 403 without X-Admin-Key, 403 with wrong X-Admin-Key
 *   (b) high/medium/low/sted geocode_confidence -> would_render_point_marker
 *       true (exact or approx-point)
 *   (c) approximate/no_match/null geocode_confidence -> false (no-point) —
 *       the actual AC4(a) regression case: an 'approximate' (kommune-
 *       centroid) row must never be marked true
 *   (d) sted/kommune/poststed/fylke passthrough, and the kommune-first
 *       `sted` label falling back to poststed when kommune is absent (AC4b
 *       inspection material)
 *   (e) pagination (limit + keyset `after`/`next_after`)
 *   (f) catalog_hidden=1 row excluded from both the batch listing and a
 *       direct `provider_id` lookup (404)
 *   (g) unknown `provider_id` -> 404
 *   (h) non-gårdssalg provider excluded from the batch listing
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
  opts: { headers?: Record<string, string>; query?: Record<string, string> } = {},
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url: "/admin/gardssalg-geo-marker-diagnostic",
      originalUrl: "/admin/gardssalg-geo-marker-diagnostic",
      path: "/admin/gardssalg-geo-marker-diagnostic",
      query: opts.query || {},
      headers: opts.headers || {},
      get() { return undefined; },
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

export function runOpplevelserGardssalgGeoMarkerDiagnosticTests(
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
    const testKey = process.env.ADMIN_KEY || "gardssalg-geo-marker-diagnostic-test-key";
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    process.env.ADMIN_KEY = testKey;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const opplevelserPath = require.resolve("./opplevelser");
    const experiencesSeoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, opplevelserPath, experiencesSeoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expDb = dbFactory.getDb("experiences");

      const insertProvider = expDb.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, rfb_seed_source, producer_type, kommune, poststed, fylke,
            lat, lon, geocode_confidence, catalog_hidden,
            enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @rfb_seed_source, @producer_type, @kommune, @poststed, @fylke,
            @lat, @lon, @geocode_confidence, @catalog_hidden,
            'raw', 'pending_verify', 'test-fixture', 'medium')`,
      );

      // ── (b) exact/approx-point fixtures (would_render_point_marker: true)
      insertProvider.run({
        id: "prov-high", navn: "Høy Presisjon Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Voss", poststed: "Voss", fylke: "Vestland",
        lat: 60.6, lon: 6.4, geocode_confidence: "high", catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-medium", navn: "Medium Presisjon Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Ulvik", poststed: "Ulvik", fylke: "Vestland",
        lat: 60.57, lon: 6.9, geocode_confidence: "medium", catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-low", navn: "Lav Presisjon Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Aurland", poststed: "Aurland", fylke: "Vestland",
        lat: 60.9, lon: 7.2, geocode_confidence: "low", catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-sted", navn: "Stedsnavn Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Tysvær", poststed: "Aksdal", fylke: "Rogaland",
        lat: 59.3, lon: 5.5, geocode_confidence: "sted", catalog_hidden: 0,
      });

      // ── (c) no-point fixtures (would_render_point_marker: false) — the
      // real AC4(a) regression coverage: 'approximate' (kommune-centroid),
      // 'no_match', and null must ALL come back false, never true.
      insertProvider.run({
        id: "prov-approx", navn: "Kommune Sentroide Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Lærdal", poststed: "Lærdalsøyri", fylke: "Vestland",
        lat: 61.1, lon: 7.5, geocode_confidence: "approximate", catalog_hidden: 0,
      });
      insertProvider.run({
        id: "prov-nomatch", navn: "Ingen Treff Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Vik", poststed: "Vik", fylke: "Vestland",
        lat: null, lon: null, geocode_confidence: "no_match", catalog_hidden: 0,
      });
      // No kommune at all — `sted` must fall back to poststed (AC4b
      // inspection material: the label the profile page shows differs from
      // the (absent) kommune column here on purpose).
      insertProvider.run({
        id: "prov-null", navn: "Ugeokodet Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: null, poststed: "Odda", fylke: "Vestland",
        lat: null, lon: null, geocode_confidence: null, catalog_hidden: 0,
      });

      // ── (f) hidden row — excluded from batch listing AND single lookup.
      insertProvider.run({
        id: "prov-hidden", navn: "Skjult Diagnostikk Gård", rfb_seed_source: "rfb-seed", producer_type: null,
        kommune: "Voss", poststed: "Voss", fylke: "Vestland",
        lat: 60.6, lon: 6.4, geocode_confidence: "high", catalog_hidden: 1,
      });

      // ── (h) non-gårdssalg provider — excluded from the batch listing.
      insertProvider.run({
        id: "prov-not-gardssalg", navn: "Ikke Gårdssalg Diagnostikk AS", rfb_seed_source: null, producer_type: null,
        kommune: "Voss", poststed: "Voss", fylke: "Vestland",
        lat: 60.6, lon: 6.4, geocode_confidence: "high", catalog_hidden: 0,
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── (a) auth gate ────────────────────────────────────────────────────
      const noKey = await callRoute(opplevelserRouter, {});
      assertEq(noKey.status, 403, "a1: GET without X-Admin-Key -> 403");
      assertTrue(!noKey.body?.providers, "a2: no-key response carries no diagnostic payload");

      const badKey = await callRoute(opplevelserRouter, { headers: { "x-admin-key": "wrong-key" } });
      assertEq(badKey.status, 403, "a3: GET with wrong X-Admin-Key -> 403");

      // ── (b)/(c)/(d)/(h) batch listing happy path ─────────────────────────
      const ok = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "50" },
      });
      assertEq(ok.status, 200, "b1: GET (valid key) -> 200");
      assertTrue(Array.isArray(ok.body.providers), "b2: providers is an array");

      const byId = (id: string) => (ok.body.providers as any[]).find((r) => r.provider_id === id);

      assertEq(ok.body.providers.length, 7, "h1: 7 rows returned (non-gårdssalg row excluded, hidden row excluded)");
      assertTrue(
        !(ok.body.providers as any[]).some((r) => r.provider_id === "prov-not-gardssalg"),
        "h2: non-gårdssalg provider excluded from batch listing",
      );
      assertTrue(
        !(ok.body.providers as any[]).some((r) => r.provider_id === "prov-hidden"),
        "f1: catalog_hidden=1 row excluded from batch listing",
      );

      const high = byId("prov-high");
      assertTrue(!!high, "b3: prov-high present");
      assertEq(high?.geocode_confidence, "high", "b4: prov-high geocode_confidence passthrough");
      assertEq(high?.map_presentation, "exact", "b5: prov-high map_presentation exact");
      assertEq(high?.would_render_point_marker, true, "b6: prov-high would_render_point_marker true");
      assertEq(high?.lat, 60.6, "b7: prov-high lat passthrough");
      assertEq(high?.lon, 6.4, "b8: prov-high lon passthrough");
      assertEq(high?.sted, "Voss", "b9: prov-high sted is kommune (kommune-first label)");
      assertEq(high?.kommune, "Voss", "b10: prov-high kommune passthrough");
      assertEq(high?.navn, "Høy Presisjon Gård", "b11: prov-high navn passthrough");

      const medium = byId("prov-medium");
      assertEq(medium?.map_presentation, "exact", "b12: prov-medium map_presentation exact");
      assertEq(medium?.would_render_point_marker, true, "b13: prov-medium would_render_point_marker true");

      const low = byId("prov-low");
      assertEq(low?.map_presentation, "exact", "b14: prov-low map_presentation exact");
      assertEq(low?.would_render_point_marker, true, "b15: prov-low would_render_point_marker true");

      const sted = byId("prov-sted");
      assertTrue(!!sted, "b16: prov-sted present");
      assertEq(sted?.map_presentation, "approx-point", "b17: prov-sted map_presentation approx-point");
      assertEq(sted?.would_render_point_marker, true, "b18: prov-sted would_render_point_marker true (a real, if approximate, point)");
      assertEq(sted?.sted, "Tysvær", "b19: prov-sted sted is kommune, NOT the poststed 'Aksdal' (AC4b: kommune-first label)");
      assertEq(sted?.poststed, "Aksdal", "b20: prov-sted poststed raw passthrough (differs from sted label — inspectable for AC4b)");

      // ── (c) the real AC4(a) regression: kommune-centroid/no-match/null
      // must ALL be would_render_point_marker: false.
      const approx = byId("prov-approx");
      assertTrue(!!approx, "c1: prov-approx present");
      assertEq(approx?.map_presentation, "no-point", "c2: prov-approx (kommune-centroid) map_presentation no-point");
      assertEq(approx?.would_render_point_marker, false, "c3: prov-approx would_render_point_marker FALSE — a kommune-centroid row must never render a point-marker");

      const nomatch = byId("prov-nomatch");
      assertEq(nomatch?.map_presentation, "no-point", "c4: prov-nomatch map_presentation no-point");
      assertEq(nomatch?.would_render_point_marker, false, "c5: prov-nomatch would_render_point_marker false");

      const nullRow = byId("prov-null");
      assertTrue(!!nullRow, "c6: prov-null present");
      assertEq(nullRow?.geocode_confidence, null, "c7: prov-null geocode_confidence null passthrough");
      assertEq(nullRow?.map_presentation, "no-point", "c8: prov-null map_presentation no-point");
      assertEq(nullRow?.would_render_point_marker, false, "c9: prov-null would_render_point_marker false");
      assertEq(nullRow?.kommune, null, "d1: prov-null kommune null passthrough");
      assertEq(nullRow?.sted, "Odda", "d2: prov-null sted falls back to poststed when kommune is absent");

      // ── (e) pagination ───────────────────────────────────────────────────
      const page1 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "3" },
      });
      assertEq(page1.status, 200, "e1: page1 -> 200");
      assertEq(page1.body.providers.length, 3, "e2: page1 has exactly `limit` rows");
      assertEq(page1.body.limit, 3, "e3: page1 echoes limit");
      assertTrue(typeof page1.body.next_after === "string" && page1.body.next_after.length > 0, "e4: page1 next_after is a non-empty cursor");
      assertEq(page1.body.total, 7, "e5: page1 total is 7 (full in-scope count, independent of limit)");

      const page2 = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { limit: "50", after: page1.body.next_after },
      });
      assertEq(page2.status, 200, "e6: page2 -> 200");
      const page1Ids = new Set((page1.body.providers as any[]).map((r) => r.provider_id));
      const page2Ids = new Set((page2.body.providers as any[]).map((r) => r.provider_id));
      assertTrue(
        [...page1Ids].every((id) => !page2Ids.has(id)),
        "e7: page2 contains no id already returned on page1 (no overlap/no double-count)",
      );
      assertEq(page1.body.providers.length + page2.body.providers.length, 7, "e8: page1 + page2 together cover all 7 in-scope rows");

      // ── (g) single provider_id lookup ────────────────────────────────────
      const single = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { provider_id: "prov-high" },
      });
      assertEq(single.status, 200, "g1: provider_id lookup (known id) -> 200");
      assertEq(single.body.provider?.provider_id, "prov-high", "g2: provider_id lookup returns the requested row");
      assertEq(single.body.provider?.would_render_point_marker, true, "g3: provider_id lookup computes the same predicate as the batch listing");

      const unknown = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { provider_id: "does-not-exist" },
      });
      assertEq(unknown.status, 404, "g4: unknown provider_id -> 404");

      const hiddenLookup = await callRoute(opplevelserRouter, {
        headers: { "x-admin-key": testKey },
        query: { provider_id: "prov-hidden" },
      });
      assertEq(hiddenLookup.status, 404, "f2: catalog_hidden=1 row -> 404 on direct provider_id lookup too (no reachable public profile)");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-geo-marker-diagnostic: unexpected error: " + String(err?.stack || err?.message || err));
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-geo-marker-diagnostic.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgGeoMarkerDiagnosticTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
