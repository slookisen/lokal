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

// ─── Pre-visit answer loop (booking-flyt-v1 slice 2) ────────────────────────
// PARALLEL to the post-visit `status` machine above — never mixed with it.
// awaiting_provider → provider_confirmed | provider_declined
//                   | time_suggested (guest accepts → provider_confirmed,
//                                     guest declines → provider_declined)
//                   | expired (auto, after BOOKING_PREVISIT_EXPIRE_HOURS)
export type BookingPreStatus =
  | "awaiting_provider"
  | "provider_confirmed"
  | "provider_declined"
  | "time_suggested"
  | "expired";

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
  // Pre-visit answer loop (slice 2). All NULL on rows created before the
  // slice — such legacy rows are OUTSIDE the pre-visit flow entirely (no
  // reminder, no auto-expiry, no answer page), guarded by respond_token
  // IS NOT NULL everywhere below.
  pre_status: BookingPreStatus;
  respond_token: string | null;            // PRODUCER credential — never in guest email
  respond_token_expires_at: string | null;
  respond_token_used_at: string | null;
  suggested_slot_at: string | null;
  guest_decision_token: string | null;     // GUEST credential — never in producer email
  guest_status_token: string | null;       // GUEST read-only status credential
  reminder_sent_at: string | null;
  expired_guest_notified_at: string | null;
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

