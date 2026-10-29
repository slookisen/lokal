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
