// ─── Route corridor geometry (pure) ──────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2b.
//
// Everything here is a total function of its arguments: no DB, no network, no
// clock, no vertical. That is deliberate — the corridor maths is the part that
// has to be provably right ("3 km off your route" is a claim we make to a
// traveller), so it must be testable without fixtures. route-corridor-service.ts
// does the impure half (geocode, fetch polyline, query SQLite).
//
// ── The algorithm, and why it is this one ────────────────────────────
// Benchmarked on the real Oslo→Bodø driving route (1 181.7 km, 33 246
// coordinates) against 2 000 POIs, Node + SQLite:
//
//   naive point-to-segment over full geometry   2 390 ms/query
//   simplify to ~500 m, then the same maths         3.6 ms/query   (670×)
//
// and the simplified run returns the IDENTICAL hit set. Simplification costs
// 10-21 ms once, so it is cached alongside the polyline. Two rejected
// alternatives, both measured:
//   • R*Tree — SLOWER at this scale (1.87 ms vs 1.11 ms). SQLite's virtual
//     table overhead dominates when the candidate set is ~2 000 rows. Revisit
//     above ~50 000. No SpatiaLite, no PostGIS.
//   • Sampling the route every N km and doing radius searches — UNDER-detects
//     (23 hits vs 26 at 10 km spacing) because a POI can sit inside the
//     corridor while being outside every sample disc. Not a shortcut, a bug.
//
// ── Why point-to-segment and not point-to-vertex ─────────────────────
// The cross-track distance to a SEGMENT yields the along-track distance in the
// same projection, for free — the same dot product that clamps t ∈ [0,1] gives
// the position along the segment. So `detour_km` (how far off the route) and
// `along_km` (how far into the trip) come out of one pass, and travel-order
// sorting costs nothing. Point-to-vertex would need a second pass and would
// overestimate detour on long straight stretches.
//
// ── Projection ───────────────────────────────────────────────────────
// Equirectangular about the route's mid-latitude. Norway spans 58–71°N, where
// km-per-degree-longitude varies from ~59 to ~36, so the cos(lat) correction is
// essential — but a single mid-latitude cos() is sufficient at these distances
// (the residual error over a 1 200 km route is well under the 20 km corridor
// half-width we are testing against, and far under the honesty floor set by the
// data itself). Working in a local planar frame is what makes the maths a
// handful of multiplies instead of a spherical solve per segment.
//
// ── What detour_km IS NOT ────────────────────────────────────────────
// It is a straight-line offset from the driving line, NOT a driving detour.
// Measured in Norway: Molde→Vestnes is 12.8 km apart and 104 km / 118 min to
// drive; Lavik→Ytre Oppedal is 4.9 km apart and 72 min (ferry). Real drive-time
// ranking is Fase 4. Every type here therefore carries an OPTIONAL
// `detour_minutes` slot so Fase 4 can fill it without a breaking change, and
// the UI copy must never call detour_km a driving distance.

import { haversineDistanceKm, KM_PER_DEG_LAT, kmPerDegLng } from "./geo-distance";

/** A WGS84 point. `lng`, not `lon` — matches the RFB column naming. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** A route polyline in travel order, from origin to destination. */
export type Polyline = LatLng[];

/**
 * A planar frame for one route: kilometres east/north of an origin, using a
 * single cos() taken at the route's mid-latitude.
 */
export interface Projection {
  /** Latitude the longitude scale was computed at. */
  refLat: number;
  refLng: number;
  kmPerLng: number;
}

/** A point projected into a {@link Projection}: kilometres east / north. */
export interface XY {
  x: number;
  y: number;
}

/**
 * The corridor geometry of one candidate relative to one route.
 * `detourMinutes` is deliberately declared here and left undefined by this
 * module: Fase 4 fills it from a routing matrix call, and callers that already
 * read the shape keep compiling.
 */
export interface CorridorHit {
  /** Straight-line kilometres from the route line. NOT a driving distance. */
  detourKm: number;
  /** Kilometres travelled along the route before the nearest point. */
  alongKm: number;
  /** Fase 4: real driving minutes off-route. Never set by this module. */
  detourMinutes?: number;
}

// ── Projection ───────────────────────────────────────────────────────

/**
 * Build the planar frame for a polyline. Origin is the first point; the
 * longitude scale is taken at the midpoint of the latitude RANGE (not the mean
 * of all vertices, which would be dragged by wherever the route has the most
 * coordinates — city stretches are densely sampled, mountain stretches are not).
 */