// ─── Pre-visit config (booking-flyt-v1 slice 2) ─────────────────────────────
// Reminder to the producer after N hours without an answer (default 24), and
// automatic expiry after M hours (default 60, hard-clamped to the spec's
// 48–72 window so an env typo can never make requests die in an hour or
// linger for a week). Anything unparseable falls back to the default.
export function previsitReminderHours(): number {
  const n = parseFloat(process.env.BOOKING_PREVISIT_REMINDER_HOURS || "");
  return Number.isFinite(n) && n > 0 ? n : 24;
}
export function previsitExpireHours(): number {
  const n = parseFloat(process.env.BOOKING_PREVISIT_EXPIRE_HOURS || "");
  const raw = Number.isFinite(n) && n > 0 ? n : 60;
  return Math.min(72, Math.max(48, raw));
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
    pre_status:     ((row.pre_status as string | null) ?? "awaiting_provider") as BookingPreStatus,
    respond_token:            (row.respond_token as string | null) ?? null,
    respond_token_expires_at: (row.respond_token_expires_at as string | null) ?? null,
    respond_token_used_at:    (row.respond_token_used_at as string | null) ?? null,
    suggested_slot_at:        (row.suggested_slot_at as string | null) ?? null,
    guest_decision_token:     (row.guest_decision_token as string | null) ?? null,
    guest_status_token:       (row.guest_status_token as string | null) ?? null,
    reminder_sent_at:         (row.reminder_sent_at as string | null) ?? null,
    expired_guest_notified_at:(row.expired_guest_notified_at as string | null) ?? null,
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

  const now = new Date();
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
    created_at:    now.toISOString(),
    // Pre-visit answer loop (slice 2): every NEW booking gets the producer's
    // one-time expiring answer credential + the guest's read-only status
    // credential up front. guest_decision_token exists only once a new time
    // has actually been suggested.
    pre_status:               "awaiting_provider",
    respond_token:            generateConfirmToken(),
    respond_token_expires_at: new Date(now.getTime() + previsitExpireHours() * 3600_000).toISOString(),
    respond_token_used_at:    null,
    suggested_slot_at:        null,
    guest_decision_token:     null,
    guest_status_token:       generateConfirmToken(),
    reminder_sent_at:         null,
    expired_guest_notified_at: null,
  };

  db.prepare(`
    INSERT INTO gardssalg_bookings (
      booking_id, experience_id, provider_id, slot_at, party_size,
      guest_name, guest_email, guest_phone, booking_ref, confirm_token,
      source, status, commission_rate, notes, created_at,
      pre_status, respond_token, respond_token_expires_at, guest_status_token
    ) VALUES (
      @booking_id, @experience_id, @provider_id, @slot_at, @party_size,
      @guest_name, @guest_email, @guest_phone, @booking_ref, @confirm_token,
      @source, @status, @commission_rate, @notes, @created_at,
      @pre_status, @respond_token, @respond_token_expires_at, @guest_status_token
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

// Producer resolves a booking via the tokenized confirm page.
// Transitions: reserved → confirmed_attended|no_show, and (booking-flyt-v1,
// "bekreft-løkka") corrections BETWEEN the two resolved states — a mis-click
// on "ikke møtt" must not be permanent, since billable/commission hangs on
// it. Same status twice is an idempotent no-op (returns the row unchanged).
// 'cancelled' is terminal. Returns null only for unknown token / cancelled.
export function resolveBooking(
  confirm_token: string,
  newStatus: "confirmed_attended" | "no_show",
  resolvedBy: string,
): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const existing = getBookingByToken(confirm_token);
  if (!existing || existing.status === "cancelled") return null;
  if (existing.status === newStatus) return existing;

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

// Undo a resolution: back to 'reserved', billable off, resolution fields
// cleared. Idempotent when already reserved; null for unknown token or the
// terminal 'cancelled' state.
export function reopenBooking(confirm_token: string): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const existing = getBookingByToken(confirm_token);
  if (!existing || existing.status === "cancelled") return null;
  if (existing.status === "reserved") return existing;

  db.prepare(`
    UPDATE gardssalg_bookings
    SET status = 'reserved', resolved_by = NULL, resolved_at = NULL,
        billable = 0
    WHERE confirm_token = ?
  `).run(confirm_token);

  return getBookingByToken(confirm_token);
}

// Time guard for attendance resolution: attended/no_show only make sense
// AFTER the visit has started. slot_at is a naive datetime-local string
// ("2026-09-03T13:00", no timezone) parsed in the server's zone (UTC on
// Fly), so for an Oslo visit the guard opens up to ~2h after the actual
// local start — conservative in the right direction for "bekreft etter
// besøket". An unparseable slot_at returns true so a broken row can still
// be resolved rather than being stuck forever.
export function visitTimeReached(
  booking: Pick<GardssalgBooking, "slot_at">,
  now: Date = new Date(),
): boolean {
  const t = new Date(booking.slot_at).getTime();
  if (isNaN(t)) return true;
  return t <= now.getTime();
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

// Guest-controlled strings (name, notes, …) are interpolated into email
// HTML below — escape them so a note like "<script>…" renders as text in
// the producer's mail client instead of as markup.
function escEmailHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const confirmUrl = `${APP_URL}/kategori/gardssalg/bekreft/${booking.confirm_token}`;
  const ics = buildIcs(booking);

  const slotFormatted = new Date(booking.slot_at).toLocaleString("nb-NO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });

  // Pre-visit answer loop (slice 2): guests get an always-readable, never-
  // mutating status page keyed by guest_status_token. Legacy rows (created
  // before the slice) have no token → no link, exactly as before. NB: the
  // producer's respond_token/confirm_token must NEVER appear in this email.
  const statusUrl = booking.guest_status_token
    ? `${APP_URL}/kategori/gardssalg/status/${encodeURIComponent(booking.booking_ref)}/${booking.guest_status_token}`
    : null;

  const htmlContent = `
<p>Hei ${escEmailHtml(booking.guest_name)},</p>
<p>Din påmelding er registrert! Her er din bekreftelse:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
  ${booking.notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Din kommentar:</td><td>${escEmailHtml(booking.notes)}</td></tr>` : ""}
</table>
<p>Produsenten er varslet om forespørselen og svarer på e-post — du får beskjed så snart reservasjonen er bekreftet eller besvart.</p>
${statusUrl ? `<p>Du kan når som helst se gjeldende status her: <a href="${statusUrl}">statusside for reservasjonen</a>.</p>` : ""}
<p>En kalenderinvitasjon (ICS) er vedlagt denne e-posten.</p>
<p>Spørsmål? Svar på denne e-posten.</p>
<p>Hilsen<br>Opplevagent</p>
  `.trim();

  const textContent = `Hei ${booking.guest_name},\n\nDin påmelding er registrert.\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}${booking.notes ? `\nDin kommentar: ${booking.notes}` : ""}\n\nProdusenten er varslet om forespørselen og svarer på e-post — du får beskjed så snart reservasjonen er bekreftet eller besvart.${statusUrl ? `\nStatus for reservasjonen: ${statusUrl}` : ""}\n\nHilsen\nOpplevagent`;

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

  // Producer-facing confirm page (booking-flyt-v1 "bekreft-løkka"): the
  // tokenized link goes to the PRODUCER only — never into the guest email or
  // the booking API response, where it would let a guest resolve their own
  // attendance (commission integrity). The page itself mutates nothing on
  // GET; actions are POST buttons, so mail-client link prefetching is safe.
  const confirmUrl = `${APP_URL}/kategori/gardssalg/bekreft/${booking.confirm_token}`;

  // Pre-visit answer loop (slice 2): the producer answers the request on the
  // tokenized svar page — Bekreft / Foreslå nytt tidspunkt / Avslå. All three
  // links target the SAME non-mutating GET page (the choice itself is a POST
  // button there, so mail-client link prefetch can never answer a request) —
  // exact same PRG safety rationale as the post-visit bekreft page above.
  // Legacy rows (respond_token NULL) simply omit the block. The guest's
  // status/decision tokens must NEVER appear in this email.
  const respondUrl = booking.respond_token
    ? `${APP_URL}/kategori/gardssalg/svar/${booking.respond_token}`
    : null;
  const expireHours = previsitExpireHours();

  const htmlContent = `
<p>Hei,</p>
<p>Du har fått en ny reservasjonsforespørsel via Opplevagent:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Gjest:</td><td>${escEmailHtml(booking.guest_name)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">E-post:</td><td>${escEmailHtml(booking.guest_email)}</td></tr>
  ${booking.guest_phone ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Telefon:</td><td>${escEmailHtml(booking.guest_phone)}</td></tr>` : ""}
  ${booking.notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">Kommentar fra gjesten:</td><td>${escEmailHtml(booking.notes)}</td></tr>` : ""}
</table>
${respondUrl ? `<p><strong>Svar gjesten med ett klikk:</strong></p>
<p><a href="${respondUrl}">Bekreft reservasjonen</a><br>
<a href="${respondUrl}">Foreslå nytt tidspunkt</a><br>
<a href="${respondUrl}">Avslå forespørselen</a></p>
<p>Lenkene åpner svarsiden der du bekrefter valget ditt. Svar gjerne innen ${previsitReminderHours()} timer — uten svar innen ${expireHours} timer utløper forespørselen automatisk og gjesten får beskjed.</p>` : ""}
<p>Spørsmål fra gjesten kan besvares direkte — gjestens e-post står over.</p>
<p>Etter besøket: <a href="${confirmUrl}">bekreft oppmøte eller ikke-oppmøte her</a>.<br>
Lenkene er personlige for denne reservasjonen — ikke del dem videre.</p>
<p>Hilsen<br>Opplevagent</p>
  `.trim();

  const textContent = `Hei,\n\nDu har fått en ny reservasjonsforespørsel via Opplevagent.\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}\nGjest: ${booking.guest_name} (${booking.guest_email}${booking.guest_phone ? ", " + booking.guest_phone : ""})${booking.notes ? `\nKommentar fra gjesten: ${booking.notes}` : ""}\n${respondUrl ? `\nSvar gjesten (bekreft / foreslå nytt tidspunkt / avslå):\n${respondUrl}\nUten svar innen ${expireHours} timer utløper forespørselen automatisk og gjesten får beskjed.\n` : ""}\nEtter besøket: bekreft oppmøte her (personlig lenke, ikke del videre):\n${confirmUrl}\n\nHilsen\nOpplevagent`;

  await emailService.sendEmail({
    to: producerEmail,
    subject: `Ny reservasjon — ${booking.booking_ref}`,
    htmlContent,
    textContent,
    replyTo: `kontakt@opplevagent.no`,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Pre-visit answer loop (dev-request 2026-07-14-booking-flyt-v1, slice 2)
// ═══════════════════════════════════════════════════════════════════════════

// Lookup helpers — respond_token IS NOT NULL is implied (a NULL can never
// equal the parameter), so legacy rows are unreachable here by construction.
export function getBookingByRespondToken(respond_token: string): GardssalgBooking | null {
  if (!respond_token) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT * FROM gardssalg_bookings WHERE respond_token = ?")
    .get(respond_token) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

export function getBookingByGuestDecisionToken(token: string): GardssalgBooking | null {
  if (!token) return null;
  const db = getDb(VERTICAL);
  const row = db
    .prepare("SELECT * FROM gardssalg_bookings WHERE guest_decision_token = ?")
    .get(token) as Record<string, unknown> | undefined;
  return row ? hydrate(row) : null;
}

// One-time + expiring semantics for the producer's answer credential.
//   ok      → the svar page may offer actions
//   used    → a terminal answer was already given (used_at stamped, or the
//             pre_status is already terminal via the guest's decision)
//   expired → the request auto-expired (or the token's expiry passed)
// GET renders a friendly no-action page for used/expired; POST mutates
// NOTHING in those states (the negative tests pin this).
export function respondTokenState(
  booking: GardssalgBooking,
  now: Date = new Date(),
): "ok" | "used" | "expired" {
  if (booking.respond_token_used_at) return "used";
  if (booking.pre_status === "expired") return "expired";
  if (booking.pre_status === "provider_confirmed" || booking.pre_status === "provider_declined") {
    return "used";
  }
  if (
    booking.respond_token_expires_at &&
    new Date(booking.respond_token_expires_at).getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return "ok";
}

// Minimal shape check for a producer-suggested slot: the same naive
// datetime-local format the booking form itself submits ("2026-09-03T13:00"),
// parseable, and in the future.
export function isValidSuggestedSlot(slot: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(slot)) return false;
  const t = new Date(slot).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

// Producer answers "Bekreft": awaiting_provider → provider_confirmed,
// terminal — respond token consumed. Returns null (no mutation) for unknown
// token, non-ok token state, or a pre_status that isn't awaiting_provider
// (from time_suggested the pending guest decision owns the outcome; the
// producer's remaining moves there are re-suggest or decline).
export function producerRespondConfirm(
  respond_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByRespondToken(respond_token);
  if (!existing || respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider") return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_confirmed', respond_token_used_at = ?
    WHERE respond_token = ? AND pre_status = 'awaiting_provider' AND respond_token_used_at IS NULL
  `).run(now.toISOString(), respond_token);
  return getBookingByRespondToken(respond_token);
}

