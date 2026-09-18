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
 * Post-deploy live-verification fix-up round (2026-09-12, 3 bugs found
 * against production after PR #854 shipped):
 *   G — Bug 1: 4 hits sharing one `adressekode` but different `nummer` (10,
 *       100, 69A, 69B, per the live Kartverket response for "Brennerivegen
 *       10" scoped to kommune Løten) -> upgraded via the hit matching the
 *       REQUESTED number (10), not rejected as ambiguous.
 *   H — Bug 1: filtering down to the requested house number leaves ZERO hits
 *       (Kartverket has the street but not that exact number) -> no_match,
 *       reported as skipped_address_shaped (an honest miss), never
 *       skipped_ambiguous.
 *   I — Bug 2: parseStreetShapeWithoutPostnummer() rescues a street address
 *       whose house number collides with the postnummer scan ("Vinjevegen
 *       1075, Vinje") — unit-level, plus a live-style integration test
 *       through the backlog path proving the row actually gets upgraded.
 *   J — Bug 2 regression: parseAddressLike() on the SAME input, and on the
 *       existing "Gården vår i Vestre Slidre 2966" prose input, still
 *       returns exactly what it returned before this fix-up (null both
 *       times) — the guard-2/3 reordering must not change parseAddressLike()'s
 *       observable behavior at all.
 *   K — Bug 2 regression: parseStreetShapeWithoutPostnummer() still rejects
 *       the genuine prose case ("Gården vår i Vestre Slidre 2966") — its
 *       word-count guard fires independently of the postnummer/housenumber
 *       collision routing, so prose is never accidentally rescued.
 *   L — Bug 3: backlog pass, the "Harstad pattern" retry that Step D already
 *       had but the backlog's own address-tier branch was missing — a row
 *       with a street-shaped `adresse` carrying its OWN (wrong) embedded
 *       postnummer, geocodeOne() mocked to no_match on it, kommune-
 *       disambiguated retry mocked to one hit -> row upgraded, the row's
 *       stored postnummer is NOT overwritten, a NEW postal-mismatch counter
 *       increments, and skipped_address_shaped does NOT also fire for it.
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
                representasjonspunkt: HIT, adressekode: 12345, nummer: 10, bokstav: "",
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
                representasjonspunkt: HIT, adressekode: 987, nummer: 9, bokstav: "",
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
            return jsonResponse({ adresser: [{ representasjonspunkt: HIT, adressekode: 55, nummer: 62, bokstav: "", postnummer: "5780", poststed: "Sekse" }] });
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
                // Bug-1 regression: BOTH hits are for the SAME requested house
                // number (8) — the ambiguity is genuine (different
                // adressekode, >50m apart), not an artifact of Kartverket
                // returning other house numbers on the same street.
                { representasjonspunkt: { lat: 60.8807, lon: 11.5623 }, adressekode: 111, nummer: 8, bokstav: "", postnummer: "2408", poststed: "Elverum" },
                // >50m away (roughly 0.01deg lat ~= 1.1km) AND a DIFFERENT adressekode.
                { representasjonspunkt: { lat: 60.8907, lon: 11.5623 }, adressekode: 222, nummer: 8, bokstav: "", postnummer: "2408", poststed: "Elverum" },
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
            return jsonResponse({ adresser: [{ representasjonspunkt: HIT, adressekode: 71, nummer: 309, bokstav: "", postnummer: "7374", poststed: "Røros" }] });
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

      // ═══ G — Bug 1: same adressekode, DIFFERENT house numbers -> filter to the requested one ═══
      {
        const id = expStore.createProvider({
          navn: "Brenneri Gårdsutsalg 2", fylke: "Innlandet", kommune: "Løten",
          kommunenummer: "3403", adresse: "Brennerivegen 10",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.85, lon = 11.35, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        // Live Kartverket shape (measured 2026-09-12): 4 hits, ONE adressekode,
        // house numbers 10 / 100 / 69A / 69B — pre-fix code treated this whole
        // set as ambiguous; the fix must pick out house number 10 specifically.
        const HIT10 = { lat: 60.8267, lon: 11.3055 };
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=L.?ten/i.test(url) && /sok=Brennerivegen 10/i.test(url)) {
            return jsonResponse({
              adresser: [
                { representasjonspunkt: HIT10, adressekode: 5024, nummer: 10, bokstav: "", postnummer: "2340", poststed: "Løten" },
                { representasjonspunkt: { lat: 60.83, lon: 11.31 }, adressekode: 5024, nummer: 100, bokstav: "", postnummer: "2340", poststed: "Løten" },
                { representasjonspunkt: { lat: 60.84, lon: 11.32 }, adressekode: 5024, nummer: 69, bokstav: "A", postnummer: "2340", poststed: "Løten" },
                { representasjonspunkt: { lat: 60.845, lon: 11.325 }, adressekode: 5024, nummer: 69, bokstav: "B", postnummer: "2340", poststed: "Løten" },
              ],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertTrue(
          row?.lat != null && Math.abs(row.lat - HIT10.lat) < 1e-6 && Math.abs((row.lon ?? 0) - HIT10.lon) < 1e-6,
          `G1: row upgraded to the house-number-10 hit specifically, not rejected as ambiguous (got ${row?.lat}, ${row?.lon})`
        );
        assertEq(row?.geocode_confidence, "high", "G2: geocode_confidence='high' (resolved, not ambiguous)");
        assertEq(result.upgraded_address, 1, "G3: result.upgraded_address counts it");
        assertEq(result.skipped_ambiguous, 0, "G4: NOT counted as ambiguous — same adressekode + different house numbers is not real ambiguity");
        const rowReport = result.rows.find((r) => r.provider_id === id);
        assertEq(rowReport?.action, "upgraded_address", "G5: per-row action='upgraded_address'");
      }

      // ═══ H — Bug 1: filtered-to-requested-number set is EMPTY -> no_match, not ambiguous ═══
      {
        const id = expStore.createProvider({
          navn: "Brenneri Gårdsutsalg 3", fylke: "Innlandet", kommune: "Løten",
          kommunenummer: "3403", adresse: "Brennerivegen 25",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.85, lon = 11.35, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        // Kartverket has the street (house numbers 10 and 100) but NOT house
        // number 25 — an honest miss, not the same thing as ambiguity.
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=L.?ten/i.test(url) && /sok=Brennerivegen 25/i.test(url)) {
            return jsonResponse({
              adresser: [
                { representasjonspunkt: { lat: 60.8267, lon: 11.3055 }, adressekode: 5024, nummer: 10, bokstav: "", postnummer: "2340", poststed: "Løten" },
                { representasjonspunkt: { lat: 60.83, lon: 11.31 }, adressekode: 5024, nummer: 100, bokstav: "", postnummer: "2340", poststed: "Løten" },
              ],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertEq(row?.geocode_confidence, "approximate", "H1: row left untouched — Kartverket has the street but not house number 25");
        assertTrue(result.skipped_address_shaped >= 1, "H2: result.skipped_address_shaped counts it (honest miss, not ambiguity)");
        assertEq(result.skipped_ambiguous, 0, "H3: NOT counted as ambiguous");
        const rowReport = result.rows.find((r) => r.provider_id === id);
        assertEq(rowReport?.action, "skipped_address_shaped", "H4: per-row action='skipped_address_shaped', not 'skipped_ambiguous'");
      }

      // ═══ I — Bug 2: postnummer/housenumber collision is rescued, not rejected ═══
      {
        const parsed = worker.parseStreetShapeWithoutPostnummer("Vinjevegen 1075, Vinje");
        assertEq(parsed?.street, "Vinjevegen 1075",
          "I1: 'Vinjevegen 1075, Vinje' is rescued (the 1075/postnummer collision is not a real postnummer)");

        // Live-style integration through the backlog path: the row must
        // actually reach the kommune-disambiguated Kartverket call and get
        // upgraded, not just parse correctly in isolation.
        const id = expStore.createProvider({
          navn: "Vinjevegen Gårdsutsalg", fylke: "Vestfold og Telemark", kommune: "Vinje",
          adresse: "Vinjevegen 1075, Vinje",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 59.6, lon = 7.9, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        const HIT = { lat: 59.615, lon: 7.8882 };
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Vinje/i.test(url) && /sok=Vinjevegen 1075/i.test(url)) {
            return jsonResponse({
              adresser: [{ representasjonspunkt: HIT, adressekode: 3890, nummer: 1075, bokstav: "", postnummer: "3890", poststed: "Vinje" }],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);
        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6,
          `I2: row upgraded via the postnummer/housenumber-collision rescue (got ${row?.lat})`);
        assertEq(row?.geocode_confidence, "high", "I3: geocode_confidence='high'");
        assertEq(result.upgraded_address, 1, "I4: result.upgraded_address counts it (missing-postnummer tier, not postal-mismatch)");
      }

      // ═══ J — Bug 2 regression: parseAddressLike() unchanged ═══
      {
        assertEq(worker.parseAddressLike("Vinjevegen 1075, Vinje"), null,
          "J1: parseAddressLike() still rejects 'Vinjevegen 1075, Vinje' outright (unchanged — guard 3's collision always returned null here)");
        assertEq(worker.parseAddressLike("Gården vår i Vestre Slidre 2966"), null,
          "J2: parseAddressLike() still rejects the existing prose case (unchanged)");
      }

      // ═══ K — Bug 2 regression: genuine prose is still rejected, not rescued ═══
      {
        assertEq(worker.parseStreetShapeWithoutPostnummer("Gården vår i Vestre Slidre 2966"), null,
          "K1: prose with a 5-word name part is still rejected — the word-count guard fires independently of the postnummer/housenumber collision routing");
      }

      // ═══ L — Bug 3: backlog pass "Harstad pattern" retry (was missing) ═══
      {
        const id = expStore.createProvider({
          navn: "Andreas Linds Gårdsutsalg 2", fylke: "Troms og Finnmark", kommune: "Harstad",
          kommunenummer: "5054", adresse: "Andreas Linds gate 9, 9405 Harstad", postnummer: "9405",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        // Backlog only re-attempts rows already at geocode_confidence='approximate'.
        db.prepare(
          `UPDATE experience_providers SET lat = 68.5, lon = 16.0, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(id);

        const HIT = { lat: 68.7985, lon: 16.5416 };
        const calls: string[] = [];
        const fetchImpl = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          calls.push(url);
          // The kommune-disambiguated retry: treffPerSide=5 + kommunenavn param.
          if (/kommunenavn=Harstad/i.test(url) && /treffPerSide=5/.test(url)) {
            return jsonResponse({
              adresser: [{ representasjonspunkt: HIT, adressekode: 4433, nummer: 9, bokstav: "", postnummer: "9406", poststed: "Harstad" }],
            });
          }
          // The address-tier geocodeOne() ladder (treffPerSide=1) — the
          // embedded postnummer "9405" never resolves, by design (the mismatch).
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;

        const result = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl, sleep: async () => {} },
        });
        const row = readProvider(id);

        assertTrue(row?.lat != null && Math.abs(row.lat - HIT.lat) < 1e-6 && Math.abs((row.lon ?? 0) - HIT.lon) < 1e-6,
          `L1: row upgraded via the kommune-disambiguated retry (got ${row?.lat}, ${row?.lon})`);
        assertEq(row?.geocode_confidence, "high", "L2: geocode_confidence='high'");
        assertEq(row?.geocode_source, "kartverket_backlog_kommune", "L3: geocode_source tags this as the kommune-fallback backlog path");
        assertEq(row?.postnummer, "9405", "L4: the row's already-stored postnummer is NOT overwritten, even though the hit disagrees (9406)");
        assertEq(row?.poststed, "Harstad", "L5: poststed WAS empty, so it IS filled in from the hit");
        assertTrue(result.upgraded_postal_mismatch >= 1, "L6: result.upgraded_postal_mismatch counts it (NEW counter)");
        assertTrue(calls.some((u) => /treffPerSide=1/.test(u)), "L9: the address-tier geocodeOne() attempt actually ran first");
        const rowReport = result.rows.find((r) => r.provider_id === id);
        assertEq(rowReport?.action, "upgraded_postal_mismatch",
          "L7+L8: per-row action='upgraded_postal_mismatch' — NOT double-counted under the plain address-tier counter, and skipped_address_shaped does not also fire for THIS row (leftover 'approximate' rows from earlier sections may contribute their own skipped_address_shaped counts to the shared in-memory DB's totals, so this is checked per-row rather than against the global counter)");
      }

      // ═══ M — dev-request 2026-09-12-opplevagent-gaardsnavn-foran-
      // gateadressen: a farm/place name BEFORE the real street segment
      // ("Nedre Røhne Gård, Jernbanegata 287") — `parts[0]` has no street
      // shape, but `parts[1]` does. parseStreetShapeWithoutPostnummer() now
      // tries subsequent comma segments in order (parseAddressLike() never
      // does — see M0 / M9 below). ═══
      {
        // ── M0: parser unit-level — the 3 measured positive rows, plus the
        // 3 explicitly-listed non-matching cases (no overmatching). ──
        assertEq(worker.parseStreetShapeWithoutPostnummer("Nedre Røhne Gård, Jernbanegata 287")?.street, "Jernbanegata 287",
          "M0a: farm name in parts[0], street in parts[1] — the street segment is found and used");
        assertEq(worker.parseStreetShapeWithoutPostnummer("Innsia Bryggeri, Hestvikveien 55")?.street, "Hestvikveien 55",
          "M0b: …second measured row");
        assertEq(worker.parseStreetShapeWithoutPostnummer("Jæren Gard, Hetlandsgata 9")?.street, "Hetlandsgata 9",
          "M0c: …third measured row");

        assertEq(worker.parseStreetShapeWithoutPostnummer("Agnes Torg Sjøparken Larvik"), null,
          "M0d: no comma segment has street shape at all — stays null, no overmatching");
        assertEq(worker.parseStreetShapeWithoutPostnummer("Olden Sentrum"), null,
          "M0e: a bare place name — stays null");
        assertEq(worker.parseStreetShapeWithoutPostnummer("c/o Servicebrygga AS"), null,
          "M0f: a care-of address with no street line anywhere — stays null");

        // ── M9: parseAddressLike() regression — untouched by this change.
        // It is NEVER called with trySubsequentSegments, so it must still
        // test parts[0] alone and reject every one of the M0 inputs above,
        // even the 3 that parseStreetShapeWithoutPostnummer() now accepts. ──
        assertEq(worker.parseAddressLike("Nedre Røhne Gård, Jernbanegata 287"), null,
          "M9a: parseAddressLike() still only tests parts[0] ('Nedre Røhne Gård' — no street shape) — unaffected by the fallback");
        assertEq(worker.parseAddressLike("Innsia Bryggeri, Hestvikveien 55"), null, "M9b: …second row");
        assertEq(worker.parseAddressLike("Jæren Gard, Hetlandsgata 9"), null, "M9c: …third row");
        assertEq(worker.parseAddressLike("Agnes Torg Sjøparken Larvik"), null, "M9d: …negative case, still null");
        assertEq(worker.parseAddressLike("Olden Sentrum"), null, "M9e: …still null");
        assertEq(worker.parseAddressLike("c/o Servicebrygga AS"), null, "M9f: …still null");
        // …and its own pre-existing test inputs are still byte-identical
        // (full breadth already covered by experiences-address-upgrade.test.ts's
        // p1-p29; spot-checked here too since this file is what changed).
        assertEq(worker.parseAddressLike("Sjøgata 21, 8006 Bodø")?.street, "Sjøgata 21", "M9g: a real address still parses exactly as before");
        assertEq(worker.parseAddressLike("Vinjevegen 1075, Vinje"), null, "M9h: the guard-3 collision case still rejects exactly as before");
        assertEq(worker.parseAddressLike("Gården vår i Vestre Slidre 2966"), null, "M9i: the prose case still rejects exactly as before");
        assertEq(worker.parseAddressLike("c/o Josef Flatlandsmo, Åbyfaret 12B")?.street, "Åbyfaret 12B", "M9j: the c/o-prefix case still parses exactly as before");

        // ── M1-M3: full integration — 3 positive rows via the backlog pass,
        // mocked Kartverket, resolve within the measured coordinates. ──
        const ROHNE_HIT = { lat: 60.6932, lon: 11.2028 };
        const idRohne = expStore.createProvider({
          navn: "Røhne Bryggerhus", fylke: "Innlandet", kommune: "Stange",
          adresse: "Nedre Røhne Gård, Jernbanegata 287",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.7, lon = 11.2, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idRohne);
        const rohneFetch = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Stange/i.test(url) && /sok=Jernbanegata 287/i.test(url)) {
            return jsonResponse({
              adresser: [{ representasjonspunkt: ROHNE_HIT, adressekode: 601, nummer: 287, bokstav: "", postnummer: "2335", poststed: "Stange" }],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;
        const rohneResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl: rohneFetch, sleep: async () => {} },
        });
        const rohneRow = readProvider(idRohne);
        assertTrue(
          rohneRow?.lat != null && Math.abs(rohneRow.lat - ROHNE_HIT.lat) < 0.001 && Math.abs((rohneRow.lon ?? 0) - ROHNE_HIT.lon) < 0.001,
          `M1: Røhne Bryggerhus resolves within 100m of (60.6932, 11.2028) — got (${rohneRow?.lat}, ${rohneRow?.lon})`
        );
        assertEq(rohneRow?.geocode_confidence, "high", "M1b: geocode_confidence='high'");
        const rohneAdresse = (db.prepare("SELECT adresse FROM experience_providers WHERE id = ?").get(idRohne) as any)?.adresse;
        assertEq(rohneAdresse, "Nedre Røhne Gård, Jernbanegata 287", "M1c: the original `adresse` text is NOT rewritten — the farm name stays");
        const rohneReport = rohneResult.rows.find((r) => r.provider_id === idRohne);
        assertEq(rohneReport?.action, "upgraded_address", "M1d: per-row action='upgraded_address'");
        assertEq(rohneReport?.planned?.place_name, "Jernbanegata 287", "M1e: planned place_name is the STREET segment only, farm name dropped from the lookup");

        const HITRA_HIT = { lat: 63.5444, lon: 9.1548 };
        const idHitra = expStore.createProvider({
          navn: "Innsia Kulturbryggeri", fylke: "Trøndelag", kommune: "Hitra",
          adresse: "Innsia Bryggeri, Hestvikveien 55",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 63.5, lon = 9.1, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idHitra);
        const hitraFetch = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Hitra/i.test(url) && /sok=Hestvikveien 55/i.test(url)) {
            return jsonResponse({
              adresser: [{ representasjonspunkt: HITRA_HIT, adressekode: 602, nummer: 55, bokstav: "", postnummer: "7247", poststed: "Hestvika" }],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;
        const hitraResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl: hitraFetch, sleep: async () => {} },
        });
        const hitraRow = readProvider(idHitra);
        assertTrue(
          hitraRow?.lat != null && Math.abs(hitraRow.lat - HITRA_HIT.lat) < 0.001 && Math.abs((hitraRow.lon ?? 0) - HITRA_HIT.lon) < 0.001,
          `M2: Innsia Kulturbryggeri resolves within 100m of (63.5444, 9.1548) — got (${hitraRow?.lat}, ${hitraRow?.lon})`
        );
        const hitraReport = hitraResult.rows.find((r) => r.provider_id === idHitra);
        assertEq(hitraReport?.action, "upgraded_address", "M2b: per-row action='upgraded_address'");

        const JAREN_HIT = { lat: 58.7343, lon: 5.6503 };
        const idJaren = expStore.createProvider({
          navn: "Jærakevitt", fylke: "Rogaland", kommune: "Time",
          adresse: "Jæren Gard, Hetlandsgata 9",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 58.7, lon = 5.6, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idJaren);
        const jarenFetch = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Time/i.test(url) && /sok=Hetlandsgata 9/i.test(url)) {
            return jsonResponse({
              adresser: [{ representasjonspunkt: JAREN_HIT, adressekode: 603, nummer: 9, bokstav: "", postnummer: "4344", poststed: "Bryne" }],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;
        const jarenResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl: jarenFetch, sleep: async () => {} },
        });
        const jarenRow = readProvider(idJaren);
        assertTrue(
          jarenRow?.lat != null && Math.abs(jarenRow.lat - JAREN_HIT.lat) < 0.001 && Math.abs((jarenRow.lon ?? 0) - JAREN_HIT.lon) < 0.001,
          `M3: Jærakevitt resolves within 100m of (58.7343, 5.6503) — got (${jarenRow?.lat}, ${jarenRow?.lon})`
        );
        const jarenReport = jarenResult.rows.find((r) => r.provider_id === idJaren);
        assertEq(jarenReport?.action, "upgraded_address", "M3b: per-row action='upgraded_address'");

        // ── M4: negative — NO segment has street shape, stays skipped_no_match ──
        const idNegative = expStore.createProvider({
          navn: "Agnes Torg Sjøparken", fylke: "Vestfold og Telemark", kommune: "Larvik",
          adresse: "Agnes Torg Sjøparken Larvik",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 59.05, lon = 10.03, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idNegative);
        // Other still-'approximate' rows left over from earlier sections (e.g.
        // section D's "Postboks 12", section E's/H's own rows) are ALSO
        // re-scanned by this call (it re-attempts every 'approximate' row up
        // to `limit`, not just the one just created) and may legitimately
        // reach this fetchImpl for THEIR OWN street. So M4b checks specifically
        // that no call was made for THIS row's (non-)address, not that the
        // fetch was never called at all.
        const negativeCalls: string[] = [];
        const negativeFetch = (async (input: any) => {
          negativeCalls.push(decodeURIComponent(String(input)));
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;
        const negativeResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl: negativeFetch, sleep: async () => {} },
        });
        const negativeRow = readProvider(idNegative);
        assertEq(negativeRow?.geocode_confidence, "approximate", "M4: 'Agnes Torg Sjøparken Larvik' left COMPLETELY unchanged — no street shape anywhere");
        assertTrue(
          !negativeCalls.some((u) => /agnes|sjøparken|sjoparken/i.test(u)),
          `M4b: the address-tier Kartverket call was never even attempted FOR THIS ROW (no street shape found in any segment) — calls: ${JSON.stringify(negativeCalls)}`
        );
        const negativeReport = negativeResult.rows.find((r) => r.provider_id === idNegative);
        assertEq(negativeReport?.action, "skipped_no_match", "M4c: reported as skipped_no_match (routed to the Stedsnavn tier, which this file's stub always misses)");

        // ── M5: segment two IS street-shaped, but the Kartverket lookup is
        // ambiguous -> skipped_ambiguous, no write (same shape as section E,
        // but exercised through the multi-segment fallback path). ──
        const idAmbiguous = expStore.createProvider({
          navn: "Nystrand Gårdsutsalg", fylke: "Innlandet", kommune: "Elverum",
          adresse: "Nystrand Gård, Vollgata 8",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.88, lon = 11.56, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idAmbiguous);
        const ambiguousFetch = (async (input: any) => {
          const url = decodeURIComponent(String(input));
          if (/kommunenavn=Elverum/i.test(url) && /sok=Vollgata 8/i.test(url)) {
            return jsonResponse({
              adresser: [
                { representasjonspunkt: { lat: 60.8807, lon: 11.5623 }, adressekode: 111, nummer: 8, bokstav: "", postnummer: "2408", poststed: "Elverum" },
                { representasjonspunkt: { lat: 60.8907, lon: 11.5623 }, adressekode: 222, nummer: 8, bokstav: "", postnummer: "2408", poststed: "Elverum" },
              ],
            });
          }
          return jsonResponse(EMPTY_ADRESSER);
        }) as unknown as typeof fetch;
        const ambiguousResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: false, deps: { fetchImpl: ambiguousFetch, sleep: async () => {} },
        });
        const ambiguousRow = readProvider(idAmbiguous);
        assertEq(ambiguousRow?.geocode_confidence, "approximate", "M5: ambiguous segment-two match — row left COMPLETELY unchanged, no write");
        assertEq(ambiguousRow?.lat, 60.88, "M5b: …coordinate untouched");
        const ambiguousReport = ambiguousResult.rows.find((r) => r.provider_id === idAmbiguous);
        assertEq(ambiguousReport?.action, "skipped_ambiguous", "M5c: reported as skipped_ambiguous");
        assertTrue(ambiguousResult.skipped_ambiguous >= 1, "M5d: result.skipped_ambiguous counts it");

        // ── M6: dry-run twin of M1 — reported as would_upgrade_address,
        // nothing written. ──
        const idDry = expStore.createProvider({
          navn: "Røhne Bryggerhus Dry", fylke: "Innlandet", kommune: "Stange",
          adresse: "Nedre Røhne Gård, Jernbanegata 287",
          brreg_verified: 1, brreg_active: 1, verification_status: "verified",
        } as any);
        db.prepare(
          `UPDATE experience_providers SET lat = 60.7, lon = 11.2, geocode_source = 'kommune_fallback',
                  geocode_confidence = 'approximate', updated_at = datetime('now') WHERE id = ?`
        ).run(idDry);
        const dryResult = await worker.runExperiencesGeocodeBacklogPass(50, {
          dryRun: true, deps: { fetchImpl: rohneFetch, sleep: async () => {} },
        });
        const dryRow = readProvider(idDry);
        assertEq(dryRow?.geocode_confidence, "approximate", "M6: dry_run does not write");
        const dryReport = dryResult.rows.find((r) => r.provider_id === idDry);
        assertEq(dryReport?.action, "would_upgrade_address", "M6b: reported as would_upgrade_address");
        assertTrue(dryResult.would_upgrade_address >= 1, "M6c: result.would_upgrade_address counts it");
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
