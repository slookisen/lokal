// ─── Route corridor discovery ────────────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2b.
//
// «om jeg skriver et stedsnavn, eller jeg skal reise fra oslo til bodø, så skal
//  vi ha en algoritme/løsning for å få forslag til stopp underveis på
//  opplevelser, drikkeplasser, grønnsak eller fruktutsalg.»  — Daniel
//
// This is the impure half of the corridor engine: geocode the endpoints, fetch
// (and cache) the driving polyline, then measure the catalogue against it. The
// maths itself lives in route-geometry.ts, which is pure and has no idea any of
// this exists.
//
// Pipeline:
//   from/to strings → geocodingService (Fase-0-hardened)   [network, cached]
//   → RouteProvider.fetchRoute()                            [network, cached]
//   → prepareRoute(): Douglas-Peucker ~500 m + projection   [pure, cached]
//   → corridorBoundingBox() → SQL BETWEEN prefilter         [SQLite, indexed]
//   → measureAgainstRoute() per candidate                   [pure, 0.8 ms]
//   → precision split, sort by along_km                     [pure]
//   → pickBestPerCluster() → spaceOutAlongRoute()           [pure]
//
// ════════════════════════════════════════════════════════════════════
// THE HONESTY RULE — read this before changing anything below
// ════════════════════════════════════════════════════════════════════
// Corridor numbers (`detour_km`, `along_km`) are emitted ONLY for rows on an
// ALLOW-LIST of exact positions. The allow-list is `geo_precision = 'address'`
// (RFB `agents` and OpplevAgent `experiences`), or `geocode_confidence IN
// ('high','medium')` for gårdssalg rows in `experience_providers`, which has no
// geo_precision column and expresses the same thing differently.
//
// It is an ALLOW-list, not "exclude city/kommune". That distinction is the
// whole point. RFB has ~948 rows with `geo_precision` NULL — unknown
// provenance, and many of them ARE seed-time city centroids
// (src/_seeds/seed-expansion-v2.ts). A deny-list of {'city','kommune'} lets
// every one of those NULL rows into the corridor maths, where a farm 25 km from
// the road would be published as "3 km fra ruten". That is exactly the
// fabricated-number problem Fase 0 and Fase 1c removed from the search page,
// and re-introducing it here — in a feature whose entire value proposition is
// "this is genuinely on your way" — would be worse than not shipping.
//
// The rule governs `along_km` ORDERING too, not just `detour_km`. A travel-
// ordered itinerary IS a positional claim: putting a producer between Hamar and
// Lillehammer says we know it is there. So imprecise rows are NEVER interleaved
// into the ordered list. They surface in a second, clearly separated bucket
// (`approximate`), grouped by place, ordered by the along-track position OF THE
// PLACE (a fact we do know, from its centroid) and carrying no number of their
// own — see buildApproximateGroups() and its comment.
//
// Labels: ONE rule about when a number may appear, TWO phrasings, because the
// referent differs (review N1). An imprecise row delegates to the existing
// helpers — geo-precision.ts's formatRfbDistanceLabel and
// experience-store.ts's formatDistanceLabel — whose centroid branch
// («i Hamar-området», never a number) is referent-neutral and is exactly the
// honesty rule we want reused. A precise row does NOT: those helpers render
// PROXIMITY («3,4 km unna» — away from YOU), and a corridor stop is measured
// off the ROUTE, which the caller is nowhere near. formatCorridorLabel() writes
// «3,4 km fra ruten» instead, matching what both /reise pages already say.
// Fase 6 hands this string to an AI assistant verbatim.
//
// ════════════════════════════════════════════════════════════════════
// SECOND HONESTY RULE — detour_km is not a driving distance
// ════════════════════════════════════════════════════════════════════
// `detour_km` is a straight-line offset from the driving line. Measured in
// Norway: Molde→Vestnes is 12.8 km apart and 104 km / 118 min to drive;
// Lavik→Ytre Oppedal is 4.9 km apart and 72 min (ferry). Fase 4 adds real
// `detour_minutes` from a routing matrix call; every shape below already has
// the optional slot, so that lands without breaking a caller. Until then the
// UI copy says «fra ruten» (from the route) and never «kjøring» (driving).

import { getDb } from "../database/init";
import { geocodingService } from "./geocoding-service";
import { formatRfbDistanceLabel } from "./geo-precision";
import { formatDistanceLabel } from "./experience-store";
import { slugify } from "../utils/slug";
import {
  prepareRoute,
  corridorBoundingBox,
  measureAgainstRoute,
  spaceOutAlongRoute,
  pickBestPerCluster,
  type LatLng,
  type Polyline,
  type PreparedRoute,
} from "./route-geometry";

// ── Routing providers ────────────────────────────────────────────────

/** How a polyline was obtained. Drives what we are allowed to claim about it. */
export type RouteKind = "road" | "straight_line";

export interface RouteResult {
  polyline: Polyline;
  /** Driving distance in km, per the provider. Null for a straight line. */
  distanceKm: number | null;
  /** Driving duration in minutes, per the provider. Null for a straight line. */
  durationMinutes: number | null;
  provider: string;
  kind: RouteKind;
}

/**
 * The seam. route-corridor-service never calls fetch directly; a provider does.
 * Tests inject a fake, production injects Mapbox (or a self-hosted OSRM), and
 * nothing about the corridor maths changes between them.
 */
export interface RouteProvider {
  readonly id: string;
  readonly kind: RouteKind;
  fetchRoute(from: LatLng, to: LatLng, via?: LatLng[]): Promise<RouteResult>;
}

/**
 * Mapbox Directions — the primary provider (100 000 requests/month free, which
 * covers this at our traffic with a wide margin).
 *
 * Token is read from the environment, never from code — same convention as
 * BRAVE_SEARCH_API_KEY / RENDER_WORKER_KEY / ANTHROPIC_API_KEY elsewhere in
 * this repo. There is no token in this file, this commit, or any fixture.
 */
