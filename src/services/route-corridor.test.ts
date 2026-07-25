/**
 * route-corridor.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2 (+ 2a, 5a/5b).
 *
 * Covers the corridor engine end to end:
 *   2a  services/geo-distance.ts — the ONE haversine, and that all three former
 *       call sites still agree with it to the bit.
 *   2b  services/route-geometry.ts — Douglas-Peucker, the equirectangular
 *       projection, point-to-segment giving detour + along in one pass, and the
 *       bbox prefilter.
 *       services/route-corridor-service.ts — provider seam, polyline cache,
 *       catalogue loaders, and THE HONESTY RULE.
 *   2d  clustering / minimum along-track separation.
 *   5   the drink taxonomy reaching parseNaturalQuery.
 *
 * Assertion ids:
 *   h1-h5    haversine: consolidation is behaviour-preserving
 *   s1-s6    simplify: endpoints kept, tolerance respected, hit set unchanged
 *   p1-p4    projection + bbox: the prefilter never clips a real neighbour
 *   m1-m8    measureAgainstRoute: detour AND along from one pass, clamped ends
 *   c1-c6    spaceOutAlongRoute: per-place cap + minimum separation
 *   a1-a9    THE ALLOW-LIST — the assertions that matter most
 *   g1-g5    approximate grouping: no numbers, ordered by the place
 *   r1-r7    routing providers: mapbox/osrm shape, no-token degradation
 *   k1-k4    polyline cache: hit, TTL expiry, key normalisation
 *   d1-d6    drink taxonomy
 *
 * No network: the RouteProvider seam is injected in every case, and the
 * geocoder's fetch is stubbed via __setGeocodingFetchForTesting. The RFB DB is
 * an in-memory instance running the REAL production schema, so the columns the
 * loaders read are the ones that ship.
 *
 * Exported runRouteCorridorTests({log}) -> TestSummary; wired into tests/test.ts.
 * Standalone: npx tsx src/services/route-corridor.test.ts
 */

import Database from "better-sqlite3";
import * as initMod from "../database/init";

import { haversineDistanceKm, kmPerDegLng, KM_PER_DEG_LAT } from "./geo-distance";
import {
  simplifyPolyline,
  prepareRoute,
  projectionForRoute,
  corridorBoundingBox,
  measureAgainstRoute,
  spaceOutAlongRoute,
  toleranceForMetres,
  DEFAULT_SIMPLIFY_TOLERANCE,
  type Polyline,
  type LatLng,
} from "./route-geometry";
import {
  corridorSearch,
  resolveRouteProvider,
  mapboxProvider,
  osrmProvider,
  straightLineProvider,
  getPreparedRoute,
  __clearRouteCacheForTesting,
  isCorridorPrecise,
  precisionFromGeocodeConfidence,
  buildApproximateGroups,
  loadRfbCandidates,
  type RouteProvider,
  type CorridorCandidate,
} from "./route-corridor-service";
import { marketplaceRegistry } from "./marketplace-registry";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "./geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// ── Fixtures ─────────────────────────────────────────────────────────

/**
 * A synthetic but realistically-shaped Norwegian route: Oslo → Trondheim-ish,
 * heading north-north-west with a wiggle, densified to ~4 000 points so the
 * simplifier has real work to do. Generated rather than captured so the file
 * stays reviewable and the test stays deterministic.
 */
function syntheticRoute(points = 4000): Polyline {
  const out: Polyline = [];
  const fromLat = 59.9139, fromLng = 10.7522;   // Oslo
  const toLat = 63.4305, toLng = 10.3951;       // Trondheim
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // A slow S-curve plus a small high-frequency jitter — the jitter is exactly
    // what Douglas-Peucker is supposed to throw away.
    const wobble = Math.sin(t * Math.PI * 3) * 0.55;
    const jitter = Math.sin(t * Math.PI * 400) * 0.0015;
    out.push({
      lat: fromLat + (toLat - fromLat) * t,
      lng: fromLng + (toLng - fromLng) * t + wobble + jitter,
    });
  }
  return out;
}

/** Straight north-south leg, 1° of latitude ≈ 111.19 km. Easy to reason about. */
function straightNorthRoute(): Polyline {
  const out: Polyline = [];
  for (let i = 0; i <= 100; i++) out.push({ lat: 59 + i / 100, lng: 10 });
  return out;
}

interface SeedAgent {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  precision: string | null;
  categories?: string[];
}

