/**
 * experiences-geocode-sted.test.ts — dev-request
 * 2026-09-09-opplevagent-stedsetikett-poststed-og-kommunesentroide-kart,
 * Skive 2: experiences-geocode-worker.ts Step D's new Stedsnavn-in-kommune
 * branch, inserted BEFORE the existing kommune-centroid fallback.
 *
 * A gårdssalg producer whose only address is a bare PLACE NAME — "Innset", a
 * real place in Rennebu kommune (kommunenummer 5022), with no house number —
 * cannot be geocoded by Step A's street-address ladder at all (there is no
 * house number to query), and used to fall straight through to Step D's
 * kommune-centroid fallback, which can land many km from the real place.
 * This tests the new middle tier: geocodeStedInKommune() looks the place name
 * up scoped to the known kommune BEFORE the kommune centroid is tried.
 *
 * Three scenarios, exactly as specced:
 *   (a) a place-name address with a known kommune AND a Stedsnavn hit →
 *       geocode_confidence='sted', a real point, geocode_source=
 *       'stedsnavn_kommune'.
 *   (b) an ordinary street address is completely unchanged — it resolves in
 *       STEP A and never even reaches Step D's SELECT (lat IS NOT NULL).
 *   (c) REGRESSION GUARD — a place-name address whose Stedsnavn lookup finds
 *       NOTHING falls through to the existing kommune-centroid fallback,
 *       BYTE-IDENTICAL to the pre-Skive-2 behaviour (same geocode_source=
 *       'kommune_fallback', geocode_confidence='approximate', same
 *       coordinate).
 *
 * Two independent HTTP seams are stubbed, matching how the real code splits
 * them: `deps.fetchImpl` (dental-geocode-worker's kartverketQuery, the
 * /adresser/v1/sok street-address API used by Step A) and
 * geocodingService's own `__setGeocodingFetchForTesting` (the /stedsnavn/v1
 * and /kommuneinfo/v1 APIs used by Step D). The Kommuneinfo payload for
 * Rennebu (kommunenummer 5022) is a verbatim capture from
 * ws.geonorge.no/kommuneinfo/v1/kommuner/5022 (2026-09-09).
 *
 * Exported runExperiencesGeocodeStedTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/experiences-geocode-sted.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Stedsnavn: "Innset" scoped to Rennebu (5022) — a real hit ───────────
const STEDSNAVN_INNSET_KNR_5022 = {
  metadata: { totaltAntallTreff: 1 },
  navn: [
    {
      navneobjekttype: "Bygdelag (bygd)",
      representasjonspunkt: { nord: 62.72083, øst: 10.04259 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
  ],
};

// ── Kommuneinfo: Rennebu (5022) — verbatim capture 2026-09-09 ───────────
const KOMMUNEINFO_RENNEBU = {
  kommunenavn: "Rennebu",
  kommunenavnNorsk: "Rennebu",
  kommunenummer: "5022",
  fylkesnavn: "Trøndelag",
  gyldigeNavn: [{ navn: "Rennebu", prioritet: 1 }],
  punktIOmrade: { coordinates: [9.887570019594, 62.766110635459], type: "Point" },
  avgrensningsboks: {
    type: "Polygon",
    coordinates: [[
      [9.421566254213, 62.558234767754], [9.421566254213, 62.974018146689],
      [10.325076717194, 62.974018146689], [10.325076717194, 62.558234767754],
      [9.421566254213, 62.558234767754],
    ]],
  },
};

const STEDSNAVN_EMPTY = { metadata: { totaltAntallTreff: 0 }, navn: [] };

export function runExperiencesGeocodeStedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("./experience-store");
    const workerPath = require.resolve("./experiences-geocode-worker");
    for (const p of [dbFactoryPath, expStorePath, workerPath]) delete require.cache[p];

    const geo = require("./geocoding-service") as typeof import("./geocoding-service");

    // Step A's own HTTP seam: dental-geocode-worker's kartverketQuery, the
    // /adresser/v1/sok street-address API. Only provider (b)'s real street
    // address gets a hit here — (a)/(c)'s place names have no house number to
    // query and never resolve at address precision, by design (the point of
    // this file is what happens AFTER Step A gives up on them).
    const dentalFetchCalls: string[] = [];

    // geocodingService's own seam: /stedsnavn/v1 + /kommuneinfo/v1.
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
    geo.__setGeocodingFetchForTesting((async (input: any) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/stedsnavn/")) {
        if (/sok=innset(&|$)/i.test(url) && /knr=5022/.test(url)) return json(STEDSNAVN_INNSET_KNR_5022);
        return json(STEDSNAVN_EMPTY); // "Tussestogo" and any other query — no hit, ever
      }
      if (url.includes("/kommuneinfo/v1/kommuner/5022")) return json(KOMMUNEINFO_RENNEBU);
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch);
    geo.__clearGeocodeCacheForTesting();

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const { experiencesGeocodeTick } = require("./experiences-geocode-worker") as
        typeof import("./experiences-geocode-worker");
      const db = dbFactory.getDb("experiences");

      // (a) place-name address, known kommune, Stedsnavn HAS a hit.
      const stedProviderId = expStore.createProvider({
        navn: "Innset Gårdsutsalg", fylke: "Trøndelag", kommune: "Rennebu",
        kommunenummer: "5022", adresse: "Innset",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // (b) ordinary street address — Step A must resolve THIS one directly,
      // so it never reaches Step D at all. Route it to a real hit below.
      const streetProviderId = expStore.createProvider({
        navn: "Fjellgata Gårdsbutikk", fylke: "Trøndelag", kommune: "Rennebu",
        kommunenummer: "5022", adresse: "Fjellgata 3, 7391 Rennebu",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // (c) place-name address, known kommune, Stedsnavn has NO hit at all —
      // must fall through to the pre-existing kommune-centroid fallback,
      // unchanged.
      const noHitProviderId = expStore.createProvider({
        navn: "Tussestogo Gårdsutsalg", fylke: "Trøndelag", kommune: "Rennebu",
        kommunenummer: "5022", adresse: "Tussestogo",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });

      // (b)'s street address resolves on the very first Step-A query.
      const fetchImplWithStreetHit = (async (input: any) => {
        const url = String(input);
        dentalFetchCalls.push(url);
        if (decodeURIComponent(url).includes("Fjellgata 3")) {
          return {
            ok: true, status: 200,
            json: async () => ({ adresser: [{ representasjonspunkt: { lat: 62.85, lon: 9.95 } }] }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ adresser: [] }) } as unknown as Response;
      }) as unknown as typeof fetch;

      await experiencesGeocodeTick(50, { fetchImpl: fetchImplWithStreetHit, sleep: async () => {} });

      // ── (a) the Stedsnavn-in-kommune hit ──────────────────────────────
      const stedRow = db
        .prepare("SELECT lat, lon, geocode_source, geocode_confidence FROM experience_providers WHERE id = ?")
        .get(stedProviderId) as { lat: number | null; lon: number | null; geocode_source: string | null; geocode_confidence: string | null };
      assertTrue(stedRow?.lat != null && stedRow?.lon != null, "sted-worker: (a) Innset got a real point");
      assertTrue(Math.abs((stedRow?.lat ?? 0) - 62.72083) < 0.01 && Math.abs((stedRow?.lon ?? 0) - 10.04259) < 0.01,
        `sted-worker: (a) …at the Stedsnavn Bygdelag point, not the kommune centroid (got ${stedRow?.lat}, ${stedRow?.lon})`);
      assertEq(stedRow?.geocode_confidence, "sted", "sted-worker: (a) geocode_confidence='sted'");
      assertEq(stedRow?.geocode_source, "stedsnavn_kommune", "sted-worker: (a) geocode_source='stedsnavn_kommune'");

      // ── (b) the ordinary street address is untouched by Step D ────────
      const streetRow = db
        .prepare("SELECT lat, lon, geocode_source, geocode_confidence FROM experience_providers WHERE id = ?")
        .get(streetProviderId) as { lat: number | null; lon: number | null; geocode_source: string | null; geocode_confidence: string | null };
      assertTrue(streetRow?.lat != null && streetRow?.lon != null, "sted-worker: (b) street address got a point");
      assertTrue(Math.abs((streetRow?.lat ?? 0) - 62.85) < 0.001 && Math.abs((streetRow?.lon ?? 0) - 9.95) < 0.001,
        `sted-worker: (b) …Step A's own geocode, not Step D's (got ${streetRow?.lat}, ${streetRow?.lon})`);
      assertEq(streetRow?.geocode_source, "kartverket", "sted-worker: (b) geocode_source='kartverket' (Step A), never reached Step D");
      assertTrue(streetRow?.geocode_confidence === "high" || streetRow?.geocode_confidence === "medium" || streetRow?.geocode_confidence === "low",
        `sted-worker: (b) geocode_confidence is a real Step-A tier, not 'sted' (got ${streetRow?.geocode_confidence})`);

      // ── (c) REGRESSION — no Stedsnavn hit falls through to the existing,
      //        unchanged kommune-centroid fallback ────────────────────────
      const noHitRow = db
        .prepare("SELECT lat, lon, geocode_source, geocode_confidence FROM experience_providers WHERE id = ?")
        .get(noHitProviderId) as { lat: number | null; lon: number | null; geocode_source: string | null; geocode_confidence: string | null };
      assertTrue(noHitRow?.lat != null && noHitRow?.lon != null, "sted-worker: (c) Tussestogo still got a point (via the kommune fallback)");
      assertTrue(Math.abs((noHitRow?.lat ?? 0) - 62.766110635459) < 0.001 && Math.abs((noHitRow?.lon ?? 0) - 9.887570019594) < 0.001,
        `sted-worker: (c) …at Rennebu kommune's OFFICIAL centroid, byte-identical to the pre-Skive-2 fallback (got ${noHitRow?.lat}, ${noHitRow?.lon})`);
      assertEq(noHitRow?.geocode_source, "kommune_fallback", "sted-worker: (c) geocode_source='kommune_fallback' — unchanged");
      assertEq(noHitRow?.geocode_confidence, "approximate", "sted-worker: (c) geocode_confidence='approximate' — unchanged, NOT 'sted'");
    } catch (err: any) {
      failed++;
      failures.push("experiences-geocode-sted: unexpected error: " + String(err?.message || err));
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
  runExperiencesGeocodeStedTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
