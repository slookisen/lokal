// ─── The owner's own change request on Opplevagent ─────────────────────────
// dev-request 2026-11-26-cs-endring-som-eier-opplevagent (slookisen/A2A), §1.
//
// On Rett fra Bonden a CS change request from the profile's own registered
// address (or own domain) writes with dataSource "owner", so the owner lock
// lets the owner's own request through. This is the Opplevagent counterpart,
// and it is deliberately as narrow:
//
//   - It is NOT an HTTP parameter. The admin routes never take or pass an
//     owner context, so no caller of /api/opplevelser/admin/* (an admin key,
//     a routine, enrichment) can reach it.
//   - The gårdssalg writers that honour it (applyGardssalgSetProviderName,
//     applyGardssalgSetContentField, applyGardssalgSetAddressUnit) take it as
//     an optional in-process argument, and do NOT trust it: they call
//     verifyOwnerRequest(), which reads the cs_change_requests row itself and
//     only lets the write past the owner lock when that row
//       * exists, is a profile_update on vertical «experiences»,
//       * targets exactly this provider,
//       * is being executed right now (status «executing» — claimed by the
//         server's own worker),
//       * has authority «registered_email» or «own_domain» (set by
//         checkAuthority when the request was filed; a Daniel approval
//         rewrites it to «approved», which does not count), and
//       * asks for exactly this field with exactly this value.
//   - Everything else (enrichment, harvest, plain admin calls, a Daniel-
//     approved request) still meets the owner lock unchanged.
//
// The audit row and field_provenance of such a write say
// `owner-request via cs-change-request <id>` (ownerRequestSource).

import { getDb } from "../database/init";
import { parseAddressUnit, type AddressUnit } from "./opplevagent-address-unit";

export interface OwnerRequestContext {
  changeRequestId: string;
}

/** The only authorities that make a change request the owner's own. */
export const OWNER_REQUEST_AUTHORITIES: readonly string[] = ["registered_email", "own_domain"];

export function ownerRequestSource(changeRequestId: string): string {
  return `owner-request via cs-change-request ${changeRequestId}`;
}

/** The value a writer is about to store, in the change request's own terms. */
export type OwnerRequestValue = { field: "name" | "about_text" | "visit_text" | "opening_hours_text"; value: string } | { field: "address"; unit: Omit<AddressUnit, "ignored"> };

export type OwnerRequestCheck = { ok: true; source: string } | { ok: false; reason: string };

/**
 * Is this write the owner's own change request, being executed now? Reads
 * the request row from the database; the caller's word is never enough.
 */
export function verifyOwnerRequest(ctx: OwnerRequestContext | null | undefined, providerId: string, want: OwnerRequestValue): OwnerRequestCheck {
  const bad = (reason: string): OwnerRequestCheck => ({ ok: false, reason });
  if (!ctx || typeof ctx.changeRequestId !== "string" || !ctx.changeRequestId) return bad("owner_request_missing");
  let row: { vertical: string; target_id: string; kind: string; status: string; authority: string; changes: string } | undefined;
  try {
    row = getDb()
      .prepare("SELECT vertical, target_id, kind, status, authority, changes FROM cs_change_requests WHERE id = ?")
      .get(ctx.changeRequestId) as typeof row;
  } catch {
    return bad("owner_request_unreadable");
  }
  if (!row) return bad("owner_request_not_found");
  if (row.vertical !== "experiences" || row.kind !== "profile_update") return bad("owner_request_wrong_kind");
  if (row.target_id !== providerId) return bad("owner_request_wrong_target");
  if (row.status !== "executing") return bad("owner_request_not_executing");
  if (!OWNER_REQUEST_AUTHORITIES.includes(row.authority)) return bad("owner_request_no_owner_authority");
  let changes: Record<string, unknown> = {};
  try {
    const v = JSON.parse(row.changes || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) changes = v;
  } catch {
    return bad("owner_request_unreadable");
  }
  const asked = changes[want.field];
  if (typeof asked !== "string") return bad("owner_request_field_not_requested");
  if (want.field === "address") {
    const p = parseAddressUnit(asked);
    if (!p.ok || p.street !== want.unit.street || p.postnummer !== want.unit.postnummer || p.poststed !== want.unit.poststed) {
      return bad("owner_request_value_mismatch");
    }
  } else if (asked.trim() !== want.value.trim()) {
    return bad("owner_request_value_mismatch");
  }
  return { ok: true, source: ownerRequestSource(ctx.changeRequestId) };
}
