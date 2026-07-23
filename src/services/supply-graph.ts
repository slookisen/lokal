/**
 * supply-graph.ts — Supply-graph v1, Slice 1 (dev-request
 * 2026-07-13-supply-graph-v1).
 *
 * Backend/data-layer only in this slice: no HTTP route wiring, no
 * owner-portal / auth changes. Two pieces:
 *
 *   1. computeEffectiveAvailability() — a pure function that decides whether
 *      a product's stored `availability` value is still trustworthy enough
 *      to show, or has gone stale because a producer set it themselves and
 *      then went quiet. Enrichment-sourced rows (the overwhelming majority
 *      today — there is no producer input yet) always pass through
 *      unchanged; only `producer_dashboard`-sourced rows can go stale.
 *
 *   2. setProducerAvailability() — the write path a future owner-portal
 *      endpoint will call. Mirrors the id-linking pattern already used by
 *      getCatalogProductIdMap() in src/routes/mcp.ts: look up the ONE
 *      products row for (agent_id, name_norm), then update it, scoping the
 *      UPDATE's WHERE to both id AND agent_id so a producer can never touch
 *      another agent's product.
 *
 * Both functions are exported for direct unit testing
 * (src/services/supply-graph.test.ts) and are not yet called from any route.
 */

import { getDb } from "../database/init";

// ─── Config ─────────────────────────────────────────────────────────────
// Default staleness window, in days, past which a producer_dashboard-sourced
// availability value is no longer trusted and is reported as 'unknown'.
// Overridable via env SUPPLY_GRAPH_STALE_DAYS. Read at call time (not module
// load) so it always reflects the running configuration — same pattern as
// getRetentionWindowDays() in src/services/traffic-stats.ts.
const DEFAULT_SUPPLY_GRAPH_STALE_DAYS = 14;

export function getSupplyGraphStaleDays(): number {
  const raw = process.env.SUPPLY_GRAPH_STALE_DAYS;
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SUPPLY_GRAPH_STALE_DAYS;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Timestamp parsing ──────────────────────────────────────────────────
// products.availability_updated_at is written via SQLite's datetime('now'),
// which yields "YYYY-MM-DD HH:MM:SS" (space-separated, UTC, no offset).
// `new Date(...)` parses that form inconsistently across JS engines (some
// treat it as local time), so normalize to a real ISO-8601 UTC string first.
// Also accepts already-ISO strings (e.g. from tests) unchanged.
function parseTimestamp(ts: string): Date {
  let s = ts.trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) s = s + "Z";
  return new Date(s);
}

/**
 * Decide the availability value that should actually be shown for a
 * product, given its raw stored value plus provenance.
 *
 * - `source === 'producer_dashboard'` AND `availabilityUpdatedAt` is more
 *   than `getSupplyGraphStaleDays()` days older than `now` (or is `null` —
 *   treated as maximally stale, since it means "never producer-set") →
 *   `'unknown'`.
 * - Everything else (fresh producer_dashboard rows, and ALL
 *   enrichment-sourced rows regardless of age — there is no producer input
 *   to go stale yet) → `availability` unchanged.
 */
export function computeEffectiveAvailability(
  availability: string,
  availabilityUpdatedAt: string | null,
  source: string,
  now: Date
): string {
  if (source !== "producer_dashboard") return availability;

  if (!availabilityUpdatedAt) return "unknown";

  const updatedAt = parseTimestamp(availabilityUpdatedAt);
  if (Number.isNaN(updatedAt.getTime())) return "unknown";

  const ageDays = (now.getTime() - updatedAt.getTime()) / MS_PER_DAY;
  if (ageDays > getSupplyGraphStaleDays()) return "unknown";

  return availability;
}

export type SetProducerAvailabilityResult =
  | { success: true; productId: string }
  | { success: false; reason: "not_found" };

/**
 * Producer-facing write path (not yet wired to any route in this slice —
 * a future owner-portal endpoint will call this). Finds the ONE products
 * row belonging to `agentId` whose name_norm exactly matches
 * `productNameNorm` (mirrors getCatalogProductIdMap() in src/routes/mcp.ts),
 * then updates its availability, marking it producer_dashboard-sourced with
 * a fresh timestamp. Never throws — any lookup/update failure resolves to
 * `{success:false, reason:'not_found'}`.
 */
export function setProducerAvailability(
  agentId: string,
  productNameNorm: string,
  availability: string,
  db?: any
): SetProducerAvailabilityResult {
  try {
    const conn = db ?? getDb();

    const rows = conn
      .prepare("SELECT id, name_norm FROM products WHERE agent_id = ?")
      .all(agentId) as Array<{ id: string; name_norm: string }>;

    const match = rows.find((r) => r.name_norm === productNameNorm);
    if (!match) return { success: false, reason: "not_found" };

    conn
      .prepare(
        `UPDATE products
            SET availability = ?,
                availability_updated_at = datetime('now'),
                availability_source = 'producer_dashboard',
                updated_at = datetime('now')
          WHERE id = ? AND agent_id = ?`
      )
      .run(availability, match.id, agentId);

    return { success: true, productId: match.id };
  } catch {
    return { success: false, reason: "not_found" };
  }
}
