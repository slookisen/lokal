// ─── Experiences Geocode Worker — dev-request 2026-07-04-opplevagent-naer-meg-geosok
// (item 1 of 4, 2026-07-10) ──────────────────────────────────────────────
//
// Backend Kartverket-based geocoding worker for the experiences vertical.
// Mirrors src/services/dental-geocode-worker.ts's pattern (idempotent SQL
// work-queue, injectable fetch/sleep deps for tests, try/catch-per-row so
// one bad record never crashes the tick) but adds a second tier: unlike
// dental_agents (each row IS an address-bearing entity), the experiences
// vertical is harvest-first — `experiences` rows often have no provider_id
// yet, and even when they do, an experience has no address of its own; its
// location comes from its provider. So this worker runs FOUR steps per
// tick, in order:
//
//   Step A — geocode experience_providers' street addresses via the
//            Kartverket adresse-API 4-step retry ladder (reusing
//            geocodeOne/kartverketQuery/transliterate/stripHouseLetterSuffix
//            from dental-geocode-worker.ts — those helpers are already
//            generic, taking plain address/postnummer/poststed strings).
//   Step D — for providers Step A could not (or will never usefully) place
//            at address precision, fall back to a kommune/fylke-centroid
//            lookup via geocodingService, tagged geocode_confidence=
//            'approximate' so the profile page can render it honestly
//            (added 2026-07-12, dev-request gardssalg-go-live-gate slice 3
//            — rural gårdssalg addresses often never resolve via the
//            adresse-API even though the kommune is known).
//   Step B — propagate a just-(or previously-)geocoded provider's REAL
//            address-precision lat/lon down to any of its experiences that
//            don't have a location yet (geo_precision='address'). Step D's
//            approximate fallback is deliberately excluded from this
//            propagation (see Step B's own comment below) — geo_precision=
//            'address' is the near-me search honesty rule (formatDistanceLabel(),
//            discoverExperiences()'s radius filter/sort all trust it to mean
//            a real street address).
//   Step C — for experiences that still have no location (unmatched to a
//            provider, or matched to a provider whose address geocoding
//            failed / is still pending), fall back to a kommune-centroid
//            lookup via geocodingService (geo_precision='kommune'). This
//            hits the Kartverket Stedsnavn API (not the adresse API), which
//            geocodingService already caches in-memory — cheap, and the
//            kommune namespace is small (~360) so it converges fast.
//
// Disable via env var RFB_DISABLE_EXPERIENCES_GEOCODE=1 (used in tests / dev).
// Gated in src/index.ts by ENABLE_EXPERIENCES=1 as well (no point ticking
// against a DB handle that isn't open).

import { getDb } from "../database/db-factory";
import {
  geocodeOne,
  type GeocodeDeps,
} from "./dental-geocode-worker";
import { geocodingService } from "./geocoding-service";

const VERTICAL = "experiences";

export type ExperiencesGeocodeResult = {
  providers_processed: number;
  providers_high: number;
  providers_medium: number;
  providers_low: number;
  providers_no_match: number;
  providers_kommune_fallback: number;
  providers_fallback_unresolved: number;
  experiences_address_precision: number;
  experiences_kommune_precision: number;
  experiences_unresolved: number;
  errors: number;
  duration_ms: number;
};

// Re-exported so callers/tests can inject the same deps shape used by
// dental-geocode-worker without importing that module directly.
export type { GeocodeDeps };

/**
 * Main tick. Runs Step A (provider address geocoding), Step D (provider
 * kommune/fylke-centroid fallback for providers Step A couldn't resolve at
 * address precision), Step B (propagate provider location -> experiences),
 * Step C (kommune-centroid fallback for experiences still unresolved), each
 * capped at `limit` rows so a large backlog can't runaway a single tick.
 * Sequential and deterministic (ORDER BY id) so re-runs are reproducible.
 */