export function projectionForRoute(route: Polyline): Projection {
  if (route.length === 0) {
    return { refLat: 0, refLng: 0, kmPerLng: kmPerDegLng(0) };
  }
  let minLat = route[0].lat;
  let maxLat = route[0].lat;
  for (const p of route) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const refLat = (minLat + maxLat) / 2;
  return { refLat, refLng: route[0].lng, kmPerLng: kmPerDegLng(refLat) };
}

/** Project one point into the frame. Cheap: two multiplies. */
export function project(p: LatLng, proj: Projection): XY {
  return {
    x: (p.lng - proj.refLng) * proj.kmPerLng,
    y: (p.lat - proj.refLat) * KM_PER_DEG_LAT,
  };
}

// ── Douglas-Peucker simplification ───────────────────────────────────

/**
 * Perpendicular distance from `p` to the infinite line through `a`–`b`, in the
 * SAME units as the inputs (degrees in, degrees out) — used only as a relative
 * measure inside the simplifier, so unit-consistency is all that matters.
 */
function perpendicularDistanceDeg(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.lng - a.lng;
    const ey = p.lat - a.lat;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const cross = Math.abs(dx * (a.lat - p.lat) - (a.lng - p.lng) * dy);
  return cross / Math.sqrt(len2);
}

/**
 * Tolerance that corresponds to roughly `metres` of positional error.
 * ~0.005° ≈ 500 m, the value the benchmark used to go from 33 246 points to
 * 349 with an identical hit set.
 */
export function toleranceForMetres(metres: number): number {
  return metres / (KM_PER_DEG_LAT * 1000);
}

/** ~500 m — the benchmarked default. */
export const DEFAULT_SIMPLIFY_TOLERANCE = toleranceForMetres(500);

/**
 * Douglas-Peucker, iterative (an explicit stack, not recursion): a 33 246-point
 * route is deep enough that the recursive form can blow the call stack on a
 * pathological split, and this runs inside a request.
 *
 * Endpoints are always preserved, so the simplified route still starts at the
 * origin and ends at the destination — which matters because along_km is
 * measured from index 0.
 */
