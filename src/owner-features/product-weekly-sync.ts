// ─── «Mine valg» products.weekly_sync ↔ product_sync_mode (Skive 4-2b) ──────
// dev-request 2026-10-21-rfb-produktimport-fra-egen-nettside, Skive 4-2b.
//
// The «Hold produktene oppdatert fra nettsiden» switch is the weekly product
// auto-sync of Skive 4-1: one truth, product_auto_sync_state.product_sync_mode
// ('weekly' = on; 'off' or no row = off). Storage adapter for the registry
// entry (registry.ts), so the resolver and the owner write path
// (resolve.ts setOwnerFeatureValue) read and write the column, never
// owner_feature_settings.
//
// The write mirrors setProductSyncMode (services/product-import/auto-sync.ts)
// on the caller's db, inside the owner write's transaction:
//   on  → mode 'weekly'; the lock counter and the auto-off reason are reset
//         (as setProductSyncMode does), nothing is fetched now — the weekly
//         job (dueAutoSyncProfiles) picks the profile up;
//   off → mode 'off' only; every other sync-state column is kept.
// Each change also writes one agent_knowledge_audit row (field
// products.weekly_sync, 'off' → 'weekly' or back), the same row the import
// page's box writes (Skive 4a), next to the owner_feature_audit row the owner
// write path itself adds.
//
// The entry is live only with PRODUCT_AUTO_SYNC_ENABLED on (liveFlag): with
// the flag off it is `coming_soon` exactly as before (resolver, page, owner
// API), so this adapter is never read or written then.

import crypto from "crypto";
import type { OwnerFeatureStorageAdapter, OwnerFeatureValue, OwnerFeatureWriteActor } from "./registry";

/** The «Mine valg» key of the setting (also the agent_knowledge_audit field). */
export const PRODUCT_WEEKLY_SYNC_KEY = "products.weekly_sync";
/**
 * The entry's liveFlag — the same env name as PRODUCT_AUTO_SYNC_FLAG in
 * services/product-import/auto-sync.ts (asserted by the 4-2b test; not
 * imported, so the registry does not load the extractor).
 */
export const PRODUCT_WEEKLY_SYNC_FLAG = "PRODUCT_AUTO_SYNC_ENABLED";

/** On / off for an existing profile; null = no such agents row. Never writes. */
export function readProductWeeklySync(db: any, agentId: string): boolean | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, s.product_sync_mode AS mode
         FROM agents a LEFT JOIN product_auto_sync_state s ON s.agent_id = a.id
        WHERE a.id = ?`,
    )
    .get(agentId) as { id: string; mode: string | null } | undefined;
  if (!row) return null;
  return row.mode === "weekly";
}

/**
 * Sets product_sync_mode for the switch and writes the audit row. Returns
 * false (nothing written) when the profile does not exist. Runs on the
 * caller's db / transaction.
 */
export function writeProductWeeklySync(db: any, agentId: string, on: boolean, actor: OwnerFeatureWriteActor): boolean {
  const before = readProductWeeklySync(db, agentId);
  if (before === null) return false;
  const mode = on ? "weekly" : "off";
  if (on) {
    db.prepare(
      `INSERT INTO product_auto_sync_state (agent_id, product_sync_mode, updated_at) VALUES (?, 'weekly', datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET product_sync_mode = 'weekly', updated_at = datetime('now'),
         consecutive_blocks = 0, disabled_reason = NULL, disabled_at = NULL`,
    ).run(agentId);
  } else {
    db.prepare(
      `INSERT INTO product_auto_sync_state (agent_id, product_sync_mode, updated_at) VALUES (?, 'off', datetime('now'))
       ON CONFLICT(agent_id) DO UPDATE SET product_sync_mode = 'off', updated_at = datetime('now')`,
    ).run(agentId);
  }
  if (before !== on) {
    // The row auditOwnerProductChange (services/owner-orderability.ts) writes for
    // the import page's box — inlined so the registry does not load the catalog
    // routes; changed_by follows the actor (the column allows owner/admin/system).
    const changedBy = actor.actor === "owner" ? "owner" : actor.actor === "system" ? "system" : "admin";
    db.prepare(
      `INSERT INTO agent_knowledge_audit
       (id, agent_id, field_name, old_value, new_value, changed_by, changed_by_email, changed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`audit_${crypto.randomBytes(8).toString("hex")}`, agentId, PRODUCT_WEEKLY_SYNC_KEY, before ? "weekly" : "off", mode,
      changedBy, actor.actor === "owner" ? actor.detail ?? null : null, new Date().toISOString(),
      `${changedBy} turned weekly price auto-sync ${on ? "on" : "off"} in «Mine valg» (produktimport skive 4-2b)`);
  }
  return true;
}

/**
 * Does the weekly job take this profile (its selection rule in
 * dueAutoSyncProfiles: mode 'weekly' and agents.is_verified = 1, before the
 * 7-day spacing)? For the switch probe; never writes.
 */
export function productWeeklySyncSelected(db: any, agentId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 AS x FROM product_auto_sync_state s JOIN agents a ON a.id = s.agent_id
        WHERE s.agent_id = ? AND s.product_sync_mode = 'weekly' AND a.is_verified = 1`,
    )
    .get(agentId);
}

export const PRODUCT_WEEKLY_SYNC_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "product_auto_sync_state.product_sync_mode",
  read: (db, subjectId): OwnerFeatureValue => readProductWeeklySync(db, subjectId),
  write: (db, subjectId, value, actor) => writeProductWeeklySync(db, subjectId, value === true, actor ?? { actor: "system" }),
};