// Producer answers "Avslå": awaiting_provider|time_suggested →
// provider_declined, terminal — respond token consumed and any pending guest
// decision loses its actionable state (pre_status gate on the guest side).
export function producerRespondDecline(
  respond_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByRespondToken(respond_token);
  if (!existing || respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider" && existing.pre_status !== "time_suggested") {
    return null;
  }
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_declined', respond_token_used_at = ?
    WHERE respond_token = ? AND pre_status IN ('awaiting_provider','time_suggested')
      AND respond_token_used_at IS NULL
  `).run(now.toISOString(), respond_token);
  return getBookingByRespondToken(respond_token);
}

// Producer answers "Foreslå nytt tidspunkt": NOT terminal (the guest now owns
// the outcome), so the respond token is deliberately NOT consumed — the
// producer may correct a typo by re-suggesting (which ROTATES
// guest_decision_token, dead-linking the previously emailed one) or still
// decline. Returns null without mutating on invalid state/slot.
export function producerSuggestTime(
  respond_token: string,
  suggested_slot_at: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByRespondToken(respond_token);
  if (!existing || respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider" && existing.pre_status !== "time_suggested") {
    return null;
  }
  if (!isValidSuggestedSlot(suggested_slot_at, now)) return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'time_suggested', suggested_slot_at = ?, guest_decision_token = ?
    WHERE respond_token = ? AND pre_status IN ('awaiting_provider','time_suggested')
      AND respond_token_used_at IS NULL
  `).run(suggested_slot_at, generateConfirmToken(), respond_token);
  return getBookingByRespondToken(respond_token);
}

