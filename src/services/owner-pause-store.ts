// ─── visibility.profile ↔ owner_profile_pause — one truth ───────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, slice S2c-2. «Profilen er
// synlig» (visibility.profile, owner-features/registry.ts) is the owner pause
// from S1b punkt 6: the registry entry has a storage adapter onto the
// owner_profile_pause row (same pattern as orders.enabled ↔
// agents.order_notifications_opt_in), so the /eier pause card and «Mine valg»
// read and write the same row. The table stays the source of truth:
//   no row, or a resume date that has passed  → visible (true)
//   a current pause row                       → not visible (false)
// Writing false pauses with no resume date (an existing pause keeps its date:
// the resolver treats an unchanged value as a no-op); writing true removes the
// row. The adapter is only read once the entry leaves `coming_soon`.

import { OWNER_PAUSE_TABLE, isOwnerPaused } from "./agent-visibility";

/** true = visible, false = paused, null = no such agent. */
export function readOwnerProfileVisible(db: any, agentId: string): boolean | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, p.paused_at AS paused_at, p.pause_until AS pause_until
         FROM agents a LEFT JOIN ${OWNER_PAUSE_TABLE} p ON p.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(agentId) as { id: string; paused_at: string | null; pause_until: string | null } | undefined;
  if (!row) return null;
  return !isOwnerPaused({ owner_paused_at: row.paused_at, owner_pause_until: row.pause_until });
}

/** Returns false when no agent row exists. */
export function writeOwnerProfileVisible(db: any, agentId: string, visible: boolean): boolean {
  const exists = db.prepare("SELECT 1 AS x FROM agents WHERE id = ?").get(agentId);
  if (!exists) return false;
  if (visible) {
    db.prepare(`DELETE FROM ${OWNER_PAUSE_TABLE} WHERE agent_id = ?`).run(agentId);
  } else {
    db.prepare(
      `INSERT INTO ${OWNER_PAUSE_TABLE} (agent_id, paused_at, pause_until, set_by) VALUES (?, ?, NULL, 'owner')
       ON CONFLICT(agent_id) DO UPDATE SET paused_at = excluded.paused_at, pause_until = NULL, set_by = excluded.set_by`,
    ).run(agentId, new Date().toISOString());
  }
  invalidatePublicListCaches();
  return true;
}

/**
 * The public list caches (registry agents/stats, sitemap) must not keep the
 * old state for a TTL — same as the /eier pause route. Lazy requires: both
 * modules are large and import the database layer.
 */
function invalidatePublicListCaches(): void {
  try {
    const { marketplaceRegistry } = require("./marketplace-registry") as typeof import("./marketplace-registry");
    marketplaceRegistry._agentsCache = null;
    marketplaceRegistry._statsCache = null;
    marketplaceRegistry._agentsCacheTime = 0;
    marketplaceRegistry._statsCacheTime = 0;
    (require("../routes/seo") as typeof import("../routes/seo")).invalidateSitemapCache();
  } catch (e) {
    console.error("[owner-features] visibility.profile cache invalidation failed:", e);
  }
}
