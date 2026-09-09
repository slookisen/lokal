/**
 * geocoding-service-sted.test.ts — dev-request
 * 2026-09-09-opplevagent-stedsetikett-poststed-og-kommunesentroide-kart,
 * Skive 2: geocodeStedInKommune().
 *
 * Norwegian gårdssalg addresses are sometimes a bare PLACE NAME with no house
 * number ("Innset" — a real place in Rennebu kommune, kommunenummer 5022, no
 * street address). geocodeStedInKommune() looks the name up via Kartverket's
 * Stedsnavn API, scoped to the kommune the caller already knows the row
 * belongs to, so "Innset" resolves to the actual hamlet rather than falling
 * straight to geocodeKommune()'s whole-municipality centroid.
 *
 * All Stedsnavn payloads below are VERBATIM (trimmed to the fields the
 * service reads) from a live query against ws.geonorge.no/stedsnavn/v1/sted
 * on 2026-09-09 — both `sok=Innset` (8 national hits) and `sok=Innset&knr=5022`
 * (narrowed to the 2 hits actually in Rennebu). That live check is also what
 * caught the spec's assumed filter param name: `&kommunenummer=5022` changes
 * nothing (Kartverket silently ignores unknown params); `&knr=5022` is the
 * real, documented filter (ws.geonorge.no/stedsnavn/v1/openapi.json). One
 * test below pins that the service queries `knr`, not `kommunenummer`.
 *
 * Exported runGeocodingServiceStedTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/services/geocoding-service-sted.test.ts
 */

