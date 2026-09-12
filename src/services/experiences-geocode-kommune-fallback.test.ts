/**
 * experiences-geocode-kommune-fallback.test.ts — dev-request
 * 2026-09-12-opplevagent-gateadresse-uten-postnummer.
 *
 * Measured 2026-09-12: parseAddressLike() rejects any address that is
 * street-shaped ("<name> <number>") but has NO 4-digit postnummer anywhere in
 * the string, unless a care-of ("c/o"/"v/") prefix was present. Rows like
 * "Brennerivegen 10" (kommune Løten), "Havsjøveien 309" (kommune Røros),
 * "Meieribakken 4" (kommune Inderøy) were misclassified as place names and
 * routed to the Stedsnavn tier, which never matches a street address.
 * 22-23 of 43 sampled backlog rows in this shape ARE resolvable via
 * Kartverket's address search when the row's OWN `kommune` column is passed
 * as `kommunenavn` disambiguation instead of a postnummer.
 *
 * parseStreetShapeWithoutPostnummer() + queryKartverketByStreetAndKommune()
 * (both in experiences-geocode-worker.ts) are the fix, wired into BOTH places
 * parseAddressLike() gates the address tier: Step D's provider
 * kommune/fylke-centroid fallback (experiencesGeocodeTick()) and the
 * backlog re-geocode pass's Fix-3 flow (runExperiencesGeocodeBacklogPass()).
 *
 * Sections:
 *   A — backlog: missing postnummer, single unambiguous kommunenavn-scoped
 *       hit -> upgraded_address, geocode_confidence='high'.
 *   B — tick (Step D): the "Harstad pattern" — Step A's OWN geocodeOne() call
 *       already had a genuinely STORED postnummer and still came back
 *       no_match; Step D's kommune-disambiguated retry resolves it anyway.
 *       Coordinate written, stored postnummer left untouched,
 *       providers_postal_mismatch counted (NOT providers_kommune_fallback_upgraded).
 *   C — backlog: kommunenavn isn't a real Kartverket kommunenavn (zero hits
 *       scoped) -> one free-text retry -> upgraded_address.
 *   D — parseStreetShapeWithoutPostnummer() rejections: prose is not
 *       street-shaped, and NON_STREET_HEAD ("Postboks 12") is not a street —
 *       neither ever reaches a Kartverket call for this path.
 *   E — backlog: ambiguous kommunenavn-scoped hits (different adressekode,
 *       >50m apart) -> no write, skipped_ambiguous.
 *   F — tick (Step D): the plain missing-postnummer case (no prior stored
 *       postnummer at all) -> providers_kommune_fallback_upgraded, proving
 *       Step D's own wiring independently of the backlog's.
 *
 * Same two independent HTTP seams as experiences-geocode-backlog.test.ts:
 * `deps.fetchImpl` (dental-geocode-worker's kartverketQuery AND this file's
 * new queryKartverketByStreetAndKommune/free-text helper — both are plain
 * fetch calls against /adresser/v1/sok, distinguished below by URL shape) and
 * geocodingService's own __setGeocodingFetchForTesting (/stedsnavn/v1 +
 * /kommuneinfo/v1, stubbed to always miss — none of these rows are place
 * names, so the Stedsnavn tier must never actually resolve any of them).
 *
 * Exported runExperiencesGeocodeKommuneFallbackTests({log}) -> TestSummary;
 * wired into tests/test.ts. Standalone:
 *   npx tsx src/services/experiences-geocode-kommune-fallback.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Never matches anything — used for the parts of the /adresser/v1/sok surface a given section doesn't care about. */
const EMPTY_ADRESSER = { adresser: [] };

