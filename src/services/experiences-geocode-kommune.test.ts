/**
 * experiences-geocode-kommune.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0a, end-to-end.
 *
 * geocoding-honesty.test.ts proves the LOOKUP now resolves «Flakstad» to
 * Flakstad kommune in Lofoten instead of the Navnegard «Flagstad» near Hamar.
 * This file proves the SYMPTOM Daniel actually saw is gone: OpplevAgent's
 * discover_experiences at the Elverum coordinates (60.9866, 11.4432,
 * radius_km 30) returned «Nusfjord Arctic Resort» — a Lofoten provider —
 * reporting distance_km 26.2 when the true distance is 788 km.
 *
 * Chain under test, exactly as it runs in production:
 *   experiencesGeocodeTick() Step C  →  geocodingService.geocodeKommune()
 *   →  experiences.loc_lat/loc_lon   →  discoverExperiences() radius filter.
 *
 * Real experiences schema in an in-memory DB (EXPERIENCES_DB_PATH=":memory:",
 * same setup as experiences-seo-sok-geo.test.ts). The Kartverket/Kommuneinfo
 * HTTP seam is injected with verbatim 2026-07-25 captures — no network.
 *
 * Exported runExperiencesGeocodeKommuneTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/experiences-geocode-kommune.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Verbatim captures (trimmed to the fields the service reads), 2026-07-25.
const STEDSNAVN_FLAKSTAD = {
  metadata: { totaltAntallTreff: 8 },
  navn: [
    { navneobjekttype: "Navnegard", representasjonspunkt: { nord: 60.81836, øst: 11.10518 }, stedsnavn: [{ skrivemåte: "Flagstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 69.19054, øst: 17.04435 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 68.10598, øst: 13.30085 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
  ],
};

const KOMMUNEINFO_FLAKSTAD = {
  antallTreff: 1,
  kommuner: [{
    kommunenavn: "Flakstad", kommunenavnNorsk: "Flakstad", kommunenummer: "1859",
    fylkesnavn: "Nordland", gyldigeNavn: [{ navn: "Flakstad", prioritet: 1 }],
    punktIOmrade: { coordinates: [13.047428499262, 68.12146144533], type: "Point" },
    avgrensningsboks: {
      type: "Polygon",
      coordinates: [[
        [12.470102725795, 67.847965300586], [12.470102725795, 68.393178536783],
        [13.579708426956, 68.393178536783], [13.579708426956, 67.847965300586],
        [12.470102725795, 67.847965300586],
      ]],
    },
  }],
};

const KOMMUNEINFO_ELVERUM = {
  antallTreff: 1,
  kommuner: [{
    kommunenavn: "Elverum", kommunenavnNorsk: "Elverum", kommunenummer: "3420",
    fylkesnavn: "Innlandet", gyldigeNavn: [{ navn: "Elverum", prioritet: 1 }],
    punktIOmrade: { coordinates: [11.7345, 60.9728], type: "Point" },
    avgrensningsboks: {
      type: "Polygon",
      coordinates: [[
        [11.09, 60.61], [11.09, 61.20], [12.14, 61.20], [12.14, 60.61], [11.09, 60.61],
      ]],
    },
  }],
};

// The Elverum query point from the live bug report.
const ELVERUM = { lat: 60.9866, lng: 11.4432 };

export function runExperiencesGeocodeKommuneTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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
    const expStorePath = require.resolve("./experience-store");
    const workerPath = require.resolve("./experiences-geocode-worker");
    for (const p of [dbFactoryPath, expStorePath, workerPath]) delete require.cache[p];

    const geo = require("./geocoding-service") as typeof import("./geocoding-service");

    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
    const notFound = () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    geo.__setGeocodingFetchForTesting((async (input: any) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/kommuneinfo/")) {
        if (/knavn=flakstad/i.test(url) || /kommuner\/1859/.test(url)) return json(KOMMUNEINFO_FLAKSTAD);
        if (/knavn=elverum/i.test(url) || /kommuner\/3420/.test(url)) return json(KOMMUNEINFO_ELVERUM);
        return notFound();
      }
      if (url.includes("/stedsnavn/")) {
        if (/sok=flakstad(&|$)/i.test(url)) return json(STEDSNAVN_FLAKSTAD);
        return json({ metadata: { totaltAntallTreff: 0 }, navn: [] });
      }
      return notFound();
    }) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const { experiencesGeocodeTick } = require("./experiences-geocode-worker") as
        typeof import("./experiences-geocode-worker");
      const db = dbFactory.getDb("experiences");

      // A Lofoten provider + experience, kommune 'Flakstad' — no street
      // address, so Step A never runs and the kommune-centroid fallback
      // (Step C/D) is the only thing that can place them. This is the exact
      // shape of the 100 %-kommune-precision experiences catalogue.
      const lofotenProvider = expStore.createProvider({
        navn: "Nusfjord Arctic Resort", fylke: "Nordland", kommune: "Flakstad",
        kommunenummer: "1859", brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Rorbuopphold i Nusfjord", provider_id: lofotenProvider,
        provider_match_status: "matched", kommune: "Flakstad", fylke: "Nordland",
        verification_status: "verified", confidence: "high",
      });

      // A genuinely nearby control, so a passing test cannot just be "the
      // radius filter returns nothing".
      const elverumProvider = expStore.createProvider({
        navn: "Elverum Opplevelser AS", fylke: "Innlandet", kommune: "Elverum",
        kommunenummer: "3420", brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      expStore.createExperience({
        title: "Skogstur i Elverum", provider_id: elverumProvider,
        provider_match_status: "matched", kommune: "Elverum", fylke: "Innlandet",
        verification_status: "verified", confidence: "high",
      });

      await experiencesGeocodeTick(50);

      // ── The stored position ────────────────────────────────────────
      const lofotenRow = db
        .prepare("SELECT loc_lat, loc_lon, geo_precision FROM experiences WHERE kommune = 'Flakstad'")
        .get() as { loc_lat: number | null; loc_lon: number | null; geo_precision: string | null };

      assertTrue(lofotenRow?.loc_lat != null && lofotenRow?.loc_lon != null,
        "0a: the Flakstad experience got a kommune-centroid position");
      assertTrue((lofotenRow?.loc_lat ?? 0) > 67,
        `0a: …and it is in LOFOTEN, not at Hamar (lat ${lofotenRow?.loc_lat}; the bug stored 60.81836)`);
      assertTrue(Math.abs((lofotenRow?.loc_lat ?? 0) - 68.12146) < 0.01 &&
                 Math.abs((lofotenRow?.loc_lon ?? 0) - 13.04743) < 0.01,
        `0a: …at Flakstad kommune's official representative point (got ${lofotenRow?.loc_lat}, ${lofotenRow?.loc_lon})`);
      assertTrue(lofotenRow?.geo_precision === "kommune",
        "0a: …honestly tagged geo_precision='kommune' (never claims street precision)");

      const provRow = db
        .prepare("SELECT lat, lon, geocode_confidence FROM experience_providers WHERE navn = 'Nusfjord Arctic Resort'")
        .get() as { lat: number | null; lon: number | null; geocode_confidence: string | null };
      assertTrue((provRow?.lat ?? 0) > 67,
        `0a: the PROVIDER row is in Lofoten too (Step D, lat ${provRow?.lat})`);
      assertTrue(provRow?.geocode_confidence === "approximate",
        "0a: …tagged 'approximate', not a real address-level geocode");

      // ── The reported symptom, through the real discovery path ──────
      const nearElverum = expStore.discoverExperiences(
        { lat: ELVERUM.lat, lng: ELVERUM.lng, radius_km: 30, sort: "distance" }, 50);
      const titles = nearElverum.map((e) => e.title);

      assertTrue(!titles.includes("Rorbuopphold i Nusfjord"),
        `0a: discover_experiences at Elverum (r=30) does NOT return the Lofoten provider (got: ${titles.join(", ") || "nothing"})`);
      assertTrue(titles.includes("Skogstur i Elverum"),
        `0a: …while the genuinely nearby Elverum experience IS returned (got: ${titles.join(", ") || "nothing"})`);

      const lofotenHit = nearElverum.find((e) => e.title === "Rorbuopphold i Nusfjord");
      assertTrue(lofotenHit === undefined,
        "0a: no result claims a 26.2 km distance for a provider 788 km away");

      // A wide-enough search still finds it, at an honest distance.
      const wide = expStore.discoverExperiences(
        { lat: ELVERUM.lat, lng: ELVERUM.lng, radius_km: 900, sort: "distance" }, 50);
      const wideHit = wide.find((e) => e.title === "Rorbuopphold i Nusfjord");
      assertTrue(!!wideHit, "0a: a 900 km search DOES find the Lofoten provider");
      assertTrue(!!wideHit && (wideHit.distance_km ?? 0) > 700,
        `0a: …and reports the real ~790 km, not 26.2 km (got ${wideHit?.distance_km})`);
    } catch (err: any) {
      failed++;
      failures.push("experiences-geocode-kommune: unexpected error: " + String(err?.message || err));
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
  runExperiencesGeocodeKommuneTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