// Guest accepts the suggested time: slot_at is REPLACED by the suggestion
// (the post-visit visitTimeReached() guard then follows the agreed time) and
// the loop terminates as provider_confirmed. One-shot-for-action by state:
// only actionable while pre_status='time_suggested', so a second click — or a
// stale rotated link — mutates nothing.
export function guestAcceptSuggestion(
  guest_decision_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByGuestDecisionToken(guest_decision_token);
  if (!existing || existing.pre_status !== "time_suggested" || !existing.suggested_slot_at) {
    return null;
  }
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_confirmed', slot_at = suggested_slot_at,
        respond_token_used_at = ?
    WHERE guest_decision_token = ? AND pre_status = 'time_suggested'
  `).run(now.toISOString(), guest_decision_token);
  return getBookingByGuestDecisionToken(guest_decision_token);
}

// Guest declines the suggested time → provider_declined, terminal.
export function guestDeclineSuggestion(
  guest_decision_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByGuestDecisionToken(guest_decision_token);
  if (!existing || existing.pre_status !== "time_suggested") return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_declined', respond_token_used_at = ?
    WHERE guest_decision_token = ? AND pre_status = 'time_suggested'
  `).run(now.toISOString(), guest_decision_token);
  return getBookingByGuestDecisionToken(guest_decision_token);
}

