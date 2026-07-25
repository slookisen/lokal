// ─── RFB Agents Geocode Worker ──────────────────────────────────────
// dev-request 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 1a.
//
// The `agents` table (rettfrabonden.com producers) was the ONLY vertical
// without a geocoding worker: dental has dental-geocode-worker.ts, experiences
// has experiences-geocode-worker.ts, RFB had nothing. Coordinates came from
// seed files (src/_seeds/seed-expansion-v2.ts:55,73) and were often a city
// centroid. Measured live 2026-07-25: 948 / 1 499 active producers (63.2 %)
// have lat/lng; 551 (36.8 %) have NONE and are invisible to every geo-filtered
// search. Fase 2's route-corridor search at 10–25 km is meaningless on top of
// that, which is why this lands first.
//
// Structure is deliberately the experiences worker's (same batching, same
// injectable fetch/sleep seam, same try/catch-per-row so one bad record can
// never crash a tick, same "ORDER BY … LIMIT" work-queue), with two additions
// the RFB table needs:
//
//   Tier A — address precision. agent_knowledge.address + postal_code →
//            Kartverket adresser/v1/sok via geocodeOne() (the SAME 4-step
//            retry ladder dental + experiences already use — not
//            re-implemented here). Writes geo_precision='address'.
//   Tier B — city-centroid fallback, ONLY for rows that have no coordinates
//            at all. Goes through geocodingService.geocode(), i.e. the Fase-0
//            hardened lookup, so it inherits the navneobjekttype allowlist,
//            the `navnestatus` name-similarity guard and the ambiguity
//            refusal ("blåskjell Kautokeino" → Larvik is rejected, not
//            stored). Writes geo_precision='city' (or 'kommune' when the hit
//            is an administrative area), which the honesty rule
//            (geo-precision.ts, 1c) then renders WITHOUT a km figure.
//
// Two invariants:
//   • NEVER DOWNGRADE. A tick that only manages a centroid must leave an
//     existing better-precision row untouched (isPrecisionUpgrade()).
//     Tier B additionally refuses to move a row that already has any
//     coordinates — replacing an unlabelled seed coordinate with a city
//     centroid is not obviously an improvement, and we would be guessing.
//   • ALWAYS STAMP. agents.geocode_attempted_at is written on every attempt,
//     whatever the outcome, and the selector orders by it (never-attempted
//     first, then oldest). Same lesson as the homepage-provenance-batch
//     rotation fix (dev-request 2026-07-19): a selector keyed on a column the
//     failure paths don't write re-picks the identical batch forever
//     (measured there: 3 consecutive calls, identical processed=13 batch).
//
// Dry-run: deps.dryRun = true performs the same lookups and reports what WOULD
// change, but takes no write — not even the attempt stamp. Safe to point at
// prod.
//
// Rate limiting: geocodeOne() sleeps THROTTLE_MS (350 ms) after every
// Kartverket request including the successful one, so a tick is naturally
// paced at ≥350 ms/row; Tier B additionally sleeps between rows because
// geocodingService has no throttle of its own (it is normally called once per
// user request, not in a loop).
//
// Disable via env var RFB_DISABLE_AGENTS_GEOCODE=1 (used in tests / dev).

import { getDb } from "../database/init";
import { geocodeOne, type GeocodeDeps } from "./dental-geocode-worker";
import { geocodingService } from "./geocoding-service";
import { isPrecisionUpgrade, type GeoPrecision } from "./geo-precision";

// Tier B's inter-row pacing (Tier A is paced by geocodeOne's own throttle).
const CENTROID_THROTTLE_MS = 350;

export type AgentsGeocodeDeps = GeocodeDeps & {
  /** Report what would change; write nothing (not even the attempt stamp). */
  dryRun?: boolean;
};

export type AgentsGeocodePlannedChange = {
  agent_id: string;
  name: string;
  from_precision: string | null;
  to_precision: GeoPrecision | null;
  lat: number | null;
  lng: number | null;
  outcome: string;
};

export type AgentsGeocodeResult = {
  dry_run: boolean;
  /** Rows selected and attempted this tick. */
  processed: number;
  /** Rows that gained (or would gain) address precision. */
  address_precision: number;
  /** Address hits by the retry ladder's confidence tier. */
  address_high: number;
  address_medium: number;
  address_low: number;
  /** Rows placed (or would be placed) at a city/kommune centroid. */
  centroid_precision: number;
  /** Rows where every lookup missed — stamped, retried much later. */
  no_match: number;
  /** Rows where a result existed but was not an upgrade (never downgrade). */
  skipped_no_upgrade: number;
  errors: number;
  duration_ms: number;
  /** Populated on dry runs so an admin can see exactly what a real run does. */
  planned: AgentsGeocodePlannedChange[];
  /** True when the single-flight guard turned this call into a no-op. */
  skipped_already_running: boolean;
};