export function mapboxProvider(token: string, fetchImpl: typeof fetch = fetch): RouteProvider {
  return {
    id: "mapbox",
    kind: "road",
    async fetchRoute(from, to, via) {
      const pts = [from, ...(via || []), to]
        .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)
        .join(";");
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/driving/${pts}` +
        `?geometries=geojson&overview=full&steps=false&access_token=${encodeURIComponent(token)}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`mapbox directions ${res.status}`);
      const data: any = await res.json();
      const route = data?.routes?.[0];
      const coords: any[] = route?.geometry?.coordinates || [];
      if (coords.length < 2) throw new Error("mapbox directions: no geometry");
      return {
        // GeoJSON is [lng, lat] — the classic axis-order trap. Both providers
        // below use the same order, which is why this mapping is repeated
        // rather than shared: it is a property of GeoJSON, not of the provider.
        polyline: coords.map((c) => ({ lat: c[1], lng: c[0] })),
        distanceKm: typeof route.distance === "number" ? route.distance / 1000 : null,
        durationMinutes: typeof route.duration === "number" ? route.duration / 60 : null,
        provider: "mapbox",
        kind: "road",
      };
    },
  };
}

/**
 * OSRM — the exit ramp. Same request/response shape as Mapbox by design, so
 * swapping providers is a config change, not a rewrite.
 *
 * MUST point at a self-hosted instance. The public demo server
 * (router.project-osrm.org) is non-commercial and rate-limited to ~1 req/s;
 * shipping on it would be both a licence breach and an outage waiting to
 * happen, so `osrmProvider` takes the base URL as a required argument and
 * resolveRouteProvider() below refuses to default to the demo host.
 *
 * Known weakness, documented rather than hidden: stock OSRM handles Norwegian
 * ferries poorly (Bodø→Moskenes routes 8.5 h around via Narvik instead of
 * taking the boat). Fase 4d adds the ferry warning.
 */
export function osrmProvider(baseUrl: string, fetchImpl: typeof fetch = fetch): RouteProvider {
  return {
    id: "osrm",
    kind: "road",
    async fetchRoute(from, to, via) {
      const pts = [from, ...(via || []), to]
        .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)
        .join(";");
      const url = `${baseUrl.replace(/\/+$/, "")}/route/v1/driving/${pts}?overview=full&geometries=geojson`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`osrm route ${res.status}`);
      const data: any = await res.json();
      const route = data?.routes?.[0];
      const coords: any[] = route?.geometry?.coordinates || [];
      if (coords.length < 2) throw new Error("osrm route: no geometry");
      return {
        polyline: coords.map((c) => ({ lat: c[1], lng: c[0] })),
        distanceKm: typeof route.distance === "number" ? route.distance / 1000 : null,
        durationMinutes: typeof route.duration === "number" ? route.duration / 60 : null,
        provider: "osrm",
        kind: "road",
      };
    },
  };
}

/**
 * The no-token path. NOT a route — a straight line between the endpoints,
 * densified so the corridor maths has something to bite on.
 *
 * The degradation is honest in three enforced ways, not one:
 *   1. `kind: "straight_line"` is on the result and on every API response.
 *   2. corridorSearch() SUPPRESSES `detour_km` entirely in this mode — the same
 *      treatment a centroid-precision row gets. A straight Oslo→Bergen line
 *      crosses Hardangervidda while the E16 goes round it, so "4 km fra ruten"
 *      would be a fabricated number about a road that is not there.
 *      `along_km` survives: progress from origin toward destination is still
 *      directionally true on a straight line, so the ORDER is real even though
 *      the offsets are not.
 *   3. the page and the API both carry a note the caller cannot drop.
 *
 * It never claims a distance or a duration (both null) — the great-circle
 * length is not the drive, and in Norway it is routinely off by 3-8×.
 */
export function straightLineProvider(steps = 200): RouteProvider {
  return {
    id: "straight-line",
    kind: "straight_line",
    async fetchRoute(from, to, via) {
      const anchors = [from, ...(via || []), to];
      const polyline: Polyline = [];
      for (let s = 0; s < anchors.length - 1; s++) {
        const a = anchors[s];
        const b = anchors[s + 1];
        const n = Math.max(2, Math.round(steps / (anchors.length - 1)));
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          polyline.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
        }
      }
      return {
        polyline,
        distanceKm: null,
        durationMinutes: null,
        provider: "straight-line",
        kind: "straight_line",
      };
    },
  };
}

/** Why the corridor could not be built, when it could not. */
export type CorridorFailure =
  | "no_routing_provider"
  | "unknown_origin"
  | "unknown_destination"
  | "routing_failed";

/**
 * Provider selection from the environment.
 *
 *   ROUTING_PROVIDER   'mapbox' (default) | 'osrm' | 'none'
 *   MAPBOX_ACCESS_TOKEN
 *   OSRM_BASE_URL      required when ROUTING_PROVIDER=osrm; the public demo
 *                      host is rejected outright (see osrmProvider).
 *   ROUTING_FALLBACK   'straight_line' (default) | 'refuse'
 *
 * Returns null when nothing is configured AND the fallback is 'refuse' — the
 * caller then reports `no_routing_provider` with a reason the UI prints. It
 * never silently substitutes a straight line for a road route: the substitution
 * happens, but it arrives labelled, and with detour_km suppressed.
 */
export function resolveRouteProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  deps: { consumeBudget?: () => boolean } = {},
): RouteProvider | null {
  const choice = (env.ROUTING_PROVIDER || "mapbox").toLowerCase();

  if (choice === "osrm") {
    const base = (env.OSRM_BASE_URL || "").trim();
    // Refuse the demo server explicitly rather than letting a copy-pasted URL
    // put a non-commercial, 1 req/s host on the critical path in production.
    if (base && !/router\.project-osrm\.org/i.test(base)) {
      return osrmProvider(base, fetchImpl);
    }
  } else if (choice === "mapbox") {
    const token = (env.MAPBOX_ACCESS_TOKEN || "").trim();
    if (token) {
      // Mapbox is the only METERED provider — a self-hosted OSRM costs nothing
      // per call, so it is deliberately left uncapped. See mapbox-budget.ts for
      // why the ceiling has to live in our code: Mapbox offers usage alerts,
      // not a hard spending cap.
      const consume =
        deps.consumeBudget ??
        (() => {
          const { tryConsumeMapboxCall } =
            require("./mapbox-budget") as typeof import("./mapbox-budget");
          return tryConsumeMapboxCall();
        });
      return cappedProvider(mapboxProvider(token, fetchImpl), consume);
    }
  }

  if ((env.ROUTING_FALLBACK || "straight_line").toLowerCase() === "refuse") return null;
  return straightLineProvider();
}

