// ─── Gårdssalg visit requests: duplicate guard + request caps (O1-3) ───────
//
// A2A build plan O1-3 (audit findings R9/R10, G6/G7). Behind
// GARDSSALG_BOOKING_CAP_ENABLED (off unless exactly "true", read on every
// call like GARDSSALG_HONEST_RECEIPT_ENABLED).
//
// Flag ON, before createBooking() on every public entry point (the
// book_gardssalg MCP tool, POST /api/opplevelser/book and the no-JS form):
//   1. duplicate: same producer + same normalised guest e-mail + an OPEN
//      request whose slot is within DUPLICATE_WINDOW_MINUTES of the new slot
//      → no row, no e-mail; the caller returns the existing ref with
//      duplicate:true.
//   2. caps (all limits below, one place): open requests per guest per
//      producer, new requests per guest per 24 h (across producers), new
//      requests per producer per 24 h (+ one admin notice per producer per
//      Oslo day) → no row, no e-mail; the caller returns cap_reached.
// Flag OFF: checkGardssalgBookingGuard() returns { kind: "ok" } without
// touching the database, so every surface behaves exactly as before.
//
// "Open" (isOpenRequest): status 'reserved' (the only pre-visit value of
// BookingStatus) AND pre_status not 'provider_declined'/'expired' (declined
// and expired requests keep status 'reserved') AND the visit time has not
// passed. Rows marked is_test (admin test-send) are never counted.
//
// SQL here references only columns from the gardssalg_bookings CREATE TABLE
// in src/database/init-experiences.ts (provider_id, guest_email, status,
// created_at). The additive columns (pre_status, is_test) are read from the
// row in JS, with the same legacy defaults as booking-store's hydrate().
// No schema change.

import { getDb } from "../database/db-factory";
import { normaliseBookingSlotInput, osloDatetimeLocalToUtcIso } from "./booking-store";
import { sendBookingAdminAlert } from "./gardssalg-booking-followup";

export function bookingCapEnabled(): boolean {
  return process.env.GARDSSALG_BOOKING_CAP_ENABLED === "true";
}

// ─── Limits (the ONE place) ─────────────────────────────────────────────────
export const DUPLICATE_WINDOW_MINUTES = 30;
export const MAX_OPEN_PER_GUEST_PER_PRODUCER = 2;
export const MAX_NEW_PER_GUEST_PER_DAY = 5;
export const MAX_NEW_PER_PRODUCER_PER_DAY = 10;
export const CAP_WINDOW_HOURS = 24;

export type BookingCapName = "open_per_guest_producer" | "guest_per_day" | "producer_per_day";

export const BOOKING_CAP_LIMITS: Record<BookingCapName, number> = {
  open_per_guest_producer: MAX_OPEN_PER_GUEST_PER_PRODUCER,
  guest_per_day: MAX_NEW_PER_GUEST_PER_DAY,
  producer_per_day: MAX_NEW_PER_PRODUCER_PER_DAY,
};

// ─── Guest-facing sentences (NO + EN) ───────────────────────────────────────
// Verbatim from text package OA-1 §2 (A2A marketing-drafts/2026-11-12-
// opplevagent-tekstpakke-oa-1.md, approved by Daniel 2026-11-15). Do not
// reword here: a changed sentence goes through the text package first.
// Placeholders: {ref} = booking reference, {produsent} = producer name.
export const BOOKING_CAP_TEXTS = {
  "dup.message": {
    no: "Du har allerede sendt denne forespørselen. Referansen er {ref}. Vi har ikke sendt den på nytt.",
    en: "You have already sent this request. The reference is {ref}. We have not sent it again.",
  },
  "cap.guestOpen": {
    no: "Du har allerede forespørsler hos {produsent} som venter på svar. Vent til produsenten har svart, eller trekk en av dem, før du sender en ny.",
    en: "You already have requests waiting for a reply from {produsent}. Please wait for the producer to reply, or withdraw one of them, before sending a new one.",
  },
  "cap.guestDay": {
    no: "Du har sendt mange forespørsler i dag. Prøv igjen i morgen, eller skriv til oss hvis du planlegger et større opplegg.",
    en: "You have sent many requests today. Please try again tomorrow, or write to us if you are planning something larger.",
  },
  "cap.producerDay": {
    no: "{produsent} har fått mange forespørsler i dag og kan ikke ta imot flere akkurat nå. Prøv igjen i morgen.",
    en: "{produsent} has received many requests today and cannot take more right now. Please try again tomorrow.",
  },
} as const;

