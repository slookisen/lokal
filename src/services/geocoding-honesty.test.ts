/**
 * geocoding-honesty.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0 fixes 0a + 0c.
 *
 * Two production bugs, both "confidently wrong point" class:
 *
 *   0a  Kommune-centroid lookup took Kartverket Stedsnavn's first fuzzy hit.
 *       «Flakstad» returns 8 hits; hit [0] is the Navnegard «Flagstad» at
 *       Hamar (60.81836, 11.10518) and Flakstad kommune in Lofoten is last —
 *       and is typed «Gard», never «Kommune», so a navneobjekttype=Kommune
 *       constraint on Stedsnavn does NOT fix it either (measured live
 *       2026-07-25: that query returns totaltAntallTreff=0). The fix routes
 *       kommune lookups to Kartverket's Kommuneinfo REGISTER instead.
 *       Symptom in production: OpplevAgent discover_experiences at Elverum
 *       (60.9866, 11.4432, radius 30) returned «Nusfjord Arctic Resort» in
 *       Lofoten with distance_km 26.2 — the true distance is 788 km.
 *
 *   0c  lookupKartverket() fell back to `navn[0]` when no populated-place
 *       type matched. `blåskjell` has exactly one Stedsnavn hit: the
 *       FRITIDSBOLIG «Blåskjell» in Larvik (58.9699, 9.89022), so
 *       extractAndGeocode("blåskjell Kautokeino") geocoded to Larvik —
 *       1 400 km wrong — and never tried the word «Kautokeino» at all.
 *
 * All Kartverket/Kommuneinfo payloads below are VERBATIM captures from the
 * live APIs on 2026-07-25 (trimmed to the fields the service reads), injected
 * through __setGeocodingFetchForTesting — no network in the test run.
 *
 * Exported runGeocodingHonestyTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/geocoding-honesty.test.ts
 */

