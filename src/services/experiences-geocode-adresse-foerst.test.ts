/**
 * experiences-geocode-adresse-foerst.test.ts — the address-first geocode fix
 * and the impossible-coordinate repair sweep.
 *
 * Daniel, 2026-08-25, on two producers sitting at lat 0 / lon 0:
 * «har lagt med begge adressene på bildet. burde vært lett å funnet selv, i
 * stedet for å sette 0.0» — and he was right. Both rows carried a real street
 * address in our own `adresse` column ("Utgårdsveien 4, 1684 Vesterøy",
 * "Sørsidevegen 3642"), and Kartverket resolves both on the FIRST query with
 * one hit each. Three separate defects stacked up:
 *
 *   1. Step A's SQL gate demanded a SEPARATE `postnummer` column. These rows
 *      keep the postcode inside `adresse` (or have none at all), so a
 *      perfectly geocodable address was skipped entirely.
 *   2. Step D then claimed the row and wrote a kommune centroid that came back
 *      0/0 — a coordinate no check refused at the time.
 *   3. The row was then STUCK: every step keys on `lat IS NULL`, so a poisoned
 *      coordinate is never retried. It would have stayed 0/0 forever.
 *
 * Covers:
 *   (a) The repro: an address with an embedded postcode and an EMPTY
 *       postnummer is geocoded at address precision — not demoted to the
 *       kommune centroid.
 *   (b) An address with no postcode anywhere still reaches the geocoder, with
 *       poststed (or kommune) carrying the place name.
 *   (c) Step 0 self-heal: a row already poisoned with 0/0 is cleared and then
 *       resolved properly IN THE SAME TICK — no admin call, no manual SQL.
 *   (d) The same sweep clears an `experiences` row poisoned the same way.
 *   (e) A geocoder answer that cannot be Norwegian is REFUSED at the write
 *       (counted, logged, stored as no_match) instead of entering the DB.
 *   (f) Step D is still the last resort it was meant to be: a row with no
 *       address at all still gets its kommune centroid, unchanged.
 *   (g) The serving side: a row whose coordinate is impossible publishes NO
 *       schema.org `geo` node — the leak that reached Google while the map
 *       gate (shipped a day earlier) only covered rendering.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/services/experiences-geocode-adresse-foerst.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesGeocodeAdresseFoerstTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// A Kartverket stub: maps a query substring → the coordinate to answer with.
// `null` means "no hit" (the real API's empty `adresser` array).
function makeFetchStub(routes: Array<{ match: RegExp; point: { lat: number; lon: number } | null }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const decoded = decodeURIComponent(String(url));
    const hit = routes.find((r) => r.match.test(decoded));
    const adresser = hit && hit.point ? [{ representasjonspunkt: hit.point }] : [];
    return { ok: true, status: 200, json: async () => ({ adresser }) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function runExperiencesGeocodeAdresseFoerstTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    assertTrue(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }

  return (async () => {
    const prevPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const storePath = require.resolve("./experience-store");
    const workerPath = require.resolve("./experiences-geocode-worker");
    const seoPath = require.resolve("../routes/experiences-seo");
    const cachePaths = [dbFactoryPath, storePath, workerPath, seoPath];

    try {
      for (const p of cachePaths) delete require.cache[p];
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db: any = dbFactory.getDb("experiences");
      const store = require("./experience-store") as typeof import("./experience-store");
      const worker = require("./experiences-geocode-worker") as typeof import("./experiences-geocode-worker");

      // ── fixtures ────────────────────────────────────────────────────
      // (a) Daniel's exact row: postcode embedded in `adresse`, postnummer EMPTY.
      const embedded = store.createProvider({
        navn: "Bryggeriet på Hvaler", org_nr: "811111111",
        fylke: "Viken", kommune: "Hvaler", poststed: "Vesterøy",
        adresse: "Utgårdsveien 4, 1684 Vesterøy",
      } as any);
      db.prepare("UPDATE experience_providers SET producer_type = ?, postnummer = '' WHERE id = ?").run("bryggeri", embedded);

      // (b) Street line with NO postcode at all — place name only.
      const noPostcode = store.createProvider({
        navn: "Sognefjord Bryggeri", org_nr: "822222222",
        fylke: "Vestland", kommune: "Høyanger", poststed: "Bjordal",
        adresse: "Sørsidevegen 3642",
      } as any);
      db.prepare("UPDATE experience_providers SET producer_type = ?, postnummer = NULL WHERE id = ?").run("bryggeri", noPostcode);

      // (c) Already poisoned with 0/0 from the old code path, and holding a
      //     usable address the whole time — the stuck state this fixes.
      const poisoned = store.createProvider({
        navn: "Fastlåst Sideri", org_nr: "833333333",
        fylke: "Vestland", kommune: "Voss", poststed: "Voss",
        adresse: "Uttrågata 9",
      } as any);
      db.prepare(
        `UPDATE experience_providers
            SET producer_type = 'sideri', postnummer = '5700',
                lat = 0, lon = 0, geocode_source = 'kommune_fallback', geocode_confidence = 'approximate'
          WHERE id = ?`
      ).run(poisoned);

      // (d) An `experiences` row poisoned the same way.
      db.prepare(
        `INSERT INTO experiences (id, slug, title, category, kommune, fylke, loc_lat, loc_lon, geo_precision, verification_status)
         VALUES ('gx-1', 'gx-null-island', 'Tur med feil koordinat', 'natur_friluft', 'Voss', 'Vestland', 0, 0, 'kommune', 'verified')`
      ).run();

      // (e) An address whose geocoder answer comes back 0/0.
      const badAnswer = store.createProvider({
        navn: "Nulløya Destilleri", org_nr: "844444444",
        fylke: "Rogaland", kommune: "Stavanger", poststed: "Stavanger",
        adresse: "Tullegata 1",
      } as any);
      db.prepare("UPDATE experience_providers SET producer_type = 'destilleri', postnummer = '4000' WHERE id = ?").run(badAnswer);

      // (f) No address at all — Step D's legitimate territory.
      const noAddress = store.createProvider({
        navn: "Kommunesenter Mjøderi", org_nr: "855555555",
        fylke: "Innlandet", kommune: "Lillehammer",
      } as any);
      db.prepare("UPDATE experience_providers SET producer_type = 'mjøderi' WHERE id = ?").run(noAddress);

      const stub = makeFetchStub([
        { match: /Utgårdsveien 4/, point: { lat: 59.098673, lon: 10.873839 } },
        { match: /Sørsidevegen 3642/, point: { lat: 61.097561, lon: 5.879827 } },
        { match: /Uttrågata 9/, point: { lat: 60.629, lon: 6.4166 } },
        { match: /Tullegata 1/, point: { lat: 0, lon: 0 } },           // (e) the poison source
        { match: /Lillehammer/, point: { lat: 61.115, lon: 10.466 } },  // kommune centroid for (f)
      ]);

      const stats: any = await worker.experiencesGeocodeTick(50, {
        fetchImpl: stub.impl,
        sleep: async () => {},
      });

      const row = (id: string) =>
        db.prepare("SELECT lat, lon, geocode_source, geocode_confidence FROM experience_providers WHERE id = ?").get(id) as any;

      // ── (a) the repro ───────────────────────────────────────────────
      const rEmbedded = row(embedded);
      assertTrue(
        rEmbedded.lat !== null && Math.abs(rEmbedded.lat - 59.098673) < 1e-4 && Math.abs(rEmbedded.lon - 10.873839) < 1e-4,
        "a1: an address with the postcode embedded and postnummer EMPTY is geocoded to its real position",
      );
      assertEq(rEmbedded.geocode_source, "kartverket", "a2: …by the address geocoder, not the kommune fallback");
      assertEq(rEmbedded.geocode_confidence, "high", "a3: …at address precision, not 'approximate'");

      // ── (b) no postcode anywhere ────────────────────────────────────
      const rNoPostcode = row(noPostcode);
      assertTrue(
        rNoPostcode.lat !== null && Math.abs(rNoPostcode.lat - 61.097561) < 1e-4,
        "b1: a street line with no postcode at all still reaches the geocoder and resolves",
      );
      assertEq(rNoPostcode.geocode_source, "kartverket", "b2: …also at address precision");
      assertTrue(
        stub.calls.some((u) => decodeURIComponent(u).includes("Bjordal")),
        "b3: the place name is carried into the query (it is what disambiguates the street)",
      );

      // ── (c) the stuck row heals itself ──────────────────────────────
      const rPoisoned = row(poisoned);
      assertTrue(rPoisoned.lat !== 0 && rPoisoned.lon !== 0, "c1: the 0/0 row no longer holds 0/0");
      assertTrue(
        rPoisoned.lat !== null && Math.abs(rPoisoned.lat - 60.629) < 1e-3,
        "c2: …it was re-geocoded from the address it had all along, in the SAME tick",
      );
      assertEq(rPoisoned.geocode_confidence, "high", "c3: …and ends at address precision");
      assertEq(stats.providers_coords_reset, 1, "c4: the repair sweep counted exactly the one poisoned provider");

      // ── (d) experiences rows too ────────────────────────────────────
      const gx = db.prepare("SELECT loc_lat, loc_lon, geo_precision FROM experiences WHERE id = 'gx-1'").get() as any;
      assertTrue(gx.loc_lat !== 0, "d1: an experiences row poisoned with 0/0 is cleared as well");
      assertEq(stats.experiences_coords_reset, 1, "d2: …and counted");

      // ── (e) an impossible answer is refused at the write ────────────
      const rBad = row(badAnswer);
      assertTrue(rBad.lat !== 0 || rBad.lon !== 0, "e1: a 0/0 geocoder answer is never stored as a position");
      assertTrue(stats.providers_implausible_rejected >= 1, "e2: …the refusal is counted, not silent");
      // Refused at address precision, the row keeps walking the ladder: Step D
      // gives it the honest kommune centroid, tagged 'approximate'. That is
      // the designed degradation — what must never happen is the impossible
      // point being stored, or an approximate position being labelled exact.
      assertEq(rBad.geocode_source, "kommune_fallback", "e3: …and it degrades to the kommune fallback");
      assertEq(rBad.geocode_confidence, "approximate", "e4: …honestly tagged 'approximate', never address precision");
      assertTrue(
        rBad.lat > 57 && rBad.lat < 81.5 && rBad.lon > -10 && rBad.lon < 36,
        "e5: …at a position that is at least inside Norway",
      );

      // ── (f) Step D unchanged for rows with nothing to geocode ───────
      const rNoAddress = row(noAddress);
      assertTrue(rNoAddress.lat !== null, "f1: a provider with no address at all still gets its kommune centroid");
      assertEq(rNoAddress.geocode_source, "kommune_fallback", "f2: …from Step D, which is now the last resort");
      assertEq(rNoAddress.geocode_confidence, "approximate", "f3: …still honestly tagged 'approximate'");

      // ── (g) nothing impossible is ever published as structured data ─
      {
        const seo = require("../routes/experiences-seo") as any;
        const router = seo.default;
        db.prepare(
          `INSERT INTO experiences (id, slug, title, category, kommune, fylke, loc_lat, loc_lon, geo_precision, verification_status)
           VALUES ('gx-2', 'gx-still-broken', 'Opplevelse med umulig punkt', 'natur_friluft', 'Voss', 'Vestland', 0, 0, 'kommune', 'verified')`
        ).run();
        const body = await new Promise<string>((resolve) => {
          const req: any = { method: "GET", url: "/opplevelse/gx-still-broken", originalUrl: "/opplevelse/gx-still-broken", path: "/opplevelse/gx-still-broken", query: {}, headers: {}, lang: "no", get() { return undefined; } };
          const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, setHeader() {}, send(b: unknown) { resolve(String(b)); } };
          router.handle(req, res, () => resolve(""));
        });
        assertTrue(body.length > 0, "g1: the detail page for a row with an impossible coordinate still renders");
        assertTrue(!/"latitude":\s*0\s*,\s*"longitude":\s*0/.test(body), "g2: it publishes NO 0/0 GeoCoordinates to search engines");
        assertTrue(!/GeoCoordinates/.test(body), "g3: the geo node is omitted entirely — saying nothing beats saying something false");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-geocode-adresse-foerst: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevPath;
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
  runExperiencesGeocodeAdresseFoerstTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
