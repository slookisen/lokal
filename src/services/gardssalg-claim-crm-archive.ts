// gardssalg-claim-crm-archive.ts — A2A dev-request 2026-11-12-opplevagent-
// o3-eierkrav-og-innlogging, slice O3-4.
//
// Files the gårdssalg claim e-mails (magic link, welcome) as outbound
// crm_messages in one CRM thread per producer, `gardssalg-claim-<providerId>`,
// on the experiences vertical — the same way the self-registration decision
// mails are filed (crmService.ingestThread; recordSelfRegisterDecisionMail).
// Only with GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED on (the callers check it).
// Only a send the mailer accepted (not DRY_RUN, not a test claim) is filed.
// The copy never holds a link token: callers render the magic-link mail with
// a placeholder, and a token= parameter that slipped in is masked here.
// Fail-open: errors are logged (message only) and never reach the claim.

import { getDb } from "../database/init";
import type { IngestThreadInput } from "./crm-service";

export const GARDSSALG_CLAIM_CRM_THREAD_PREFIX = "gardssalg-claim-";
/** What the CRM copy of the magic-link mail carries instead of the link. */
export const GARDSSALG_CLAIM_CRM_LINK_PLACEHOLDER = "[innloggingslenke]";

/** O3-4 flag GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED: on only when exactly
 *  "true" (default off), read per call. Gates the welcome mail and this filing. */
export function isGardssalgClaimWelcomeEmailEnabled(): boolean {
  return process.env.GARDSSALG_CLAIM_WELCOME_EMAIL_ENABLED === "true";
}

export function gardssalgClaimCrmThreadId(providerId: string): string {
  return `${GARDSSALG_CLAIM_CRM_THREAD_PREFIX}${providerId}`;
}

type IngestFn = (input: IngestThreadInput, primaryEmail: string, vertical: "experiences") => unknown;
let ingestOverride: IngestFn | null = null;

/** Test-only: replace the CRM ingest (e.g. with one that throws); null restores it. */
export function __setGardssalgClaimCrmIngestForTesting(fn: IngestFn | null): void {
  ingestOverride = fn;
}

const TOKEN_QUERY_RE = /([?&](?:amp;)?[A-Za-z0-9_-]*token=)[^&\s"'<>#]+/gi;
function maskTokens(s: string): string {
  return String(s ?? "").replace(TOKEN_QUERY_RE, "$1[skjult]");
}

export interface GardssalgClaimMailArchiveInput {
  kind: "magic_link" | "welcome";
  providerId: string;
  claimId?: string | null;
  to: string;
  /** The mail as rendered for the CRM (no link token). */
  rendered: { subject: string; textContent: string; htmlContent: string };
  isTest?: boolean;
  sendResult: { success?: boolean; messageId?: string } | null | undefined;
}

/** Files one sent claim mail in the producer's CRM thread. Never throws;
 *  returns whether a copy was filed. */
export function archiveGardssalgClaimMail(input: GardssalgClaimMailArchiveInput): boolean {
  try {
    const smtpId = input.sendResult?.messageId;
    if (input.sendResult?.success !== true || !smtpId || smtpId === "DRY_RUN") return false;
    if (input.isTest) return false;
    const to = String(input.to || "").trim().toLowerCase();
    if (!to) return false;

    const ingest: IngestFn =
      ingestOverride ??
      ((i, e, v) => (require("./crm-service") as typeof import("./crm-service")).crmService.ingestThread(i, e, v));
    const { CRM_SENDER_ADDRESS } = require("./crm-platform-identity") as typeof import("./crm-platform-identity");
    const subject = maskTokens(input.rendered.subject);
    ingest(
      {
        threadId: gardssalgClaimCrmThreadId(input.providerId),
        subject,
        category: "system",
        messages: [
          {
            messageId: smtpId,
            direction: "out",
            fromEmail: CRM_SENDER_ADDRESS,
            toEmails: [to],
            subject,
            bodyText: maskTokens(input.rendered.textContent).trim(),
            bodyHtml: maskTokens(input.rendered.htmlContent).trim(),
            sentAt: new Date().toISOString(),
            rawMetadata: {
              source: "gardssalg-claim",
              kind: input.kind,
              provider_id: input.providerId,
              claim_id: input.claimId ?? null,
              smtp_message_id: smtpId,
            },
          },
        ],
      },
      to,
      "experiences",
    );
    // A transactional mail the producer asked for, not a cold-outreach touch
    // (same clean-up as claim-crm-tracking.ts / gardssalg-self-register.ts).
    try {
      getDb()
        .prepare("DELETE FROM outreach_sent_log WHERE message_id = ? AND notes LIKE 'auto:cold_outreach%'")
        .run(smtpId);
    } catch { /* no outreach log: nothing to clean */ }
    return true;
  } catch (err) {
    console.error(
      `[gardssalg-claim-crm-archive] ${input.kind} mail for provider ${input.providerId} not filed:`,
      err instanceof Error ? maskTokens(err.message) : "error",
    );
    return false;
  }
}