export type BookingCapTextKey = keyof typeof BOOKING_CAP_TEXTS;

/** Which text-pack key each cap uses. */
export const CAP_TEXT_KEY: Record<BookingCapName, BookingCapTextKey> = {
  open_per_guest_producer: "cap.guestOpen",
  guest_per_day: "cap.guestDay",
  producer_per_day: "cap.producerDay",
};

export type CapLang = "no" | "en";

export function duplicateMessage(ref: string, lang: CapLang): string {
  return BOOKING_CAP_TEXTS["dup.message"][lang].replace("{ref}", ref);
}

/**
 * {produsent} is the producer's name. With no name on file, a neutral noun
 * is used ("produsenten" / "the producer"), capitalised at sentence start.
 */
export function capReachedMessage(cap: BookingCapName, lang: CapLang, producerName?: string | null): string {
  const name = String(producerName ?? "").trim() || (lang === "no" ? "produsenten" : "the producer");
  const text = BOOKING_CAP_TEXTS[CAP_TEXT_KEY[cap]][lang].split("{produsent}").join(name);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── Pure logic ─────────────────────────────────────────────────────────────
export function normaliseGuestEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

/** A stored row, as far as the guard needs it (raw DB column values). */
export interface GuardRow {
  booking_ref: string;
  provider_id: string;
  guest_email: string;
  slot_at: string;
  status: string;
  pre_status?: string | null;
  created_at: string | null;
  is_test?: number | null;
}

export type BookingGuardResult =
  | { kind: "ok" }
  | { kind: "duplicate"; booking_ref: string }
  | { kind: "cap_reached"; cap: BookingCapName; limit: number };

/** Instant (ms) of a stored slot: zone-carrying ISO, or a legacy naked Oslo wall time. */
function slotMs(slot: string): number {
  const iso = osloDatetimeLocalToUtcIso(slot) ?? slot;
  return Date.parse(iso);
}

/** created_at is ISO (createBooking) or sqlite datetime('now') (UTC, no zone). */
function createdMs(created: string | null): number {
  if (!created) return NaN;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created) ? created.replace(" ", "T") + "Z" : created;
  return Date.parse(s);
}

export function isOpenRequest(row: Pick<GuardRow, "status" | "pre_status" | "slot_at">, now: Date): boolean {
  if (row.status !== "reserved") return false;
  const pre = row.pre_status ?? "awaiting_provider";
  if (pre === "provider_declined" || pre === "expired") return false;
  const t = slotMs(row.slot_at);
  return !Number.isFinite(t) || t >= now.getTime();
}

/**
 * Decides one new request against the rows that can matter (any open row for
 * this producer or guest, and any row created in the last CAP_WINDOW_HOURS).
 * Duplicate first (a retry gets its ref back even when a cap is also hit),
 * then the caps in order: open per guest+producer, guest per day, producer
 * per day. `slot_at` is the new request's slot as the caller sent it.
 */