function seedAgents(db: Database.Database, agents: SeedAgent[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at, geo_precision)
    VALUES (?, ?, ?, 'test', ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, ?, '[]', '[]', '{}', '["no"]',
            0.6, 1, 0, 0, 0, 0, datetime('now'), datetime('now'), ?)
  `);
  for (const a of agents) {
    stmt.run(
      a.id, a.name, "Lokal produsent", `${a.id}@example.no`, `https://${a.id}.example.no`,
      "key-" + a.id, a.lat, a.lng, a.city,
      JSON.stringify(a.categories || ["vegetables"]), a.precision,
    );
  }
}

/** A provider that returns a fixed polyline and counts how often it was asked. */
function stubProvider(polyline: Polyline, kind: "road" | "straight_line" = "road") {
  let calls = 0;
  const provider: RouteProvider = {
    id: "stub",
    kind,
    async fetchRoute() {
      calls += 1;
      return {
        polyline,
        distanceKm: 500,
        durationMinutes: 420,
        provider: "stub",
        kind,
      };
    },
  };
  return { provider, calls: () => calls };
}

/**
 * Geocoder stub: resolves a small gazetteer offline. Installed by replacing the
 * fetch the real geocodingService uses, so the Fase-0 hardening (object-type
 * allow-list, ambiguity refusal) still runs — we are testing through it, not
 * around it.
 *
 * Oslo / Trondheim are in geocoding-service's hardcoded MAJOR_CITIES table and
 * never reach fetch at all; the stub exists so anything else 404s honestly.
 */
