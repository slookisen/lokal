// ─── provider-work-queue.ts ─────────────────────────────────────────────
// Shared hand-off queue between the three gårdssalg pipelines (ownership-
// verification sweep, content-enrichment "berikelse", and website-discovery
// "discovery") so they hand each other work instead of silently dropping
// cases — dev-request 2026-08-17-forsyningskjede-samarbeid-og-
// kvalitetsoppdatering, Skive 1.
//
// Backing table: provider_work_queue (src/database/init-experiences.ts).
// Four producers/consumers, wired at their call sites elsewhere:
//   - sweep -> discovery, reason "missing_source"
//   - sweep -> discovery, reason "evidence_url_rejected" (payload carries the
//     rejected candidate URL so discovery never blindly re-proposes it)
//   - berikelse -> discovery, reason "parked_needs_replacement"
//   - discovery -> sweep (resolved when a discovered candidate is approved
//     and written to a provider's hjemmeside column)

import { v4 as uuid } from "uuid";
import { getDb } from "../database/db-factory";

const VERTICAL = "experiences";

export type ProviderWorkQueueEntry = {
  provider_id: string;
  provider_name?: string | null;
  from_system: string;
  to_system: string;
  reason: string;
  payload?: string | null;
  batch_id?: string | null;
};

export type ProviderWorkQueueRow = {
  id: string;
  provider_id: string;
  provider_name: string | null;
  from_system: string;
  to_system: string;
  reason: string;
  payload: string | null;
  batch_id: string | null;
  requested_at: string;
};

/**
 * Enqueue one provider_work_queue item — idempotent: if an UNRESOLVED row
 * already exists for the same (provider_id, to_system, reason), this is a
 * no-op (anti-churn, same spirit as the other queue tables in this
 * codebase — don't pile up duplicate asks for the same thing).
 */
export function enqueueProviderWorkQueueItem(entry: ProviderWorkQueueEntry): { enqueued: boolean } {
  const db = getDb(VERTICAL);
  const existing = db
    .prepare(
      `SELECT id FROM provider_work_queue
       WHERE provider_id = ? AND to_system = ? AND reason = ? AND resolved_at IS NULL
       LIMIT 1`
    )
    .get(entry.provider_id, entry.to_system, entry.reason);
  if (existing) {
    return { enqueued: false };
  }
  db.prepare(
    `INSERT INTO provider_work_queue
       (id, provider_id, provider_name, from_system, to_system, reason, payload, batch_id, requested_at)
     VALUES (@id, @provider_id, @provider_name, @from_system, @to_system, @reason, @payload, @batch_id, datetime('now'))`
  ).run({
    id: uuid(),
    provider_id: entry.provider_id,
    provider_name: entry.provider_name ?? null,
    from_system: entry.from_system,
    to_system: entry.to_system,
    reason: entry.reason,
    payload: entry.payload ?? null,
    batch_id: entry.batch_id ?? null,
  });
  return { enqueued: true };
}

/**
 * Mark every pending (unresolved) provider_work_queue row for
 * (providerId, toSystem) as resolved with the given outcome. Returns the
 * number of rows changed.
 */
export function resolveProviderWorkQueueItems(providerId: string, toSystem: string, outcome: string): number {
  const db = getDb(VERTICAL);
  const result = db
    .prepare(
      `UPDATE provider_work_queue SET resolved_at = datetime('now'), outcome = ?
       WHERE provider_id = ? AND to_system = ? AND resolved_at IS NULL`
    )
    .run(outcome, providerId, toSystem);
  return result.changes;
}

/**
 * List pending (unresolved) provider_work_queue rows targeted at
 * `toSystem`, oldest-requested first.
 */
export function listPendingProviderWorkQueue(toSystem: string, limit?: number): ProviderWorkQueueRow[] {
  const db = getDb(VERTICAL);
  const sql =
    `SELECT id, provider_id, provider_name, from_system, to_system, reason, payload, batch_id, requested_at
     FROM provider_work_queue
     WHERE to_system = ? AND resolved_at IS NULL
     ORDER BY requested_at ASC` + (typeof limit === "number" ? ` LIMIT ?` : "");
  const rows = typeof limit === "number"
    ? db.prepare(sql).all(toSystem, limit)
    : db.prepare(sql).all(toSystem);
  return rows as ProviderWorkQueueRow[];
}