type CandidateRow = {
  id: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  geo_precision: string | null;
  address: string | null;
  postal_code: string | null;
};

// ── Strictly-increasing attempt stamps ──────────────────────────────
// datetime('now') has 1-second granularity, and a tick with a warm geocode
// cache can stamp a whole batch inside the same second — which would make the
// "oldest attempt first" ordering fall back to the `id` tiebreaker and hand
// the NEXT tick the exact same rows. Monotonic ms stamps make consecutive
// batches provably disjoint.
let lastStampMs = 0;
function nextAttemptStamp(): string {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString();
}

// ── Single-flight guard (review follow-up 6) ────────────────────────
// The hourly setInterval tick and an admin POST /admin/agents/geocode-batch
// can overlap. Selection happens up front and the attempt stamp is only
// written when a row FINISHES, so two concurrent ticks select the identical
// batch: measured 4/4 overlap and 8 Kartverket requests for 4 rows. The
// outcome is benign (same writes, never-downgrade holds) but it doubles load
// on a free public API and makes a dry run's `planned` list misleading.
// A module-level flag is enough — this worker is single-process by design.
let running = false;

// ── Admin-request parsing (pure, unit-tested) ───────────────────────
// Extracted from the route so the two decisions that actually matter are
// testable without touching process.env.ADMIN_KEY — the shared global behind
// this repo's documented cart-*/gardssalg-claim/orch-pr-9 test races.

export const GEOCODE_BATCH_LIMIT_DEFAULT = 50;
export const GEOCODE_BATCH_LIMIT_MAX = 200;

/** Clamp a caller-supplied batch limit into [1, 200]; non-numbers → default. */
export function clampGeocodeBatchLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : GEOCODE_BATCH_LIMIT_DEFAULT;
  return Math.max(1, Math.min(GEOCODE_BATCH_LIMIT_MAX, n));
}

/**
 * Parse the dry_run flag STRICTLY (review B4).
 *
 * `body.dry_run === true` fails OPEN: `{"dry_run":"true"}` — the obvious curl
 * typo, and JSON-stringified booleans are common from shell scripts — is not
 * `true`, so it silently performed a REAL WRITE against production. This
 * endpoint exists precisely to rehearse against prod, so failing open defeats
 * its purpose. Anything that is not a real boolean is now rejected rather than
 * interpreted. (The repo's other dry_run endpoints use the loose convention,
 * but none of them is a prod-mutation rehearsal switch.)
 */
export function parseDryRunFlag(raw: unknown): { ok: true; dryRun: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, dryRun: false };
  if (typeof raw === "boolean") return { ok: true, dryRun: raw };
  return {
    ok: false,
    error:
      `dry_run må være en boolsk verdi (true/false uten anførselstegn) — fikk ${JSON.stringify(raw)}. ` +
      `Avvist i stedet for tolket: en feilskrevet dry_run ville ellers ha kjørt en ekte skriving mot produksjon.`,
  };
}

/**
 * Work-queue counts for the admin endpoint / ops. Cheap: one table scan.
 */
