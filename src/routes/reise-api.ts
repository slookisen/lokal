// ─── /reise JSON API ─────────────────────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 2 +
// the machine-readable surface Fase 6's `reise_discover` MCP tool will call.
//
// One handler FACTORY, two mounts, and deliberately NOT one shared endpoint:
//
//   RFB          GET /api/marketplace/reise   sources: ['rfb']
//   OpplevAgent  GET /api/opplevelser/reise   sources: ['experience','gardssalg']
//
// Host isolation is a rule here, not a preference. `/api/*` passes THROUGH both
// host gates in index.ts (index.ts:300-326 and the dental equivalent), so a
// single shared route would happily serve opplevagent rows on
// rettfrabonden.com and vice versa. The dev-request's Fase 7 is explicit that
// cross-vertical federation «krever arkitekturbeslutning» — separate SQLite
// databases with deliberately isolated code paths — and 7c says host isolation
// must survive it. So this slice federates NOTHING: each mount is handed its
// own source list and its own database handle, and neither can reach the
// other's catalogue even by passing ?sources=.
//
// ── Response shape, designed for an LLM consumer ─────────────────────
// Compact and ordered, because a model pays for every token and reads
// top-to-bottom:
//   • `stops[]` is already in travel order — no sort key to interpret.
//   • every stop carries `along_km`, `detour_km`, `geo_precision`, `label`
//     and `url`, which is everything needed to say a sentence about it.
//   • `detour_km` is null rather than absent when we will not vouch for it,
//     so a model does not have to distinguish "missing" from "unknown".
//   • `detour_minutes` is reserved and documented as the field to PREFER once
//     Fase 4 fills it — the fjord problem (Molde→Vestnes: 12.8 km apart,
//     104 km / 118 min to drive) means detour_km ranks Norway badly.
//   • `approximate[]` is a separate array, not a flag on `stops[]`, so a naive
//     consumer that only reads `stops` cannot accidentally publish a
//     distance-free row as if it had a distance.
//   • `notes[]` is prose the caller is expected to relay verbatim.

import { Router, type Request, type Response } from "express";
import {
  corridorSearch,
  DEFAULT_MAX_DETOUR_KM,
  DEFAULT_MAX_PER_PLACE,
  DEFAULT_MIN_SEPARATION_KM,
  type CorridorSource,
  type CorridorSearchResult,
} from "../services/route-corridor-service";

