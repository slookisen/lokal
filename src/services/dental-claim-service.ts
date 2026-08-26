// --- Dental Claim Service PR-104 (2026-06-03) + PR-107 (2026-06-04) ---
//
// Multi-worker record-claim service for dental_agents.
//
// PR-107: fix zombie-claim bug.
//   sweepExpiredClaims() NULLs worker_id/claimed_at for expired rows so
//   they become visible to ORDER BY id scans again. Called inside
//   claimBatch transaction (before SELECT) and at top of claimStatus.

import { getDb } from "../database/db-factory";

export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type ClaimFilter = {
  // PR-120: thin_site is a valid enrichment_state; excluded from default pool below.
  enrichment_state?: "raw" | "enriched" | "thin_site";
  verification_status?: "pending_verify" | "verified" | "needs_review" | "rejected";
  has_hjemmeside?: boolean;
  has_adresse?: boolean;
  has_lat?: boolean;
  // dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
  // item 2a (2026-07-17): exclusion of clinics parked by 3 consecutive
  // extraction failures (30d backoff), mirroring the homepage-parking
  // excludeParked flag (dental-store.ts listDentalAgents) but for the
  // claim-batch pool instead of the read-side listing.
  //
  // dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 3
  // (dental measurement, 2026-07-30): flipped from opt-in to default-ON.
  // Measured against six consecutive daily dental-agent-enrichment run
  // reports (2026-07-25..07-30, dental-enrichment-runs/*.md): the SKILL's
  // completion-mode claim call (the ONLY mode that has run every single day
  // this week, since the raw+hjemmeside pool has been empty every day) never
  // set this flag -- only the raw-pool claim (§4.1) and the record-level
  // recordDentalExtractionResult reporting (§4.4) were wired up. The result
  // was directly observable and named by the enrichment agent itself:
  // "Jasleen Kaur Kainth" (Sunntannhelse.no, wrong-entity) was re-claimed and
  // re-flagged on 2026-07-24, 25, 26, 28 AND 30; "Spongdal Tannklinikk" was
  // explicitly logged as its "8th attempt" and "Leksvik Tannklinikk" its
  // "6th attempt" on 2026-07-30 -- all three permanently unenrichable
  // (county-directory pages / wrong chain, not the clinic's own site), well
  // past the 3-strike parking threshold this exclusion exists to enforce.
  // Every OTHER exclusion in this function (is_inactive, thin_site,
  // completion-mode completeness) is already unconditional-by-default; this
  // was the one outlier requiring an opt-in the caller silently never sent.
  // Backward-compatible: explicit `true` is unchanged (still applies the
  // clause); explicit `false` remains a no-op (opt-out escape hatch for a
  // caller that deliberately wants to see parked rows, e.g. review tooling);
  // only the OMITTED case flips from no-op to applied. Env
  // DENTAL_EXTRACTION_PARKING_DISABLED="true" is an additional global
  // rollback flag, mirroring DENTAL_HOMEPAGE_PARKING_DISABLED's idiom
  // (dental-store.ts) for the sibling homepage-parking exclusion.
  //
  // dev-request 2026-08-23-dental-wrong-entity-streak-parking (2026-08-24):
  // this SAME flag now also gates the independent wrong_entity_streak /
  // wrong_entity_unreachable_since exclusion (a separate 3-strike counter
  // for "fetched page describes a different clinic" results, distinct from
  // the insufficient-yield extraction failures this flag originally covered
  // -- see recordDentalExtractionResult()'s doc comment in dental-store.ts).
  //
  // dev-request 2026-08-26-dental-dead-homepage-no-strike-counter (2026-08-26):
  // this SAME flag now ALSO gates a THIRD, older, previously-unwired parking
  // mechanism: homepage_unreachable_since / homepage_fetch_attempts, set by
  // recordDentalHomepageFetchResult() in dental-store.ts (enrichment-metode
  // slice 1, 2026-07-16) and reported through POST /admin/homepage-fetch-
  // result (src/routes/dental.ts). That mechanism mirrors RFB PR #248 exactly
  // (3 consecutive fetch failures -> parked 30 days, any success -> full
  // reset) and has existed since 2026-07-16, but until now it was never
  // checked by this claim-pool query -- a homepage reported dead via that
  // endpoint kept being re-claimed and re-fetched every cycle regardless.
  // Wired onto this SAME flag/env var (no new flag) for the same reason
  // wrong_entity_unreachable_since was above: it is yet another independent
  // stamp-based parking signal already computed server-side, so there is no
  // reason for a caller to opt into it separately from the other two.
  excludeParkedExtraction?: boolean;
};