/**
 * Wrap a metered provider so that exhausting its monthly allowance DEGRADES
 * rather than fails.
 *
 * The budget is charged inside fetchRoute(), which getPreparedRoute() only
 * reaches on a cache MISS — so a cached route is free, and the cap bounds
 * network calls rather than page views.
 *
 * On exhaustion this answers with the straight-line provider's result. The
 * corridor engine already emits an honest note whenever `kind !== "road"`, so
 * the visitor is told the ordering is real but the road is not. Returning an
 * error instead would hand them a failure for a budget decision they had no
 * part in.
 *
 * `kind` stays the PRIMARY provider's kind ("road") because it describes what
 * this provider is, not what any single call returned; the per-route `kind` on
 * the result is what downstream reads, and that one is honest per call.
 */
/** `provider` value on a straight line produced because the monthly cap was hit. */
export const CAPPED_STRAIGHT_LINE_PROVIDER = "straight-line-capped";

export function cappedProvider(primary: RouteProvider, consume: () => boolean): RouteProvider {
  const fallback = straightLineProvider();
  return {
    id: primary.id,
    kind: primary.kind,
    async fetchRoute(from, to, via) {
      if (!consume()) {
        const r = await fallback.fetchRoute(from, to, via);
        // Tag it. "We have not configured routing" and "we have used this
        // month's allowance" are different facts, and an operator reading a
        // screenshot must be able to tell which one they are looking at.
        return { ...r, provider: CAPPED_STRAIGHT_LINE_PROVIDER };
      }
      return primary.fetchRoute(from, to, via);
    },
  };
}

// ── Route cache ──────────────────────────────────────────────────────
//
// Keyed on the rounded endpoint coordinates rather than the raw query strings,
// so «oslo til bodø», «Oslo→Bodø» and «fra oslo til bodo» share one entry once
// geocoding has resolved them. 4 decimals ≈ 11 m, far finer than any endpoint
// we geocode to (city centroids move by kilometres), so no two distinct trips
// collide.
//
// TTL 24 h: road geometry changes on the timescale of roadworks, and a stale
// route degrades gracefully (a closed side road shifts a detour by a few
// hundred metres) — nothing here justifies re-billing Mapbox per request. The
// prepared/simplified form is cached, because simplification costs 10-21 ms and
// is pure, so re-deriving it per request would undo the work that got the query
// down to 0.8 ms.
//
// ══ WHAT IS DELIBERATELY *NOT* CACHED: the raw polyline ═════════════
// REVIEW B1. The first version of this cache stored the whole RouteResult,
// raw polyline included, for 24 h. That polyline is read EXACTLY ONCE — by
// prepareRoute() below — and never again: corridorSearch() only ever reads
// kind/provider/distanceKm/durationMinutes off the route, and the vertex count
// comes from prepared.sourcePointCount. So a 33 246-point Oslo→Bodø geometry
// was being pinned for a day for nothing.
//
// Measured under forced GC with the real prepareRoute(), 20 distinct real
// Oslo→Bodø routes:
//     with the raw polyline     2.57 MB/entry  →  515 MB at the old cap of 200
//     without it                0.19 MB/entry  →    5 MB at the new cap of 25
// a 13× reduction per entry and ~100× overall.
//
// That mattered because the cache is reachable from an UNAUTHENTICATED page.
// The JSON endpoints sit under app.use("/api", generalLimiter) (index.ts:389),
// but the SSR /reise handlers did not — a crawler walking 200 distinct
// ?from=X&to=Y pairs could fill the cache to cap and pin half a gigabyte in a
// process that also serves rettfrabonden.com and finn-tannlege.com. Both SSR
// pages are now behind generalLimiter too (index.ts), so this is belt AND
// braces: a smaller belt, and a buckle on the door.
//
// Eviction is LRU with an expiry sweep, not FIFO. Under FIFO an EXPIRED entry
// still held a slot until it happened to reach the front, so a stale entry
// could evict a fresh, actively-used one. Now: sweep what is dead first, and
// only if that frees nothing, drop the least-recently-USED.
type CachedRouteMeta = Omit<RouteResult, "polyline">;

interface CachedRoute {
  /** Route metadata WITHOUT the polyline. See the B1 note above. */
  meta: CachedRouteMeta;
  prepared: PreparedRoute;
  expiresAt: number;
}

const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** ~5 MB at the measured 0.19 MB/entry. Was 200 (≈515 MB). See review B1. */
const ROUTE_CACHE_MAX = 25;
const routeCache = new Map<string, CachedRoute>();

function routeCacheKey(providerId: string, from: LatLng, to: LatLng, via?: LatLng[]): string {
  const f = (p: LatLng) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  return [providerId, f(from), ...(via || []).map(f), f(to)].join("|");
}

/** Test-only: empty the route cache so cases do not leak into each other. */
export function __clearRouteCacheForTesting(): void {
  routeCache.clear();
}

/** Test-only: inspect the cache without exporting the Map itself. */
export function __peekRouteCacheForTesting(): Array<{ key: string; entry: CachedRoute }> {
  return [...routeCache.entries()].map(([key, entry]) => ({ key, entry }));
}