/** Round for output. Nothing downstream reads finer than 0.1 km. */
function round1(n: number | null | undefined): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function parseIntParam(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Serialise a corridor result for the wire. snake_case, because this is the
 * surface an MCP tool and an OpenAPI schema describe — the rest of
 * /api/opplevelser already answers in snake_case, and the RFB marketplace API
 * is camelCase internally but its *geo* fields (distance_km, geo_precision)
 * are already snake_case for exactly this reason.
 */
export function serialiseCorridor(r: CorridorSearchResult) {
  if (!r.ok) {
    return {
      success: false,
      error: r.failure,
      reason: r.reason,
      stops: [],
      approximate: [],
      notes: r.notes,
    };
  }
  return {
    success: true,
    from: r.from ? { query: r.from.query, name: r.from.name, lat: r.from.lat, lng: r.from.lng } : null,
    to: r.to ? { query: r.to.query, name: r.to.name, lat: r.to.lat, lng: r.to.lng } : null,
    route: r.route
      ? {
          // 'road' | 'straight_line'. A consumer MUST check this: on
          // straight_line there is no road geometry, detour_km is null
          // throughout, and only the ORDER of stops is meaningful.
          kind: r.route.kind,
          provider: r.route.provider,
          distance_km: round1(r.route.distanceKm),
          duration_minutes: r.route.durationMinutes == null ? null : Math.round(r.route.durationMinutes),
          simplified_points: r.route.simplifiedPoints,
          source_points: r.route.sourcePoints,
        }
      : null,
    count: r.stops.length,
    stops: r.stops.map((s) => ({
      id: s.id,
      name: s.name,
      source: s.source,
      /** Km travelled along the route before this stop — the ordering key. */
      along_km: round1(s.alongKm),
      /**
       * Straight-line km from the route line. NOT a driving distance, and null
       * whenever we will not vouch for the number (straight-line mode).
       */
      detour_km: round1(s.detourKm),
      /**
       * Reserved for Fase 4 (a routing-matrix call). PREFER this over
       * detour_km once it is populated: in Norway a 12.8 km straight-line
       * offset can be a 118-minute drive.
       */
      detour_minutes: s.detourMinutes ?? null,
      /** Always 'address' on this list — see the allow-list in the service. */
      geo_precision: s.precision,
      place: s.place,
      /** Ready-to-print Norwegian phrase from the shared honesty helpers. */
      label: s.label,
      categories: s.categories,
      is_drink: !!s.isDrink,
      url: s.url,
    })),
    /**
     * Places along the route that HAVE something, where we do not know the
     * producer's position precisely enough to quote a distance. Items here
     * never carry along_km or detour_km — that is the point of the bucket, not
     * an oversight. Present them as "in this place, along your route".
     */
    approximate: r.approximate.map((g) => ({
      place: g.place,
      items: g.items.map((i) => ({
        id: i.id,
        name: i.name,
        source: i.source,
        geo_precision: i.precision,
        label: i.label,
        categories: i.categories,
        is_drink: !!i.isDrink,
        url: i.url,
      })),
    })),
    /** Relay these to the user verbatim. They explain what we did not do. */
    notes: r.notes,
    query_ms: r.queryMs,
  };
}

export interface ReiseApiOptions {
  /** Catalogues this mount may read. Not overridable by the request. */
  sources: CorridorSource[];
  /** Resolve the database handle(s) this mount needs, per request. */
  databases: () => { rfbDb?: any; experiencesDb?: any };
}

/**
 * Build the corridor API router for ONE vertical. The `sources` list is closed
 * over, never read from the query string — see the host-isolation note above.
 */
export function buildReiseApiRouter(opts: ReiseApiOptions): Router {
  const router = Router();

  router.get("/reise", async (req: Request, res: Response) => {
    const from = typeof req.query.from === "string" ? req.query.from.trim() : "";
    const to = typeof req.query.to === "string" ? req.query.to.trim() : "";

    if (!from || !to) {
      res.status(400).json({
        success: false,
        error: "missing_endpoints",
        reason: "Oppgi både ?from= og ?to= (for eksempel ?from=Oslo&to=Trondheim).",
      });
      return;
    }

    const via = ([] as string[]).concat(
      Array.isArray(req.query.via) ? (req.query.via as string[]) : typeof req.query.via === "string" ? [req.query.via] : [],
    ).map((v) => String(v).trim()).filter(Boolean);

    const dbs = opts.databases();

    let result: CorridorSearchResult;
    try {
      result = await corridorSearch({
        from,
        to,
        via,
        maxDetourKm: parseIntParam(req.query.detour_max_km, DEFAULT_MAX_DETOUR_KM),
        limit: parseIntParam(req.query.limit, 25),
        maxPerPlace: parseIntParam(req.query.max_per_place, DEFAULT_MAX_PER_PLACE),
        minSeparationKm: parseIntParam(req.query.min_separation_km, DEFAULT_MIN_SEPARATION_KM),
        drinkOnly: req.query.drink === "true" || req.query.interests === "drikke",
        sources: opts.sources,
        rfbDb: dbs.rfbDb,
        experiencesDb: dbs.experiencesDb,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: "internal",
        reason: "Reisesøket feilet. Prøv igjen om litt.",
      });
      return;
    }

    // A corridor we could not build is a 200 with success:false rather than a
    // 4xx: the request was well-formed, we simply have nothing honest to say.
    // The `error` code tells a machine which; `reason` tells a human.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(serialiseCorridor(result));
  });

  return router;
}