// ─── Pre-visit emails ───────────────────────────────────────────────────────
// Guest emails are transactional (the guest asked for this booking) and are
// NOT behind the producer dispatch gates; every guest-controlled string is
// escEmailHtml()-escaped. Producer emails go through the SAME gate pair as
// sendProducerNotification — see sendGatedProducerEmail() below: gates off →
// no send, logged, never silently swallowed.

function slotNb(slot: string | null): string {
  if (!slot) return "";
  return new Date(slot).toLocaleString("nb-NO", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Oslo",
  });
}

function guestStatusUrl(booking: GardssalgBooking): string | null {
  return booking.guest_status_token
    ? `${APP_URL}/kategori/gardssalg/status/${encodeURIComponent(booking.booking_ref)}/${booking.guest_status_token}`
    : null;
}

const statusFooterHtml = (booking: GardssalgBooking): string => {
  const u = guestStatusUrl(booking);
  return u ? `<p>Se gjeldende status når som helst: <a href="${u}">statusside for reservasjonen</a>.</p>` : "";
};

// Guest: the producer confirmed (directly, or via the guest accepting a
// suggested time — pass acceptedSuggestion to word it accordingly).
export async function sendPrevisitConfirmedToGuest(
  booking: GardssalgBooking,
  acceptedSuggestion = false,
): Promise<void> {
  const slotFormatted = slotNb(booking.slot_at);
  const lead = acceptedSuggestion
    ? "Du har akseptert det nye tidspunktet — reservasjonen er nå bekreftet:"
    : "Gode nyheter — produsenten har bekreftet reservasjonen din:";
  await emailService.sendEmail({
    to: booking.guest_email,
    subject: `Reservasjonen er bekreftet — ${booking.booking_ref}`,
    htmlContent: `
<p>Hei ${escEmailHtml(booking.guest_name)},</p>
<p>${lead}</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
</table>
<p>Velkommen! Produsenten registrerer oppmøtet etter besøket.</p>
${statusFooterHtml(booking)}
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: `Hei ${booking.guest_name},\n\n${acceptedSuggestion ? "Du har akseptert det nye tidspunktet — reservasjonen er nå bekreftet." : "Produsenten har bekreftet reservasjonen din."}\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}${guestStatusUrl(booking) ? `\nStatus: ${guestStatusUrl(booking)}` : ""}\n\nHilsen\nOpplevagent`,
    replyTo: "kontakt@opplevagent.no",
  });
}

// Guest: the producer (or the guest's own decline of a suggestion) ended the
// request — apologetic, with a pointer to alternative producers.
export async function sendPrevisitDeclinedToGuest(booking: GardssalgBooking): Promise<void> {
  const slotFormatted = slotNb(booking.slot_at);
  const alternatives = `${APP_URL}/kategori/gardssalg`;
  await emailService.sendEmail({
    to: booking.guest_email,
    subject: `Reservasjonen kunne dessverre ikke bekreftes — ${booking.booking_ref}`,
    htmlContent: `
<p>Hei ${escEmailHtml(booking.guest_name)},</p>
<p>Vi beklager — reservasjonsforespørselen din (${booking.booking_ref}, ${slotFormatted}) kunne dessverre ikke bekreftes av produsenten denne gangen.</p>
<p>Det finnes flere produsenter som tar imot besøk: <a href="${alternatives}">se alternative tilbydere her</a>.</p>
${statusFooterHtml(booking)}
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: `Hei ${booking.guest_name},\n\nVi beklager — reservasjonsforespørselen din (${booking.booking_ref}, ${slotFormatted}) kunne dessverre ikke bekreftes av produsenten denne gangen.\nSe alternative tilbydere: ${alternatives}\n\nHilsen\nOpplevagent`,
    replyTo: "kontakt@opplevagent.no",
  });
}

