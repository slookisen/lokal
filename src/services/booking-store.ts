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
import { emailService } from "./email-service";

const VERTICAL = "experiences";
const APP_URL = process.env.APP_URL || "https://opplevagent.no";

// ─── Dark-launch-stop feature flag (dev-request 2026-07-12-gardssalg-dark-
// launch-stop, slice 0) ────────────────────────────────────────────────────
// The gårdssalg booking flow has looked 100% functional on prod since
// 2026-07-03 (real form, "confirmation" screen, confirmation email) but no
// producer is ever notified and no producer has been onboarded — a live
// trust/reputation risk. This is the single fail-safe switch: booking
// submission (both POST /api/opplevelser/book and the no-JS SSR fallback)
// and the "coming soon" UI notices all gate on the pair
// (BOOKING_DISPATCH_ENABLED=true AND the specific provider's booking_live=1)
// via isBookingPaused() below — never re-implement this check inline.
//
// Fail-safe by construction: anything other than the literal string "true"
// (unset, "false", "1", a typo, ...) means OFF.
export function bookingDispatchEnabled(): boolean {
  return process.env.BOOKING_DISPATCH_ENABLED === "true";
}

// True when booking submission for this provider must be blocked and the
// "coming soon" notice shown — i.e. this provider hasn't been onboarded
// (booking_live !== 1), OR (for real providers) dispatch is off globally.
// providerBookingLive is whatever experience_providers.booking_live holds
// (0/1/NULL/undefined) — anything but the literal 1 counts as "not live".
//
// providerCatalogHidden (optional) is experience_providers.catalog_hidden.
// A catalog_hidden=1 provider is the controlled slice-0 TEST provider: it can
// ONLY be created by POST /admin/gardssalg/test-provider (admin-key gated) with
// the notification email pinned by the admin caller, and it is filtered out of
// the public catalog/count/sitemap. Such a provider dispatches even when the
// global master switch is off — this is the intended test harness, and its
// blast radius is bounded to the admin-specified address. REAL providers
// (catalog_hidden 0/NULL) are unchanged: they still require BOTH the global
// BOOKING_DISPATCH_ENABLED master switch AND their own booking_live=1.
export function isBookingPaused(
  providerBookingLive: number | null | undefined,
  providerCatalogHidden?: number | null | undefined,
): boolean {
  // Must be onboarded either way.
  if (providerBookingLive !== 1) return true;
  // Hidden, admin-created, email-pinned test provider → dispatch even if the
  // global master switch is off (real providers below still require it).
  if (providerCatalogHidden === 1) return false;
  // Real providers: unchanged double gate — still need the global master switch.
  return !bookingDispatchEnabled();
}

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

// ─── ICS + confirmation email — shared by every booking entry point ────────
// Lives here (not in a route file) so both POST /api/opplevelser/book
// (opplevelser.ts) and the gårdssalg SSR reservation form's no-JS fallback
// (experiences-seo.ts) go through the exact same code — no duplicated
// business logic between the JSON API and the progressively-enhanced form.
export function buildIcs(booking: GardssalgBooking): string {
  const dtStamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const slotDate = new Date(booking.slot_at);
  const dtStart = slotDate.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const dtEnd = new Date(slotDate.getTime() + 2 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:.]/g, "")
    .slice(0, 15) + "Z";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Opplevagent//Gardssalg Booking//NO",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${booking.booking_id}@opplevagent.no`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:Gårdssalg & smaking — ref ${booking.booking_ref}`,
    `DESCRIPTION:Påmelding via opplevagent.no. Bookingref: ${booking.booking_ref}`,
    `ATTENDEE;CN=${booking.guest_name}:mailto:${booking.guest_email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export async function sendBookingConfirmation(booking: GardssalgBooking): Promise<void> {
  const confirmUrl = `${APP_URL}/api/opplevelser/book/confirm/${booking.confirm_token}`;
  const ics = buildIcs(booking);

  const slotFormatted = new Date(booking.slot_at).toLocaleString("nb-NO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });

  const htmlContent = `
<p>Hei ${booking.guest_name},</p>
<p>Din påmelding er registrert! Her er din bekreftelse:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
</table>
<p>Tilbyderen vil bekrefte oppmøte etter besøket via lenken nedenfor (kun for tilbyder).</p>
<p>En kalenderinvitasjon (ICS) er vedlagt denne e-posten.</p>
<p>Spørsmål? Svar på denne e-posten.</p>
<p>Hilsen<br>Opplevagent</p>
  `.trim();

  const textContent = `Hei ${booking.guest_name},\n\nDin påmelding er registrert.\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}\n\nHilsen\nOpplevagent`;

  await emailService.sendEmail({
    to: booking.guest_email,
    subject: `Bekreftelse på påmelding — ${booking.booking_ref}`,
    htmlContent,
    textContent,
    replyTo: `kontakt@opplevagent.no`,
    attachments: [
      {
        filename: `gardssalg-${booking.booking_ref}.ics`,
        content: ics,
        contentType: "text/calendar; charset=utf-8; method=REQUEST",
      },
    ],
  });

  // Producer confirm link — logged so Daniel can verify manually
  console.log(`[booking] ${booking.booking_ref} confirm_url=${confirmUrl}`);
}

// ─── Producer notification email (dev-request 2026-07-12-gardssalg-dark-
// launch-stop, slice 0, point 5) ────────────────────────────────────────────
// Forward-looking wiring for once a producer is actually onboarded: when
// BOOKING_DISPATCH_ENABLED=true and the booking's provider has
// booking_live=1 (both call sites — POST /api/opplevelser/book and the no-JS
// SSR fallback — only reach this after confirming that via isBookingPaused()
// being false), also notify the producer at their experience_providers.epost
// via the same emailService used for the guest confirmation above. Minimal
// on purpose: no template system, plain text/HTML in the same style as
// sendBookingConfirmation. Fire-and-forget at the call site, same as the
// guest email — a missing/broken producer notification must never affect
// the guest's booking. If the provider has no epost on file, log a clear
// warning instead of throwing.
export async function sendProducerNotification(
  booking: GardssalgBooking,
  producerEmail: string | null | undefined,
): Promise<void> {
  if (!producerEmail) {
    console.error(
      `[booking] producer notification SKIPPED — no epost on file for provider ${booking.provider_id} (booking ${booking.booking_ref})`,
    );
    return;
  }

  const slotFormatted = new Date(booking.slot_at).toLocaleString("nb-NO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });

  const htmlContent = `
<p>Hei,</p>
<p>Du har fått en ny reservasjon via Opplevagent:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Gjest:</td><td>${booking.guest_name}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">E-post:</td><td>${booking.guest_email}</td></tr>
  ${booking.guest_phone ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Telefon:</td><td>${booking.guest_phone}</td></tr>` : ""}
</table>
<p>Spørsmål fra gjesten kan besvares direkte — gjestens e-post står over.</p>
<p>Hilsen<br>Opplevagent</p>
  `.trim();

  const textContent = `Hei,\n\nDu har fått en ny reservasjon via Opplevagent.\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}\nGjest: ${booking.guest_name} (${booking.guest_email}${booking.guest_phone ? ", " + booking.guest_phone : ""})\n\nHilsen\nOpplevagent`;

  await emailService.sendEmail({
    to: producerEmail,
    subject: `Ny reservasjon — ${booking.booking_ref}`,
    htmlContent,
    textContent,
    replyTo: `kontakt@opplevagent.no`,
  });
}