import {
  geocodingService,
  haversineDistanceKm,
  isAcceptablePlaceType,
  radiusFromBoundingBox,
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "./geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Live-captured API payloads (2026-07-25) ────────────────────────

const STEDSNAVN_FLAKSTAD = {
  metadata: { totaltAntallTreff: 8 },
  navn: [
    // hit [0] — the bug: a farm near Hamar, 26.2 km from Elverum
    { navneobjekttype: "Navnegard", representasjonspunkt: { nord: 60.81836, øst: 11.10518 }, stedsnavn: [{ skrivemåte: "Flagstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 69.19054, øst: 17.04435 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Forsamlingshus/kulturhus", representasjonspunkt: { nord: 60.06334, øst: 11.35429 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 60.17764, øst: 11.35967 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 60.80843, øst: 11.38715 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Bruk", representasjonspunkt: { nord: 60.73515, øst: 11.33489 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 60.06426, øst: 11.34742 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 68.10598, øst: 13.30085 }, stedsnavn: [{ skrivemåte: "Flakstad" }] },
  ],
};

const KOMMUNEINFO_FLAKSTAD = {
  antallTreff: 1,
  kommuner: [
    {
      kommunenavn: "Flakstad",
      kommunenavnNorsk: "Flakstad",
      kommunenummer: "1859",
      fylkesnavn: "Nordland",
      gyldigeNavn: [{ navn: "Flakstad", prioritet: 1 }],
      punktIOmrade: { coordinates: [13.047428499262, 68.12146144533], type: "Point" },
      avgrensningsboks: {
        type: "Polygon",
        coordinates: [[
          [12.470102725795, 67.847965300586],
          [12.470102725795, 68.393178536783],
          [13.579708426956, 68.393178536783],
          [13.579708426956, 67.847965300586],
          [12.470102725795, 67.847965300586],
        ]],
      },
    },
  ],
};

const STEDSNAVN_BLASKJELL = {
  metadata: { totaltAntallTreff: 1 },
  navn: [
    { navneobjekttype: "Fritidsbolig", representasjonspunkt: { nord: 58.9699, øst: 9.89022 }, stedsnavn: [{ skrivemåte: "Blåskjell" }] },
  ],
};

const STEDSNAVN_KAUTOKEINO = {
  metadata: { totaltAntallTreff: 2 },
  navn: [
    { navneobjekttype: "Tettsted", representasjonspunkt: { nord: 69.01243, øst: 23.04101 }, stedsnavn: [{ skrivemåte: "Guovdageaidnu" }] },
    { navneobjekttype: "Enebolig/mindre boligbygg", representasjonspunkt: { nord: 61.08741, øst: 11.38256 }, stedsnavn: [{ skrivemåte: "Kautokeino" }] },
  ],
};

const STEDSNAVN_EMPTY = { metadata: { totaltAntallTreff: 0 }, navn: [] };

/**
 * Fake fetch over the two Kartverket APIs. Anything not explicitly routed
 * behaves like the real services do for an unknown name: Stedsnavn returns an
 * empty `navn` array, Kommuneinfo returns HTTP 404 ("Ingen treff").
 */
function makeFakeFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body } as unknown as Response);
  const notFound = () =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);

  const fetchImpl = (async (input: any) => {
    const url = decodeURIComponent(String(input));
    calls.push(url);

    if (url.includes("/kommuneinfo/")) {
      if (/knavn=flakstad/i.test(url) || /kommuner\/1859/.test(url)) return json(KOMMUNEINFO_FLAKSTAD);
      return notFound();
    }
    if (url.includes("/stedsnavn/")) {
      if (/sok=flakstad(&|$)/i.test(url)) return json(STEDSNAVN_FLAKSTAD);
      if (/sok=blåskjell(&|$)/i.test(url)) return json(STEDSNAVN_BLASKJELL);
      if (/sok=kautokeino(&|$)/i.test(url)) return json(STEDSNAVN_KAUTOKEINO);
      return json(STEDSNAVN_EMPTY);
    }
    return notFound();
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

export async function runGeocodingHonestyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) {
      passed++;
      if (log) console.log(`  ✓ ${label}`);
    } else {
      failed++;
      failures.push(`✗ ${label}`);
      if (log) console.log(`  ✗ ${label}`);
    }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);
  }

  const { fetchImpl, calls } = makeFakeFetch();
  __setGeocodingFetchForTesting(fetchImpl);
  __clearGeocodeCacheForTesting();

  try {
    // ── 0c: navneobjekttype allowlist ────────────────────────────────
    assertTrue(isAcceptablePlaceType("Tettsted"), "0c: Tettsted is an acceptable place type");
    assertTrue(isAcceptablePlaceType("Kommune"), "0c: Kommune is an acceptable place type");
    assertTrue(isAcceptablePlaceType("Landskapsområde"), "0c: Landskapsområde (Lofoten/Hardanger) accepted");
    assertTrue(!isAcceptablePlaceType("Fritidsbolig"), "0c: Fritidsbolig REJECTED (the Larvik «Blåskjell» bug)");
    assertTrue(!isAcceptablePlaceType("Navnegard"), "0c: Navnegard REJECTED (the Hamar «Flagstad» bug)");
    assertTrue(!isAcceptablePlaceType("Gard"), "0c: Gard REJECTED");
    assertTrue(!isAcceptablePlaceType("Bruk"), "0c: Bruk REJECTED");
    assertTrue(!isAcceptablePlaceType(""), "0c: empty navneobjekttype REJECTED");
    // The old code used substring matching, so "By" matched these too.
    assertTrue(!isAcceptablePlaceType("Bygg for jordbruk, fiske og fangst"),
      "0c: substring-'By' false positive rejected by exact matching");

    // ── 0c: a lone product word must not produce a point ─────────────
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("blåskjell");
      assertEq(r, null, "0c: geocode('blåskjell') returns null, not the Larvik Fritidsbolig");
    }

    // ── 0c: the headline regression — «blåskjell Kautokeino» ─────────
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.extractAndGeocode("blåskjell Kautokeino");
      assertTrue(r !== null, "0c: 'blåskjell Kautokeino' resolves to SOME place");
      if (r) {
        const distToLarvik = haversineDistanceKm(r.lat, r.lng, 58.9699, 9.89022);
        const distToKautokeino = haversineDistanceKm(r.lat, r.lng, 69.01243, 23.04101);
        assertTrue(distToLarvik > 100,
          `0c: 'blåskjell Kautokeino' is NOT Larvik (got ${r.lat},${r.lng} — ${distToLarvik.toFixed(0)} km from Larvik)`);
        assertTrue(distToKautokeino < 20,
          `0c: 'blåskjell Kautokeino' resolves to Kautokeino/Guovdageaidnu (${distToKautokeino.toFixed(1)} km off)`);
        assertEq(r.placeType, "Tettsted", "0c: the accepted hit is the Tettsted, not the Enebolig");
      }
    }

    // ── 0c: no navn[0] fallback when every hit is an unacceptable type ─
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("flakstad");
      // Stedsnavn has 8 hits, all farms/houses → rejected; the Kommuneinfo
      // register fallback then supplies the real kommune.
      assertTrue(r !== null, "0c/0a: 'flakstad' still resolves (via the kommune register)");
      if (r) {
        assertEq(r.source, "kommuneinfo", "0c/0a: 'flakstad' resolved by the kommune register, not Stedsnavn navn[0]");
        assertTrue(haversineDistanceKm(r.lat, r.lng, 60.81836, 11.10518) > 500,
          "0c/0a: 'flakstad' is NOT the «Flagstad» Navnegard near Hamar");
      }
    }

    // ── 0a: geocodeKommune picks the kommune, not the same-named farm ──
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("Flakstad");
      assertTrue(r !== null, "0a: geocodeKommune('Flakstad') resolves");
      if (r) {
        const toLofoten = haversineDistanceKm(r.lat, r.lng, 68.12146, 13.04743);
        assertTrue(toLofoten < 5,
          `0a: Flakstad kommune centroid is in Lofoten (got ${r.lat},${r.lng}, ${toLofoten.toFixed(1)} km off)`);
        assertEq(r.source, "kommuneinfo", "0a: source is the kommune register");
        assertTrue(r.radiusKm >= 20 && r.radiusKm <= 60,
          `0a: radius derived from the kommune bounding box (got ${r.radiusKm} km)`);
      }
    }

    // ── 0a: the Elverum symptom, stated as distance ───────────────────
    {
      __clearGeocodeCacheForTesting();
      const ELVERUM = { lat: 60.9866, lng: 11.4432 };
      const r = await geocodingService.geocodeKommune("Flakstad");
      assertTrue(r !== null, "0a: Elverum case — Flakstad resolves");
      if (r) {
        const d = haversineDistanceKm(ELVERUM.lat, ELVERUM.lng, r.lat, r.lng);
        // Old behaviour: 26.2 km (inside a radius-30 search from Elverum).
        assertTrue(d > 30,
          `0a: a Flakstad-kommune provider is OUTSIDE a 30 km search from Elverum (got ${d.toFixed(1)} km; the bug reported 26.2 km)`);
        assertTrue(d > 700,
          `0a: …and is in fact ~788 km away (got ${d.toFixed(0)} km)`);
      }
    }

    // ── 0a: kommunenummer takes priority over the name ────────────────
    {
      __clearGeocodeCacheForTesting();
      calls.length = 0;
      const r = await geocodingService.geocodeKommune("Flakstad", "1859");
      assertTrue(r !== null && haversineDistanceKm(r!.lat, r!.lng, 68.12146, 13.04743) < 5,
        "0a: geocodeKommune by kommunenummer 1859 → Flakstad kommune in Lofoten");
      assertTrue(calls.some((u) => u.includes("/kommuneinfo/v1/kommuner/1859")),
        "0a: the kommunenummer path hits the exact register endpoint");
      assertTrue(!calls.some((u) => u.includes("/stedsnavn/")),
        "0a: with a kommunenummer, no fuzzy Stedsnavn call is made at all");
    }

    // ── 0a: a name that is not a kommune must not be invented ─────────
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("blåskjell");
      assertEq(r, null, "0a: geocodeKommune('blåskjell') returns null rather than a wrong point");
    }

    // ── Results are cached (no repeated API hammering) ────────────────
    {
      __clearGeocodeCacheForTesting();
      calls.length = 0;
      await geocodingService.geocodeKommune("Flakstad");
      const afterFirst = calls.length;
      await geocodingService.geocodeKommune("Flakstad");
      assertEq(calls.length, afterFirst, "0a: second geocodeKommune('Flakstad') is served from cache");
    }

    // ── radiusFromBoundingBox ─────────────────────────────────────────
    {
      const r = radiusFromBoundingBox(KOMMUNEINFO_FLAKSTAD.kommuner[0]!.avgrensningsboks, 68.12);
      assertTrue(r >= 25 && r <= 35, `bbox radius: Flakstad ≈ 30 km (got ${r})`);
      assertEq(radiusFromBoundingBox(undefined, 60), 30, "bbox radius: missing box → 30 km default");
      assertEq(radiusFromBoundingBox({ coordinates: [[[10, 60], [10.001, 60], [10.001, 60.001], [10, 60]]] }, 60), 10,
        "bbox radius: tiny box clamped up to 10 km");
    }
  } finally {
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runGeocodingHonestyTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