export type ClaimedRecord = {
  id: string;
  navn: string;
  org_nr: string;
  adresse: string | null;
  postnummer: string | null;
  poststed: string | null;
  hjemmeside: string | null;
  enrichment_state: string;
  verification_status: string;
};

// Build a parameterised WHERE-clause from a filter spec.
export function buildWhereClause(
  filter: ClaimFilter,
  now: number
): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  // Always: not currently claimed (worker_id IS NULL) OR expired claim
  conditions.push("(worker_id IS NULL OR claimed_at < ?)");
  params.push(now - CLAIM_TIMEOUT_MS);

  // PR-108 (2026-06-04): junk-exclusion. Records a worker has parked as
  // needs_review or rejected (e.g. non-dental Brreg residue: HEPRO, DPCOM,
  // LESS, dental labs, foreign pharma) must NOT re-enter the claim pool --
  // workers were re-claiming the same junk every cycle (4+ consecutive
  // cycles observed). Only applied when the caller does not explicitly
  // filter on verification_status, so review-queues remain reachable.
  if (filter.verification_status === undefined) {
    conditions.push(
      "(verification_status IS NULL OR verification_status NOT IN ('needs_review','rejected'))"
    );
  }

  // PR-120: thin_site parking exclusion. Records whose enrichment_state has
  // been set to thin_site (yielded <3 committable fields every cycle) are
  // excluded from the default claim pool -- workers kept re-claiming the same
  // records on every cycle. Only excluded when the caller does NOT explicitly
  // request thin_site records, so parked records remain reachable on demand.
  if (filter.enrichment_state !== "thin_site") {
    conditions.push("(enrichment_state IS NULL OR enrichment_state != 'thin_site')");
  }

  // PR-131 (2026-07-01): completion-mode already-complete exclusion. When a
  // worker's raw+hjemmeside pool is drained it falls back to completion mode
  // (enrichment_state=enriched) to deepen already-enriched records missing
  // rich fields (om_oss/treatments/opening_hours/specialists). The claim
  // query has no completeness filter, so every worker kept re-claiming the
  // SAME already-fully-populated head-of-list batch every cycle (claim ->
  // discover already complete -> release, 0 spawns), while 105+ genuinely
  // incomplete `enriched` records later in id-order were never reached
  // (supervisor-inbox headsup 2026-07-01, dental-agent-enrichment worker).
  // Exclude a row from the completion-mode pool ONLY when it is unambiguously
  // fully populated on all four rich fields -- mirrors the "release without
  // spawning" completeness check the worker SKILL already applies (SKILL
  // section 4.1), so this just moves that judgment earlier, into the pool
  // itself. `treatments`/`specialists` are JSON-array TEXT columns written
  // via jsonOrNull() (src/services/dental-store.ts), which never persists a
  // literal '[]' -- empty is always NULL -- but we still guard '[]' too
  // since other defensive reads in the codebase (e.g. dental-store.ts
  // specialist_clinic_count) do the same. `opening_hours` is a JSON-array
  // TEXT column guarded as NULL/'' elsewhere (src/routes/dental.ts
  // google-places-batch auto-select query); '[]'/'{}' are guarded too for
  // the same defensive reason. `om_oss` is plain TEXT, empty is NULL/''.
  // Only applied in completion-mode (enrichment_state === "enriched"); no
  // other filter combination is affected, so raw/thin_site pools and any
  // future explicit enrichment_state values are untouched.
  if (filter.enrichment_state === "enriched") {
    conditions.push(`
      NOT (
        om_oss IS NOT NULL AND om_oss <> ''
        AND treatments IS NOT NULL AND treatments <> '' AND treatments <> '[]'
        AND opening_hours IS NOT NULL AND opening_hours <> '' AND opening_hours <> '[]' AND opening_hours <> '{}'
        AND specialists IS NOT NULL AND specialists <> '' AND specialists <> '[]'
      )
    `.trim());
  }

  if (filter.enrichment_state !== undefined) {
    conditions.push("enrichment_state = ?");
    params.push(filter.enrichment_state);
  }
  if (filter.verification_status !== undefined) {
    conditions.push("verification_status = ?");
    params.push(filter.verification_status);
  }
  if (filter.has_hjemmeside === true) {
    conditions.push("hjemmeside IS NOT NULL AND hjemmeside <> ''");
  } else if (filter.has_hjemmeside === false) {
    conditions.push("(hjemmeside IS NULL OR hjemmeside = '')");
  }
  if (filter.has_adresse === true) {
    conditions.push("adresse IS NOT NULL AND adresse <> ''");
  } else if (filter.has_adresse === false) {
    conditions.push("(adresse IS NULL OR adresse = '')");
  }
  if (filter.has_lat === true) {
    conditions.push("lat IS NOT NULL");
  } else if (filter.has_lat === false) {
    conditions.push("lat IS NULL");
  }

  // dev-request 2026-07-16-dental-hjemmeside-url-vask, item 2 (nedlagt-
  // flagging): permanently-closed clinics (is_inactive=1, set via
  // /admin/dental/mark-inactive) must NEVER re-enter the claim pool -- a
  // closed clinic should never be enriched again. This is ALWAYS applied
  // (unconditional, no opt-out), mirroring the PR-108 junk-exclusion / PR-120
  // thin_site-parking conditions above: no caller can opt out.
  conditions.push("(is_inactive IS NULL OR is_inactive = 0)");

  // dev-request 2026-07-12-dental-enrichment-universe-growth-and-queue-hygiene,
  // item 2a: exclude clinics parked by 3 consecutive extraction failures
  // (extraction_unreachable_since set AND within the last 30 days), same
  // backoff window as the homepage-parking twin (dental-store.ts
  // DENTAL_PARK_BACKOFF_MS).
  //
  // dev-request 2026-08-23-dental-wrong-entity-streak-parking (2026-08-24):
  // ALSO exclude clinics parked by 3 consecutive wrong_entity results
  // (wrong_entity_unreachable_since set AND within the last 30 days) -- an
  // INDEPENDENT streak from extraction_attempts/extraction_unreachable_since
  // above (see recordDentalExtractionResult()'s doc comment, dental-store.ts,
  // for why the two counters are kept separate; mirrors the RFB
  // agent_knowledge.wrong_entity_streak twin, PR #309). A row is excluded if
  // EITHER stamp is actively parking it -- same 30-day window, same literal
  // `datetime('now','-30 days')` SQL style as the extraction clause, gated
  // by the SAME excludeParkedExtraction flag / rollback env var (no
  // separate new flag -- a wrong-entity result is reported through the same
  // POST /admin/extraction-result endpoint as an ordinary extraction
  // failure, so it shares that endpoint's exclusion toggle).
  //
  // dev-request 2026-07-29-blacklist-backfill-og-berikelsestriage, slice 3:
  // default-ON as of 2026-07-30 (see the ClaimFilter.excludeParkedExtraction
  // doc comment above for the measured evidence this is based on) -- applied
  // unless the caller explicitly passes `false` (opt-out, preserved for a
  // caller that deliberately wants parked rows back, e.g. review tooling) or
  // the env rollback flag is set.
  //
  // dev-request 2026-08-26-dental-dead-homepage-no-strike-counter (2026-08-26):
  // ALSO exclude clinics parked by homepage_unreachable_since -- a THIRD,
  // independent parking stamp, older than both of the above (set by
  // recordDentalHomepageFetchResult(), dental-store.ts, enrichment-metode
  // slice 1, 2026-07-16; reported via POST /admin/homepage-fetch-result,
  // src/routes/dental.ts) and mirroring RFB PR #248 exactly (3 consecutive
  // homepage-fetch failures -> parked 30 days, any success -> full reset).
  // That column pair already existed and was already being written by the
  // reporting endpoint, but this claim-pool query never read it -- so a
  // clinic whose homepage was reported dead kept being re-claimed and
  // re-fetched every cycle regardless. Same 30-day window, same literal
  // `datetime('now','-30 days')` SQL style, gated by the SAME
  // excludeParkedExtraction flag / DENTAL_EXTRACTION_PARKING_DISABLED
  // rollback env var as the other two stamps above (no new flag -- see the
  // ClaimFilter.excludeParkedExtraction doc comment for why an already-
  // computed server-side parking signal doesn't get its own opt-in).
  const extractionParkingDisabled = process.env.DENTAL_EXTRACTION_PARKING_DISABLED === "true";
  if (filter.excludeParkedExtraction !== false && !extractionParkingDisabled) {
    conditions.push(
      "(extraction_unreachable_since IS NULL OR extraction_unreachable_since <= datetime('now','-30 days'))"
    );
    conditions.push(
      "(wrong_entity_unreachable_since IS NULL OR wrong_entity_unreachable_since <= datetime('now','-30 days'))"
    );
    conditions.push(
      "(homepage_unreachable_since IS NULL OR homepage_unreachable_since <= datetime('now','-30 days'))"
    );
  }

  return { clause: conditions.join(" AND "), params };
}

