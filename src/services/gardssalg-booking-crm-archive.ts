// gardssalg-booking-crm-archive.ts — A2A dev-request 2026-11-12-opplevagent-
// o4-epost-og-tekster, slice O4-5b (2026-11-17).
//
// Files the booking e-mails the platform sends TO THE PRODUCER (the owner of
// the gårdssalg) as outbound crm_messages in ONE CRM thread per booking,
// `gardssalg-booking-<bookingId>`, so the correspondence is visible under
// GET /admin/crm/threads/:id. Same pattern as claim-crm-tracking.ts (eierkrav
// C3), on the experiences vertical.
//
// Wired at the two producer send paths in booking-store.ts:
//   - sendProducerNotification()  — the new-request mail (kind "producer_new",
//                                   "producer_new_retry" for the followup
//                                   job's single re-send);
//   - sendGatedProducerEmail()    — the reminder, the guest's answer to a
//                                   suggested time, and the guest's
//                                   cancellation/withdrawal (gardssalg-cancel.ts);
//                                   kind = the caller's kind string.
// Guest e-mails are never filed here.
//
// Flag GARDSSALG_BOOKING_CRM_ARCHIVE_ENABLED, on only when exactly "true"
// (default off): off = no CRM read or write at all, and the sends are
// unchanged either way (this module is called after the send, with what was
// sent).
//
// Only a send the mailer accepted is filed (success with a real Message-ID;
// DRY_RUN reached nobody). Test bookings (is_test = 1) are not filed: the
// send guard redirected that mail to the test inbox, not to the producer.
//
// Idempotent for retries: a message with the same recipient, subject and
// text body already in the thread is not filed again (its id is returned).
//
// Fail-open: every error is caught and logged; filing never changes the
// send, the booking or the caller's return value.
//
// Masking (review r1, B1/B2): the stored copy is NOT byte-identical to the
// sent mail. Before anything is written, subject / text / HTML are masked:
//   - every booking token value (respond_token, confirm_token,
//     guest_decision_token, guest_status_token) is replaced by "[skjult]" —
//     exact replacement of the row's own values, plus a regex safety net for
//     the token path segments (/svar/, /bekreft/, /gjestesvar/, /status/<ref>/)
//     and token-like query parameters. These links act on the producer's
//     behalf / steer commission, and booking-store never logs confirm_token.
//   - the guest's name, e-mail, phone and comment (notes) are replaced by
//     "[skjult]", raw and HTML-escaped, because gardssalg-guest-contact-sweep
//     clears those booking fields after 30 days and the privacy notice
//     promises it; a copy in crm_messages would outlive that.
// The sent mail itself is untouched. raw_metadata carries no token or guest
// value.
//
// Outreach bookkeeping: as in claim-crm-tracking.ts, an out/sent message on a
// thread without inbound can be recorded by trg_log_cold_outreach_to_sent_log_v2
// as a cold-outreach touch (when the address matches an rfb agent). These are
// transactional booking mails, so that row is removed in the same transaction.

import { getDb } from "../database/init";
import { getDb as getVerticalDb } from "../database/db-factory";
import { crmService } from "./crm-service";

export const GARDSSALG_BOOKING_CRM_THREAD_PREFIX = "gardssalg-booking-";

export function isGardssalgBookingCrmArchiveEnabled(): boolean {
  return process.env.GARDSSALG_BOOKING_CRM_ARCHIVE_ENABLED === "true";
}

export function gardssalgBookingCrmThreadId(bookingId: string): string {
  return `${GARDSSALG_BOOKING_CRM_THREAD_PREFIX}${bookingId}`;
}

export const GARDSSALG_BOOKING_CRM_MASK = "[skjult]";

/** The booking fields the archive reads: ids, plus the values it masks. */
export interface ProducerBookingMailArchiveBooking {
  booking_id: string;
  booking_ref: string;
  provider_id: string;
  is_test?: number | null;
  confirm_token?: string | null;
  respond_token?: string | null;
  guest_decision_token?: string | null;
  guest_status_token?: string | null;
  guest_name?: string | null;
  guest_email?: string | null;
  guest_phone?: string | null;
  notes?: string | null;
}

export interface ProducerBookingMailArchiveInput {
  booking: ProducerBookingMailArchiveBooking;
  /** What the mail is, e.g. "producer_new", "reminder", "guest-cancel". */
  kind: string;
  /** The producer address the mail was sent to. */
  to: string;
  subject: string;
  textContent: string;
  htmlContent: string;
  /** What emailService.sendEmail returned. */
  sendResult: { success?: boolean; messageId?: string } | null | undefined | void;
}

function providerName(providerId: string): string | null {
  try {
    const row = getVerticalDb("experiences")
      .prepare("SELECT navn FROM experience_providers WHERE id = ?")
      .get(providerId) as { navn: string | null } | undefined;
    return row?.navn ?? null;
  } catch {
    return null;
  }
}

