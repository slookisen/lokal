// ─── Gårdssalg booking switch: shared rules (dev-request 2026-10-22-
// opplevagent-mine-valg-gardssalg, G1 items 3 and 7) ─────────────────────────
//
// One place for three rules that used to be copied or missing:
//
//   1. hasBookingRequestEmail — the "a booking request must have somewhere
//      to go" requirement. The admin lever (POST /admin/gardssalg-booking-
//      activation, routes/opplevelser.ts) has always refused enabled:true
//      without an `epost`; the owner portal checkbox (services/gardssalg-
//      claim.ts updateClaimedProviderProfile) now uses the SAME function, so
//      the two can never disagree on what counts as a usable address.
//
//   2. The admin brake. When the admin lever applies enabled:false it stamps
//      experience_providers.booking_admin_brake_at (+ the operator's note in
//      booking_admin_brake_note); enabled:true clears both. While the stamp is
//      set the owner can switch booking OFF but never back ON, and the portal
//      shows "stanset av Opplevagent" with the reason. booking_live stays the
//      only switch every booking surface reads (isBookingPaused, booking-
//      store.ts) — the brake only gates who may set it to 1.
//
//   3. The booking note given to AI surfaces (MCP discover_gardssalg /
//      book_gardssalg, A2A gardssalg_discover, REST /api/opplevelser/discover,
//      the openapi example). A profile that has an owner (claimed_at set) and
//      is not bookable is not "opening soon": the owner turned it off (or it
//      is paused/braked). Only never-claimed profiles keep "åpner snart".
//
// Pure functions + one small DB writer taking the handle as a parameter, so
// callers in routes and services share it without a new import cycle.

import crypto from "crypto";
import type Database from "better-sqlite3";
import { isBookingPaused } from "./booking-store";

/** True when the provider has an address a booking request can be sent to.
 *  Same rule the admin lever has always applied (non-empty, trimmed epost). */
export function hasBookingRequestEmail(epost: string | null | undefined): boolean {
  return typeof epost === "string" && epost.trim() !== "";
}

// ── Owner enable gate ───────────────────────────────────────────────────────

export type OwnerBookingBlockReason = "admin_brake" | "no_booking_email";

export interface OwnerBookingBlock {
  reason: OwnerBookingBlockReason;
  /** Norwegian, safe to show the owner (plain text, caller escapes for HTML). */
  message: string;
  /** The operator's note for an admin brake, when one was given. */
  note: string | null;
}

export const OWNER_BOOKING_ADMIN_BRAKE_MSG =
  "Booking er stanset av Opplevagent. Du kan ikke slå den på igjen selv. Ta kontakt med kontakt@opplevagent.no.";
export const OWNER_BOOKING_NO_EMAIL_MSG =
  "Booking kan ikke slås på før profilen har en e-postadresse som forespørslene kan sendes til. Ta kontakt med kontakt@opplevagent.no.";

export interface OwnerBookingGateRow {
  epost: string | null;
  booking_admin_brake_at: string | null;
  booking_admin_brake_note: string | null;
}

/** Why the owner may not switch booking ON for this row, or null if allowed.
 *  The admin brake is checked first: it wins even when an address exists. */
export function ownerBookingEnableBlock(row: OwnerBookingGateRow): OwnerBookingBlock | null {
  if (row.booking_admin_brake_at) {
    const note = typeof row.booking_admin_brake_note === "string" && row.booking_admin_brake_note.trim() !== ""
      ? row.booking_admin_brake_note.trim()
      : null;
    return { reason: "admin_brake", message: OWNER_BOOKING_ADMIN_BRAKE_MSG, note };
  }
  if (!hasBookingRequestEmail(row.epost)) {
    return { reason: "no_booking_email", message: OWNER_BOOKING_NO_EMAIL_MSG, note: null };
  }
  return null;
}

// ── Admin brake writer ──────────────────────────────────────────────────────

/**
 * Set (on=true) or lift (on=false) the admin brake for one provider. Writes
 * only the two brake columns, and one gardssalg_content_audit row
 * (field_name='booking_admin_brake', changed_by='admin') when the state
 * actually changes. Returns whether anything changed. Setting an already-set
 * brake refreshes the note (when a new one is given) without a new audit row.
 */
