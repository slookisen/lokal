// ─── Big-table indexes built in the night window, not at boot ──────────
// dev-request 2026-10-08-serverheng-hovedtraad-oppstart-statistikk-samtaler
// (A2A), skive 4.
//
// CREATE INDEX on a big table is one synchronous better-sqlite3 call: it holds
// the single event loop until the whole index is built. Indexes added in
// database/init.ts therefore run at every boot (and stall a deploy); an index
// added here is instead built by the hourly auto-prune tick (src/index.ts) in
// its 03:00–03:59 UTC window, the same low-traffic hour the nightly prune and
// cart-contact sweep use. IF NOT EXISTS makes it a no-op on every later night.

import type Database from "better-sqlite3";

export interface NightIndex {
  name: string;
  table: string;
  /** Column list exactly as written inside the parentheses. */
  columns: string;
}

export const NIGHT_INDEXES: NightIndex[] = [
  // /samtaler: listConversations (WHERE vertical_id = ? ORDER BY updated_at DESC LIMIT 50)
  // and getSourceStats (WHERE vertical_id = ? GROUP BY source, MAX(updated_at)).
  { name: "idx_conversations_vertical_updated", table: "conversations", columns: "vertical_id, updated_at" },
];

/** Builds each missing night index; returns the names it created. Failures are logged, not thrown. */
export function ensureNightIndexes(db: Database.Database, indexes: NightIndex[] = NIGHT_INDEXES): string[] {
  const created: string[] = [];
  for (const ix of indexes) {
    try {
      const exists = db
        .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?")
        .get(ix.name, ix.table);
      if (exists) continue;
      db.exec(`CREATE INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.columns})`);
      created.push(ix.name);
    } catch (err) {
      console.error(`[night-indexes] ${ix.name} failed (non-fatal):`, err);
    }
  }
  return created;
}