import {
  geocodingService,
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "./geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ─── Live-captured Stedsnavn payloads (2026-09-09) ──────────────────────

// sok=Innset&knr=5022 — narrowed server-side to the 2 hits actually in
// Rennebu kommune (5022). Kirke is not an acceptable navneobjekttype, so the
// only qualifying hit is the Bygdelag.
const STEDSNAVN_INNSET_KNR_5022 = {
  metadata: { totaltAntallTreff: 2 },
  navn: [
    {
      navneobjekttype: "Bygdelag (bygd)",
      representasjonspunkt: { nord: 62.72083, øst: 10.04259 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
    {
      navneobjekttype: "Kirke",
      representasjonspunkt: { nord: 62.72033, øst: 10.04254 },
      stedsnavn: [{ skrivemåte: "Innset kirke", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
  ],
};

// sok=Innset (unfiltered) — 5 of the live 8 hits (trimmed to the ones the
// tests below exercise; the other 3 are further duplicate Gard/Kirke rows
// that don't change which one wins).
const STEDSNAVN_INNSET_ALL = {
  metadata: { totaltAntallTreff: 8 },
  navn: [
    {
      navneobjekttype: "Bygdelag (bygd)",
      representasjonspunkt: { nord: 62.72083, øst: 10.04259 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
    {
      navneobjekttype: "Navnegard",
      representasjonspunkt: { nord: 68.66184, øst: 18.81107 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Bardu", kommunenummer: "5520" }],
    },
    {
      navneobjekttype: "Kirke",
      representasjonspunkt: { nord: 62.72033, øst: 10.04254 },
      stedsnavn: [{ skrivemåte: "Innset kirke", navnestatus: "hovednavn", språk: "Norsk" },
                  { skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
    {
      navneobjekttype: "Grend",
      representasjonspunkt: { nord: 68.65882, øst: 18.81244 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Bardu", kommunenummer: "5520" }],
    },
    {
      navneobjekttype: "Gard",
      representasjonspunkt: { nord: 68.96237, øst: 19.74637 },
      stedsnavn: [{ skrivemåte: "Innset", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Målselv", kommunenummer: "5524" }],
    },
  ],
};

// A place whose ONLY hit is an unacceptable type (Navnegard — a farm, not a
// place) — same in both the knr-filtered and unfiltered response, so no
// corroboration path can ever manufacture a hit out of it.
const STEDSNAVN_LONELY_FARM = {
  metadata: { totaltAntallTreff: 1 },
  navn: [
    {
      navneobjekttype: "Navnegard",
      representasjonspunkt: { nord: 60.1, øst: 10.1 },
      stedsnavn: [{ skrivemåte: "Låven", navnestatus: "hovednavn", språk: "Norsk" }],
      kommuner: [{ kommunenavn: "Rennebu", kommunenummer: "5022" }],
    },
  ],
};

const STEDSNAVN_EMPTY = { metadata: { totaltAntallTreff: 0 }, navn: [] };

function makeFakeFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);

  const fetchImpl = (async (input: any) => {
    const url = decodeURIComponent(String(input));
    calls.push(url);

    if (!url.includes("/stedsnavn/")) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;

    const hasKnr5022 = /(?:^|[?&])knr=5022(?:&|$)/.test(url);
    const hasKnr9999 = /(?:^|[?&])knr=9999(?:&|$)/.test(url);
    if (/sok=innset(&|$)/i.test(url)) {
      if (hasKnr9999) return json(STEDSNAVN_EMPTY); // a kommunenummer with no real hits at all
      return json(hasKnr5022 ? STEDSNAVN_INNSET_KNR_5022 : STEDSNAVN_INNSET_ALL);
    }
    if (/sok=l[åa]ven(&|$)/i.test(url)) return json(STEDSNAVN_LONELY_FARM);
    return json(STEDSNAVN_EMPTY);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

export async function runGeocodingServiceStedTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { fetchImpl, calls } = makeFakeFetch();
  __setGeocodingFetchForTesting(fetchImpl);
  __clearGeocodeCacheForTesting();

  try {
    // ── hit corroborated by kommunenummer (server-side knr filter) ─────
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeStedInKommune("Innset", "5022", null);
      assertTrue(r !== null, "sted: geocodeStedInKommune('Innset', '5022') resolves");
      if (r) {
        assertTrue(Math.abs(r.lat - 62.72083) < 0.001 && Math.abs(r.lng - 10.04259) < 0.001,
          `sted: …to the Rennebu Bygdelag (got ${r.lat}, ${r.lng})`);
        assertEq(r.placeType, "Bygdelag (bygd)", "sted: accepted hit is the Bygdelag, not the Kirke");
        assertEq(r.source, "kartverket", "sted: source is kartverket");
      }
      assertTrue(calls.some((u) => u.includes("knr=5022")),
        "sted: the request used the REAL Kartverket filter param `knr`");
      assertTrue(!calls.some((u) => u.includes("kommunenummer=")),
        "sted: the request did NOT use the undocumented/no-op `kommunenummer` param");
    }

    // ── hit corroborated by kommune NAME (no kommunenummer given) ──────
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeStedInKommune("Innset", null, "Rennebu");
      assertTrue(r !== null, "sted: geocodeStedInKommune('Innset', null, 'Rennebu') resolves");
      if (r) {
        assertTrue(Math.abs(r.lat - 62.72083) < 0.001 && Math.abs(r.lng - 10.04259) < 0.001,
          `sted: …corroborated by kommunenavn to the Rennebu Bygdelag (got ${r.lat}, ${r.lng})`);
      }
      assertTrue(!calls.some((u) => u.includes("knr=")),
        "sted: with no kommunenummer, no knr-filtered request is made at all");
      assertTrue(calls.some((u) => /sok=innset(&|$)/i.test(u)),
        "sted: …the unfiltered search is used instead");
    }

    // ── REJECTED: corroboration fails (kommune name matches nothing) ───
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeStedInKommune("Innset", null, "Oslo");
      assertEq(r, null,
        "sted: 'Innset' corroborated against 'Oslo' (no hit is in Oslo) is REJECTED, not a wrong guess");
    }

    // ── REJECTED: no corroboration possible at all (neither given) ─────
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeStedInKommune("Innset", null, null);
      assertEq(r, null, "sted: with neither kommunenummer nor kommuneNavn, refuses to guess");
      assertEq(calls.length, 0, "sted: …and never makes a network request to do it");
    }

    // ── REJECTED: type outside the PLACE_TYPE_TIERS allowlist ──────────
    // Even with BOTH a matching kommunenummer and kommuneNavn, a farm
    // (Navnegard) is not an acceptable place type — corroboration is not a
    // license to loosen the type filter.
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      const r = await geocodingService.geocodeStedInKommune("Låven", "5022", "Rennebu");
      assertEq(r, null, "sted: a Navnegard (farm) hit is rejected regardless of kommune corroboration");
    }

    // ── Cache-hit on a second call (no repeated API hammering) ─────────
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      await geocodingService.geocodeStedInKommune("Innset", "5022", null);
      const afterFirst = calls.length;
      assertTrue(afterFirst > 0, "sted: first call made at least one request");
      await geocodingService.geocodeStedInKommune("Innset", "5022", null);
      assertEq(calls.length, afterFirst, "sted: second identical call is served from cache");
    }

    // ── Falls back to unfiltered+corroborated when the knr search is empty ─
    {
      calls.length = 0;
      __clearGeocodeCacheForTesting();
      // A kommunenummer that yields zero Stedsnavn hits at all (not routed by
      // the fake fetch → STEDSNAVN_EMPTY) must still resolve via the
      // unfiltered + kommuneNavn-corroborated path when a name is also given.
      const r = await geocodingService.geocodeStedInKommune("Innset", "9999", "Rennebu");
      assertTrue(r !== null,
        "sted: an empty knr-filtered search still resolves via the unfiltered+name-corroborated fallback");
      if (r) {
        assertTrue(Math.abs(r.lat - 62.72083) < 0.001,
          `sted: …to the same Rennebu Bygdelag (got ${r.lat})`);
      }
    }
  } finally {
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runGeocodingServiceStedTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
