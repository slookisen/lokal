// ─── Geo precision vocabulary + honesty rule (RFB) ──────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1
// (1a column vocabulary, 1c honesty rule).
//
// Pure module — no DB, no network — so the worker (agents-geocode-worker.ts),
// the registry (marketplace-registry.ts), the HTML/MCP renderers and the tests
// all share ONE definition of "how precisely do we actually know where this
// producer is".
//
// Why this exists: 948 of 1 499 active RFB producers carry seed-time hardcoded
// coordinates (src/_seeds/seed-expansion-v2.ts) that are frequently a CITY
// CENTROID, not the farm. Rendering "2,4 km unna" off a city centroid is a
// fabricated number. The experiences vertical already solved the same problem
// with `experiences.geo_precision` + formatDistanceLabel() (experience-store.ts);
// this is the RFB half of the same rule.
//
// Vocabulary (agents.geo_precision):
//   'address' — geocoded from a real street address via Kartverket
//               adresser/v1/sok. The ONLY tier allowed to claim a km figure.
//   'postal'  — reserved: a postal-area representative point. Approximate, so
//               it is a centroid tier for honesty purposes. Not produced by
//               the Fase 1 worker (no postal-only tier is implemented yet) —
//               declared here so the column's value set is fixed up front and
//               a later slice can start writing it without a second migration
//               or a second honesty review.
//   'city'    — a Kartverket Stedsnavn/Kommuneinfo point for the producer's
//               free-text `city`. Approximate: somewhere in that place.
//   'kommune' — a municipality centroid. Approximate, coarsest tier.
//   null      — UNKNOWN provenance. Every pre-Fase-1 row is null: it may be a
//               real farm coordinate or a seed centroid, we cannot tell. Left
//               rendering exactly as it did before this slice (no silent
//               behaviour change for 948 producers on deploy); the worker
//               resolves rows out of this state into an honest tier over time.

export type GeoPrecision = "address" | "postal" | "city" | "kommune";

/**
 * Ordinal quality of a precision tier. Higher is better. Unknown/null is 0 so
 * "never downgrade" comparisons work without special-casing null.
 *
 * NOTE the deliberate asymmetry: 'address' (4) is the only tier the honesty
 * rule treats as exact, but 'postal' > 'city' > 'kommune' still matters to the
 * worker's never-downgrade guard — a kommune centroid must never overwrite a
 * city point.
 */
export const GEO_PRECISION_RANK: Record<string, number> = {
  address: 4,
  postal: 3,
  city: 2,
  kommune: 1,
};

/** Rank of a stored precision value; 0 for null/unknown/garbage. */
export function precisionRank(p: string | null | undefined): number {
  if (!p) return 0;
  return GEO_PRECISION_RANK[p] ?? 0;
}

/**
 * True when `candidate` is a strict improvement over `existing`.
 * The worker's never-downgrade guard: a run that only manages a kommune
 * centroid must leave an existing address-precision row alone.
 */
export function isPrecisionUpgrade(
  existing: string | null | undefined,
  candidate: GeoPrecision
): boolean {
  return precisionRank(candidate) > precisionRank(existing);
}

/**
 * The honesty rule. True only for tiers where a rendered "X km" figure is a
 * real measurement rather than a distance to a centroid.
 *
 * null is NOT exact-but-not-suppressed: see the vocabulary note above — legacy
 * rows keep their pre-Fase-1 rendering, and callers pass them through
 * unchanged. Suppression is opt-in via an explicit centroid tag, which is why
 * this returns false for null and `shouldSuppressDistance()` (below) — the one
 * the renderers actually call — is a separate predicate.
 */
export function isExactPrecision(p: string | null | undefined): boolean {
  return p === "address";
}

/**
 * The predicate the search/rendering path uses: hide the km figure when we
 * KNOW the position is a centroid. An untagged (null) legacy row is not
 * suppressed — we have no evidence either way and suppressing 948 producers'
 * distances on deploy is a bigger lie-by-omission than the status quo.
 */
export function shouldSuppressDistance(p: string | null | undefined): boolean {
  if (!p) return false;
  return !isExactPrecision(p);
}

/**
 * RFB counterpart of experience-store.ts's formatDistanceLabel() — same rule,
 * different vocabulary (RFB has a free-text `city`, no kommune column).
 *
 *   'address' + a number  → "2,4 km unna"
 *   centroid tier         → "i Vadsø-området" (never a km figure)
 *   unknown (null)        → null, caller renders as before
 */
export function formatRfbDistanceLabel(
  distanceKm: number | null | undefined,
  geoPrecision: string | null | undefined,
  city?: string | null
): string | null {
  if (isExactPrecision(geoPrecision) && typeof distanceKm === "number" && Number.isFinite(distanceKm)) {
    const km = distanceKm.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${km} km unna`;
  }
  if (shouldSuppressDistance(geoPrecision)) {
    return city ? `i ${city}-området` : "omtrentlig posisjon";
  }
  return null;
}