export async function experiencesGeocodeTick(
  limit: number = 50,
  deps: GeocodeDeps = {}
): Promise<ExperiencesGeocodeResult> {
  const start = Date.now();
  const db = getDb(VERTICAL);
  const stats: ExperiencesGeocodeResult = {
    providers_processed: 0,
    providers_high: 0,
    providers_medium: 0,
    providers_low: 0,
    providers_no_match: 0,
    providers_kommune_fallback: 0,
    providers_fallback_unresolved: 0,
    experiences_address_precision: 0,
    experiences_kommune_precision: 0,
    experiences_unresolved: 0,
    errors: 0,
    duration_ms: 0,
  };

  // ─── Step A — provider address geocoding ───────────────────────────
  // Exact mirror of dental-geocode-worker's WHERE clause: excludes both
  // successfully-geocoded rows (lat IS NOT NULL) and prior no_match rows
  // (geocode_confidence='no_match'), so the worker is naturally idempotent
  // across ticks and never re-hammers a dead address.
  const providerRows = db
    .prepare(
      `SELECT id, adresse, postnummer, poststed
       FROM experience_providers
       WHERE adresse IS NOT NULL
         AND adresse <> ''
         AND postnummer IS NOT NULL
         AND postnummer <> ''
         AND lat IS NULL
         AND geocode_confidence IS NULL
       ORDER BY id
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    adresse: string;
    postnummer: string;
    poststed: string | null;
  }>;

  const updateProviderGeocoded = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kartverket', geocode_confidence = ?,
            updated_at = datetime('now')
      WHERE id = ?`
  );
  const updateProviderNoMatch = db.prepare(
    `UPDATE experience_providers
        SET geocode_source = 'kartverket', geocode_confidence = 'no_match',
            updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of providerRows) {
    try {
      const result = await geocodeOne(
        row.adresse,
        row.postnummer,
        row.poststed ?? "",
        deps
      );
      stats.providers_processed++;

      if (result.confidence === "no_match") {
        stats.providers_no_match++;
        updateProviderNoMatch.run(row.id);
      } else {
        if (result.confidence === "high") stats.providers_high++;
        else if (result.confidence === "medium") stats.providers_medium++;
        else if (result.confidence === "low") stats.providers_low++;
        updateProviderGeocoded.run(result.lat, result.lng, result.confidence, row.id);
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] provider geocoding failed for ${row.id}:`, err);
    }
  }

  // ─── Step D — provider kommune/fylke-centroid fallback ─────────────
  // (numbered D, not C, to match the pre-existing Step C below it — this
  // fills the gap dev-request 2026-07-12-gardssalg-go-live-gate-dark-launch-
  // og-onboarding slice 3 calls out: rural gårdssalg addresses often never
  // resolve via the Kartverket adresse-API, so Step A leaves them
  // geocode_confidence='no_match' and the profile page's map block shows
  // "posisjon ikke registrert" forever — even though the provider's own
  // kommune/fylke IS known and geocodable. Mirrors Step C's kommune-centroid
  // lookup, but writes the PROVIDER's own lat/lon (not an experience's), and
  // only for rows Step A could not (or will never usefully) resolve at
  // address precision — never overwrites a real address-level geocode.
  // geocode_confidence='approximate' tags the result distinctly from
  // Step A's high/medium/low tiers so the profile route can render an
  // honest "ca. posisjon" label instead of claiming address precision.
  const providerFallbackRows = db
    .prepare(
      `SELECT id, kommune, fylke
         FROM experience_providers
        WHERE lat IS NULL
          AND (
            geocode_confidence = 'no_match'
            OR (
              geocode_confidence IS NULL
              AND (adresse IS NULL OR adresse = '' OR postnummer IS NULL OR postnummer = '')
            )
          )
          AND ((kommune IS NOT NULL AND kommune <> '') OR (fylke IS NOT NULL AND fylke <> ''))
        ORDER BY id
        LIMIT ?`
    )
    .all(limit) as Array<{ id: string; kommune: string | null; fylke: string | null }>;

  const updateProviderApprox = db.prepare(
    `UPDATE experience_providers
        SET lat = ?, lon = ?, geocode_source = 'kommune_fallback', geocode_confidence = 'approximate',
            updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of providerFallbackRows) {
    try {
      let geo = row.kommune ? await geocodingService.geocode(row.kommune) : null;
      if (!geo && row.fylke) {
        geo = await geocodingService.geocode(row.fylke);
      }
      if (geo) {
        updateProviderApprox.run(geo.lat, geo.lng, row.id);
        stats.providers_kommune_fallback++;
      } else {
        // Genuine "can't resolve" -- same discipline as Step C: no
        // negative-cache column for this tier, left to retry next tick
        // (cheap once geocodingService's in-memory cache is warm).
        stats.providers_fallback_unresolved++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] provider kommune fallback failed for ${row.id}:`, err);
    }
  }

  // ─── Step B — propagate provider location -> experiences ──────────
  // Any experience still missing a location, matched to a provider that
  // already has a usable, address-precision geocode result. Single SQL
  // statement via a join, capped at `limit` rows per tick.
  //
  // Excludes 'approximate' (Step D's kommune/fylke-centroid fallback) as
  // well as 'no_match' — this UPDATE always writes geo_precision='address',
  // which formatDistanceLabel() (experience-store.ts) and discoverExperiences()'s
  // haversine radius filter/sort treat as a genuine street-address-level
  // position (the near-me search "honesty rule"). Propagating an approximate
  // provider position here would silently mislabel it as exact and corrupt
  // "within X km" results. Step D's approximate fallback is scoped to the
  // provider's own profile-page map for now (dev-request gardssalg-go-live-
  // gate slice 3) — propagating it to experiences is a distinct, un-asked-for
  // feature left for a future slice if wanted.
  try {
    const propagateRows = db
      .prepare(
        `SELECT e.id AS id, p.lat AS lat, p.lon AS lon
           FROM experiences e
           JOIN experience_providers p ON p.id = e.provider_id
          WHERE e.loc_lat IS NULL
            AND e.geo_precision IS NULL
            AND e.provider_id IS NOT NULL
            AND p.lat IS NOT NULL
            AND p.lon IS NOT NULL
            AND p.geocode_confidence IS NOT NULL
            AND p.geocode_confidence NOT IN ('no_match', 'approximate')
          ORDER BY e.id
          LIMIT ?`
      )
      .all(limit) as Array<{ id: string; lat: number; lon: number }>;

    const updateExperienceAddress = db.prepare(
      `UPDATE experiences
          SET loc_lat = ?, loc_lon = ?, geo_precision = 'address', updated_at = datetime('now')
        WHERE id = ?`
    );

    for (const row of propagateRows) {
      try {
        updateExperienceAddress.run(row.lat, row.lon, row.id);
        stats.experiences_address_precision++;
      } catch (err) {
        stats.errors++;
        console.error(`[experiences-geocode] provider->experience propagation failed for ${row.id}:`, err);
      }
    }
  } catch (err) {
    stats.errors++;
    console.error("[experiences-geocode] Step B (propagate) failed:", err);
  }

  // ─── Step C — kommune-centroid fallback ────────────────────────────
  // Covers unmatched experiences AND experiences whose provider has no
  // usable address / failed geocoding. Kommune name-space is small and
  // geocodingService caches lookups in-memory, so this converges fast
  // and never grows unbounded even though a failed lookup here doesn't
  // set any negative-cache column (there's no confidence tier for it,
  // just a genuine "can't resolve yet" -- retried next tick).
  const fallbackRows = db
    .prepare(
      `SELECT id, kommune, fylke
         FROM experiences
        WHERE loc_lat IS NULL
          AND geo_precision IS NULL
          AND kommune IS NOT NULL
          AND kommune <> ''
        ORDER BY id
        LIMIT ?`
    )
    .all(limit) as Array<{ id: string; kommune: string; fylke: string | null }>;

  const updateExperienceKommune = db.prepare(
    `UPDATE experiences
        SET loc_lat = ?, loc_lon = ?, geo_precision = 'kommune', updated_at = datetime('now')
      WHERE id = ?`
  );

  for (const row of fallbackRows) {
    try {
      let geo = await geocodingService.geocode(row.kommune);
      if (!geo && row.fylke) {
        geo = await geocodingService.geocode(row.fylke);
      }
      if (geo) {
        updateExperienceKommune.run(geo.lat, geo.lng, row.id);
        stats.experiences_kommune_precision++;
      } else {
        // Genuine "can't resolve" -- no negative-cache column exists for
        // this tier, so leave geo_precision NULL and let it retry next
        // tick (cheap: cached after first hit, small kommune namespace).
        stats.experiences_unresolved++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[experiences-geocode] kommune fallback failed for ${row.id}:`, err);
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}
