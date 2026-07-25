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
  placeTypeTier,
  nameMatchesQuery,
  officialNames,
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

// NB: the full `stedsnavn` array, verbatim. Every entry is navnestatus
// "hovednavn" — Kartverket records one official name PER LANGUAGE for
// multilingual places — which is what lets the name-similarity guard accept
// «Guovdageaidnu» as the answer to "kautokeino" while still rejecting a
// loose alias (see STEDSNAVN_NES below).
const STEDSNAVN_KAUTOKEINO = {
  metadata: { totaltAntallTreff: 2 },
  navn: [
    {
      navneobjekttype: "Tettsted",
      representasjonspunkt: { nord: 69.01243, øst: 23.04101 },
      stedsnavn: [
        { skrivemåte: "Guovdageaidnu", navnestatus: "hovednavn", språk: "Nordsamisk" },
        { skrivemåte: "Guov'dagæi'dno", navnestatus: "hovednavn", språk: "Nordsamisk" },
        { skrivemåte: "Guovdagæino", navnestatus: "hovednavn", språk: "Nordsamisk" },
        { skrivemåte: "Kautokeino", navnestatus: "hovednavn", språk: "Norsk" },
        { skrivemåte: "Koutokeino", navnestatus: "hovednavn", språk: "Kvensk" },
      ],
    },
    {
      navneobjekttype: "Enebolig/mindre boligbygg",
      representasjonspunkt: { nord: 61.08741, øst: 11.38256 },
      stedsnavn: [{ skrivemåte: "Kautokeino", navnestatus: "hovednavn", språk: "Norsk" }],
    },
  ],
};

// Review follow-up item 5. Raising treffPerSide 3 → 10 changed Kartverket's own
// ordering, and the type allowlist alone let an ACCEPTABLE-TYPE record that is
// not the place asked for win: for "nes" the top Tettsted hit is «Tingnes»
// (60.7621, 10.94127), which merely lists "Nes" as an UNDERNAVN. Verbatim
// capture 2026-07-25.
const STEDSNAVN_NES = {
  metadata: { totaltAntallTreff: 4 },
  navn: [
    {
      navneobjekttype: "Tettsted",
      representasjonspunkt: { nord: 60.7621, øst: 10.94127 },
      stedsnavn: [
        { skrivemåte: "Tingnes", navnestatus: "hovednavn", språk: "Norsk" },
        { skrivemåte: "Nes", navnestatus: "undernavn", språk: "Norsk" },
      ],
    },
    {
      navneobjekttype: "Tettsted",
      representasjonspunkt: { nord: 60.56348, øst: 9.98776 },
      stedsnavn: [{ skrivemåte: "Nes", navnestatus: "hovednavn", språk: "Norsk" }],
    },
  ],
};

// Review follow-up item 4. Norway has genuinely duplicated kommune names and
// the register returns them all — there is no honest way to pick. Verbatim.
const KOMMUNEINFO_HEROY = {
  antallTreff: 2,
  kommuner: [
    {
      kommunenavn: "Herøy", kommunenavnNorsk: "Herøy", kommunenummer: "1818", fylkesnavn: "Nordland",
      gyldigeNavn: [{ navn: "Herøy", prioritet: 1 }],
      punktIOmrade: { coordinates: [11.606, 66.133], type: "Point" },
    },
    {
      kommunenavn: "Herøy", kommunenavnNorsk: "Herøy", kommunenummer: "1515", fylkesnavn: "Møre og Romsdal",
      gyldigeNavn: [{ navn: "Herøy", prioritet: 1 }],
      punktIOmrade: { coordinates: [5.293, 62.439], type: "Point" },
    },
  ],
};

const KOMMUNEINFO_HEROY_1515 = {
  kommunenavn: "Herøy", kommunenavnNorsk: "Herøy", kommunenummer: "1515", fylkesnavn: "Møre og Romsdal",
  gyldigeNavn: [{ navn: "Herøy", prioritet: 1 }],
  punktIOmrade: { coordinates: [5.293, 62.439], type: "Point" },
};

const KOMMUNEINFO_VALER = {
  antallTreff: 2,
  kommuner: [
    {
      kommunenavn: "Våler", kommunenavnNorsk: "Våler", kommunenummer: "3419", fylkesnavn: "Innlandet",
      gyldigeNavn: [{ navn: "Våler", prioritet: 1 }],
      punktIOmrade: { coordinates: [12.015, 60.813], type: "Point" },
    },
    {
      kommunenavn: "Våler", kommunenavnNorsk: "Våler", kommunenummer: "3114", fylkesnavn: "Østfold",
      gyldigeNavn: [{ navn: "Våler", prioritet: 1 }],
      punktIOmrade: { coordinates: [10.922, 59.464], type: "Point" },
    },
  ],
};

