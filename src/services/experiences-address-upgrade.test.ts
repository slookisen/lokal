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

        // ── Review follow-up 5: the adversarial set ────────────────
        // 13 of 29 of these used to be false-accepted. None could store a
        // wrong point (the adresse-API is strictly conjunctive, so each simply
        // returned 0 hits) — but every one was a futile HTTP request, and
        // together they were the volume amplifier for the B2 no-rotation bug.
        assertEq(parse("Postboks 123, 0150 Oslo"), null,
          "p9: a POST BOX is a postal address, not a location — refused");
        assertEq(parse("P.b. 22, 0150 Oslo"), null, "p10: …abbreviated «P.b.» too");
        assertEq(parse("Boks 4, 8006 Bodø"), null, "p11: …and «Boks»");
        assertEq(parse("Kai 4, 8006 Bodø"), null, "p12: «Kai 4» is a quay number, not a street");
        assertEq(parse("Bygg 3, 8006 Bodø"), null, "p13: «Bygg 3» is a building number");
        assertEq(parse("Sal 2, 8006 Bodø"), null, "p14: «Sal 2» is a hall number");
        assertEq(parse("Rom 12, 8006 Bodø"), null, "p15: «Rom 12» is a room number");
        assertEq(parse("Inngang 2, 8006 Bodø"), null, "p16: «Inngang 2» is an entrance number");
        assertEq(parse("Rv 7, 3560 Hemsedal"), null, "p17: «Rv 7» is a road number, not an address");
        assertEq(parse("Oslo S: spor 12, 0154 Oslo"), null,
          "p18: the delabeller no longer eats «Oslo S:» and parses «spor 12» as a street");
        assertEq(parse("Gården vår i Vestre Slidre 2966"), null,
          "p19: a whole sentence whose trailing number IS the postnummer is refused");
        assertEq(parse("Vestergade 5, 8000 Aarhus, Danmark"), null,
          "p20: an explicitly FOREIGN address is refused — 8000 is a valid Norwegian postnummer too (Trondheim), so this would otherwise have placed a Danish meeting point in Trøndelag");

        // …and the guards must not have broken the real thing.
        assertEq(parse("Nedre Slottsgate 8, 0157 Oslo")?.street, "Nedre Slottsgate 8",
          "p21: a genuine two-word street name still parses");
        assertEq(parse("Kong Oscars gate 5, 5017 Bergen")?.street, "Kong Oscars gate 5",
          "p22: …and a three-word one");
        assertEq(parse("Sjøgata 21B, 8006 Bodø")?.street, "Sjøgata 21B",
          "p23: …including a house-letter suffix");
        assertEq(parse("Møtested: Havnegata 7, 8006 Bodø")?.street, "Havnegata 7",
          "p24: …behind a real «Møtested:» label");
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

      // ── B2: Step F must ROTATE, not re-select the same residue forever ──
      // Before the fix both give-up paths were a bare `continue` with no
      // write, while the selector was ORDER BY e.id LIMIT ? — so the
      // unresolvable residue was re-selected in the identical order every
      // hour forever AND starved every row behind the LIMIT (measured: 3
      // ticks, byte-identical row list, rows 4-6 never reached; ~100 futile
      // Kartverket requests/hour, indefinitely, against a free public API).
      {
        // Six rows that can NEVER resolve: address-shaped meeting_points that
        // the injected Kartverket seam always misses. Nothing leaves the queue
        // by succeeding, so rotation must come from the attempt stamp alone.
        const stuck: string[] = [];
        for (let i = 1; i <= 6; i++) {
          stuck.push(expStore.createExperience({
            title: `Fastlåst ${i}`, provider_id: withoutAddress,
            provider_match_status: "matched", kommune: "Bodø", fylke: "Nordland",
            meeting_point: `Ingenveien ${i}, 8006 Bodø`,
            verification_status: "verified", confidence: "high",
          }));
        }
        db.prepare(
          `UPDATE experiences SET loc_lat = 67.2804, loc_lon = 14.4049, geo_precision = 'kommune',
                  meeting_point_geocode_attempted_at = NULL
            WHERE id IN (${stuck.map(() => "?").join(",")})`
        ).run(...stuck);

        // Track exactly which addresses Kartverket is asked for, per tick.
        const asked: string[][] = [];
        let current: string[] = [];
        const trackingDeps = {
          sleep: async () => {},
          fetchImpl: (async (input: any) => {
            const url = decodeURIComponent(String(input));
            const m = url.match(/sok=([^&]+)/);
            if (m) current.push(m[1]);
            return { ok: true, status: 200, json: async () => ({ adresser: [] }) } as unknown as Response;
          }) as unknown as typeof fetch,
        };

        for (let tick = 0; tick < 3; tick++) {
          current = [];
          await worker.experiencesGeocodeTick(2, trackingDeps);
          asked.push(current.filter((q) => /ingenveien/i.test(q)));
        }

        const flat = asked.flat();
        const uniq = new Set(flat);
        assertTrue(asked[0].length > 0, `b2-1: tick 1 attempted some stuck rows (${JSON.stringify(asked[0])})`);
        assertTrue(
          JSON.stringify(asked[0]) !== JSON.stringify(asked[1]),
          `b2-2: tick 2 asks for DIFFERENT addresses than tick 1 — the residue rotates instead of repeating (${JSON.stringify(asked[0])} vs ${JSON.stringify(asked[1])})`
        );
        assertEq(uniq.size, flat.length,
          `b2-3: across 3 ticks NO address is queried twice — zero wasted Kartverket requests (${JSON.stringify(flat)})`);
        assertTrue(uniq.size >= 4,
          `b2-4: …and the ticks reach BEYOND the first LIMIT-sized batch, so rows behind it no longer starve (${uniq.size} distinct rows reached)`);

        const stampedCount = (db.prepare(
          `SELECT COUNT(*) AS c FROM experiences
            WHERE meeting_point_geocode_attempted_at IS NOT NULL AND id IN (${stuck.map(() => "?").join(",")})`
        ).get(...stuck) as any).c;
        assertTrue(stampedCount >= 4,
          `b2-5: every attempted row is stamped whatever the outcome (${stampedCount} of 6 stamped)`);

        const distinctStamps = (db.prepare(
          `SELECT COUNT(DISTINCT meeting_point_geocode_attempted_at) AS c FROM experiences
            WHERE meeting_point_geocode_attempted_at IS NOT NULL AND id IN (${stuck.map(() => "?").join(",")})`
        ).get(...stuck) as any).c;
        assertEq(distinctStamps, stampedCount,
          "b2-6: …with DISTINCT monotonic stamps — a 1-second-granularity stamp would collapse a batch and reinstate the id-tiebreaker defect");

        // A row whose text is not address-shaped must be stamped too — it is
        // the largest cohort, and it costs no HTTP request to leave it stuck.
        const vagueStamp = db.prepare(
          `SELECT meeting_point_geocode_attempted_at AS at FROM experiences WHERE id = ?`
        ).get(expVaguePoint) as any;
        assertTrue(!!vagueStamp?.at,
          "b2-7: «ved brygga» is stamped as attempted as well, so the not-address-shaped cohort rotates instead of being re-parsed every tick");
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
