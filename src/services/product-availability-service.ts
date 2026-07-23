/**
 * Product Availability Service — Local Supply Graph v1
 * (dev-request 2026-07-23-supplygraph).
 *
 * Write path for a claimed producer's per-product availability
 * (in_stock/seasonal/sold_out), stored directly on the SQL `products` table
 * — deliberately NOT routed through knowledgeService.ownerUpdate() /
 * PUT /agents/:id/knowledge, which overwrites the whole freetext
 * agent_knowledge.products blob and has no concept of a SQL products.id.
 * See src/routes/marketplace.ts's PATCH /agents/:id/products/:productId/
 * availability for the HTTP entry point and its auth.
 *
 * Read-time freshness/auto-expiry (Pattern A — no cron sweep) lives in
 * src/config/supply-graph.ts (effectiveAvailability()); this file only
 * concerns itself with the WRITE side.
 */

import { getDb } from "../database/init";
import { isValidProductAvailability, type ProductAvailability } from "../config/supply-graph";

// ─── Test-DB override (module-local, race-proof) ─────────────────────────────
// Same idiom as cart-service.ts / trust-event-service.ts: production always
// has _productAvailabilityTestDb === null -> getDb(). Tests call
// __setProductAvailabilityTestDb(db) to pin an in-memory DB without touching
// the global __setDbForTesting singleton.
let _productAvailabilityTestDb: any = null;
export function __setProductAvailabilityTestDb(db: any): void {
  _productAvailabilityTestDb = db;
}

// ─── field_provenance shape ──────────────────────────────────────────────────
// Same JSON-object-of-arrays shape as agent_knowledge.field_provenance:
//   { "availability": [{ value, source_type, fetched_at }, ...] }
export interface AvailabilityProvenanceRecord {
  value: string;
  source_type: string;
  fetched_at: string;
}

// Cap array growth. A producer flipping availability daily for years would
// otherwise grow this column unboundedly; only the recent history is
// actually useful (this is a lightweight audit trail, not an analytics
// ledger — cf. consumer_usage_ledger for the aggregate-only pattern used
// where longer history genuinely matters).
const FIELD_PROVENANCE_MAX_RECORDS = 20;

function mergeAvailabilityProvenance(
  existingJson: string | null | undefined,
  value: string,
  sourceType: string,
  fetchedAt: string,
): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
    } catch {
      // Malformed/legacy value -> start fresh rather than throw. A write
      // must never be blocked by a corrupt provenance blob.
    }
  }
  const priorRaw = (existing as Record<string, unknown>).availability;
  const prior = Array.isArray(priorRaw) ? priorRaw : [];
  const record: AvailabilityProvenanceRecord = { value, source_type: sourceType, fetched_at: fetchedAt };
  const merged = [...prior, record].slice(-FIELD_PROVENANCE_MAX_RECORDS);
  return { ...existing, availability: merged };
}

export interface ProductAvailabilityRow {
  id: string;
  agent_id: string;
  availability: string;
  availability_updated_at: string | null;
  field_provenance: string;
}

export type SetProductAvailabilityResult =
  | { ok: true; product: ProductAvailabilityRow }
  | { ok: false; reason: "invalid_availability" }
  | { ok: false; reason: "not_found" };

export interface SetProductAvailabilityInput {
  agentId: string;
  productId: string;
  availability: string;
  /** field_provenance.source_type — defaults to 'owner' (a producer using
   *  their own claim token / API key). Admin-key callers should pass
   *  'admin' explicitly so the provenance trail distinguishes the two. */
  sourceType?: string;
}

/**
 * Set a product's availability. Ownership is enforced by the WHERE clause
 * (id = ? AND agent_id = ?) — a productId that exists but belongs to a
 * DIFFERENT agent is indistinguishable from a productId that does not exist
 * at all, both from the caller's perspective (reason: "not_found") and in
 * the SQL itself, so this function can never leak cross-agent product
 * existence.
 */
export function setProductAvailability(input: SetProductAvailabilityInput): SetProductAvailabilityResult {
  if (!isValidProductAvailability(input.availability)) {
    return { ok: false, reason: "invalid_availability" };
  }
  const availability: ProductAvailability = input.availability;
  const db = _productAvailabilityTestDb ?? getDb();

  const existing = db
    .prepare("SELECT id, agent_id, field_provenance FROM products WHERE id = ? AND agent_id = ?")
    .get(input.productId, input.agentId) as
    | { id: string; agent_id: string; field_provenance: string | null }
    | undefined;

  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const fetchedAt = new Date().toISOString();
  const provenance = mergeAvailabilityProvenance(
    existing.field_provenance,
    availability,
    input.sourceType || "owner",
    fetchedAt,
  );
  const provenanceJson = JSON.stringify(provenance);

  db.prepare(
    `UPDATE products
        SET availability = ?,
            availability_updated_at = datetime('now'),
            updated_at = datetime('now'),
            field_provenance = ?
      WHERE id = ? AND agent_id = ?`,
  ).run(availability, provenanceJson, input.productId, input.agentId);

  const updated = db
    .prepare(
      "SELECT id, agent_id, availability, availability_updated_at, field_provenance FROM products WHERE id = ?",
    )
    .get(input.productId) as ProductAvailabilityRow;

  return { ok: true, product: updated };
}
