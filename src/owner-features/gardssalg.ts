// ─── «Mine valg» for gårdssalg — flag, allowlist and the booking readers ─────
// dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, «v2 for
// Opplevagent», slice O1a.
//
// Everything is behind two switches, both off by default:
//   OA_OWNER_FEATURES_ENABLED          "1"/"true" = the gårdssalg «Mine valg»
//                                      tab, its API and the owner choices it
//                                      stores take effect. Anything else (unset,
//                                      "0", a typo) = off: no tab (404), and no
//                                      surface reads a gårdssalg owner choice,
//                                      so today's behaviour is unchanged.
//   OWNER_FEATURES_ALLOWED_SUBJECTS    the shared allowlist (owner-features/
//                                      allowlist.ts), `gardssalg:<provider id>`.
// The tab itself is in addition limited to the test producer
// (experience_providers.is_test_provider = 1) until Daniel's pilot GO.
//
// Readers here (featureOn, governance S4 rule 2): booking.pause — a new
// visit request is refused with «tar ikke imot forespørsler nå» on every
// booking channel (POST /api/opplevelser/book, the no-JS form post,
// book_gardssalg) and the AI discover note says the same; the profile stays
// visible (the pause never touches catalog_hidden).

import { isSubjectAllowedForOwnerFeatures } from "./allowlist";
import { gardssalgFeatureOn } from "./resolve";
import { ownerFlagMode, type OwnerFlagMode } from "./owner-flag-mode";

export const OA_OWNER_FEATURES_ENABLED_ENV = "OA_OWNER_FEATURES_ENABLED";

export function oaOwnerFeaturesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[OA_OWNER_FEATURES_ENABLED_ENV];
  return v === "1" || v === "true";
}

/** The owner choices of this gårdssalg producer apply: flag on and the producer is allowlisted. */
export function gardssalgOwnerFeaturesActive(providerId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!providerId || !oaOwnerFeaturesEnabled(env)) return false;
  return isSubjectAllowedForOwnerFeatures("gardssalg", providerId, env);
}

/**
 * booking.pause is on for this producer. Flag off or not allowlisted →
 * false without any lookup (today's behaviour). A lookup error while the
 * choice applies counts as paused (the owner asked for no new requests;
 * refusing one is the safe side) and is logged.
 */
export function gardssalgOwnerBookingPaused(providerId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!gardssalgOwnerFeaturesActive(providerId, env)) return false;
  try {
    return gardssalgFeatureOn(providerId as string, "booking.pause", { env });
  } catch (e) {
    console.error(`[owner-features] booking.pause lookup failed for gardssalg ${providerId}:`, e);
    return true;
  }
}

// ─── The gårdssalg owner dashboard flag (O2-1) ──────────────────────────────
// dev-request 2026-11-12-opplevagent-o2-eierdashbord-for-besok, slice O2-1.
// GARDSSALG_OWNER_DASHBOARD_ENABLED reads the same three modes as the RFB
// owner flags (owner-flag-mode.ts ownerFlagMode):
//   "1" / "true" → all    every producer the rest of the gate lets through
//   "pilot"      → pilot  only `gardssalg:<provider id>` on
//                         OWNER_FEATURES_ALLOWED_SUBJECTS
//   anything else → off   (default) — no dashboard, the owner pages exactly
//                         as before.
// This is the flag part only. The dashboard additionally stays limited to the
// test producer in code until slice O2-5, and needs a verified owner session
// (routes/gardssalg-owner-features.ts gardssalgOwnerDashboardActiveFor).

export const GARDSSALG_OWNER_DASHBOARD_ENABLED_ENV = "GARDSSALG_OWNER_DASHBOARD_ENABLED";

/** PURE: the mode of GARDSSALG_OWNER_DASHBOARD_ENABLED. */
export function gardssalgOwnerDashboardMode(env: NodeJS.ProcessEnv = process.env): OwnerFlagMode {
  return ownerFlagMode(GARDSSALG_OWNER_DASHBOARD_ENABLED_ENV, env);
}

/** PURE: the flag lets this producer in (all → yes; pilot → allowlisted; off → no). */
export function gardssalgOwnerDashboardFlagOnFor(providerId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!providerId) return false;
  const mode = gardssalgOwnerDashboardMode(env);
  if (mode === "all") return true;
  if (mode === "pilot") return isSubjectAllowedForOwnerFeatures("gardssalg", providerId, env);
  return false;
}
