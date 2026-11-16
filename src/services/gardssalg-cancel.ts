// ─── Gårdssalg: cancellation by the guest or the producer (O1-5) ───────────
//
// A2A dev-request 2026-11-12-opplevagent-o1-trygg-aa-aapne, slice O1-5
// (audit finding R2). Behind GARDSSALG_CANCEL_ENABLED (off unless exactly
// "true", read on every call like the other O1 flags).
//
//   Guest  — from the status page (credential: guest_status_token, never the
//            reference alone). Before the producer has answered
//            (awaiting_provider / time_suggested) the guest WITHDRAWS the
//            request («Trekk»); after confirmation (provider_confirmed) the
//            guest CANCELS the visit («Avlys»). Reason optional. The producer
//            gets one e-mail (through the producer dispatch gates).
//   Producer — from the svar page (credential: respond_token), only for a
//            visit the producer has CONFIRMED. Reason required. The guest
//            gets one e-mail.
//
// Both: only while the post-visit status is 'reserved', and a confirmed visit
// only before its time. The write is one guarded UPDATE (status 'cancelled'
// plus cancelled_at / cancelled_by / cancel_reason, and resolved_at so the
// 30-day guest-contact sweep picks the row up); its .changes decides whether
// this call owns the e-mail, so a second click or a race sends nothing.
// pre_status is left as it was: the followup job (reminder / expiry) and every
// pre-visit action require status = 'reserved', so they never touch the row
// again, and the attendance page refuses «Møtte» / «Ikke møtt»
// (resolveBooking() treats 'cancelled' as terminal).
//
// Texts: verbatim from the approved text package OA-1 §4 (A2A
// marketing-drafts/2026-11-12-opplevagent-tekstpakke-oa-1.md, approved by
// Daniel 2026-11-15). Do not reword here. E-mail to the producer is always
// Norwegian; the guest e-mail follows guestEmailLang() (O4-2: English only
// with GARDSSALG_EMAIL_EN_ENABLED and guest_lang "en"). The e-mail texts
// live in the O4-2 register, gardssalg-email-texts.ts.

import { getDb } from "../database/db-factory";
import { emailService } from "./email-service";
import { crmFromHeader } from "./crm-platform-identity";
import {
  getBookingByRef,
  osloDatetimeLocalToUtcIso,
  sendGatedProducerEmail,
  type GardssalgBooking,
} from "./booking-store";
import { fillOa1, formatOsloInstant, loadReceiptProvider } from "./gardssalg-honest-receipt";
import { emailText, guestEmailLang } from "./gardssalg-email-texts";

const APP_URL = process.env.APP_URL || "https://opplevagent.no";

export function gardssalgCancelEnabled(): boolean {
  return process.env.GARDSSALG_CANCEL_ENABLED === "true";
}