export async function getPreparedRoute(
  provider: RouteProvider,
  from: LatLng,
  to: LatLng,
  via?: LatLng[],
  now: number = Date.now(),
): Promise<{ route: CachedRouteMeta; prepared: PreparedRoute; cached: boolean }> {
  const key = routeCacheKey(provider.id, from, to, via);
  const hit = routeCache.get(key);
  if (hit && hit.expiresAt > now) {
    // LRU touch: re-inserting moves the key to the end of the Map's insertion
    // order, so the eviction scan below always drops the least-recently-USED
    // rather than the oldest-created.
    routeCache.delete(key);
    routeCache.set(key, hit);
    return { route: hit.meta, prepared: hit.prepared, cached: true };
  }

  const route = await provider.fetchRoute(from, to, via);
  const prepared = prepareRoute(route.polyline);
  // `polyline` is dropped here and never stored. Everything downstream needs
  // is either on `meta` or already inside `prepared`.
  const { polyline: _discardedPolyline, ...meta } = route;

  // Sweep expired entries first — under the old FIFO scheme a dead entry could
  // hold a slot and evict a live one.
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    for (const [k, v] of routeCache) if (v.expiresAt <= now) routeCache.delete(k);
  }
  // Still full → drop least-recently-used until there is room.
  while (routeCache.size >= ROUTE_CACHE_MAX) {
    const lru = routeCache.keys().next();
    if (lru.done) break;
    routeCache.delete(lru.value);
  }
  routeCache.set(key, { meta, prepared, expiresAt: now + ROUTE_CACHE_TTL_MS });

  return { route: meta, prepared, cached: false };
}

// ── Candidates ───────────────────────────────────────────────────────

/** Which catalogue a suggestion came from. */
export type CorridorSource = "rfb" | "experience" | "gardssalg";

/** A row pulled from a catalogue, before it has met the route. */
export interface CorridorCandidate {
  id: string;
  source: CorridorSource;
  name: string;
  lat: number;
  lng: number;
  /** Normalised to the geo-precision.ts vocabulary. Null = unknown provenance. */
  precision: string | null;
  /** Free-text place: RFB `city`, experiences `kommune`. Used for grouping. */
  place: string | null;
  fylke?: string | null;
  categories: string[];
  url: string;
  description?: string | null;
  /** True when this row is a drink producer (Fase 5). */
  isDrink?: boolean;
}

/** A candidate that is precisely placed and inside the corridor. */
export interface CorridorStop extends CorridorCandidate {
  /**
   * Straight-line km from the route line. NULL when the "route" is a straight
   * line (no real road geometry to be offset from) — never a fabricated number.
   */
  detourKm: number | null;
  /** Km travelled along the route before this stop. */
  alongKm: number;
  /** Fase 4 slot. Always undefined today. Prefer this over detourKm when set. */
  detourMinutes?: number;
  /** Honest human label, from the shared helpers. */
  label: string | null;
}

/** Imprecise rows, grouped by the place whose position we DO know. */
export interface ApproximateGroup {
  place: string;
  /** Along-track km OF THE PLACE (its centroid), not of any member. */
  placeAlongKm: number;
  /** Never carries a per-item distance. That is the point. */
  items: Array<CorridorCandidate & { label: string | null }>;
}

export interface CorridorSearchResult {
  ok: boolean;
  failure?: CorridorFailure;
  /** Human-readable reason, always set when ok is false. Norwegian. */
  reason?: string;
  from?: { query: string; name: string; lat: number; lng: number };
  to?: { query: string; name: string; lat: number; lng: number };
  route?: {
    kind: RouteKind;
    provider: string;
    distanceKm: number | null;
    durationMinutes: number | null;
    /** Vertices after Douglas-Peucker; the raw count before it. */
    simplifiedPoints: number;
    sourcePoints: number;
    cached: boolean;
  };
  /** Precisely placed suggestions, in travel order. */
  stops: CorridorStop[];
  /** Imprecise rows, grouped, no numbers. */
  approximate: ApproximateGroup[];
  /** Notes the caller MUST render (degraded routing, suppressed numbers, …). */
  notes: string[];
  /** Wall-clock ms spent in the corridor maths (excludes network). */
  queryMs: number;
  counts: {
    scanned: number;
    precise: number;
    imprecise: number;
    afterSpacing: number;
  };
}

// ── The precision allow-list ─────────────────────────────────────────

/**
 * THE allow-list. Exactly one tier passes: a coordinate geocoded from a real
 * street address. Everything else — 'city', 'kommune', 'postal', NULL, a typo,
 * a value a future migration adds — is imprecise and gets no number.
 *
 * Written as an allow-list on purpose (see the file header). If you are here to
 * add a tier, ask first whether a user would accept "4 km fra ruten" being
 * computed from it.
 */
export function isCorridorPrecise(precision: string | null | undefined): boolean {
  return precision === "address";
}

/**
 * `experience_providers` (gårdssalg) has no geo_precision column — it expresses
 * the same idea as `geocode_confidence`. Map it into the shared vocabulary
 * rather than teaching the corridor a second dialect:
 *   'high' | 'medium' → a real address geocode      → 'address'
 *   'approximate'     → a kommune/fylke centroid    → 'kommune'
 *   'low'             → matched, but weakly. Treated as a centroid: a low-
 *                       confidence address hit is precisely the case where a
 *                       km figure would be confidently wrong.
 *   null              → never geocoded              → null (unknown)
 */
export function precisionFromGeocodeConfidence(conf: string | null | undefined): string | null {
  if (conf === "high" || conf === "medium") return "address";
  if (conf === "approximate" || conf === "low") return "kommune";
  return null;
}

// ── Catalogue loaders ────────────────────────────────────────────────
//
// One bbox query per catalogue. The bbox is the route's own bounding box grown
// by the detour budget, so SQLite discards the ~98 % of the country that cannot
// possibly qualify using plain BETWEEN on indexed columns — no R*Tree (measured
// SLOWER at this scale: 1.87 ms vs 1.11 ms), no SpatiaLite, no PostGIS. Same
// pattern marketplace-registry.ts:232 and experience-store.ts:1163 already use.

/** Fase 5: the drink taxonomy, shared by the parser, the filters and the API. */
export const DRINK_CATEGORIES = new Set([
  "beverages", "beer", "cider", "sider", "juice", "coffee", "drikke",
]);

