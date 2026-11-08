// ─── Re-geocode one producer: clear its map point + attempt counter ─────────
// Same geocode reset PUT /admin/knowledge applies on a real address change
// (dev-request 2026-09-11-rettet-adresse-oppdaterer-ikke-kartpunktet). The
// geocode worker (agents-geocode-worker.ts) picks the row up again on its next
// tick. Used by POST /admin/agents/:id/geocode-reset and the address-
// correction paths in routes/marketplace.ts, and by POST /admin/agents/claim-
// merge-approve when a merge fills the survivor's address while it keeps a
// map point that belonged to no address of its own.

import type { getDb } from "../database/init";

export function invalidateAgentGeocode(db: ReturnType<typeof getDb>, agentId: string): void {
  db.prepare(
    `UPDATE agents SET geo_precision = NULL, lat = NULL, lng = NULL, geocode_source = NULL,
       geocode_outcome = NULL, geocode_attempts = 0, geocode_attempted_at = NULL WHERE id = ?`,
  ).run(agentId);
}
