// ─── RFB Geocode Invalidation Backfill (one-time) ───────────────────
// dev-request 2026-09-11-rettet-adresse-oppdaterer-ikke-kartpunktet, item 2
// ("Rydd etterslepet" — clear the pre-existing backlog).
//
// admin-knowledge.ts's PUT /admin/knowledge now resets a row's geocode fields
// whenever it actually changes address/postal_code (see that route's own
// "Geocode invalidation" block). That fixes every write from here on, but it
// cannot retroactively fix a row whose address was already corrected BEFORE
// that fix shipped — those rows sit at `geo_precision = 'address'` with a
// coordinate that was computed from an address which no longer exists in
// `agent_knowledge`, and agents-geocode-worker.ts's own selector treats
// `geo_precision = 'address'` as a CEILING it will never revisit (its
// IMPROVABLE predicate: `geo_precision IS NULL OR geo_precision <> 'address'`)
// — nothing else in the system was ever going to notice on its own.
//
// Concrete case this exists for: "Valens heimelaga" — address corrected to
// Nordagutuvegen, 3820 Nordagutu (~59.43/9.32); the stored coordinate stayed
// at ~59.69314/5.47994, near Haugesund — about 210 km away — across two
// customer complaints.
//
// NO RELIABLE TIMESTAMP TO DECIDE "changed after geocoded"
// ──────────────────────────────────────────────────────────
// The dev-request's preferred signal — "the address was corrected after the
// coordinate was set" — is not decidable from this schema. The only
// candidate columns are `agent_knowledge.updated_at` (bumped by ANY write
// through PUT /admin/knowledge — about/products/opening_hours/provenance
// merges, not just address/postal_code) and `agents.geocode_attempted_at`
// (bumped by every attempt the geocode WORKER makes, success or failure, and
// unrelated to when the address text itself last changed). Comparing them
// would produce false positives for the overwhelming majority of rows that
// have simply been enriched again since their last geocode, with no address
// change involved at all — exactly the "guess dressed as a measurement" this
// whole dev-request exists to remove. So per the spec's own fallback clause,
// this file implements ONLY the plausibility check.
//
// THE PLAUSIBILITY CHECK
// ───────────────────────
// For each candidate row (active, `geo_precision = 'address'`, has a current
// street address + postal_code, has a stored lat/lng — i.e. exactly the rows
// that CLAIM exact precision today), re-run the SAME Tier-A Kartverket
// lookup agents-geocode-worker.ts uses (geocodeOne(), the 4-step retry
// ladder) against the row's CURRENT address/postal_code/city. This is more
// precise than a generic "postal-code centroid" table (which does not exist
// in this codebase — there is no reverse postnummer->coordinate dataset;
// `geo-precision.ts`'s 'postal' tier is explicitly documented as "reserved:
// … Not produced by the Fase 1 worker … a later slice can start writing it").
// Comparing against a FRESH geocode of the row's own current address is a
// strictly better and more directly relevant signal than a coarse postal
// centroid would have been, and it costs nothing new: it is the exact same
// Kartverket call the geocode worker already makes for these rows, reused
// here read-only for comparison instead of write.
//
//   • fresh lookup MISSES (no_match)      -> REJECTED AS UNCERTAIN. We cannot
//     corroborate a problem, so — per "never write an uncertain point", the
//     same rule agents-postal-backfill.ts's header states — we do nothing.
//     The stored coordinate is left exactly as it was.
//   • fresh lookup HITS, within
//     IMPLAUSIBLE_DISTANCE_KM_THRESHOLD km of the stored point
//                                          -> plausible. No action.
//   • fresh lookup HITS, further than that -> RE-GEOCODE-FLAGGED. The stored
//     point is corroborated wrong. We CLEAR the geocode fields (the exact
//     same reset PUT /admin/knowledge now performs) so agents-geocode-
//     worker.ts's own selector picks the row up on its next tick and writes
//     the real coordinate itself.
//
// This function NEVER writes the freshly-looked-up lat/lng anywhere — it is
// used only to compute a distance and is then discarded. The only DB write
// this file ever makes is a CLEAR (NULLing/reset), never a new coordinate —
// satisfying the dev-request's "never write an uncorroborated/guessed
// coordinate" rule structurally, not just by convention.
//
// THRESHOLD
// ─────────
// 50 km, matching the dev-request's own suggested starting point. Norwegian
// postal-code areas and the retry ladder's own recovery steps (transliteration,
// house-letter-suffix stripping, street-only fallback) can legitimately move a
// resolved point a few km from an earlier attempt at the SAME address; 50 km
// safely separates that ordinary wobble from "wrong region entirely" — the
// measured failure class this dev-request is about (Haugesund/Nordagutu is
// ~210 km; the platform's own worked example elsewhere, «blåskjell
// Kautokeino» -> Larvik, is ~1400 km). Exported so ops can retune it without
// touching the selection/write logic.
//
// ONE-TIME, NOT A SCHEDULED WORKER
// ──────────────────────────────────
// Unlike agents-geocode-worker.ts / agents-postal-backfill.ts, this file adds
// NO new columns and NO scheduled tick — the dev-request calls it "Engangs-
// batch" (a one-time batch) and the realistic cohort is small (rows already
// claiming 'address' precision are a minority of active producers, and the
// sub-cohort whose CURRENT address disagrees with its stored point by >50 km
// is expected to be a handful, not hundreds — this dev-request found exactly
// one). A row that resolves as REJECTED AS UNCERTAIN or CONFIRMED PLAUSIBLE
// is not stamped, so a repeat call re-checks it; a FLAGGED row drops out of
// the `geo_precision = 'address'` selector the moment it is cleared, so
// repeat calls naturally converge on what is left. `limit` bounds each call
// (default 50, max 200, same clamp the other two RFB backfill workers use);
// raise it, or call again, to cover a larger backlog — see agentsGeocode-
// InvalidateBackfillQueueStatus() for the denominator.
//
// Rate limiting: routed through the SAME process-wide 2 req/s Kartverket
// budget (kartverket-budget.ts) the geocode + postal-backfill workers share —
// geocodeOne()'s retry ladder is handed a budgeted fetch exactly like
// agents-geocode-worker.ts's own Tier A call does, so all of this file's
// traffic is counted, not estimated.

