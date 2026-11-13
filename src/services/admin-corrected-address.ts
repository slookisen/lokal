// ─── Admin-corrected address guard ───────────────────────────────────────────
// dev-request 2026-11-08-rfb-adresse-skriveveier-respekterer-admin-retting
// (Daniel live 2026-11-08, Lega «Litangen 2»).
//
// POST /admin/agents/content-correction (field "address", lokal#1457) writes
// agent_knowledge.address with one audit row: field_name 'address',
// changed_by 'admin', notes starting with "content-correction-". It does not
// touch field_provenance on purpose, so nothing else records that a person
// corrected the value — and every automatic address write path could put the
// old value back on the next enrichment run.
//
// isAdminCorrectedAddress() is the one shared check those write paths use:
// true when the LATEST real address change in the audit log is such an admin
// content-correction AND its new_value is still the column's value. So:
//   - a newer owner change (owner-portal audit row, or an owner write that
//     changed the column without an audit row) lifts the guard;
//   - a newer content-correction takes over and protects its own value;
//   - audit rows that record no change (old_value = new_value, e.g. the Brreg
//     backfill's provenance-only row) are not "the latest change" and are
//     skipped, so they cannot lift the guard.
// Read-only: it never writes, and it never looks at field_provenance or
// curated_fields.
//
// Owner lanes (claim token / API key → ownerUpdate, the owner portal) do not
// call this — the owner always wins. The shared admin key is never treated as
// the owner (same rule as the W40 phone guard), so `dataSource: "owner"` or an
// incoming `source_type: "owner"` record on an admin lane is not an exemption;
// an admin relay of an owner's new address goes through content-correction.

/** Outcome/reason string every guarded write path reports. */
export const ADMIN_CORRECTED = "admin_corrected" as const;

/** content-correction's audit notes start with its batch tag "content-correction-YYYYMMDD-HHMMSS". */
export const CONTENT_CORRECTION_NOTES_PREFIX = "content-correction-";

/** The slice of a better-sqlite3 handle this module needs. */
interface DbLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

// changed_at is written both as "YYYY-MM-DD HH:MM:SS" (datetime('now')) and as
// ISO text; datetime() reads both, so the two formats order correctly against
// each other. Rows in the same second keep insertion order (rowid).
const LATEST_ADDRESS_CHANGE_SQL = `
  SELECT changed_by, new_value, notes
    FROM agent_knowledge_audit
   WHERE agent_id = ? AND field_name = 'address' AND old_value IS NOT new_value
   ORDER BY COALESCE(datetime(changed_at), changed_at) DESC, rowid DESC
   LIMIT 1`;

function currentAddress(db: DbLike, agentId: string): string | null {
  const row = db.prepare(`SELECT address FROM agent_knowledge WHERE agent_id = ?`).get(agentId) as
    | { address?: string | null }
    | undefined;
  return row?.address ?? null;
}

/**
 * True when the agent's address is protected: the latest audited address
 * change is an admin content-correction and its value is still in the column.
 * Fails open (false) on any read error, so a guard bug never blocks a write
 * path outright.
 */
export function isAdminCorrectedAddress(db: DbLike, agentId: string): boolean {
  try {
    const latest = db.prepare(LATEST_ADDRESS_CHANGE_SQL).get(agentId) as
      | { changed_by?: string | null; new_value?: string | null; notes?: string | null }
      | undefined;
    if (!latest) return false;
    if (latest.changed_by !== "admin") return false;
    if (!String(latest.notes ?? "").startsWith(CONTENT_CORRECTION_NOTES_PREFIX)) return false;
    const current = currentAddress(db, agentId);
    return current !== null && latest.new_value === current;
  } catch {
    return false;
  }
}

/**
 * Should an automatic (non-owner) write of `incoming` to the address column be
 * refused? True only when the agent is admin-corrected and `incoming` is a
 * different value (compared trimmed). `undefined` (no address in the write)
 * and the same value are never refused.
 */
export function adminCorrectedAddressBlocks(db: DbLike, agentId: string, incoming: unknown): boolean {
  if (incoming === undefined) return false;
  const next = incoming === null ? "" : String(incoming).trim();
  let current: string | null;
  try {
    current = currentAddress(db, agentId);
  } catch {
    return false;
  }
  if (next === (current ?? "").trim()) return false;
  return isAdminCorrectedAddress(db, agentId);
}