// Guest: the producer suggested a new time — carries the guest's one-shot
// decision link. The producer's respond/confirm tokens must NEVER appear here.
export async function sendSuggestionToGuest(booking: GardssalgBooking): Promise<void> {
  if (!booking.guest_decision_token || !booking.suggested_slot_at) return;
  const decisionUrl = `${APP_URL}/kategori/gardssalg/gjestesvar/${booking.guest_decision_token}`;
  const originalFormatted = slotNb(booking.slot_at);
  const suggestedFormatted = slotNb(booking.suggested_slot_at);
  await emailService.sendEmail({
    to: booking.guest_email,
    subject: `Produsenten foreslår et nytt tidspunkt — ${booking.booking_ref}`,
    htmlContent: `
<p>Hei ${escEmailHtml(booking.guest_name)},</p>
<p>Produsenten kan dessverre ikke ta imot besøket ${originalFormatted}, men foreslår i stedet:</p>
<p style="font-size:1.05rem;font-weight:bold">${suggestedFormatted}</p>
<p><a href="${decisionUrl}">Svar på forslaget her</a> — du kan akseptere det nye tidspunktet eller avslå.</p>
<p>Lenken er personlig for denne reservasjonen (${booking.booking_ref}) — ikke del den videre.</p>
${statusFooterHtml(booking)}
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: `Hei ${booking.guest_name},\n\nProdusenten kan dessverre ikke ta imot besøket ${originalFormatted}, men foreslår i stedet:\n${suggestedFormatted}\n\nAksepter eller avslå forslaget her (personlig lenke):\n${decisionUrl}\n\nHilsen\nOpplevagent`,
    replyTo: "kontakt@opplevagent.no",
  });
}

// Guest: the request auto-expired without a producer answer — never a silent
// death. Apologetic + alternatives, mirrors the declined email.
export async function sendPrevisitExpiredToGuest(booking: GardssalgBooking): Promise<void> {
  const slotFormatted = slotNb(booking.slot_at);
  const alternatives = `${APP_URL}/kategori/gardssalg`;
  await emailService.sendEmail({
    to: booking.guest_email,
    subject: `Forespørselen utløp uten svar — ${booking.booking_ref}`,
    htmlContent: `
<p>Hei ${escEmailHtml(booking.guest_name)},</p>
<p>Vi beklager — produsenten har dessverre ikke besvart reservasjonsforespørselen din (${booking.booking_ref}, ${slotFormatted}) i tide, så den er nå utløpt.</p>
<p>Det finnes flere produsenter som tar imot besøk: <a href="${alternatives}">se alternative tilbydere her</a>.</p>
${statusFooterHtml(booking)}
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: `Hei ${booking.guest_name},\n\nVi beklager — produsenten har dessverre ikke besvart reservasjonsforespørselen din (${booking.booking_ref}, ${slotFormatted}) i tide, så den er nå utløpt.\nSe alternative tilbydere: ${alternatives}\n\nHilsen\nOpplevagent`,
    replyTo: "kontakt@opplevagent.no",
  });
}

// ─── Gated producer sends ───────────────────────────────────────────────────
// EVERY pre-visit producer email goes through here: the provider row is read
// fresh and the send only happens when isBookingPaused() allows it — the
// exact same gate pair (global master switch + per-provider booking_live,
// with the hidden-test-provider carve-out) the booking entry points enforce.
// Gates off or no epost on file → no send, one clear log line. Returns
// whether a send was actually attempted (the followup engine uses this to
// avoid stamping reminder_sent_at on a suppressed reminder).
function getProviderDispatchRow(provider_id: string): {
  navn: string | null;
  epost: string | null;
  booking_live: number | null;
  catalog_hidden: number | null;
} | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      "SELECT navn, epost, booking_live, catalog_hidden FROM experience_providers WHERE id = ?",
    )
    .get(provider_id) as
    | { navn: string | null; epost: string | null; booking_live: number | null; catalog_hidden: number | null }
    | undefined;
  return row ?? null;
}