// ─── Text package OA-1 §4 (verbatim) ────────────────────────────────────────
export const OA1_CANCEL_TEXTS = {
  "cancel.guest.button": { nb: "Avlys", en: "Cancel" },
  "cancel.guest.buttonPending": { nb: "Trekk", en: "Withdraw" },
  "cancel.guest.heading": { nb: "Avlys besøket", en: "Cancel the visit" },
  "cancel.guest.headingPending": { nb: "Trekk forespørselen", en: "Withdraw the request" },
  "cancel.guest.intro": {
    nb: "{produsent} får beskjed med en gang. Du kan ikke angre en avlysning, men du kan sende en ny forespørsel.",
    en: "{produsent} will be told right away. A cancellation cannot be undone, but you can send a new request.",
  },
  "cancel.guest.introPending": {
    nb: "{produsent} får beskjed med en gang. Du kan ikke angre, men du kan sende en ny forespørsel.",
    en: "{produsent} will be told right away. This cannot be undone, but you can send a new request.",
  },
  "cancel.reasonLabel": {
    nb: "Grunn (valgfritt, sendes til produsenten)",
    en: "Reason (optional, sent to the producer)",
  },
  "cancel.guest.submit": { nb: "Ja, avlys", en: "Yes, cancel" },
  "cancel.guest.submitPending": { nb: "Ja, trekk", en: "Yes, withdraw" },
  "cancel.back": { nb: "Nei, behold", en: "No, keep it" },
  "cancel.guest.done.heading": { nb: "Besøket er avlyst", en: "The visit is cancelled" },
  "cancel.guest.done.headingPending": { nb: "Forespørselen er trukket", en: "The request is withdrawn" },
  "cancel.guest.done.body": {
    nb: "Vi har gitt {produsent} beskjed. Referanse: {ref}.",
    en: "We have told {produsent}. Reference: {ref}.",
  },
  "status.cancelledByGuest": { nb: "Avlyst av gjesten", en: "Cancelled by the guest" },
  "status.withdrawnByGuest": { nb: "Trukket av gjesten", en: "Withdrawn by the guest" },
  "status.cancelledByProducer": { nb: "Avlyst av produsenten", en: "Cancelled by the producer" },
  "cancel.producer.button": { nb: "Avlys besøket" },
  "cancel.producer.heading": { nb: "Avlys besøket {tid}" },
  "cancel.producer.intro": {
    nb: "Gjesten får e-post med en gang, med grunnen du skriver. Du kan ikke angre en avlysning.",
  },
  "cancel.producer.reasonLabel": { nb: "Grunn (sendes til gjesten)" },
  "cancel.producer.reasonMissing": { nb: "Skriv en kort grunn, så gjesten vet hvorfor." },
  "cancel.producer.submit": { nb: "Ja, avlys besøket" },
  "cancel.producer.done.heading": { nb: "Besøket er avlyst" },
  "cancel.producer.done.body": { nb: "Vi har gitt {gjest} beskjed. Referanse: {ref}." },
  // The e-mail texts live in the O4-2 register (gardssalg-email-texts.ts).
  "cancel.toGuest.subject": { nb: emailText("cancel.toGuest.subject", "nb"), en: emailText("cancel.toGuest.subject", "en") },
  "cancel.toGuest.body": { nb: emailText("cancel.toGuest.body", "nb"), en: emailText("cancel.toGuest.body", "en") },
  // E-mail to the producer when the guest cancels (always Norwegian).
  "cancel.toProducer.subject": { nb: emailText("cancel.toProducer.subject") },
  "cancel.toProducer.subjectPending": { nb: emailText("cancel.toProducer.subjectPending") },
  "cancel.toProducer.body": { nb: emailText("cancel.toProducer.body") },
} as const;

/** The package's substitution for a request that was not confirmed yet (§4.1, under the e-mail). */
export const TO_PRODUCER_CANCELLED_PHRASE = emailText("cancel.toProducer.cancelledPhrase");
export const TO_PRODUCER_WITHDRAWN_PHRASE = emailText("cancel.toProducer.withdrawnPhrase");

export type Oa1CancelKey = keyof typeof OA1_CANCEL_TEXTS;

/** Norwegian text for a key (every key has nb). */
export function cancelText(key: Oa1CancelKey): string {
  return OA1_CANCEL_TEXTS[key].nb;
}

// ─── Who may cancel what ────────────────────────────────────────────────────

export type GuestCancelMode = "withdraw" | "cancel";

type CancelRow = Pick<GardssalgBooking, "status" | "pre_status" | "respond_token" | "slot_at">;

function slotIso(slot: string | null): string | null {
  if (!slot) return null;
  return osloDatetimeLocalToUtcIso(slot) ?? slot;
}

/** True once the visit time has passed (an unparseable slot counts as passed: refuse). */
function visitPassed(booking: Pick<GardssalgBooking, "slot_at">, now: Date): boolean {
  const t = Date.parse(slotIso(booking.slot_at) ?? "");
  return !Number.isFinite(t) || t <= now.getTime();
}

/**
 * What the guest may do now: "withdraw" before the producer has answered,
 * "cancel" for a confirmed visit that has not started, null otherwise
 * (declined, expired, already cancelled or resolved, legacy row, or a
 * confirmed visit whose time has passed).
 */
export function guestCancelMode(booking: CancelRow, now: Date = new Date()): GuestCancelMode | null {
  if (booking.status !== "reserved" || !booking.respond_token) return null;
  if (booking.pre_status === "awaiting_provider" || booking.pre_status === "time_suggested") return "withdraw";
  if (booking.pre_status === "provider_confirmed" && !visitPassed(booking, now)) return "cancel";
  return null;
}

/** The producer may cancel only a visit they have confirmed, before its time. */
export function producerMayCancel(booking: CancelRow, now: Date = new Date()): boolean {
  return booking.status === "reserved" && !!booking.respond_token
    && booking.pre_status === "provider_confirmed" && !visitPassed(booking, now);
}

// ─── Stored cancellation (additive columns, init-experiences.ts) ────────────

export type CancelledBy = "guest" | "producer";

export interface CancelInfo {
  cancelled_at: string | null;
  cancelled_by: CancelledBy | null;
  cancel_reason: string | null;
}

/** Longest stored reason (the forms use the same maxlength). */
export const CANCEL_REASON_MAX = 500;