export function evaluateGardssalgBookingGuard(
  req: { provider_id: string; guest_email: string; slot_at: string },
  rows: GuardRow[],
  now: Date = new Date(),
): BookingGuardResult {
  const email = normaliseGuestEmail(req.guest_email);
  const reqSlot = slotMs(normaliseBookingSlotInput(req.slot_at));
  const windowMs = DUPLICATE_WINDOW_MINUTES * 60_000;
  const dayAgo = now.getTime() - CAP_WINDOW_HOURS * 3600_000;
  const live = rows.filter((r) => Number(r.is_test ?? 0) !== 1);
  const sameGuest = (r: GuardRow) => normaliseGuestEmail(r.guest_email) === email;
  const sameProducer = (r: GuardRow) => r.provider_id === req.provider_id;

  const openHere = live.filter((r) => sameProducer(r) && sameGuest(r) && isOpenRequest(r, now));

  if (Number.isFinite(reqSlot)) {
    const dup = openHere
      .map((r) => ({ r, d: Math.abs(slotMs(r.slot_at) - reqSlot) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= windowMs)
      .sort((a, b) => a.d - b.d)[0];
    if (dup) return { kind: "duplicate", booking_ref: dup.r.booking_ref };
  }

  if (openHere.length >= MAX_OPEN_PER_GUEST_PER_PRODUCER) {
    return { kind: "cap_reached", cap: "open_per_guest_producer", limit: MAX_OPEN_PER_GUEST_PER_PRODUCER };
  }
  const recent = live.filter((r) => createdMs(r.created_at) >= dayAgo);
  if (recent.filter(sameGuest).length >= MAX_NEW_PER_GUEST_PER_DAY) {
    return { kind: "cap_reached", cap: "guest_per_day", limit: MAX_NEW_PER_GUEST_PER_DAY };
  }
  if (recent.filter(sameProducer).length >= MAX_NEW_PER_PRODUCER_PER_DAY) {
    return { kind: "cap_reached", cap: "producer_per_day", limit: MAX_NEW_PER_PRODUCER_PER_DAY };
  }
  return { kind: "ok" };
}

// ─── Admin notice: at most one per producer per Oslo day ────────────────────
// In-process memory (cheap; a restart can at worst send one more notice that
// day). The notice carries the producer id and the limit, no guest data.
const _producerCapNotified = new Map<string, string>();

export function __resetBookingCapNoticesForTesting(): void {
  _producerCapNotified.clear();
}

function osloDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Returns true when a notice was triggered now (false = already sent today). */
export function notifyProducerCapOnce(provider_id: string, now: Date = new Date()): boolean {
  const day = osloDay(now);
  if (_producerCapNotified.get(provider_id) === day) return false;
  _producerCapNotified.set(provider_id, day);
  const subject = `[gardssalg] Produsent-tak nådd: ${provider_id}`;
  const text =
    `Produsenten ${provider_id} har fått ${MAX_NEW_PER_PRODUCER_PER_DAY} nye besøksforespørsler ` +
    `de siste ${CAP_WINDOW_HOURS} timene. Nye forespørsler avvises med cap_reached ` +
    `(GARDSSALG_BOOKING_CAP_ENABLED). Dette varselet sendes maks én gang per produsent per dag.`;
  console.warn(`[booking-cap] producer_per_day reached for provider ${provider_id} — admin notice queued`);
  sendBookingAdminAlert(subject, text).catch(() => { /* never throws; logged there */ });
  return true;
}

// ─── DB entry point ─────────────────────────────────────────────────────────
/**
 * The one call the entry points make before createBooking(). Flag off →
 * { kind: "ok" } with no DB access. Never throws: a lookup failure fails open
 * (logged), so the guard can never block a request on its own error.
 */
export function checkGardssalgBookingGuard(
  req: { provider_id: string; guest_email: string; slot_at: string },
  now: Date = new Date(),
): BookingGuardResult {
  if (!bookingCapEnabled()) return { kind: "ok" };
  try {
    const db = getDb("experiences");
    const cutoff = new Date(now.getTime() - CAP_WINDOW_HOURS * 3600_000).toISOString();
    const rows = db.prepare(`
      SELECT * FROM gardssalg_bookings
       WHERE (provider_id = ? OR lower(trim(guest_email)) = ?)
         AND (status = 'reserved' OR julianday(created_at) >= julianday(?))
    `).all(req.provider_id, normaliseGuestEmail(req.guest_email), cutoff) as GuardRow[];
    const result = evaluateGardssalgBookingGuard(req, rows, now);
    if (result.kind === "duplicate") {
      console.log(`[booking-cap] duplicate request for provider ${req.provider_id} → existing ${result.booking_ref}`);
    } else if (result.kind === "cap_reached") {
      console.log(`[booking-cap] cap_reached ${result.cap} (limit ${result.limit}) for provider ${req.provider_id}`);
      if (result.cap === "producer_per_day") notifyProducerCapOnce(req.provider_id, now);
    }
    return result;
  } catch (err) {
    console.error("[booking-cap] guard lookup failed — allowing the request", err);
    return { kind: "ok" };
  }
}