/** Gårdssalg producer_type values — all of them are drink producers. */
export const DRINK_PRODUCER_TYPES = new Set([
  "bryggeri", "cideri", "vingård", "vingard", "destilleri", "mjøderi", "mjoderi", "seltzeri",
]);

/** Experience categories that are food/drink stops rather than sights. */
export const DRINK_EXPERIENCE_CATEGORIES = new Set(["mat_drikke", "gardssalg", "gardssalg_smaking"]);

/**
 * Review N5: gårdssalg rows are drink producers unless their `producer_type`
 * says otherwise. NULL/blank (43 of 50 production rows) counts as drink,
 * because the vertical is a drink catalogue; a recognised non-drink type does
 * not. Extend NON_DRINK_PRODUCER_TYPES as the taxonomy grows.
 */
export const NON_DRINK_PRODUCER_TYPES = new Set([
  "gardsbutikk", "gårdsbutikk", "gardsutsalg", "gårdsutsalg",
  "bakeri", "ysteri", "meieri", "slakteri", "reko", "annet",
]);

export function isGardssalgDrinkType(producerType: string | null | undefined): boolean {
  const t = String(producerType || "").trim().toLowerCase();
  if (!t) return true;                                    // unknown → drink
  if (DRINK_PRODUCER_TYPES.has(t)) return true;           // known drink → drink
  return !NON_DRINK_PRODUCER_TYPES.has(t);                // known non-drink → not
}

function isDrinkRow(source: CorridorSource, categories: string[], producerType?: string | null): boolean {
  if (producerType && DRINK_PRODUCER_TYPES.has(producerType.toLowerCase())) return true;
  for (const c of categories) {
    const k = String(c || "").toLowerCase();
    if (DRINK_CATEGORIES.has(k)) return true;
    if (source === "experience" && DRINK_EXPERIENCE_CATEGORIES.has(k)) return true;
  }
  return false;
}

const RFB_BASE_URL = process.env.BASE_URL || "https://rettfrabonden.com";
const EXPERIENCES_BASE_URL = process.env.OPPLEVAGENT_BASE_URL || "https://opplevagent.no";

/**
 * RFB producers inside the bbox.
 *
 * `umbrella_type IS NULL` mirrors marketplace-registry.discover()'s
 * producer-surface rule (Phase 5.11 A4.1) — an umbrella organisation is not a
 * place you stop at.
 */
export function loadRfbCandidates(
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  db: any = getDb(),
): CorridorCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, name, description, city, lat, lng, geo_precision, categories, url
         FROM agents
        WHERE is_active = 1
          AND umbrella_type IS NULL
          AND role = 'producer'
          AND lat IS NOT NULL AND lng IS NOT NULL
          AND lat BETWEEN ? AND ?
          AND lng BETWEEN ? AND ?`,
    )
    .all(box.minLat, box.maxLat, box.minLng, box.maxLng) as any[];

  return rows.map((r) => {
    let categories: string[] = [];
    try {
      categories = r.categories ? JSON.parse(r.categories) : [];
    } catch {
      categories = [];
    }
    return {
      id: String(r.id),
      source: "rfb" as const,
      name: String(r.name || ""),
      lat: r.lat as number,
      lng: r.lng as number,
      precision: (r.geo_precision ?? null) as string | null,
      place: (r.city ?? null) as string | null,
      categories,
      description: r.description ?? null,
      url: `${RFB_BASE_URL}/produsent/${slugify(String(r.name || ""))}`,
      isDrink: isDrinkRow("rfb", categories),
    };
  });
}

/**
 * OpplevAgent experiences inside the bbox.
 *
 * The gates replicate discoverExperiences() (experience-store.ts:1138-1145)
 * verbatim — verified, decent confidence, provider active in Brreg, and not a
 * dedup loser (`canonical_id IS NULL`). A corridor page is a publishing surface
 * like any other; it does not get to show rows the catalogue hides.
 */
export function loadExperienceCandidates(
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  db: any,
): CorridorCandidate[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.slug, e.title, e.title_no, e.category, e.kommune, e.fylke,
              e.loc_lat, e.loc_lon, e.geo_precision
         FROM experiences e
         LEFT JOIN experience_providers p ON p.id = e.provider_id
        WHERE e.verification_status = 'verified'
          AND e.confidence IN ('high','medium')
          AND e.canonical_id IS NULL
          AND (p.brreg_active IS NULL OR p.brreg_active = 1)
          AND e.loc_lat IS NOT NULL AND e.loc_lon IS NOT NULL
          AND e.loc_lat BETWEEN ? AND ?
          AND e.loc_lon BETWEEN ? AND ?`,
    )
    .all(box.minLat, box.maxLat, box.minLng, box.maxLng) as any[];

  return rows.map((r) => ({
    id: String(r.id),
    source: "experience" as const,
    name: String(r.title_no || r.title || ""),
    lat: r.loc_lat as number,
    lng: r.loc_lon as number,
    precision: (r.geo_precision ?? null) as string | null,
    place: (r.kommune ?? null) as string | null,
    fylke: (r.fylke ?? null) as string | null,
    categories: r.category ? [String(r.category)] : [],
    url: `${EXPERIENCES_BASE_URL}/opplevelse/${r.slug}`,
    isDrink: isDrinkRow("experience", r.category ? [String(r.category)] : []),
  }));
}

/**
 * Gårdssalg drink producers inside the bbox. These live in
 * `experience_providers` (NOT `experiences`) with `producer_type` set, and use
 * `lat`/`lon` + `geocode_confidence` rather than `loc_lat`/`loc_lon` +
 * `geo_precision`. Both differences are load-bearing and both have bitten
 * before — see experience-store.ts:2073.
 *
 * The catalogue gate is lifted verbatim from searchGardssalgProviders()
 * (experience-store.ts:2098-2101).
 */