export function normaliseCancelReason(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  const cut = s.slice(0, CANCEL_REASON_MAX);
  // Never keep half of a surrogate pair (an emoji cut at the limit).
  return cut.length === CANCEL_REASON_MAX && /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function getCancelInfo(booking_id: string): CancelInfo | null {
  const row = getDb("experiences")
    .prepare("SELECT cancelled_at, cancelled_by, cancel_reason FROM gardssalg_bookings WHERE booking_id = ?")
    .get(booking_id) as { cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string | null } | undefined;
  if (!row) return null;
  const by = row.cancelled_by === "guest" || row.cancelled_by === "producer" ? row.cancelled_by : null;
  return { cancelled_at: row.cancelled_at ?? null, cancelled_by: by, cancel_reason: row.cancel_reason ?? null };
}

/**
 * The guarded write. Only succeeds while the row is still 'reserved' with the
 * pre_status the caller saw, so the mode (withdraw/cancel) the e-mail states
 * is the one written. Returns the updated row, or null when nothing changed.
 */
function writeCancellation(
  booking: GardssalgBooking,
  by: CancelledBy,
  reason: string,
  now: Date,
): GardssalgBooking | null {
  const at = now.toISOString();
  const res = getDb("experiences").prepare(`
    UPDATE gardssalg_bookings
    SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?,
        resolved_at = ?, resolved_by = ?
    WHERE booking_id = ? AND status = 'reserved' AND respond_token IS NOT NULL AND pre_status = ?
  `).run(at, by, reason || null, at, by === "guest" ? "gjest" : "produsent", booking.booking_id, booking.pre_status);
  if (res.changes !== 1) return null;
  return getBookingByRef(booking.booking_ref);
}

export type CancelOutcome =
  | { ok: true; booking: GardssalgBooking; mode: GuestCancelMode }
  | { ok: false; reason: "not_allowed" | "reason_missing" };

/** The guest cancels or withdraws. The caller has checked the guest token. */
export function guestCancel(booking: GardssalgBooking, rawReason: unknown, now: Date = new Date()): CancelOutcome {
  const mode = guestCancelMode(booking, now);
  if (!mode) return { ok: false, reason: "not_allowed" };
  const updated = writeCancellation(booking, "guest", normaliseCancelReason(rawReason), now);
  return updated ? { ok: true, booking: updated, mode } : { ok: false, reason: "not_allowed" };
}

/** The producer cancels a confirmed visit. The caller has checked the respond token. */
export function producerCancel(booking: GardssalgBooking, rawReason: unknown, now: Date = new Date()): CancelOutcome {
  if (!producerMayCancel(booking, now)) return { ok: false, reason: "not_allowed" };
  const reason = normaliseCancelReason(rawReason);
  if (!reason) return { ok: false, reason: "reason_missing" };
  const updated = writeCancellation(booking, "producer", reason, now);
  return updated ? { ok: true, booking: updated, mode: "cancel" } : { ok: false, reason: "not_allowed" };
}

/** The status word for a cancelled row (status.* keys), or null when not cancelled. */
export function cancelledStatusLabel(
  booking: Pick<GardssalgBooking, "status" | "pre_status">,
  info: CancelInfo | null,
): string | null {
  if (booking.status !== "cancelled" || !info?.cancelled_by) return null;
  if (info.cancelled_by === "producer") return cancelText("status.cancelledByProducer");
  return booking.pre_status === "provider_confirmed"
    ? cancelText("status.cancelledByGuest")
    : cancelText("status.withdrawnByGuest");
}

// ─── E-mails ────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface CancelEmail {
  subject: string;
  htmlContent: string;
  textContent: string;
}

/**
 * Text and HTML from a package body: paragraphs split on blank lines, lines
 * in a paragraph joined with <br>. `urlKeys` become links in the HTML.
 */
function renderBody(body: string, raw: Record<string, string>, urlKeys: string[] = []): { text: string; html: string } {
  const esc: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) esc[k] = escHtml(v);
  for (const k of urlKeys) if (raw[k]) esc[k] = `<a href="${escHtml(raw[k])}">${escHtml(raw[k])}</a>`;
  const text = fillOa1(body, raw);
  const html = body
    .split("\n\n")
    .map((p) => `<p>${p.split("\n").map((l) => fillOa1(escHtml(l), esc)).join("<br>\n")}</p>`)
    .join("\n");
  return { text, html };
}

/** Drops the «Grunn …» line when there is no reason (package rule for the guest's reason). */
function dropLineWith(body: string, placeholder: string): string {
  return body
    .split("\n\n")
    .filter((p) => !p.includes(placeholder))
    .join("\n\n");
}