export function simplifyPolyline(route: Polyline, tolerance = DEFAULT_SIMPLIFY_TOLERANCE): Polyline {
  const n = route.length;
  if (n <= 2) return route.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistanceDeg(route[i], route[first], route[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index > first) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Polyline = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(route[i]);
  return out;
}

// ── The prepared route ───────────────────────────────────────────────

/**
 * A route with everything precomputed that does not depend on the candidate:
 * the simplified polyline, its projection, the projected vertices, and the
 * cumulative along-track distance at each vertex.
 *
 * Build ONCE per route and reuse across every candidate (and across requests —
 * route-corridor-service.ts caches it with the polyline).
 */
export interface PreparedRoute {
  /** Simplified polyline, travel order preserved. */
  points: Polyline;
  projection: Projection;
  /** Projected vertices, parallel to `points`. */
  xy: XY[];
  /** cumulative[i] = along-track km from the start to vertex i. */
  cumulative: number[];
  /** Total length of the SIMPLIFIED line, in km. */
  lengthKm: number;
  /** Bounding box of the polyline in degrees, pre-expansion. */
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  /** How many vertices the input had, before simplification. */
  sourcePointCount: number;
}

export function prepareRoute(route: Polyline, tolerance = DEFAULT_SIMPLIFY_TOLERANCE): PreparedRoute {
  const points = simplifyPolyline(route, tolerance);
  const projection = projectionForRoute(points.length > 0 ? points : route);
  const xy = points.map((p) => project(p, projection));

  // Cumulative distance uses the TRUE haversine between successive simplified
  // vertices, not the planar approximation, so along_km stays comparable to the
  // km figures shown elsewhere on the site.
  const cumulative: number[] = new Array(points.length);
  cumulative[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cumulative[i] =
      cumulative[i - 1] +
      haversineDistanceKm(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return {
    points,
    projection,
    xy,
    cumulative,
    lengthKm: points.length > 0 ? cumulative[points.length - 1] : 0,
    bbox: points.length > 0
      ? { minLat, maxLat, minLng, maxLng }
      : { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 },
    sourcePointCount: route.length,
  };
}

/**
 * The SQL pre-filter box: the route's bbox grown by `maxDetourKm` on every
 * side. Anything outside this cannot possibly be within maxDetourKm of the
 * line, so SQLite can discard it with an index-friendly BETWEEN before a single
 * JS multiply happens.
 *
 * The longitude padding is computed at the latitude where degrees of longitude
 * are SHORTEST (the pole-most edge of the box), so the box is never too narrow
 * anywhere along it — the classic bug is using the mid-latitude and clipping
 * candidates off the northern end of a long north-south route like Oslo→Bodø.
 */
export function corridorBoundingBox(
  prepared: PreparedRoute,
  maxDetourKm: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const b = prepared.bbox;
  const latPad = maxDetourKm / KM_PER_DEG_LAT;
  const worstLat = Math.max(Math.abs(b.minLat), Math.abs(b.maxLat));
  const lngPad = maxDetourKm / Math.max(kmPerDegLng(Math.min(worstLat, 89.9)), 1e-6);
  return {
    minLat: b.minLat - latPad,
    maxLat: b.maxLat + latPad,
    minLng: b.minLng - lngPad,
    maxLng: b.maxLng + lngPad,
  };
}

// ── The corridor measurement ─────────────────────────────────────────

/**
 * Cross-track distance from `point` to the prepared route, plus the along-track
 * distance of the nearest point on the line. ONE pass over the segments; both
 * numbers fall out of the same projection.
 *
 * Returns null only for a degenerate (empty) route.
 */
export function measureAgainstRoute(point: LatLng, prepared: PreparedRoute): CorridorHit | null {
  const n = prepared.xy.length;
  if (n === 0) return null;

  const p = project(point, prepared.projection);

  if (n === 1) {
    const dx = p.x - prepared.xy[0].x;
    const dy = p.y - prepared.xy[0].y;
    return { detourKm: Math.sqrt(dx * dx + dy * dy), alongKm: 0 };
  }

  let bestDist2 = Infinity;
  let bestAlong = 0;

  for (let i = 0; i < n - 1; i++) {
    const a = prepared.xy[i];
    const b = prepared.xy[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const wx = p.x - a.x;
    const wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;

    // t is the projection parameter along the segment, clamped so the nearest
    // point never runs off either end — this is what makes it point-to-SEGMENT
    // and what makes `t` reusable as the along-track fraction.
    let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const cx = a.x + t * vx - p.x;
    const cy = a.y + t * vy - p.y;
    const d2 = cx * cx + cy * cy;

    if (d2 < bestDist2) {
      bestDist2 = d2;
      // Free of charge: the same t, applied to the cumulative table.
      const segLen = prepared.cumulative[i + 1] - prepared.cumulative[i];
      bestAlong = prepared.cumulative[i] + t * segLen;
    }
  }

  return { detourKm: Math.sqrt(bestDist2), alongKm: bestAlong };
}

// ── Clustering / spacing ─────────────────────────────────────────────

/**
 * Fase 2d. A greedy single pass over an ALONG-SORTED list that enforces:
 *   • at most `maxPerGroup` suggestions sharing a `groupKey` (kommune), and
 *   • at least `minSeparationKm` of along-track distance between consecutive
 *     kept suggestions.
 *
 * Why greedy-in-travel-order rather than MMR-with-scores: the traveller reads
 * the list as an itinerary. Dropping an earlier stop because a later one scored
 * higher would reorder their day for a reason they cannot see. Keeping the
 * first of each cluster is the behaviour a map user expects, and it is stable —
 * the same route always yields the same list.
 *
 * Callers that want the BEST rather than the FIRST of each cluster should sort
 * within an along-track bucket before calling; the separation rule is applied
 * to whatever order it is given.
 *
 * `groupKey` returning null/"" means "ungrouped" — such items are never counted
 * against a kommune quota (we must not let 40 rows with an unknown kommune all
 * collapse into one bucket).
 */
export function spaceOutAlongRoute<T>(
  items: T[],
  opts: {
    alongKm: (item: T) => number;
    groupKey: (item: T) => string | null | undefined;
    maxPerGroup: number;
    minSeparationKm: number;
  },
): T[] {
  const kept: T[] = [];
  const groupCount = new Map<string, number>();
  let lastAlong = -Infinity;

  for (const item of items) {
    const along = opts.alongKm(item);
    if (along - lastAlong < opts.minSeparationKm) continue;

    const raw = opts.groupKey(item);
    const key = raw ? String(raw).trim().toLowerCase() : "";
    if (key) {
      const seen = groupCount.get(key) || 0;
      if (seen >= opts.maxPerGroup) continue;
      groupCount.set(key, seen + 1);
    }

    kept.push(item);
    lastAlong = along;
  }

  return kept;
}
