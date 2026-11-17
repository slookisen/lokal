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
import { crmFromHeader } from "./crm-platform-identity";
import { tokenLogLabel } from "../utils/log-label";
import { isSourceClientLabel } from "../utils/url-utm";
import {
  awaitingExpiryDueMs,
  previsitReminderDue,
  recordProducerNotifyOutcome,
  followupClockFloorMs,
  isLegacyPreFloorRow,
  stampMs,
  type ProducerNotifyOutcome,
} from "./gardssalg-booking-followup";
import {
  honestReceiptEnabled,
  buildHonestReceiptEmail,
  buildConfirmedIcs,
  loadReceiptProvider,
  oa1Text,
  formatOsloInstant,
  CONFIRMED_ICS_CONTENT_TYPE,
} from "./gardssalg-honest-receipt";
import {
  visitConfirmedByProducer,
  CONFIRMED_VISIT_SQL,
  deadlineAfterSuggestion,
} from "./gardssalg-attendance-guard";
import { gardssalgNow } from "./gardssalg-test-clock";
import { gardssalgNotifyRecipient } from "./gardssalg-notify-address";
import { archiveProducerBookingMail } from "./gardssalg-booking-crm-archive";
import {
  emailText,
  fillEmailText,
  guestEmailLang,
  normaliseGuestLang,
  renderEmailBody,
  type EmailLang,
  type GardssalgEmailKey,
} from "./gardssalg-email-texts";

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
// providerCatalogHidden (optional) is experience_providers.catalog_hidden and
// providerIsTest (optional) is experience_providers.is_test_provider.
// catalog_hidden=1 means "not in the public catalog" and is set both for real
// producers who asked to be delisted (the CS "fjern oss" flow, POST
// /admin/gardssalg-provider-visibility) and for the controlled TEST provider.
// A catalog_hidden=1 row therefore ALWAYS pauses dispatch — regardless of
// booking_live and of the global master switch — UNLESS it is explicitly
// flagged is_test_provider=1. That flag is set ONLY by the admin-key-gated
// POST /admin/gardssalg/test-provider (and by the migration for the one known
// test row, see init-experiences.ts); the flagged test provider keeps
// dispatching even when the global master switch is off (notification email
// pinned by the admin caller, blast radius bounded to that address).
// Fixes the 2026-10-03 consent gap where a caller holding a delisted
// producer's raw provider_id (POST /api/opplevelser/book, the book_gardssalg
// MCP tool — neither goes through the slug lookup that 404s hidden rows)
// could dispatch a booking and notify them. Fail-closed: an omitted
// providerIsTest counts as "not a test provider". REAL visible providers
// (catalog_hidden 0/NULL) are unchanged: they still require BOTH the global
// BOOKING_DISPATCH_ENABLED master switch AND their own booking_live=1.
export function isBookingPaused(
  providerBookingLive: number | null | undefined,
  providerCatalogHidden?: number | null | undefined,
  providerIsTest?: number | null | undefined,
): boolean {
  // Must be onboarded either way.
  if (providerBookingLive !== 1) return true;
  if (providerCatalogHidden === 1) {
    // Delisted real producer (hidden, not the flagged test provider) → never
    // dispatch, whatever the master switch says.
    if (providerIsTest !== 1) return true;
    // Flagged, admin-created, email-pinned test provider → dispatch even if
    // the global master switch is off (real providers below still require it).
    return false;
  }
  // Real providers: unchanged double gate — still need the global master switch.
  return !bookingDispatchEnabled();
}

// ─── Honest paused-state copy (dev-request 2026-08-09-gardssalg-kommer-
// snart-fjernes-eier-aktivert-booking) ──────────────────────────────────────
// "Kommer snart" promised a timeline nobody controls; activation is the
// owner's call (the claim-portal checkbox / the admin lever), so every
// surface now states the plain fact instead. ONE source for the copy — the
// web API, the SSR panel, the profile page and the MCP tool all render
// these strings, never a re-worded inline variant.
export const BOOKING_NOT_ACTIVATED_MSG =
  "Booking er ikke aktivert for denne produsenten ennå.";
// dev-request 2026-11-06-opplevagent-meld-interesse-fjernes-mens-booking-av:
// the former «interest» variant promised an interest message that was never
// stored; with booking off the visitor is pointed at the producer's own
// contact routes instead (no promise of a reply or a booking).
export const BOOKING_NOT_ACTIVATED_CONTACT_MSG =
  BOOKING_NOT_ACTIVATED_MSG +
  " Ta kontakt med produsenten direkte.";

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
  /**
   * dev-request 2026-07-26-booking-test-send-guard. 1 = this booking is a
   * deliberate end-to-end test: every outgoing email for it (guest receipt
   * AND the producer notification that carries the actionable tokens) is
   * redirected to TEST_SEND_REDIRECT_EMAIL, and the row is marked so it can
   * be filtered out of stats. Settable ONLY from an admin-gated call — it is
   * not a field of BookingInputSchema, so it cannot be smuggled in through
   * any public booking payload. 0 for every existing and normal booking.
   */
  is_test: number;
  // O1-1 (R1/R11): the registered producer notification. The followup
  // clock starts at notify_sent_at; NULL = never reminded or expired.
  notify_sent_at: string | null;
  notify_failed_at: string | null;
  notify_retried_at: string | null;
  /** F1-1: AI assistant label (SOURCE_CLIENT_LABELS) or null. */
  source_client: string | null;
  /**
   * O4-2: the guest's language, "nb" or "en". NULL on rows created before
   * the column (= "nb"). Only decides the guest e-mails, and only with
   * GARDSSALG_EMAIL_EN_ENABLED (guestEmailLang()).
   */
  guest_lang?: EmailLang | null;
}

export const BookingInputSchema = z.object({
  experience_id: z.string().optional(),
  provider_id: z.string().min(1),
  slot_at: z.string().min(1),
  party_size: z.number().int().min(1).max(50),
  guest_name: z.string().min(1).max(200),
  guest_email: z.string().email(),
  guest_phone: z.string().max(30).optional(),
  // dev-request 2026-10-22-opplevagent-booking-provisjonssats-fra-offentlig-kall:
  // there is deliberately NO commission_rate field here. This schema parses the
  // untrusted body of the public entry points (POST /api/opplevelser/book, the
  // book_gardssalg MCP tool, the web form), and zod strips unknown keys, so a
  // caller-supplied rate never reaches createBooking(). The rate always comes
  // from experience_providers.commission_rate.
  notes: z.string().max(500).optional(),
  // dev-request 2026-07-14-booking-flyt-v1, slice 1 ("myk åpningstidsvalidering"):
  // when a guest resends after the route layer told them their slot falls
  // outside the provider's stated opening_hours_text, this flag says "yes,
  // I still want this time" and the route proceeds to create the booking
  // anyway. A deliberate, explicit schema field — zod already strips unknown
  // keys everywhere this schema is parsed, so this is not a smuggling risk.
  // Consumed at the route layer only (services/gardssalg-opening-hours.ts's
  // checkBookingSlotAllowed()) — createBooking() itself never reads or
  // stores it (no DB column for this slice).
  confirm_outside_hours: z.boolean().optional(),
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
    // Legacy rows predate the column; absent -> 0 (a real, non-test booking).
    is_test:                  Number(row.is_test ?? 0) === 1 ? 1 : 0,
    notify_sent_at:           (row.notify_sent_at as string | null) ?? null,
    notify_failed_at:         (row.notify_failed_at as string | null) ?? null,
    notify_retried_at:        (row.notify_retried_at as string | null) ?? null,
    source_client:            (row.source_client as string | null) ?? null,
    guest_lang:               row.guest_lang == null ? null : normaliseGuestLang(row.guest_lang),
  };
}