/** Drops the sentence that needs {profilside} when the producer has no profile page. */
function dropSentenceWith(body: string, placeholder: string): string {
  return body
    .split("\n")
    .map((line) => line.split(/(?<=\.) /).filter((s) => !s.includes(placeholder)).join(" "))
    .join("\n");
}

/** E-mail to the producer when the guest cancels or withdraws (§4.1). */
export function buildGuestCancelProducerEmail(
  booking: Pick<GardssalgBooking, "guest_name" | "slot_at" | "party_size" | "booking_ref">,
  mode: GuestCancelMode,
  reason: string,
): CancelEmail {
  let body: string = cancelText("cancel.toProducer.body");
  if (mode === "withdraw") body = body.replace(TO_PRODUCER_CANCELLED_PHRASE, TO_PRODUCER_WITHDRAWN_PHRASE);
  if (!reason) body = dropLineWith(body, "{grunn}");
  const raw = {
    gjest: booking.guest_name,
    tid: formatOsloInstant(slotIso(booking.slot_at), "nb"),
    antall: String(booking.party_size),
    ref: booking.booking_ref,
    grunn: reason,
  };
  const { text, html } = renderBody(body, raw);
  const subjectKey = mode === "withdraw" ? "cancel.toProducer.subjectPending" : "cancel.toProducer.subject";
  return { subject: fillOa1(cancelText(subjectKey), { ref: booking.booking_ref }), htmlContent: html, textContent: text };
}

/** E-mail to the guest when the producer cancels (§4.2). */
export function buildProducerCancelGuestEmail(
  booking: Pick<GardssalgBooking, "guest_name" | "slot_at" | "booking_ref">,
  ctx: { producerName: string; profileUrl: string | null },
  reason: string,
  lang: "nb" | "en" = "nb",
): CancelEmail {
  let body: string = OA1_CANCEL_TEXTS["cancel.toGuest.body"][lang];
  if (!ctx.profileUrl) body = dropSentenceWith(body, "{profilside}");
  const raw = {
    gjest: booking.guest_name,
    produsent: ctx.producerName,
    tid: formatOsloInstant(slotIso(booking.slot_at), lang),
    ref: booking.booking_ref,
    grunn: reason,
    profilside: ctx.profileUrl ?? "",
  };
  const { text, html } = renderBody(body, raw, ["profilside"]);
  const subject = fillOa1(OA1_CANCEL_TEXTS["cancel.toGuest.subject"][lang], { produsent: ctx.producerName, ref: booking.booking_ref });
  return { subject, htmlContent: html, textContent: text };
}

/** The producer's public profile page, or null without a slug. */
export function producerProfileUrl(provider_id: string): string | null {
  try {
    const row = getDb("experiences")
      .prepare("SELECT slug FROM experience_providers WHERE id = ?")
      .get(provider_id) as { slug?: string | null } | undefined;
    const slug = String(row?.slug ?? "").trim();
    return slug ? `${APP_URL}/kategori/gardssalg/produsent/${encodeURIComponent(slug)}` : null;
  } catch {
    return null;
  }
}

/** Producer e-mail after a guest cancellation, through the producer dispatch gates. */
export async function sendGuestCancelToProducer(booking: GardssalgBooking, mode: GuestCancelMode): Promise<boolean> {
  const reason = getCancelInfo(booking.booking_id)?.cancel_reason ?? "";
  return sendGatedProducerEmail(booking, mode === "withdraw" ? "guest-withdraw" : "guest-cancel", () =>
    buildGuestCancelProducerEmail(booking, mode, reason),
  );
}

/** Guest e-mail after a producer cancellation (transactional, like the other guest e-mails). */
export async function sendProducerCancelToGuest(booking: GardssalgBooking): Promise<boolean> {
  if (!booking.guest_email?.trim()) return false; // contact already swept
  const reason = getCancelInfo(booking.booking_id)?.cancel_reason ?? "";
  const provider = loadReceiptProvider(booking.provider_id);
  const mail = buildProducerCancelGuestEmail(
    booking,
    { producerName: provider.navn, profileUrl: producerProfileUrl(booking.provider_id) },
    reason,
    guestEmailLang(booking),
  );
  await emailService.sendEmail({
    to: booking.guest_email,
    isTestSend: booking.is_test === 1,
    subject: mail.subject,
    htmlContent: mail.htmlContent,
    textContent: mail.textContent,
    replyTo: "kontakt@opplevagent.no",
    from: crmFromHeader("experiences"),
  });
  return true;
}