export function loadGardssalgCandidates(
  box: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  db: any,
): CorridorCandidate[] {
  const rows = db
    .prepare(
      `SELECT id, navn, slug, fylke, kommune, poststed, producer_type,
              lat, lon, geocode_confidence
         FROM experience_providers
        WHERE (producer_type IS NOT NULL OR rfb_seed_source = 'rfb-seed')
          AND (catalog_hidden IS NULL OR catalog_hidden != 1)
          AND lat IS NOT NULL AND lon IS NOT NULL
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?`,
    )
    .all(box.minLat, box.maxLat, box.minLng, box.maxLng) as any[];

  return rows.map((r) => ({
    id: String(r.id),
    source: "gardssalg" as const,
    name: String(r.navn || ""),
    lat: r.lat as number,
    lng: r.lon as number,
    precision: precisionFromGeocodeConfidence(r.geocode_confidence),
    place: (r.kommune ?? r.poststed ?? null) as string | null,
    fylke: (r.fylke ?? null) as string | null,
    categories: r.producer_type ? [String(r.producer_type)] : [],
    url: `${EXPERIENCES_BASE_URL}/kategori/gardssalg/produsent/${r.slug}`,
    // REVIEW N5. The rule is: a gårdssalg row is a drink producer UNLESS its
    // producer_type says otherwise.
    //
    // The earlier blanket `true` was right about today's catalogue and wrong
    // about its own WHERE clause: that clause also admits `rfb_seed_source =
    // 'rfb-seed'` rows, which carry no producer_type constraint at all, so the
    // first non-drink RFB-seeded row would have silently become a drink stop.
    //
    // Why not simply key off producer_type: it is unpopulated on 43 of 50
    // production rows, so requiring it would hide 86 % of the catalogue from
    // the very filter Daniel asked for. Hence "unknown counts as drink"
    // (matching what the vertical IS — bryggeri / cideri / vingård /
    // destilleri / mjøderi / seltzeri) but a KNOWN non-drink type is believed.
    // The data gap is noted, not patched here.
    isDrink: isGardssalgDrinkType(r.producer_type),
  }));
}

// ── Labels ───────────────────────────────────────────────────────────

/**
 * REVIEW N1 — the referent, not just the number.
 *
 * The shared helpers (geo-precision.ts's formatRfbDistanceLabel,
 * experience-store.ts's formatDistanceLabel) render PROXIMITY: «3,4 km unna»,
 * i.e. "away from you". In a corridor the same number means something else
 * entirely — "off the route you are driving" — and the caller is nowhere near
 * it. The number was true and the sentence was wrong, and Fase 6 hands this
 * string to an AI assistant verbatim, so the mistake would have been repeated
 * out loud.
 *
 * So the split is:
 *
 *   PRECISE row, real road route  → corridor phrasing, written here, because
 *                                   no existing helper expresses this referent:
 *                                   «3,4 km fra ruten» — matching the wording
 *                                   both /reise pages already use.
 *   PRECISE row, straight-line    → detourKm is null (we refuse to claim an
 *                                   offset from a line that is not the road),
 *                                   so: «langs ruten», no number.
 *   IMPRECISE row                 → delegate to the shared helpers unchanged.
 *                                   Their centroid branch is referent-neutral
 *                                   («i Hamar-området», never a number) and is
 *                                   exactly the honesty rule we want reused.
 *
 * That is still one rule about WHEN a number may appear — isCorridorPrecise()
 * and the helpers agree, and the belt-and-braces holds: even if a centroid row
 * reached the first branch, detourKm would be null for it.
 */
