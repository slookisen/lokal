// ─── Customer-service lock visible to the owner ─────────────────────────────
// dev-request 2026-10-22-rfb-mine-valg-eierbrytere, S1a point 4.
//
// A field the customer-service agent corrected carries
// curated_fields.<column>.by = "rfb-customer-service". The owner portal used to
// skip such a field silently, so owners could not change their own data. With
// OWNER_PORTAL_CS_LOCK_OVERRIDE on, the portal shows «Rettet av kundeservice
// <dato>» and lets the owner save the field; the existing save path then
// stamps curated_fields.<column>.by = "owner". Locks set by anyone else
// (admin, enrichment …) are untouched. Default OFF = behaviour unchanged.

/** Env flag (read at call time, "1" or "true" = on). Default OFF. */
export const OWNER_PORTAL_CS_LOCK_FLAG = "OWNER_PORTAL_CS_LOCK_OVERRIDE";

export const CS_LOCK_BY = "rfb-customer-service";

export function ownerPortalCsLockOverrideEnabled(): boolean {
  const v = process.env[OWNER_PORTAL_CS_LOCK_FLAG];
  return v === "1" || v === "true";
}

/** True when the flag is on and this curated_fields entry was set by customer service. */
export function isOverridableCsLock(info: { by?: unknown } | null | undefined): boolean {
  return ownerPortalCsLockOverrideEnabled() && !!info && info.by === CS_LOCK_BY;
}

/** «Rettet av kundeservice 22.10.2026» (date omitted when locked_at is missing/unparseable). */
export function csLockNote(info: { by?: unknown; locked_at?: unknown } | null | undefined): string {
  const base = "Rettet av kundeservice";
  const raw = info && typeof info.locked_at === "string" ? info.locked_at : "";
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime())) return base;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${base} ${dd}.${mm}.${d.getUTCFullYear()}`;
}
