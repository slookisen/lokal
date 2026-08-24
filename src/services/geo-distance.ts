// ─── Shared geo distance primitives ──────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2a:
// «Konsolider de tre duplikate haversine-implementasjonene til én delt modul.»
//
// Before this file the identical great-circle formula existed three times:
//   • services/geocoding-service.ts   — exported haversineDistanceKm(), used by
//                                       experience-store.ts (OpplevAgent).
//   • services/marketplace-registry.ts— private, unexported haversine() (RFB).
//   • services/matching-engine.ts     — private calculateDistance()/toRad().
//
// Why they were never merged before is documented in geocoding-service.ts:
// marketplace-registry.ts is deliberately rfb-isolated and importing
// geocoding-service (which pulls in database/init's getDb) purely to borrow one
// pure function would have coupled the verticals. THIS module fixes that by
// being what neither of the other two could be: **pure**. No DB, no network, no
// vertical. Everything here is a total function of its arguments, so any
// vertical may import it without dragging state along, and the corridor engine
// (route-geometry.ts) can be unit-tested with zero fixtures.
//
// geocoding-service.ts keeps exporting `haversineDistanceKm` as a re-export so
// the ~10 existing OpplevAgent call sites are untouched; the formula itself now
// lives here once.
//
// Numerical note (CORRECTED — review N3; the first version of this comment got
// both the verdict and the cause wrong):
//
// All three originals used R = 6371 and the same 2·atan2(√a, √(1−a)) haversine.
// geocoding-service.ts's and marketplace-registry.ts's copies ARE bit-identical
// to this one — measured 0.00 % divergence over 200 000 Norway-bbox pairs.
// matching-engine.ts's copy is NOT: 33.59 % of pairs differ, by at most
// 6.821e-13 km (sub-nanometre, ~2.5 ULP).
//
// The cause is NOT `Math.sin(x) ** 2` vs `Math.sin(x) * Math.sin(x)`, which the
// original comment blamed. V8 folds those to the same result — measured
// 0/200 000 divergence. The cause is FLOATING-POINT ASSOCIATIVITY in the
// degrees→radians conversion:
//
//     (deg * Math.PI) / 180        matching-engine.ts
//     deg * (Math.PI / 180)        the other two, and this file
//
// which differ on 19.63 % of inputs across 58-71 °N, because `Math.PI / 180` is
// itself rounded before the multiply. Four toRad calls per haversine is what
// lifts 19.63 % per call to 33.59 % per pair.
//
// Nothing in this codebase reads a distance finer than 0.1 km
// (formatDistanceLabel rounds to one decimal), so no observable behaviour
// moves. route-corridor.test.ts asserts the measured BOUND rather than a
// bit-identity that does not hold.

/** Mean Earth radius in kilometres — the value all three originals used. */
export const EARTH_RADIUS_KM = 6371;

/**
 * Degrees → radians.
 *
 * `deg * (Math.PI / 180)`, matching what geocoding-service.ts and
 * marketplace-registry.ts always did. See the associativity note above before
 * "simplifying" this to `(deg * Math.PI) / 180`.
 */
export function toRadians(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Great-circle (haversine) distance between two WGS84 points, in kilometres.
 *
 * This is the ONE implementation. It is a straight-line ("crow-flies") figure:
 * in Norway that can understate driving distance by an order of magnitude
 * (measured: Molde→Vestnes is 12.8 km apart but 104 km / 118 min to drive), so
 * never present the output of this function to a user as a travel distance.
 */
export function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Kilometres per degree of latitude. Constant everywhere (meridians are great
 * circles), which is why the equirectangular projection below only has to
 * correct the LONGITUDE axis.
 */
export const KM_PER_DEG_LAT = (Math.PI / 180) * EARTH_RADIUS_KM;

/**
 * Kilometres per degree of longitude at a given latitude.
 * At Norway's 58–71°N this ranges from ~59 km/° (Kristiansand) down to ~36 km/°
 * (Nordkapp) — which is exactly why a naive "1 degree ≈ 111 km both axes" bbox
 * over-selects by 2-3× in the north.
 */
export function kmPerDegLng(latDeg: number): number {
  return KM_PER_DEG_LAT * Math.cos(toRadians(latDeg));
}

// ─── Norway coordinate sanity gate ───────────────────────────────────
// Daniel, live sesjon 2026-08-24 (UX-gjennomgang opplevagent.no, punkt 5):
// «Kartet burde være zoomet inn på Norge, og vi burde unngå å ha plasseringer
// utenfor Afrika (mangler sikkert koordinater).»
//
// Two producers on prod carried lat=0/lon=0 — "null island" in the Gulf of
// Guinea, ~5 000 km off the coast of West Africa. Nothing rendered them
// wrongly; the maps faithfully plotted what the DB held. But Leaflet's
// fitBounds() covers the FULL extent of the marker set, so those two points
// alone forced every map that included them to open zoomed out over the
// Atlantic instead of over Norway.
//
// The box below is a plausibility gate, not a precise border: it covers the
// mainland (57.9–71.2 °N, 4.5–31.1 °E), Svalbard (up to ~81 °N / ~35 °E) and
// Jan Mayen (~71 °N / −9 °E) with a little slack on every side. It is
// deliberately coarse — its job is to catch coordinates that CANNOT be
// Norwegian (0/0 from a failed geocode, a swapped lat/lon pair, a foreign
// address), never to adjudicate whether a point is on the right side of a
// fjord.
export const NORWAY_BBOX = { minLat: 57.0, maxLat: 81.5, minLon: -10.0, maxLon: 36.0 } as const;

/**
 * True when (lat, lon) could plausibly be a position in Norway. Rejects
 * non-finite values and 0/0 by construction (lat 0 is far below minLat).
 * Callers use this to decide whether a stored coordinate is trustworthy
 * enough to plot — a row that fails it keeps every other surface it has
 * (card, profile, search); only its map marker is withheld until the geocode
 * is fixed.
 */
export function isPlausibleNorwayCoord(lat: number | null | undefined, lon: number | null | undefined): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return (
    lat >= NORWAY_BBOX.minLat && lat <= NORWAY_BBOX.maxLat &&
    lon >= NORWAY_BBOX.minLon && lon <= NORWAY_BBOX.maxLon
  );
}