async function sendGatedProducerEmail(
  booking: GardssalgBooking,
  kind: string,
  build: (producerEmail: string) => { subject: string; htmlContent: string; textContent: string },
): Promise<boolean> {
  const provider = getProviderDispatchRow(booking.provider_id);
  if (!provider || isBookingPaused(provider.booking_live, provider.catalog_hidden)) {
    console.log(
      `[booking-previsit] producer ${kind} SUPPRESSED by dispatch gate — provider ${booking.provider_id}, booking ${booking.booking_ref}`,
    );
    return false;
  }
  if (!provider.epost) {
    console.error(
      `[booking-previsit] producer ${kind} SKIPPED — no epost on file for provider ${booking.provider_id} (booking ${booking.booking_ref})`,
    );
    return false;
  }
  const { subject, htmlContent, textContent } = build(provider.epost);
  await emailService.sendEmail({
    to: provider.epost,
    subject,
    htmlContent,
    textContent,
    replyTo: "kontakt@opplevagent.no",
  });
  return true;
}

// Producer: reminder after previsitReminderHours() without an answer. Carries
// the svar link again (producer credential — fine in a producer email).
export async function sendPrevisitReminderToProducer(booking: GardssalgBooking): Promise<boolean> {
  if (!booking.respond_token) return false;
  const respondUrl = `${APP_URL}/kategori/gardssalg/svar/${booking.respond_token}`;
  const slotFormatted = slotNb(booking.slot_at);
  return sendGatedProducerEmail(booking, "reminder", () => ({
    subject: `Påminnelse: ubesvart reservasjonsforespørsel — ${booking.booking_ref}`,
    htmlContent: `
<p>Hei,</p>
<p>En reservasjonsforespørsel venter fortsatt på svar fra deg:</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Bookingref:</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Dato/tid:</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Antall:</td><td>${booking.party_size} person${booking.party_size > 1 ? "er" : ""}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">Gjest:</td><td>${escEmailHtml(booking.guest_name)}</td></tr>
</table>
<p><a href="${respondUrl}">Svar her: bekreft, foreslå nytt tidspunkt eller avslå</a>.</p>
<p>Uten svar innen ${previsitExpireHours()} timer fra forespørselen kom inn, utløper den automatisk og gjesten får beskjed.</p>
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: `Hei,\n\nEn reservasjonsforespørsel venter fortsatt på svar fra deg.\nBookingref: ${booking.booking_ref}\nDato/tid: ${slotFormatted}\nAntall: ${booking.party_size}\nGjest: ${booking.guest_name}\n\nSvar her (bekreft / foreslå nytt tidspunkt / avslå):\n${respondUrl}\n\nUten svar innen ${previsitExpireHours()} timer fra forespørselen kom inn, utløper den automatisk og gjesten får beskjed.\n\nHilsen\nOpplevagent`,
  }));
}

// Producer: outcome of the guest's decision on a suggested time.
export async function sendGuestDecisionToProducer(
  booking: GardssalgBooking,
  accepted: boolean,
): Promise<boolean> {
  const slotFormatted = slotNb(booking.slot_at);
  return sendGatedProducerEmail(booking, accepted ? "guest-accept" : "guest-decline", () => ({
    subject: accepted
      ? `Gjesten aksepterte det nye tidspunktet — ${booking.booking_ref}`
      : `Gjesten avslo det nye tidspunktet — ${booking.booking_ref}`,
    htmlContent: accepted
      ? `
<p>Hei,</p>
<p>Gjesten ${escEmailHtml(booking.guest_name)} har akseptert det nye tidspunktet for reservasjon ${booking.booking_ref}.</p>
<p>Avtalt tidspunkt er nå: <strong>${slotFormatted}</strong>.</p>
<p>Bekreft oppmøte etter besøket via lenken i den opprinnelige e-posten.</p>
<p>Hilsen<br>Opplevagent</p>`.trim()
      : `
<p>Hei,</p>
<p>Gjesten ${escEmailHtml(booking.guest_name)} kunne dessverre ikke på det foreslåtte tidspunktet, og reservasjonsforespørselen ${booking.booking_ref} er avsluttet.</p>
<p>Hilsen<br>Opplevagent</p>`.trim(),
    textContent: accepted
      ? `Hei,\n\nGjesten ${booking.guest_name} har akseptert det nye tidspunktet for reservasjon ${booking.booking_ref}.\nAvtalt tidspunkt er nå: ${slotFormatted}.\n\nHilsen\nOpplevagent`
      : `Hei,\n\nGjesten ${booking.guest_name} kunne dessverre ikke på det foreslåtte tidspunktet, og reservasjonsforespørselen ${booking.booking_ref} er avsluttet.\n\nHilsen\nOpplevagent`,
  }));
}

// ─── Reminder + auto-expiry engine ──────────────────────────────────────────
// Idempotent by construction: reminder_sent_at is stamped only on an ACTUAL
// send (a gate-suppressed reminder retries next run), expiry flips
// pre_status exactly once, and expired_guest_notified_at guards the guest
// notification — so calling this back-to-back does nothing the second time.
// Timestamp comparisons happen in JS (Date.parse) because created_at mixes
// ISO-with-Z (createBooking) and sqlite datetime('now') formats historically.
// Exposed via POST /api/opplevelser/admin/booking-followups (requireAdmin)
// and the hourly tick in src/index.ts; `now` is injectable for clock tests.
export interface BookingFollowupResult {
  examined: number;
  reminders_sent: number;
  reminders_suppressed: number;
  expired: number;
  expired_guests_notified: number;
  errors: number;
}

export async function processBookingFollowups(
  now: Date = new Date(),
): Promise<BookingFollowupResult> {
  const db = getDb(VERTICAL);
  const result: BookingFollowupResult = {
    examined: 0,
    reminders_sent: 0,
    reminders_suppressed: 0,
    expired: 0,
    expired_guests_notified: 0,
    errors: 0,
  };

  // Only slice-2 rows (respond_token set) still awaiting an answer, plus
  // already-expired rows whose guest was never notified (crash between the
  // status flip and the email must not orphan the apology — "aldri stille
  // død").
  const rows = db
    .prepare(`
      SELECT * FROM gardssalg_bookings
      WHERE respond_token IS NOT NULL
        AND (
          pre_status = 'awaiting_provider'
          OR (pre_status = 'expired' AND expired_guest_notified_at IS NULL)
        )
    `)
    .all() as Record<string, unknown>[];

  const nowMs = now.getTime();
  const reminderMs = previsitReminderHours() * 3600_000;

  for (const raw of rows) {
    const booking = hydrate(raw);
    result.examined++;
    try {
      // ── Expiry: respond_token_expires_at (stamped at creation from the
      // clamped previsitExpireHours()) is the single source of truth. ──
      const expiresMs = booking.respond_token_expires_at
        ? new Date(booking.respond_token_expires_at).getTime()
        : NaN;
      const shouldExpire =
        booking.pre_status === "awaiting_provider" &&
        Number.isFinite(expiresMs) &&
        expiresMs <= nowMs;

      if (shouldExpire) {
        db.prepare(`
          UPDATE gardssalg_bookings SET pre_status = 'expired'
          WHERE booking_id = ? AND pre_status = 'awaiting_provider'
        `).run(booking.booking_id);
        booking.pre_status = "expired";
        result.expired++;
      }

      if (booking.pre_status === "expired" && !booking.expired_guest_notified_at) {
        await sendPrevisitExpiredToGuest(booking);
        db.prepare(
          "UPDATE gardssalg_bookings SET expired_guest_notified_at = ? WHERE booking_id = ?",
        ).run(now.toISOString(), booking.booking_id);
        result.expired_guests_notified++;
        continue;
      }

      // ── Reminder: once, after previsitReminderHours() without an answer,
      // only while the request is still alive. ──
      if (
        booking.pre_status === "awaiting_provider" &&
        !booking.reminder_sent_at &&
        Number.isFinite(Date.parse(booking.created_at)) &&
        nowMs - Date.parse(booking.created_at) >= reminderMs
      ) {
        const sent = await sendPrevisitReminderToProducer(booking);
        if (sent) {
          db.prepare(
            "UPDATE gardssalg_bookings SET reminder_sent_at = ? WHERE booking_id = ?",
          ).run(now.toISOString(), booking.booking_id);
          result.reminders_sent++;
        } else {
          result.reminders_suppressed++;
        }
      }
    } catch (err) {
      result.errors++;
      console.error(
        `[booking-previsit] followup failed for ${booking.booking_ref}:`,
        err,
      );
    }
  }

  return result;
}