// Review follow-up R1 — MINOR-SETTLEMENT vs MAJOR-PLACE collisions. Verbatim
// captures 2026-07-25. In each case a hamlet-scale record used to sit in the
// SAME tier as towns and therefore out-ranked the island / kommune of the same
// name, which was never even looked at.

// «Frøya»: a Grend in Bremanger (Vestland) beat the Trøndelag island. This one
// was a REGRESSION against main, which returned the island.
const STEDSNAVN_FROYA = {
  metadata: { totaltAntallTreff: 6 },
  navn: [
    { navneobjekttype: "Øy i sjø", representasjonspunkt: { nord: 63.6721, øst: 8.3343 },
      stedsnavn: [{ skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Øy i sjø", representasjonspunkt: { nord: 61.7854, øst: 4.8483 },
      stedsnavn: [{ skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Kirke", representasjonspunkt: { nord: 61.7757, øst: 4.8975 },
      stedsnavn: [{ skrivemåte: "Frøya kyrkje", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Bruk", representasjonspunkt: { nord: 63.6909, øst: 8.4373 },
      stedsnavn: [{ skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Grend", representasjonspunkt: { nord: 61.7723, øst: 4.8919 },
      stedsnavn: [{ skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Skjær i sjø", representasjonspunkt: { nord: 63.8210, øst: 9.4436 },
      stedsnavn: [{ skrivemåte: "Frøya", navnestatus: "hovednavn", språk: "Norsk" }] },
  ],
};

// «Sunndal»: a Bygdelag in Kvinnherad beat Sunndal kommune — 309 km.
const STEDSNAVN_SUNNDAL = {
  metadata: { totaltAntallTreff: 6 },
  navn: [
    { navneobjekttype: "Kommune", representasjonspunkt: { nord: 62.67463, øst: 8.56189 },
      stedsnavn: [{ skrivemåte: "Sunndal kommune", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Sunndal", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Bygdelag (bygd)", representasjonspunkt: { nord: 60.11749, øst: 6.26784 },
      stedsnavn: [{ skrivemåte: "Sunndal", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Gard", representasjonspunkt: { nord: 63.37997, øst: 11.33589 },
      stedsnavn: [{ skrivemåte: "Sunndal", navnestatus: "hovednavn", språk: "Norsk" }] },
  ],
};

// «Tysnes»: the bilingual Grend «Diksná / Tysnes» in Nordland beat Tysnes
// kommune in Vestland — 1 045 km. Note the kommune matches only through the
// «<query> kommune» rule, and the island «Tysnesøya» carries Tysnes as an
// UNDERNAVN so the name guard correctly ignores it.
const STEDSNAVN_TYSNES = {
  metadata: { totaltAntallTreff: 5 },
  navn: [
    { navneobjekttype: "Øy i sjø", representasjonspunkt: { nord: 59.97586, øst: 5.44574 },
      stedsnavn: [{ skrivemåte: "Tysnesøya", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Tysnes", navnestatus: "undernavn", språk: "Norsk" }] },
    { navneobjekttype: "Kommune", representasjonspunkt: { nord: 60.00579, øst: 5.5002 },
      stedsnavn: [{ skrivemåte: "Tysnes kommune", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Tysnes", navnestatus: "undernavn", språk: "Norsk" }] },
    { navneobjekttype: "Kirke", representasjonspunkt: { nord: 60.04043, øst: 5.53119 },
      stedsnavn: [{ skrivemåte: "Tysnes kyrkje", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Tysnes", navnestatus: "hovednavn", språk: "Norsk" }] },
    { navneobjekttype: "Grend", representasjonspunkt: { nord: 68.2596, øst: 15.95385 },
      stedsnavn: [{ skrivemåte: "Diksná", navnestatus: "hovednavn", språk: "Lulesamisk" },
                  { skrivemåte: "Tysnes", navnestatus: "hovednavn", språk: "Norsk" }] },
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
      if (/knavn=herøy/i.test(url)) return json(KOMMUNEINFO_HEROY);
      if (/kommuner\/1515/.test(url)) return json(KOMMUNEINFO_HEROY_1515);
      if (/knavn=våler/i.test(url)) return json(KOMMUNEINFO_VALER);
      return notFound();
    }
    if (url.includes("/stedsnavn/")) {
      if (/sok=flakstad(&|$)/i.test(url)) return json(STEDSNAVN_FLAKSTAD);
      if (/sok=blåskjell(&|$)/i.test(url)) return json(STEDSNAVN_BLASKJELL);
      if (/sok=kautokeino(&|$)/i.test(url)) return json(STEDSNAVN_KAUTOKEINO);
      if (/sok=nes(&|$)/i.test(url)) return json(STEDSNAVN_NES);
      if (/sok=frøya(&|$)/i.test(url)) return json(STEDSNAVN_FROYA);
      if (/sok=sunndal(&|$)/i.test(url)) return json(STEDSNAVN_SUNNDAL);
      if (/sok=tysnes(&|$)/i.test(url)) return json(STEDSNAVN_TYSNES);
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

    // ══════════════════════════════════════════════════════════════
    // item 5 (review) — name-similarity guard on Stedsnavn
    // ══════════════════════════════════════════════════════════════
    // The type allowlist is not sufficient: a record can be an acceptable TYPE
    // and still not be the place that was asked for. Kartverket's own ordering
    // is page-size dependent, so raising treffPerSide 3 → 10 silently
    // relocated some lookups. The discriminator is `navnestatus`.
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("nes");
      assertTrue(r !== null, "item 5: 'nes' still resolves");
      if (r) {
        assertTrue(r.name !== "Tingnes",
          `item 5: «Tingnes» is NOT returned as the answer for "nes" — «Nes» is only an UNDERNAVN there (got ${r.name})`);
        assertEq(r.name, "Nes", "item 5: the accepted record is genuinely named Nes");
        assertTrue(Math.abs(r.lat - 60.56348) < 0.001,
          `item 5: …and it is the Nes whose hovednavn matches (got ${r.lat})`);
      }
    }
    {
      // The guard must NOT break real multilingual place names: Kartverket
      // records one hovednavn per language, so «Kautokeino» (Norsk) and
      // «Guovdageaidnu» (Nordsamisk) are both official names of one place.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("kautokeino");
      assertTrue(r !== null && Math.abs(r.lat - 69.01243) < 0.001,
        `item 5: a Sami/Norwegian multilingual name still resolves (got ${r?.lat})`);
      assertEq(r?.name, "Guovdageaidnu", "item 5: …and reports Kartverket's primary official name");
    }
    assertTrue(nameMatchesQuery(
      { stedsnavn: [{ skrivemåte: "Dyrøy kommune", navnestatus: "hovednavn" }] }, "Dyrøy"),
      "item 5: «<query> kommune» counts as a match (Kartverket names admin records that way)");
    assertTrue(nameMatchesQuery(
      { stedsnavn: [{ skrivemåte: "Kvam herad", navnestatus: "hovednavn" }] }, "kvam"),
      "item 5: «<query> herad» counts too");
    assertTrue(nameMatchesQuery(
      { stedsnavn: [{ skrivemåte: "Bømlo", navnestatus: "hovednavn" }] }, "bomlo"),
      "item 5: matching is diacritic-insensitive (ø → o)");
    assertTrue(!nameMatchesQuery(
      { stedsnavn: [{ skrivemåte: "Tingnes", navnestatus: "hovednavn" },
                    { skrivemåte: "Nes", navnestatus: "undernavn" }] }, "nes"),
      "item 5: an UNDERNAVN alias never qualifies");
    assertTrue(!nameMatchesQuery(
      { stedsnavn: [{ skrivemåte: "Nesbyen", navnestatus: "hovednavn" }] }, "nes"),
      "item 5: a prefix is not a match — «Nesbyen» is not «Nes»");
    assertEq(officialNames({ stedsnavn: [{ skrivemåte: "A" }, { skrivemåte: "B" }] }).join("|"), "A",
      "item 5: with no navnestatus at all, only the first listed name is treated as official");

    // ══════════════════════════════════════════════════════════════
    // R1 (review) — a hamlet must not out-rank the island/kommune it shares
    //               a name with
    // ══════════════════════════════════════════════════════════════
    assertEq(placeTypeTier("Tettsted"), 0, "R1: towns are tier 0");
    assertEq(placeTypeTier("Kommune"), 1, "R1: administrative areas are tier 1");
    assertEq(placeTypeTier("Øy i sjø"), 2, "R1: named islands/regions are tier 2");
    assertEq(placeTypeTier("Grend"), 3, "R1: hamlets are LAST (tier 3), not alongside towns");
    assertEq(placeTypeTier("Bygdelag (bygd)"), 3, "R1: …so are bygdelag");
    assertEq(placeTypeTier("Poststed"), 3, "R1: …and poststeder");
    assertEq(placeTypeTier("Gard"), -1, "R1: a farm is still not a place at all");
    assertTrue(isAcceptablePlaceType("Grend"),
      "R1: demoted ≠ rejected — a hamlet is still a valid answer when nothing better shares the name");

    {
      // «Frøya» — the REGRESSION against main. One of Norway's largest seafood
      // municipalities; the branch pointed `sjømat Frøya` at a 15 km circle
      // around a hamlet in Bremanger, 275 km away, reported as geoFiltered.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("frøya");
      assertTrue(r !== null, "R1: 'frøya' resolves");
      if (r) {
        assertEq(r.placeType, "Øy i sjø", "R1: 'frøya' is the Trøndelag ISLAND, not the Bremanger Grend");
        assertTrue(Math.abs(r.lat - 63.6721) < 0.001 && Math.abs(r.lng - 8.3343) < 0.001,
          `R1: …at 63.6721, 8.3343 — the same point main returned (got ${r.lat}, ${r.lng})`);
        assertTrue(haversineDistanceKm(r.lat, r.lng, 61.7723, 4.8919) > 250,
          "R1: …i.e. 275 km away from the hamlet the branch used to pick");
      }
    }
    {
      // «Sunndal» — Bygdelag in Kvinnherad vs Sunndal kommune, 309 km.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("sunndal");
      assertTrue(r !== null, "R1: 'sunndal' resolves");
      if (r) {
        assertEq(r.placeType, "Kommune", "R1: 'sunndal' is the kommune, not the Kvinnherad Bygdelag");
        assertTrue(haversineDistanceKm(r.lat, r.lng, 60.11749, 6.26784) > 250,
          `R1: …309 km from the hamlet (got ${r.lat}, ${r.lng})`);
      }
    }
    {
      // «Tysnes» — the bilingual Grend «Diksná/Tysnes» in Nordland vs Tysnes
      // kommune in Vestland, 1 045 km. Also proves the interaction with the
      // name guard: the ISLAND «Tysnesøya» carries Tysnes only as an
      // undernavn, so the kommune (matched via «<query> kommune») is correct.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocode("tysnes");
      assertTrue(r !== null, "R1: 'tysnes' resolves");
      if (r) {
        assertEq(r.placeType, "Kommune", "R1: 'tysnes' is the Vestland kommune, not the Nordland Grend");
        assertTrue(r.lat < 62,
          `R1: …in Vestland, 1 045 km from «Diksná» in Nordland (got ${r.lat})`);
        assertTrue(r.name !== "Tysnesøya",
          "R1: …and not the island, whose «Tysnes» is only an undernavn");
      }
    }

    // ══════════════════════════════════════════════════════════════
    // item 4 (review) — duplicate kommune names must be REFUSED
    // ══════════════════════════════════════════════════════════════
    // The exact-name search used to run BEFORE the "only one hit" guard, so it
    // silently returned the first of two same-named kommuner with full
    // confidence — the same class of bug as 0a, one layer down.
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("Herøy");
      assertEq(r, null,
        "item 4: «Herøy» by NAME is refused — 1818 Nordland and 1515 Møre og Romsdal are ~450 km apart");
    }
    {
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("Våler");
      assertEq(r, null,
        "item 4: «Våler» by NAME is refused — 3419 Innlandet and 3114 Østfold are ~150 km apart");
    }
    {
      // …but a caller that KNOWS which one (experience_providers.kommunenummer)
      // is unaffected — that path is exact.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("Herøy", "1515");
      assertTrue(r !== null, "item 4: geocodeKommune('Herøy','1515') still resolves");
      if (r) {
        assertTrue(Math.abs(r.lat - 62.439) < 0.01 && Math.abs(r.lng - 5.293) < 0.01,
          `item 4: …to the Møre og Romsdal Herøy, exactly (got ${r.lat}, ${r.lng})`);
      }
    }
    {
      // An unambiguous kommune is of course still resolved by name.
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeKommune("Flakstad");
      assertTrue(r !== null, "item 4: an unambiguous kommune name still resolves");
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
