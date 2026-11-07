// claim-crm-tracking.ts — eierkrav slice C3 (2026-11-06).
//
// Files the RFB claim-flow e-mails to the claimant (the verification code,
// its resend, and «Profilen til X er nå din» on approval) as outbound
// crm_messages in ONE CRM thread per claim, `claim-<claimId>`, so the whole
// claim correspondence is visible under GET /admin/crm/threads/:id.
// B2b-2 adds one mail that does not go to the claimant: the «Ny eier
// registrert» notice to the farm's known address after an auto-approval
// (kind "farm_notice", no secret in it, same thread and same bookkeeping).
//
// Flag CLAIM_CRM_TRACKING_ENABLED, on only when exactly "true" (default off):
// off = no CRM read or write at all.
//
// Secrets are never stored. The copy is rendered by the same email-service
// builders as the sent mail, but with the code replaced by CODE_MASK and the
// login link by LOGIN_LINK_PLACEHOLDER — this module is never given the code
// or the link, so it cannot store them.
//
// Fail-open: every error is caught and logged; recording never changes the
// send, the claim outcome or the HTTP response.
//
// Reply threading: inbound mail reaches the CRM only through POST
// /admin/crm/ingest, keyed by the caller's (Gmail) thread id — there is no
// In-Reply-To/References matcher in this codebase. The SMTP Message-ID is
// therefore stored in raw_metadata.smtpMessageId only; a reply from the
// claimant lands in its own Gmail thread, not in `claim-<claimId>`.
//
// Outreach bookkeeping: an out/sent message on a thread without inbound is
// what trg_log_cold_outreach_to_sent_log_v2 records as a cold-outreach touch
// in outreach_sent_log, and three such touches with no reply trip the
// permanent max-touch-vern block (outreach-max-touch-vern.ts, threshold 3 —
// exactly code + resend + approval). These are transactional mails the
// claimant asked for, so the row the trigger wrote for THIS message id is
// removed in the same transaction.

import { getDb } from "../database/init";
import { crmService } from "./crm-service";
import { emailService } from "./email-service";

export const CLAIM_CRM_THREAD_PREFIX = "claim-";
export const CODE_MASK = "••••••";
export const LOGIN_LINK_PLACEHOLDER = "[innloggingslenke]";

// B2b-2 (eierkrav auto-approval): "farm_notice" is the «Ny eier registrert»
// notice to the farm's known address. It carries no secret, so its copy is
// the sent mail as is; it goes in the same `claim-<claimId>` thread.
export type ClaimMailKind = "claim_code" | "claim_approved" | "farm_notice";

export function isClaimCrmTrackingEnabled(): boolean {
  return process.env.CLAIM_CRM_TRACKING_ENABLED === "true";
}

export function claimCrmThreadId(claimId: string): string {
  return `${CLAIM_CRM_THREAD_PREFIX}${claimId}`;
}

export interface ClaimMailRecordInput {
  kind: ClaimMailKind;
  claimId: string;
  agentId: string;
  /** The address the mail was sent to. */
  email: string;
  /** The profile name the mail was rendered with. */
  agentName: string;
  /** What emailService.sendVerificationCode / sendClaimConfirmation returned. */
  sendResult: { success: boolean; messageId?: string } | null | undefined;
  /** farm_notice only: the date the sent notice was rendered with. */
  at?: Date;
}

/**
 * Records one claim mail in the claim's CRM thread. Never throws. Returns the
 * crm_messages id, or null when the flag is off or recording failed.
 */
export function recordClaimMail(input: ClaimMailRecordInput): string | null {
  if (!isClaimCrmTrackingEnabled()) return null;
  try {
    const to = input.email.trim().toLowerCase();
    const rendered =
      input.kind === "claim_code"
        ? emailService.buildVerificationCodeEmail(CODE_MASK, input.agentName)
        : input.kind === "farm_notice"
          ? emailService.buildClaimFarmNoticeEmail(input.agentName, input.at)
          : emailService.buildClaimConfirmationEmail(input.agentName, LOGIN_LINK_PLACEHOLDER, input.agentId);
    const smtpMessageId = input.sendResult?.messageId;
    // DRY_RUN reached nobody — the routes treat it as not sent too.
    const sent = input.sendResult?.success === true && !!smtpMessageId && smtpMessageId !== "DRY_RUN";
    const threadId = claimCrmThreadId(input.claimId);
    const db = getDb();

    return db.transaction((): string => {
      const existing = db.prepare("SELECT vertical_id FROM crm_threads WHERE id = ?").get(threadId) as
        { vertical_id: string } | undefined;
      if (existing && existing.vertical_id !== "rfb") {
        throw new Error(`thread ${threadId} belongs to vertical ${existing.vertical_id}`);
      }
      if (!existing) {
        const contact = crmService.resolveContact(to, input.agentName, "rfb");
        // A record of mail the platform sent, nothing to act on: status 'done'.
        db.prepare(`
          INSERT INTO crm_threads (id, contact_id, subject, category, severity, assigned_to, status, vertical_id)
          VALUES (?, ?, ?, 'system', 'normal', 'unassigned', 'done', 'rfb')
        `).run(threadId, contact.id, rendered.subject);
      }

      const { messageId } = crmService.recordOutboundReply({
        threadId,
        vertical: "rfb",
        toEmails: [to],
        subject: rendered.subject,
        bodyText: rendered.textContent.trim(),
        bodyHtml: rendered.htmlContent.trim(),
        deliveryStatus: sent ? "sent" : "failed",
        rawMetadata: {
          source: "claim-flow",
          claimId: input.claimId,
          agentId: input.agentId,
          kind: input.kind,
          smtpMessageId: smtpMessageId && smtpMessageId !== "DRY_RUN" ? smtpMessageId : null,
        },
      });

      db.prepare(
        "DELETE FROM outreach_sent_log WHERE message_id = ? AND notes LIKE 'auto:cold_outreach%'",
      ).run(messageId);

      return messageId;
    })();
  } catch (err) {
    console.error(
      `[claim-crm-tracking] ${input.kind} for claim ${input.claimId} not recorded:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
