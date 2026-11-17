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

export interface ProducerBookingMailArchiveInput {
  booking: { booking_id: string; booking_ref: string; provider_id: string; is_test?: number | null };
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
        `).get(threadId, JSON.stringify([to]), input.subject, input.textContent) as { id: string } | undefined;
        if (dup) return dup.id;
      } else {
        const contact = crmService.resolveContact(to, name, "experiences");
        // A record of mail the platform sent, nothing to act on: status 'done'.
        db.prepare(`
          INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, vertical_id)
          VALUES (?, ?, ?, 'system', 'normal', 'unassigned', 'done', 'experiences')
        `).run(threadId, contact.id, input.subject);
      }

      const { messageId } = crmService.recordOutboundReply({
        threadId,
        vertical: "experiences",
        toEmails: [to],
        subject: input.subject,
        bodyText: input.textContent,
        bodyHtml: input.htmlContent,
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