export function formatCorridorLabel(detourKm: number | null | undefined): string {
  if (typeof detourKm === "number" && Number.isFinite(detourKm)) {
    const km = detourKm.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${km} km fra ruten`;
  }
  return "langs ruten";
}

function labelFor(c: CorridorCandidate, detourKm: number | null): string | null {
  if (isCorridorPrecise(c.precision)) return formatCorridorLabel(detourKm);
  // Imprecise: the shared centroid phrasing, unchanged. These helpers never
  // print a km figure for a non-'address' precision, which is why they are the
  // right thing to reuse here and the wrong thing to reuse above.
  if (c.source === "rfb") {
    return formatRfbDistanceLabel(null, c.precision, c.place);
  }
  const p = c.precision === "address" ? "address" : c.precision === null ? null : "kommune";
  return formatDistanceLabel(null, p as any, c.place);
}

// ── Approximate grouping ─────────────────────────────────────────────

/**
 * Rows we cannot place precisely still get shown — hiding a third of the
 * catalogue would be its own dishonesty — but they are never mixed into the
 * itinerary.
 *
 * They are grouped by `place` and each group is ordered by THE PLACE's
 * along-track position. That number is honest in a way a per-producer one is
 * not: it is derived from the centroid, and it describes the centroid. We are
 * saying "the route passes through Ringsaker, and these producers are in
 * Ringsaker" — two facts we hold — instead of "this producer is 3.4 km from
 * your route", which we do not.
 *
 * The group's own along position is therefore NOT published as a per-item
 * number; it exists to order the sections so the page still reads front-to-back
 * as a journey.
 */
export function buildApproximateGroups(
  imprecise: Array<{ candidate: CorridorCandidate; alongKm: number }>,
  maxPerGroup: number,
): ApproximateGroup[] {
  const byPlace = new Map<string, { place: string; along: number[]; items: CorridorCandidate[] }>();
  for (const { candidate, alongKm } of imprecise) {
    const place = (candidate.place || "").trim();
    if (!place) continue; // no place, no honest sentence to write about it
    const key = place.toLowerCase();
    let g = byPlace.get(key);
    if (!g) {
      g = { place, along: [], items: [] };
      byPlace.set(key, g);
    }
    g.along.push(alongKm);
    g.items.push(candidate);
  }

  const groups: ApproximateGroup[] = [];
  for (const g of byPlace.values()) {
    // Median-ish: the place's own position, taken as the mean of the centroids
    // that claim to be in it. Robust enough for ordering sections.
    const placeAlongKm = g.along.reduce((a, b) => a + b, 0) / g.along.length;
    groups.push({
      place: g.place,
      placeAlongKm,
      items: g.items
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, "nb-NO"))
        .slice(0, maxPerGroup)
        .map((c) => ({ ...c, label: labelFor(c, null) })),
    });
  }
  groups.sort((a, b) => a.placeAlongKm - b.placeAlongKm);
  return groups;
}

// ── The search ───────────────────────────────────────────────────────

export interface CorridorSearchOptions {
  from: string;
  to: string;
  via?: string[];
  /** Corridor half-width in km. Default 20, clamped 1-100. */
  maxDetourKm?: number;
  /** Only drink producers (Fase 5). */
  drinkOnly?: boolean;
  /** Restrict to these catalogues. Default: all available. */
  sources?: CorridorSource[];
  /** Max suggestions in the ordered list. Default 25, clamped 1-100. */
  limit?: number;
  /** Fase 2d: max per place. Default 3. */
  maxPerPlace?: number;
  /** Fase 2d: min along-track separation in km. Default 25. */
  minSeparationKm?: number;
  /** Injected. Defaults to resolveRouteProvider(process.env). */
  provider?: RouteProvider | null;
  /** RFB database handle. Defaults to getDb(). */
  rfbDb?: any;
  /** Experiences database handle. Omit to skip both experience catalogues. */
  experiencesDb?: any;
  now?: number;
}

export const DEFAULT_MAX_DETOUR_KM = 20;
export const DEFAULT_MAX_PER_PLACE = 3;
export const DEFAULT_MIN_SEPARATION_KM = 25;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * REVIEW N4, second half. A fixed 25 km separation is tuned for a long haul and
 * strangles a short one: measured, a 36 km route with 12 candidates returned
 * 2 — «Oslo til Drammen» could never yield more than two suggestions, and the
 * SSR pages expose no control to loosen it (only the JSON API does).
 *
 * Scale it so any route can carry up to ~8 stops, while never EXCEEDING what
 * the caller asked for. Long routes are therefore bit-for-bit unchanged
 * (485 km / 8 = 60.6 → min(25, 60.6) = 25), and short ones stop being empty
 * (36 km / 8 = 4.5 km).
 *
 * Uses the provider's driving distance when we have one, and the simplified arc
 * length otherwise — in straight-line mode we refuse to claim a distance, but
 * we still need a length to scale against.
 */
export const CORRIDOR_TARGET_STOPS = 8;

export function resolveSeparationKm(
  requestedKm: number,
  routeDistanceKm: number | null | undefined,
  preparedLengthKm: number,
): number {
  const lengthKm = routeDistanceKm != null && routeDistanceKm > 0 ? routeDistanceKm : preparedLengthKm;
  if (!(lengthKm > 0)) return requestedKm;
  return Math.min(requestedKm, lengthKm / CORRIDOR_TARGET_STOPS);
}

export async function corridorSearch(opts: CorridorSearchOptions): Promise<CorridorSearchResult> {
  const notes: string[] = [];
  const maxDetourKm = clamp(opts.maxDetourKm ?? DEFAULT_MAX_DETOUR_KM, 1, 100);
  const limit = clamp(opts.limit ?? 25, 1, 100);
  const maxPerPlace = clamp(opts.maxPerPlace ?? DEFAULT_MAX_PER_PLACE, 1, 10);
  const minSeparationKm = clamp(opts.minSeparationKm ?? DEFAULT_MIN_SEPARATION_KM, 0, 200);

  const empty = (failure: CorridorFailure, reason: string): CorridorSearchResult => ({
    ok: false, failure, reason, stops: [], approximate: [], notes,
    queryMs: 0, counts: { scanned: 0, precise: 0, imprecise: 0, afterSpacing: 0 },
  });

  const provider = opts.provider !== undefined ? opts.provider : resolveRouteProvider();
  if (!provider) {
    return empty(
      "no_routing_provider",
      "Vi har ikke ruteberegning aktivert akkurat nå, så vi kan ikke si hva som ligger langs " +
        "kjøreruten. Prøv nærhetssøk på et sted i stedet.",
    );
  }

  // Fase-0-hardened geocoding: refuses low-confidence and wrong-object-type
  // hits rather than returning the first fuzzy match (which is how «blåskjell
  // Kautokeino» used to resolve to Larvik, 1 400 km out).
  const [fromGeo, toGeo] = await Promise.all([
    geocodingService.geocode(opts.from),
    geocodingService.geocode(opts.to),
  ]);
  if (!fromGeo) {
    return empty("unknown_origin", `Vi fant ikke stedet «${opts.from}». Prøv et annet stedsnavn.`);
  }
  if (!toGeo) {
    return empty("unknown_destination", `Vi fant ikke stedet «${opts.to}». Prøv et annet stedsnavn.`);
  }

  const viaGeo: LatLng[] = [];
  for (const v of opts.via || []) {
    const g = await geocodingService.geocode(v);
    if (g) viaGeo.push({ lat: g.lat, lng: g.lng });
    else notes.push(`Vi fant ikke stoppet «${v}», så det er ikke med i ruten.`);
  }

  // CachedRouteMeta, not RouteResult: the raw polyline is consumed by
  // prepareRoute() inside getPreparedRoute() and never stored (review B1).
  // Nothing below reads it — this type makes that a compile-time guarantee.
  let routed: { route: CachedRouteMeta; prepared: PreparedRoute; cached: boolean };
  try {
    routed = await getPreparedRoute(
      provider,
      { lat: fromGeo.lat, lng: fromGeo.lng },
      { lat: toGeo.lat, lng: toGeo.lng },
      viaGeo.length > 0 ? viaGeo : undefined,
      opts.now,
    );
  } catch (err: any) {
    return empty(
      "routing_failed",
      `Ruteberegningen svarte ikke (${String(err?.message || err)}). Prøv igjen om litt.`,
    );
  }

  const { route, prepared, cached } = routed;
  const straightLine = route.kind !== "road";
  if (straightLine) {
    notes.push(
      route.provider === CAPPED_STRAIGHT_LINE_PROVIDER
        ? "Vi har brukt opp månedens kvote for ruteberegning, så dette er luftlinjen mellom " +
            "stedene — ikke veien. Rekkefølgen stemmer, men vi oppgir ingen avstand til ruten. " +
            "Ekte kjørerute er tilbake ved månedsskiftet."
        : "Vi har ikke ekte kjørerute her, så dette er luftlinjen mellom stedene — ikke veien. " +
            "Rekkefølgen stemmer, men vi oppgir ingen avstand til ruten.",
    );
  }

  // ── The measured part. Everything from here is pure + SQLite. ──
  const t0 = Date.now();

  const box = corridorBoundingBox(prepared, maxDetourKm);

  let candidates: CorridorCandidate[] = [];
  const wanted = new Set<CorridorSource>(opts.sources || ["rfb", "experience", "gardssalg"]);
  if (wanted.has("rfb")) {
    try {
      candidates = candidates.concat(loadRfbCandidates(box, opts.rfbDb ?? getDb()));
    } catch { /* a missing rfb catalogue must not take the whole page down */ }
  }
  if (opts.experiencesDb) {
    if (wanted.has("experience")) {
      try {
        candidates = candidates.concat(loadExperienceCandidates(box, opts.experiencesDb));
      } catch { /* ditto */ }
    }
    if (wanted.has("gardssalg")) {
      try {
        candidates = candidates.concat(loadGardssalgCandidates(box, opts.experiencesDb));
      } catch { /* ditto */ }
    }
  }

  const scanned = candidates.length;
  if (opts.drinkOnly) candidates = candidates.filter((c) => c.isDrink);

  const precise: CorridorStop[] = [];
  const imprecise: Array<{ candidate: CorridorCandidate; alongKm: number }> = [];

  // Imprecise rows are tested against a WIDER corridor than the precise ones.
  // Their stored coordinate is a centroid, so the true position can be tens of
  // km away; using the same 20 km cut would silently drop real neighbours
  // because their kommune's centre happens to sit on the far side of the
  // kommune. They are not being ranked on this number — only included or not —
  // so a generous cut is the conservative choice.
  const impreciseDetourKm = maxDetourKm + 30;

  // REVIEW N9: `prepared` is the SIMPLIFIED polyline, so its arc length is a
  // little shorter than the provider's true driving distance (Douglas-Peucker
  // cuts corners; measured drift 1.95 %-7.6 %, i.e. up to ~25 km on Oslo→Bodø).
  // The page prints «etter N km» from along_km next to «1 182 km kjøring» from
  // route.distanceKm — two numbers about the same journey that did not agree.
  // Rescale along_km onto the provider's distance so they do. Only when we HAVE
  // a real distance: in straight-line mode distanceKm is null (we refuse to
  // claim one), and 1.0 leaves along_km as the honest simplified arc length.
  const alongScale =
    route.distanceKm != null && prepared.lengthKm > 0
      ? route.distanceKm / prepared.lengthKm
      : 1;

  for (const c of candidates) {
    const hit = measureAgainstRoute({ lat: c.lat, lng: c.lng }, prepared);
    if (!hit) continue;

    if (isCorridorPrecise(c.precision)) {
      if (hit.detourKm > maxDetourKm) continue;
      // Straight-line mode: the offset is measured against a line that is not
      // the road, so it is not a fact about the drive. Suppress it exactly the
      // way a centroid row's distance is suppressed. along_km survives.
      const detourKm = straightLine ? null : hit.detourKm;
      precise.push({
        ...c,
        detourKm,
        alongKm: hit.alongKm * alongScale,
        label: labelFor(c, detourKm),
      });
    } else {
      if (hit.detourKm > impreciseDetourKm) continue;
      imprecise.push({ candidate: c, alongKm: hit.alongKm * alongScale });
    }
  }

  precise.sort((a, b) => a.alongKm - b.alongKm);

  // ── REVIEW N4: pick the BEST of each cluster, not the first ─────────
  // The greedy separation pass keeps whatever it sees first, so one mediocre
  // stop suppressed every better one behind it. pickBestPerCluster() elects the
  // lowest-detour member of each along-track cluster first; spaceOutAlongRoute()
  // then enforces the hard separation and the per-place quota on the winners.
  //
  // In straight-line mode detourKm is null for every row (we refuse to claim an
  // offset from a line that is not the road), so the score is Infinity across
  // the board and the pass degenerates to "keep the first of each cluster" —
  // the previous behaviour, which is the right fallback when there is genuinely
  // no basis to prefer one over another.
  const effectiveSeparationKm = resolveSeparationKm(minSeparationKm, route.distanceKm, prepared.lengthKm);
  const bestOfCluster = pickBestPerCluster(precise, {
    alongKm: (s) => s.alongKm,
    score: (s) => s.detourKm ?? Infinity,
    minSeparationKm: effectiveSeparationKm,
  });

  const spaced = spaceOutAlongRoute(bestOfCluster, {
    alongKm: (s) => s.alongKm,
    groupKey: (s) => s.place,
    maxPerGroup: maxPerPlace,
    minSeparationKm: effectiveSeparationKm,
  }).slice(0, limit);

  const approximate = buildApproximateGroups(imprecise, maxPerPlace);
  const queryMs = Date.now() - t0;

  if (spaced.length === 0 && approximate.length > 0) {
    notes.push(
      "Ingen av stedene langs denne ruten er stedfestet nøyaktig nok til at vi tør si hvor " +
        "langt de ligger fra veien. Under viser vi hvilke steder langs ruten som har noe å by på.",
    );
  }

  return {
    ok: true,
    from: { query: opts.from, name: fromGeo.name, lat: fromGeo.lat, lng: fromGeo.lng },
    to: { query: opts.to, name: toGeo.name, lat: toGeo.lat, lng: toGeo.lng },
    route: {
      kind: route.kind,
      provider: route.provider,
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      simplifiedPoints: prepared.points.length,
      sourcePoints: prepared.sourcePointCount,
      cached,
    },
    stops: spaced,
    approximate,
    notes,
    queryMs,
    counts: {
      scanned,
      precise: precise.length,
      imprecise: imprecise.length,
      afterSpacing: spaced.length,
    },
  };
}
