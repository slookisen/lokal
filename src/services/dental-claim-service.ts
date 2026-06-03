// ─── Dental Claim Service — PR-104 (2026-06-03) ─────────────────────
//
// Multi-worker record-claim service for dental_agents.
//
// Each Claude-based scheduled task spawns with a unique worker_id (e.g.
// "dental-worker-1", "dental-worker-2"). Workers call /admin/dental/claim-batch
// to atomically reserve up to N records for processing. Records auto-release
// after CLAIM_TIMEOUT_MS so a crashed worker can't lock them forever.
//
// Filter shapes (supported now):
//   - { enrichment_state: "raw" }
//   - { enrichment_state: "enriched", verification_status: "pending_verify" }
//   - { enrichment_state: "raw", has_hjemmeside: true }
//   - { enrichment_state: "raw", has_adresse: true, has_lat: false }
//
// More filters can be added — keep allow-listed to prevent SQL-injection.

import { getDb } from "../database/db-factory";

export const CLAIM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type ClaimFilter = {
  enrichment_state?: "raw" | "enriched";
  verification_status?: "pending_verify" | "verified" | "needs_review" | "rejected";
  has_hjemmeside?: boolean;
  has_adresse?: boolean;
  has_lat?: boolean;
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

// Build a parameterised WHERE-clause from a filter spec. Returns
// {clause, params}. Filter keys are allow-listed; any unknown key is
// silently ignored (callers pass an allow-listed ClaimFilter type).
export function buildWhereClause(
  filter: ClaimFilter,
  now: number
): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  // Always: not currently claimed (worker_id IS NULL) OR expired claim
  conditions.push("(worker_id IS NULL OR claimed_at < ?)");
  params.push(now - CLAIM_TIMEOUT_MS);

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

  return { clause: conditions.join(" AND "), params };
}

// Atomically claim up to `size` records. Returns the claimed records.
// Uses a single transaction so SELECT + UPDATE are atomic with respect
// to other workers calling claimBatch concurrently.
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

  // Use a transaction so SELECT + UPDATE is atomic per worker.
  const claim = db.transaction(() => {
    const candidates = db
      .prepare(`SELECT id FROM dental_agents WHERE ${clause} ORDER BY id LIMIT ?`)
      .all(...params, size) as Array<{ id: string }>;

    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE dental_agents SET worker_id = ?, claimed_at = ? WHERE id IN (${placeholders})`
    ).run(workerId, now, ...ids);

    // Return the now-claimed records with full data needed for processing.
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

// Release a batch of records. Workers should call this after processing
// to free records for re-claim (or immediately if processing fails).
// Only records currently claimed by the supplied workerId are released —
// a worker cannot release another worker's claims.
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
export function claimStatus(): Array<{
  worker_id: string;
  count: number;
  oldest_claim_age_ms: number;
}> {
  const db = getDb("dental");
  const now = Date.now();
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
