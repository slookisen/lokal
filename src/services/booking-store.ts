// ─── Gardssalg Booking Store — Phase 2 (2026-06-28) ──────────────────
//
// Attribution + attendance tracking for opplevagent gardssalg bookings.
// All writes go to /data/experiences.db via getDb('experiences').
//
// Lifecycle: reserved → confirmed_attended | no_show | cancelled
// commission_rate comes from experience_providers.commission_rate;
// billable flips to 1 only on confirmed_attended (post-visit only).
//
// Never auto-sends — Daniel (producer) resolves each booking manually
// via the tokenized confirm URL. No funds move in Phase 2.

import { v4 as uuid } from "uuid";
import { z } from "zod";
import { getDb } from "../database/db-factory";

const VERTICAL = "experiences";

export type BookingStatus =
  | "reserved"
  | "confirmed_attended"
  | "no_show"
  | "cancelled";

export interface GardssalgBooking {
  booking_id: string;
  experience_id: string | null;
  provider_id: string;
  slot_at: string;
  party_size: number;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  booking_ref: string;
  confirm_token: string;
  source: string;
  status: BookingStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  commission_rate: number | null;
  billable: number;
  notes: string | null;
  created_at: string;
}

export const BookingInputSchema = z.object({
  experience_id: z.string().optional(),
  provider_id: z.string().min(1),
  slot_at: z.string().min(1),
  party_size: z.number().int().min(1).max(50),
  guest_name: z.string().min(1).max(200),
  guest_email: z.string().email(),
  guest_phone: z.string().max(30).optional(),
  commission_rate: z.number().min(0).max(1).optional(),
  notes: z.string().max(500).optional(),
});
export type BookingInput = z.infer<typeof BookingInputSchema>;

// Human-readable ref: GARD-YYYYMMDD-XXXXX (no ambiguous chars)
function generateBookingRef(): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `GARD-${d}-${suffix}`;
}

// Opaque 32-hex token for producer confirm link
function generateConfirmToken(): string {
  return uuid().replace(/-/g, "");
}

function hydrate(row: Record<string, unknown>): GardssalgBooking {
  return {
    booking_id:     row.booking_id as string,
    experience_id:  (row.experience_id as string | null) ?? null,
    provider_id:    row.provider_id as string,
    slot_at:        row.slot_at as string,
    party_size:     row.party_size as number,
    guest_name:     row.guest_name as string,
    guest_email:    row.guest_email as string,
    guest_phone:    (row.guest_phone as string | null) ?? null,
    booking_ref:    row.booking_ref as string,
    confirm_token:  row.confirm_token as string,
    source:         row.source as string,
    status:         row.status as BookingStatus,
    resolved_by:    (row.resolved_by as string | null) ?? null,
    resolved_at:    (row.resolved_at as string | null) ?? null,
    commission_rate:(row.commission_rate as number | null) ?? null,
    billable:       row.billable as number,
    notes:          (row.notes as string | null) ?? null,
    created_at:     row.created_at as string,
  };
}

export function createBooking(input: BookingInput): GardssalgBooking {
  const db = getDb(VERTICAL);

  // Inherit commission_rate from provider if not explicitly set
  let commission_rate = input.commission_rate ?? null;
  if (commission_rate === null) {
    const prov = db
      .prepare("SELECT commission_rate FROM experience_providers WHERE id = ?")
      .get(input.provider_id) as { commission_rate: number | null } | undefined;
    commission_rate = prov?.commission_rate ?? null;
  }

  const booking: GardssalgBooking = {
    booking_id:    uuid(),
    experience_id: input.experience_id ?? null,
    provider_id:   input.provider_id,
    slot_at:       input.slot_at,
    party_size:    input.party_size,
    guest_name:    input.guest_name,
    guest_email:   input.guest_email,
    guest_phone:   input.guest_phone ?? null,
    booking_ref:   generateBookingRef(),
    confirm_token: generateConfirmToken(),
    source:        "opplevagent",
    status:        "reserved",
    resolved_by:   null,
    resolved_at:   null,
    commission_rate,
    billable:      0,
    notes:         input.notes ?? null,
    created_at:    new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO gardssalg_bookings (
      booking_id, experience_id, provider_id, slot_at, party_size,
      guest_name, guest_email, guest_phone, booking_ref, confirm_token,
      source, status, commission_rate, notes, created_at
    ) VALUES (
      @booking_id, @experience_id, @provider_id, @slot_at, @party_size,
      @guest_name, @guest_email, @guest_phone, @booking_ref, @confirm_token,
      @source, @status, @commission_rate, @notes, @created_at
    )
  `).run(booking);

  return booking;
}

export function getBookingByRef(booking_ref: string): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT * FROM gardssalg_bookings WHERE booking_ref = ?")
    .get(booking_ref) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

export function getBookingByToken(
  confirm_token: string,
): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT * FROM gardssalg_bookings WHERE confirm_token = ?")
    .get(confirm_token) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

// Producer calls this via tokenized confirm link.
// Only transitions from 'reserved'; returns null if token unknown or already resolved.
export function resolveBooking(
  confirm_token: string,
  newStatus: "confirmed_attended" | "no_show",
  resolvedBy: string,
): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const existing = getBookingByToken(confirm_token);
  if (!existing || existing.status !== "reserved") return null;

  db.prepare(`
    UPDATE gardssalg_bookings
    SET status = ?, resolved_by = ?, resolved_at = datetime('now'),
        billable = ?
    WHERE confirm_token = ?
  `).run(
    newStatus,
    resolvedBy,
    newStatus === "confirmed_attended" ? 1 : 0,
    confirm_token,
  );

  return getBookingByToken(confirm_token);
}

// Monthly commission statement for one provider.
// Returns only confirmed_attended bookings for the given YYYY-MM month.
export function getCommissionStatement(
  provider_id: string,
  monthStr: string, // e.g. '2026-07'
): {
  provider_id: string;
  month: string;
  bookings: GardssalgBooking[];
  total_parties: number;
  commission_rate: number | null;
} {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare(`
      SELECT * FROM gardssalg_bookings
      WHERE provider_id = ?
        AND status = 'confirmed_attended'
        AND strftime('%Y-%m', resolved_at) = ?
      ORDER BY resolved_at
    `)
    .all(provider_id, monthStr) as Record<string, unknown>[];

  const bookings = rows.map(hydrate);
  const total_parties = bookings.reduce((s, b) => s + b.party_size, 0);
  const commission_rate = bookings[0]?.commission_rate ?? null;

  return { provider_id, month: monthStr, bookings, total_parties, commission_rate };
}

// Pending bookings for a provider (for producer dashboard / reminder checks).
export function getPendingBookings(provider_id: string): GardssalgBooking[] {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare(
      "SELECT * FROM gardssalg_bookings WHERE provider_id = ? AND status = 'reserved' ORDER BY slot_at",
    )
    .all(provider_id) as Record<string, unknown>[];
  return rows.map(hydrate);
}
