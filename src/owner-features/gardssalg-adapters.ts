// ─── «Mine valg» for gårdssalg — storage adapters and the subject loader ────
// dev-request 2026-10-22-opplevagent-mine-valg-gardssalg, «v2 for
// Opplevagent», slice O1a. The gårdssalg producer rows live in experiences.db
// (db-factory getDb("experiences")); the owner_feature_* tables (explicit
// choices, audit, batches, interest) are the shared ones in lokal.db, keyed
// (vertical='gardssalg', subject_id=experience_providers.id) as
// database/init.ts documents. An adapter entry keeps its existing column as
// the source of truth and writes it through the existing service function,
// so the existing log and gates apply unchanged:
//
//   booking.enabled    ↔ experience_providers.booking_live, written by
//                        updateClaimedProviderProfile() (the portal's own
//                        writer: the admin brake and the booking-address rule
//                        in ownerBookingEnableBlock, one gardssalg_content_audit
//                        row per change). No new state.
//   visibility.profile ↔ the owner pause (catalog_hidden +
//                        catalog_hidden_reason='owner_pause', G1 pkt 4),
//                        written by pauseOwnedProvider()/resumeOwnedProvider()
//                        (verified claim required, one audit row per change).
//
// The services are required lazily (inside the functions) so the registry
// module never pulls the claim service — and its booking-gate import, which
// reads the resolver — into a load-time cycle.

import type { LocalizedText, OwnerFeatureCondition, OwnerFeatureStorageAdapter } from "./registry";

type ClaimService = typeof import("../services/gardssalg-claim");
type BookingGate = typeof import("../services/gardssalg-booking-gate");

function claimService(): ClaimService {
  return require("../services/gardssalg-claim") as ClaimService;
}
function bookingGate(): BookingGate {
  return require("../services/gardssalg-booking-gate") as BookingGate;
}
function experiencesDb(): any {
  return (require("../database/db-factory") as typeof import("../database/db-factory")).getDb("experiences");
}

export const GARDSSALG_BOOKING_ENABLED_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "experience_providers.booking_live",
  read: (_db, subjectId) => {
    const row = experiencesDb()
      .prepare(`SELECT booking_live FROM experience_providers WHERE id = ?`)
      .get(subjectId) as { booking_live: number | null } | undefined;
    if (!row) return null;
    return Number(row.booking_live) === 1;
  },
  write: (_db, subjectId, value) => {
    const out = claimService().updateClaimedProviderProfile(subjectId, { booking_live: value === true ? 1 : 0 });
    if (out.ok === true) return true;
    // The portal writer's own gate (admin brake / request address) refused:
    // a 409 with its Norwegian reason, never a 404.
    if (out.error === "booking_blocked") {
      return {
        blocked: {
          no: out.block.note ? `${out.block.message} Grunn: ${out.block.note}.` : out.block.message,
          en: out.block.reason === "admin_brake"
            ? "Booking was stopped by Opplevagent. You cannot switch it back on yourself. Contact kontakt@opplevagent.no."
            : "Booking cannot be switched on until the profile has an e-mail address the requests can be sent to. Contact kontakt@opplevagent.no.",
        },
      };
    }
    return false;
  },
};

export const GARDSSALG_PROFILE_VISIBLE_ADAPTER: OwnerFeatureStorageAdapter = {
  column: "experience_providers.catalog_hidden (owner_pause)",
  read: (_db, subjectId) => {
    const state = claimService().getOwnedVisibilityStateById(subjectId);
    if (state === null) return null;
    return state === "visible";
  },
  write: (_db, subjectId, value) => {
    const svc = claimService();
    const out = value === true ? svc.resumeOwnedProvider(subjectId) : svc.pauseOwnedProvider(subjectId);
    return out.ok === true;
  },
};

export interface GardssalgSubjectFacts {
  exists: boolean;
  /** A used, not revoked gardssalg_claims row (isGardssalgProviderClaimed). */
  verifiedOwner: boolean;
  isTestProvider: boolean;
  conditions: Partial<Record<OwnerFeatureCondition, { met: boolean; reason?: LocalizedText }>>;
}

const VISIBILITY_NOT_OWNER_CONTROLLED: Record<string, LocalizedText> = {
  removed: {
    no: "Profilen er fjernet etter ditt ønske og kan ikke gjøres synlig herfra. Kontakt kontakt@opplevagent.no hvis du vil ha den tilbake.",
    en: "The profile was removed at your request and cannot be made visible from here. Contact kontakt@opplevagent.no if you want it back.",
  },
  quality_hidden: {
    no: "Profilen er skjult av Opplevagent. Kontakt kontakt@opplevagent.no for å høre hvorfor.",
    en: "The profile is hidden by Opplevagent. Contact kontakt@opplevagent.no to find out why.",
  },
};

/** Everything the resolver needs to know about one gårdssalg producer row. */
export function loadGardssalgSubjectFacts(providerId: string): GardssalgSubjectFacts {
  const db = experiencesDb();
  const row = db
    .prepare(
      `SELECT id, epost, booking_admin_brake_at, booking_admin_brake_note, catalog_hidden, catalog_hidden_reason, is_test_provider
         FROM experience_providers WHERE id = ?`,
    )
    .get(providerId) as
    | {
        id: string; epost: string | null; booking_admin_brake_at: string | null; booking_admin_brake_note: string | null;
        catalog_hidden: number | null; catalog_hidden_reason: string | null; is_test_provider: number | null;
      }
    | undefined;
  if (!row) return { exists: false, verifiedOwner: false, isTestProvider: false, conditions: {} };
  const svc = claimService();
  const gate = bookingGate();
  // The admin brake wins over the owner (G1 item 3): same stamp ownerBookingEnableBlock reads.
  const brake = !!row.booking_admin_brake_at;
  const brakeNote = typeof row.booking_admin_brake_note === "string" && row.booking_admin_brake_note.trim() !== ""
    ? row.booking_admin_brake_note.trim()
    : null;
  const brakeReason: LocalizedText | undefined = brake
    ? {
        no: brakeNote ? `${gate.OWNER_BOOKING_ADMIN_BRAKE_MSG} Grunn: ${brakeNote}.` : gate.OWNER_BOOKING_ADMIN_BRAKE_MSG,
        en: "Booking was stopped by Opplevagent. You cannot switch it back on yourself. Contact kontakt@opplevagent.no.",
      }
    : undefined;
  const state = svc.getOwnedVisibilityState(row);
  return {
    exists: true,
    verifiedOwner: svc.isGardssalgProviderClaimed(providerId),
    isTestProvider: Number(row.is_test_provider) === 1,
    conditions: {
      bookingRequestEmail: gate.hasBookingRequestEmail(row.epost)
        ? { met: true }
        : {
            met: false,
            reason: {
              no: gate.OWNER_BOOKING_NO_EMAIL_MSG,
              en: "Booking cannot be switched on until the profile has an e-mail address the requests can be sent to. Contact kontakt@opplevagent.no.",
            },
          },
      noBookingAdminBrake: brake ? { met: false, reason: brakeReason } : { met: true },
      // The rest is not wired for gårdssalg: no entry requires them.
      isVerifiedBadge: { met: false },
      visibilityOwnerControlled: state === "visible" || state === "owner_pause"
        ? { met: true }
        : { met: false, reason: VISIBILITY_NOT_OWNER_CONTROLLED[state] },
    },
  };
}
