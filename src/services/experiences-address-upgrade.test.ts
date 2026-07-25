/**
 * experiences-address-upgrade.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1b.
 *
 * Measured live 2026-07-25: ~427 of 433 experiences are geocoded and 100 % of
 * them sit at geo_precision='kommune'. ZERO at address precision — everything
 * in Bodø honestly reports distance_km 0, and Fase 2's 10–25 km corridor
 * search over municipal centroids would be meaningless.
 *
 * The cause is an ordering gap, not missing data: Step B of
 * experiences-geocode-worker.ts only propagates a provider's address-level
 * position to experiences whose geo_precision IS NULL, so any experience Step C
 * reached first is pinned at 'kommune' forever. Steps E and F are the missing
 * re-attempt.
 *
 * Covers:
 *   e1-e4  Step E: a kommune-precision experience whose provider HAS a real
 *          address geocode is lifted to 'address' with the provider's position
 *   e5-e6  …but a provider placed only by the kommune-centroid fallback
 *          ('approximate', Step D) may NOT promote anything — that would
 *          relabel a centroid as street precision, which is the exact lie the
 *          geo_precision column exists to prevent
 *   f1-f4  Step F: `meeting_point` is used as an address source ONLY when it
 *          actually parses as one; «ved brygga» stays at kommune precision
 *   p1-p8  parseAddressLike() itself — the strict accept/refuse boundary
 *
 * Setup mirrors experiences-geocode-kommune.test.ts (EXPERIENCES_DB_PATH=
 * ":memory:" + __resetDbFactoryForTesting()), with the Kartverket adresse-API
 * injected via GeocodeDeps.fetchImpl — no network.
 *
 * Exported runExperiencesAddressUpgradeTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone:
 *   npx tsx src/services/experiences-address-upgrade.test.ts
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// adresser/v1/sok shape. Two distinct points so a test can prove WHICH lookup
// produced the stored position.
const PROVIDER_POINT = { lat: 67.2804, lon: 14.4049 };  // provider street address
const MEETING_POINT = { lat: 67.2900, lon: 14.3800 };   // meeting_point address

export function runExperiencesAddressUpgradeTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      actual === expected,
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    for (const p of [
      require.resolve("../database/db-factory"),
      require.resolve("./experience-store"),
      require.resolve("./experiences-geocode-worker"),
    ]) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("./experience-store") as typeof import("./experience-store");
      const worker = require("./experiences-geocode-worker") as
        typeof import("./experiences-geocode-worker");
      const db = dbFactory.getDb("experiences");

      // ── p1-p8: the parser's accept/refuse boundary ───────────────
      // Deliberately strict: a wrong-but-precise point is worse than an honest
      // kommune centroid (the whole lesson of Fase 0).
      {
        const parse = worker.parseAddressLike;
        assertEq(parse("Sjøgata 21, 8006 Bodø")?.street, "Sjøgata 21",
          "p1: a real address is parsed into its street part");
        assertEq(parse("Sjøgata 21, 8006 Bodø")?.postnummer, "8006",
          "p2: …and its postnummer");
        assertEq(parse("Oppmøte: Storgata 5, 8300 Svolvær")?.street, "Storgata 5",
          "p3: a leading «Oppmøte:» label is stripped");
        assertEq(parse("ved brygga"), null,
          "p4: «ved brygga» is NOT an address — refused, the row stays at kommune precision");
        assertEq(parse("vi henter deg på hotellet"), null,
          "p5: neither is a pickup sentence");
        assertEq(parse("Storgata 5"), null,
          "p6: a street with no postnummer is refused — «Storgata 5» exists in dozens of kommuner");
        assertEq(parse("oppmøte 30 min før avgang"), null,
          "p7: a time instruction is refused even though it contains a number");
        assertEq(parse(""), null, "p8: empty/missing meeting_point is refused");
      }

      // ── Seed: a Bodø provider WITH a street address ──────────────
      const withAddress = expStore.createProvider({
        navn: "Bodø Opplevelser AS", fylke: "Nordland", kommune: "Bodø", kommunenummer: "1804",
        adresse: "Sjøgata 21", postnummer: "8006", poststed: "Bodø",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expWithProviderAddress = expStore.createExperience({
        title: "Havsafari fra Bodø", provider_id: withAddress,
        provider_match_status: "matched", kommune: "Bodø", fylke: "Nordland",
        verification_status: "verified", confidence: "high",
      });

      // …and a provider with NO address, i.e. one that Step D can only place
      // at a kommune centroid ('approximate').
      const withoutAddress = expStore.createProvider({
        navn: "Saltstraumen Guiding", fylke: "Nordland", kommune: "Bodø", kommunenummer: "1804",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const expApproxProvider = expStore.createExperience({
        title: "Guidet tur i Saltstraumen", provider_id: withoutAddress,
        provider_match_status: "matched", kommune: "Bodø", fylke: "Nordland",
        verification_status: "verified", confidence: "high",
      });

      // …and one with an address-shaped meeting_point but no provider address,
      // plus one whose meeting_point is prose.
      const expMeetingPoint = expStore.createExperience({
        title: "Kajakk ved kaia", provider_id: withoutAddress,
        provider_match_status: "matched", kommune: "Bodø", fylke: "Nordland",
        meeting_point: "Oppmøte: Havnegata 7, 8006 Bodø",
        verification_status: "verified", confidence: "high",
      });
      const expVaguePoint = expStore.createExperience({
        title: "Fisketur", provider_id: withoutAddress,
        provider_match_status: "matched", kommune: "Bodø", fylke: "Nordland",
        meeting_point: "ved brygga",
        verification_status: "verified", confidence: "high",
      });

      // Put the world in the state the live catalogue is actually in: every
      // experience at kommune precision, the address-bearing provider already
      // geocoded, the address-less provider placed at 'approximate'.
      db.prepare(
        `UPDATE experiences SET loc_lat = 67.2804, loc_lon = 14.4049, geo_precision = 'kommune'`
      ).run();
      db.prepare(
        `UPDATE experience_providers SET lat = ?, lon = ?, geocode_confidence = 'high',
                geocode_source = 'kartverket' WHERE id = ?`
      ).run(PROVIDER_POINT.lat, PROVIDER_POINT.lon, withAddress);
      db.prepare(
        `UPDATE experience_providers SET lat = 67.2500, lon = 14.4000, geocode_confidence = 'approximate',
                geocode_source = 'kommune_fallback' WHERE id = ?`
      ).run(withoutAddress);

      // The adresse-API seam: only Havnegata resolves (that is Step F's row).
      const deps = {
        sleep: async () => {},
        fetchImpl: (async (input: any) => {
          const url = decodeURIComponent(String(input));
          const body = /havnegata/i.test(url)
            ? { adresser: [{ representasjonspunkt: MEETING_POINT }] }
            : { adresser: [] };
          return { ok: true, status: 200, json: async () => body } as unknown as Response;
        }) as unknown as typeof fetch,
      };

      await worker.experiencesGeocodeTick(50, deps);

      const rowOf = (id: string) => db
        .prepare(`SELECT loc_lat, loc_lon, geo_precision FROM experiences WHERE id = ?`)
        .get(id) as any;

      // ── e1-e4: Step E — the kommune → address upgrade ────────────
      {
        const r = rowOf(expWithProviderAddress);
        assertEq(r.geo_precision, "address",
          "e1: a kommune-precision experience is LIFTED to address precision once its provider has a real street geocode");
        assertEq(r.loc_lat, PROVIDER_POINT.lat,
          "e2: …and takes the provider's actual address position");
        assertEq(r.loc_lon, PROVIDER_POINT.lon, "e3: …both coordinates");

        // Idempotent: a second tick must not churn or regress it.
        await worker.experiencesGeocodeTick(50, deps);
        assertEq(rowOf(expWithProviderAddress).geo_precision, "address",
          "e4: a second tick leaves it at address precision (upgrade only, never a downgrade)");
      }

      // ── e5-e6: an 'approximate' provider may not promote anything ─
      {
        const r = rowOf(expApproxProvider);
        assertEq(r.geo_precision, "kommune",
          "e5: an experience whose provider was placed only by the kommune-centroid fallback STAYS at kommune precision");
        assertTrue(r.loc_lat !== 67.25,
          "e6: …and is not silently moved to that approximate provider point either");
      }

      // ── f1-f4: Step F — meeting_point, only when it is an address ─
      {
        const parsed = rowOf(expMeetingPoint);
        assertEq(parsed.geo_precision, "address",
          "f1: an experience with an address-shaped meeting_point is lifted to address precision");
        assertEq(parsed.loc_lat, MEETING_POINT.lat,
          "f2: …at the position Kartverket returned for THAT address (not the provider's)");

        const vague = rowOf(expVaguePoint);
        assertEq(vague.geo_precision, "kommune",
          "f3: «ved brygga» is not an address — the row stays honestly at kommune precision");
        assertEq(vague.loc_lat, 67.2804,
          "f4: …with its kommune-centroid position untouched (no guessed point)");
      }
    } catch (err: any) {
      failed++;
      failures.push("experiences-address-upgrade: unexpected error: " + String(err?.message || err));
    } finally {
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory"))
          .__resetDbFactoryForTesting();
      } catch { /* nothing to reset */ }
      if (prevExperiencesDbPath === undefined) delete process.env.EXPERIENCES_DB_PATH;
      else process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
    }

    return { passed, failed, failures };
  })();
}

// Standalone runner
if (require.main === module) {
  runExperiencesAddressUpgradeTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