export function runExperiencesGeocodeKommuneFallbackTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const workerPath = require.resolve("./experiences-geocode-worker");
    for (const p of [dbFactoryPath, expStorePath, workerPath]) delete require.cache[p];

    const geo = require("./geocoding-service") as typeof import("./geocoding-service");
    // None of this file's rows are place names — the Stedsnavn/Kommuneinfo
    // seam must never resolve any of them. Always-miss stub, same shape as
    // the sibling test files' own "never returns a hit" fixtures.
    geo.__setGeocodingFetchForTesting((async () => ({
      ok: true, status: 200,
      json: async () => ({ metadata: { totaltAntallTreff: 0 }, navn: [] }),
    } as unknown as Response)) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const worker = require("./experiences-geocode-worker") as typeof import("./experiences-geocode-worker");
      const db = dbFactory.getDb("experiences");

      function readProvider(id: string) {
        return db
          .prepare("SELECT lat, lon, geocode_confidence, geocode_source, postnummer, poststed FROM experience_providers WHERE id = ?")
          .get(id) as {
          lat: number | null; lon: number | null; geocode_confidence: string | null;
          geocode_source: string | null; postnummer: string | null; poststed: string | null;
        };
      }

      // ═══ A — backlog: missing postnummer, single unambiguous kommunenavn hit ═══
      {
        const id = expStore.createProvider({
          navn: "Brenneri Gårdsutsalg", fylke: "Innlandet", kommune: "Løten",
          kommunenummer: "3403", adresse: "Brennerivegen 10",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        // Backlog only re-attempts rows already at geocode_confidence='approximate'.
        db.prepare(
          `UPDATE experience_providers SET lat = 60.85, lon = 11.35, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        const HIT = { lat: 60.8422, lon: 11.3517 };
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=L.?ten/i.test(url) && /sok=Brennerivegen 10/i.test(url)) {
            return jsonResponse({
              adresser: [{
                representasjonspunkt: HIT, adressekode: 12345,
                postnummer: "2340", poststed: "Løten",
              }],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6 && Math.abs((row.lon ?? 0) - HIT.lon) < 1e-6,
          `A1: row upgraded to the kommunenavn-scoped hit, not the kommune centroid (got ${row?.lat}, ${row?.lon})`);
        assertEq(row?.geocode_confidence, "high", "A2: geocode_confidence='high'");
        assertEq(row?.geocode_source, "kartverket_backlog_kommune", "A3: geocode_source tags this as the kommune-fallback backlog path");
        assertEq(row?.postnummer, "2340", "A4: empty postnummer filled from the Kartverket hit");
        assertEq(row?.poststed, "Løten", "A5: empty poststed filled from the Kartverket hit");
        assertEq(result.upgraded_address, 1, "A6: result.upgraded_address counts it (same address-tier counter as Fix 3)");
        const rowReport = result.rows.find((r) => r.provider_id === id);
        assertEq(rowReport?.action, "upgraded_address", "A7: per-row report action='upgraded_address'");
      }

      // ═══ B — tick (Step D): "Harstad pattern" postnummer mismatch ═══
      {
        const id = expStore.createProvider({
          navn: "Andreas Linds Gårdsutsalg", fylke: "Troms og Finnmark", kommune: "Harstad",
          kommunenummer: "5054", adresse: "Andreas Linds gate 9", postnummer: "9405",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);

        const HIT = { lat: 68.7985, lon: 16.5416 };
        const calls: string[] = [];
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          calls.push(url);
          // Step D's kommune-disambiguated call: treffPerSide=5 + kommunenavn param.
          if (/kommunenavn=Harstad/i.test(url) && /treffPerSide=5/.test(url)) {
            return jsonResponse({
              adresser: [{
                representasjonspunkt: HIT, adressekode: 987,
                postnummer: "9406", poststed: "Harstad",
              }],
            });
          }
          // Step A's own geocodeOne() ladder (treffPerSide=1) — the stored
          // postnummer "9405" never resolves, by design (this IS the mismatch).
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.experiencesGeocodeTick(50, { fetchImpl, sleep: async () => {} });
        const row = readProvider(id);

        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6 && Math.abs((row.lon ?? 0) - HIT.lon) < 1e-6,
          `B1: row upgraded to the kommune-disambiguated hit (got ${row?.lat}, ${row?.lon})`);
        assertEq(row?.geocode_confidence, "high", "B2: geocode_confidence='high'");
        assertEq(row?.geocode_source, "kartverket_kommune_fallback", "B3: geocode_source tags this as Step D's kommune-fallback path");
        assertEq(row?.postnummer, "9405", "B4: the row's already-stored postnummer is NOT overwritten, even though the hit disagrees (9406)");
        assertEq(row?.poststed, "Harstad", "B5: poststed WAS empty, so it IS filled in from the hit");
        assertEq(result.providers_postal_mismatch, 1, "B6: result.providers_postal_mismatch counts it");
        assertEq(result.providers_kommune_fallback_upgraded, 0, "B7: NOT double-counted under the plain missing-postnummer counter");
        assertTrue(calls.some((u) => /treffPerSide=1/.test(u)), "B8: Step A's own postnummer-based attempt actually ran first");
      }

      // ═══ C — backlog: kommune isn't a real kommunenavn, free-text fallback ═══
      {
        const id = expStore.createProvider({
          navn: "Sekse Gårdsutsalg", fylke: "Vestland", kommune: "Sekse",
          adresse: "Seksevegen 62",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.4, lon = 6.5, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        const HIT = { lat: 60.395, lon: 6.512 };
        const calls: string[] = [];
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          calls.push(url);
          if (/kommunenavn=Sekse/i.test(url)) return jsonResponse(EMPTY_ADRESSER); // not a real kommunenavn -> zero hits
          if (/sok=Seksevegen 62, Sekse/i.test(url)) {
            return jsonResponse({ adresser: [{ representasjonspunkt: HIT, adressekode: 55, postnummer: "5780", poststed: "Sekse" }] });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6, `C1: row upgraded via the free-text fallback (got ${row?.lat})`);
        assertEq(result.upgraded_address, 1, "C2: result.upgraded_address counts it");
        assertTrue(calls.some((u) => /kommunenavn=Sekse/i.test(u)), "C3: the kommunenavn-scoped call was attempted first");
        assertTrue(calls.some((u) => /sok=Seksevegen 62, Sekse/i.test(u) && !/kommunenavn=/.test(u)),
          "C4: exactly one free-text retry (no kommunenavn param) was made after the scoped call returned zero hits");
        assertEq(calls.length, 2, `C5: at most 2 Kartverket calls total for this path (got ${calls.length})`);
      }

      // ═══ D — parseStreetShapeWithoutPostnummer() rejections: no Kartverket call attempted ═══
      {
        const { parseStreetShapeWithoutPostnummer, parseAddressLike } = worker;

        assertEq(parseStreetShapeWithoutPostnummer("Gården vår i Vestre Slidre"), null,
          "D1: prose (not street-shaped) is rejected, same as parseAddressLike()");
        assertEq(parseAddressLike("Gården vår i Vestre Slidre"), null, "D1b: …parseAddressLike() agrees");

        assertEq(parseStreetShapeWithoutPostnummer("Postboks 12"), null,
          "D2: NON_STREET_HEAD ('Postboks 12') is rejected, same as parseAddressLike()");
        assertEq(parseAddressLike("Postboks 12"), null, "D2b: …parseAddressLike() agrees");

        // Full integration check: a NON_STREET_HEAD address, even with a real
        // kommune, must never even reach the new Kartverket helper — verified
        // by a fetch stub that fails the test if it is ever called.
        const id = expStore.createProvider({
          navn: "Postboks Gårdsutsalg", fylke: "Innlandet", kommune: "Løten",
          adresse: "Postboks 12",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.85, lon = 11.35, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);
        let fetchCalled = false;
        const fetchImpl = (async () => { fetchCalled = true; return jsonResponse(EMPTY_ADRESSER); }) as unknown as typeof fetch;
        await worker.runExperiencesGeocodeBacklogPass(50, { dryRun: false, deps: { fetchImpl, sleep: async () => {} } });
        assertTrue(!fetchCalled, "D3: no Kartverket call was attempted for a NON_STREET_HEAD address");
      }

      // ═══ E — backlog: ambiguous kommunenavn-scoped hits ═══
      {
        const id = expStore.createProvider({
          navn: "Vollgata Gårdsutsalg", fylke: "Innlandet", kommune: "Elverum",
          adresse: "Vollgata 8",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.88, lon = 11.56, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Elverum/i.test(url)) {
            return jsonResponse({
              adresser: [
                { representasjonspunkt: { lat: 60.8807, lon: 11.5623 }, adressekode: 111, postnummer: "2408", poststed: "Elverum" },
                // >50m away (roughly 0.01deg lat ~= 1.1km) AND a DIFFERENT adressekode.
                { representasjonspunkt: { lat: 60.8907, lon: 11.5623 }, adressekode: 222, postnummer: "2408", poststed: "Elverum" },
              ],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertEq(row?.geocode_confidence, "approximate", "E1: ambiguous row left COMPLETELY unchanged, no write");
        assertEq(row?.lat, 60.88, "E2: …coordinate untouched");
        assertTrue(result.skipped_ambiguous >= 1, "E3: result.skipped_ambiguous counts it");
        const rowReport = result.rows.find((r) => r.provider_id === id);
        assertEq(rowReport?.action, "skipped_ambiguous", "E4: per-row report action='skipped_ambiguous'");
      }

      // ═══ F — tick (Step D): plain missing-postnummer upgrade (no prior stored postnummer) ═══
      {
        const id = expStore.createProvider({
          navn: "Havsjøveien Gårdsutsalg", fylke: "Trøndelag", kommune: "Røros",
          kommunenummer: "5025", adresse: "Havsjøveien 309",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);

        const HIT = { lat: 62.5833, lon: 11.3833 };
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=R.?ros/i.test(url) && /treffPerSide=5/.test(url)) {
            return jsonResponse({ adresser: [{ representasjonspunkt: HIT, adressekode: 71, postnummer: "7374", poststed: "Røros" }] });
          }
          return jsonResponse(EMPTY_ADRESSER); // Step A's own ladder never hits
        }) as unknown as typeof fetch;

        const result = await worker.experiencesGeocodeTick(50, { fetchImpl, sleep: async () => {} });
        const row = readProvider(id);
        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6, `F1: row upgraded via Step D's kommune-disambiguated fallback (got ${row?.lat})`);
        assertEq(row?.geocode_confidence, "high", "F2: geocode_confidence='high'");
        assertEq(row?.geocode_source, "kartverket_kommune_fallback", "F3: geocode_source tags Step D's path");
        assertEq(row?.postnummer, "7374", "F4: postnummer filled in (was empty, no prior stored value)");
        assertEq(result.providers_kommune_fallback_upgraded, 1, "F5: result.providers_kommune_fallback_upgraded counts it");
        assertEq(result.providers_postal_mismatch, 0, "F6: NOT counted as a postal mismatch — there was no prior stored postnummer to conflict with");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-geocode-kommune-fallback: unexpected error: " + String(err?.message || err) + (err?.stack ? `\n${err.stack}` : ""));
    } finally {
      geo.__setGeocodingFetchForTesting();
      geo.__clearGeocodeCacheForTesting();
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* nothing to reset */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runExperiencesGeocodeKommuneFallbackTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