import { getDb } from "../database/init";
import { geocodeOne, type GeocodeDeps } from "./dental-geocode-worker";
import { haversineDistanceKm } from "./geo-distance";
import { budgetedFetch } from "./kartverket-budget";

/**
 * A fresh re-check that disagrees with the stored point by more than this
 * (km) is treated as corroborated-wrong and flagged for re-geocode. See this
 * file's header for the measured justification.
 */
export const IMPLAUSIBLE_DISTANCE_KM_THRESHOLD = 50;

export type InvalidateBackfillDeps = GeocodeDeps & {
  /** Report what would change; write nothing. */
  dryRun?: boolean;
  /**
   * Keyset pagination cursor (dev-request 2026-09-11-geo-pagination) — the
   * last id the PREVIOUS call reported as `InvalidateBackfillResult.next_after`.
   * Without it, a row this call CONFIRMS PLAUSIBLE or REJECTS AS UNCERTAIN
   * keeps the exact same geo_precision='address' state, so a bare
   * `ORDER BY id LIMIT ?` re-selects it at the top of every subsequent call
   * forever and the tail of the eligible set past `limit` is never reached.
   * Absent/undefined means "start from the beginning".
   */
  after?: string;
};

export type InvalidateBackfillPlannedChange = {
  agent_id: string;
  name: string;
  address: string;
  postal_code: string;
  stored_lat: number;
  stored_lng: number;
  outcome: "re_geocode_flagged" | "rejected_uncertain" | "confirmed_plausible";
  /** Distance between the stored point and the fresh re-check, when one exists. */
  distance_km: number | null;
  detail: string;
};

export type InvalidateBackfillResult = {
  dry_run: boolean;
  processed: number;
  /** Corroborated wrong (fresh re-check disagrees by more than the threshold) — geocode fields cleared. */
  re_geocode_flagged: number;
  /** No fresh re-check could be obtained (Kartverket no_match) — left untouched, never guessed. */
  rejected_uncertain: number;
  /** Fresh re-check agrees with the stored point within the threshold — left untouched. */
  confirmed_plausible: number;
  errors: number;
  duration_ms: number;
  planned: InvalidateBackfillPlannedChange[];
  /** Keyset pagination cursor — the id of the last row scanned this call, or null once the page came back shorter than `limit` (nothing left eligible). Pass back as `deps.after` on the next call. */
  next_after: string | null;
};

type CandidateRow = {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  address: string;
  postal_code: string;
  city: string | null;
};

/** Only rows that CLAIM exact precision today and have what Tier A needs to re-check them. */
const CANDIDATE_WHERE = `
  a.is_active = 1
  AND a.geo_precision = 'address'
  AND a.lat IS NOT NULL AND a.lng IS NOT NULL
  AND k.address IS NOT NULL AND TRIM(k.address) <> ''
  AND k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> ''
`;