function installOfflineGeocoder(): void {
  __setGeocodingFetchForTesting((async () =>
    ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();
}

// ── The suite ────────────────────────────────────────────────────────

export async function runRouteCorridorTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function ok(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function eq(actual: unknown, expected: unknown, label: string): void {
    ok(JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
  function near(actual: number, expected: number, tol: number, label: string): void {
    ok(Math.abs(actual - expected) <= tol,
      `${label} (expected ${expected} ±${tol}, got ${actual})`);
  }

  const prevDb = (initMod as any).__peekDbForTesting?.();
  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  (initMod as any).__setDbForTesting(db as any);
  (initMod as any).__initSchemaForTesting(db as any);

  const prevLog = console.log;

  try {
    installOfflineGeocoder();
    __clearRouteCacheForTesting();

    // ══ h: the consolidated haversine ═════════════════════════════════
    //
    // Rather than pinning magic numbers (which only prove the formula does not
    // DRIFT), the three pre-merge implementations are reproduced verbatim below
    // and compared to the survivor over a grid spanning Norway. That is the
    // actual claim the Fase-2a commit makes: consolidating changed nothing.
    {
      // geocoding-service.ts:290, verbatim as it stood before the merge.
      const original_geocodingService = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        const R = 6371;
        const toRad = (deg: number) => deg * (Math.PI / 180);
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      // matching-engine.ts:342, verbatim — note `** 2` where the others use x*x.
      const original_matchingEngine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        const R = 6371;
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
      };

      let mismatchGeocoding = 0;
      let mismatchMatching = 0;
      let maxAbsDiffKm = 0;
      let samples = 0;
      // 58-71 °N, 5-30 °E — the country, plus the long diagonals.
      for (let lat1 = 58; lat1 <= 71; lat1 += 0.5) {
        for (let lng1 = 5; lng1 <= 30; lng1 += 1) {
          for (let lat2 = 58; lat2 <= 71; lat2 += 1.3) {
            for (let lng2 = 5; lng2 <= 30; lng2 += 2.1) {
              const merged = haversineDistanceKm(lat1, lng1, lat2, lng2);
              if (merged !== original_geocodingService(lat1, lng1, lat2, lng2)) mismatchGeocoding++;
              const me = original_matchingEngine(lat1, lng1, lat2, lng2);
              if (merged !== me) {
                mismatchMatching++;
                maxAbsDiffKm = Math.max(maxAbsDiffKm, Math.abs(merged - me));
              }
              samples++;
            }
          }
        }
      }
      ok(samples > 50000, `h0: the grid is big enough to be meaningful (${samples} pairs)`);
      eq(mismatchGeocoding, 0,
        "h1: bit-identical to geocoding-service.ts's pre-merge implementation");
      // marketplace-registry.ts's private copy was character-for-character the
      // same as geocoding-service.ts's, so h1 covers it; it is now an import
      // alias and cannot diverge by construction.

      // matching-engine.ts is the ONE that is not bit-identical, and it is
      // worth being precise about rather than hand-waving: it wrote
      // `Math.sin(x) ** 2` where the other two wrote `Math.sin(x) * Math.sin(x)`.
      // `**` is Math.pow semantics, which V8 does not guarantee to equal a
      // multiplication in the last bit — measured, it differs on 6.5 % of pairs.
      // The magnitude is the whole story: at most ~7e-13 km, i.e. under a
      // NANOMETRE, ~2.5 ULP. Nothing in this codebase reads distance below
      // 0.1 km (formatDistanceLabel rounds to one decimal), so this is
      // behaviour-preserving in every sense that can be observed — but the
      // commit message should not have claimed "to the bit", and this assertion
      // is what keeps the claim honest.
      ok(maxAbsDiffKm < 1e-9,
        `h2: matching-engine's \`** 2\` differed on ${mismatchMatching}/${samples} pairs, by at most ` +
        `${maxAbsDiffKm.toExponential(2)} km (sub-nanometre, ~2 ULP) — below every rounding this codebase does`);

      eq(haversineDistanceKm(59, 10, 59, 10), 0, "h3: zero distance for identical points");
      near(haversineDistanceKm(59, 10, 60, 10), 111.19, 0.02,
        "h4: one degree of latitude is ~111.19 km anywhere");
      near(KM_PER_DEG_LAT, 111.19, 0.02, "h5: KM_PER_DEG_LAT matches the measured degree");
      // The cos(lat) correction that makes the projection usable in the north:
      // a degree of longitude is nearly twice as long at Kristiansand as at
      // Nordkapp. Getting this wrong is what makes a naive bbox over-select 2-3×.
      near(kmPerDegLng(58), 58.93, 0.05, "h6: ~59 km per degree of longitude in the south");
      near(kmPerDegLng(71), 36.20, 0.05, "h7: ~36 km per degree of longitude at Nordkapp");
    }

    // ══ s: Douglas-Peucker ════════════════════════════════════════════
    {
      const route = syntheticRoute(4000);
      const simplified = simplifyPolyline(route, DEFAULT_SIMPLIFY_TOLERANCE);

      ok(simplified.length < route.length / 5,
        `s1: ~500 m simplification cuts the route hard (${route.length} → ${simplified.length})`);
      eq(simplified[0], route[0], "s2: the origin vertex survives");
      eq(simplified[simplified.length - 1], route[route.length - 1],
        "s3: the destination vertex survives");

      // The benchmark's central claim, stated as the invariant that actually
      // holds: simplifying to ~500 m perturbs the measured detour by at most
      // ~500 m, so the 20 km corridor selects the same set EXCEPT for
      // candidates sitting within the tolerance of the boundary — where "in or
      // out" was never a meaningful distinction anyway.
      //
      // (The dev-request's "identical hit count" was measured on a real road
      // polyline with real POIs; on an adversarial synthetic route with probes
      // deliberately swept across the 20 km line, one boundary-straddling probe
      // does flip. Asserting the bounded ERROR rather than a hit count is the
      // claim that is true in general, and it is the stronger one.)
      const full = prepareRoute(route, 0);           // tolerance 0 = keep everything
      const cut = prepareRoute(route, DEFAULT_SIMPLIFY_TOLERANCE);
      let maxErrKm = 0;
      let flips = 0;
      let flippedNearBoundary = 0;
      for (let i = 0; i < 400; i++) {
        const t = i / 399;
        const p: LatLng = {
          lat: 59.9 + t * 3.5 + ((i % 7) - 3) * 0.06,
          lng: 10.75 + Math.sin(t * Math.PI * 3) * 0.55 + ((i % 5) - 2) * 0.12,
        };
        const a = measureAgainstRoute(p, full)!;
        const b = measureAgainstRoute(p, cut)!;
        maxErrKm = Math.max(maxErrKm, Math.abs(a.detourKm - b.detourKm));
        if ((a.detourKm <= 20) !== (b.detourKm <= 20)) {
          flips++;
          if (Math.abs(a.detourKm - 20) < 1) flippedNearBoundary++;
        }
      }
      ok(maxErrKm < 1.0,
        `s4: simplification perturbs the detour by at most ${(maxErrKm * 1000).toFixed(0)} m over 400 probes`);
      eq(flips, flippedNearBoundary,
        `s4b: every membership flip (${flips}) was a probe within 1 km of the corridor edge — none moved a real neighbour`);

      const coarse = simplifyPolyline(route, toleranceForMetres(5000));
      ok(coarse.length <= simplified.length,
        "s5: a coarser tolerance never keeps MORE points");
      eq(simplifyPolyline([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }]).length, 2,
        "s6: a two-point line is returned untouched");
    }

    // ══ p: projection + bbox prefilter ════════════════════════════════
    {
      const route = straightNorthRoute();
      const prepared = prepareRoute(route, 0);
      const proj = projectionForRoute(route);
      near(proj.refLat, 59.5, 0.001, "p1: the projection is anchored at the route's mid-latitude");
      near(proj.kmPerLng, kmPerDegLng(59.5), 1e-9, "p2: the longitude scale uses that latitude");

      const box = corridorBoundingBox(prepared, 20);
      ok(box.minLat < 59 && box.maxLat > 60, "p3: the bbox is padded north and south");
      // The trap this guards: padding longitude at the MID latitude clips
      // candidates off the pole-most end, where degrees of longitude are
      // shortest. The pad must be wide enough for the WORST latitude in the box.
      const padKmAtWorst = (box.maxLng - 10) * kmPerDegLng(60);
      ok(padKmAtWorst >= 20,
        `p4: the longitude pad still covers 20 km at the route's northernmost point (${padKmAtWorst.toFixed(1)} km)`);
    }

    // ══ m: point-to-segment gives detour AND along in one pass ════════
    {
      const prepared = prepareRoute(straightNorthRoute(), 0);

      // A point due east of the 59.5 mark: detour is pure longitude, along is
      // pure latitude — the two axes are independent, so both can be checked.
      const east: LatLng = { lat: 59.5, lng: 10 + 10 / kmPerDegLng(59.5) };
      const hit = measureAgainstRoute(east, prepared)!;
      near(hit.detourKm, 10, 0.15, "m1: cross-track distance is the perpendicular offset");
      near(hit.alongKm, 111.19 * 0.5, 0.5, "m2: along-track distance falls out of the same pass");

      // On the line → zero detour, along = position.
      const on = measureAgainstRoute({ lat: 59.25, lng: 10 }, prepared)!;
      near(on.detourKm, 0, 0.01, "m3: a point on the route has zero detour");
      near(on.alongKm, 111.19 * 0.25, 0.4, "m4: …and its along distance is its position");

      // Past the end: t clamps to 1, so along saturates at the route length
      // rather than running off — this is what makes it point-to-SEGMENT.
      const past = measureAgainstRoute({ lat: 61, lng: 10 }, prepared)!;
      near(past.alongKm, prepared.lengthKm, 0.01, "m5: beyond the destination, along clamps to the route length");
      near(past.detourKm, 111.19, 0.5, "m6: …and the detour is the distance to the endpoint, not to an extended line");

      const before = measureAgainstRoute({ lat: 58, lng: 10 }, prepared)!;
      near(before.alongKm, 0, 0.01, "m7: before the origin, along clamps to zero");

      eq(measureAgainstRoute({ lat: 59, lng: 10 }, prepareRoute([], 0)), null,
        "m8: a degenerate route measures nothing rather than throwing");
    }

    // ══ c: clustering / spacing (Fase 2d) ═════════════════════════════
    {
      const items = [
        { n: "a", along: 0,   place: "Hamar" },
        { n: "b", along: 2,   place: "Hamar" },
        { n: "c", along: 3,   place: "Hamar" },
        { n: "d", along: 30,  place: "Hamar" },
        { n: "e", along: 60,  place: "Hamar" },
        { n: "f", along: 90,  place: "Hamar" },
        { n: "g", along: 120, place: "Lillehammer" },
      ];
      const kept = spaceOutAlongRoute(items, {
        alongKm: (i) => i.along,
        groupKey: (i) => i.place,
        maxPerGroup: 3,
        minSeparationKm: 25,
      });
      eq(kept.map((k) => k.n), ["a", "d", "e", "g"],
        "c1: 25 km separation drops the cluster, the kommune cap drops the 4th Hamar row");

      const hamar = kept.filter((k) => k.place === "Hamar").length;
      ok(hamar <= 3, "c2: never more than maxPerGroup from one place");
      for (let i = 1; i < kept.length; i++) {
        ok(kept[i].along - kept[i - 1].along >= 25,
          `c3: consecutive suggestions are ≥25 km apart (${kept[i - 1].n}→${kept[i].n})`);
      }

      // A null group key must NOT collapse into one bucket — 36.8 % of RFB
      // producers have no usable place string, and quota-ing them together
      // would silently hide all but three of them.
      const unplaced = Array.from({ length: 8 }, (_, i) => ({ n: `u${i}`, along: i * 40, place: null }));
      const keptUnplaced = spaceOutAlongRoute(unplaced, {
        alongKm: (i) => i.along,
        groupKey: (i) => i.place,
        maxPerGroup: 3,
        minSeparationKm: 25,
      });
      eq(keptUnplaced.length, 8, "c4: rows with no place are not counted against any quota");

      eq(spaceOutAlongRoute([], { alongKm: () => 0, groupKey: () => null, maxPerGroup: 3, minSeparationKm: 25 }),
        [], "c5: an empty list stays empty");

      const noSpacing = spaceOutAlongRoute(items, {
        alongKm: (i) => i.along, groupKey: () => null, maxPerGroup: 99, minSeparationKm: 0,
      });
      eq(noSpacing.length, items.length, "c6: with both limits off, nothing is dropped");
    }

    // ══ a: THE ALLOW-LIST ═════════════════════════════════════════════
    //
    // The assertions this whole slice hangs on. A deny-list of {city,kommune}
    // would pass a1 and a2 and FAIL a3 — which is the exact bug the reviewer
    // flagged, and the reason the rule is written as an allow-list.
    {
      eq(isCorridorPrecise("address"), true, "a1: 'address' is precise");
      eq(isCorridorPrecise("kommune"), false, "a2: a kommune centroid is not precise");
      eq(isCorridorPrecise(null), false,
        "a3: NULL provenance is NOT precise — the 948-row trap a deny-list would walk into");
      eq(isCorridorPrecise("city"), false, "a4: a city centroid is not precise");
      eq(isCorridorPrecise("postal"), false, "a5: a postal point is not precise");
      eq(isCorridorPrecise("Address"), false, "a6: the check is exact, not case-folded or fuzzy");

      // …and through the real search, against the real schema.
      const route = straightNorthRoute();
      const { provider } = stubProvider(route);
      seedAgents(db, [
        { id: "p-exact",  name: "Nøyaktig Gård",  city: "Ringsaker", lat: 59.30, lng: 10.02, precision: "address" },
        { id: "p-exact2", name: "Nøyaktig To",    city: "Gjøvik",    lat: 59.80, lng: 10.03, precision: "address" },
        { id: "p-null",   name: "Ukjent Gård",    city: "Ringsaker", lat: 59.40, lng: 10.02, precision: null },
        { id: "p-komm",   name: "Sentroid Gård",  city: "Ringsaker", lat: 59.50, lng: 10.02, precision: "kommune" },
        { id: "p-far",    name: "Langt Unna",     city: "Bergen",    lat: 59.50, lng: 5.30,  precision: "address" },
      ]);

      __clearRouteCacheForTesting();
      const r = await corridorSearch({
        from: "Oslo", to: "Trondheim", provider, rfbDb: db,
        maxDetourKm: 20, minSeparationKm: 0, sources: ["rfb"],
      });

      eq(r.ok, true, "a7: the search succeeds");
      const ids = r.stops.map((s) => s.id);
      eq(ids, ["p-exact", "p-exact2"],
        "a8: ONLY address-precision rows enter the travel-ordered list");
      ok(!ids.includes("p-null") && !ids.includes("p-komm"),
        "a9: a NULL-provenance row and a kommune centroid are both kept out of the corridor maths");
      ok(r.stops.every((s) => typeof s.alongKm === "number" && typeof s.detourKm === "number"),
        "a10: every listed stop carries both numbers");
      ok(r.stops[0].alongKm < r.stops[1].alongKm,
        "a11: the list is in travel order, not score order");
      ok(!ids.includes("p-far"), "a12: the bbox prefilter excludes a producer 300 km off-route");

      // …and they surface, honestly, in the second bucket.
      const approxIds = r.approximate.flatMap((g) => g.items.map((i) => i.id));
      ok(approxIds.includes("p-null") && approxIds.includes("p-komm"),
        "a13: the imprecise rows are still SHOWN — in the approximate bucket");
      ok(r.approximate.every((g) => g.items.every((i) => !("detourKm" in i))),
        "a14: no approximate item carries a detour number at all");
      ok(r.approximate.every((g) => g.items.every((i) => i.label === null || !/\d/.test(i.label))),
        "a15: no approximate item's label contains a digit");
    }

    // ══ g: approximate grouping ═══════════════════════════════════════
    {
      const mk = (id: string, place: string | null): CorridorCandidate => ({
        id, source: "rfb", name: `Gård ${id}`, lat: 60, lng: 10,
        precision: null, place, categories: [], url: "https://example.no",
      });
      const groups = buildApproximateGroups([
        { candidate: mk("x", "Lillehammer"), alongKm: 200 },
        { candidate: mk("y", "Hamar"), alongKm: 120 },
        { candidate: mk("z", "Hamar"), alongKm: 124 },
        { candidate: mk("w", null), alongKm: 50 },
      ], 3);

      eq(groups.map((g) => g.place), ["Hamar", "Lillehammer"],
        "g1: groups are ordered by the PLACE's position along the route");
      eq(groups[0].items.length, 2, "g2: members of one place are collected together");
      near(groups[0].placeAlongKm, 122, 0.01, "g3: the place's position is the mean of its members' centroids");
      ok(!groups.some((g) => g.items.some((i) => i.id === "w")),
        "g4: a row with no place is dropped rather than grouped under a made-up heading");

      const capped = buildApproximateGroups(
        Array.from({ length: 9 }, (_, i) => ({ candidate: mk(`c${i}`, "Hamar"), alongKm: 100 })), 3);
      eq(capped[0].items.length, 3, "g5: the per-place cap applies to the approximate bucket too");
    }

    // ══ r: routing providers ══════════════════════════════════════════
    {
      // Mapbox: correct URL shape, GeoJSON [lng,lat] decoded the right way
      // round, and the token never appearing anywhere but the query string.
      let seenUrl = "";
      const fakeFetch = (async (url: any) => {
        seenUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            routes: [{
              distance: 485200, duration: 26900,
              geometry: { type: "LineString", coordinates: [[10.7522, 59.9139], [10.3951, 63.4305]] },
            }],
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const mb = mapboxProvider("TEST-TOKEN-NOT-REAL", fakeFetch);
      const mbRoute = await mb.fetchRoute({ lat: 59.9139, lng: 10.7522 }, { lat: 63.4305, lng: 10.3951 });
      ok(/api\.mapbox\.com\/directions\/v5\/mapbox\/driving\//.test(seenUrl),
        "r1: mapbox provider calls the Directions v5 driving profile");
      ok(/10\.752200,59\.913900;10\.395100,63\.430500/.test(seenUrl),
        "r2: waypoints are lng,lat — the axis order the API expects");
      eq(mbRoute.polyline[0], { lat: 59.9139, lng: 10.7522 },
        "r3: GeoJSON [lng,lat] is decoded back to {lat,lng}");
      eq(mbRoute.kind, "road", "r4: a real provider is marked as a road route");
      near(mbRoute.distanceKm!, 485.2, 0.01, "r5: metres are converted to km");

      // OSRM: same shape, so a swap is config not code.
      let osrmUrl = "";
      const osrmFetch = (async (url: any) => {
        osrmUrl = String(url);
        return { ok: true, status: 200, json: async () => ({
          routes: [{ distance: 1000, duration: 60, geometry: { coordinates: [[10, 59], [10, 60]] } }],
        }) } as unknown as Response;
      }) as unknown as typeof fetch;
      const os = osrmProvider("https://osrm.internal.example", osrmFetch);
      const osRoute = await os.fetchRoute({ lat: 59, lng: 10 }, { lat: 60, lng: 10 });
      ok(/osrm\.internal\.example\/route\/v1\/driving\//.test(osrmUrl),
        "r6: osrm provider hits the same-shaped endpoint on the configured host");
      eq(osRoute.polyline.length, 2, "r7: and returns the same RouteResult shape");

      // ── The no-token path ──
      eq(resolveRouteProvider({ ROUTING_FALLBACK: "refuse" } as any), null,
        "r8: with no token and fallback=refuse, there is NO provider — the caller must say so");
      eq(resolveRouteProvider({} as any)!.kind, "straight_line",
        "r9: with no token and the default fallback, the substitute is TAGGED as not-a-route");
      eq(resolveRouteProvider({ ROUTING_PROVIDER: "mapbox", MAPBOX_ACCESS_TOKEN: "x" } as any)!.id, "mapbox",
        "r10: a configured token selects mapbox");
      eq(resolveRouteProvider({ ROUTING_PROVIDER: "osrm", OSRM_BASE_URL: "https://osrm.internal" } as any)!.id, "osrm",
        "r11: ROUTING_PROVIDER=osrm + a base URL selects osrm");
      eq(resolveRouteProvider({
        ROUTING_PROVIDER: "osrm",
        OSRM_BASE_URL: "https://router.project-osrm.org",
        ROUTING_FALLBACK: "refuse",
      } as any), null,
        "r12: the public OSRM demo server is REFUSED — non-commercial, 1 req/s, never in production");

      // A straight line must not be dressed up as a drive.
      const sl = await straightLineProvider(50).fetchRoute({ lat: 59, lng: 10 }, { lat: 60, lng: 11 });
      eq(sl.distanceKm, null, "r13: the straight-line substitute claims no driving distance");
      eq(sl.durationMinutes, null, "r14: …and no driving duration");
      eq(sl.kind, "straight_line", "r15: …and says what it is");
    }

    // ══ Straight-line mode suppresses detour_km end to end ════════════
    {
      __clearRouteCacheForTesting();
      const { provider } = stubProvider(straightNorthRoute(), "straight_line");
      const r = await corridorSearch({
        from: "Oslo", to: "Trondheim", provider, rfbDb: db,
        maxDetourKm: 20, minSeparationKm: 0, sources: ["rfb"],
      });
      ok(r.stops.length > 0, "r16: a straight-line corridor still returns suggestions");
      ok(r.stops.every((s) => s.detourKm === null),
        "r17: …but NO detour number, because the line is not the road");
      ok(r.stops.every((s) => typeof s.alongKm === "number"),
        "r18: along_km survives — progress toward the destination is still real");
      ok(r.notes.some((n) => /luftlinje/i.test(n)),
        "r19: the caller is handed a note it must render");
      eq(r.route!.kind, "straight_line", "r20: the response says the route is not a road route");
    }

    // ══ Refusal path ═════════════════════════════════════════════════
    {
      const r = await corridorSearch({ from: "Oslo", to: "Trondheim", provider: null, rfbDb: db });
      eq(r.ok, false, "r21: with no provider the search refuses");
      eq(r.failure, "no_routing_provider", "r22: …with a machine-readable reason");
      ok(!!r.reason && r.reason.length > 20, "r23: …and a sentence a human can read");
      eq(r.stops, [], "r24: …and no results that would imply it worked");
    }

    // ══ Unknown place ════════════════════════════════════════════════
    {
      const { provider } = stubProvider(straightNorthRoute());
      const r = await corridorSearch({
        from: "Kvxzyq Ikkeetsted", to: "Trondheim", provider, rfbDb: db,
      });
      eq(r.ok, false, "r25: an ungeocodable origin fails honestly");
      eq(r.failure, "unknown_origin", "r26: …identified as the origin, not a generic error");
    }

    // ══ k: polyline cache ═════════════════════════════════════════════
    {
      __clearRouteCacheForTesting();
      const { provider, calls } = stubProvider(straightNorthRoute());
      const from = { lat: 59.9139, lng: 10.7522 };
      const to = { lat: 63.4305, lng: 10.3951 };

      const a = await getPreparedRoute(provider, from, to, undefined, 1_000_000);
      eq(a.cached, false, "k1: the first call is a miss");
      eq(calls(), 1, "k1b: …and hits the provider once");

      const b = await getPreparedRoute(provider, from, to, undefined, 1_000_000);
      eq(b.cached, true, "k2: the second call is a hit");
      eq(calls(), 1, "k2b: …and does NOT hit the provider again");
      ok(a.prepared === b.prepared, "k3: the SIMPLIFIED form is cached too, not just the polyline");

      // 4-decimal key rounding: ~11 m, far finer than any endpoint we geocode
      // to, so distinct trips never collide but jitter does not miss.
      const c = await getPreparedRoute(provider, { lat: 59.913903, lng: 10.752201 }, to, undefined, 1_000_000);
      eq(c.cached, true, "k4: sub-metre jitter in the endpoint still hits the same cache entry");

      const d = await getPreparedRoute(provider, from, to, undefined, 1_000_000 + 25 * 3600 * 1000);
      eq(d.cached, false, "k5: past the 24 h TTL it re-fetches");
    }

    // ══ d: drink taxonomy (Fase 5) ════════════════════════════════════
    {
      // Verified live against rettfrabonden.com on 2026-07-25 BEFORE this
      // change: `q=øl` and `q=drikke` both returned categories: null and
      // answered with Kringler Gjestegård / Homme Gård — producers that sell
      // no drink at all. 100+ producers carry the `beverages` category and
      // none of them were reachable by category search.
      const cases: Array<[string, string]> = [
        ["øl", "beverages"], ["drikke", "beverages"], ["brygg", "beverages"],
        ["sider", "beverages"], ["cideri", "beverages"], ["vingård", "beverages"],
        ["destilleri", "beverages"], ["brenneri", "beverages"], ["akevitt", "beverages"],
        ["mjød", "beverages"], ["eplemost", "beverages"], ["saft", "beverages"],
        ["gårdskafé", "beverages"], ["kombucha", "beverages"],
      ];
      for (const [q, cat] of cases) {
        const parsed = marketplaceRegistry.parseNaturalQuery(q);
        ok((parsed.categories || []).includes(cat), `d1: «${q}» now maps to ${cat}`);
      }

      // …and a realistic sentence, not just the bare word.
      const sentence = marketplaceRegistry.parseNaturalQuery("finnes det et bryggeri i nærheten");
      ok((sentence.categories || []).includes("beverages"),
        "d2: the mapping survives inside a natural sentence");

      // The word-boundary fix cuts both ways: «øl» must match the word and only
      // the word. A producer NAME that merely ends in -øl is not a drink query.
      ok(!(marketplaceRegistry.parseNaturalQuery("Bryggerøl Gård").categories || []).includes("beverages"),
        "d3: «Bryggerøl Gård» is a name, not a drink query — the -øl suffix does not trigger the category");
      ok((marketplaceRegistry.parseNaturalQuery("øl fra Bryggerøl Gård").categories || []).includes("beverages"),
        "d3b: …but the standalone word «øl» in the same sentence does");
      ok(!(marketplaceRegistry.parseNaturalQuery("Tromsøost").categories || []).includes("dairy"),
        "d4: «Tromsøost» no longer false-matches «ost» — the ASCII \\b bug, fixed");
      ok((marketplaceRegistry.parseNaturalQuery("geitost").categories || []).includes("dairy"),
        "d5: …while «geitost» still matches dairy, exactly as before");
      ok(!(marketplaceRegistry.parseNaturalQuery("honning").categories || []).includes("beverages"),
        "d6: a non-drink query is untouched");
      ok((marketplaceRegistry.parseNaturalQuery("økologiske egg").categories || []).includes("eggs"),
        "d7: «økologiske egg» matches for the first time (it began with ø, so \\b never fired)");

      // drinkOnly on the corridor search.
      seedAgents(db, [
        { id: "p-beer", name: "Ruteøl Bryggeri", city: "Ringsaker", lat: 59.35, lng: 10.02,
          precision: "address", categories: ["beverages"] },
      ]);
      __clearRouteCacheForTesting();
      const { provider } = stubProvider(straightNorthRoute());
      const r = await corridorSearch({
        from: "Oslo", to: "Trondheim", provider, rfbDb: db,
        maxDetourKm: 20, minSeparationKm: 0, drinkOnly: true, sources: ["rfb"],
      });
      eq(r.stops.map((s) => s.id), ["p-beer"],
        "d8: drinkOnly narrows the corridor to drink producers");
    }

    // ══ Loader honesty: what the SQL actually returns ═════════════════
    {
      const prepared = prepareRoute(straightNorthRoute(), 0);
      const box = corridorBoundingBox(prepared, 20);
      const rows = loadRfbCandidates(box, db);
      ok(rows.length > 0, "l1: the bbox loader returns candidates");
      ok(rows.every((r) => typeof r.lat === "number" && typeof r.lng === "number"),
        "l2: every candidate has real coordinates (NULLs are excluded in SQL)");
      ok(rows.some((r) => r.precision === null), "l3: NULL-provenance rows ARE loaded…");
      ok(rows.filter((r) => isCorridorPrecise(r.precision)).length < rows.length,
        "l4: …and the allow-list, not the SQL, is what keeps them out of the maths");
      ok(rows.every((r) => r.url.startsWith("http")), "l5: every candidate carries a URL");

      eq(precisionFromGeocodeConfidence("high"), "address", "l6: gårdssalg 'high' → address");
      eq(precisionFromGeocodeConfidence("medium"), "address", "l7: gårdssalg 'medium' → address");
      eq(precisionFromGeocodeConfidence("approximate"), "kommune", "l8: 'approximate' → a centroid tier");
      eq(precisionFromGeocodeConfidence("low"), "kommune",
        "l9: 'low' is treated as a centroid — a weak address hit is where a km figure is confidently wrong");
      eq(precisionFromGeocodeConfidence(null), null, "l10: never geocoded stays unknown");
    }

    // ══ Performance, on a realistically-sized route ═══════════════════
    {
      const route = syntheticRoute(4000);
      const prepared = prepareRoute(route, DEFAULT_SIMPLIFY_TOLERANCE);
      const probes: LatLng[] = Array.from({ length: 2000 }, (_, i) => ({
        lat: 59.9 + (i % 350) * 0.01,
        lng: 10.4 + ((i * 7) % 100) * 0.01,
      }));
      const t0 = Date.now();
      for (const p of probes) measureAgainstRoute(p, prepared);
      const ms = Date.now() - t0;
      ok(ms < 400,
        `perf1: 2 000 candidates against a ${prepared.points.length}-vertex route in ${ms} ms`);
    }
  } finally {
    console.log = prevLog;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    __clearRouteCacheForTesting();
    if (prevDb) (initMod as any).__setDbForTesting(prevDb as any);
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runRouteCorridorTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    for (const f of s.failures) console.log("  " + f);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
