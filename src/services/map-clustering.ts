/**
 * map-clustering.ts — dev-request 2026-07-19-opplevagent-kart-fylke-gardssalg,
 * arbeidspunkt 6 ("Klynging ved tette punkter (Oslo/Bergen)").
 *
 * Pure, DOM-free clustering algorithm shared conceptually by the two
 * multi-marker Leaflet maps (/fylke/:fylke, /kategori/gardssalg). This
 * module exists so the ALGORITHM can be unit-tested directly in Node — this
 * repo's test runner (tests/test.ts) has no headless browser/DOM available
 * (same constraint slice 1 flagged for the Lighthouse criterion). The map
 * pages themselves do NOT import this module at runtime — the actual
 * shipped client code is a hand-written vanilla-JS twin, the MAP_CLUSTER_JS
 * constant in src/routes/experiences-seo.ts, reused VERBATIM by both
 * FYLKE_MAP_INIT_JS and GARDSSALG_MAP_INIT_JS (the same "shared, not
 * copied" discipline already used there for FYLKE_MAP_CSS). Keep this
 * file's algorithm and MAP_CLUSTER_JS's algorithm in sync by hand if either
 * ever changes — tests/test.ts's runMapClusteringTests() proves THIS copy
 * is correct; the kart-12+/kg-12+ assertions in tests/test.ts prove the
 * shipped client copy is present and wired into both map pages' rendered
 * output (not that its runtime output is byte-identical — no
 * browser-execution tooling in this sandbox).
 *
 * No new API round-trip: both call sites feed this function the SAME
 * already-fetched point arrays (ExperienceMapPoint[] / GardssalgProviderMapPoint[])
 * used to build the existing #fylke-map-data / #gardssalg-map-data JSON
 * islands — those islands are UNCHANGED by this feature (still the flat,
 * per-point shape slices 1/2 shipped and their own tests (kart-02/kg-03)
 * still pin) — clustering is purely a client-side *rendering* decision on
 * top of that same data, exactly as the dev-request's requirement 1 allows.
 */

export interface ClusterPoint {
  lat: number;
  lon: number;
  // true = this point is a centroid/kommune (or otherwise non-address)
  // fallback, never a real geocoded address — the SAME honesty flag every
  // individual marker already carries (geo_precision==='kommune' on the
  // fylke map, isApproxGardssalgConfidence() on the gardssalg map).
  approx: boolean;
}

export interface ClusterGroup<T extends ClusterPoint> {
  lat: number;
  lon: number;
  // A cluster's approx flag is well-defined because approx/exact points are
  // NEVER mixed into the same group (see clusterMapPoints below) — this is
  // the precision-honesty invariant surviving clustering (dev-request
  // requirement 3): an approximate point can never be silently absorbed
  // into a cluster that then implies more precision than it has, and a
  // real-address cluster can never silently gain an approximate member.
  approx: boolean;
  members: T[];
}

// ~3km: tight enough that two points in different kommuner essentially
// never merge, loose enough that a genuinely dense cluster of points within
// the same city (the dev-request's own examples, Oslo/Bergen) collapses
// into one bubble instead of a pile of overlapping pins.
export const DEFAULT_CLUSTER_RADIUS_KM = 3;
// A "cluster" of exactly 1 point is just an ordinary point — callers render
// groups below this size as the existing individual marker, unchanged.
export const MIN_CLUSTER_SIZE = 2;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Union-find over one homogeneous (all-approx or all-exact) partition:
// transitively merges any two points within radiusKm of one another.
function clusterPartition<T extends ClusterPoint>(points: T[], radiusKm: number): ClusterGroup<T>[] {
  const n = points.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) parent.push(i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon) <= radiusKm) {
        union(i, j);
      }
    }
  }
  const order: number[] = [];
  const groups = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
      order.push(root);
    }
    groups.get(root)!.push(points[i]);
  }
  return order.map((root) => {
    const members = groups.get(root)!;
    const lat = members.reduce((s, p) => s + p.lat, 0) / members.length;
    const lon = members.reduce((s, p) => s + p.lon, 0) / members.length;
    return { lat, lon, approx: members[0].approx, members };
  });
}

/**
 * Groups nearby points into clusters, NEVER mixing approx and exact points
 * into the same group (partitioned first — see ClusterGroup's doc comment
 * for why). Deterministic for a given input order/radius. Groups with
 * members.length < MIN_CLUSTER_SIZE are ordinary singleton points — callers
 * should render those exactly as before this feature existed; only
 * members.length >= MIN_CLUSTER_SIZE groups are real clusters.
 */
export function clusterMapPoints<T extends ClusterPoint>(
  points: T[],
  radiusKm: number = DEFAULT_CLUSTER_RADIUS_KM
): ClusterGroup<T>[] {
  const exact = points.filter((p) => !p.approx);
  const approx = points.filter((p) => p.approx);
  return [...clusterPartition(exact, radiusKm), ...clusterPartition(approx, radiusKm)];
}