/** Denominator for the admin endpoint — how many rows this batch could still check. */
export function agentsGeocodeInvalidateBackfillQueueStatus(): { eligible: number } {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE ${CANDIDATE_WHERE}`
    )
    .get() as any;
  return { eligible: row?.n ?? 0 };
}

function emptyStats(dryRun: boolean): InvalidateBackfillResult {
  return {
    dry_run: dryRun,
    processed: 0,
    re_geocode_flagged: 0,
    rejected_uncertain: 0,
    confirmed_plausible: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    next_after: null,
  };
}

/**
 * One pass over up to `limit` eligible rows. See this file's header for the
 * full decision rule. Never writes a new coordinate — the only write is a
 * CLEAR of the seven geocode fields (mirrors PUT /admin/knowledge's own
 * invalidation), and only for a row corroborated wrong.
 */
export async function agentsGeocodeInvalidateBackfillTick(
  limit: number = 50,
  deps: InvalidateBackfillDeps = {}
): Promise<InvalidateBackfillResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const stats = emptyStats(dryRun);
  const after = typeof deps.after === "string" ? deps.after : "";

  const candidates = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.lat AS lat, a.lng AS lng, a.city AS city,
              k.address AS address, k.postal_code AS postal_code
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE ${CANDIDATE_WHERE}
          AND a.id > ?
        ORDER BY a.id ASC
        LIMIT ?`
    )
    .all(after, limit) as CandidateRow[];
  // Keyset cursor for the NEXT call — see InvalidateBackfillDeps.after's own
  // comment for why a plain `ORDER BY id LIMIT ?` re-selects an unchanged row
  // forever without it.
  stats.next_after = candidates.length === limit && candidates.length > 0 ? candidates[candidates.length - 1].id : null;

  // Same reset PUT /admin/knowledge's own invalidation performs — guarded by
  // `geo_precision = 'address'` so a concurrent change between SELECT and
  // UPDATE (e.g. this same row being corrected again mid-batch) cannot
  // clobber a state this tick no longer has accurate information about.
  const clearGeocode = db.prepare(
    `UPDATE agents
        SET geo_precision = NULL, lat = NULL, lng = NULL,
            geocode_source = NULL, geocode_outcome = NULL,
            geocode_attempts = 0, geocode_attempted_at = NULL
      WHERE id = ? AND geo_precision = 'address'`
  );

  for (const row of candidates) {
    stats.processed++;
    try {
      const address = (row.address || "").trim();
      const postal = (row.postal_code || "").trim();
      const city = (row.city || "").trim();

      const hit = await geocodeOne(address, postal, city, {
        ...deps,
        fetchImpl: budgetedFetch(deps.fetchImpl ?? fetch, sleep),
      });

      if (hit.confidence === "no_match") {
        stats.rejected_uncertain++;
        stats.planned.push({
          agent_id: row.id,
          name: row.name ?? "",
          address,
          postal_code: postal,
          stored_lat: row.lat,
          stored_lng: row.lng,
          outcome: "rejected_uncertain",
          distance_km: null,
          detail: "fresh re-check of the current address found no Kartverket match — cannot corroborate either way; left untouched",
        });
        continue;
      }

      const distanceKm = haversineDistanceKm(row.lat, row.lng, hit.lat, hit.lng);
      if (distanceKm > IMPLAUSIBLE_DISTANCE_KM_THRESHOLD) {
        stats.re_geocode_flagged++;
        stats.planned.push({
          agent_id: row.id,
          name: row.name ?? "",
          address,
          postal_code: postal,
          stored_lat: row.lat,
          stored_lng: row.lng,
          outcome: "re_geocode_flagged",
          distance_km: Math.round(distanceKm * 10) / 10,
          detail:
            `fresh re-check of the current address places it ${Math.round(distanceKm)} km from the stored point ` +
            `(threshold ${IMPLAUSIBLE_DISTANCE_KM_THRESHOLD} km) — geocode fields cleared for re-attempt`,
        });
        if (!dryRun) {
          clearGeocode.run(row.id);
        }
      } else {
        stats.confirmed_plausible++;
        stats.planned.push({
          agent_id: row.id,
          name: row.name ?? "",
          address,
          postal_code: postal,
          stored_lat: row.lat,
          stored_lng: row.lng,
          outcome: "confirmed_plausible",
          distance_km: Math.round(distanceKm * 10) / 10,
          detail: `fresh re-check agrees with the stored point within ${IMPLAUSIBLE_DISTANCE_KM_THRESHOLD} km — left untouched`,
        });
      }
    } catch (err) {
      stats.errors++;
      console.error(`[agents-geocode-invalidate-backfill] failed for ${row.id}:`, err);
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;
}
