// ─── Experience filter tags — derived, additive-only ────────────────
//
// Daniel (dev-request, 2026-07): cross-cutting FILTER TAGS instead of new
// categories for experiences (hikes, museums, activities, ...) — explicitly
// "tags/filters only, no new categories". This module is the derivation
// logic only: a pure function that maps an experience record → a list of
// tag strings. No schema change, no new column, no backfill job.
//
// Why computed-at-read-time rather than a persisted/backfilled column:
// every condition below is a cheap comparison against fields that already
// exist on the `experiences` row (see src/database/init-experiences.ts) —
// there's no expensive aggregation or cross-table join to cache, so a
// persisted derived column would just be a second source of truth that can
// drift from the fields it's derived from. This mirrors the existing
// gardssalgVisible() convention in src/routes/experiences-seo.ts (compute
// live from existing columns) rather than the backfill-script convention
// used for genuinely expensive/external enrichment (e.g. phone/email
// provenance backfills in src/services/search-enrich*.ts).
//
// Wired into src/services/experience-store.ts's hydrateExperience(), so
// every experience returned by discoverExperiences() / getExperienceById() /
// getPublishedExperienceBySlug() carries a `tags` field for free.
//
// UI filter-chips / badges that DISPLAY these tags are a LATER slice — this
// only emits the derived list.

export const EXPERIENCE_TAGS = [
  "familievennlig",
  "gratis",
  "under-300",
  "tilgjengelig",
  "værsikker",
  "sesong",
] as const;
export type ExperienceTag = (typeof EXPERIENCE_TAGS)[number];

/** NOK threshold behind the `under-300` tag. Named/exported so a later slice
 *  can add more price bands (e.g. `under-500`) without re-deriving the
 *  concept — see also DiscoverFilterSchema's `max_price` param, which this
 *  intentionally mirrors in spirit but is NOT wired into (this is a fixed
 *  marketing threshold, not a user-supplied one). */
export const UNDER_PRICE_THRESHOLD_NOK = 300;

/**
 * The subset of the `experiences` row that tag derivation actually reads.
 * Kept as its own narrow interface (rather than importing the full
 * `Experience` type from experience-store.ts) so this module has zero
 * dependency on the DB layer and stays trivially unit-testable — and so it
 * can't accidentally widen the write-side Zod schema by import cycle.
 */
export interface TaggableExperience {
  age_suitability?: "all" | "family" | "adults" | "kids" | null;
  min_age?: number | null;
  price_band?: string | null;
  price_from?: number | null;
  indoor_outdoor?: "indoor" | "outdoor" | "both" | null;
  weather_dependent?: 0 | 1 | null;
  accessibility?: string[] | null;
  season?: string[] | null;
  seasonal_valid_from?: string | null;
  seasonal_valid_to?: string | null;
}

/**
 * Derive the cross-cutting filter tags for one experience.
 *
 * Pure, additive-only: never mutates the input, never throws on missing or
 * partial data (harvested rows are frequently incomplete — the absence of a
 * field simply means that tag's condition doesn't fire). Order of the
 * returned array follows EXPERIENCE_TAGS.
 */
export function deriveExperienceTags(exp: TaggableExperience): ExperienceTag[] {
  const tags: ExperienceTag[] = [];

  // familievennlig — age_suitability says the experience targets everyone /
  // families / kids, AND there's no explicit min_age that contradicts it
  // (defensive: a harvested row could carry age_suitability='family' with a
  // stale/bad-source min_age=18 — the numeric field wins as the tiebreaker).
  const familyBySuitability =
    exp.age_suitability === "all" ||
    exp.age_suitability === "family" ||
    exp.age_suitability === "kids";
  const adultOnlyByMinAge = typeof exp.min_age === "number" && exp.min_age >= 18;
  if (familyBySuitability && !adultOnlyByMinAge) {
    tags.push("familievennlig");
  }

  // gratis — explicit 'gratis' price band, or a confirmed price_from of 0.
  const isFree = exp.price_band === "gratis" || exp.price_from === 0;
  if (isFree) {
    tags.push("gratis");
  }

  // under-300 — priced (not free — 'gratis' already covers that case) and at
  // or below the threshold.
  if (
    typeof exp.price_from === "number" &&
    exp.price_from > 0 &&
    exp.price_from <= UNDER_PRICE_THRESHOLD_NOK
  ) {
    tags.push("under-300");
  }

  // tilgjengelig — has at least one documented accessibility accommodation.
  // The `accessibility` column has no fixed vocabulary (free-text harvest
  // data, e.g. "rullestolvennlig", "teleslynge"), so "non-empty" is the
  // conservative, non-overfit signal rather than matching specific phrases.
  if (Array.isArray(exp.accessibility) && exp.accessibility.length > 0) {
    tags.push("tilgjengelig");
  }

  // værsikker — weather-proof: indoor, or explicitly not weather-dependent.
  // Deliberately narrower than discoverExperiences()'s rain/snow heuristic
  // (which also treats indoor_outdoor='both' as rain-friendly) — a tag that
  // claims "weather-safe" should not cover a partly-outdoor experience.
  const isWeatherSafe = exp.indoor_outdoor === "indoor" || exp.weather_dependent === 0;
  if (isWeatherSafe) {
    tags.push("værsikker");
  }

  // sesong — restricted to specific season(s), or has an explicit seasonal
  // validity window. A `season` of just ['year_round'] (or empty/absent) is
  // NOT seasonal.
  const seasonList = Array.isArray(exp.season) ? exp.season : [];
  const isSeasonRestricted =
    (seasonList.length > 0 && !(seasonList.length === 1 && seasonList[0] === "year_round")) ||
    Boolean(exp.seasonal_valid_from) ||
    Boolean(exp.seasonal_valid_to);
  if (isSeasonRestricted) {
    tags.push("sesong");
  }

  return tags;
}
