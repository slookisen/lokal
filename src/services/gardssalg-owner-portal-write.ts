// ─── The owner's own write from the gårdssalg owner portal ────────────────
// dev-request 2026-11-26-opplevagent-eier-endrer-adresse-selv (slookisen/A2A),
// slice 1.
//
// The owner of a claimed Opplevagent gårdssalg profile may change the address
// (street, postnummer, poststed + the map point) on the owner portal. The
// address columns are owner-locked for every OTHER writer
// (isGardssalgFieldOwnerLocked: content_source='claim' / 'manual'); the
// owner's own write is something else, and this is how the store writer
// (applyGardssalgSetAddressUnit) tells the two apart. Deliberately as narrow
// as the CS owner-request context (cs-owner-request.ts):
//
//   - It is NOT an HTTP parameter. Only the owner-portal address routes
//     (routes/gardssalg-claim.ts) pass it, with the token of the session the
//     request came with. No admin route takes or passes it.
//   - The store writer does not trust it: verifyOwnerPortalWrite() reads the
//     gardssalg_claims row for the token itself (the same rule as
//     verifyGardssalgOwnerSessionToken: used, not expired, not revoked, not
//     a draft) and only lets the write past the owner lock when that session
//     belongs to exactly this provider, and the row is not Opplevagent-
//     curated (content_source='manual' stays locked for the owner too, as
//     for the owner's other content fields — updateClaimedProviderProfile).
//
// The audit rows of such a write say changed_by='owner',
// batch_id='owner-portal' (like the portal's other owner writes) and
// field_provenance.<col>.source_url = OWNER_PORTAL_ADDRESS_SOURCE.

import { getDb } from "../database/db-factory";

export interface OwnerPortalWriteContext {
  /** The owner session token the request came with (cookie or Bearer). */
  sessionToken: string;
}

export const OWNER_PORTAL_ADDRESS_SOURCE = "owner-portal: eierens egen endring (innlogget eier)";

export type OwnerPortalWriteCheck = { ok: true; source: string } | { ok: false; reason: string };

/** Is this the owner's own write, from a live session for exactly this provider? Reads the database; the caller's word is never enough. */
export function verifyOwnerPortalWrite(ctx: OwnerPortalWriteContext | null | undefined, providerId: string): OwnerPortalWriteCheck {
  const bad = (reason: string): OwnerPortalWriteCheck => ({ ok: false, reason });
  if (!ctx || typeof ctx.sessionToken !== "string" || !ctx.sessionToken) return bad("owner_session_missing");
  const db = getDb("experiences");
  let claim: { provider_id: string } | undefined;
  try {
    claim = db
      .prepare(
        `SELECT provider_id FROM gardssalg_claims
          WHERE token = ? AND used = 1 AND expires_at > datetime('now') AND revoked_at IS NULL
            AND COALESCE(draft_mode, 0) = 0`,
      )
      .get(ctx.sessionToken) as typeof claim;
  } catch {
    return bad("owner_session_unreadable");
  }
  if (!claim) return bad("owner_session_invalid");
  if (claim.provider_id !== providerId) return bad("owner_session_wrong_provider");
  const row = db.prepare(`SELECT content_source FROM experience_providers WHERE id = ?`).get(providerId) as { content_source: string | null } | undefined;
  if (!row) return bad("provider_not_found");
  if (row.content_source === "manual") return bad("locked_by_manual");
  return { ok: true, source: OWNER_PORTAL_ADDRESS_SOURCE };
}