export function agentsGeocodeQueueStatus(): {
  active: number;
  address_precision: number;
  centroid_precision: number;
  unknown_precision: number;
  missing_coordinates: number;
  pending: number;
  never_attempted: number;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS active,
         COUNT(*) FILTER (WHERE a.geo_precision = 'address') AS address_precision,
         COUNT(*) FILTER (WHERE a.geo_precision IN ('postal','city','kommune')) AS centroid_precision,
         COUNT(*) FILTER (WHERE a.geo_precision IS NULL) AS unknown_precision,
         COUNT(*) FILTER (WHERE a.lat IS NULL OR a.lng IS NULL) AS missing_coordinates,
         COUNT(*) FILTER (WHERE a.geocode_attempted_at IS NULL) AS never_attempted,
         COUNT(*) FILTER (
           WHERE (a.geo_precision IS NULL OR a.geo_precision <> 'address')
             AND (
               (k.address IS NOT NULL AND TRIM(k.address) <> ''
                AND k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')
               OR ((a.lat IS NULL OR a.lng IS NULL) AND a.city IS NOT NULL AND TRIM(a.city) <> '')
             )
         ) AS pending
       FROM agents a
       LEFT JOIN agent_knowledge k ON k.agent_id = a.id
       WHERE a.is_active = 1`
    )
    .get() as any;
  return {
    active: row?.active ?? 0,
    address_precision: row?.address_precision ?? 0,
    centroid_precision: row?.centroid_precision ?? 0,
    unknown_precision: row?.unknown_precision ?? 0,
    missing_coordinates: row?.missing_coordinates ?? 0,
    pending: row?.pending ?? 0,
    never_attempted: row?.never_attempted ?? 0,
  };
}

function emptyStats(dryRun: boolean): AgentsGeocodeResult {
  return {
    dry_run: dryRun,
    processed: 0,
    address_precision: 0,
    address_high: 0,
    address_medium: 0,
    address_low: 0,
    centroid_precision: 0,
    no_match: 0,
    skipped_no_upgrade: 0,
    errors: 0,
    duration_ms: 0,
    planned: [],
    skipped_already_running: false,
  };
}

/**
 * One tick. Selects up to `limit` active producers that could still improve,
 * runs Tier A then Tier B per row, and stamps every attempt so the next tick
 * picks a disjoint batch.
 *
 * Single-flight (review follow-up 6): if a tick is already in progress this
 * returns immediately with skipped_already_running=true rather than selecting
 * — and re-fetching — the same batch a second time.
 */
export async function agentsGeocodeTick(
  limit: number = 50,
  deps: AgentsGeocodeDeps = {}
): Promise<AgentsGeocodeResult> {
  if (running) {
    console.log("[agents-geocode] tick skipped — a tick is already running");
    return { ...emptyStats(deps.dryRun === true), skipped_already_running: true };
  }
  running = true;
  try {
    return await runAgentsGeocodeTick(limit, deps);
  } finally {
    running = false;
  }
}

async function runAgentsGeocodeTick(
  limit: number,
  deps: AgentsGeocodeDeps
): Promise<AgentsGeocodeResult> {
  const start = Date.now();
  const dryRun = deps.dryRun === true;
  const db = getDb();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const stats: AgentsGeocodeResult = emptyStats(dryRun);

  // ── Candidate selection ───────────────────────────────────────────
  // A row is worth a lookup when it is active, is not already at address
  // precision (the ceiling — nothing here can improve on it), and has either
  //   • a street address + postnummer  → Tier A can run, or
  //   • no coordinates at all + a city → Tier B can at least make it visible.
  // Rotation: never-attempted rows first (the `IS NOT NULL` expression sorts
  // false=0 before true=1), then oldest attempt.
  const candidates = db
    .prepare(
      `SELECT a.id AS id, a.name AS name, a.lat AS lat, a.lng AS lng, a.city AS city,
              a.geo_precision AS geo_precision,
              k.address AS address, k.postal_code AS postal_code
         FROM agents a
         LEFT JOIN agent_knowledge k ON k.agent_id = a.id
        WHERE a.is_active = 1
          AND (a.geo_precision IS NULL OR a.geo_precision <> 'address')
          AND (
                (k.address IS NOT NULL AND TRIM(k.address) <> ''
                 AND k.postal_code IS NOT NULL AND TRIM(k.postal_code) <> '')
             OR ((a.lat IS NULL OR a.lng IS NULL) AND a.city IS NOT NULL AND TRIM(a.city) <> '')
          )
        ORDER BY (a.geocode_attempted_at IS NOT NULL), a.geocode_attempted_at ASC, a.id ASC
        LIMIT ?`
    )
    .all(limit) as CandidateRow[];

  // geocode_prev_lat/lng capture the coordinate this worker is about to
  // overwrite (review follow-up 10), in the SAME statement so there is no
  // window where the old value is lost but the new one is not yet written.
  // Tier A replaces seed coordinates in place, so without this the
  // dev-request's "kan stoppes" rollback restores nothing.
  const updatePosition = db.prepare(
    `UPDATE agents
        SET geocode_prev_lat = lat, geocode_prev_lng = lng,
            lat = ?, lng = ?, geo_precision = ?, geocode_source = ?,
            geocode_outcome = ?, geocode_attempted_at = ?
      WHERE id = ?`
  );
  const updateAttemptOnly = db.prepare(
    `UPDATE agents
        SET geocode_outcome = ?, geocode_attempted_at = ?
      WHERE id = ?`
  );

  for (const row of candidates) {
    stats.processed++;
    try {
      const address = (row.address || "").trim();
      const postal = (row.postal_code || "").trim();
      const city = (row.city || "").trim();

      let wrote = false;

      // ── Tier A — real street address via the Kartverket adresse ladder ──
      if (address && postal) {
        const hit = await geocodeOne(address, postal, city, deps);
        if (hit.confidence !== "no_match") {
          if (isPrecisionUpgrade(row.geo_precision, "address")) {
            stats.address_precision++;
            if (hit.confidence === "high") stats.address_high++;
            else if (hit.confidence === "medium") stats.address_medium++;
            else stats.address_low++;
            record(row, "address", hit.lat, hit.lng, "kartverket_adresse", hit.confidence);
            wrote = true;
          } else {
            // Unreachable today (the selector excludes 'address' rows) but
            // kept as the explicit never-downgrade guard so a future selector
            // change cannot silently start overwriting better data.
            stats.skipped_no_upgrade++;
            recordAttemptOnly(row, "skipped_no_upgrade");
            wrote = true;
          }
        }
      }

      // ── Tier B — city centroid, only for rows with NO position at all ──
      // Deliberately not applied to rows that already have coordinates: an
      // untagged seed coordinate might be the actual farm, and swapping it for
      // a city centroid would be a guess dressed as an improvement.
      if (!wrote && (row.lat === null || row.lng === null) && city) {
        const geo = await geocodingService.geocode(city);
        await sleep(CENTROID_THROTTLE_MS);
        if (geo) {
          const t = (geo.placeType || "").toLowerCase().trim();
          const precision: GeoPrecision =
            t === "kommune" || t === "fylke" || t === "annen administrativ inndeling"
              ? "kommune"
              : "city";
          // geo.source is the geocoding-service tier that answered
          // ("kartverket" = Stedsnavn, "kommuneinfo" = the kommune register,
          // "hardcoded"/"database"/"cache" = local tables). Recorded verbatim
          // apart from disambiguating Stedsnavn from the adresse API, since
          // both would otherwise read "kartverket".
          const source = geo.source === "kartverket" ? "kartverket_stedsnavn" : geo.source;
          if (isPrecisionUpgrade(row.geo_precision, precision)) {
            stats.centroid_precision++;
            record(row, precision, geo.lat, geo.lng, source, "city_centroid");
          } else {
            stats.skipped_no_upgrade++;
            recordAttemptOnly(row, "skipped_no_upgrade");
          }
          wrote = true;
        }
      }

      // ── Nothing resolved — stamp anyway so the row rotates out ──────
      if (!wrote) {
        stats.no_match++;
        recordAttemptOnly(row, "no_match");
      }
    } catch (err) {
      stats.errors++;
      console.error(`[agents-geocode] failed for ${row.id}:`, err);
      // REVIEW B3: the ALWAYS-STAMP invariant this file's header states was
      // not honoured on the error path. A row that throws every tick (bad
      // upstream data, a persistent DNS/TLS failure for its address) kept
      // NULL geocode_attempted_at, so the selector re-picked the identical
      // head of the queue forever and everything behind the LIMIT starved —
      // at limit=50, fifty persistently-erroring rows silently halt the whole
      // backfill and the only symptom is `errors=50` in an hourly log line.
      // Stamping an 'error' outcome rotates them out; they come back round
      // once the rest of the universe has been attempted.
      try {
        recordAttemptOnly(row, "error");
      } catch (stampErr) {
        // Guard the guard: if the DB itself is the thing failing, a throw here
        // would abort the whole tick and lose the rows already processed.
        console.error(`[agents-geocode] could not stamp attempt for ${row.id}:`, stampErr);
      }
    }
  }

  stats.duration_ms = Date.now() - start;
  return stats;

  function record(
    row: CandidateRow,
    precision: GeoPrecision,
    lat: number,
    lng: number,
    source: string,
    outcome: string
  ): void {
    stats.planned.push({
      agent_id: row.id,
      name: row.name ?? "",
      from_precision: row.geo_precision,
      to_precision: precision,
      lat,
      lng,
      outcome,
    });
    if (dryRun) return;
    updatePosition.run(lat, lng, precision, source, outcome, nextAttemptStamp(), row.id);
  }

  function recordAttemptOnly(row: CandidateRow, outcome: string): void {
    stats.planned.push({
      agent_id: row.id,
      name: row.name ?? "",
      from_precision: row.geo_precision,
      to_precision: null,
      lat: null,
      lng: null,
      outcome,
    });
    if (dryRun) return;
    updateAttemptOnly.run(outcome, nextAttemptStamp(), row.id);
  }
}