// Same escaping as booking-store's escEmailHtml (the producer mails' HTML
// interpolates guest values through it); kept local to avoid an import cycle.
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escHtmlMinimal(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Safety net for token links whose value is not the row's own (e.g. a stale
// token after a re-issue): the path segment after a token route, and any
// token-like query parameter (?token=, &amp;respond_token=, …).
const TOKEN_PATH_RE = /(\/kategori\/gardssalg\/(?:svar|bekreft|gjestesvar)\/)[^\s"'<>&?#/]+/g;
const STATUS_PATH_RE = /(\/kategori\/gardssalg\/status\/[^\s"'<>/?#]+\/)[^\s"'<>&?#/]+/g;
const TOKEN_QUERY_RE = /([?&](?:amp;)?[A-Za-z0-9_-]*token=)[^&\s"'<>#]+/gi;

/**
 * Masks the booking's token values and the guest's contact data in one
 * string (subject, text or HTML). Exact replacement of the booking's own
 * values (raw, HTML-escaped, and for e-mail lower-cased), in one pass so a
 * value can never match inside an earlier mask; then the token regexes.
 */
export function maskProducerBookingMail(text: string, booking: ProducerBookingMailArchiveBooking): string {
  const M = GARDSSALG_BOOKING_CRM_MASK;
  const raw = [
    booking.confirm_token, booking.respond_token, booking.guest_decision_token, booking.guest_status_token,
    booking.guest_name, booking.guest_email, booking.guest_email?.toLowerCase(), booking.guest_phone, booking.notes,
  ];
  const needles = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    for (const form of [v, v.trim()]) {
      if (!form) continue;
      needles.add(form);
      needles.add(escHtml(form));
      needles.add(escHtmlMinimal(form));
      needles.add(encodeURIComponent(form));
    }
  }
  let out = String(text ?? "");
  if (needles.size > 0) {
    const alts = [...needles].sort((a, b) => b.length - a.length).map(escRegExp);
    out = out.replace(new RegExp(alts.join("|"), "g"), M);
  }
  return out
    .replace(TOKEN_PATH_RE, `$1${M}`)
    .replace(STATUS_PATH_RE, `$1${M}`)
    .replace(TOKEN_QUERY_RE, `$1${M}`);
}

/**
 * Files one producer booking mail in the booking's CRM thread. Never throws.
 * Returns the crm_messages id, or null when the flag is off, the mail was not
 * sent, the booking is a test booking, or filing failed.
 */
export function archiveProducerBookingMail(input: ProducerBookingMailArchiveInput): string | null {
  if (!isGardssalgBookingCrmArchiveEnabled()) return null;
  try {
    const r = input.sendResult || undefined;
    const smtpMessageId = r?.messageId;
    if (r?.success !== true || !smtpMessageId || smtpMessageId === "DRY_RUN") return null;
    if (input.booking.is_test === 1) return null;
    const to = String(input.to || "").trim().toLowerCase();
    if (!to) return null;

    const threadId = gardssalgBookingCrmThreadId(input.booking.booking_id);
    const name = providerName(input.booking.provider_id);
    const subject = maskProducerBookingMail(input.subject, input.booking);
    const bodyText = maskProducerBookingMail(input.textContent, input.booking);
    const bodyHtml = maskProducerBookingMail(input.htmlContent, input.booking);
    const db = getDb();

    return db.transaction((): string => {
      const existing = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(threadId) as
        { vertical_id: string } | undefined;
      if (existing && existing.vertical_id !== "experiences") {
        throw new Error(`thread ${threadId} belongs to vertical ${existing.vertical_id}`);
      }
      if (existing) {
        const dup = db.prepare(`
          SELECT id FROM crm_messages
          WHERE thread_id = ? AND direction = 'out' AND to_emails = ? AND subject = ? AND body_text = ?
          LIMIT 1
        `).get(threadId, JSON.stringify([to]), subject, bodyText) as { id: string } | undefined;
        if (dup) return dup.id;
      } else {
        const contact = crmService.resolveContact(to, name, "experiences");
        // A record of mail the platform sent, nothing to act on: status 'done'.
        db.prepare(`
          INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, vertical_id)
          VALUES (?, ?, ?, 'system', 'normal', 'unassigned', 'done', 'experiences')
        `).run(threadId, contact.id, subject);
      }

      const { messageId } = crmService.recordOutboundReply({
        threadId,
        vertical: "experiences",
        toEmails: [to],
        subject,
        bodyText,
        bodyHtml,
        deliveryStatus: "sent",
        rawMetadata: {
          source: "gardssalg-booking",
          bookingId: input.booking.booking_id,
          bookingRef: input.booking.booking_ref,
          providerId: input.booking.provider_id,
          kind: input.kind,
          smtpMessageId,
        },
      });

      db.prepare(
        "DELETE FROM outreach_sent_log WHERE message_id = ? AND notes LIKE 'auto:cold_outreach%'",
      ).run(messageId);

      return messageId;
    })();
  } catch (err) {
    console.error(
      `[gardssalg-booking-crm-archive] ${input.kind} for booking ${input.booking.booking_ref} not filed:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