// `source` stamps the channel a booking came in through, for analytics only
// — it never changes validation, the DB table, the confirm-token lifecycle,
// or anything else about the flow below. Defaults to "opplevagent" (the web
// form's channel, unchanged for both existing call sites — opplevelser.ts's
// POST /api/opplevelser/book and experiences-seo.ts's no-JS SSR fallback —
// which never pass a second argument). experiences-mcp.ts's book_gardssalg
// tool is the only caller that passes "mcp".
//
// `opts.isTest` (dev-request 2026-07-26-booking-test-send-guard) marks the
// booking as a deliberate end-to-end test so every email it triggers is
// redirected to TEST_SEND_REDIRECT_EMAIL. It is a THIRD ARGUMENT on purpose,
// deliberately NOT a field of BookingInputSchema: the schema is what both
// public entry points (POST /api/opplevelser/book and the book_gardssalg MCP
// tool) parse their untrusted payload with, and zod strips unknown keys — so
// there is no field name a public caller could smuggle to reach this. Only an
// admin-gated call site passes it.
//
// `opts.guestLang` (O4-2) is the guest's language from the web form or the
// REST API: "en" or "nb", anything else (and a caller that passes nothing,
// such as the book_gardssalg MCP tool) is stored as "nb".
//
// `opts.sourceClient` (dev-request 2026-11-12-f1, F1-1) is the AI assistant
// the booking came from, set by the MCP tool and by the REST route for an
// ai_search caller. Only a value in SOURCE_CLIENT_LABELS is stored; anything
// else (and the web form, which never passes it) is stored as NULL.
export function createBooking(
  input: BookingInput,
  source: string = "opplevagent",
  opts: { isTest?: boolean; sourceClient?: string | null; guestLang?: unknown } = {},
): GardssalgBooking {
  const db = getDb(VERTICAL);

  // The rate is always the provider's own, never the caller's (see the note on
  // BookingInputSchema). NULL provider rate → NULL on the booking.
  const prov = db
    .prepare("SELECT commission_rate FROM experience_providers WHERE id = ?")
    .get(input.provider_id) as { commission_rate: number | null } | undefined;
  const commission_rate = prov?.commission_rate ?? null;

  const now = new Date();
  const booking: GardssalgBooking = {
    booking_id:    uuid(),
    experience_id: input.experience_id ?? null,
    provider_id:   input.provider_id,
    // TZ-fix 2026-07-30: a naked datetime-local slot from the public form is
    // Oslo wall time → stored as the UTC instant. Zone-carrying instants from
    // API/MCP callers pass through untouched.
    slot_at:       normaliseBookingSlotInput(input.slot_at),
    party_size:    input.party_size,
    guest_name:    input.guest_name,
    guest_email:   input.guest_email,
    guest_phone:   input.guest_phone ?? null,
    booking_ref:   generateBookingRef(),
    confirm_token: generateConfirmToken(),
    source,
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
    is_test:                  opts.isTest === true ? 1 : 0,
    notify_sent_at:           null,
    notify_failed_at:         null,
    notify_retried_at:        null,
    source_client:            isSourceClientLabel(opts.sourceClient) ? opts.sourceClient : null,
    guest_lang:               normaliseGuestLang(opts.guestLang),
  };

  db.prepare(`
    INSERT INTO gardssalg_bookings (
      booking_id, experience_id, provider_id, slot_at, party_size,
      guest_name, guest_email, guest_phone, booking_ref, confirm_token,
      source, status, commission_rate, notes, created_at,
      pre_status, respond_token, respond_token_expires_at, guest_status_token,
      is_test, source_client, guest_lang
    ) VALUES (
      @booking_id, @experience_id, @provider_id, @slot_at, @party_size,
      @guest_name, @guest_email, @guest_phone, @booking_ref, @confirm_token,
      @source, @status, @commission_rate, @notes, @created_at,
      @pre_status, @respond_token, @respond_token_expires_at, @guest_status_token,
      @is_test, @source_client, @guest_lang
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
// 'cancelled' is terminal. Returns null for unknown token / cancelled.
// O1-4 (R6): also null, with nothing written (status and billable
// untouched), unless the producer has confirmed the visit — see
// visitConfirmedByProducer() in gardssalg-attendance-guard.ts.
export function resolveBooking(
  confirm_token: string,
  newStatus: "confirmed_attended" | "no_show",
  resolvedBy: string,
): GardssalgBooking | null {
  const db = getDb(VERTICAL);
  const existing = getBookingByToken(confirm_token);
  if (!existing || existing.status === "cancelled") return null;
  if (!visitConfirmedByProducer(existing)) return null;
  if (existing.status === newStatus) return existing;

  const result = db.prepare(`
    UPDATE gardssalg_bookings
    SET status = ?, resolved_by = ?, resolved_at = datetime('now'),
        billable = ?
    WHERE confirm_token = ? AND status != 'cancelled' AND ${CONFIRMED_VISIT_SQL}
  `).run(
    newStatus,
    resolvedBy,
    newStatus === "confirmed_attended" ? 1 : 0,
    confirm_token,
  );
  if (result.changes === 0) return null;

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
// be resolved rather than being stuck forever. The default `now` is
// gardssalgNow(): real time, except a test-only override off production
// (O1-7, services/gardssalg-test-clock.ts).
export function visitTimeReached(
  booking: Pick<GardssalgBooking, "slot_at">,
  now: Date = gardssalgNow(),
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

// O2-2 («Mine besøk» in the gårdssalg owner dashboard): the requests for ONE
// provider in every status — the owner's list (waiting, upcoming, earlier).
// Read only, scoped by provider_id. Every still-open row (status 'reserved',
// the same set as getPendingBookings) is always included, so nothing the
// owner can act on is cut; the closed history is capped at the newest
// `historyLimit` rows by created_at.
export const PROVIDER_BOOKINGS_HISTORY_LIMIT = 200;
export function listProviderBookings(
  provider_id: string,
  historyLimit: number = PROVIDER_BOOKINGS_HISTORY_LIMIT,
): GardssalgBooking[] {
  if (!provider_id) return [];
  const db = getDb(VERTICAL);
  const closed = db
    .prepare(
      "SELECT * FROM gardssalg_bookings WHERE provider_id = ? AND status != 'reserved' ORDER BY created_at DESC LIMIT ?",
    )
    .all(provider_id, Math.max(0, Math.floor(historyLimit))) as Record<string, unknown>[];
  return [...getPendingBookings(provider_id), ...closed.map(hydrate)];
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

// O4-2: every sentence below comes from the text register
// (gardssalg-email-texts.ts); only markup and layout stay here.
function nbText(key: GardssalgEmailKey, vars?: Record<string, string>): string {
  const t = emailText(key, "nb");
  return vars ? fillEmailText(t, vars) : t;
}
const partyNb = (n: number): string => nbText(n > 1 ? "party.many" : "party.one", { antall: String(n) });
const signoffHtml = (): string => nbText("signoff").replace("\n", "<br>");

// ─── ICS + confirmation email — shared by every booking entry point ────────
// Lives here (not in a route file) so both POST /api/opplevelser/book
// (opplevelser.ts) and the gårdssalg SSR reservation form's no-JS fallback
// (experiences-seo.ts) go through the exact same code — no duplicated
// business logic between the JSON API and the progressively-enhanced form.
// O1-4 (R8): includeGuest=false drops the ATTENDEE line (guest name and
// e-mail) — used by the download route when the guest's token is missing.
// The e-mailed file goes to the guest and keeps it.
export function buildIcs(booking: GardssalgBooking, includeGuest: boolean = true): string {
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
    ...(includeGuest ? [`ATTENDEE;CN=${booking.guest_name}:mailto:${booking.guest_email}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export async function sendBookingConfirmation(booking: GardssalgBooking): Promise<void> {
  // O1-2 (R3/G13): with GARDSSALG_HONEST_RECEIPT_ENABLED the guest gets a
  // receipt that says "received, not confirmed" and NO calendar file (that
  // goes with the producer's confirmation). Flag off: the legacy mail below.
  if (honestReceiptEnabled()) {
    await sendHonestReceipt(booking);
    return;
  }

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

  // The legacy receipt is not translated (text package OA-2 A): always Norwegian.
  const htmlContent = `
<p>${nbText("greeting", { gjest: escEmailHtml(booking.guest_name) })}</p>
<p>${nbText("receipt.legacy.lead")}</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.ref")}</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.time")}</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.party")}</td><td>${partyNb(booking.party_size)}</td></tr>
  ${booking.notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.note")}</td><td>${escEmailHtml(booking.notes)}</td></tr>` : ""}
</table>
<p>${nbText("receipt.legacy.notified")}</p>
${statusUrl ? `<p>${nbText("receipt.legacy.status", { statuslenke: `<a href="${statusUrl}">${nbText("footer.statusLinkText")}</a>` })}</p>` : ""}
<p>${nbText("receipt.legacy.ics")}</p>
<p>${nbText("receipt.legacy.questions")}</p>
<p>${signoffHtml()}</p>
  `.trim();

  const textContent = `${nbText("greeting", { gjest: booking.guest_name })}\n\n${nbText("receipt.legacy.textLead")}\n${nbText("label.ref")} ${booking.booking_ref}\n${nbText("label.time")} ${slotFormatted}\n${nbText("label.party")} ${booking.party_size}${booking.notes ? `\n${nbText("label.note")} ${booking.notes}` : ""}\n\n${nbText("receipt.legacy.notified")}${statusUrl ? `\n${nbText("receipt.legacy.statusText", { statusside: statusUrl })}` : ""}\n\n${nbText("signoff")}`;

  await emailService.sendEmail({
    to: booking.guest_email,
    subject: nbText("receipt.legacy.subject", { ref: booking.booking_ref }),
    htmlContent,
    textContent,
    replyTo: `kontakt@opplevagent.no`,
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
    isTestSend: booking.is_test === 1,
    attachments: [
      {
        filename: `gardssalg-${booking.booking_ref}.ics`,
        content: ics,
        contentType: "text/calendar; charset=utf-8; method=REQUEST",
      },
    ],
  });

  // Producer confirm link sent. Never log the URL itself: it carries the
  // producer's confirm_token (T1, eierportal bølge 0) — log a hash label.
  console.log(`[booking] ${booking.booking_ref} confirm link sent (token ${tokenLogLabel(booking.confirm_token)})`);
}

// O1-2: the honest receipt (text package OA-1 §1.2), never the legacy one
// with the flag on. The provider row is read before the first await.
// O4-2: in the guest's language (guestEmailLang()).
async function sendHonestReceipt(booking: GardssalgBooking): Promise<void> {
  const provider = loadReceiptProvider(booking.provider_id);
  const mail = buildHonestReceiptEmail(
    booking,
    { producerName: provider.navn, statusUrl: guestStatusUrl(booking) },
    guestEmailLang(booking),
  );
  await emailService.sendEmail({
    to: booking.guest_email,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: `kontakt@opplevagent.no`,
    from: crmFromHeader("experiences"),
    isTestSend: booking.is_test === 1,
  });
  console.log(`[booking] ${booking.booking_ref} honest guest receipt sent`);
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
  // dev-request 2026-07-14-booking-flyt-v1, slice 1 ("myk åpningstids-
  // validering"): the provider's OWN stated opening_hours_text, attached
  // ALWAYS when non-blank — regardless of whether this particular booking
  // fell inside or outside those hours — so a mismatch is visible to the
  // producer ("tilbyderens oppgitte tider legges alltid ved i varselet så
  // avviket er synlig for dem", the dev-request's own spec line). Optional
  // and additive: every existing caller that doesn't pass it keeps behaving
  // exactly as before.
  openingHoursText?: string | null,
  // O1-1 (R11): `retry` = the followup job's single re-send of a failed
  // first send. The outcome is stamped on the row (notify_sent_at /
  // notify_failed_at) and a failure or a missing address alerts the admin
  // (recordProducerNotifyOutcome). Never throws, so the call sites stay
  // fire-and-forget.
  opts: { retry?: boolean } = {},
): Promise<ProducerNotifyOutcome> {
  // Resolve the DB handle NOW (same tick as the caller): the send resolves
  // later, and a late getDb() could open a different database.
  const db = getDb(VERTICAL);
  // O4-3: the confirmed address while a changed one awaits confirmation (flag off: unchanged).
  producerEmail = gardssalgNotifyRecipient(booking.provider_id, producerEmail);
  const record = (outcome: ProducerNotifyOutcome, reason?: string) =>
    recordProducerNotifyOutcome(db, booking, outcome, { retry: opts.retry, reason });
  if (!producerEmail || !producerEmail.trim()) {
    console.error(
      `[booking] producer notification SKIPPED — no epost on file for provider ${booking.provider_id} (booking ${booking.booking_ref})`,
    );
    await record("not_live");
    return "not_live";
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
  // status/decision tokens must NEVER appear in this email. The deadline is
  // rendered from the STAMPED respond_token_expires_at (the value the expiry
  // engine actually honors), never recomputed from the live env.
  const respondUrl = booking.respond_token
    ? `${APP_URL}/kategori/gardssalg/svar/${booking.respond_token}`
    : null;
  const deadlineFormatted = booking.respond_token_expires_at
    ? slotNb(booking.respond_token_expires_at)
    : null;

  // Slice 1 ("myk åpningstidsvalidering"): attach the producer's OWN stated
  // hours whenever non-blank, regardless of inside/outside-hours outcome —
  // this is what makes a mismatch visible to them (see this function's
  // param doc comment).
  const hoursRaw = openingHoursText && openingHoursText.trim() ? openingHoursText.trim() : null;

  // Producer e-mails are always Norwegian (text package OA-2 A).
  const htmlContent = `
<p>${nbText("greeting.producer")}</p>
<p>${nbText("producer.new.lead")}</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.ref")}</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.time")}</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.party")}</td><td>${partyNb(booking.party_size)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.guest")}</td><td>${escEmailHtml(booking.guest_name)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.email")}</td><td>${escEmailHtml(booking.guest_email)}</td></tr>
  ${booking.guest_phone ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.phone")}</td><td>${escEmailHtml(booking.guest_phone)}</td></tr>` : ""}
  ${booking.notes ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.note")}</td><td>${escEmailHtml(booking.notes)}</td></tr>` : ""}
  ${hoursRaw ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.hours")}</td><td>${escEmailHtml(hoursRaw)}</td></tr>` : ""}
</table>
${respondUrl ? `<p><strong>${nbText("producer.new.respondHeading")}</strong></p>
<p><a href="${respondUrl}" style="display:inline-block;background:#1d4e46;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">${nbText("producer.new.respondButton")}</a></p>
<p>${nbText("producer.new.respondChoices")}${deadlineFormatted ? ` ${nbText("producer.deadline", { frist: `<strong>${deadlineFormatted}</strong>` })}` : ""}</p>` : ""}
<p>${nbText("producer.new.guestQuestions")}</p>
<p>${nbText("producer.new.after", { lenke: `<a href="${confirmUrl}">${nbText("producer.new.afterLinkText")}</a>` })}<br>
${nbText("producer.new.linksPersonal")}</p>
<p>${signoffHtml()}</p>
  `.trim();

  const textContent = `${nbText("greeting.producer")}\n\n${nbText("producer.new.textLead")}\n${nbText("label.ref")} ${booking.booking_ref}\n${nbText("label.time")} ${slotFormatted}\n${nbText("label.party")} ${booking.party_size}\n${nbText("producer.label.guest")} ${booking.guest_name} (${booking.guest_email}${booking.guest_phone ? ", " + booking.guest_phone : ""})${booking.notes ? `\n${nbText("producer.label.note")} ${booking.notes}` : ""}${hoursRaw ? `\n${nbText("producer.label.hours")} ${hoursRaw}` : ""}\n${respondUrl ? `\n${nbText("producer.new.respondText")}\n${respondUrl}${deadlineFormatted ? `\n${nbText("producer.deadline", { frist: deadlineFormatted })}` : ""}\n` : ""}\n${nbText("producer.new.afterText")}\n${confirmUrl}\n\n${nbText("signoff")}`;

  const subject = nbText("producer.new.subject", { ref: booking.booking_ref });
  let sendResult: { success?: boolean; messageId?: string; error?: string } | void;
  try {
    sendResult = await emailService.sendEmail({
      to: producerEmail,
      subject,
      htmlContent,
      textContent,
      replyTo: `kontakt@opplevagent.no`,
      // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
      // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
      // Resend verifies one domain — so the display name is what carries it.
      from: crmFromHeader("experiences"),
      // The PRODUCER email is the one carrying the actionable respond/confirm
      // tokens — redirecting only the guest receipt would still hit a real
      // producer with a test. See services/send-guard.ts.
      isTestSend: booking.is_test === 1,
    });
  } catch (err) {
    console.error(`[booking] producer notification FAILED for ${booking.booking_ref}:`, err);
    await record("failed", String((err as Error)?.message || err));
    return "failed";
  }
  // emailService reports a transport failure as { success: false }.
  if (sendResult && sendResult.success === false) {
    console.error(`[booking] producer notification FAILED for ${booking.booking_ref}: ${sendResult.error || "unknown error"}`);
    await record("failed", String(sendResult.error || "unknown error"));
    return "failed";
  }
  await record("sent");
  // O4-5b: file the sent mail in the booking's CRM thread (flag off: no-op; never throws).
  archiveProducerBookingMail({
    booking,
    kind: opts.retry ? "producer_new_retry" : "producer_new",
    to: producerEmail,
    subject,
    textContent,
    htmlContent,
    sendResult,
  });
  return "sent";
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
// datetime-local format the booking form itself submits ("2026-09-03T13:00",
// optionally with seconds), parseable, and in the future. Anchored ($) so
// trailing garbage never sneaks past the parseability check.
/**
 * Convert a naked datetime-local string («YYYY-MM-DDTHH:mm», what the
 * <input type="datetime-local"> fields on the booking + svar pages submit)
 * from EUROPE/OSLO WALL TIME to a UTC ISO instant.
 *
 * The bug this exists for (Daniel, E2E-test 2026-07-30): the naked string was
 * stored verbatim, `new Date()` on the server (TZ=UTC) read it as UTC, and
 * every display formats in Europe/Oslo — so the time a producer TYPED came
 * out two hours later everywhere. A wall time typed by a Norwegian producer
 * for a Norwegian farm visit IS Oslo time; this makes that explicit.
 *
 * DST-safe via double correction: guess the instant as if the wall time were
 * UTC, read Oslo's offset at that instant, adjust, then re-read the offset at
 * the adjusted instant (handles the ±1h boundary days). Pure — exported for
 * tests.
 */
export function osloDatetimeLocalToUtcIso(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((input || "").trim());
  if (!m) return null;
  const y = +m[1]!, mo = +m[2]!, d = +m[3]!, h = +m[4]!, mi = +m[5]!, sec = +(m[6] ?? "0");
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, sec);
  if (!Number.isFinite(asUtc)) return null;
  const osloOffsetMin = (atMs: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Oslo",
      timeZoneName: "longOffset",
    }).formatToParts(new Date(atMs));
    const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const om = /GMT([+-])(\d{2}):(\d{2})/.exec(tz);
    if (!om) return 0;
    return (om[1] === "-" ? -1 : 1) * (+om[2]! * 60 + +om[3]!);
  };
  let instant = asUtc - osloOffsetMin(asUtc) * 60_000;
  instant = asUtc - osloOffsetMin(instant) * 60_000;
  const d2 = new Date(instant);
  return Number.isFinite(d2.getTime()) ? d2.toISOString() : null;
}

/**
 * Round a wall-clock time (already broken into components) up to the START
 * of the NEXT hour — always strictly greater than the input, even when the
 * input is already exactly on an hour boundary (e.g. 13:00:00 -> 14:00, not
 * 13:00). Pure calendar arithmetic done on a Date.UTC-labelled timeline used
 * purely as a component-math scratch space (no real UTC/offset conversion
 * happens here, so this needs no DST handling of its own — it just carries
 * whatever wall-clock components it's given forward). Returns a
 * "YYYY-MM-DDTHH:mm" string, the exact format <input type="datetime-local">
 * consumes. Exported for tests.
 */
export function nextRoundHourWallTime(y: number, mo: number, d: number, h: number, mi: number, s: number): string {
  const scratch = Date.UTC(y, mo - 1, d, h, mi, s);
  const flooredToHour = scratch - (scratch % 3_600_000);
  const nextHour = new Date(flooredToHour + 3_600_000);
  const pad = (n: number, len = 2): string => String(n).padStart(len, "0");
  const yy = nextHour.getUTCFullYear();
  const mm = pad(nextHour.getUTCMonth() + 1);
  const dd = pad(nextHour.getUTCDate());
  const hh = pad(nextHour.getUTCHours());
  return `${pad(yy, 4)}-${mm}-${dd}T${hh}:00`;
}

/**
 * The booking form's default `slot_at` value: the next round hour in
 * EUROPE/OSLO wall-clock time, computed from `now` (injectable for tests,
 * defaults to `new Date()`). Reads Oslo's current wall-clock components via
 * Intl.DateTimeFormat (hourCycle "h23" so midnight is "00", not "24"), then
 * delegates to nextRoundHourWallTime — this function's ONLY job is the
 * UTC-instant -> Oslo-wall-clock-components step; the hour-rounding math
 * lives in nextRoundHourWallTime alone. Pure given an injected `now`.
 * Exported for tests.
 */
export function defaultBookingSlotAtDatetimeLocal(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): number => +(parts.find((p) => p.type === type)?.value ?? "0");
  return nextRoundHourWallTime(get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second"));
}

/**
 * Normalise ANY slot input to the canonical stored form: a naked
 * datetime-local string is Oslo wall time → UTC ISO; a string that already
 * carries a zone (Z or ±hh:mm) passes through untouched (API/MCP callers
 * send proper instants); anything else is returned as-is — this function
 * normalises, it does not validate. Pure — exported for tests.
 */
export function normaliseBookingSlotInput(input: string): string {
  const naked = osloDatetimeLocalToUtcIso(input);
  return naked ?? input;
}

export function isValidSuggestedSlot(slot: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(slot)) return false;
  // TZ-fix 2026-07-30: the future-check must judge the instant the producer
  // MEANT (Oslo wall time), not the naked string read as server-local.
  const iso = osloDatetimeLocalToUtcIso(slot);
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) && t > now.getTime();
}

// The pre-visit loop only exists for a booking that is still post-visit
// 'reserved' — once attendance is resolved (confirmed_attended/no_show) or
// the booking is cancelled, every pre-visit action/reminder/expiry is moot
// and must neither fire nor mutate (review finding 3).
export function previsitOpen(booking: Pick<GardssalgBooking, "status">): boolean {
  return booking.status === "reserved";
}

// When the request will auto-expire, in epoch ms (NaN = never/unknown).
// awaiting_provider: the stamped respond_token_expires_at. time_suggested:
// whichever comes FIRST of the token expiry and the suggested visit time
// itself — a suggestion whose time has passed unanswered can never be
// accepted into the past, so the loop must close then (review finding 1).
export function previsitExpiryDueMs(booking: GardssalgBooking): number {
  const tokenMs = booking.respond_token_expires_at
    ? new Date(booking.respond_token_expires_at).getTime()
    : NaN;
  if (booking.pre_status !== "time_suggested") return tokenMs;
  const suggestedMs = booking.suggested_slot_at
    ? new Date(booking.suggested_slot_at).getTime()
    : NaN;
  if (!Number.isFinite(tokenMs)) return suggestedMs;
  if (!Number.isFinite(suggestedMs)) return tokenMs;
  return Math.min(tokenMs, suggestedMs);
}

// Whether the guest's accept/decline of a suggested time is still available:
// booking still 'reserved' post-visit, pre_status still time_suggested, and
// the loop's expiry (token expiry OR the suggested time itself) not yet
// reached — accepting a slot that already lies in the past would open the
// post-visit attendance guard immediately (review finding 1).
export function guestDecisionActionable(
  booking: GardssalgBooking,
  now: Date = new Date(),
): boolean {
  if (!previsitOpen(booking)) return false;
  if (booking.pre_status !== "time_suggested" || !booking.suggested_slot_at) return false;
  const dueMs = previsitExpiryDueMs(booking);
  return !Number.isFinite(dueMs) || dueMs > now.getTime();
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
  if (!existing || !previsitOpen(existing)) return null;
  if (respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider") return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_confirmed', respond_token_used_at = ?
    WHERE respond_token = ? AND pre_status = 'awaiting_provider' AND respond_token_used_at IS NULL
      AND status = 'reserved'
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
  if (!existing || !previsitOpen(existing)) return null;
  if (respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider" && existing.pre_status !== "time_suggested") {
    return null;
  }
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_declined', respond_token_used_at = ?
    WHERE respond_token = ? AND pre_status IN ('awaiting_provider','time_suggested')
      AND respond_token_used_at IS NULL AND status = 'reserved'
  `).run(now.toISOString(), respond_token);
  return getBookingByRespondToken(respond_token);
}

// Producer answers "Foreslå nytt tidspunkt": NOT terminal (the guest now owns
// the outcome), so the respond token is deliberately NOT consumed — the
// producer may correct a typo by re-suggesting (which ROTATES
// guest_decision_token, dead-linking the previously emailed one) or still
// decline. Returns null without mutating on invalid state/slot.
// O1-4 (R7): every suggestion moves the answer deadline
// (respond_token_expires_at) to 48 hours after the suggestion, never earlier
// than it already was (deadlineAfterSuggestion()).
export function producerSuggestTime(
  respond_token: string,
  suggested_slot_at: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByRespondToken(respond_token);
  if (!existing || !previsitOpen(existing)) return null;
  if (respondTokenState(existing, now) !== "ok") return null;
  if (existing.pre_status !== "awaiting_provider" && existing.pre_status !== "time_suggested") {
    return null;
  }
  if (!isValidSuggestedSlot(suggested_slot_at, now)) return null;
  // TZ-fix 2026-07-30: the form's naked datetime-local IS Oslo wall time —
  // store the UTC instant, never the ambiguous naked string. Validation above
  // deliberately still runs on the RAW input (its regex is the form contract).
  const storedSlot = normaliseBookingSlotInput(suggested_slot_at);
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'time_suggested', suggested_slot_at = ?, guest_decision_token = ?,
        respond_token_expires_at = ?
    WHERE respond_token = ? AND pre_status IN ('awaiting_provider','time_suggested')
      AND respond_token_used_at IS NULL AND status = 'reserved'
  `).run(
    storedSlot,
    generateConfirmToken(),
    deadlineAfterSuggestion(existing.respond_token_expires_at, now),
    respond_token,
  );
  return getBookingByRespondToken(respond_token);
}

// Guest accepts the suggested time: slot_at is REPLACED by the suggestion
// (the post-visit visitTimeReached() guard then follows the agreed time) and
// the loop terminates as provider_confirmed. One-shot-for-action by state:
// only actionable while pre_status='time_suggested', so a second click — or a
// stale rotated link — mutates nothing. Time-bounded (review finding 1):
// guestDecisionActionable() refuses once the loop's expiry OR the suggested
// time itself has passed — an acceptance may never set slot_at into the past.
export function guestAcceptSuggestion(
  guest_decision_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByGuestDecisionToken(guest_decision_token);
  if (!existing || !guestDecisionActionable(existing, now)) return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_confirmed', slot_at = suggested_slot_at,
        respond_token_used_at = ?
    WHERE guest_decision_token = ? AND pre_status = 'time_suggested' AND status = 'reserved'
  `).run(now.toISOString(), guest_decision_token);
  return getBookingByGuestDecisionToken(guest_decision_token);
}

// Guest declines the suggested time → provider_declined, terminal. Same
// actionability window as accept: after the loop's expiry the followup
// engine owns the closure (expired + guest notification).
export function guestDeclineSuggestion(
  guest_decision_token: string,
  now: Date = new Date(),
): GardssalgBooking | null {
  const existing = getBookingByGuestDecisionToken(guest_decision_token);
  if (!existing || !guestDecisionActionable(existing, now)) return null;
  const db = getDb(VERTICAL);
  db.prepare(`
    UPDATE gardssalg_bookings
    SET pre_status = 'provider_declined', respond_token_used_at = ?
    WHERE guest_decision_token = ? AND pre_status = 'time_suggested' AND status = 'reserved'
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
  // Legacy rows stored the naked datetime-local string verbatim; those were
  // typed as Oslo wall time, so route them through the same converter before
  // formatting — otherwise old bookings keep the +2h display error forever.
  const iso = osloDatetimeLocalToUtcIso(slot) ?? slot;
  return new Date(iso).toLocaleString("nb-NO", {
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
  return u ? `<p>${nbText("footer.status", { statuslenke: `<a href="${u}">${nbText("footer.statusLinkText")}</a>` })}</p>` : "";
};

// O4-2: English guest e-mails (GARDSSALG_EMAIL_EN_ENABLED and guest_lang
// "en", see guestEmailLang()). Built in the layout of text package OA-2 A
// from the register's English texts: paragraphs joined by a blank line, the
// ones that do not apply (null) left out, URLs shown as links in the HTML.
const enText = (key: GardssalgEmailKey): string => emailText(key, "en");

function slotEn(slot: string | null): string {
  if (!slot) return "";
  return formatOsloInstant(osloDatetimeLocalToUtcIso(slot) ?? slot, "en");
}

function englishGuestMail(
  booking: GardssalgBooking,
  subjectKey: GardssalgEmailKey,
  paragraphs: Array<string | null>,
  vars: Record<string, string> = {},
): { subject: string; htmlContent: string; textContent: string } {
  const raw: Record<string, string> = {
    gjest: booking.guest_name,
    produsent: loadReceiptProvider(booking.provider_id).navn,
    ref: booking.booking_ref,
    tid: slotEn(booking.slot_at),
    antall: String(booking.party_size),
    statusside: guestStatusUrl(booking) ?? "",
    oversikt: `${APP_URL}/kategori/gardssalg`,
    ...vars,
  };
  const body = paragraphs.filter((p): p is string => !!p).join("\n\n");
  const { text, html } = renderEmailBody(body, raw, ["statusside", "oversikt", "svarlenke"]);
  return { subject: fillEmailText(enText(subjectKey), { ref: booking.booking_ref }), htmlContent: html, textContent: text };
}

const enStatusFooter = (booking: GardssalgBooking): string | null =>
  guestStatusUrl(booking) ? enText("footer.status") : null;

// Guest: the producer confirmed (directly, or via the guest accepting a
// suggested time — pass acceptedSuggestion to word it accordingly).
export async function sendPrevisitConfirmedToGuest(
  booking: GardssalgBooking,
  acceptedSuggestion = false,
): Promise<void> {
  const lang = guestEmailLang(booking);
  const slotFormatted = slotNb(booking.slot_at);
  const lead = acceptedSuggestion
    ? nbText("guest.confirmed.leadAccepted")
    : nbText("guest.confirmed.lead");
  // O1-2 (R4): with GARDSSALG_HONEST_RECEIPT_ENABLED the calendar file comes
  // HERE — on the producer's confirmation, and as a new file when the guest
  // accepted a new time — with the producer's address as LOCATION. Flag off:
  // icsLine is "" and no attachment, so the mail is byte-identical to before.
  let icsLine = "";
  let icsAttachment: { filename: string; content: string; contentType: string } | null = null;
  if (honestReceiptEnabled()) {
    const provider = loadReceiptProvider(booking.provider_id);
    icsLine = oa1Text(acceptedSuggestion ? "confirmed.newTimeIcsLine" : "confirmed.icsLine", lang);
    icsAttachment = {
      filename: `gardssalg-${booking.booking_ref}.ics`,
      content: buildConfirmedIcs(
        booking,
        { producerName: provider.navn, sted: provider.sted, statusUrl: guestStatusUrl(booking) },
        lang,
      ),
      contentType: CONFIRMED_ICS_CONTENT_TYPE,
    };
  }
  const mail = lang === "en"
    ? englishGuestMail(booking, "guest.confirmed.subject", [
      enText("greeting"),
      enText(acceptedSuggestion ? "guest.confirmed.leadAccepted" : "guest.confirmed.lead"),
      `${enText("label.ref")} {ref}\n${enText("label.time")} {tid}\n${enText("label.party")} {antall}`,
      icsLine || null,
      enStatusFooter(booking),
      enText("signoff"),
    ])
    : {
      subject: nbText("guest.confirmed.subject", { ref: booking.booking_ref }),
      htmlContent: `
<p>${nbText("greeting", { gjest: escEmailHtml(booking.guest_name) })}</p>
<p>${lead}</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.ref")}</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.time")}</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.party")}</td><td>${partyNb(booking.party_size)}</td></tr>
</table>${icsLine ? `\n<p>${escEmailHtml(icsLine)}</p>` : ""}
<p>${nbText("guest.confirmed.welcome")}</p>
${statusFooterHtml(booking)}
<p>${signoffHtml()}</p>`.trim(),
      textContent: `${nbText("greeting", { gjest: booking.guest_name })}\n\n${nbText(acceptedSuggestion ? "guest.confirmed.textLeadAccepted" : "guest.confirmed.textLead")}\n${nbText("label.ref")} ${booking.booking_ref}\n${nbText("label.time")} ${slotFormatted}\n${nbText("label.party")} ${booking.party_size}${icsLine ? `\n\n${icsLine}` : ""}${guestStatusUrl(booking) ? `\n${nbText("footer.statusText", { statusside: guestStatusUrl(booking)! })}` : ""}\n\n${nbText("signoff")}`,
    };
  await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
    ...(icsAttachment ? { attachments: [icsAttachment] } : {}),
  });
}

// Guest: the producer (or the guest's own decline of a suggestion) ended the
// request — apologetic, with a pointer to alternative producers.
export async function sendPrevisitDeclinedToGuest(booking: GardssalgBooking): Promise<void> {
  const slotFormatted = slotNb(booking.slot_at);
  const alternatives = `${APP_URL}/kategori/gardssalg`;
  const vars = { ref: booking.booking_ref, tid: slotFormatted };
  const mail = guestEmailLang(booking) === "en"
    ? englishGuestMail(booking, "guest.declined.subject", [
      enText("greeting"),
      enText("guest.declined.body"),
      enText("guest.alternatives"),
      enText("signoff"),
    ])
    : {
      subject: nbText("guest.declined.subject", { ref: booking.booking_ref }),
      htmlContent: `
<p>${nbText("greeting", { gjest: escEmailHtml(booking.guest_name) })}</p>
<p>${nbText("guest.declined.body", vars)}</p>
<p>${nbText("guest.alternatives", { alternativlenke: `<a href="${alternatives}">${nbText("guest.alternativesLinkText")}</a>` })}</p>
${statusFooterHtml(booking)}
<p>${signoffHtml()}</p>`.trim(),
      textContent: `${nbText("greeting", { gjest: booking.guest_name })}\n\n${nbText("guest.declined.body", vars)}\n${nbText("guest.alternativesText", { oversikt: alternatives })}\n\n${nbText("signoff")}`,
    };
  await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
  });
}

// Guest: the producer suggested a new time — carries the guest's one-shot
// decision link. The producer's respond/confirm tokens must NEVER appear here.
export async function sendSuggestionToGuest(booking: GardssalgBooking): Promise<void> {
  if (!booking.guest_decision_token || !booking.suggested_slot_at) return;
  const decisionUrl = `${APP_URL}/kategori/gardssalg/gjestesvar/${booking.guest_decision_token}`;
  const originalFormatted = slotNb(booking.slot_at);
  const suggestedFormatted = slotNb(booking.suggested_slot_at);
  const mail = guestEmailLang(booking) === "en"
    ? englishGuestMail(booking, "guest.suggestion.subject", [
      enText("greeting"),
      enText("guest.suggestion.lead"),
      "{nytt_tidspunkt}",
      enText("guest.suggestion.reply"),
      enText("guest.suggestion.personal"),
      enStatusFooter(booking),
      enText("signoff"),
    ], { nytt_tidspunkt: slotEn(booking.suggested_slot_at), svarlenke: decisionUrl })
    : {
      subject: nbText("guest.suggestion.subject", { ref: booking.booking_ref }),
      htmlContent: `
<p>${nbText("greeting", { gjest: escEmailHtml(booking.guest_name) })}</p>
<p>${nbText("guest.suggestion.lead", { tid: originalFormatted })}</p>
<p style="font-size:1.05rem;font-weight:bold">${suggestedFormatted}</p>
<p>${nbText("guest.suggestion.reply", { svarlenke: `<a href="${decisionUrl}">${nbText("guest.suggestion.replyLinkText")}</a>` })}</p>
<p>${nbText("guest.suggestion.personal", { ref: booking.booking_ref })}</p>
${statusFooterHtml(booking)}
<p>${signoffHtml()}</p>`.trim(),
      textContent: `${nbText("greeting", { gjest: booking.guest_name })}\n\n${nbText("guest.suggestion.lead", { tid: originalFormatted })}\n${suggestedFormatted}\n\n${nbText("guest.suggestion.replyText")}\n${decisionUrl}\n\n${nbText("signoff")}`,
    };
  await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
  });
}

// Guest: the request auto-expired — never a silent death. Apologetic +
// alternatives, mirrors the declined email. Two truthful variants: a plain
// unanswered request vs. a suggested time that was never finally settled
// (suggested_slot_at present — review finding 1: time_suggested expires too).
export async function sendPrevisitExpiredToGuest(booking: GardssalgBooking): Promise<void> {
  const slotFormatted = slotNb(booking.slot_at);
  const alternatives = `${APP_URL}/kategori/gardssalg`;
  const reasonKey: GardssalgEmailKey = booking.suggested_slot_at ? "guest.expired.bodySuggested" : "guest.expired.body";
  const reasonHtml = nbText(reasonKey, { ref: booking.booking_ref, tid: slotFormatted });
  const mail = guestEmailLang(booking) === "en"
    ? englishGuestMail(booking, "guest.expired.subject", [
      enText("greeting"),
      enText(reasonKey),
      enText("guest.alternatives"),
      enText("signoff"),
    ])
    : {
      subject: nbText("guest.expired.subject", { ref: booking.booking_ref }),
      htmlContent: `
<p>${nbText("greeting", { gjest: escEmailHtml(booking.guest_name) })}</p>
<p>${reasonHtml}</p>
<p>${nbText("guest.alternatives", { alternativlenke: `<a href="${alternatives}">${nbText("guest.alternativesLinkText")}</a>` })}</p>
${statusFooterHtml(booking)}
<p>${signoffHtml()}</p>`.trim(),
      textContent: `${nbText("greeting", { gjest: booking.guest_name })}\n\n${reasonHtml}\n${nbText("guest.alternativesText", { oversikt: alternatives })}\n\n${nbText("signoff")}`,
    };
  await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
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
  is_test_provider: number | null;
} | null {
  const db = getDb(VERTICAL);
  const row = db
    .prepare(
      "SELECT navn, epost, booking_live, catalog_hidden, is_test_provider FROM experience_providers WHERE id = ?",
    )
    .get(provider_id) as
    | { navn: string | null; epost: string | null; booking_live: number | null; catalog_hidden: number | null; is_test_provider: number | null }
    | undefined;
  // O4-3: the confirmed address while a changed one awaits confirmation (flag off: unchanged).
  return row ? { ...row, epost: gardssalgNotifyRecipient(provider_id, row.epost) ?? null } : null;
}

// Exported for O1-5 (gardssalg-cancel.ts): the producer's cancellation notice
// goes through the same gates.
export async function sendGatedProducerEmail(
  booking: GardssalgBooking,
  kind: string,
  build: (producerEmail: string) => { subject: string; htmlContent: string; textContent: string },
): Promise<boolean> {
  const provider = getProviderDispatchRow(booking.provider_id);
  if (!provider || isBookingPaused(provider.booking_live, provider.catalog_hidden, provider.is_test_provider)) {
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
  const sendResult = await emailService.sendEmail({
    to: provider.epost,
    subject,
    htmlContent,
    textContent,
    replyTo: "kontakt@opplevagent.no",
    // Steg 3 / funn 2: this mail carries Opplevagent content, so it must READ
    // as Opplevagent in the inbox list. The address stays rettfrabonden.com —
    // Resend verifies one domain — so the display name is what carries it.
    from: crmFromHeader("experiences"),
    isTestSend: booking.is_test === 1,
  });
  // O4-5b: file the sent mail in the booking's CRM thread (flag off: no-op; never throws).
  archiveProducerBookingMail({ booking, kind, to: provider.epost, subject, textContent, htmlContent, sendResult });
  return true;
}

// Producer: reminder after previsitReminderHours() without an answer. Carries
// the svar link again (producer credential — fine in a producer email).
export async function sendPrevisitReminderToProducer(booking: GardssalgBooking): Promise<boolean> {
  if (!booking.respond_token) return false;
  const respondUrl = `${APP_URL}/kategori/gardssalg/svar/${booking.respond_token}`;
  const slotFormatted = slotNb(booking.slot_at);
  // Deadline from the STAMPED expiry (what the engine actually honors), not
  // recomputed from the live env.
  const deadlineFormatted = booking.respond_token_expires_at
    ? slotNb(booking.respond_token_expires_at)
    : null;
  const deadlineHtml = deadlineFormatted
    ? nbText("producer.deadline", { frist: `<strong>${deadlineFormatted}</strong>` })
    : nbText("producer.deadlineNone");
  const deadlineText = deadlineFormatted
    ? nbText("producer.deadline", { frist: deadlineFormatted })
    : nbText("producer.deadlineNone");
  return sendGatedProducerEmail(booking, "reminder", () => ({
    subject: nbText("producer.reminder.subject", { ref: booking.booking_ref }),
    htmlContent: `
<p>${nbText("greeting.producer")}</p>
<p>${nbText("producer.reminder.lead")}</p>
<table style="border-collapse:collapse;font-family:sans-serif">
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.ref")}</td><td>${booking.booking_ref}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.time")}</td><td>${slotFormatted}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("label.party")}</td><td>${partyNb(booking.party_size)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;font-weight:bold">${nbText("producer.label.guest")}</td><td>${escEmailHtml(booking.guest_name)}</td></tr>
</table>
<p><a href="${respondUrl}">${nbText("producer.reminder.linkText")}</a>.</p>
<p>${deadlineHtml}</p>
<p>${signoffHtml()}</p>`.trim(),
    textContent: `${nbText("greeting.producer")}\n\n${nbText("producer.reminder.textLead")}\n${nbText("label.ref")} ${booking.booking_ref}\n${nbText("label.time")} ${slotFormatted}\n${nbText("label.party")} ${booking.party_size}\n${nbText("producer.label.guest")} ${booking.guest_name}\n\n${nbText("producer.reminder.respondText")}\n${respondUrl}\n\n${deadlineText}\n\n${nbText("signoff")}`,
  }));
}

// Producer: outcome of the guest's decision on a suggested time.
export async function sendGuestDecisionToProducer(
  booking: GardssalgBooking,
  accepted: boolean,
): Promise<boolean> {
  const slotFormatted = slotNb(booking.slot_at);
  return sendGatedProducerEmail(booking, accepted ? "guest-accept" : "guest-decline", () => ({
    subject: nbText(accepted ? "producer.guestAccepted.subject" : "producer.guestDeclined.subject", { ref: booking.booking_ref }),
    htmlContent: accepted
      ? `
<p>${nbText("greeting.producer")}</p>
<p>${nbText("producer.guestAccepted.body", { gjest: escEmailHtml(booking.guest_name), ref: booking.booking_ref })}</p>
<p>${nbText("producer.guestAccepted.time", { tid: `<strong>${slotFormatted}</strong>` })}</p>
<p>${nbText("producer.guestAccepted.attendance")}</p>
<p>${signoffHtml()}</p>`.trim()
      : `
<p>${nbText("greeting.producer")}</p>
<p>${nbText("producer.guestDeclined.body", { gjest: escEmailHtml(booking.guest_name), ref: booking.booking_ref })}</p>
<p>${signoffHtml()}</p>`.trim(),
    textContent: accepted
      ? `${nbText("greeting.producer")}\n\n${nbText("producer.guestAccepted.body", { gjest: booking.guest_name, ref: booking.booking_ref })}\n${nbText("producer.guestAccepted.time", { tid: slotFormatted })}\n\n${nbText("signoff")}`
      : `${nbText("greeting.producer")}\n\n${nbText("producer.guestDeclined.body", { gjest: booking.guest_name, ref: booking.booking_ref })}\n\n${nbText("signoff")}`,
  }));
}

// ─── Reminder + auto-expiry engine ──────────────────────────────────────────
// Idempotent AND concurrency-safe (review finding 2): every send is claimed
// FIRST via a guarded UPDATE whose .changes result decides whether THIS call
// owns the send — better-sqlite3 executes synchronously, so two overlapping
// processBookingFollowups() calls can never both see .changes === 1 for the
// same row. A claim is released again if the send throws (retry next run) or
// the reminder is gate-suppressed (retry once the gate returns) — a stamp
// never claims an email that wasn't actually handed to the mailer.
// Scope: only post-visit-'reserved' rows (review finding 3) in
// awaiting_provider OR time_suggested (review finding 1: a suggestion
// expires too — at the token expiry or the suggested time itself, whichever
// comes first), plus already-expired rows whose guest was never notified
// (crash between flip and email must not orphan the apology — "aldri stille
// død"). Reminders only chase awaiting_provider: in time_suggested the
// producer HAS answered.
// Timestamp comparisons happen in JS (Date.parse) because created_at mixes
// ISO-with-Z (createBooking) and sqlite datetime('now') formats historically.
// Exposed via POST /api/opplevelser/admin/booking-followups (requireAdmin)
// and the hourly tick in src/index.ts; `now` is injectable for clock tests.
export interface BookingFollowupResult {
  examined: number;
  /** O1-1 (R11): single re-sends of a failed producer notification attempted. */
  producer_notify_retried: number;
  reminders_sent: number;
  reminders_suppressed: number;
  expired: number;
  expired_guests_notified: number;
  errors: number;
  /**
   * O4-5: guest reminders sent the day before a confirmed visit. Present only
   * with GARDSSALG_GUEST_REMINDER_ENABLED on, so the result (and the admin
   * POST response) is unchanged with the flag off.
   */
  guest_reminders_sent?: number;
}

export async function processBookingFollowups(
  now: Date = new Date(),
): Promise<BookingFollowupResult> {
  const db = getDb(VERTICAL);
  const result: BookingFollowupResult = {
    examined: 0,
    producer_notify_retried: 0,
    reminders_sent: 0,
    reminders_suppressed: 0,
    expired: 0,
    expired_guests_notified: 0,
    errors: 0,
  };

  // O1-1 (R11): one re-send of a producer notification that failed. Claimed
  // first (notify_retried_at), like every other step. Before the send the
  // respond deadline is re-stamped from now, so the deadline the e-mail
  // states is the one the expiry below honours (the clock starts at the
  // registered notification). Gate off → claim released, retried later.
  const failedNotify = db
    .prepare(`
      SELECT * FROM gardssalg_bookings
      WHERE respond_token IS NOT NULL AND status = 'reserved' AND pre_status = 'awaiting_provider'
        AND notify_failed_at IS NOT NULL AND notify_retried_at IS NULL AND notify_sent_at IS NULL
    `)
    .all() as Record<string, unknown>[];
  for (const raw of failedNotify) {
    const booking = hydrate(raw);
    try {
      // A request whose visit time has already passed is not re-sent (and not
      // claimed): asking the producer to answer it would be pointless.
      // Known, accepted: such a row (failed, slot passed) is then neither
      // re-sent nor expired — it stays awaiting_provider with no guest e-mail;
      // the admin already got the failure alert for it.
      const slotMs = stampMs(booking.slot_at);
      if (Number.isFinite(slotMs) && slotMs <= now.getTime()) continue;
      // The claim re-checks the state the SELECT saw: a row answered,
      // cancelled or delivered in between is left alone.
      const claim = db
        .prepare(`
          UPDATE gardssalg_bookings SET notify_retried_at = ?
          WHERE booking_id = ? AND notify_retried_at IS NULL
            AND status = 'reserved' AND pre_status = 'awaiting_provider'
            AND notify_sent_at IS NULL AND notify_failed_at IS NOT NULL
        `)
        .run(now.toISOString(), booking.booking_id);
      if (claim.changes !== 1) continue;
      const provider = getProviderDispatchRow(booking.provider_id);
      if (!provider || isBookingPaused(provider.booking_live, provider.catalog_hidden, provider.is_test_provider)) {
        db.prepare("UPDATE gardssalg_bookings SET notify_retried_at = NULL WHERE booking_id = ?").run(booking.booking_id);
        console.log(`[booking-previsit] producer notification retry SUPPRESSED by dispatch gate — booking ${booking.booking_ref}`);
        continue;
      }
      booking.respond_token_expires_at = new Date(now.getTime() + previsitExpireHours() * 3600_000).toISOString();
      db.prepare("UPDATE gardssalg_bookings SET respond_token_expires_at = ? WHERE booking_id = ?")
        .run(booking.respond_token_expires_at, booking.booking_id);
      const hours = db
        .prepare("SELECT opening_hours_text FROM experience_providers WHERE id = ?")
        .get(booking.provider_id) as { opening_hours_text: string | null } | undefined;
      await sendProducerNotification(booking, provider.epost, hours?.opening_hours_text ?? null, { retry: true });
      result.producer_notify_retried++;
    } catch (err) {
      result.errors++;
      console.error(`[booking-previsit] producer notification retry failed for ${booking.booking_ref}:`, err);
    }
  }

  // Only slice-2 rows (respond_token set): live pre-visit loops on bookings
  // still post-visit-'reserved', plus already-expired rows whose guest was
  // never notified.
  const rows = db
    .prepare(`
      SELECT * FROM gardssalg_bookings
      WHERE respond_token IS NOT NULL
        AND (
          (status = 'reserved' AND pre_status IN ('awaiting_provider','time_suggested'))
          OR (pre_status = 'expired' AND expired_guest_notified_at IS NULL)
        )
    `)
    .all() as Record<string, unknown>[];

  const nowMs = now.getTime();

  for (const raw of rows) {
    const booking = hydrate(raw);
    result.examined++;
    try {
      // ── Expiry (previsitFollowupDue()): awaiting_provider 60 h after the
      // registered producer notification; time_suggested at the token
      // expiry OR the suggested time itself, whichever comes first. ──
      const due = previsitFollowupDue(booking, nowMs);
      const shouldExpire = due.expire;

      if (shouldExpire) {
        const flip = db.prepare(`
          UPDATE gardssalg_bookings SET pre_status = 'expired'
          WHERE booking_id = ? AND pre_status IN ('awaiting_provider','time_suggested')
            AND status = 'reserved'
        `).run(booking.booking_id);
        // .changes guards the counter under concurrent calls — only the call
        // that actually flipped the row counts (and proceeds to notify below;
        // a racing call that lost the flip still passes through the
        // notification claim, which is itself guarded).
        if (flip.changes === 1) result.expired++;
        booking.pre_status = "expired";
      }

      if (booking.pre_status === "expired" && !booking.expired_guest_notified_at) {
        // Claim BEFORE sending — the guarded UPDATE is the concurrency lock.
        const claim = db.prepare(`
          UPDATE gardssalg_bookings SET expired_guest_notified_at = ?
          WHERE booking_id = ? AND expired_guest_notified_at IS NULL
        `).run(now.toISOString(), booking.booking_id);
        if (claim.changes === 1 && !booking.guest_email?.trim()) {
          // Guest contact already cleared by the gardssalg-guest-contact-sweep:
          // nothing to e-mail. The claim stays set so the row is not re-examined.
        } else if (claim.changes === 1) {
          try {
            await sendPrevisitExpiredToGuest(booking);
            result.expired_guests_notified++;
          } catch (err) {
            // Release the claim so the next run retries — the guest must
            // never silently miss the closure email.
            db.prepare(
              "UPDATE gardssalg_bookings SET expired_guest_notified_at = NULL WHERE booking_id = ?",
            ).run(booking.booking_id);
            throw err;
          }
        }
        continue;
      }

      // ── Reminder: once, after previsitReminderHours() without an answer,
      // only while the request is still alive and unanswered. ──
      if (due.remind) {
        // Claim BEFORE sending (concurrency lock, as above).
        const claim = db.prepare(`
          UPDATE gardssalg_bookings SET reminder_sent_at = ?
          WHERE booking_id = ? AND reminder_sent_at IS NULL
            AND pre_status = 'awaiting_provider' AND status = 'reserved'
        `).run(now.toISOString(), booking.booking_id);
        if (claim.changes === 1) {
          let sent = false;
          try {
            sent = await sendPrevisitReminderToProducer(booking);
          } catch (err) {
            db.prepare(
              "UPDATE gardssalg_bookings SET reminder_sent_at = NULL WHERE booking_id = ?",
            ).run(booking.booking_id);
            throw err;
          }
          if (sent) {
            result.reminders_sent++;
          } else {
            // Gate-suppressed: release the claim so the reminder retries
            // once the dispatch gate is back on.
            db.prepare(
              "UPDATE gardssalg_bookings SET reminder_sent_at = NULL WHERE booking_id = ?",
            ).run(booking.booking_id);
            result.reminders_suppressed++;
          }
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

  // ── O4-5: the guest's reminder the day before a confirmed visit. Flag off:
  // no query, no write, no send, and the result keeps its old shape. ──
  if (gardssalgGuestReminderEnabled()) {
    result.guest_reminders_sent = 0;
    await processGuestReminders(now, result);
  }

  return result;
}

// ─── O1-1 (R1): what the followup job decides for one row ──────────────────
// awaiting_provider: reminder previsitReminderHours() and expiry
// previsitExpireHours() after the REGISTERED producer notification
// (notify_sent_at, never before FOLLOWUP_CLOCK_FLOOR) — a row without one is
// neither reminded nor expired, except a legacy row created before the floor
// with every notify_* column NULL, whose clock starts at the floor. time_suggested: the producer HAS answered, so
// the guest-side deadline (previsitExpiryDueMs()) is unchanged. Shared by the
// job and the dry-run count, so the two can never disagree.
export function previsitFollowupDue(
  booking: GardssalgBooking,
  nowMs: number,
): { remind: boolean; expire: boolean } {
  if (!booking.respond_token || booking.status !== "reserved") return { remind: false, expire: false };
  if (booking.pre_status === "time_suggested") {
    const dueMs = previsitExpiryDueMs(booking);
    return { remind: false, expire: Number.isFinite(dueMs) && dueMs <= nowMs };
  }
  if (booking.pre_status !== "awaiting_provider") return { remind: false, expire: false };
  const expireMs = awaitingExpiryDueMs(booking, previsitExpireHours());
  const expire = Number.isFinite(expireMs) && expireMs <= nowMs;
  return { expire, remind: !expire && previsitReminderDue(booking, nowMs, previsitReminderHours()) };
}

export interface BookingFollowupDryRun {
  would_remind: number;
  would_expire: number;
  /**
   * awaiting_provider rows created at/after the clock floor without a
   * registered producer notification (never reminded/expired). Legacy rows
   * are NOT counted here — see legacy_counted_from_floor.
   */
  without_registered_notification: number;
  /**
   * awaiting_provider rows created before the clock floor with every notify_*
   * column NULL (predate the columns): reminded/expired counting from the floor.
   */
  legacy_counted_from_floor: number;
  clock_floor: string;
}

// Read-only: how many rows processBookingFollowups() would remind and expire
// at `now`. Ignores the dispatch gate (a gate-suppressed reminder still counts).
export function countBookingFollowupsDue(now: Date = new Date()): BookingFollowupDryRun {
  const db = getDb(VERTICAL);
  const rows = db
    .prepare(`
      SELECT * FROM gardssalg_bookings
      WHERE respond_token IS NOT NULL AND status = 'reserved'
        AND pre_status IN ('awaiting_provider','time_suggested')
    `)
    .all() as Record<string, unknown>[];
  const out: BookingFollowupDryRun = {
    would_remind: 0,
    would_expire: 0,
    without_registered_notification: 0,
    legacy_counted_from_floor: 0,
    clock_floor: new Date(followupClockFloorMs()).toISOString(),
  };
  const nowMs = now.getTime();
  for (const raw of rows) {
    const booking = hydrate(raw);
    const due = previsitFollowupDue(booking, nowMs);
    if (due.expire) out.would_expire++;
    else if (due.remind) out.would_remind++;
    if (booking.pre_status === "awaiting_provider" && !booking.notify_sent_at) {
      if (isLegacyPreFloorRow(booking)) out.legacy_counted_from_floor++;
      else out.without_registered_notification++;
    }
  }
  return out;
}

// ─── O4-5: reminder to the guest the day before a confirmed visit ──────────
// A2A dev-request 2026-11-12-opplevagent-o4-epost-og-tekster, slice O4-5.
// Behind GARDSSALG_GUEST_REMINDER_ENABLED (off unless exactly "true", read on
// every call like the other GARDSSALG_* flags). Run by the followup job above
// (the hourly booking-followups tick in src/index.ts and POST
// /admin/booking-followups); no scheduler of its own.
//
// Who: a visit the PRODUCER HAS CONFIRMED — pre_status 'provider_confirmed'
// (the producer pressed «Bekreft», or the guest accepted the producer's
// suggested time) while the post-visit status is still 'reserved'. Never a
// pending (awaiting_provider), suggested (time_suggested), declined, expired
// or cancelled booking, never one already resolved after the visit, and never
// a row whose guest contact the 30-day sweep has cleared.
//
// When: «dagen før» (OA-2 B), as the subject says «I morgen» / «Tomorrow».
// Both must hold at the send moment:
//   1. the visit's Europe/Oslo calendar date is exactly the day after the
//      send moment's Europe/Oslo date (calendar arithmetic, so DST-safe), and
//   2. the visit is still in the future and at most
//      GUEST_REMINDER_WINDOW_HOURS (24) away.
// With the hourly tick a visit confirmed in good time gets the reminder about
// 24 hours before (e.g. 15:00 the day before a 15:00 visit). A visit confirmed
// later on the day before gets it on the next tick. A visit confirmed on the
// day itself (or after the last tick of the day before) never gets one: there
// is no moment at which «I morgen» would be true. A visit that has passed never
// gets one. No separate minimum lead time: rule 1 already excludes the
// same-day case the earlier 2-hour bound was for; the only short-lead case left
// is a visit just after midnight reminded late the evening before, where
// «I morgen» is still true.
//
// Once: guest_reminder_sent_at is claimed with a guarded UPDATE (… IS NULL,
// plus the confirmed/reserved state) BEFORE the send; only the call whose
// UPDATE changed the row sends, so two overlapping ticks cannot both send
// (better-sqlite3 runs synchronously). A send that throws or reports failure
// releases the claim, so the next tick retries while the window is open.
//
// Text: OA-2 B, verbatim, in the O4-2 register (guest.reminder.*). English only
// with GARDSSALG_EMAIL_EN_ENABLED and guest_lang "en" (guestEmailLang()).
// The cancel line links the status page only when GARDSSALG_CANCEL_ENABLED is
// on (that is where the guest cancels); otherwise the guest is asked to reply
// to the e-mail (reply-to kontakt@opplevagent.no, like every guest e-mail).

export const GUEST_REMINDER_WINDOW_HOURS = 24;

/** Off unless exactly "true", read on every call. */
export function gardssalgGuestReminderEnabled(): boolean {
  return process.env.GARDSSALG_GUEST_REMINDER_ENABLED === "true";
}

// Same rule as gardssalgCancelEnabled() in gardssalg-cancel.ts (which imports
// this module, so it is not imported here).
function guestCancelEnabled(): boolean {
  return process.env.GARDSSALG_CANCEL_ENABLED === "true";
}

// The slot_at bounds only keep past and far-off visits out of the scan; the
// exact rule is guestReminderDue(). They compare as text with a margin of a
// day on each side, which is safe for every slot_at format in the table
// (ISO with Z from createBooking(), legacy naked Oslo "YYYY-MM-DDTHH:MM", and
// SQLite "YYYY-MM-DD HH:MM:SS"): all start with the date, and the margin
// covers the time-zone offset and the ' ' / 'T' separator.
const GUEST_REMINDER_CANDIDATES_SQL = `
  SELECT * FROM gardssalg_bookings
  WHERE status = 'reserved' AND pre_status = 'provider_confirmed'
    AND guest_reminder_sent_at IS NULL
    AND slot_at >= ? AND slot_at <= ?
`;

function guestReminderCandidates(nowMs: number): Record<string, unknown>[] {
  const day = 24 * 3600_000;
  return getDb(VERTICAL)
    .prepare(GUEST_REMINDER_CANDIDATES_SQL)
    .all(new Date(nowMs - day).toISOString(), new Date(nowMs + (GUEST_REMINDER_WINDOW_HOURS * 3600_000) + 2 * day).toISOString()) as Record<string, unknown>[];
}

const OSLO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
});

/** The Europe/Oslo calendar date of an instant, "YYYY-MM-DD". */
export function osloDateOf(ms: number): string {
  const parts = OSLO_DATE.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar day after "YYYY-MM-DD" (pure date arithmetic, no time zone). */
function nextCalendarDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

type ReminderRow = GardssalgBooking & { guest_reminder_sent_at?: string | null };

function hydrateReminderRow(raw: Record<string, unknown>): ReminderRow {
  return { ...hydrate(raw), guest_reminder_sent_at: (raw.guest_reminder_sent_at as string | null) ?? null };
}

/** The visit start in epoch ms (a legacy naked slot is Oslo wall time); NaN when unreadable. */
function visitStartMs(slot: string | null): number {
  if (!slot) return NaN;
  return Date.parse(osloDatetimeLocalToUtcIso(slot) ?? slot);
}

/**
 * Whether the job sends the guest reminder for this booking at `nowMs`.
 * Shared by the job and the dry-run count, so the two cannot disagree.
 */
export function guestReminderDue(booking: ReminderRow, nowMs: number): boolean {
  if (booking.status !== "reserved" || booking.pre_status !== "provider_confirmed") return false;
  if (booking.guest_reminder_sent_at) return false;
  if (!booking.guest_email?.trim()) return false;
  const startMs = visitStartMs(booking.slot_at);
  if (!Number.isFinite(startMs)) return false;
  const leadMs = startMs - nowMs;
  if (leadMs <= 0 || leadMs > GUEST_REMINDER_WINDOW_HOURS * 3600_000) return false;
  // «I morgen»: the visit's Oslo date is the day after today's Oslo date.
  return osloDateOf(startMs) === nextCalendarDay(osloDateOf(nowMs));
}

/** The reminder e-mail (OA-2 B). Values are escaped in the HTML; the status URL is a link there. */
export function buildGuestReminderEmail(
  booking: GardssalgBooking,
): { subject: string; htmlContent: string; textContent: string; lang: EmailLang } {
  const lang = guestEmailLang(booking);
  const provider = loadReceiptProvider(booking.provider_id);
  const statusUrl = guestStatusUrl(booking);
  // Cancel line only when the guest can cancel on the status page; otherwise
  // (flag off, or a row without a status link) the reply line.
  const withCancel = guestCancelEnabled() && !!statusUrl;
  let body = emailText("guest.reminder.body", lang)
    .split("\n\n")
    .map((p) => (!withCancel && p.includes("{statusside}") ? emailText("guest.reminder.replyLine", lang) : p))
    .join("\n\n");
  // No address on file: "Sted: {produsent}" rather than a dangling comma.
  if (!provider.sted) body = body.split("{produsent}, {sted}").join("{produsent}");
  const raw: Record<string, string> = {
    gjest: booking.guest_name,
    produsent: provider.navn,
    sted: provider.sted,
    tid: lang === "en" ? slotEn(booking.slot_at) : slotNb(booking.slot_at),
    antall: String(booking.party_size),
    ref: booking.booking_ref,
    statusside: statusUrl ?? "",
  };
  const { text, html } = renderEmailBody(body, raw, ["statusside"]);
  const subject = fillEmailText(emailText("guest.reminder.subject", lang), { produsent: provider.navn, ref: booking.booking_ref });
  return { subject, htmlContent: html, textContent: text, lang };
}

/** Sends the reminder; true when the mailer accepted it. */
export async function sendGuestReminder(booking: GardssalgBooking): Promise<boolean> {
  const mail = buildGuestReminderEmail(booking);
  const r = await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    // Same sender identity as the other guest e-mails (Steg 3 / funn 2).
    from: crmFromHeader("experiences"),
  });
  return r?.success !== false;
}

async function processGuestReminders(now: Date, result: BookingFollowupResult): Promise<void> {
  const db = getDb(VERTICAL);
  const nowMs = now.getTime();
  const rows = guestReminderCandidates(nowMs);
  for (const raw of rows) {
    const booking = hydrateReminderRow(raw);
    if (!guestReminderDue(booking, nowMs)) continue;
    const stamp = now.toISOString();
    try {
      // Claim BEFORE sending — the guarded UPDATE is the concurrency lock and
      // re-checks the state the SELECT saw (cancelled or resolved in between
      // → no claim, no send).
      const claim = db.prepare(`
        UPDATE gardssalg_bookings SET guest_reminder_sent_at = ?
        WHERE booking_id = ? AND guest_reminder_sent_at IS NULL
          AND status = 'reserved' AND pre_status = 'provider_confirmed'
      `).run(stamp, booking.booking_id);
      if (claim.changes !== 1) continue;
      let sent = false;
      try {
        sent = await sendGuestReminder(booking);
      } catch (err) {
        db.prepare("UPDATE gardssalg_bookings SET guest_reminder_sent_at = NULL WHERE booking_id = ? AND guest_reminder_sent_at = ?")
          .run(booking.booking_id, stamp);
        throw err;
      }
      if (sent) {
        result.guest_reminders_sent = (result.guest_reminders_sent ?? 0) + 1;
      } else {
        // Not handed to the mailer: release so the next tick retries.
        db.prepare("UPDATE gardssalg_bookings SET guest_reminder_sent_at = NULL WHERE booking_id = ? AND guest_reminder_sent_at = ?")
          .run(booking.booking_id, stamp);
        result.errors++;
        console.error(`[booking-previsit] guest reminder not sent for ${booking.booking_ref}; retried next run`);
      }
    } catch (err) {
      result.errors++;
      console.error(`[booking-previsit] guest reminder failed for ${booking.booking_ref}:`, err);
    }
  }
}

export interface GuestReminderDryRun {
  /** Whether GARDSSALG_GUEST_REMINDER_ENABLED is on (the job only sends when it is). */
  enabled: boolean;
  /** Reminders the job would send now if the flag were on. */
  would_send: number;
  booking_refs: string[];
  window_hours: number;
  /** The date rule: the visit's Europe/Oslo date is the day after today's. */
  rule: "oslo_day_before";
}

// Read-only (no claim, no send): which reminders processBookingFollowups()
// would send at `now`. Counts regardless of the flag, and says whether it is on.
export function countGuestRemindersDue(now: Date = new Date()): GuestReminderDryRun {
  const nowMs = now.getTime();
  const refs: string[] = [];
  for (const raw of guestReminderCandidates(nowMs)) {
    const booking = hydrateReminderRow(raw);
    if (guestReminderDue(booking, nowMs)) refs.push(booking.booking_ref);
  }
  refs.sort();
  return {
    enabled: gardssalgGuestReminderEnabled(),
    would_send: refs.length,
    booking_refs: refs,
    window_hours: GUEST_REMINDER_WINDOW_HOURS,
    rule: "oslo_day_before",
  };
}
