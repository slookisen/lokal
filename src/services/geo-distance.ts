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
// Numerical note: all three originals used R = 6371 km and the same
// atan2/asin-equivalent haversine, so consolidating is behaviour-preserving to
// the last bit for the two atan2 variants. matching-engine.ts's variant used
// `** 2` instead of `x * x` — identical IEEE-754 result for a finite double —
// and the same `2 * atan2(√a, √(1-a))`, so it too is bit-identical.

/** Mean Earth radius in kilometres — the value all three originals used. */
export const EARTH_RADIUS_KM = 6371;

/** Degrees → radians. */
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