export function setGardssalgBookingAdminBrake(
  expDb: Database.Database,
  providerId: string,
  on: boolean,
  note: string | null,
  batchId: string,
): boolean {
  const txn = expDb.transaction((): boolean => {
    const row = expDb
      .prepare(`SELECT booking_admin_brake_at FROM experience_providers WHERE id = ?`)
      .get(providerId) as { booking_admin_brake_at: string | null } | undefined;
    if (!row) return false;
    const isOn = !!row.booking_admin_brake_at;
    if (on && isOn) {
      if (note) {
        expDb
          .prepare(`UPDATE experience_providers SET booking_admin_brake_note = @note WHERE id = @id`)
          .run({ id: providerId, note });
      }
      return false;
    }
    if (!on && !isOn) return false;
    if (on) {
      expDb
        .prepare(
          `UPDATE experience_providers
              SET booking_admin_brake_at = datetime('now'), booking_admin_brake_note = @note
            WHERE id = @id`,
        )
        .run({ id: providerId, note });
    } else {
      expDb
        .prepare(
          `UPDATE experience_providers
              SET booking_admin_brake_at = NULL, booking_admin_brake_note = NULL
            WHERE id = @id`,
        )
        .run({ id: providerId });
    }
    expDb
      .prepare(
        `INSERT INTO gardssalg_content_audit
           (id, provider_id, field_name, old_value, new_value, source_url, batch_id, changed_by, changed_at, notes)
         VALUES (@id, @provider_id, 'booking_admin_brake', @old_value, @new_value, NULL, @batch_id, 'admin', datetime('now'), @notes)`,
      )
      .run({
        id: crypto.randomUUID(),
        provider_id: providerId,
        old_value: isOn ? "on" : "off",
        new_value: on ? "on" : "off",
        batch_id: batchId,
        notes: note,
      });
    return true;
  });
  return txn();
}

// ── Booking note for AI surfaces ────────────────────────────────────────────

export const GARDSSALG_BOOKING_NOTE_LIVE = "Book direkte. / Book directly.";
export const GARDSSALG_BOOKING_NOTE_OPENS_SOON =
  "Reservasjoner åpner snart; ta kontakt via profilsiden. / Bookings open soon; visit the profile page to get in touch.";
export const GARDSSALG_BOOKING_NOTE_NOT_TAKING =
  "Produsenten tar ikke imot forespørsler nå; ta kontakt via profilsiden. / The producer is not taking requests right now; visit the profile page to get in touch.";

export interface GardssalgBookingStatus {
  live: boolean;
  mode: "request" | "paused";
  note: string;
}

/** True when the profile has an owner (claimed at least once). */
function hasOwner(claimedAt: string | null | undefined): boolean {
  return typeof claimedAt === "string" && claimedAt.trim() !== "";
}

/**
 * The booking object every gårdssalg discover surface returns. `live` comes
 * from isBookingPaused (unchanged gate). When not live: an owned profile says
 * it is not taking requests now; a never-claimed profile keeps "åpner snart".
 */
export function gardssalgBookingStatus(row: {
  booking_live: number | null | undefined;
  claimed_at?: string | null;
}): GardssalgBookingStatus {
  const live = !isBookingPaused(row.booking_live);
  if (live) return { live, mode: "request", note: GARDSSALG_BOOKING_NOTE_LIVE };
  return {
    live,
    mode: "paused",
    note: hasOwner(row.claimed_at) ? GARDSSALG_BOOKING_NOTE_NOT_TAKING : GARDSSALG_BOOKING_NOTE_OPENS_SOON,
  };
}

/** The not-live line for a rejected booking request (book_gardssalg), as a
 *  Norwegian and an English sentence. Owned profiles: "tar ikke imot
 *  forespørsler nå"; never-claimed: null (the caller keeps its existing
 *  "Booking er ikke aktivert … ennå" copy). */
export function gardssalgNotTakingRequestsText(claimedAt: string | null | undefined): { no: string; en: string } | null {
  if (!hasOwner(claimedAt)) return null;
  return {
    no: "Produsenten tar ikke imot forespørsler nå.",
    en: "The producer is not taking requests right now.",
  };
}
