/**
 * opplevelser-gardssalg-rest-discover.test.ts — dev-request
 * 2026-07-19-gardssalg-agent-flater: GET /api/opplevelser/discover?category=
 * gardssalg_smaking always got zero direct hits, because gårdssalg (farm-sale
 * drink producer) rows live in `experience_providers`, NOT `experiences` —
 * the only table discoverExperiencesRelaxed() ever queries. Its zero-hit
 * fallback then silently relaxed (dropped) `category` one filter at a time
 * until it found UNRELATED experiences to return, attaching a "løsnet:
 * kategori" note. An agent asking for gårdssalg never got routed to the real
 * gårdssalg producers.
 *
 * This covers the fix: /discover now intercepts category=gardssalg_smaking
 * BEFORE discoverExperiencesRelaxed() runs and routes to the same
 * searchGardssalgProviders() store function the discover_gardssalg MCP tool
 * uses (src/routes/experiences-mcp.ts), returning a { vertical: "gardssalg",
 * ... } envelope with NO relaxed_filters/note field — no more silent
 * relaxation for this category.
 *
 * Covers:
 *   1. category=gardssalg_smaking (no other filters) -> vertical:"gardssalg",
 *      shaped results, no relaxed_filters/note field at all.
 *   2. category=gardssalg_smaking&fylke=<real fylke> -> only matching rows
 *      (the hidden and other-fylke rows are excluded).
 *   3. a booking_live=1 row, with dispatch enabled -> booking.live:true,
 *      booking.mode:"request".
 *   4. a row with booking_live not set -> booking.live:false,
 *      booking.mode:"paused" (regardless of the dispatch flag).
 *   5. a catalog_hidden=1 row never appears in the response, under any filter
 *      combination that would otherwise match it.
 *   6. every other existing /discover behavior (non-gardssalg category, no
 *      category at all) is unaffected — run alongside
 *      opplevelser-discover-relax.test.ts / opplevelser-discover-geo.test.ts
 *      in the same `npm test` gate, which re-runs those unmodified.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/opplevelser-gardssalg-rest-discover.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runOpplevelserGardssalgRestDiscoverTests() and folds its pass/fail
 *      counts into the `npm test` summary (see opplevelser-discover-relax.
 *      test.ts for the precedent this follows).
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Same synthetic router.handle() shortcut as opplevelser-discover-relax.test.ts /
// opplevelser-discover-geo.test.ts — /discover is a plain REST GET, so no MCP
// session handshake is needed here.
function callRoute(router: any, url: string): Promise<{ handled: boolean; status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ handled: true, status: statusCode, body });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : null });
    });
  });
}

export function runOpplevelserGardssalgRestDiscoverTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const prevBookingDispatchEnabled = process.env.BOOKING_DISPATCH_ENABLED;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.BOOKING_DISPATCH_ENABLED;

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const opplevelserPath = require.resolve("./opplevelser");
    const cachePaths = [dbFactoryPath, expStorePath, opplevelserPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");

      // ── Fixtures — same raw-insert pattern as
      // opplevelser-gardssalg-mcp-discoverability.test.ts (createProvider()
      // doesn't support booking_live/catalog_hidden/slug). ──────────────────
      const insertProvider = db.prepare(
        `INSERT INTO experience_providers
           (id, navn, vertical, fylke, kommune, producer_type, booking_live, catalog_hidden, lat, lon,
            geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
         VALUES
           (@id, @navn, 'experiences', @fylke, @kommune, @producer_type, @booking_live, @catalog_hidden, @lat, @lon,
            @geocode_confidence, @slug, 'raw', 'pending_verify', 'test-fixture', 'medium')`
      );
      // gs-live: real, Vestland, onboarded for booking (booking_live=1).
      insertProvider.run({
        id: "gs-live", navn: "Fjordgard Bryggeri", fylke: "Vestland", kommune: "Bergen",
        producer_type: "bryggeri", booking_live: 1, catalog_hidden: null,
        lat: 60.39, lon: 5.32, geocode_confidence: "high", slug: "fjordgard-bryggeri",
      });
      // gs-paused: real, Trøndelag, never onboarded for booking (booking_live NULL).
      insertProvider.run({
        id: "gs-paused", navn: "Stille Sideri", fylke: "Trøndelag", kommune: "Trondheim",
        producer_type: "cideri", booking_live: null, catalog_hidden: null,
        lat: 63.43, lon: 10.39, geocode_confidence: "high", slug: "stille-sideri",
      });
      // gs-hidden: catalog_hidden=1 test provider — matches every filter below
      // (same fylke/kommune/producer_type/booking_live as gs-live) yet must
      // NEVER appear in the REST /discover response.
      insertProvider.run({
        id: "gs-hidden", navn: "Skjult Gardsmat", fylke: "Vestland", kommune: "Bergen",
        producer_type: "bryggeri", booking_live: 1, catalog_hidden: 1,
        lat: 60.40, lon: 5.33, geocode_confidence: "high", slug: "skjult-gardsmat",
      });

      const opplevelserRouter = (require("./opplevelser") as typeof import("./opplevelser")).default as any;

      // ── 1. category=gardssalg_smaking, no other filters ───────────────────
      const res1 = await callRoute(opplevelserRouter, "/discover?category=gardssalg_smaking");
      assertTrue(res1.handled, "1a: GET /discover?category=gardssalg_smaking is handled");
      assertEq(res1.body.vertical, "gardssalg", "1b: vertical is 'gardssalg'");
      assertEq(res1.body.count, 2, "1c: count is 2 (gs-live + gs-paused; gs-hidden excluded)");
      assertTrue(!("relaxed_filters" in res1.body), "1d: no relaxed_filters field at all");
      assertTrue(!("note" in res1.body), "1e: no note field at all");
      const names1 = (res1.body.results as any[]).map((r) => r.navn);
      assertTrue(names1.includes("Fjordgard Bryggeri"), "1f: gs-live present");
      assertTrue(names1.includes("Stille Sideri"), "1g: gs-paused present");
      assertTrue(!names1.includes("Skjult Gardsmat"), "1h: gs-hidden absent");
      const liveRow1 = (res1.body.results as any[]).find((r) => r.navn === "Fjordgard Bryggeri");
      assertEq(liveRow1?.fylke, "Vestland", "1i: fylke echoed on result row");
      assertEq(liveRow1?.kommune, "Bergen", "1j: kommune echoed on result row");
      assertEq(liveRow1?.producer_type, "bryggeri", "1k: producer_type echoed on result row");
      assertEq(liveRow1?.lat, 60.39, "1l: lat echoed on result row");
      assertEq(liveRow1?.lon, 5.32, "1m: lon echoed on result row");
      assertEq(liveRow1?.geocode_confidence, "high", "1n: geocode_confidence echoed on result row");
      assertEq(liveRow1?.profile_url, "https://opplevagent.no/kategori/gardssalg/produsent/fjordgard-bryggeri", "1o: profile_url built from slug");
      assertTrue(!("distance_km" in liveRow1), "1p: no distance_km when no lat/lng origin was given");
      assertTrue(typeof liveRow1?.booking === "object" && liveRow1.booking !== null, "1q: booking object present");

      // ── 2. category=gardssalg_smaking&fylke=Vestland -> only Vestland rows ──
      const res2 = await callRoute(opplevelserRouter, "/discover?category=gardssalg_smaking&fylke=Vestland");
      assertEq(res2.body.vertical, "gardssalg", "2a: vertical is 'gardssalg'");
      assertEq(res2.body.count, 1, "2b: exactly 1 match (gs-live only)");
      const names2 = (res2.body.results as any[]).map((r) => r.navn);
      assertTrue(names2.includes("Fjordgard Bryggeri"), "2c: gs-live present");
      assertTrue(!names2.includes("Stille Sideri"), "2d: gs-paused (Trøndelag) excluded by fylke filter");
      assertTrue(!names2.includes("Skjult Gardsmat"), "2e: gs-hidden still excluded even matching fylke");
      assertEq(res2.body.query?.fylke, "Vestland", "2f: query object echoes the applied fylke filter");

      // ── 5 (part 2). producer_type + booking_live=true query params never
      //     leak the hidden row even though it matches every filter. ─────────
      const res2b = await callRoute(
        opplevelserRouter,
        "/discover?category=gardssalg_smaking&fylke=Vestland&kommune=Bergen&producer_type=bryggeri&booking_live=true"
      );
      const names2b = (res2b.body.results as any[]).map((r) => r.navn);
      assertTrue(!names2b.includes("Skjult Gardsmat"), "5a: gs-hidden never returned, even matching every filter it has");
      assertTrue(names2b.includes("Fjordgard Bryggeri"), "5b: gs-live still returned (real, non-hidden, matching row)");
      assertEq(res2b.body.count, 1, "5c: exactly 1 producer returned (hidden one truly absent, not filtered by name)");

      // ── 3. booking_live=1 row + dispatch enabled -> booking.live:true ─────
      process.env.BOOKING_DISPATCH_ENABLED = "true";
      const res3 = await callRoute(opplevelserRouter, "/discover?category=gardssalg_smaking&fylke=Vestland");
      const liveRow3 = (res3.body.results as any[]).find((r) => r.navn === "Fjordgard Bryggeri");
      assertEq(liveRow3?.booking?.live, true, "3a: booking_live=1 + dispatch enabled -> booking.live:true");
      assertEq(liveRow3?.booking?.mode, "request", "3b: booking.mode is 'request' when live");
      assertTrue(
        typeof liveRow3?.booking?.note === "string" && /book direkte|book directly/i.test(liveRow3.booking.note),
        "3c: booking.note carries the 'book directly' message when live"
      );

      // ── 4. booking_live not set -> booking.live:false regardless of dispatch ──
      const res4 = await callRoute(opplevelserRouter, "/discover?category=gardssalg_smaking&fylke=Trøndelag");
      const pausedRow4 = (res4.body.results as any[]).find((r) => r.navn === "Stille Sideri");
      assertTrue(!!pausedRow4, "4a: gs-paused present in the Trøndelag result");
      assertEq(pausedRow4?.booking?.live, false, "4b: booking_live not set -> booking.live:false even with dispatch enabled");
      assertEq(pausedRow4?.booking?.mode, "paused", "4c: booking.mode is 'paused'");
      assertTrue(
        typeof pausedRow4?.booking?.note === "string" && /åpner snart|open soon/i.test(pausedRow4.booking.note),
        "4d: booking.note carries the honest dark-launch message when paused"
      );

      // Also verify the dispatch-disabled case pauses even the onboarded row
      // (mirrors discover_gardssalg's own double-gate coverage).
      delete process.env.BOOKING_DISPATCH_ENABLED;
      const res4b = await callRoute(opplevelserRouter, "/discover?category=gardssalg_smaking&fylke=Vestland");
      const liveRow4b = (res4b.body.results as any[]).find((r) => r.navn === "Fjordgard Bryggeri");
      assertEq(liveRow4b?.booking?.live, false, "4e: BOOKING_DISPATCH_ENABLED unset -> booking.live:false even for a booking_live=1 provider");
      assertEq(liveRow4b?.booking?.mode, "paused", "4f: booking.mode is 'paused' when dispatch is globally off");

      // ── geo: distance_km present only when lat/lng given ──────────────────
      const res5geo = await callRoute(
        opplevelserRouter,
        "/discover?category=gardssalg_smaking&lat=60.39&lng=5.32&radius_km=50"
      );
      assertEq(res5geo.body.count, 1, "geo1: radius_km=50 around Bergen origin finds only gs-live");
      const geoRow = (res5geo.body.results as any[])[0];
      assertTrue(typeof geoRow?.distance_km === "number", "geo2: distance_km present as a number when lat/lng given");

      // ── 6. non-gardssalg category / no category at all still goes through
      //     the unchanged discoverExperiencesRelaxed() path (vertical:
      //     "experiences", not "gardssalg"). ────────────────────────────────
      const res6 = await callRoute(opplevelserRouter, "/discover?fylke=Vestland");
      assertEq(res6.body.vertical, "experiences", "6a: no category -> unchanged experiences vertical");
      assertTrue(!("gardssalg" in (res6.body ?? {})), "6b: sanity — no stray gardssalg key leaked onto the experiences branch");
    } catch (err: any) {
      failed++;
      failures.push("opplevelser-gardssalg-rest-discover: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      if (prevBookingDispatchEnabled === undefined) delete process.env.BOOKING_DISPATCH_ENABLED;
      else process.env.BOOKING_DISPATCH_ENABLED = prevBookingDispatchEnabled;
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

// Standalone runner: `npx tsx src/routes/opplevelser-gardssalg-rest-discover.test.ts`
if (require.main === module) {
  runOpplevelserGardssalgRestDiscoverTests({ log: true }).then((summary) => {
    console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
    process.exit(summary.failed > 0 ? 1 : 0);
  });
}