// PR-107: Sweep expired claims -- NULL out worker_id/claimed_at for any
// row whose claimed_at is older than CLAIM_TIMEOUT_MS. Returns the
// number of rows cleared. Accepts an optional `now` timestamp so tests
// can inject a synthetic clock without monkey-patching Date.now().
//
// This is the authoritative fix for the zombie-claim bug: after the
// sweep, ORDER BY id scans see previously-stuck rows again, so
// claimBatch naturally reclaims them without any special-case logic.
export function sweepExpiredClaims(now: number = Date.now()): number {
  const db = getDb("dental");
  const cutoff = now - CLAIM_TIMEOUT_MS;
  const result = db
    .prepare(
      `UPDATE dental_agents SET worker_id = NULL, claimed_at = NULL
       WHERE worker_id IS NOT NULL AND claimed_at < ?`
    )
    .run(cutoff);
  return result.changes;
}

// Atomically claim up to `size` records. Returns the claimed records.
// Uses a single transaction so SELECT + UPDATE are atomic.
//
// PR-107: calls sweepExpiredClaims inside the transaction (before the
// SELECT) so that expired zombie rows are visible to ORDER BY id scans
// and can be reclaimed by any worker.
export function claimBatch(
  workerId: string,
  size: number,
  filter: ClaimFilter
): ClaimedRecord[] {
  if (!workerId || workerId.length > 64) throw new Error("invalid worker_id");
  if (size < 1 || size > 500) throw new Error("size must be 1..500");

  const db = getDb("dental");
  const now = Date.now();
  const { clause, params } = buildWhereClause(filter, now);

  const claim = db.transaction(() => {
    // PR-107: sweep expired claims first so zombie rows become
    // unclaimed and are visible to the ORDER BY id scan below.
    sweepExpiredClaims(now);

    const candidates = db
      .prepare(`SELECT id FROM dental_agents WHERE ${clause} ORDER BY id LIMIT ?`)
      .all(...params, size) as Array<{ id: string }>;

    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE dental_agents SET worker_id = ?, claimed_at = ? WHERE id IN (${placeholders})`
    ).run(workerId, now, ...ids);

    const claimed = db
      .prepare(
        `SELECT id, navn, org_nr, adresse, postnummer, poststed, hjemmeside, enrichment_state, verification_status
         FROM dental_agents WHERE id IN (${placeholders}) ORDER BY id`
      )
      .all(...ids) as ClaimedRecord[];
    return claimed;
  });

  return claim();
}

// Release a batch of records. Only records currently claimed by the
// supplied workerId are released -- a worker cannot release another
// worker's claims. (PR-107: semantics unchanged.)
export function releaseBatch(workerId: string, recordIds: string[]): number {
  if (!workerId) throw new Error("invalid worker_id");
  if (recordIds.length === 0) return 0;
  if (recordIds.length > 500) throw new Error("max 500 ids per release");

  const db = getDb("dental");
  const placeholders = recordIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE dental_agents SET worker_id = NULL, claimed_at = NULL WHERE worker_id = ? AND id IN (${placeholders})`
    )
    .run(workerId, ...recordIds);
  return result.changes;
}

// Status query: how many records are currently claimed by each worker,
// and how old the oldest claim is (helps spot stuck workers).
//
// PR-107: calls sweepExpiredClaims before querying so the result
// reflects only live (non-expired) claims. Without this, claimStatus
// would keep reporting zombie workers even though their claims have
// logically expired.
export function claimStatus(): Array<{
  worker_id: string;
  count: number;
  oldest_claim_age_ms: number;
}> {
  const db = getDb("dental");
  const now = Date.now();

  // PR-107: clear zombies so the count below reflects only live claims.
  sweepExpiredClaims(now);

  const rows = db
    .prepare(
      `SELECT worker_id, COUNT(*) AS count, MIN(claimed_at) AS oldest_claim_at
       FROM dental_agents
       WHERE worker_id IS NOT NULL
       GROUP BY worker_id`
    )
    .all() as Array<{ worker_id: string; count: number; oldest_claim_at: number }>;
  return rows.map((r) => ({
    worker_id: r.worker_id,
    count: r.count,
    oldest_claim_age_ms: now - r.oldest_claim_at,
  }));
}
